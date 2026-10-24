/**
 * World — orchestrates one scenario (hazard-only OR v2x) deterministically.
 *
 * Per fixed timestep it:
 *   1. advances the emergency vehicle's driver-state machine (impairment onset),
 *   2. runs the emergency vehicle's PULL-OVER maneuver: ease off, seek a safe gap
 *      toward the shoulder, change lanes only when safe, stop on the shoulder,
 *   3. (v2x only) broadcasts an emergency advisory to in-range connected vehicles
 *      and roadside units,
 *   4. delivers due V2X messages (respecting latency / loss / expiration),
 *   5. lets following vehicles react to what they can PERCEIVE (visual, late) or
 *      to a V2X advisory (early); connected cars in the target lane may YIELD to
 *      open a merge gap,
 *   6. integrates IDM motion with bounded deceleration + smooth lateral motion,
 *   7. derives each vehicle's visualization role and records metrics,
 *   8. detects rear-end collisions (travel lanes only; the shoulder is a refuge).
 *
 * The hazard-only and v2x worlds share identical construction and identical
 * initial fleets; the ONLY behavioral difference is whether V2X messaging exists.
 * That keeps the side-by-side comparison honest.
 *
 * DISCLAIMER: educational digital twin, not a production safety controller. The
 * pull-over, yielding, and gap-acceptance rules are simplified, safety-CONSTRAINED
 * heuristics (no forced unsafe maneuvers), not validated vehicle-control logic.
 */
import {
  DriverState,
  PullOverPhase,
  VehicleRole,
  V2XMessageType,
  type RoadsideUnit,
  type ScenarioKind,
  type SimConfig,
  type V2XMessage,
  type Vehicle,
} from "./types";
import { Rng } from "./rng";
import { buildScenario } from "./scenario";
import { createRSUs, expireRSUs, updateRSU } from "./rsu";
import { V2XBus } from "./v2x";
import {
  createDriverStateContext,
  shouldBroadcast,
  stepDriverState,
  type DriverStateContext,
} from "./driverState";
import { stepVehicle, type Leader } from "./vehicle";
import { MetricsAccumulator, detectCollisions } from "./metrics";
import {
  ADVISORY_SPEED,
  DT,
  LANE_CHANGE_RATE,
  NEAR_STOP_SPEED,
  PULLOVER_DECEL,
  PULLOVER_REQUEST_SPEED,
  REACTION,
  SAFE_MERGE_GAP,
  VISUAL_RANGE,
  YIELD_DECEL,
  YIELD_SPEED_MARGIN,
} from "./constants";

export class World {
  readonly kind: ScenarioKind;
  readonly config: SimConfig;
  vehicles: Vehicle[];
  rsus: RoadsideUnit[];
  time = 0;
  /** Lane index of the shoulder (one lane-width right of the last travel lane). */
  readonly shoulderLane: number;

  private readonly hazardId: number;
  private readonly hazardCtx: DriverStateContext;
  private readonly bus: V2XBus;
  private readonly rng: Rng;
  private readonly metrics = new MetricsAccumulator();
  private sosRequested = false;

  constructor(kind: ScenarioKind, config: SimConfig) {
    this.kind = kind;
    this.config = config;
    this.rng = new Rng(config.seed);
    const scenario = buildScenario(config);
    this.vehicles = scenario.vehicles;
    this.hazardId = scenario.hazardVehicleId;
    this.hazardCtx = createDriverStateContext();
    this.rsus = createRSUs(config.highwayLength);
    this.bus = new V2XBus(config.networkLatency, config.packetLoss, this.rng);
    this.shoulderLane = config.laneCount; // shoulder sits just right of travel lanes
  }

  get hazardVehicleId(): number {
    return this.hazardId;
  }

  requestSOS(): void {
    this.sosRequested = true;
  }

  getMetrics() {
    return this.metrics.snapshot(this.bus.deliveryRate());
  }

