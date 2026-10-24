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

/** Convert m/s to mph for display. */
export const MS_TO_MPH = 2.2369362920544;
