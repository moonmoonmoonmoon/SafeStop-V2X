# SafeStop V2X — Design

> **Status note.** This document describes the design of the system **as currently
> implemented** in `src/`. It is reverse-documented from the code. Sections or
> items that are planned but not built are marked **[Future]**. It does not
> describe build tooling or development history.

## 1. Goals and constraints

- Compare a hazard-only highway scenario against a V2X-assisted one, side by side,
  from identical initial conditions, to show the value of earlier information and
  cooperative behavior around an impaired driver pulling over.
- Be a transparent, deterministic, fully client-side digital twin — an educational
  demonstration, **not** a production safety controller, with no medical or
  validated collision-prevention claims.
- Keep the simulation core pure and unit-testable; keep detection, communication,
  vehicle dynamics, and visualization modular.

## 2. High-level architecture

```
                    ┌─────────────────────────────────────────┐
  requestAnimationFrame fixed-timestep loop (App.tsx)          │
                    │                                           │
          Simulation (simulation.ts)                           │
          ├── World "hazard-only"  (world.ts)                  │
          └── World "v2x"          (world.ts)                  │
                    │  each World composes:                    │
                    │   scenario.ts  (initial fleet)           │
                    │   driverState.ts (detection FSM)         │
                    │   idm.ts + vehicle.ts (dynamics)         │
                    │   v2x.ts (V2XBus) + rsu.ts (V2I)         │
                    │   metrics.ts (MetricsAccumulator)        │
                    ▼                                           │
           SimSnapshot (plain data) ──────────────────────────┘
                    │
         ┌──────────┼───────────────┐
         ▼          ▼               ▼
  HighwayCanvas  MetricsDashboard  EventTimeline   (read-only views)
```

The `sim/` layer has **no React or DOM imports**. React owns only the animation
loop, control state, and rendering. The views receive a `SimSnapshot` (plain
copied data) and never mutate simulation state.

## 3. Technology choices

- **React 18 + TypeScript (strict) + Vite 5** — fast client-side app, no backend.
- **HTML5 Canvas 2D** for the highway view — full control over the custom
  road/vehicle/propagation drawing; no engine dependency.
- **Vitest + @testing-library/react + jsdom** for unit and smoke tests.
- Rationale: the deliverable is a visual, interactive, deterministic simulation
  that must run anywhere a browser does and be easy to reason about and test. A
  pure TypeScript core plus a thin React/Canvas view meets that with minimal deps.

## 4. Simulation core

### 4.1 Time and determinism

- Fixed timestep `DT = 0.05 s` (20 Hz), defined in `constants.ts`.
- `rng.ts` implements a seeded **mulberry32** generator (`Rng`). All stochastic
  decisions (initial desired speeds, connectivity draws, packet loss) consume this
  single source, so a run is a pure function of `(SimConfig)`.
- `App.tsx` uses an accumulator pattern: real frame delta is accumulated and the
  sim is advanced in whole `DT` steps, clamped to avoid a spiral of death; a
  `runToken` forces a clean rAF restart on Demo/Reset even when already running.

### 4.2 Domain model (`types.ts`)

- `Vehicle` — `id`, `lane` (int travel lane; shoulder == `laneCount`), `laneF`
  (continuous lateral position for smooth lane changes), `position`, `speed`,
  `acceleration`, `length`, `desiredSpeed`, `isConnected`, `driverState`, `role`
  (visualization), `pullOver` phase, `pullOverCompletedAt`, `yielding`, and
  perception bookkeeping (`advisorySpeed`, `advisoryReceivedAt`, `advisoryActive`,
  `visualSeenAt`, `leaderBrakeNoticedAt`, `respondingToHazard`), and `crashed`.
- Enums: `DriverState` (`Normal|Suspected|Confirmed`), `VehicleRole`
  (`Normal|Unalerted|Alerted|Braking|Yielding|Emergency`), `PullOverPhase`
  (`None|Requesting|Changing|OnShoulder|Stopped`), `V2XMessageType`
  (`EMERGENCY_SLOWDOWN`).
