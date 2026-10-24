import { describe, it, expect } from "vitest";
import { World, safeToChangeInto } from "../world";
import { Simulation, DEFAULT_CONFIG, DEMO_PRESET_CONFIG } from "../simulation";
import {
  DriverState,
  PullOverPhase,
  VehicleRole,
  type SimConfig,
  type Vehicle,
} from "../types";
import { SAFE_MERGE_GAP, VEHICLE_LENGTH } from "../constants";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVehicle(
  id: number,
  lane: number,
  position: number,
  overrides: Partial<Vehicle> = {}
): Vehicle {
  return {
    id,
    lane,
    laneF: lane,
    position,
    speed: 20,
    acceleration: 0,
    length: VEHICLE_LENGTH,
    desiredSpeed: 20,
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
    ...overrides,
  };
}

function stepsFor(seconds: number): number {
  return Math.round(seconds / 0.05);
}

/** Advance a World and return its hazard vehicle each step for inspection. */
function runWorld(w: World, seconds: number): void {
  const n = stepsFor(seconds);
  for (let i = 0; i < n; i++) w.step();
}

// ---------------------------------------------------------------------------
// (4) safeToChangeInto respects BOTH the front and rear SAFE_MERGE_GAP
// ---------------------------------------------------------------------------

describe("safeToChangeInto (pure gap-acceptance helper)", () => {
  const hazard = makeVehicle(0, 1, 500);
  const targetLane = 2;

  it("is safe when the target lane is empty (both gaps Infinity)", () => {
    expect(safeToChangeInto(hazard, [hazard], targetLane)).toBe(true);
  });

  it("rejects when the FRONT gap is below SAFE_MERGE_GAP.front", () => {
    // Leader just ahead in the target lane, front gap = (front - rear) ... compute
    // a bumper gap just under the required front gap.
    const frontGap = SAFE_MERGE_GAP.front - 1;
    const lead = makeVehicle(1, targetLane, hazard.position + VEHICLE_LENGTH + frontGap);
    // Ample rear clearance so only the front gap can be the cause.
    const rear = makeVehicle(2, targetLane, hazard.position - hazard.length - 100);
    expect(safeToChangeInto(hazard, [hazard, lead, rear], targetLane)).toBe(false);
  });

  it("rejects when the REAR gap is below SAFE_MERGE_GAP.rear", () => {
    const rearGap = SAFE_MERGE_GAP.rear - 1;
    const rear = makeVehicle(1, targetLane, hazard.position - hazard.length - rearGap);
    // Ample front clearance so only the rear gap can be the cause.
    const lead = makeVehicle(2, targetLane, hazard.position + VEHICLE_LENGTH + 100);
    expect(safeToChangeInto(hazard, [hazard, lead, rear], targetLane)).toBe(false);
  });

  it("accepts only when BOTH gaps meet their respective thresholds", () => {
    const lead = makeVehicle(
      1,
      targetLane,
      hazard.position + VEHICLE_LENGTH + SAFE_MERGE_GAP.front + 0.5
    );
    const rear = makeVehicle(
      2,
      targetLane,
      hazard.position - hazard.length - SAFE_MERGE_GAP.rear - 0.5
    );
    expect(safeToChangeInto(hazard, [hazard, lead, rear], targetLane)).toBe(true);
  });

  it("ignores vehicles in other lanes and crashed vehicles", () => {
    const otherLane = makeVehicle(1, targetLane + 1, hazard.position); // different lane
    const crashedClose = makeVehicle(2, targetLane, hazard.position - hazard.length - 2, {
      crashed: true,
    });
    expect(safeToChangeInto(hazard, [hazard, otherLane, crashedClose], targetLane)).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// (1) Does NOT change lanes when the target lane lacks a safe gap
// ---------------------------------------------------------------------------

describe("emergency pull-over gating", () => {
  it("stays in its lane (phase Requesting) when the target lane is packed", () => {
    // A single-lane highway has NO travel lane to the right — the only target is
    // the shoulder, which is always clear. To exercise a BLOCKED travel-lane
    // merge we need a scenario where the target travel lane is kept full. The
    // DEMO preset's hazard-only world is exactly that: the target lane stays
    // congested/overwhelmed and the hazard never reaches a shoulder stop.
    const w = new World("hazard-only", DEMO_PRESET_CONFIG);
    runWorld(w, 30);
    const hazard = w.vehicles.find((v) => v.id === w.hazardVehicleId)!;
    // It declared the emergency (left Normal) but could not safely complete the
    // pull-over: it is NOT stopped on the shoulder.
    expect(hazard.driverState).not.toBe(DriverState.Normal);
    expect(hazard.pullOver).not.toBe(PullOverPhase.Stopped);
    expect(w.getMetrics().pullOverCompletionTime).toBeNull();
  });

  it("only enters the Changing phase after the emergency is declared", () => {
    // The World transitions None -> Requesting -> Changing: the lateral move
    // (Changing) can never happen before the emergency is active, and a change is
    // only ever entered from Requesting (the gap-gated state). Verify the phase
    // ordering holds across a full run in both worlds, and that a change does
    // actually occur (the maneuver is not permanently stuck in DEFAULT).
    for (const kind of ["hazard-only", "v2x"] as const) {
      const w = new World(kind, DEFAULT_CONFIG);
      const n = stepsFor(30);
      let sawRequesting = false;
      let sawChanging = false;
      let changedBeforeRequesting = false;
      for (let i = 0; i < n; i++) {
        w.step();
        const hazard = w.vehicles.find((v) => v.id === w.hazardVehicleId)!;
        if (hazard.pullOver === PullOverPhase.Requesting) sawRequesting = true;
        if (hazard.pullOver === PullOverPhase.Changing) {
          sawChanging = true;
          if (!sawRequesting) changedBeforeRequesting = true;
        }
      }
      expect(changedBeforeRequesting).toBe(false); // never Changing before Requesting
      expect(sawRequesting).toBe(true);
      expect(sawChanging).toBe(true);
    }
  });

  it("waits (does not reach the shoulder) when the target lane stays packed", () => {
    // Pack the FIRST target travel lane with a dense wall of cars traveling at the
    // hazard's pull-over request speed, straddling the hazard. Because the wall
    // moves at the speed the hazard settles to, it keeps straddling the hazard and
    // no safe gap opens, so the hazard can never complete the pull-over.
    const w = new World("hazard-only", DEFAULT_CONFIG);
    const hazard = w.vehicles.find((v) => v.id === w.hazardVehicleId)!;
    const targetLane = hazard.lane + 1;

    // Remove existing target-lane traffic, then lay a tight wall (5.5 m centers =>
    // ~1 m bumper gaps, far below the ~12/16 m required) matched to the request
    // speed so it tracks the slowing hazard.
    w.vehicles = w.vehicles.filter(
      (v) => v.id === hazard.id || v.lane !== targetLane
    );
    let packId = 10_000;
    const requestSpeed = 12; // PULLOVER_REQUEST_SPEED
    for (let offset = -200; offset <= 200; offset += VEHICLE_LENGTH + 1) {
      w.vehicles.push(
        makeVehicle(packId++, targetLane, hazard.position + offset, {
          speed: requestSpeed,
          desiredSpeed: requestSpeed,
        })
      );
    }

    runWorld(w, 25);
    // Blocked the whole time: never stopped on the shoulder.
    expect(hazard.pullOver).not.toBe(PullOverPhase.Stopped);
    expect(hazard.lane).toBeLessThan(w.shoulderLane);
    expect(w.getMetrics().pullOverCompletionTime).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (2) DOES change lanes and reach the shoulder when a safe gap exists
// ---------------------------------------------------------------------------

describe("emergency pull-over completion", () => {
  it("reaches the shoulder (phase Stopped) when safe gaps are available (v2x DEFAULT)", () => {
    const w = new World("v2x", DEFAULT_CONFIG);
    runWorld(w, 30);
    const hazard = w.vehicles.find((v) => v.id === w.hazardVehicleId)!;
    expect(hazard.pullOver).toBe(PullOverPhase.Stopped);
    expect(hazard.lane).toBe(w.shoulderLane);
    expect(hazard.speed).toBeLessThanOrEqual(1.0);
    expect(w.getMetrics().pullOverCompletionTime).not.toBeNull();
  });

  it("also completes in the hazard-only DEFAULT world, just later", () => {
    const sim = new Simulation(DEFAULT_CONFIG);
    for (let i = 0; i < stepsFor(30); i++) sim.step();
    const snap = sim.snapshot();
    expect(snap.hazardOnly.emergencyPhase).toBe(PullOverPhase.Stopped);
    expect(snap.v2x.emergencyPhase).toBe(PullOverPhase.Stopped);
    const hzt = snap.hazardOnly.metrics.pullOverCompletionTime!;
    const v2xt = snap.v2x.metrics.pullOverCompletionTime!;
    expect(v2xt).toBeLessThan(hzt); // cooperative merge is sooner
  });
});

// ---------------------------------------------------------------------------
// (3) Never occupies the same (lane, overlapping position) as another vehicle
// ---------------------------------------------------------------------------

describe("no overlap / teleport during the pull-over", () => {
  // The emergency vehicle changes lanes smoothly (laneF advances at a bounded
  // rate) and only ever COMMITS to the target lane when it is safe. Across a full
  // run, its integer lane must never coincide with another non-crashed vehicle at
  // an overlapping longitudinal position (which would be a teleport/overlap bug).
  function assertNoEmergencyOverlap(config: SimConfig, kind: "hazard-only" | "v2x") {
    const w = new World(kind, config);
    const n = stepsFor(30);
    let maxLaneFJump = 0;
    let prevLaneF: number | null = null;
    for (let i = 0; i < n; i++) {
      w.step();
      const hazard = w.vehicles.find((v) => v.id === w.hazardVehicleId)!;

      // Lateral motion is smooth: laneF never jumps by more than a small bound.
      if (prevLaneF !== null) {
        maxLaneFJump = Math.max(maxLaneFJump, Math.abs(hazard.laneF - prevLaneF));
      }
      prevLaneF = hazard.laneF;

      if (hazard.crashed) continue;
      // No other LIVE vehicle shares the hazard's integer lane at an overlapping
      // position (bumper-to-bumper overlap => teleport/overlap).
      for (const other of w.vehicles) {
        if (other.id === hazard.id || other.crashed) continue;
        if (other.lane !== hazard.lane) continue;
        const centerGap = Math.abs(other.position - hazard.position);
        const overlap = centerGap < (other.length + hazard.length) / 2 - 1e-6;
        expect(overlap).toBe(false);
      }
    }
    // A single lane change takes ~2 s; per 0.05 s step laneF moves ~0.025 — the
    // jump must stay tiny (definitely never a full-lane teleport).
    expect(maxLaneFJump).toBeLessThan(0.1);
  }

  it("v2x DEFAULT: emergency vehicle never overlaps another vehicle", () => {
    assertNoEmergencyOverlap(DEFAULT_CONFIG, "v2x");
  });

  it("hazard-only DEFAULT: emergency vehicle never overlaps another vehicle", () => {
    assertNoEmergencyOverlap(DEFAULT_CONFIG, "hazard-only");
  });

  it("v2x DEMO: emergency vehicle never overlaps another vehicle", () => {
    assertNoEmergencyOverlap(DEMO_PRESET_CONFIG, "v2x");
  });
});
