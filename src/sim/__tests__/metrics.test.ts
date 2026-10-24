import { describe, it, expect } from "vitest";
import { MetricsAccumulator, detectCollisions } from "../metrics";
import {
  DriverState,
  PullOverPhase,
  VehicleRole,
  type Vehicle,
} from "../types";

function makeVehicle(id: number, position: number, speed = 30): Vehicle {
  return {
    id,
    lane: 0,
    laneF: 0,
    position,
    speed,
    acceleration: 0,
    length: 4.5,
    desiredSpeed: 30,
    isConnected: false,
    driverState: DriverState.Normal,
    role: VehicleRole.Normal,
    pullOver: PullOverPhase.None,
    pullOverCompletedAt: null,
    yielding: false,
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

  it("computes pull-over completion time from confirmation to shoulder stop", () => {
    const m = new MetricsAccumulator();
    m.recordConfirmed(3.0);
    m.recordPullOverCompleted(18.5);
    const snap = m.snapshot(1);
    expect(snap.pullOverCompletionTime).toBeCloseTo(15.5);
  });

  it("reports null pull-over completion time when it never completed", () => {
    const m = new MetricsAccumulator();
    m.recordConfirmed(3.0);
    // No recordPullOverCompleted -> never reached the shoulder stop.
    const snap = m.snapshot(1);
    expect(snap.pullOverCompletionTime).toBeNull();
  });
});

describe("harsh-braking events (near-miss definition)", () => {
  it("counts a hard brake ONLY when it coincides with a dangerous TTC", () => {
    const m = new MetricsAccumulator();
    // Hard brake but with a huge/▸∞ TTC (plenty of room): NOT a harsh event.
    m.recordVehicleBraking(1, -6.0, Infinity);
    m.recordVehicleBraking(2, -6.0, 5.0); // above NEAR_MISS_TTC (2.5): not harsh
    expect(m.harshBrakingEvents).toBe(0);

    // Hard brake while dangerously close (TTC <= 2.5 s): a genuine near-miss.
    m.recordVehicleBraking(3, -6.0, 1.5);
    expect(m.harshBrakingEvents).toBe(1);
  });

  it("does NOT count a mild brake even at a low TTC (must exceed the threshold)", () => {
    const m = new MetricsAccumulator();
    // Below HARSH_BRAKING_THRESHOLD (4.0 m/s^2): not a harsh brake.
    m.recordVehicleBraking(1, -2.0, 1.0);
    expect(m.harshBrakingEvents).toBe(0);
  });

  it("latches: one sustained near-miss episode counts as a single event", () => {
    const m = new MetricsAccumulator();
    // Same vehicle, several consecutive harsh+close ticks -> one event.
    m.recordVehicleBraking(1, -6.0, 1.2);
    m.recordVehicleBraking(1, -6.5, 1.0);
    m.recordVehicleBraking(1, -6.0, 0.9);
    expect(m.harshBrakingEvents).toBe(1);
    // Leaves the harsh regime (opens up), then re-enters -> a second event.
    m.recordVehicleBraking(1, -1.0, Infinity);
    m.recordVehicleBraking(1, -6.0, 1.1);
    expect(m.harshBrakingEvents).toBe(2);
  });

  it("does NOT count more cars merely RESPONDING (the inversion it fixes)", () => {
    const m = new MetricsAccumulator();
    // Many vehicles brake firmly in response to an advisory, but each still has
    // a safe gap (large TTC). None of these should register as harsh events —
    // responding safely is not a near-miss.
    for (let id = 0; id < 20; id++) {
      m.recordVehicleBraking(id, -5.0, 6.0);
    }
    expect(m.harshBrakingEvents).toBe(0);
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