- `SimConfig` — `seed`, `laneCount`, `highwayLength`, `vehicleCount`, `meanSpeed`,
  `emergencyTime`, `v2xPenetration`, `networkLatency`, `packetLoss`, `commRange`,
  `messageLifetime`.
- `Metrics` — `collisions`, `minTTC`, `maxBrakingDecel`, `harshBrakingEvents`,
  `warningLeadTime`, `pullOverCompletionTime` (`number | null`), `messageDeliveryRate`.

### 4.3 Car-following (`idm.ts`, `vehicle.ts`)

- `idmAcceleration({speed, desiredSpeed, gap, approachRate})` implements the
  Intelligent Driver Model: free-road term `1 - (v/v0)^delta` minus interaction
  term `(s*/s)^2`, with `s* = s0 + max(0, v*T + v*dv / (2*sqrt(a*b)))`. Parameters
  live in `constants.ts` (`IDM`).
- `stepVehicle(v, leader, effectiveDesiredSpeed, dt)` computes IDM acceleration,
  clamps braking to `MAX_EMERGENCY_DECEL`, integrates with semi-implicit Euler,
  and prevents reversing. Crashed vehicles are frozen obstacles.

### 4.4 Detection state machine (`driverState.ts`)

- Pure `stepDriverState(ctx, {impairmentSignal, sosPressed, dt})` returns the next
  context. Tracks continuous signal/clear durations and an SOS latch.
- Transitions: `Normal -> Suspected` once the signal persists past
  `DETECTION.ignoreBelow`; `Suspected -> Confirmed` after `DETECTION.confirmAfter`;
  de-escalation back to `Normal` after `DETECTION.clearAfter` of a cleared signal;
  SOS forces and latches `Confirmed`.
- `shouldBroadcast(ctx)` is true **only** in `Confirmed`. This is the core safety
  guarantee (Suspected and brief signals never broadcast).

### 4.5 V2X bus (`v2x.ts`) and V2I (`rsu.ts`)

- `V2XBus(latency, packetLoss, rng)` with `broadcast(message, receiverIdsInRange,
  now)`, `collectDue(now)`, and `deliveryRate()`.
  - Range filtering is done by the caller (`world.ts`) before `broadcast`.
  - Each receiver delivery is dropped with probability `packetLoss` (counted as an
    attempt), otherwise scheduled at `now + latency`.
  - `collectDue` returns messages whose `deliverAt <= now`; messages past
    `expiresAt` are discarded as stale and not counted delivered.
- `rsu.ts`: `createRSUs(highwayLength)` spaces signs; `updateRSU(rsu, message)`
  lights an upstream, in-range sign with `"EMERGENCY AHEAD <d> m — SLOW DOWN"`;
  `expireRSUs` clears signs past the message lifetime.

### 4.6 Scenario construction (`scenario.ts`)

`buildScenario(config)` deterministically lays out `vehicleCount` vehicles:

- Vehicles are distributed across lanes (`distributeLaneCounts`), keeping the
  middle hazard lane compact.
- The hazard lane (`buildHazardLane`) is structured as:
  `[fast upstream platoon] (open gap > VISUAL_RANGE) [tight follower cluster]
  [HAZARD at the front]`. The frontmost vehicle is designated the emergency
  vehicle and forced connected.
- Other lanes (`buildCruisingLane`) are evenly spaced stable traffic.
- `layoutMergeBlocker` repositions a few existing target-lane vehicles into a tight
  stream straddling the hazard so a natural merge gap is rare (no add/remove, so
  both worlds keep identical fleets). This makes cooperative yielding the
  measurable difference between scenarios.

### 4.7 World orchestration (`world.ts`)

