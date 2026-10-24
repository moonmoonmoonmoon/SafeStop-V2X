import { describe, it, expect } from "vitest";
import {
  Simulation,
  DEFAULT_CONFIG,
  DEMO_PRESET_CONFIG,
} from "../simulation";
import type { SimConfig } from "../types";

/** Run a simulation for `seconds` and return the final snapshot. */
function run(config: SimConfig, seconds: number) {
  const sim = new Simulation(config);
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) sim.step();
  return sim.snapshot();
}

// A full run long enough for the pull-over maneuver to complete in both worlds
// of the DEFAULT scenario (the hazard-only world waits for a natural merge gap,
// so it finishes noticeably later than the cooperative v2x world).
const FULL = 30;

describe("deterministic replay", () => {
  it("produces byte-identical results for the same config + seed", () => {
    const a = run(DEFAULT_CONFIG, 8);
    const b = run(DEFAULT_CONFIG, 8);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("produces different results for a different seed", () => {
    const a = run({ ...DEFAULT_CONFIG, seed: 1 }, 8);
    const b = run({ ...DEFAULT_CONFIG, seed: 2 }, 8);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});

describe("scenario construction", () => {
  it("both worlds start from identical initial vehicle layouts", () => {
    const sim = new Simulation(DEFAULT_CONFIG);
    const snap = sim.snapshot();
    const h = snap.hazardOnly.vehicles.map((v) => [v.lane, v.position]);
    const x = snap.v2x.vehicles.map((v) => [v.lane, v.position]);
    expect(h).toEqual(x);
    // Same designated hazard vehicle in both.
    expect(snap.hazardOnly.hazardVehicleId).toBe(snap.v2x.hazardVehicleId);
  });
});

describe("V2X advantage (behavioral, not a validated safety claim)", () => {
  it("delivers V2X messages when penetration and range allow", () => {
    const snap = run(DEFAULT_CONFIG, 8);
    // Some messages should have been attempted/delivered in the v2x world.
    expect(snap.v2x.metrics.messageDeliveryRate).toBeGreaterThan(0);
  });

  it("V2X scenario produces a positive warning lead time; hazard-only has none", () => {
    const snap = run(DEFAULT_CONFIG, FULL);
    // Hazard-only has no V2X warnings, so its lead time stays 0.
    expect(snap.hazardOnly.metrics.warningLeadTime).toBe(0);
    // V2X should register a positive lead time once a warning is delivered —
    // the advisory reaches upstream traffic BEFORE the hazard reaches near-stop.
    expect(snap.v2x.metrics.warningLeadTime).toBeGreaterThan(0);
  });

  it("bounds braking: no vehicle exceeds the physical deceleration limit", () => {
    const snap = run(DEFAULT_CONFIG, FULL);
    // MAX_EMERGENCY_DECEL is 8.0; allow a tiny numerical margin.
    expect(snap.hazardOnly.metrics.maxBrakingDecel).toBeLessThanOrEqual(8.001);
    expect(snap.v2x.metrics.maxBrakingDecel).toBeLessThanOrEqual(8.001);
  });

  it("DEFAULT: v2x is at least as safe as hazard-only on every reported metric", () => {
    const snap = run(DEFAULT_CONFIG, FULL);
    const h = snap.hazardOnly.metrics;
    const x = snap.v2x.metrics;

    // No collisions in EITHER DEFAULT world — this is the mild scenario.
    expect(h.collisions).toBe(0);
    expect(x.collisions).toBe(0);

    // v2x is never LESS safe on minimum time-to-collision. Both are effectively
    // safe (> 2.5 s) for v2x; the uninformed hazard-only world has a closer call.
    expect(x.minTTC).toBeGreaterThanOrEqual(h.minTTC);
    expect(x.minTTC).toBeGreaterThan(2.5);

    // Harsh (near-miss) braking is NOT inverted: v2x must be <= hazard-only.
    // This is the whole point of the honest metric — more cars RESPONDING in v2x
    // must not be counted against it; only genuinely dangerous brakes count.
    expect(x.harshBrakingEvents).toBeLessThanOrEqual(h.harshBrakingEvents);

    // Braking is never worse in v2x, and always within the physical bound.
    expect(x.maxBrakingDecel).toBeLessThanOrEqual(h.maxBrakingDecel + 1e-6);
  });

  it("DEFAULT: v2x pulls over SOONER than hazard-only (cooperative gap creation)", () => {
    const snap = run(DEFAULT_CONFIG, FULL);
    const h = snap.hazardOnly.metrics.pullOverCompletionTime;
    const x = snap.v2x.metrics.pullOverCompletionTime;
    // Both complete the pull-over within the run...
    expect(h).not.toBeNull();
    expect(x).not.toBeNull();
    // ...but the cooperative v2x world opens a merge gap sooner, so it finishes
    // the pull-over strictly earlier than the hazard-only world (which must wait
    // for a natural gap).
    expect(x!).toBeLessThan(h!);
  });

  it("DEFAULT: v2x warning arrives with lead time to spare", () => {
    const snap = run(DEFAULT_CONFIG, FULL);
    expect(snap.v2x.metrics.warningLeadTime).toBeGreaterThan(0);
  });

  it("DEMO PRESET: hazard-only rear-ends; v2x has strictly fewer collisions", () => {
    // Uses the EXACT config loaded by the on-stage "Demo Preset" button, so the
    // presentation's dramatic contrast is a verified property of the sim.
    const snap = run(DEMO_PRESET_CONFIG, FULL);
    // Without V2X, late visual perception of the stopped queue causes at least
    // one rear-end collision among the fast upstream approachers.
    expect(snap.hazardOnly.metrics.collisions).toBeGreaterThanOrEqual(1);
    // The early radio advisory lets connected cars slow in time: fewer collisions.
    expect(snap.v2x.metrics.collisions).toBeLessThan(
      snap.hazardOnly.metrics.collisions
    );
    // Braking still bounded in both.
    expect(snap.hazardOnly.metrics.maxBrakingDecel).toBeLessThanOrEqual(8.001);
    expect(snap.v2x.metrics.maxBrakingDecel).toBeLessThanOrEqual(8.001);
  });

  it("DEMO PRESET: v2x completes the pull-over; hazard-only does not", () => {
    const snap = run(DEMO_PRESET_CONFIG, FULL);
    // The high-risk hazard-only world never reaches a safe shoulder stop within
    // the run (it is overwhelmed / blocked), so completion time is null.
    expect(snap.hazardOnly.metrics.pullOverCompletionTime).toBeNull();
    expect(snap.hazardOnly.emergencyPhase).not.toBe("Stopped");
    // The v2x world cooperatively opens a gap and completes the pull-over.
    expect(snap.v2x.metrics.pullOverCompletionTime).not.toBeNull();
    expect(snap.v2x.emergencyPhase).toBe("Stopped");
  });

  it("DEMO PRESET: both worlds start from identical initial traffic", () => {
    const sim = new Simulation(DEMO_PRESET_CONFIG);
    const snap = sim.snapshot();
    const h = snap.hazardOnly.vehicles.map((v) => [v.lane, v.position, v.speed]);
    const x = snap.v2x.vehicles.map((v) => [v.lane, v.position, v.speed]);
    expect(h).toEqual(x);
    expect(snap.hazardOnly.hazardVehicleId).toBe(snap.v2x.hazardVehicleId);
  });

  it("DEMO PRESET: replays deterministically (same run every time)", () => {
    const a = run(DEMO_PRESET_CONFIG, FULL);
    const b = run(DEMO_PRESET_CONFIG, FULL);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
