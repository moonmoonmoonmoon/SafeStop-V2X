/**
 * Intelligent Driver Model (IDM) car-following.
 *
 * The IDM computes an acceleration from the current speed, the gap to the leader,
 * and the approach rate. It is a standard, well-documented microscopic traffic
 * model. Reference form:
 *
 *   a = a_max * [ 1 - (v / v0)^delta - (s* / s)^2 ]
 *   s* = s0 + max(0, v*T + v*dv / (2*sqrt(a_max*b)))
 *
 * where v is speed, v0 desired speed, s gap, dv approach rate (v - v_lead),
 * s0 min gap, T time headway, a_max max accel, b comfortable decel.
 */
import { IDM } from "./constants";

export interface IdmInput {
  speed: number; // current speed v (m/s)
  desiredSpeed: number; // v0 (m/s)
  gap: number; // bumper-to-bumper gap s to leader (m); Infinity if no leader
  approachRate: number; // dv = v - v_lead (m/s)
}

/**
 * Compute the IDM acceleration (m/s^2). Can be negative (braking) or positive.
 */
export function idmAcceleration(input: IdmInput): number {
  const { speed, desiredSpeed, gap, approachRate } = input;
  const v0 = Math.max(desiredSpeed, 0.1);

  // Free-road term.
  const freeRoad = 1 - Math.pow(speed / v0, IDM.delta);

  let interaction = 0;
  if (Number.isFinite(gap)) {
    const sStar =
      IDM.minGap +
      Math.max(
        0,
        speed * IDM.timeHeadway +
          (speed * approachRate) /
            (2 * Math.sqrt(IDM.maxAccel * IDM.comfortDecel))
      );
    const s = Math.max(gap, 0.1); // avoid divide-by-zero / explosion at contact
    interaction = Math.pow(sStar / s, 2);
  }

  return IDM.maxAccel * (freeRoad - interaction);
}
