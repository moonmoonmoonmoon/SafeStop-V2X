/**
 * SafeStop V2X — shared domain types and documented simulation constants.
 *
 * DISCLAIMER: This is a SIMULATION for demonstration and education. It is NOT a
 * production vehicle safety controller. It does not perform medical diagnosis and
 * does not claim validated collision prevention. All numbers below are plausible
 * modeling assumptions, not calibrated real-world values.
 *
 * Units (SI) used everywhere in the sim core:
 *   - distance / position: meters (m)
 *   - speed:               meters per second (m/s)   [1 m/s ≈ 2.237 mph]
 *   - acceleration:        meters per second^2 (m/s^2)
 *   - time:                seconds (s)
 */

// ----------------------------------------------------------------------------
// Driver / vehicle state machine
// ----------------------------------------------------------------------------

/**
 * Internal driver condition. "Suspected" is an INTERNAL state only — it must NOT
 * trigger an external V2X broadcast. Only "Confirmed" (driver SOS, or a sustained
 * confirmed detection) results in a broadcast hazard.
 */
export enum DriverState {
  Normal = "Normal",
  Suspected = "Suspected",
  Confirmed = "Confirmed",
}

/**
 * Behavioral role used primarily for VISUALIZATION so the animation is legible
 * without reading the source. Derived from the vehicle's situation each tick:
 *
 *   - Emergency: the impaired vehicle performing the pull-over maneuver.
 *   - Unalerted: has not yet perceived the emergency (still driving normally).
 *   - Alerted:   has received/seen the warning and is easing off (mild response).
 *   - Braking:   actively braking hard in response to the hazard.
 *   - Yielding:  deliberately opening a gap to let the emergency vehicle in.
 *   - Normal:    ordinary background traffic, no emergency in play.
 */
export enum VehicleRole {
  Normal = "Normal",
  Unalerted = "Unalerted",
  Alerted = "Alerted",
  Braking = "Braking",
  Yielding = "Yielding",
  Emergency = "Emergency",
}

/**
 * Pull-over maneuver phase for the emergency vehicle. The driver with acute
 * visual impairment wants to leave the travel lane and stop on the shoulder, but
 * ONLY when a safe gap exists in the target lane. If no safe gap exists the
 * maneuver WAITS (it is never forced).
 */
export enum PullOverPhase {
  None = "None", // not attempting (no emergency yet)
  Requesting = "Requesting", // emergency declared, seeking a safe gap toward shoulder
  Changing = "Changing", // a safe gap exists; laterally moving to the next lane
  OnShoulder = "OnShoulder", // reached the shoulder
  Stopped = "Stopped", // stopped safely on the shoulder (maneuver complete)
}

export type VehicleId = number;

export interface Vehicle {
  id: VehicleId;
  lane: number; // 0 = leftmost (fastest) ... laneCount-1 = rightmost travel lane
  /**
   * Continuous lateral position in "lane units" for smooth rendering of lane
   * changes. Integer value == centered in `lane`. The shoulder is at lane index
   * `laneCount` (one lane-width to the right of the rightmost travel lane).
   */
  laneF: number;
  position: number; // longitudinal position along the highway (m)
  speed: number; // m/s
  acceleration: number; // m/s^2 (last computed)
  length: number; // vehicle length (m)
  desiredSpeed: number; // free-flow target speed (m/s)
  isConnected: boolean; // equipped with V2X radio?
  driverState: DriverState;
  /** Visualization role (derived each tick). */
  role: VehicleRole;
  /** Pull-over maneuver phase (emergency vehicle only; None for others). */
  pullOver: PullOverPhase;
  /** Sim time (s) the pull-over maneuver completed (reached shoulder stop). */
  pullOverCompletedAt: number | null;
  /** True when this vehicle is deliberately opening a gap for the emergency car. */
  yielding: boolean;
  /** The hazard vehicle that this vehicle is currently responding to, if any. */
  respondingToHazard: boolean;
  /** Target speed this vehicle is trying to reach due to an advisory (m/s). */
  advisorySpeed: number | null;
  /** Simulation time (s) at which an advisory was received (for reaction delay). */
  advisoryReceivedAt: number | null;
  /** Whether the advisory reaction delay has elapsed and the driver is acting. */
  advisoryActive: boolean;
  /** Sim time (s) at which this driver first visually perceived the hazard. */
  visualSeenAt: number | null;
  /**
   * Perception-reaction lag bookkeeping: the sim time at which this driver first
   * noticed the leader braking hard. Until REACTION.visual elapses from this
   * moment, the driver does NOT brake for it (models human reaction lag, the
   * cause of rear-end crashes). Connected vehicles acting on a V2X advisory skip
   * this lag because they were already slowing.
   */
  leaderBrakeNoticedAt: number | null;
  crashed: boolean;
}

