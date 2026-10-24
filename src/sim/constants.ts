/**
 * SafeStop V2X — documented physical and modeling constants.
 *
 * Every value here is an explicit modeling ASSUMPTION for the demo. They are
 * chosen to be plausible, not calibrated against a specific vehicle or roadway.
 */

/** Fixed simulation timestep (s). Deterministic replay depends on this being fixed. */
export const DT = 0.05; // 20 Hz physics

/** Intelligent Driver Model (IDM) parameters. */
export const IDM = {
  /** Maximum acceleration (m/s^2). Typical passenger-car comfort value. */
  maxAccel: 1.5,
  /** Comfortable deceleration (m/s^2). Used by IDM for normal following. */
  comfortDecel: 2.0,
  /** Minimum bumper-to-bumper gap at standstill (m). */
  minGap: 2.0,
  /** Desired safe time headway (s). */
  timeHeadway: 1.5,
  /** Acceleration exponent (delta) in the IDM free-road term. */
  delta: 4,
} as const;

/**
 * Hard physical limit on braking (m/s^2, magnitude). Bounds emergency braking so
 * vehicles decelerate within realistic tire/road limits — no instant stops.
 * ~0.8 g on dry pavement.
 */
export const MAX_EMERGENCY_DECEL = 8.0;

/** Default vehicle length (m). */
export const VEHICLE_LENGTH = 4.5;

/**
 * Human reaction delay (s) before a driver acts on a stimulus.
 *   - Visual hazard light (hazard-only scenario): slower, must perceive brake lights.
 *   - V2X advisory (connected driver): faster, HMI alerts the driver directly.
 * These model the key advantage of V2X: earlier, clearer information.
 */
export const REACTION = {
  visual: 1.2, // seconds to react to a brake-light / hazard cue
  v2xAdvisory: 0.6, // seconds to react to an in-cabin V2X advisory
} as const;

/**
 * Speed (m/s) at or below which the hazard vehicle is considered "stopped"
 * for lead-time and crash-settling purposes.
 */
export const NEAR_STOP_SPEED = 1.0;

/** Advisory target speed the hazard broadcasts to approaching traffic (m/s). */
export const ADVISORY_SPEED = 8.0; // ~18 mph crawl past the hazard

/**
 * Target speed the HAZARD vehicle itself decays toward during a confirmed
 * emergency (m/s). A compromised driver eases off / brakes toward a near stop
 * on the shoulder or in-lane. This low target is what creates the dangerous
 * speed differential that following traffic must respond to.
 */
export const HAZARD_STOP_SPEED = 0;

/**
 * Rate (m/s^2, magnitude) the hazard vehicle decelerates once its emergency is
 * active. Firm but within physical limits — models a driver lifting off and
 * braking moderately, not slamming to a halt.
 */
export const HAZARD_DECEL = 6.0;

/**
 * Longitudinal distance ahead (m) within which a following driver can VISUALLY
 * perceive the slowed/stopped hazard and begin reacting (after a reaction delay).
 * In the hazard-only scenario this is the ONLY information channel.
 */
export const VISUAL_RANGE = 120;

/**
 * Detection-side timing for the driver-state machine (seconds). These govern the
 * INTERNAL Normal/Suspected/Confirmed transitions, decoupled from broadcasting.
 */
export const DETECTION = {
  /**
   * Sustained impairment signal duration to escalate Suspected -> Confirmed (s).
   *
   * This is deliberately SHORT. A connected vehicle performing a genuine
   * emergency slowdown confirms the hazard quickly — it knows its own driver is
   * compromised and it is already braking. Confirming fast is what lets the V2X
   * advisory reach upstream traffic BEFORE those drivers could ever see the
   * hazard with their own eyes (visual perception only works within VISUAL_RANGE,
   * and upstream connected cars are far beyond that). It is still gated by the
   * ignore threshold below, so brief blinks never confirm and never broadcast.
   */
  confirmAfter: 0.5,
  /** Signal must clear for this long to de-escalate back toward Normal (s). */
  clearAfter: 1.5,
  /**
   * Brief signals shorter than this never leave Normal — models ordinary blinking
   * or a quick eye rub NOT producing any external broadcast.
   */
  ignoreBelow: 0.4,
} as const;

