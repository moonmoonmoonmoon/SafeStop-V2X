/**
 * Driver-state machine: Normal -> Suspected -> Confirmed.
 *
 * SAFETY-HONEST DESIGN:
 *   - "Suspected" is INTERNAL ONLY. It never triggers an external V2X broadcast.
 *   - Ordinary, brief signals (a blink, a quick eye rub) that last less than
 *     DETECTION.ignoreBelow never leave Normal.
 *   - A sustained impairment signal escalates Suspected -> Confirmed only after
 *     DETECTION.confirmAfter seconds.
 *   - A manual SOS button forces Confirmed immediately (driver is the authority).
 *   - Only the Confirmed state causes the vehicle to broadcast a hazard.
 *
 * The "impairment signal" is an abstract boolean input. In the core sim it is
 * driven by the scenario (the designated hazard driver has a genuine emergency).
 * Later, an optional webcam/MediaPipe detector can feed the same boolean without
 * changing this logic — detection stays modular.
 */
import { DriverState } from "./types";
import { DETECTION } from "./constants";

export interface DriverStateContext {
  state: DriverState;
  /** How long the current impairment signal has been continuously present (s). */
  signalDuration: number;
  /** How long the signal has been continuously absent (s). */
  clearDuration: number;
  /** Latched once the driver presses SOS; forces/holds Confirmed. */
  sosLatched: boolean;
}

export function createDriverStateContext(): DriverStateContext {
  return {
    state: DriverState.Normal,
    signalDuration: 0,
    clearDuration: 0,
    sosLatched: false,
  };
}

export interface DriverStateInput {
  /** Is an impairment signal present this tick (e.g. sustained eye closure)? */
  impairmentSignal: boolean;
  /** Did the driver press the manual SOS this tick (edge, not held)? */
  sosPressed: boolean;
  dt: number;
}

/**
 * Advance the driver-state machine by one tick. Pure function of (ctx, input).
 * Returns the next context; does not mutate the input.
 */
export function stepDriverState(
  ctx: DriverStateContext,
  input: DriverStateInput
): DriverStateContext {
  const { impairmentSignal, sosPressed, dt } = input;

  const next: DriverStateContext = {
    state: ctx.state,
    signalDuration: impairmentSignal ? ctx.signalDuration + dt : 0,
    clearDuration: impairmentSignal ? 0 : ctx.clearDuration + dt,
    sosLatched: ctx.sosLatched || sosPressed,
  };

  // Manual SOS is authoritative: driver declares the emergency.
  if (next.sosLatched) {
    next.state = DriverState.Confirmed;
    return next;
  }

  switch (ctx.state) {
    case DriverState.Normal: {
      // Only escalate once the signal has persisted beyond the ignore threshold.
      // Brief blinks / eye rubs (< ignoreBelow) are filtered out entirely.
      if (impairmentSignal && next.signalDuration >= DETECTION.ignoreBelow) {
        next.state = DriverState.Suspected;
      }
      break;
    }
    case DriverState.Suspected: {
      if (next.signalDuration >= DETECTION.confirmAfter) {
        // Sustained -> confirmed (still internal until broadcast logic runs).
        next.state = DriverState.Confirmed;
      } else if (!impairmentSignal && next.clearDuration >= DETECTION.clearAfter) {
        // Cleared quickly: it was a false alarm, drop back to Normal.
        next.state = DriverState.Normal;
      }
      break;
    }
    case DriverState.Confirmed: {
      // Without SOS latch, a confirmed detection can clear if the signal is gone
      // long enough (driver recovered). With SOS latch we returned above.
      if (!impairmentSignal && next.clearDuration >= DETECTION.clearAfter) {
        next.state = DriverState.Normal;
      }
      break;
    }
  }

  return next;
}

/**
 * Whether the vehicle should be broadcasting a hazard. ONLY Confirmed broadcasts.
 * Suspected explicitly does not — this is the safety guarantee.
 */
export function shouldBroadcast(ctx: DriverStateContext): boolean {
  return ctx.state === DriverState.Confirmed;
}