  /** Advance the whole world by one fixed timestep. */
  step(): void {
    const dt = DT;
    this.time += dt;

    const hazard = this.vehicleById(this.hazardId);

    // (1) Emergency vehicle's internal state machine (impairment onset / SOS).
    const impairmentSignal = this.time >= this.config.emergencyTime;
    const nextCtx = stepDriverState(this.hazardCtx, {
      impairmentSignal,
      sosPressed: this.sosRequested,
      dt,
    });
    this.sosRequested = false;
    Object.assign(this.hazardCtx, nextCtx);
    hazard.driverState = this.hazardCtx.state;
    if (this.hazardCtx.state === DriverState.Confirmed) {
      this.metrics.recordConfirmed(this.time);
    }

    const emergencyActive = this.hazardCtx.state !== DriverState.Normal;

    // (3) V2X broadcast — only in the v2x scenario and only when Confirmed.
    if (this.kind === "v2x" && shouldBroadcast(this.hazardCtx)) {
      this.broadcastHazard(hazard);
    }

    // (4) Deliver due messages: set advisories on connected receivers, light RSUs.
    const due = this.kind === "v2x" ? this.bus.collectDue(this.time) : [];
    for (const item of due) {
      this.metrics.recordFirstWarning(this.time);
      if (typeof item.receiverId === "number") {
        const v = this.vehicleById(item.receiverId);
        if (v && !v.crashed && v.id !== this.hazardId) {
          if (v.advisorySpeed === null) {
            v.advisorySpeed = item.message.advisorySpeed;
            v.advisoryReceivedAt = this.time;
          }
        }
      }
    }
    if (this.kind === "v2x" && shouldBroadcast(this.hazardCtx)) {
      const msg = this.makeHazardMessage(hazard);
      for (const rsu of this.rsus) updateRSU(rsu, msg);
    }
    expireRSUs(this.rsus, this.time);

    // (2)+(5)+(6) Advance the emergency vehicle's pull-over and all followers.
    this.updateEmergencyVehicle(hazard, emergencyActive, dt);
    this.updateFollowers(hazard, dt);

    // (7) Derive roles for visualization.
    this.deriveRoles(hazard, emergencyActive);

    // (8) Collisions (travel lanes only) + metric timing.
    this.detectAndRecordCollisions();
    if (hazard.speed <= NEAR_STOP_SPEED) {
      this.metrics.recordHazardNearStop(this.time);
    }
    if (
      hazard.pullOver === PullOverPhase.Stopped &&
      hazard.pullOverCompletedAt !== null
    ) {
      this.metrics.recordPullOverCompleted(hazard.pullOverCompletedAt);
    }
  }

  // --------------------------------------------------------------------------
  // Emergency vehicle: pull-over maneuver
  // --------------------------------------------------------------------------

  /**
   * The emergency vehicle eases off, then attempts to move RIGHT toward the
   * shoulder one lane at a time, changing lanes ONLY when a safe gap exists in
   * the target lane. If no safe gap exists it keeps rolling at the request speed
   * and WAITS — the maneuver is delayed, never forced.
   */
  private updateEmergencyVehicle(
    hazard: Vehicle,
    emergencyActive: boolean,
    dt: number
  ): void {
    if (hazard.crashed) {
      hazard.speed = 0;
      hazard.acceleration = 0;
      return;
    }

    if (!emergencyActive) {
      // Normal cruising before the emergency.
      hazard.pullOver = PullOverPhase.None;
      hazard.acceleration = 0;
      hazard.position += hazard.speed * dt;
      return;
    }

    // Enter the maneuver on first activation.
    if (hazard.pullOver === PullOverPhase.None) {
      hazard.pullOver = PullOverPhase.Requesting;
    }

    const targetLane = hazard.lane + 1; // moving right toward the shoulder
    const atShoulder = hazard.lane >= this.shoulderLane;

    // Longitudinal speed control.
    let targetSpeed: number;
    if (atShoulder) {
      targetSpeed = 0; // on the shoulder: come to a full, safe stop
    } else {
      targetSpeed = PULLOVER_REQUEST_SPEED; // keep rolling to be able to merge
    }
    this.easeSpeed(hazard, targetSpeed, PULLOVER_DECEL, dt);

    // Lateral control + phase transitions.
    if (hazard.pullOver === PullOverPhase.Changing) {
      // Safety-constrained lane change: the gap must stay safe for the WHOLE
      // lateral move, not just at the instant it was committed. Fast target-lane
      // traffic can close the gap during the ~2 s change; if that happens before
      // the hazard has committed past the lane boundary (laneF still nearer the
      // origin lane), ABORT back to the origin lane and keep WAITING. This is what
      // prevents merging into closing traffic — the maneuver is never forced.
      const committedPastBoundary = hazard.laneF >= hazard.lane + 0.5;
      if (!committedPastBoundary && !this.safeToChangeInto(hazard, targetLane)) {
        // Ease back toward the origin lane center and resume requesting.
        hazard.laneF = Math.max(hazard.lane, hazard.laneF - LANE_CHANGE_RATE * dt);
        if (hazard.laneF <= hazard.lane + 1e-6) {
          hazard.laneF = hazard.lane;
          hazard.pullOver = PullOverPhase.Requesting;
        }
        return;
      }
      // Mid lane-change: advance laneF toward the integer target lane.
      hazard.laneF = Math.min(targetLane, hazard.laneF + LANE_CHANGE_RATE * dt);
      if (hazard.laneF >= targetLane - 1e-6) {
        hazard.laneF = targetLane;
        hazard.lane = targetLane;
        hazard.pullOver =
          hazard.lane >= this.shoulderLane
            ? PullOverPhase.OnShoulder
            : PullOverPhase.Requesting; // keep moving right if more lanes remain
      }
      return;
    }

    if (hazard.pullOver === PullOverPhase.Requesting) {
      if (hazard.lane >= this.shoulderLane) {
        hazard.pullOver = PullOverPhase.OnShoulder;
      } else if (this.safeToChangeInto(hazard, targetLane)) {
        hazard.pullOver = PullOverPhase.Changing; // begin the lateral move
      }
      // else: no safe gap — WAIT (keep rolling at request speed). Delayed, safe.
      return;
    }

    if (hazard.pullOver === PullOverPhase.OnShoulder) {
      if (hazard.speed <= NEAR_STOP_SPEED) {
        hazard.speed = 0;
        hazard.pullOver = PullOverPhase.Stopped;
        if (hazard.pullOverCompletedAt === null) {
          hazard.pullOverCompletedAt = this.time;
        }
      }
      return;
    }
    // Stopped: nothing more to do (already at rest on the shoulder).
  }