A `World(kind, config)` owns the vehicles, RSUs, a `V2XBus`, an `Rng`, a
`MetricsAccumulator`, the emergency driver-state context, and the shoulder lane
index. Per `step()`:

1. Advance the emergency driver state machine (impairment at `emergencyTime`, plus
   any SOS); record confirmation time.
2. If `kind === "v2x"` and confirmed, broadcast the advisory to connected,
   in-`commRange` receivers, and light upstream in-range RSUs.
3. Deliver due V2X messages: set `advisorySpeed`/`advisoryReceivedAt` on receivers;
   record first-warning time; expire stale signs.
4. `updateEmergencyVehicle`: run the pull-over maneuver (below).
5. `updateFollowers`: for every other vehicle, by lane/position order —
   - cooperative `shouldYield` check (v2x only) → ease to open the rear gap;
   - otherwise compute `followerTargetSpeed` (graduated target via V2X advisory
     and/or visual channel) and whether the driver `hasPerceivedHazard`;
   - perceived → full IDM car-following toward the reduced target; not perceived →
     `cruiseFreeFlow` toward desired speed;
   - record TTC, acceleration, and harsh-braking samples.
6. `deriveRoles`: assign each vehicle a `VehicleRole` for visualization.
7. Detect collisions in travel lanes; record near-stop and pull-over completion.

**Pull-over maneuver** (`updateEmergencyVehicle`, `safeToChangeInto`, `easeSpeed`):
the emergency vehicle eases toward `PULLOVER_REQUEST_SPEED` (or 0 on the shoulder),
and transitions `None -> Requesting -> Changing -> OnShoulder -> Stopped`. It only
enters `Changing` when `safeToChangeInto(targetLane)` finds both front and rear
gaps ≥ `SAFE_MERGE_GAP`; during `Changing` it advances `laneF` toward the integer
target lane at `LANE_CHANGE_RATE`; if the gap becomes unsafe it reverts to
`Requesting`. `safeToChangeInto` is a module-level pure helper so it is directly
unit-testable.

**Perception gating** (`hasPerceivedHazard`): ordinary following is never gated;
during an emergency, a follower reacts only via a delivered advisory (`advisoryActive`)
or a visual sighting within `VISUAL_RANGE` after `REACTION.visual`. This is the
honest source of the early-vs-late information difference.

### 4.8 Metrics (`metrics.ts`)

`MetricsAccumulator` tracks, from the running sim: `collisions`, `minTTC` (min over
closing pairs), `maxBrakingDecel`, `harshBrakingEvents`, first-warning and
near-stop times (→ `warningLeadTime`), confirmation and pull-over-complete times
(→ `pullOverCompletionTime`, `null` if never completed), and the delivery rate.

The harsh-braking counter uses a per-vehicle rising-edge latch and counts an event
only when braking exceeds `HARSH_BRAKING_THRESHOLD` **and** TTC ≤ `NEAR_MISS_TTC`.
Rationale: the single-worst-case `maxBrakingDecel` saturates at the 8.0 m/s² clamp
in both scenarios, so it cannot distinguish them; the near-miss-gated event count
measures how *often* dangerous late braking occurred without being inflated simply
because more cars respond in the V2X scenario.

`detectCollisions(laneVehicles)` scans an ascending-position lane for bumper gap
≤ 0, marks both vehicles crashed, and avoids double-counting.

### 4.9 Simulation driver (`simulation.ts`)

`Simulation` constructs both `World`s from one `SimConfig`, advances them in
lockstep, exposes `requestSOS()`, and produces a `SimSnapshot` (plain copies of
vehicles/RSUs plus metrics, the shoulder lane index, and the emergency vehicle's
phase/driver-state for the timeline). `reset(config)` rebuilds both worlds.

Presets:
- `DEFAULT_CONFIG` — `seed 12345, 3 lanes, 2000 m, 24 vehicles, 31 m/s, emergency
  at 3 s, 70% V2X, 100 ms latency, 5% loss, 400 m range, 10 s lifetime`.
