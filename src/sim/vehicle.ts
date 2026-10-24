/**
 * Vehicle longitudinal dynamics.
 *
 * Vehicles follow the IDM for normal car-following. When a vehicle is acting on a
 * V2X advisory OR reacting to a visible hazard, its effective desired speed is
 * reduced toward the advisory speed, and braking is bounded by MAX_EMERGENCY_DECEL.
 *
 * SAFETY-HONEST: connected vehicles only receive an EARLIER advisory (lower
 * reaction delay) and lower their target speed smoothly. They never teleport,
 * never brake beyond physical limits, and never perform lane changes here.
 */
import type { Vehicle } from "./types";
import { idmAcceleration } from "./idm";
import { MAX_EMERGENCY_DECEL } from "./constants";

export interface Leader {
  position: number;
  speed: number;
  length: number;
}

/**
 * Compute and integrate one vehicle's motion for a timestep dt.
 * `leader` is the closest vehicle ahead in the same lane, or null.
 * `effectiveDesiredSpeed` already accounts for any active advisory.
 */
export function stepVehicle(
  v: Vehicle,
  leader: Leader | null,
  effectiveDesiredSpeed: number,
  dt: number
): void {
  if (v.crashed) {
    // Crashed vehicles are immobile obstacles.
    v.speed = 0;
    v.acceleration = 0;
    return;
  }

  let gap = Infinity;
  let approachRate = 0;
  if (leader) {
    gap = leader.position - v.position - leader.length;
    approachRate = v.speed - leader.speed;
  }

  let accel = idmAcceleration({
    speed: v.speed,
    desiredSpeed: effectiveDesiredSpeed,
    gap,
    approachRate,
  });

  // Bound braking to a physically realistic maximum (no instant stops).
  if (accel < -MAX_EMERGENCY_DECEL) {
    accel = -MAX_EMERGENCY_DECEL;
  }

  v.acceleration = accel;

  // Semi-implicit Euler integration.
  let newSpeed = v.speed + accel * dt;
  if (newSpeed < 0) newSpeed = 0; // vehicles don't reverse
  v.position += ((v.speed + newSpeed) / 2) * dt;
  v.speed = newSpeed;
}