/**
 * Threshold (m/s^2, magnitude) above which a deceleration counts as a HARSH
 * braking event. ~0.4 g — firmer than comfortable braking, the kind of stab at
 * the brakes a surprised driver makes. Used for the harsh-braking-events metric.
 */
export const HARSH_BRAKING_THRESHOLD = 4.0;

/**
 * Time-to-collision (s) at or below which a situation is a genuine NEAR-MISS.
 * The harsh-braking-events metric only counts a hard brake that happens while the
 * braking vehicle is this close (in time) to its leader — i.e. a dangerous,
 * last-moment stab at the brakes, not a comfortable anticipatory slowdown with
 * plenty of room. See metrics.ts for the full definition and its rationale.
 *
 * ~2.5 s is a common surrogate-safety boundary: above it a following driver has
 * time to resolve the conflict smoothly; at/below it the margin is unsafe.
 */
export const NEAR_MISS_TTC = 2.5;

// ----------------------------------------------------------------------------
// Emergency pull-over maneuver (impaired driver leaving the travel lane)
// ----------------------------------------------------------------------------

/**
 * Speed (m/s) the emergency vehicle slows to while REQUESTING a pull-over. It
 * eases off and flags its intent, but keeps rolling so it can merge into a gap —
 * it does not stop dead in the travel lane. It only stops once on the shoulder.
 */
export const PULLOVER_REQUEST_SPEED = 12.0; // ~27 mph

/** Deceleration (m/s^2) used by the emergency vehicle easing toward request speed. */
export const PULLOVER_DECEL = 3.0;

/**
 * Lateral speed (lane-units per second) of a lane change. A full lane change
 * (one lane width) therefore takes 1 / this seconds. ~0.5 => a 2 s lane change.
 */
export const LANE_CHANGE_RATE = 0.5;

/**
 * Minimum SAFE gaps (m, bumper-to-bumper) required in the TARGET lane before the
 * emergency vehicle will begin a lane change. If either gap is insufficient the
 * maneuver WAITS — it is never forced. Front gap to the lead vehicle in the
 * target lane; rear gap to the following vehicle in the target lane.
 */
export const SAFE_MERGE_GAP = {
  front: 12.0, // m of clear road ahead in the target lane
  rear: 16.0, // m of clear road behind in the target lane (larger: closing traffic)
} as const;

/**
 * When a connected vehicle in the target lane receives the pull-over advisory and
 * is positioned to be the one the emergency car merges in front of, it YIELDS:
 * it eases off to open the required rear gap. This models cooperative V2X
 * gap-creation. Yielding is a mild, bounded speed reduction, not hard braking.
 */
export const YIELD_DECEL = 3.5; // m/s^2 firm-but-gentle easing to open a gap
// NOTE: kept strictly below HARSH_BRAKING_THRESHOLD (4.0) so a yield is never a
// "harsh" event, yet at least as firm as the hazard's own PULLOVER_DECEL (3.0)
// so the yielding neighbour actually drops BACK (opens the rear gap) instead of
// coasting faster than the decelerating hazard and overtaking it.

/**
 * How far below the emergency vehicle's CURRENT speed a yielding neighbour aims
 * (m/s). Targeting a speed a fixed margin under the hazard (rather than a fixed
 * absolute speed) guarantees the yielder keeps dropping back relative to the
 * hazard the whole time it is yielding, so the rear merge gap opens steadily and
 * early. Small enough to stay a gentle cooperative ease, not a hard brake.
 */
export const YIELD_SPEED_MARGIN = 6.0;

/** Convert m/s to mph for display. */
export const MS_TO_MPH = 2.2369362920544;
