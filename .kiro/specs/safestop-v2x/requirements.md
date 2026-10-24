# SafeStop V2X — Requirements

> **Status note.** This document is written *after the fact* to describe the
> system as it is currently implemented in `src/`. Each requirement below is
> marked **[Implemented]** when it reflects behavior present in the code, or
> **[Future]** when it is a planned idea that is **not** in the codebase. It does
> not describe how the project was built or any tooling history.

## Overview

SafeStop V2X is an educational, browser-based digital twin. It simulates a
multi-lane highway where one driver suffers an acute impairment and must slow and
pull over, and it compares two scenarios side by side from identical initial
conditions:

- **Hazard-only** — drivers react only to what they can visually perceive.
- **V2X-assisted** — a Vehicle-to-Everything layer warns connected vehicles and
  roadside signs earlier and enables cooperative yielding.

It is a demonstration/teaching tool. It is **not** a production vehicle safety
system, performs **no** medical diagnosis, and makes **no** validated
collision-prevention claim.

## Glossary

- **Emergency / hazard vehicle** — the single designated vehicle whose driver
  becomes impaired during the run.
- **Connected vehicle** — a vehicle equipped with a V2X radio.
- **Advisory** — the `EMERGENCY_SLOWDOWN` V2X message broadcast by a confirmed
  emergency vehicle.
- **Pull-over** — the maneuver in which the emergency vehicle leaves the travel
  lanes for the shoulder.

---

## Requirement 1 — Two synchronized scenarios from identical conditions

**User story:** As a presenter, I want the baseline and the V2X-assisted scenario
to run from identical starting traffic, so that any difference is attributable only
to V2X.

**Acceptance criteria**

1. **[Implemented]** The system SHALL run a "hazard-only" world and a "v2x" world
   simultaneously, in lockstep, on a fixed timestep.
2. **[Implemented]** Both worlds SHALL be constructed from the same `SimConfig` and
   seed so their initial vehicle positions, speeds, lanes, and connectivity are
   identical.
3. **[Implemented]** The only behavioral difference between the worlds SHALL be
   whether V2X broadcasting/advisories exist.
4. **[Implemented]** Given the same config and seed, a run SHALL reproduce exactly
   (deterministic replay).

## Requirement 2 — Realistic longitudinal traffic

**User story:** As a viewer, I want vehicles to move and follow each other
plausibly, so that the demo is believable.

**Acceptance criteria**

1. **[Implemented]** Vehicles SHALL follow the Intelligent Driver Model (IDM) for
   car-following, computing acceleration from speed, desired speed, gap, and
   approach rate.
2. **[Implemented]** Braking SHALL be bounded by a hard physical limit
   (`MAX_EMERGENCY_DECEL` = 8.0 m/s²); vehicles SHALL NOT instantly stop or reverse.
3. **[Implemented]** The highway SHALL have `laneCount` travel lanes (default 3)
   plus a shoulder lane.
4. **[Implemented]** The initial fleet SHALL start in a stable, spaced configuration
   so there is no startup braking transient before the emergency.

## Requirement 3 — Driver impairment detection and confirmation

**User story:** As a safety-conscious designer, I want ordinary blinks or eye rubs
to never trigger an external alarm, so that only genuine emergencies are broadcast.

**Acceptance criteria**

1. **[Implemented]** The system SHALL model a driver state machine with states
   `Normal`, `Suspected`, and `Confirmed`.
2. **[Implemented]** A brief impairment signal shorter than `DETECTION.ignoreBelow`
   (0.4 s) SHALL leave the state at `Normal`.
3. **[Implemented]** A sustained impairment signal SHALL escalate `Suspected ->
   Confirmed` after `DETECTION.confirmAfter`.
4. **[Implemented]** The `Suspected` state SHALL NOT cause any external V2X
   broadcast; only `Confirmed` SHALL broadcast.
5. **[Implemented]** A manual SOS input SHALL force `Confirmed` immediately and
   latch it.
6. **[Implemented]** The detection input SHALL be an abstract boolean, decoupled
   from any specific sensor.
7. **[Future]** A webcam/MediaPipe eye monitor MAY later supply the impairment
   signal. (No camera or ML code exists today.)