- `DEMO_PRESET_CONFIG` — same seed, `36 vehicles, 36 m/s, emergency at 2 s, 90%
  V2X` (high-risk preset for the live demo).

## 5. Visualization and UI

- `render/HighwayCanvas.tsx` — pure Canvas view of one scenario. Both scenarios are
  drawn on a **shared zoomed viewport** (`viewStart..viewEnd` in meters, computed
  in `App.tsx`) so cars and gaps are legible and the two panels line up. It draws
  travel lanes, a hatched shoulder, vehicles colored by `role`/state (with smooth
  `laneF` lateral position), roadside signs, V2X propagation rings + links, and
  distance ticks.
- `ui/ControlPanel.tsx` — Play/Pause, Step, Apply & Replay, Driver SOS, and the
  parameter sliders.
- `ui/MetricsDashboard.tsx` — the metric comparison table, formatting null
  pull-over as "not completed" and explaining the 8.0 m/s² peak.
- `ui/EventTimeline.tsx` — Detection → Confirmation → Broadcast → Vehicle Response
  → Safe Pull-Over, derived from the live v2x snapshot.
- `App.tsx` — owns the loop and config state, the Demo Preset / Reset Demo
  controls, viewport computation, and overall layout.

## 6. Data flow and state ownership

- React state: the pending `SimConfig`, the latest `SimSnapshot`, `running`, and a
  `runToken`. The `Simulation` instance lives in a ref (mutated by the loop, not
  React state) and is the single source of truth for simulation state.
- The snapshot is produced once per stepped frame and threaded immutably into the
  views. Views never call back into the sim except through the explicit control
  handlers (play/pause/step/apply/SOS/demo/reset) on `App.tsx`.

## 7. Testing strategy

- `sim/__tests__/driverState.test.ts` — state transitions and the
  never-broadcast-on-Suspected / SOS-latch guarantees.
- `sim/__tests__/v2x.test.ts` — delivery under latency, loss, and expiration, and
  delivery-rate accounting.
- `sim/__tests__/metrics.test.ts` — metric accumulation, the near-miss harsh-brake
  definition, pull-over completion/`null`, and collision detection.
- `sim/__tests__/pullover.test.ts` — gap gating (no change without a safe gap),
  reaching the shoulder when safe, no overlap/teleport during the change, and the
  pure `safeToChangeInto` helper.
- `sim/__tests__/simulation.test.ts` — deterministic replay, identical initial
  fleets, and the honest DEFAULT vs high-risk DEMO contrasts (collisions and
  pull-over outcomes emerge from the model).
- `ui/__tests__/App.smoke.test.tsx` — the app mounts (canvas `getContext` is
  stubbed in `test/setup.ts`).

## 8. Key design decisions and trade-offs

- **Pure core / thin view** keeps the physics deterministic and testable and lets
  the renderer be swapped without touching behavior.
- **Perception gating** (rather than always-on IDM reacting to the hazard) is what
  makes the early-warning benefit honest instead of assumed.
- **Near-miss-gated harsh-braking metric** was chosen because the peak-braking
  metric saturates in both scenarios and cannot be used to differentiate them.
- **Engineered merge-blocker layout** makes cooperative yielding the measurable
  difference for the pull-over, while preserving identical fleets across worlds.
- **Shoulder as a collision-free refuge** reflects that a vehicle that has left the
  travel lanes is out of the rear-end conflict.

## 9. Future design directions (not implemented)

- **[Future]** Webcam/MediaPipe eye monitoring feeding the existing driver-state
  machine's abstract impairment boolean (no sensor/ML code exists today).
- **[Future]** Discretionary lane changes for ordinary background traffic.
- **[Future]** A richer communication model (RF propagation, interference,
  congestion control) and additional V2X message types.
- **[Future]** Multi-device/WebSocket presentation mode; persistence; real
  map/routing data.
