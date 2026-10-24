# SafeStop V2X — Project Steering

Guidance for working in this repository. Everything below describes the system as
it is actually implemented in `src/`. Where something is a plan rather than code,
it is called out explicitly under "Not implemented / future".

## What this project is

SafeStop V2X is an **educational, browser-based digital twin** that compares two
highway scenarios side by side when a driver suffers an acute impairment and must
slow down and pull over:

- **Scenario A — "hazard-only"**: drivers only react to what they can visually
  perceive (today's baseline).
- **Scenario B — "v2x"**: an added Vehicle-to-Everything (V2X) communication layer
  warns connected vehicles and roadside signs earlier, and connected vehicles can
  cooperatively yield to help the impaired vehicle pull over.

Both scenarios run from the **same seed and identical initial traffic**; the only
difference is whether V2X messaging exists. This is a simulation for demonstration
and teaching. It is **not** a production vehicle safety controller, performs **no**
medical diagnosis, and makes **no** validated collision-prevention claim. Keep this
framing in any code, copy, or docs.

## Technology stack

- **React 18** + **TypeScript** (strict) with **Vite 5** as the dev server/bundler.
- **Vitest 2** + **@testing-library/react** + **jsdom** for tests.
- Rendering is a hand-written **HTML5 Canvas 2D** view (no game/engine library).
- No backend, no network calls, no runtime dependencies beyond React/ReactDOM.

Scripts (`package.json`): `dev`, `build` (`tsc -b && vite build`), `preview`,
`test` (`vitest run`), `test:watch`, `typecheck` (`tsc --noEmit`).

Run locally: `npm install` then `npm run dev`.

## Architecture

The code separates a **pure, framework-free simulation core** from a thin **React
visualization layer**. The core has no React/DOM imports and is fully unit-tested.

```
src/
  sim/                         # pure simulation core (no React)
    types.ts                   # domain types, enums, Metrics, SimConfig
    constants.ts               # ALL tunable modeling constants (single source)
    rng.ts                     # seeded mulberry32 RNG (deterministic replay)
    idm.ts                     # Intelligent Driver Model acceleration
    vehicle.ts                 # longitudinal integration + bounded braking
    driverState.ts             # Normal -> Suspected -> Confirmed state machine
    v2x.ts                     # V2XBus: range/latency/loss/expiration
    rsu.ts                     # roadside units + variable message signs (V2I)
    scenario.ts                # deterministic initial fleet + engineered layout
    world.ts                   # per-tick orchestration of ONE scenario
    simulation.ts              # runs both worlds in lockstep; DEFAULT/DEMO config
    metrics.ts                 # MetricsAccumulator + collision detection
    __tests__/                 # Vitest suites for the core
  render/
    HighwayCanvas.tsx          # Canvas renderer for one scenario (pure view)
  ui/
    ControlPanel.tsx           # sliders + Play/Pause/Step/Apply/SOS buttons
    MetricsDashboard.tsx       # side-by-side metric comparison
    EventTimeline.tsx          # Detection->Confirmation->Broadcast->Response->Pull-Over
    __tests__/App.smoke.test.tsx
  App.tsx                      # top-level: rAF fixed-timestep loop + layout
  main.tsx                     # React entry
  App.css / index.css          # styling
  test/setup.ts                # jsdom + canvas getContext stub for tests
```

Data flow: `App.tsx` owns a `Simulation` (in a ref) and advances it with a
fixed-timestep accumulator driven by `requestAnimationFrame`. Each tick it reads a
`SimSnapshot` (deep-enough shallow copies) and passes it to the renderer and UI.
The UI is **read-only** over simulation state — it never mutates the core.

### Determinism (important invariant)

- Fixed timestep `DT = 0.05 s` (20 Hz). All randomness comes from one seeded `Rng`.
- Same `SimConfig` + seed ⇒ byte-identical run. Tests assert this.
- Both worlds build from the **same seed** so their initial fleets are identical;
  the hazard-only and v2x worlds each own an independent `Rng` instance seeded from
  the config.

When changing the core, preserve determinism: do not introduce `Math.random`,
`Date.now`, iteration over unordered structures, or time-dependent branching in the
sim. Draw randomness only from the injected `Rng`.

## Simulation behavior (as implemented)

- **Highway**: `laneCount` travel lanes (default 3) plus one **shoulder** lane at
  index `laneCount`. Positions increase in the direction of travel, so "upstream"
  / "behind" means a lower position.
- **Car-following**: the Intelligent Driver Model (`idm.ts`) computes acceleration
  from speed, desired speed, gap, and approach rate. Integration is semi-implicit
  Euler in `vehicle.ts`. Braking is clamped to `MAX_EMERGENCY_DECEL` (8.0 m/s²) —
  no instant stops. Vehicles never reverse.
- **Perception-gated emergency response** (`world.ts`): during an active emergency
  a follower only engages emergency braking once it has *perceived* the hazard —
  either by a delivered V2X advisory (early) or by seeing a slow leader within
  `VISUAL_RANGE` and waiting out `REACTION.visual` (late). An un-alerted driver
  keeps driving free-flow toward its desired speed. Ordinary (non-emergency)
  car-following is never suppressed. This late-vs-early information gap is the
  honest mechanism behind the scenario difference.
- **Emergency pull-over maneuver** (`world.ts`): on confirmation the impaired
  vehicle eases to `PULLOVER_REQUEST_SPEED`, then moves one lane right at a time
  toward the shoulder, changing lanes **only** when both a front gap
  (`SAFE_MERGE_GAP.front`) and a larger rear gap (`SAFE_MERGE_GAP.rear`) exist in
  the target lane. If no safe gap exists it **waits** (phase stays `Requesting`); a
  change in progress is **aborted** back to waiting if the gap stops being safe.
  Lateral motion is continuous via `laneF` at `LANE_CHANGE_RATE` (no teleport).
  Phases: `None -> Requesting -> Changing -> OnShoulder -> Stopped`.
- **Cooperative gap creation (v2x only)**: a connected vehicle in the target lane
  that has the advisory and sits just behind the emergency car **yields**, easing
  to `YIELD_SPEED_MARGIN` below the emergency car's speed (at `YIELD_DECEL`) to open
  the rear merge gap. This lets the pull-over complete sooner than in hazard-only,
  where the car must wait for a natural gap.
- **Collisions**: rear-end contact (gap ≤ 0) is detected per travel lane in
  `metrics.ts`; both vehicles are marked `crashed` and become immobile obstacles.
  The **shoulder is a refuge** — collisions are only detected in travel lanes.

### Scenario construction (`scenario.ts`)

The fleet is laid out deterministically. The hazard lane is the middle lane and is
kept compact: a tight cluster of immediate followers behind the frontmost
(designated emergency) vehicle, an open gap wider than `VISUAL_RANGE`, then a
faster upstream platoon spread across the `VISUAL_RANGE..commRange` band (too far
to *see* the hazard but reachable by radio). A few existing target-lane vehicles
are repositioned into a tight "merge blocker" stream so that a natural merge gap is
rare — which is what makes cooperative V2X yielding the measurable difference.
Vehicles are never added or removed during this, so both worlds keep identical
fleets and `vehicleCount` is preserved.

## V2X communication model

Implemented in `v2x.ts` (`V2XBus`) and driven from `world.ts`:

- **Broadcast trigger**: only when the emergency driver state is `Confirmed`
  (`shouldBroadcast`). `Suspected` never broadcasts.
- **Range**: `world.ts` filters receivers to connected vehicles within
  `config.commRange` of the origin before handing them to the bus.
- **Latency**: each accepted message is scheduled for delivery `networkLatency`
  seconds later.
- **Packet loss**: each attempted delivery is dropped with probability
  `packetLoss` (drops still count against the delivery rate).
- **Expiration**: messages carry `expiresAt = now + messageLifetime`; a message
  that arrives after it has expired is discarded and not counted as delivered.
- **Message type**: a single `EMERGENCY_SLOWDOWN` advisory carrying the origin
  position/lane and an `advisorySpeed` (`ADVISORY_SPEED`). This mirrors the *intent*
  of ETSI DENM / SAE J2735 hazard advisories; it is a simplified abstraction, **not**
  an RF propagation, interference, or congestion-control model.
- **V2I**: roadside units (`rsu.ts`) within range of a broadcasting hazard and
  upstream of it light a variable message sign reading
  `"EMERGENCY AHEAD <distance> m — SLOW DOWN"`; signs clear when the message
  lifetime expires.

## Safety metrics (`metrics.ts`, surfaced in `MetricsDashboard.tsx`)

All metrics are computed from the running simulation — none are hardcoded.

- **collisions** — count of rear-end contacts (travel lanes only).
- **minTTC** — minimum time-to-collision over closing follower/leader pairs
  (`gap / approachRate`, only while closing). `Infinity` if never at risk.
- **maxBrakingDecel** — the single largest braking magnitude (m/s²). Reaches 8.0 in
  both scenarios because at least one vehicle hits the hard `MAX_EMERGENCY_DECEL`
  clamp, so the *peak* is the same across scenarios.
- **harshBrakingEvents** — count of distinct rising-edge events where a vehicle
  brakes harder than `HARSH_BRAKING_THRESHOLD` (4.0 m/s²) **while** its TTC to the
  leader is at/below `NEAR_MISS_TTC` (2.5 s). This near-miss gating is deliberate:
  it measures how *often* dangerous last-moment braking happened (which the single
  peak hides) and does not penalize a scenario merely because more cars respond.
- **warningLeadTime** — seconds between the first V2X warning delivered and the
  emergency vehicle reaching near-stop (`NEAR_STOP_SPEED`). 0 for hazard-only.
- **pullOverCompletionTime** — seconds from emergency confirmation to a safe stop
  on the shoulder; `null` if the pull-over never completes during the run.
- **messageDeliveryRate** — delivered / attempted V2X messages (1.0 when none
  attempted, e.g. hazard-only).

## Driver-state machine (`driverState.ts`)

`Normal -> Suspected -> Confirmed`, a pure function of (context, input):

- Brief signals shorter than `DETECTION.ignoreBelow` (0.4 s) never leave `Normal`.
- A sustained signal escalates `Suspected -> Confirmed` after `DETECTION.confirmAfter`.
- `Suspected` is **internal only and never broadcasts**. Only `Confirmed` broadcasts.
- A manual **SOS** forces `Confirmed` immediately and latches it (driver authority).
- The impairment signal is an abstract boolean; in the core it is driven by the
  scenario at `emergencyTime`. These safety semantics are covered by tests and must
  be preserved.

## Presets (`simulation.ts`)

- `DEFAULT_CONFIG` — milder scenario; V2X is at least as safe on every metric and
  strictly better on warning lead time and pull-over completion.
- `DEMO_PRESET_CONFIG` — denser/faster high-risk preset for the live demo where the
  hazard-only baseline collides and/or fails to pull over, while v2x avoids
  collisions and completes the pull-over. Values are exercised by
  `simulation.test.ts` so the contrast is a verified, emergent property — not
  hardcoded outcomes.

## Coding conventions

- **TypeScript strict mode** (see `tsconfig.json`): `noUnusedLocals`,
  `noUnusedParameters`, `noFallthroughCasesInSwitch`. Builds must be warning-clean;
  `npm run build` runs `tsc` and fails on unused symbols.
- **SI units everywhere in the core**: meters, m/s, m/s², seconds. Convert to mph
  only for display via `MS_TO_MPH`.
- **Single source of tunables**: all modeling numbers live in `src/sim/constants.ts`
  with a doc comment stating the assumption. Do not scatter magic numbers through
  `world.ts`/`scenario.ts`; add a named, commented constant instead.
- **Keep the four concerns modular**: detection (`driverState.ts`), communication
  (`v2x.ts`, `rsu.ts`), vehicle dynamics (`idm.ts`, `vehicle.ts`), and
  visualization (`render/`, `ui/`). The sim core must stay free of React/DOM.
- **Determinism** is a hard requirement (see above).
- **Honesty**: do not hardcode collisions or metric outcomes; the contrast must
  emerge from the model. Keep the disclaimer language (simulation, not a production
  safety controller, no medical/collision-prevention claims) in user-facing copy.
- **Pure, testable sim functions**: prefer module-level pure helpers that can be
  unit-tested over private methods with hidden state.
- **Tests**: add/extend Vitest suites under `src/sim/__tests__` for core changes.
  Do not weaken the safety-semantics tests in `driverState.test.ts` or the V2X
  delivery tests in `v2x.test.ts`.
- Styling is plain CSS in `App.css`/`index.css`; no CSS framework.

## Not implemented / future (do not document as existing)

- **Webcam / MediaPipe eye monitoring** is NOT implemented. The driver-state
  machine takes an abstract impairment boolean so such a detector *could* later
  feed it without changing downstream logic, but no camera, ML model, or detection
  code exists in the repo today.
- Background (non-emergency) vehicles do **not** make discretionary lane changes;
  only the emergency vehicle changes lanes.
- The V2X layer does not model RF propagation, interference, or congestion control.
- No backend, persistence, multi-device/WebSocket, or real map/routing data.
