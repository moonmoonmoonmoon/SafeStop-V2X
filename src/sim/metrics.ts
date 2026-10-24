/**
 * Safety metrics accumulated over a simulation run.
 *
 *   - collisions:          count of rear-end contacts detected.
 *   - minTTC:              minimum time-to-collision across all following pairs (s).
 *                          TTC = gap / approachRate, only when closing (dv > 0).
 *   - maxBrakingDecel:     largest braking magnitude any vehicle used (m/s^2).
 *   - warningLeadTime:     time between first warning delivery and the hazard
 *                          vehicle reaching near-stop (s). Larger = more time for
 *                          following traffic to respond.
 *   - messageDeliveryRate: delivered / attempted V2X messages [0..1].
 */
import type { Metrics, Vehicle } from "./types";

export class MetricsAccumulator {
  collisions = 0;
  minTTC = Infinity;
  maxBrakingDecel = 0;
  firstWarningAt: number | null = null;
  hazardNearStopAt: number | null = null;

  /** Record a braking event (accel is signed; we track braking magnitude). */
  recordAcceleration(accel: number): void {
    if (accel < 0) {
      this.maxBrakingDecel = Math.max(this.maxBrakingDecel, -accel);
    }
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
    return {
      collisions: this.collisions,
      minTTC: this.minTTC,
      maxBrakingDecel: this.maxBrakingDecel,
      warningLeadTime: lead,
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
