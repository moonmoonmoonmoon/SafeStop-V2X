/**
 * EventTimeline — shows the emergency event pipeline for the V2X scenario:
 *   Detection → Confirmation → Broadcast → Vehicle Response → Safe Pull-Over
 *
 * Each stage lights up as the simulation reaches it. The stage states are derived
 * from the live V2X-world snapshot (driver state, whether any advisory is active,
 * and the pull-over phase), so the timeline reflects the actual run, not a script.
 */
import type { WorldSnapshot } from "../sim/simulation";
import { DriverState, PullOverPhase } from "../sim/types";

interface Props {
  v2x: WorldSnapshot;
  emergencyTime: number;
  simTime: number;
}

interface Stage {
  label: string;
  done: boolean;
  active: boolean;
}

export function EventTimeline({ v2x, emergencyTime, simTime }: Props) {
  const driver = v2x.emergencyDriverState;
  const phase = v2x.emergencyPhase;
  const anyAdvisory = v2x.vehicles.some((x) => x.advisoryActive);
  const anyResponding = v2x.vehicles.some(
    (x) => x.id !== v2x.hazardVehicleId && (x.respondingToHazard || x.yielding)
  );

  const detected = simTime >= emergencyTime || driver !== DriverState.Normal;
  const confirmed = driver === DriverState.Confirmed;
  const broadcast = confirmed; // v2x world broadcasts on confirmation
  const responded = anyAdvisory || anyResponding;
  const pulledOver = phase === PullOverPhase.Stopped;

  const stages: Stage[] = [
    { label: "Detection", done: detected, active: detected && !confirmed },
    { label: "Confirmation", done: confirmed, active: confirmed && !broadcast },
    { label: "Broadcast", done: broadcast, active: broadcast && !responded },
    {
      label: "Vehicle Response",
      done: responded,
      active: responded && !pulledOver,
    },
    { label: "Safe Pull-Over", done: pulledOver, active: false },
  ];

  return (
    <div className="timeline">
      <div className="timeline-title">Emergency event timeline (V2X)</div>
      <div className="timeline-track">
        {stages.map((s, i) => (
          <div key={s.label} className="timeline-stage">
            <div
              className={
                "timeline-dot" +
                (s.done ? " done" : "") +
                (s.active ? " active" : "")
              }
            >
              {s.done ? "✓" : i + 1}
            </div>
            <span className="timeline-label">{s.label}</span>
            {i < stages.length - 1 && (
              <div className={"timeline-conn" + (s.done ? " done" : "")} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
