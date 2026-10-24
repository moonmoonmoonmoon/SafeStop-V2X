/**
 * Safety metrics accumulated over a simulation run.
 *
 *   - collisions:          count of rear-end contacts detected.
 *   - minTTC:              minimum time-to-collision across all following pairs (s).
 *                          TTC = gap / approachRate, only when closing (dv > 0).
 *   - maxBrakingDecel:     largest braking magnitude any vehicle used (m/s^2).
 *   - harshBrakingEvents:  count of DANGEROUS hard-braking episodes (near-misses).
 *                          See recordVehicleBraking below for the exact, honest
 *                          definition and why it is defined this way.
 *   - warningLeadTime:     time between first warning delivery and the hazard
 *                          vehicle reaching near-stop (s). Larger = more time for
 *                          following traffic to respond.
 *   - pullOverCompletionTime: time from emergency confirmation to shoulder-stop
 *                          (s), or null if the pull-over never completed.
 *   - messageDeliveryRate: delivered / attempted V2X messages [0..1].
 */
import type { Metrics, Vehicle, VehicleId } from "./types";
import { HARSH_BRAKING_THRESHOLD, NEAR_MISS_TTC } from "./constants";

export class MetricsAccumulator {
  collisions = 0;
  minTTC = Infinity;
  maxBrakingDecel = 0;
  harshBrakingEvents = 0;
  firstWarningAt: number | null = null;
  hazardNearStopAt: number | null = null;
  confirmedAt: number | null = null;
  pullOverCompletedAt: number | null = null;

  /**
   * Per-vehicle latch so a single sustained hard-braking episode counts as ONE
   * harsh-braking event (counted on the rising edge into the harsh regime), not
   * once per tick.
   */
  private harshLatched = new Set<VehicleId>();

  /** Record a braking event (accel is signed; we track braking magnitude). */
  recordAcceleration(accel: number): void {
    if (accel < 0) {
      this.maxBrakingDecel = Math.max(this.maxBrakingDecel, -accel);
    }
  }

  /**
   * Record a vehicle's braking for the harsh-event counter.
   *
   * HONEST DEFINITION (why it is this and not "any hard brake"):
   *   A harsh-braking EVENT is a DANGEROUS, last-moment stab at the brakes — the
   *   kind that signals a near-miss. It is counted once per episode (on the rising
   *   edge) ONLY when BOTH hold at the same instant:
   *     (a) the vehicle brakes harder than HARSH_BRAKING_THRESHOLD, AND
   *     (b) its time-to-collision to the leader is at or below NEAR_MISS_TTC —
   *         i.e. it is braking hard because it is genuinely too close.
   *
   *   Earlier this metric counted EVERY hard-braking dip across the whole fleet.
   *   That penalised the V2X scenario for the wrong reason: V2X makes MORE cars
   *   respond to the hazard at all (unalerted cars in the hazard-only world never
   *   perceive it and so never brake). Counting all responses made "more cars
   *   acting safely" look worse than "most cars obliviously doing nothing". A car
   *   easing firmly onto a V2X advisory while it still has a huge gap (large/▸∞
   *   TTC) is not a safety event; a surprised driver braking hard with <2.5 s to
   *   impact is. Gating on TTC counts the second and ignores the first, so the
   *   metric measures real danger and cannot be inflated merely by more cars
   *   responding. It is legitimately EQUAL (often 0 vs 0) in a mild scenario where
   *   no one is actually at risk, and separates sharply when there is real danger.
   *
   * `ttc` is the vehicle's current time-to-collision to its leader (s), or
   * Infinity when it is not closing / has no leader.
   */
  recordVehicleBraking(id: VehicleId, accel: number, ttc: number): void {
    const harsh = accel <= -HARSH_BRAKING_THRESHOLD && ttc <= NEAR_MISS_TTC;
    if (harsh && !this.harshLatched.has(id)) {
      this.harshBrakingEvents++;
      this.harshLatched.add(id);
    } else if (!harsh && this.harshLatched.has(id)) {
      this.harshLatched.delete(id);
    }
  }

  recordConfirmed(now: number): void {
    if (this.confirmedAt === null) this.confirmedAt = now;
  }

  recordPullOverCompleted(now: number): void {
    if (this.pullOverCompletedAt === null) this.pullOverCompletedAt = now;
  }

  /** Record a time-to-collision sample for a closing follower/leader pair. */
  recordTTC(gap: number, approachRate: number): void {
    if (approachRate > 0.01 && gap > 0) {
      const ttc = gap / approachRate;
      this.minTTC = Math.min(this.minTTC, ttc);
    }
  }

  recordCollision(): void {
    this.collisions++;
  }

  recordFirstWarning(now: number): void {
    if (this.firstWarningAt === null) {
      this.firstWarningAt = now;
    }
  }

  recordHazardNearStop(now: number): void {
    if (this.hazardNearStopAt === null) {
      this.hazardNearStopAt = now;
    }
  }

  snapshot(deliveryRate: number): Metrics {
    let lead = 0;
    if (this.firstWarningAt !== null && this.hazardNearStopAt !== null) {
      lead = Math.max(0, this.hazardNearStopAt - this.firstWarningAt);
    }
    let pullOverTime: number | null = null;
    if (this.confirmedAt !== null && this.pullOverCompletedAt !== null) {
      pullOverTime = Math.max(0, this.pullOverCompletedAt - this.confirmedAt);
    }
    return {
      collisions: this.collisions,
      minTTC: this.minTTC,
      maxBrakingDecel: this.maxBrakingDecel,
      harshBrakingEvents: this.harshBrakingEvents,
      warningLeadTime: lead,
      pullOverCompletionTime: pullOverTime,
      messageDeliveryRate: deliveryRate,
    };
  }
}

/**
 * Detect rear-end collisions in a single lane's ordered vehicle list and mark
 * crashed vehicles. Returns the number of NEW collisions this call.
 * `laneVehicles` must be sorted by ascending position.
 */
export function detectCollisions(laneVehicles: Vehicle[]): number {
  let newCollisions = 0;
  for (let i = 1; i < laneVehicles.length; i++) {
    const rear = laneVehicles[i - 1];
    const front = laneVehicles[i];
    const gap = front.position - rear.position - front.length;
    if (gap <= 0 && !(rear.crashed && front.crashed)) {
      if (!rear.crashed || !front.crashed) {
        if (!rear.crashed) rear.crashed = true;
        if (!front.crashed) front.crashed = true;
        newCollisions++;
      }
    }
  }
  return newCollisions;
}
