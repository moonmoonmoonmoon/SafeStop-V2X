/**
 * MetricsDashboard — side-by-side comparison of the key safety metrics for the
 * two scenarios. Numbers come straight from the sim's MetricsAccumulator.
 */
import type { Metrics } from "../sim/types";
import { MS_TO_MPH } from "../sim/constants";

interface Props {
  hazardOnly: Metrics;
  v2x: Metrics;
}

function fmtTTC(ttc: number): string {
  return Number.isFinite(ttc) ? `${ttc.toFixed(1)} s` : "—";
}

interface Row {
  label: string;
  unit: string;
  get: (m: Metrics) => number;
  fmt: (m: Metrics) => string;
  /** "lower" means a lower value is better (green). */
  better: "lower" | "higher";
}

const ROWS: Row[] = [
  {
    label: "Collisions",
    unit: "",
    get: (m) => m.collisions,
    fmt: (m) => `${m.collisions}`,
    better: "lower",
  },
  {
    label: "Min time-to-collision",
    unit: "",
    get: (m) => (Number.isFinite(m.minTTC) ? m.minTTC : 999),
    fmt: (m) => fmtTTC(m.minTTC),
    better: "higher",
  },
  {
    label: "Max braking",
    unit: "m/s²",
    get: (m) => m.maxBrakingDecel,
    fmt: (m) => `${m.maxBrakingDecel.toFixed(1)} m/s²`,
    better: "lower",
  },
  {
    label: "Warning lead time",
    unit: "s",
    get: (m) => m.warningLeadTime,
    fmt: (m) => `${m.warningLeadTime.toFixed(1)} s`,
    better: "higher",
  },
  {
    label: "Message delivery",
    unit: "%",
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
          const v2xBetter =
            row.better === "lower" ? xv < hv : xv > hv;
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
        Lead time = seconds between the first V2X warning delivered and the hazard
        vehicle reaching near-stop. Higher lead time and TTC are safer; lower
        collisions and braking force are safer. mph reference: 31 m/s ≈{" "}
        {Math.round(31 * MS_TO_MPH)} mph.
      </p>
    </div>
  );
}