  /**
   * Safety-constrained gap acceptance: is it safe for the emergency vehicle to
   * move into `targetLane` right now? Requires BOTH a clear front gap to the
   * nearest leader and a clear rear gap to the nearest follower in that lane.
   * Delegates to the pure, unit-tested {@link safeToChangeInto} helper.
   */
  private safeToChangeInto(hazard: Vehicle, targetLane: number): boolean {
    return safeToChangeInto(hazard, this.vehicles, targetLane);
  }

  /**
   * Time-to-collision (s) from a follower to its in-lane leader: gap / closing
   * speed when actually closing on a real leader, else Infinity (not at risk).
   */
  private ttcToLeader(v: Vehicle, leader: Vehicle | null): number {
    if (!leader) return Infinity;
    const gap = leader.position - v.position - leader.length;
    const dv = v.speed - leader.speed;
    if (dv <= 0.01 || gap <= 0) return Infinity;
    return gap / dv;
  }

  /** Ease a vehicle's speed toward target at up to `decel` (m/s^2). */
  private easeSpeed(
    v: Vehicle,
    target: number,
    decel: number,
    dt: number
  ): void {
    let newSpeed = v.speed;
    if (v.speed > target) {
      newSpeed = Math.max(target, v.speed - decel * dt);
      v.acceleration = -decel;
    } else if (v.speed < target) {
      newSpeed = Math.min(target, v.speed + decel * dt);
      v.acceleration = decel;
    } else {
      v.acceleration = 0;
    }
    v.position += ((v.speed + newSpeed) / 2) * dt;
    v.speed = newSpeed;
  }

  // --------------------------------------------------------------------------
  // Following / surrounding traffic
  // --------------------------------------------------------------------------

  private updateFollowers(hazard: Vehicle, dt: number): void {
    // Group by current travel lane and sort by position so each vehicle sees its
    // true leader. The emergency vehicle is handled separately above; include it
    // as a potential leader/obstacle for others while it is still in a travel lane.
    const lanes: Vehicle[][] = Array.from(
      { length: this.config.laneCount + 1 }, // +1 for the shoulder lane
      () => []
    );
    for (const v of this.vehicles) lanes[v.lane]?.push(v);
    for (const lane of lanes) lane.sort((a, b) => a.position - b.position);

    for (let laneIdx = 0; laneIdx < lanes.length; laneIdx++) {
      const lane = lanes[laneIdx];
      for (let i = 0; i < lane.length; i++) {
        const v = lane[i];
        if (v.id === hazard.id) continue; // already advanced

        const leader = i + 1 < lane.length ? lane[i + 1] : null;

        // Current time-to-collision to this vehicle's leader (s): Infinity unless
        // it is closing on a real leader. Used both for the minTTC metric and to
        // gate the near-miss harsh-braking counter below.
        const ttc = this.ttcToLeader(v, leader);
        if (leader) {
          const gap = leader.position - v.position - leader.length;
          const dv = v.speed - leader.speed;
          this.metrics.recordTTC(gap, dv);
        }

        // Cooperative yielding: a connected vehicle that has the advisory and is
        // the emergency car's intended rear neighbor in the target lane eases off
        // to open the merge gap. Mild, bounded — not hard braking.
        if (this.shouldYield(v, hazard)) {
          v.yielding = true;
          // Target a speed a fixed margin BELOW the emergency vehicle's current
          // speed so the yielder always drops back relative to it — the rear gap
          // opens monotonically from the moment yielding starts, instead of the
          // two vehicles decelerating in lockstep. Bounded below by a sensible
          // floor so the yield stays a gentle ease, never a stop-in-lane. This is
          // the cooperative gap-creation that lets the hazard merge early in v2x.
          const yieldTarget = Math.max(hazard.speed - YIELD_SPEED_MARGIN, 6);
          this.easeSpeed(v, yieldTarget, YIELD_DECEL, dt);
          this.metrics.recordAcceleration(v.acceleration);
          this.metrics.recordVehicleBraking(v.id, v.acceleration, ttc);
          continue;
        }
        v.yielding = false;

        const effectiveDesired = this.followerTargetSpeed(v, hazard, leader);
        const perceived = this.hasPerceivedHazard(v, hazard, leader);

        if (perceived) {
          const leaderInput: Leader | null = leader
            ? { position: leader.position, speed: leader.speed, length: leader.length }
            : null;
          stepVehicle(v, leaderInput, effectiveDesired, dt);
        } else {
          this.cruiseFreeFlow(v, dt);
        }
        this.metrics.recordAcceleration(v.acceleration);
        this.metrics.recordVehicleBraking(v.id, v.acceleration, ttc);
      }
    }
  }