// ----------------------------------------------------------------------------
// V2X messaging
// ----------------------------------------------------------------------------

export enum V2XMessageType {
  /**
   * Decentralized Environmental Notification-style hazard message. Mirrors the
   * intent of ETSI DENM / SAE J2735 hazard advisories, simplified for the sim.
   */
  EmergencySlowdown = "EMERGENCY_SLOWDOWN",
}

export interface V2XMessage {
  id: number;
  type: V2XMessageType;
  originId: VehicleId | string; // vehicle id or RSU id
  originPosition: number; // m along highway
  originLane: number;
  /** Advisory target speed the origin suggests for approaching traffic (m/s). */
  advisorySpeed: number;
  createdAt: number; // sim time created (s)
  expiresAt: number; // sim time after which the message is stale (s)
}

/** A message in flight: scheduled to be delivered at deliverAt to receiverId. */
export interface InFlightMessage {
  message: V2XMessage;
  receiverId: VehicleId | string;
  deliverAt: number; // sim time delivery occurs (s)
}

// ----------------------------------------------------------------------------
// Roadside infrastructure (V2I)
// ----------------------------------------------------------------------------

export interface RoadsideUnit {
  id: string;
  position: number; // m along highway
  range: number; // communication range (m)
  /** Current sign text, or null when clear. */
  signText: string | null;
  /** Sim time the sign warning expires. */
  signExpiresAt: number | null;
}

// ----------------------------------------------------------------------------
// Scenario configuration
// ----------------------------------------------------------------------------

export type ScenarioKind = "hazard-only" | "v2x";

export interface SimConfig {
  seed: number;
  laneCount: number;
  highwayLength: number; // m
  vehicleCount: number; // initial number of vehicles (traffic density proxy)
  meanSpeed: number; // mean free-flow desired speed (m/s)
  /** Sim time (s) at which the designated hazard vehicle declares an emergency. */
  emergencyTime: number;
  /** Fraction [0..1] of vehicles equipped with V2X radios. */
  v2xPenetration: number;
  /** One-way V2X network latency (s). */
  networkLatency: number;
  /** V2X packet loss probability [0..1]. */
  packetLoss: number;
  /** V2V/V2I communication range (m). */
  commRange: number;
  /** Message validity lifetime (s). */
  messageLifetime: number;
}

// ----------------------------------------------------------------------------
// Metrics
// ----------------------------------------------------------------------------

export interface Metrics {
  collisions: number;
  /** Minimum time-to-collision observed across the run (s). Infinity if never at risk. */
  minTTC: number;
  /** Maximum braking deceleration magnitude observed (m/s^2, positive number). */
  maxBrakingDecel: number;
  /**
   * Count of DANGEROUS harsh-braking events (near-misses): distinct episodes of a
   * vehicle braking harder than HARSH_BRAKING_THRESHOLD WHILE its time-to-collision
   * to the leader is at or below NEAR_MISS_TTC. Gating on TTC is deliberate: a car
   * easing firmly onto a V2X advisory with plenty of room is not a safety event,
   * whereas a surprised driver braking hard with little time to impact is. This
   * keeps the metric from penalising the v2x scenario merely because MORE cars
   * respond at all. See metrics.ts (recordVehicleBraking) for the full rationale.
   */
  harshBrakingEvents: number;
  /** Lead time between first warning delivery and hazard vehicle reaching near-stop (s). */
  warningLeadTime: number;
  /**
   * Time (s) from emergency confirmation to the emergency vehicle completing its
   * pull-over (stopped on the shoulder). null if not completed during the run.
   */
  pullOverCompletionTime: number | null;
  /** Delivered messages / attempted deliveries [0..1]. */
  messageDeliveryRate: number;
}
