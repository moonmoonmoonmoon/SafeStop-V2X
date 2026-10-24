import { describe, it, expect } from "vitest";
import { V2XBus } from "../v2x";
import { Rng } from "../rng";
import { V2XMessageType, type V2XMessage } from "../types";

function makeMessage(now: number, lifetime = 10): V2XMessage {
  return {
    id: 1,
    type: V2XMessageType.EmergencySlowdown,
    originId: 0,
    originPosition: 100,
    originLane: 1,
    advisorySpeed: 8,
    createdAt: now,
    expiresAt: now + lifetime,
  };
}

describe("V2X message bus", () => {
  it("delivers messages after the configured latency, not before", () => {
    const bus = new V2XBus(0.1, 0, new Rng(1));
    const msg = makeMessage(0);
    bus.broadcast(msg, [5], 0);

    // Before latency elapses: nothing due.
    expect(bus.collectDue(0.05)).toHaveLength(0);
    // At/after latency: delivered.
    const due = bus.collectDue(0.1);
    expect(due).toHaveLength(1);
    expect(due[0].receiverId).toBe(5);
  });

  it("drops stale messages past expiration (not counted as delivered)", () => {
    const bus = new V2XBus(0.1, 0, new Rng(1));
    const msg = makeMessage(0, 0.05); // expires at 0.05, but delivers at 0.1
    bus.broadcast(msg, [5], 0);
    const due = bus.collectDue(0.1);
    expect(due).toHaveLength(0);
    expect(bus.stats.delivered).toBe(0);
    expect(bus.stats.attempted).toBe(1);
  });

  it("applies packet loss: loss=1 delivers nothing, loss=0 delivers all", () => {
    const lossy = new V2XBus(0, 1, new Rng(42));
    lossy.broadcast(makeMessage(0), [1, 2, 3], 0);
    expect(lossy.collectDue(0)).toHaveLength(0);
    expect(lossy.deliveryRate()).toBe(0);

    const clean = new V2XBus(0, 0, new Rng(42));
    clean.broadcast(makeMessage(0), [1, 2, 3], 0);
    expect(clean.collectDue(0)).toHaveLength(3);
    expect(clean.deliveryRate()).toBe(1);
  });

  it("delivery rate reflects partial loss and is deterministic per seed", () => {
    const a = new V2XBus(0, 0.5, new Rng(7));
    const b = new V2XBus(0, 0.5, new Rng(7));
    const ids = Array.from({ length: 100 }, (_, i) => i);
    a.broadcast(makeMessage(0), ids, 0);
    b.broadcast(makeMessage(0), ids, 0);
    a.collectDue(0);
    b.collectDue(0);
    // Same seed => identical outcome (deterministic replay).
    expect(a.stats.delivered).toBe(b.stats.delivered);
    // Roughly half delivered.
    expect(a.deliveryRate()).toBeGreaterThan(0.3);
    expect(a.deliveryRate()).toBeLessThan(0.7);
  });

  it("respects communication range via the caller-provided receiver list", () => {
    // The bus delivers only to the ids it is given; range filtering happens
    // upstream. Verify it never invents receivers.
    const bus = new V2XBus(0, 0, new Rng(1));
    bus.broadcast(makeMessage(0), [], 0);
    expect(bus.collectDue(0)).toHaveLength(0);
    expect(bus.stats.attempted).toBe(0);
  });
});
