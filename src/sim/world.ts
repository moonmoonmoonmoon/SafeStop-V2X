/**
 * World — orchestrates one scenario (hazard-only OR v2x) deterministically.
 *
 * Per tick it:
 *   1. advances the hazard vehicle's driver-state machine (emergency onset),
 *   2. applies the hazard vehicle's own emergency slowdown (bounded braking),
 *   3. (v2x only) broadcasts a hazard advisory to in-range receivers + RSUs,
 *   4. delivers due messages (respecting latency / loss / expiration),
 *   5. lets following vehicles react — either to a visible hazard (slow, visual
 *      reaction delay) or to a V2X advisory (earlier, in-cabin reaction delay),
 *   6. integrates IDM motion with bounded deceleration,
 *   7. detects collisions and records metrics.
 *
 * The hazard-only and v2x worlds share identical construction; the ONLY behavioral
 * difference is whether step 3/4 run and whether non-hazard vehicles can receive
 * advisories. That keeps the side-by-side comparison honest.
 */
import {
  DriverState,
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
  HAZARD_DECEL,
  HAZARD_STOP_SPEED,
  NEAR_STOP_SPEED,
  REACTION,
  VISUAL_RANGE,
} from "./constants";

export interface VisibleHazard {
  position: number;
  lane: number;
}

export class World {
  readonly kind: ScenarioKind;
  readonly config: SimConfig;
  vehicles: Vehicle[];
  rsus: RoadsideUnit[];
  time = 0;

  private readonly hazardId: number;
  private readonly hazardCtx: DriverStateContext;
  private readonly bus: V2XBus;
  private readonly rng: Rng;
  private readonly metrics = new MetricsAccumulator();
  private sosRequested = false;

  constructor(kind: ScenarioKind, config: SimConfig) {
    this.kind = kind;
    this.config = config;
    // Each world gets its own RNG seeded from the config so both scenarios share
    // identical initial fleets but keep independent, reproducible event streams.
    this.rng = new Rng(config.seed);
    const scenario = buildScenario(config);
    this.vehicles = scenario.vehicles;
    this.hazardId = scenario.hazardVehicleId;
    this.hazardCtx = createDriverStateContext();
    this.rsus = createRSUs(config.highwayLength);
    this.bus = new V2XBus(config.networkLatency, config.packetLoss, this.rng);
  }

  get hazardVehicleId(): number {
    return this.hazardId;
  }

  /** Driver pressed SOS (manual confirmation). */
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

    // (1) Drive the hazard vehicle's internal state machine. The genuine
    // impairment signal switches on at emergencyTime. A manual SOS (if pressed)
    // is also fed in. Suspected never broadcasts; only Confirmed does.
    const impairmentSignal = this.time >= this.config.emergencyTime;
    const prevState = this.hazardCtx.state;
    const nextCtx = stepDriverState(this.hazardCtx, {
      impairmentSignal,
      sosPressed: this.sosRequested,
      dt,
    });
    this.sosRequested = false;
    Object.assign(this.hazardCtx, nextCtx);
    hazard.driverState = this.hazardCtx.state;
    void prevState;

