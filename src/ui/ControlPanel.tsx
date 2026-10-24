/**
 * ControlPanel — interactive controls for the demo. Editing any control updates
 * the pending config; "Apply & Replay" resets both worlds deterministically.
 */
import type { SimConfig } from "../sim/types";
import { MS_TO_MPH } from "../sim/constants";

interface Props {
  config: SimConfig;
  running: boolean;
  onChange: (patch: Partial<SimConfig>) => void;
  onApply: () => void;
  onToggleRun: () => void;
  onStep: () => void;
  onSOS: () => void;
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  display?: (v: number) => string;
  onChange: (v: number) => void;
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  display,
  onChange,
}: SliderProps) {
  return (
    <label className="slider">
      <span className="slider-label">
        {label}
        <strong>{display ? display(value) : `${value}${suffix ?? ""}`}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  );
}

export function ControlPanel({
  config,
  running,
  onChange,
  onApply,
  onToggleRun,
  onStep,
  onSOS,
}: Props) {
  return (
    <div className="controls">
      <div className="controls-actions">
        <button className="btn primary" onClick={onToggleRun}>
          {running ? "⏸ Pause" : "▶ Play"}
        </button>
        <button className="btn" onClick={onStep} disabled={running}>
          ⏭ Step
        </button>
        <button className="btn warn" onClick={onApply}>
          ↻ Apply & Replay
        </button>
        <button className="btn sos" onClick={onSOS}>
          🆘 Driver SOS
        </button>
      </div>

      <div className="controls-grid">
        <Slider
          label="Traffic density (vehicles)"
          value={config.vehicleCount}
          min={6}
          max={45}
          step={1}
          onChange={(v) => onChange({ vehicleCount: v })}
        />
        <Slider
          label="Mean speed"
          value={config.meanSpeed}
          min={15}
          max={38}
          step={1}
          display={(v) => `${v} m/s (${Math.round(v * MS_TO_MPH)} mph)`}
          onChange={(v) => onChange({ meanSpeed: v })}
        />
        <Slider
          label="Emergency onset"
          value={config.emergencyTime}
          min={1}
          max={12}
          step={0.5}
          suffix=" s"
          onChange={(v) => onChange({ emergencyTime: v })}
        />
        <Slider
          label="V2X penetration"
          value={config.v2xPenetration}
          min={0}
          max={1}
          step={0.05}
          display={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => onChange({ v2xPenetration: v })}
        />
        <Slider
          label="Network latency"
          value={config.networkLatency}
          min={0}
          max={1}
          step={0.02}
          display={(v) => `${Math.round(v * 1000)} ms`}
          onChange={(v) => onChange({ networkLatency: v })}
        />
        <Slider
          label="Packet loss"
          value={config.packetLoss}
          min={0}
          max={0.6}
          step={0.01}
          display={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => onChange({ packetLoss: v })}
        />
        <Slider
          label="Comm range"
          value={config.commRange}
          min={100}
          max={800}
          step={25}
          suffix=" m"
          onChange={(v) => onChange({ commRange: v })}
        />
        <Slider
          label="Random seed"
          value={config.seed}
          min={1}
          max={99999}
          step={1}
          onChange={(v) => onChange({ seed: Math.round(v) })}
        />
      </div>
      <p className="controls-hint">
        Adjust a control, then <strong>Apply &amp; Replay</strong> to rerun both
        scenarios deterministically from identical initial conditions.
      </p>
    </div>
  );
}
