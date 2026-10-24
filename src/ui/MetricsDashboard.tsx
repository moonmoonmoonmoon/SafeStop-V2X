/**
 * MetricsDashboard — side-by-side comparison of the key safety metrics for the
 * two scenarios. Every value comes straight from the sim's MetricsAccumulator;
 * nothing here is hardcoded.
 */
import type { Metrics } from "../sim/types";
import { HARSH_BRAKING_THRESHOLD, MAX_EMERGENCY_DECEL } from "../sim/constants";

interface Props {
  hazardOnly: Metrics;
  v2x: Metrics;
}

function fmtTTC(ttc: number): string {
  return Number.isFinite(ttc) ? `${ttc.toFixed(1)} s` : "—";
}

function fmtPullOver(t: number | null): string {
  return t === null ? "not completed" : `${t.toFixed(1)} s`;
}

interface Row {
  label: string;
  get: (m: Metrics) => number;
  fmt: (m: Metrics) => string;
  /** "lower" means a lower value is better (green). */
  better: "lower" | "higher";
}

// Sentinels so "not completed" (null) sorts as WORSE than any finite time.
const PULLOVER_WORST = 1e9;

const ROWS: Row[] = [
  {
    label: "Collisions",
    get: (m) => m.collisions,
    fmt: (m) => `${m.collisions}`,
    better: "lower",
  },
  {
    label: "Min time-to-collision",
    get: (m) => (Number.isFinite(m.minTTC) ? m.minTTC : 999),
    fmt: (m) => fmtTTC(m.minTTC),
    better: "higher",
  },
  {
    label: "Max braking",
    get: (m) => m.maxBrakingDecel,
    fmt: (m) => `${m.maxBrakingDecel.toFixed(1)} m/s²`,
    better: "lower",
  },
  {
    label: "Harsh-braking events",
    get: (m) => m.harshBrakingEvents,
    fmt: (m) => `${m.harshBrakingEvents}`,
    better: "lower",
  },
  {
    label: "Warning lead time",
    get: (m) => m.warningLeadTime,
    fmt: (m) => `${m.warningLeadTime.toFixed(1)} s`,
    better: "higher",
  },
  {
    label: "Pull-over completion",
    get: (m) => m.pullOverCompletionTime ?? PULLOVER_WORST,
    fmt: (m) => fmtPullOver(m.pullOverCompletionTime),
    better: "lower",
  },
  {
    label: "Message delivery",
    get: (m) => m.messageDeliveryRate,
    fmt: (m) => `${Math.round(m.messageDeliveryRate * 100)}%`,
    better: "higher",
  },
];

export function MetricsDashboard({ hazardOnly, v2x }: Props) {
  return (
    <div className="metrics">
      <div className="metrics-header">
        <span>Metric</span>
        <span className="col-hazard">Hazard lights only</span>
        <span className="col-v2x">SafeStop V2X</span>
      </div>
      {ROWS.map((row) => {
        const hv = row.get(hazardOnly);
        const xv = row.get(v2x);
        let hClass = "";
        let xClass = "";
        if (hv !== xv) {
          const v2xBetter = row.better === "lower" ? xv < hv : xv > hv;
          xClass = v2xBetter ? "good" : "bad";
          hClass = v2xBetter ? "bad" : "good";
        }
        return (
          <div className="metrics-row" key={row.label}>
            <span className="metric-label">{row.label}</span>
            <span className={`metric-val ${hClass}`}>{row.fmt(hazardOnly)}</span>
            <span className={`metric-val ${xClass}`}>{row.fmt(v2x)}</span>
          </div>
        );
      })}
      <p className="metrics-note">
        All values are computed from the simulation each run. <strong>Max braking</strong>{" "}
        reaches {MAX_EMERGENCY_DECEL.toFixed(1)} m/s² in both scenarios because at
        least one vehicle hits the hard physical braking limit — so the peak is the
        same. The <strong>harsh-braking events</strong> count (near-miss braking
        above {HARSH_BRAKING_THRESHOLD.toFixed(0)} m/s² while time-to-collision is
        low) shows how OFTEN dangerous braking happened, which the single peak
        hides. Lead time = seconds between the first V2X warning and the emergency
        vehicle reaching near-stop. Pull-over completion = seconds from
        confirmation to a safe stop on the shoulder.
      </p>
    </div>
  );
}
