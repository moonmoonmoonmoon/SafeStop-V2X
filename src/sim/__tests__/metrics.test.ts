import { describe, it, expect } from "vitest";
import { MetricsAccumulator, detectCollisions } from "../metrics";
import { DriverState, type Vehicle } from "../types";

function makeVehicle(id: number, position: number, speed = 30): Vehicle {
  return {
    id,
    lane: 0,
    position,
    speed,
    acceleration: 0,
    length: 4.5,
    desiredSpeed: 30,
    isConnected: false,
    driverState: DriverState.Normal,
    respondingToHazard: false,
    advisorySpeed: null,
    advisoryReceivedAt: null,
    advisoryActive: false,
    visualSeenAt: null,
    leaderBrakeNoticedAt: null,
    crashed: false,
  };
}

describe("metrics accumulator", () => {
  it("tracks maximum braking deceleration magnitude only for negative accel", () => {
    const m = new MetricsAccumulator();
    m.recordAcceleration(1.5); // accelerating: ignored
    m.recordAcceleration(-2.0);
    m.recordAcceleration(-5.5);
    m.recordAcceleration(-3.0);
    expect(m.maxBrakingDecel).toBeCloseTo(5.5);
  });

  it("records minimum TTC only when closing (approachRate > 0)", () => {
    const m = new MetricsAccumulator();
    m.recordTTC(100, -5); // opening: ignored
    m.recordTTC(60, 10); // ttc = 6
    m.recordTTC(20, 10); // ttc = 2
    m.recordTTC(50, 5); // ttc = 10
    expect(m.minTTC).toBeCloseTo(2);
  });

  it("computes warning lead time between first warning and hazard near-stop", () => {
    const m = new MetricsAccumulator();
    m.recordFirstWarning(2.0);
    m.recordFirstWarning(2.5); // only first counts
    m.recordHazardNearStop(6.0);
    m.recordHazardNearStop(7.0); // only first counts
    const snap = m.snapshot(1);
    expect(snap.warningLeadTime).toBeCloseTo(4.0);
  });

  it("delivery rate flows through the snapshot", () => {
    const m = new MetricsAccumulator();
    const snap = m.snapshot(0.87);
    expect(snap.messageDeliveryRate).toBeCloseTo(0.87);
  });
});

describe("collision detection", () => {
  it("flags a rear-end contact and marks both vehicles crashed", () => {
    const rear = makeVehicle(0, 100);
    const front = makeVehicle(1, 102); // gap = 102 - 100 - 4.5 < 0
    const n = detectCollisions([rear, front]);
    expect(n).toBe(1);
    expect(rear.crashed).toBe(true);
    expect(front.crashed).toBe(true);
  });

  it("does not flag a safe gap", () => {
    const rear = makeVehicle(0, 100);
    const front = makeVehicle(1, 130);
    const n = detectCollisions([rear, front]);
    expect(n).toBe(0);
    expect(rear.crashed).toBe(false);
    expect(front.crashed).toBe(false);
  });

  it("does not double-count an already-crashed pair", () => {
    const rear = makeVehicle(0, 100);
    const front = makeVehicle(1, 102);
    expect(detectCollisions([rear, front])).toBe(1);
    // Second pass: both already crashed, no new collision.
    expect(detectCollisions([rear, front])).toBe(0);
  });
});
