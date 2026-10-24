import { describe, it, expect } from "vitest";
import { Simulation, DEFAULT_CONFIG } from "../simulation";
import type { SimConfig } from "../types";

/** Run a simulation for `seconds` and return the final snapshot. */
function run(config: SimConfig, seconds: number) {
  const sim = new Simulation(config);
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) sim.step();
  return sim.snapshot();
}

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
    const snap = run(DEFAULT_CONFIG, 20);
    // Hazard-only has no V2X warnings, so its lead time stays 0.
    expect(snap.hazardOnly.metrics.warningLeadTime).toBe(0);
    // V2X should register a positive lead time once a warning is delivered —
    // the advisory reaches upstream traffic BEFORE the hazard reaches near-stop.
    expect(snap.v2x.metrics.warningLeadTime).toBeGreaterThan(0);
  });

  it("bounds braking: no vehicle exceeds the physical deceleration limit", () => {
    const snap = run(DEFAULT_CONFIG, 20);
    // MAX_EMERGENCY_DECEL is 8.0; allow a tiny numerical margin.
    expect(snap.hazardOnly.metrics.maxBrakingDecel).toBeLessThanOrEqual(8.001);
    expect(snap.v2x.metrics.maxBrakingDecel).toBeLessThanOrEqual(8.001);
  });

  it("DEFAULT: v2x is measurably safer than hazard-only (higher minTTC, no worse braking)", () => {
    const snap = run(DEFAULT_CONFIG, 20);
    // The honest V2X benefit: upstream connected cars are warned by radio BEFORE
    // they could ever SEE the hazard, so they glide down early instead of braking
    // hard late. That yields a strictly higher minimum time-to-collision.
    expect(snap.v2x.metrics.minTTC).toBeGreaterThan(snap.hazardOnly.metrics.minTTC);
    // Braking is never worse in v2x, and always within the physical bound.
    expect(snap.v2x.metrics.maxBrakingDecel).toBeLessThanOrEqual(
      snap.hazardOnly.metrics.maxBrakingDecel + 1e-6
    );
    // And the V2X warning arrives with lead time to spare.
    expect(snap.v2x.metrics.warningLeadTime).toBeGreaterThan(0);
  });

  it("STRESS: denser/faster traffic rear-ends in hazard-only; v2x has strictly fewer collisions", () => {
    const stress: SimConfig = {
      ...DEFAULT_CONFIG,
      vehicleCount: 36,
      meanSpeed: 36,
      emergencyTime: 2,
      v2xPenetration: 0.9,
    };
    const snap = run(stress, 20);
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
});
