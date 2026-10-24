/**
 * Scenario builder.
 *
 * Builds a deterministic initial fleet of vehicles from a SimConfig + seed. The
 * SAME config/seed produces the SAME fleet, which is what lets the two scenarios
 * (hazard-only vs V2X) start from identical initial conditions — the only
 * difference between them is whether V2X messaging is enabled.
 *
 * Initial conditions are STABLE: every vehicle starts at (or below) a common
 * cruising speed with gaps at least the safe following distance, so there is no
 * startup braking transient. The ONLY disturbance in the run is the designated
 * hazard vehicle's emergency. This keeps the comparison and metrics clean.
 */
import {
  DriverState,
  PullOverPhase,
  VehicleRole,
  type SimConfig,
  type Vehicle,
} from "./types";
import { Rng } from "./rng";
import { IDM, VEHICLE_LENGTH, VISUAL_RANGE } from "./constants";

export interface Scenario {
  vehicles: Vehicle[];
  /** The vehicle designated to experience the emergency. */
  hazardVehicleId: number;
}

function makeVehicle(
  id: number,
  lane: number,
  position: number,
  speed: number,
  desiredSpeed: number,
  isConnected: boolean
): Vehicle {
  return {
    id,
    lane,
    laneF: lane,
    position,
    speed,
    acceleration: 0,
    length: VEHICLE_LENGTH,
    desiredSpeed,
    isConnected,
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

export function buildScenario(config: SimConfig): Scenario {
  const rng = new Rng(config.seed);
  const vehicles: Vehicle[] = [];

  // Common cruising speed for a stable start (slightly below mean desired speed).
  const cruise = config.meanSpeed;
  void IDM;

  const midLane = Math.floor(config.laneCount / 2);

  // Deterministic connectivity draw, in a fixed vehicle-index order, so both
  // scenarios share one identical fleet. (The hazard vehicle is forced connected
  // afterward.)
  const nextConnected = () => rng.chance(config.v2xPenetration);

  let id = 0;

  // Distribute vehicleCount across lanes deterministically. The hazard lane is
  // kept deliberately COMPACT (a short cluster plus a small fast upstream group)
  // so the engineered approach-and-stop plays out quickly and the contrast is
  // visible within a short run. Any surplus vehicles go to the other lanes as
  // ordinary background traffic. Totals always equal config.vehicleCount.
  const laneCounts = distributeLaneCounts(config);

  for (let lane = 0; lane < config.laneCount; lane++) {
    const n = laneCounts[lane];
    // The hazard lane gets a deliberately structured layout so there is a clean
    // story to measure; the other lanes are ordinary stable traffic.
    if (lane === midLane) {
      buildHazardLane(vehicles, lane, cruise, n, rng, () => id++, nextConnected);
    } else {
      buildCruisingLane(vehicles, lane, cruise, n, rng, () => id++, nextConnected);
    }
  }

  // --- Designate the hazard vehicle ---
  // In the hazard lane, the hazard is the FRONTMOST vehicle (highest position).
  // A tight cluster of immediate followers trails it closely (they see it early,
  // react in both scenarios — the realistic, similar-in-both part). Further
  // upstream (lower position), beyond an open gap, a group of faster vehicles
  // approaches. Those upstream vehicles are too far back to SEE the hazard when
  // it stops, so in hazard-only they keep full speed until the last moment and
  // brake hard, while in v2x they get the radio advisory early and glide down.
  const laneVehicles = vehicles
    .filter((v) => v.lane === midLane)
    .sort((a, b) => a.position - b.position);
  const hazard = laneVehicles[laneVehicles.length - 1];
  hazard.isConnected = true;

  // --- Engineer the pull-over gap situation in the TARGET lane -------------
  // The emergency vehicle pulls over to the RIGHT, so its first target lane is
  // midLane+1. We reposition a few EXISTING target-lane vehicles into a tight
  // stream straddling the hazard, forming a "merge blocker". No vehicle is added
  // or removed, so vehicleCount is preserved and BOTH worlds get the identical
  // fleet.
  //
  // With the stream there, the hazard cannot merge immediately: the rear gap is
  // unsafe and natural both-sides-safe gaps are rare. The two worlds then diverge
  // HONESTLY:
  //   - hazard-only: the stream (unaware) keeps cruising; the hazard must WAIT
  //     for a rare natural gap, and the safety-constrained merge is held off (any
  //     committed change aborted) until the gap is genuinely clear. It completes
  //     the pull-over LATE and never collides.
  //   - v2x: the connected neighbour just behind the hazard receives the advisory
  //     and YIELDS, easing below the hazard's speed to open the rear gap. The
  //     hazard merges SOONER.
  // This makes cooperative gap-creation the measurable difference between them.
  const targetLane = midLane + 1;
  if (targetLane <= config.laneCount - 1) {
    layoutMergeBlocker(vehicles, hazard, targetLane, cruise);
  }

  return { vehicles, hazardVehicleId: hazard.id };
}

/** Number of close immediate followers trailing the hazard in its own lane. */
const HAZARD_IMMEDIATE_FOLLOWERS = 3;

/** Max fast upstream approachers placed in the hazard lane (keeps it compact). */
const MAX_UPSTREAM_IN_HAZARD_LANE = 5;

/** Number of cars in the target-lane merge stream straddling the hazard. */
const MERGE_STREAM_SIZE = 4;

/** Center-to-center spacing within the merge stream (m). Tight => rare gaps. */
const MERGE_SPACING = 24;



/**
 * Deterministically decide how many vehicles go in each lane. The hazard lane is
 * capped so its engineered structure (cluster + short fast upstream platoon) is
 * compact; remaining vehicles are spread evenly across the other lanes. Always
 * sums to config.vehicleCount.
 */
function distributeLaneCounts(config: SimConfig): number[] {
  const midLane = Math.floor(config.laneCount / 2);
  const counts = new Array<number>(config.laneCount).fill(0);

  const hazardCap = HAZARD_IMMEDIATE_FOLLOWERS + 1 + MAX_UPSTREAM_IN_HAZARD_LANE;
  const hazardLaneCount = Math.min(config.vehicleCount, hazardCap);
  counts[midLane] = hazardLaneCount;

  let remaining = config.vehicleCount - hazardLaneCount;
  const otherLanes: number[] = [];
  for (let l = 0; l < config.laneCount; l++) if (l !== midLane) otherLanes.push(l);

  // Round-robin the rest across the other lanes for an even, deterministic split.
  let idx = 0;
  while (remaining > 0 && otherLanes.length > 0) {
    counts[otherLanes[idx % otherLanes.length]]++;
    idx++;
    remaining--;
  }
  // Single-lane edge case: everything already went to the hazard lane above.
  if (otherLanes.length === 0) counts[midLane] = config.vehicleCount;
  return counts;
}

/**
 * Build the middle (hazard) lane with a deliberate structure (positions increase
 * in the direction of travel, so "upstream"/"behind" means LOWER position):
 *
 *   [ upstream approachers ]  ( open gap )  [ immediate followers ] [ HAZARD ]
 *     low position ..............................................> high position
 *
 * - HAZARD: frontmost vehicle; it performs the emergency stop.
 * - immediate followers: a tight ~1 s-headway group right behind it. They see it
 *   early and react in BOTH scenarios (realistic, similar in both).
 * - open gap: open road, so the upstream group gets no early chain warning.
 * - upstream approachers: faster cars spread across the VISUAL_RANGE..commRange
 *   band behind the hazard. They must rely on their OWN information channel:
 *   visual (late) without V2X, or the radio advisory (early) with V2X. This is
 *   where the honest V2X benefit shows up.
 */
function buildHazardLane(
  vehicles: Vehicle[],
  lane: number,
  cruise: number,
  laneCount: number,
  rng: Rng,
  takeId: () => number,
  nextConnected: () => boolean
): void {
  const clusterCount = Math.min(laneCount, HAZARD_IMMEDIATE_FOLLOWERS + 1); // hazard + followers
  const upstreamCount = Math.max(0, laneCount - clusterCount);

  // Start upstream (low position): the fast approach group at a tight ~0.8 s
  // headway (dense platoon on open road). Marked connected so V2X genuinely
  // reaches them; they want to go a touch faster than cruise, so without warning
  // they close hard on the back of the stopping queue. At this tight spacing a
  // 1.2 s visual reaction lag can be unrecoverable in dense/fast traffic — the
  // honest origin of a rear-end collision when there is no early V2X advisory.
  let pos = rng.range(40, 70);
  const upstreamGap = cruise * 0.8;
  for (let k = 0; k < upstreamCount; k++) {
    const desiredSpeed = cruise + rng.range(3, 7);
    const connected = k % 2 === 0 ? true : nextConnected();
    vehicles.push(
      makeVehicle(takeId(), lane, pos, cruise, desiredSpeed, connected)
    );
    pos += upstreamGap + VEHICLE_LENGTH + rng.range(1, 5);
  }

  // Open gap between the upstream group and the back of the downstream cluster.
  // It is wider than VISUAL_RANGE so the frontmost upstream car literally cannot
  // SEE the stopping queue until it has closed to within visual range — by which
  // point, in dense/fast traffic, a late visual reaction leaves too little room
  // to stop (rear-end collision). With an early V2X advisory the same car has
  // already bled off speed and clears the gap safely. Kept just over VISUAL_RANGE
  // so the fast platoon reaches the forming queue quickly (early, robust crash).
  pos += VISUAL_RANGE + rng.range(20, 50);

  // Downstream cluster: immediate followers at a tight ~1 s headway, then the
  // hazard at the front (highest position added last).
  const clusterGap = cruise * 1.0; // ~1 s headway (m)
  for (let k = 0; k < clusterCount; k++) {
    const desiredSpeed = Math.max(cruise, cruise + rng.range(0, 4));
    vehicles.push(
      makeVehicle(takeId(), lane, pos, cruise, desiredSpeed, nextConnected())
    );
    pos += clusterGap + VEHICLE_LENGTH + rng.range(2, 8);
  }
}

/**
 * Engineer the merge situation in the emergency vehicle's first target lane so
 * that the pull-over is GATED on gap availability, and so cooperative V2X
 * yielding is what opens the gap sooner.
 *
 * We reposition a few EXISTING target-lane vehicles into a tight stream (no
 * add/remove, so the fleet is identical in both worlds and vehicleCount is
 * preserved):
 *
 *     [ car ] [ car ] [ rear neighbour ]   [ hazard (other lane) ]
 *       low position ................................> high position
 *
 * The stream straddles the hazard's longitudinal position and all cars cruise at
 * the common speed, so it stays abreast of the hazard until the emergency begins.
 * It is dense enough that a NATURALLY-occurring both-sides-safe gap next to the
 * hazard is rare:
 *   - hazard-only: the uninformed stream keeps cruising; the hazard must WAIT for
 *     a rare natural gap, and the safety-constrained merge is held off (any
 *     committed change aborted) until the gap is genuinely clear — so it completes
 *     the pull-over LATE and never collides.
 *   - v2x: the rear neighbour just behind the hazard is connected, receives the
 *     advisory and YIELDS, easing below the hazard's speed to deliberately open
 *     the rear gap EARLY — so the hazard merges and completes the pull-over SOONER.
 */
function layoutMergeBlocker(
  vehicles: Vehicle[],
  hazard: Vehicle,
  targetLane: number,
  cruise: number
): void {
  const inLane = vehicles
    .filter((v) => v.lane === targetLane)
    .sort((a, b) => a.position - b.position);
  if (inLane.length === 0) return;

  const blockerCount = Math.min(inLane.length, MERGE_STREAM_SIZE);
  const blockers = inLane.slice(inLane.length - blockerCount);
  // Rear-neighbour sits just behind the hazard; the rest trail at MERGE_SPACING.
  const rearGap = 11; // m behind the hazard, < SAFE_MERGE_GAP.rear (16)
  const rearNeighborPos = hazard.position - hazard.length - rearGap;
  for (let k = 0; k < blockers.length; k++) {
    const v = blockers[k];
    v.position = rearNeighborPos - k * MERGE_SPACING;
    v.laneF = targetLane;
    v.speed = cruise;
    v.desiredSpeed = cruise;
    v.isConnected = true; // connected so the yield can happen in v2x
  }
}

/** Ordinary stable lane: evenly spaced cruising traffic, no engineered gap. */
function buildCruisingLane(
  vehicles: Vehicle[],
  lane: number,
  cruise: number,
  laneCount: number,
  rng: Rng,
  takeId: () => number,
  nextConnected: () => boolean
): void {
  const headwayGap = cruise * 1.0;
  let pos = rng.range(40, 90);
  for (let k = 0; k < laneCount; k++) {
    const desiredSpeed = Math.max(cruise, cruise + rng.range(0, 4));
    vehicles.push(
      makeVehicle(takeId(), lane, pos, cruise, desiredSpeed, nextConnected())
    );
    pos += headwayGap + VEHICLE_LENGTH + rng.range(2, 12);
  }
}