  /**
   * Should this vehicle yield to open a merge gap for the emergency vehicle?
   * Only in the v2x scenario, only connected vehicles that have the advisory,
   * only the nearest follower just behind the emergency car in its intended
   * target lane, and only while the emergency car is seeking that gap.
   */
  private shouldYield(v: Vehicle, hazard: Vehicle): boolean {
    if (this.kind !== "v2x") return false;
    if (!v.isConnected || !v.advisoryActive) return false;
    if (hazard.pullOver !== PullOverPhase.Requesting) return false;
    const targetLane = hazard.lane + 1;
    if (targetLane > this.config.laneCount - 1) return false; // merging onto shoulder: no travel-lane neighbor
    if (v.lane !== targetLane) return false;
    const dx = hazard.position - v.position; // >0 => v is behind the hazard
    return dx > 0 && dx < SAFE_MERGE_GAP.rear + 25; // just behind, within influence
  }

  private hasPerceivedHazard(
    v: Vehicle,
    hazard: Vehicle,
    leader: Vehicle | null
  ): boolean {
    const emergencyActive = hazard.driverState !== DriverState.Normal;
    if (!emergencyActive || !leader) {
      v.leaderBrakeNoticedAt = null;
      return true;
    }
    const gap = leader.position - v.position - leader.length;
    const leaderMuchSlower = leader.speed < v.speed - 2.0;
    if (!leaderMuchSlower || gap > VISUAL_RANGE * 2) {
      v.leaderBrakeNoticedAt = null;
      return true;
    }
    if (v.advisoryActive) {
      v.leaderBrakeNoticedAt = null;
      return true;
    }
    if (gap <= VISUAL_RANGE) {
      if (v.leaderBrakeNoticedAt === null) {
        v.leaderBrakeNoticedAt = this.time;
      }
      return this.time - v.leaderBrakeNoticedAt >= REACTION.visual;
    }
    v.leaderBrakeNoticedAt = null;
    return false;
  }

  private cruiseFreeFlow(v: Vehicle, dt: number): void {
    if (v.crashed) {
      v.speed = 0;
      v.acceleration = 0;
      return;
    }
    stepVehicle(v, null, v.desiredSpeed, dt);
  }

  private followerTargetSpeed(
    v: Vehicle,
    hazard: Vehicle,
    _leader: Vehicle | null
  ): number {
    const hazardActive = hazard.driverState !== DriverState.Normal;
    if (!hazardActive) return v.desiredSpeed;

    const behind = v.position < hazard.position;
    const distance = hazard.position - v.position;
    if (!behind) return v.desiredSpeed;

    let target = v.desiredSpeed;

    // --- V2X advisory channel (early, anticipatory) ---
    if (
      v.advisorySpeed !== null &&
      v.advisoryReceivedAt !== null &&
      this.time - v.advisoryReceivedAt >= REACTION.v2xAdvisory
    ) {
      v.advisoryActive = true;
      v.respondingToHazard = true;
      target = Math.min(target, this.graduatedTarget(distance, v.advisorySpeed));
    }

    // --- Visual channel (late, same-lane line-of-sight only) ---
    const sameLane = v.lane === hazard.lane;
    if (sameLane && distance <= VISUAL_RANGE) {
      if (v.visualSeenAt === null) v.visualSeenAt = this.time;
      if (this.time - v.visualSeenAt >= REACTION.visual) {
        v.respondingToHazard = true;
        target = Math.min(target, this.graduatedTarget(distance, ADVISORY_SPEED));
      }
    }

    return target;
  }