## Requirement 4 — Perception-gated emergency response

**User story:** As a viewer, I want drivers to react only to information they
actually have, so that the value of earlier warning is honest.

**Acceptance criteria**

1. **[Implemented]** During an active emergency, a following driver SHALL engage
   emergency braking only after perceiving the hazard, via either (a) a delivered
   V2X advisory, or (b) seeing a slow leader within `VISUAL_RANGE` and waiting out
   `REACTION.visual`.
2. **[Implemented]** A driver that has not perceived the hazard SHALL continue
   free-flow toward its desired speed (it does not brake for an unperceived car).
3. **[Implemented]** Ordinary, non-emergency car-following SHALL NOT be suppressed
   by this gating.
4. **[Implemented]** The V2X reaction delay (`REACTION.v2xAdvisory`) SHALL be
   shorter than the visual reaction delay (`REACTION.visual`).

## Requirement 5 — Safety-constrained emergency pull-over

**User story:** As an impaired driver, I want to pull over to the shoulder safely,
changing lanes only when there is room, so that I never force an unsafe maneuver.

**Acceptance criteria**

1. **[Implemented]** On confirmation, the emergency vehicle SHALL ease toward
   `PULLOVER_REQUEST_SPEED` and seek to move toward the shoulder one lane at a time.
2. **[Implemented]** The emergency vehicle SHALL change lanes only when BOTH a
   front gap ≥ `SAFE_MERGE_GAP.front` and a rear gap ≥ `SAFE_MERGE_GAP.rear` exist
   in the target lane.
3. **[Implemented]** If no safe gap exists, the maneuver SHALL wait (remain in
   `Requesting`) rather than force a change.
4. **[Implemented]** A lane change in progress SHALL be aborted back to waiting if
   the target gap stops being safe.
5. **[Implemented]** Lateral movement SHALL be continuous (`laneF`) at
   `LANE_CHANGE_RATE`, without teleporting or overlapping another vehicle.
6. **[Implemented]** The maneuver SHALL progress through phases `None -> Requesting
   -> Changing -> OnShoulder -> Stopped` and stop safely on the shoulder.

## Requirement 6 — Cooperative V2X gap creation (yielding)

**User story:** As a connected driver, I want to open a gap for an impaired vehicle
that needs to pull over, so that it can reach the shoulder sooner.

**Acceptance criteria**

1. **[Implemented]** In the v2x scenario only, a connected vehicle that has the
   advisory and is the emergency vehicle's intended rear neighbor in the target
   lane SHALL yield.
2. **[Implemented]** Yielding SHALL be a mild, bounded ease (`YIELD_DECEL`) toward
   `YIELD_SPEED_MARGIN` below the emergency vehicle's current speed — not hard
   braking.
3. **[Implemented]** Cooperative yielding SHALL enable the pull-over to complete
   sooner in the v2x scenario than in hazard-only.

## Requirement 7 — Simulated V2X communication

**User story:** As an engineer, I want the V2X layer to model the properties that
matter (range, latency, loss, expiration), so that the demo is credible.

**Acceptance criteria**

1. **[Implemented]** The emergency vehicle SHALL broadcast an `EMERGENCY_SLOWDOWN`
   advisory only while `Confirmed`.
2. **[Implemented]** Only connected vehicles within `commRange` of the origin SHALL
   be eligible receivers.
3. **[Implemented]** Each delivery SHALL be delayed by `networkLatency`.
4. **[Implemented]** Each attempted delivery SHALL be dropped with probability
   `packetLoss`, and drops SHALL count against the delivery rate.
5. **[Implemented]** A message SHALL carry an expiration (`messageLifetime`); a
   message arriving after expiry SHALL be discarded and not counted as delivered.
6. **[Future]** The layer does NOT model RF propagation, interference, or
   congestion control, and there is no requirement that it do so.

## Requirement 8 — Roadside infrastructure (V2I)

**User story:** As a driver without a V2X radio, I want roadside signs to warn me,
so that unconnected traffic also benefits.

**Acceptance criteria**

