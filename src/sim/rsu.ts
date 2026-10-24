/**
 * Roadside Units (RSUs) and Variable Message Signs (VMS) — the V2I layer.
 *
 * An RSU near a broadcasting hazard receives the V2X hazard message and lights up
 * a variable message sign with an upstream warning. This models how connected
 * infrastructure can warn ALL approaching drivers — including those in vehicles
 * with no V2X radio — by displaying a physical sign.
 */
import type { RoadsideUnit, V2XMessage } from "./types";

export function createRSUs(highwayLength: number): RoadsideUnit[] {
  // Place signs at regular intervals along the highway.
  const rsus: RoadsideUnit[] = [];
  const spacing = 400; // m between signs (assumption)
  let idx = 0;
  for (let pos = spacing; pos < highwayLength; pos += spacing) {
    rsus.push({
      id: `RSU-${idx++}`,
      position: pos,
      range: 500, // m: an RSU hears hazards within 500 m
      signText: null,
      signExpiresAt: null,
    });
  }
  return rsus;
}

/**
 * Update an RSU given a hazard message it can hear. Returns true if the sign was
 * (re)activated. Only signs UPSTREAM of the hazard (i.e. before it) warn drivers
 * who are still approaching.
 */
export function updateRSU(
  rsu: RoadsideUnit,
  message: V2XMessage
): boolean {
  const withinRange =
    Math.abs(rsu.position - message.originPosition) <= rsu.range;
  const upstream = rsu.position < message.originPosition; // warn before the hazard
  if (withinRange && upstream) {
    const distance = Math.round(message.originPosition - rsu.position);
    rsu.signText = `⚠ HAZARD AHEAD ${distance} m — SLOW DOWN`;
    rsu.signExpiresAt = message.expiresAt;
    return true;
  }
  return false;
}

/** Clear expired sign messages. */
export function expireRSUs(rsus: RoadsideUnit[], now: number): void {
  for (const rsu of rsus) {
    if (rsu.signExpiresAt !== null && rsu.signExpiresAt <= now) {
      rsu.signText = null;
      rsu.signExpiresAt = null;
    }
  }
}