  private graduatedTarget(distance: number, advisory: number): number {
    const full = 60;
    const fade = 420;
    if (distance <= full) return advisory;
    if (distance >= fade) return Infinity;
    const t = (distance - full) / (fade - full);
    const span = this.config.meanSpeed * 1.6;
    return advisory + Math.sqrt(t) * span;
  }

  // --------------------------------------------------------------------------
  // Roles (visualization) + collisions
  // --------------------------------------------------------------------------

  private deriveRoles(hazard: Vehicle, emergencyActive: boolean): void {
    for (const v of this.vehicles) {
      if (v.id === hazard.id) {
        v.role = VehicleRole.Emergency;
        continue;
      }
      if (v.crashed) {
        v.role = VehicleRole.Braking; // rendered via crashed flag anyway
        continue;
      }
      if (!emergencyActive) {
        v.role = VehicleRole.Normal;
        continue;
      }
      if (v.yielding) {
        v.role = VehicleRole.Yielding;
      } else if (v.acceleration <= -3.0) {
        v.role = VehicleRole.Braking;
      } else if (v.respondingToHazard || v.advisoryActive) {
        v.role = VehicleRole.Alerted;
      } else {
        v.role = VehicleRole.Unalerted;
      }
    }
  }

  private detectAndRecordCollisions(): void {
    // Only travel lanes can rear-end; the shoulder is a refuge (no following
    // traffic there). Iterate travel lanes 0..laneCount-1.
    const lanes: Vehicle[][] = Array.from(
      { length: this.config.laneCount },
      () => []
    );
    for (const v of this.vehicles) {
      if (v.lane < this.config.laneCount) lanes[v.lane].push(v);
    }
    for (const lane of lanes) {
      lane.sort((a, b) => a.position - b.position);
      const n = detectCollisions(lane);
      for (let i = 0; i < n; i++) this.metrics.recordCollision();
    }
  }

  // --------------------------------------------------------------------------

  private vehicleById(id: number): Vehicle {
    const v = this.vehicles[id];
    if (v && v.id === id) return v;
    return this.vehicles.find((x) => x.id === id)!;
  }

  private makeHazardMessage(hazard: Vehicle): V2XMessage {
    return {
      id: this.bus.allocateId(),
      type: V2XMessageType.EmergencySlowdown,
      originId: hazard.id,
      originPosition: hazard.position,
      originLane: hazard.lane,
      advisorySpeed: ADVISORY_SPEED,
      createdAt: this.time,
      expiresAt: this.time + this.config.messageLifetime,
    };
  }

  private broadcastHazard(hazard: Vehicle): void {
    const msg = this.makeHazardMessage(hazard);
    const receivers: (number | string)[] = [];
    for (const v of this.vehicles) {
      if (v.id === hazard.id || v.crashed || !v.isConnected) continue;
      const dist = Math.abs(v.position - hazard.position);
      if (dist <= this.config.commRange) receivers.push(v.id);
    }
    this.bus.broadcast(msg, receivers, this.time);
  }
}

/**
 * Pure gap-acceptance predicate for the emergency pull-over, extracted from the
 * World so it can be unit-tested in isolation (no World/Simulation needed).
 *
 * Returns true only when BOTH the front gap (to the nearest vehicle AHEAD in the
 * target lane) and the rear gap (to the nearest vehicle BEHIND) are at least the
 * corresponding SAFE_MERGE_GAP. Gaps are bumper-to-bumper. Crashed vehicles and
 * the emergency vehicle itself are ignored. With no blocking traffic in the
 * target lane both gaps are Infinity and the change is safe.
 */
export function safeToChangeInto(
  hazard: Vehicle,
  vehicles: readonly Vehicle[],
  targetLane: number
): boolean {
  let frontGap = Infinity;
  let rearGap = Infinity;
  for (const v of vehicles) {
    if (v.id === hazard.id || v.crashed) continue;
    if (v.lane !== targetLane) continue;
    const dx = v.position - hazard.position;
    if (dx >= 0) {
      frontGap = Math.min(frontGap, dx - v.length);
    } else {
      rearGap = Math.min(rearGap, -dx - hazard.length);
    }
  }
  return frontGap >= SAFE_MERGE_GAP.front && rearGap >= SAFE_MERGE_GAP.rear;
}