1. **[Implemented]** Roadside units SHALL be placed along the highway at fixed
   intervals.
2. **[Implemented]** A roadside unit within range of, and upstream of, a
   broadcasting hazard SHALL display `"EMERGENCY AHEAD <distance> m — SLOW DOWN"`.
3. **[Implemented]** A sign SHALL clear when the triggering message's lifetime
   expires.

## Requirement 9 — Safety metrics

**User story:** As a presenter, I want quantitative, simulation-derived metrics, so
that the comparison is objective and not hardcoded.

**Acceptance criteria**

1. **[Implemented]** The system SHALL compute, per scenario, from the running sim:
   collision count, minimum time-to-collision, maximum braking deceleration,
   harsh-braking events, warning lead time, pull-over completion time, and message
   delivery rate.
2. **[Implemented]** The harsh-braking-events count SHALL count a hard brake
   (> `HARSH_BRAKING_THRESHOLD`) only when it occurs with a near-miss time-to-
   collision (≤ `NEAR_MISS_TTC`), counted once per rising edge per vehicle.
3. **[Implemented]** Pull-over completion time SHALL be measured from confirmation
   to a shoulder stop, and SHALL report "not completed" when the maneuver never
   finishes within the run.
4. **[Implemented]** No metric value or collision outcome SHALL be hardcoded; all
   SHALL emerge from the model.

## Requirement 10 — Collision handling

**Acceptance criteria**

1. **[Implemented]** A rear-end contact (bumper gap ≤ 0) in a travel lane SHALL be
   detected and both vehicles marked crashed.
2. **[Implemented]** Crashed vehicles SHALL become immobile obstacles.
3. **[Implemented]** The shoulder SHALL be treated as a refuge: collisions SHALL be
   detected in travel lanes only.

## Requirement 11 — Interactive controls and presets

**User story:** As a presenter, I want to run, pause, step, and reset the sim and
load a prepared scenario, so that I can drive a 3-minute demo smoothly.

**Acceptance criteria**

1. **[Implemented]** The UI SHALL provide Play/Pause, Step, Apply & Replay, and a
   manual Driver SOS control.
2. **[Implemented]** The UI SHALL provide a one-click Demo Preset that loads a
   high-risk scenario and starts it, and a Reset Demo that replays the current
   scenario deterministically.
3. **[Implemented]** The UI SHALL expose sliders for traffic density, mean speed,
   emergency onset, V2X penetration, network latency, packet loss, communication
   range, and random seed.
4. **[Implemented]** Editing a control and applying it SHALL rebuild both worlds
   deterministically from the new config.

## Requirement 12 — Comprehensible visualization

**User story:** As a viewer, I want to understand the animation without reading the
code, so that the demo communicates on its own.

**Acceptance criteria**

1. **[Implemented]** The renderer SHALL draw both scenarios on a shared zoomed
   viewport so vehicles and gaps are legible.
2. **[Implemented]** A shoulder lane SHALL be visually distinct from travel lanes.
3. **[Implemented]** Vehicles SHALL be color-coded by role (emergency, unalerted,
   alerted, braking, yielding, crashed).
4. **[Implemented]** When the emergency vehicle is broadcasting, V2X propagation
   SHALL be visualized (expanding rings and links to alerted vehicles).
5. **[Implemented]** Active roadside signs SHALL be rendered.
6. **[Implemented]** An event timeline SHALL show Detection -> Confirmation ->
   Broadcast -> Vehicle Response -> Safe Pull-Over, lit from live V2X-world state.

## Requirement 13 — Determinism, portability, and quality

**Acceptance criteria**

1. **[Implemented]** The simulation core SHALL be free of React/DOM dependencies.
2. **[Implemented]** The app SHALL run locally with `npm install` and `npm run dev`
   with no backend.
3. **[Implemented]** The project SHALL pass `tsc` strict typechecking and its
   Vitest suite.

## Out of scope / future (not implemented)

- Webcam/MediaPipe eye detection or any ML-based impairment sensing.
- Discretionary lane changes by ordinary background traffic.
- RF propagation, interference, or congestion-control modeling.
- Backend services, persistence, multi-device, or real map/routing data.
