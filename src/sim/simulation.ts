/**
 * Simulation — runs the two synchronized worlds (hazard-only vs v2x) from the
 * SAME config and seed, in lockstep, so the comparison is apples-to-apples.
 *
 * Deterministic replay: resetting with the same config reproduces the run exactly.
 */
import { World } from "./world";
import type { Metrics, RoadsideUnit, SimConfig, Vehicle } from "./types";
import { DT } from "./constants";

export interface WorldSnapshot {
  vehicles: Vehicle[];
  rsus: RoadsideUnit[];
  metrics: Metrics;
  hazardVehicleId: number;
}

export interface SimSnapshot {
  time: number;
  hazardOnly: WorldSnapshot;
  v2x: WorldSnapshot;
}

export const DEFAULT_CONFIG: SimConfig = {
  seed: 12345,
  laneCount: 3,
  highwayLength: 2000,
  vehicleCount: 24,
  meanSpeed: 31, // ~ 70 mph
  emergencyTime: 3,
  v2xPenetration: 0.7,
  networkLatency: 0.1, // 100 ms
  packetLoss: 0.05, // 5%
  commRange: 400, // m
  messageLifetime: 10, // s
};

/**
 * DEMO_PRESET_CONFIG — the on-stage scenario for a 3-minute pitch.
 *
 * Denser, faster traffic with an earlier emergency. Under these conditions the
 * hazard-only baseline produces at least one rear-end collision while the V2X
 * scenario avoids all collisions — from the SAME seed and identical initial
 * traffic. These exact values are exercised by the "stress" assertions in
 * simulation.test.ts, so the dramatic contrast is a verified, reproducible
 * property of the sim, not a staged one.
 */
export const DEMO_PRESET_CONFIG: SimConfig = {
  ...DEFAULT_CONFIG,
  seed: 12345,
  vehicleCount: 36,
  meanSpeed: 36, // ~ 81 mph
  emergencyTime: 2,
  v2xPenetration: 0.9,
};

export class Simulation {
  config: SimConfig;
  hazardOnly: World;
  v2x: World;

  constructor(config: SimConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.hazardOnly = new World("hazard-only", config);
    this.v2x = new World("v2x", config);
  }

  /** Rebuild both worlds from the (possibly new) config. */
  reset(config: SimConfig = this.config): void {
    this.config = config;
    this.hazardOnly = new World("hazard-only", config);
    this.v2x = new World("v2x", config);
  }

  /** Advance both worlds one fixed timestep. */
  step(): void {
    this.hazardOnly.step();
    this.v2x.step();
  }

  requestSOS(): void {
    this.hazardOnly.requestSOS();
    this.v2x.requestSOS();
  }

  get time(): number {
    return this.v2x.time;
  }

  snapshot(): SimSnapshot {
    return {
      time: this.time,
      hazardOnly: this.worldSnapshot(this.hazardOnly),
      v2x: this.worldSnapshot(this.v2x),
    };
  }

  private worldSnapshot(w: World): WorldSnapshot {
    return {
      // Shallow copies so React sees new references without deep churn.
      vehicles: w.vehicles.map((v) => ({ ...v })),
      rsus: w.rsus.map((r) => ({ ...r })),
      metrics: w.getMetrics(),
      hazardVehicleId: w.hazardVehicleId,
    };
  }
}

export { DT };
