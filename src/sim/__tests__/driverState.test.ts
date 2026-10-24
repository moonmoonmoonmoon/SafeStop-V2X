import { describe, it, expect } from "vitest";
import {
  createDriverStateContext,
  shouldBroadcast,
  stepDriverState,
  type DriverStateContext,
} from "../driverState";
import { DriverState } from "../types";
import { DETECTION } from "../constants";

const DT = 0.05;

/** Helper: feed a continuous impairment signal for `seconds` and return ctx. */
function feedSignal(
  ctx: DriverStateContext,
  seconds: number,
  signal: boolean,
  sos = false
): DriverStateContext {
  let c = ctx;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    c = stepDriverState(c, {
      impairmentSignal: signal,
      sosPressed: sos && i === 0, // edge press on first tick
      dt: DT,
    });
  }
  return c;
}

describe("driver-state machine", () => {
  it("starts Normal and does not broadcast", () => {
    const ctx = createDriverStateContext();
    expect(ctx.state).toBe(DriverState.Normal);
    expect(shouldBroadcast(ctx)).toBe(false);
  });

  it("ignores a brief blink / eye rub (stays Normal, never broadcasts)", () => {
    const ctx = createDriverStateContext();
    // Signal shorter than the ignore threshold.
    const brief = DETECTION.ignoreBelow - DT;
    const after = feedSignal(ctx, brief, true);
    expect(after.state).toBe(DriverState.Normal);
    expect(shouldBroadcast(after)).toBe(false);
  });

  it("escalates Normal -> Suspected once signal persists past ignore threshold", () => {
    const ctx = createDriverStateContext();
    const after = feedSignal(ctx, DETECTION.ignoreBelow + DT, true);
    expect(after.state).toBe(DriverState.Suspected);
    // CRITICAL: Suspected must NOT broadcast.
    expect(shouldBroadcast(after)).toBe(false);
  });

  it("escalates Suspected -> Confirmed after sustained signal, then broadcasts", () => {
    const ctx = createDriverStateContext();
    const after = feedSignal(ctx, DETECTION.confirmAfter + 2 * DT, true);
    expect(after.state).toBe(DriverState.Confirmed);
    expect(shouldBroadcast(after)).toBe(true);
  });

  it("de-escalates Suspected -> Normal when signal clears quickly", () => {
    let ctx = createDriverStateContext();
    // Reach Suspected but not Confirmed.
    ctx = feedSignal(ctx, DETECTION.ignoreBelow + DT, true);
    expect(ctx.state).toBe(DriverState.Suspected);
    // Clear the signal long enough to recover.
    ctx = feedSignal(ctx, DETECTION.clearAfter + DT, false);
    expect(ctx.state).toBe(DriverState.Normal);
  });

  it("manual SOS forces Confirmed immediately and latches", () => {
    const ctx = createDriverStateContext();
    const after = stepDriverState(ctx, {
      impairmentSignal: false,
      sosPressed: true,
      dt: DT,
    });
    expect(after.state).toBe(DriverState.Confirmed);
    expect(shouldBroadcast(after)).toBe(true);

    // Latch holds even without any impairment signal afterward.
    const later = feedSignal(after, 5, false);
    expect(later.state).toBe(DriverState.Confirmed);
    expect(shouldBroadcast(later)).toBe(true);
  });
});