    // (2) Once the hazard driver is compromised (Suspected or Confirmed), the
    // vehicle decelerates firmly toward a near-stop. This is handled directly
    // (not via IDM) because the driver is no longer following traffic — they are
    // slowing/stopping regardless. This creates the dangerous speed differential
    // that following traffic must react to.
    const hazardSlowing = this.hazardCtx.state !== DriverState.Normal;

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
          // Earlier advisory: record receipt time; the driver acts after a short
          // in-cabin reaction delay (REACTION.v2xAdvisory).
          if (v.advisorySpeed === null) {
            v.advisorySpeed = item.message.advisorySpeed;
            v.advisoryReceivedAt = this.time;
          }
        }
      }
    }

    // RSUs: update signs from any currently broadcasting hazard (v2x scenario).
    if (this.kind === "v2x" && shouldBroadcast(this.hazardCtx)) {
      const msg = this.makeHazardMessage(hazard);
      for (const rsu of this.rsus) {
        updateRSU(rsu, msg);
      }
    }
    expireRSUs(this.rsus, this.time);

    // (5)+(6) Update every vehicle lane-by-lane with IDM + advisory/visual logic.
    this.updateVehicles(hazard, hazardSlowing, dt);

    // (7) Collisions + hazard near-stop time for lead-time metric.
    this.detectAndRecordCollisions();
    if (hazard.speed <= NEAR_STOP_SPEED) {
      this.metrics.recordHazardNearStop(this.time);
    }
  }

  // --------------------------------------------------------------------------

  private vehicleById(id: number): Vehicle {
    // Vehicles are created with contiguous ids starting at 0.
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

    // Receivers in range: connected vehicles behind the hazard within commRange.
    const receivers: (number | string)[] = [];
    for (const v of this.vehicles) {
      if (v.id === hazard.id || v.crashed || !v.isConnected) continue;
      const dist = Math.abs(v.position - hazard.position);
      if (dist <= this.config.commRange) {
        receivers.push(v.id);
      }
    }
    // RSUs in range also "receive" (handled via updateRSU in step()).
    this.bus.broadcast(msg, receivers, this.time);
  }

  private updateVehicles(
    hazard: Vehicle,
    hazardSlowing: boolean,
    dt: number
  ): void {
    // Group by lane and sort by position so each vehicle sees its true leader.
    const lanes: Vehicle[][] = Array.from(
      { length: this.config.laneCount },
      () => []
    );
    for (const v of this.vehicles) lanes[v.lane].push(v);
    for (const lane of lanes) lane.sort((a, b) => a.position - b.position);

    for (const lane of lanes) {
      for (let i = 0; i < lane.length; i++) {
        const v = lane[i];
        const leader = i + 1 < lane.length ? lane[i + 1] : null;

        // Record a TTC sample against the leader (closing situations only).
        if (leader) {
          const gap = leader.position - v.position - leader.length;
          const dv = v.speed - leader.speed;
          this.metrics.recordTTC(gap, dv);
        }

        if (v.id === hazard.id) {
          // Hazard vehicle: direct firm deceleration toward a near-stop, not IDM.
          this.stepHazardVehicle(v, hazardSlowing, dt);
          this.metrics.recordAcceleration(v.acceleration);
          continue;
        }

        // Followers: reduce their desired speed via the information channels
        // (this also latches visual/advisory perception timestamps on v).
        const effectiveDesired = this.followerTargetSpeed(v, hazard, leader);

        // Decide what this driver can actually SEE / is acting on this tick.
        //
        // The honest core of the model: a driver who has NOT yet perceived the
        // emergency does not brake for it. If the slow/stopped obstacle ahead is
        // still beyond their perception (too far to see, no advisory, or still
        // inside their reaction delay), they keep driving at free-flow — they have
        // not noticed anything is wrong. Only once they perceive it (visually, or
        // via a V2X advisory) do they engage car-following braking.
        //
        // This is what makes late information dangerous: a fast car bearing down
        // on a queue it cannot see yet keeps full speed, then has far too little
        // room once it finally reacts. An early V2X advisory removes that window.
        const perceived = this.hasPerceivedHazard(v, hazard, leader);

        if (perceived) {
          // Reacting driver: full IDM car-following toward the (reduced) target.
          const leaderInput: Leader | null = leader
            ? { position: leader.position, speed: leader.speed, length: leader.length }
            : null;
          stepVehicle(v, leaderInput, effectiveDesired, dt);
        } else {
          // Un-alerted driver: drive free-flow toward desired speed, NOT braking
          // for the unperceived obstacle. (Still bounded; still deterministic.)
          this.cruiseFreeFlow(v, dt);
        }
        this.metrics.recordAcceleration(v.acceleration);
      }
    }
  }

  /**
   * Has this follower actually PERCEIVED the emergency ahead and begun reacting?
   * Only a perceiving driver engages car-following braking; everyone else keeps
   * driving free-flow (see updateVehicles). A driver perceives when ANY of:
   *
   *   - There is no active emergency yet, OR the leader is not meaningfully slower
   *     than them — i.e. ordinary traffic. Normal car-following always applies;
   *     this model only gates the EMERGENCY response, never baseline following.
   *   - They are acting on a delivered V2X advisory (advisoryActive). This is the
   *     early channel — it fires BEFORE they could ever see the hazard.
   *   - They can SEE a slow/stopped leader within VISUAL_RANGE and their own
   *     reaction delay (REACTION.visual) has elapsed since first sighting. This is
   *     the LATE channel — the only one available without V2X.
   *
   * The visual sighting clock is per-driver and starts the moment a slow leader
   * enters their visual range, modeling genuine line-of-sight perception.
   */
  private hasPerceivedHazard(
    v: Vehicle,
    hazard: Vehicle,
    leader: Vehicle | null
  ): boolean {
    const emergencyActive = hazard.driverState !== DriverState.Normal;

    // No emergency, or no leader: ordinary free/following behavior — never gated.
    if (!emergencyActive || !leader) {
      v.leaderBrakeNoticedAt = null;
      return true;
    }

    const gap = leader.position - v.position - leader.length;
    const leaderMuchSlower = leader.speed < v.speed - 2.0;

    // Leader not meaningfully slower than us yet: nothing to react to; drive
    // normally (baseline IDM following is not suppressed).
    if (!leaderMuchSlower || gap > VISUAL_RANGE * 2) {
      v.leaderBrakeNoticedAt = null;
      // If we're already slower/matched, normal following keeps the gap fine.
      return true;
    }

    // V2X advisory already active: the driver was alerted early and is reacting.
    if (v.advisoryActive) {
      v.leaderBrakeNoticedAt = null;
      return true;
    }

    // Visual channel: can the driver SEE the slow leader (within visual range)?
    if (gap <= VISUAL_RANGE) {
      if (v.leaderBrakeNoticedAt === null) {
        v.leaderBrakeNoticedAt = this.time;
      }
      // Reacted only once the human reaction delay has elapsed since sighting.
      return this.time - v.leaderBrakeNoticedAt >= REACTION.visual;
    }

    // Slow leader exists but is still beyond visual range and no advisory: the
    // driver cannot perceive it yet. They keep driving free-flow (the danger).
    v.leaderBrakeNoticedAt = null;
    return false;
  }

  /**
   * Free-flow driving for a driver who has not perceived the hazard: accelerate
   * toward their desired speed with no leader interaction (they have not noticed
   * the slow car ahead). Bounded, deterministic — never exceeds desired speed.
   */
  private cruiseFreeFlow(v: Vehicle, dt: number): void {
    if (v.crashed) {
      v.speed = 0;
      v.acceleration = 0;
      return;
    }
    // IDM free-road term only (gap = Infinity => no braking for any leader).
    stepVehicle(v, null, v.desiredSpeed, dt);
  }

  /** Hazard vehicle deceleration: lift off and brake toward a near-stop. */
  private stepHazardVehicle(v: Vehicle, slowing: boolean, dt: number): void {
    if (v.crashed) {
      v.speed = 0;
      v.acceleration = 0;
      return;
    }
    if (!slowing) {
      // Still normal: cruise at desired speed.
      v.acceleration = 0;
      v.position += v.speed * dt;
      return;
    }
    let newSpeed: number;
    if (v.speed > HAZARD_STOP_SPEED) {
      newSpeed = Math.max(HAZARD_STOP_SPEED, v.speed - HAZARD_DECEL * dt);
      v.acceleration = -HAZARD_DECEL;
    } else {
      newSpeed = HAZARD_STOP_SPEED;
      v.acceleration = 0;
    }
    v.position += ((v.speed + newSpeed) / 2) * dt;
    v.speed = newSpeed;
  }

  /**
   * Compute a follower's effective desired speed given the hazard. Two
   * information channels, modeling the core V2X advantage:
   *
   *   - VISUAL (every driver, both scenarios): a driver can only perceive the
   *     slowed hazard once it is within VISUAL_RANGE AHEAD IN THEIR OWN LANE, and
   *     then only reacts after REACTION.visual seconds. This is late — by the time
   *     a fast closing car sees a near-stopped vehicle, hard braking (and often a
   *     rear-end collision) can result.
   *
   *   - V2X ADVISORY (connected vehicles, v2x scenario only): the driver is
   *     alerted in-cabin as soon as the message is delivered — BEFORE they can see
   *     the hazard — and reacts after a short REACTION.v2xAdvisory delay. This
   *     earlier, graduated slowdown is what prevents the collision.
   *
   * The more cautious (lower) applicable target wins. IDM then produces the
   * actual, physically-bounded braking.
   */
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
      // Latch the moment this driver first SEES the hazard, then apply a reaction
      // delay from that moment (not from global emergency onset).
      if (v.visualSeenAt === null) {
        v.visualSeenAt = this.time;
      }
      if (this.time - v.visualSeenAt >= REACTION.visual) {
        v.respondingToHazard = true;
        target = Math.min(target, this.graduatedTarget(distance, ADVISORY_SPEED));
      }
    }

    return target;
  }

  /**
   * Graduated target speed by distance to hazard: closer => closer to advisory
   * speed; farther => nearer free-flow. Produces a smooth deceleration wave
   * rather than everyone braking at once.
   *
   * The curve is deliberately gentle so a V2X-advised car far upstream only eases
   * off at first and tightens its target as it approaches. That smooth, early
   * glide is the honest V2X benefit: the car bleeds off speed over a long distance
   * and never needs a hard, late stab at the brakes — unlike a hazard-only driver
   * who keeps full speed until the hazard pops into visual range and must brake
   * hard (lower TTC, harder braking, and in dense/fast traffic a rear-end crash).
   */
  private graduatedTarget(distance: number, advisory: number): number {
    const full = 60; // within 60 m: full advisory crawl speed
    const fade = 420; // beyond 420 m: essentially free flow
    if (distance <= full) return advisory;
    if (distance >= fade) return Infinity; // no constraint
    const t = (distance - full) / (fade - full); // 0..1 (near..far)
    // Smooth ramp from the advisory crawl speed up toward free flow. Using a
    // square-root shape keeps the far end high (barely constrained) while pulling
    // the target down firmly as the car closes in.
    const span = this.config.meanSpeed * 1.6; // headroom above advisory
    return advisory + Math.sqrt(t) * span;
  }

  private detectAndRecordCollisions(): void {
    const lanes: Vehicle[][] = Array.from(
      { length: this.config.laneCount },
      () => []
    );
    for (const v of this.vehicles) lanes[v.lane].push(v);
    for (const lane of lanes) {
      lane.sort((a, b) => a.position - b.position);
      const n = detectCollisions(lane);
      for (let i = 0; i < n; i++) this.metrics.recordCollision();
    }
  }
}
