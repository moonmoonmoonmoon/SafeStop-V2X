/**
 * App — top-level SafeStop V2X demo.
 *
 * Runs the Simulation with a fixed-timestep accumulator driven by rAF, and renders
 * the two scenarios side by side with controls and a metrics dashboard.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_CONFIG,
  DEMO_PRESET_CONFIG,
  Simulation,
  type SimSnapshot,
} from "./sim/simulation";
import { DT } from "./sim/constants";
import type { SimConfig } from "./sim/types";
import { HighwayCanvas } from "./render/HighwayCanvas";
import { ControlPanel } from "./ui/ControlPanel";
import { MetricsDashboard } from "./ui/MetricsDashboard";
import "./App.css";

const MAX_SIM_TIME = 25; // seconds of simulated time per run

export default function App() {
  const simRef = useRef<Simulation>(new Simulation(DEFAULT_CONFIG));
  const [config, setConfig] = useState<SimConfig>(DEFAULT_CONFIG);
  const [snapshot, setSnapshot] = useState<SimSnapshot>(() =>
    simRef.current.snapshot()
  );
  const [running, setRunning] = useState(false);
  // Bumped whenever a run (re)starts, so the animation effect always restarts the
  // rAF loop cleanly even when `running` was already true (e.g. Reset Demo).
  const [runToken, setRunToken] = useState(0);

  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const accumulatorRef = useRef<number>(0);

  // Fixed-timestep loop: advance the sim in DT increments regardless of frame rate.
  const loop = useCallback((now: number) => {
    const sim = simRef.current;
    const last = lastTimeRef.current || now;
    let frameDelta = (now - last) / 1000;
    lastTimeRef.current = now;
    // Clamp to avoid spiral-of-death after a tab is backgrounded.
    if (frameDelta > 0.25) frameDelta = 0.25;
    accumulatorRef.current += frameDelta;

    let stepped = false;
    while (accumulatorRef.current >= DT) {
      if (sim.time < MAX_SIM_TIME) {
        sim.step();
        stepped = true;
      }
      accumulatorRef.current -= DT;
    }

    if (stepped) setSnapshot(sim.snapshot());

    if (sim.time >= MAX_SIM_TIME) {
      setRunning(false);
      return;
    }
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  useEffect(() => {
    if (running) {
      lastTimeRef.current = 0;
      accumulatorRef.current = 0;
      rafRef.current = requestAnimationFrame(loop);
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      };
    }
  }, [running, runToken, loop]);

  const handleChange = useCallback((patch: Partial<SimConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
  }, []);

  const handleApply = useCallback(() => {
    setRunning(false);
    simRef.current.reset(config);
    accumulatorRef.current = 0;
    lastTimeRef.current = 0;
    setSnapshot(simRef.current.snapshot());
  }, [config]);

  const handleToggleRun = useCallback(() => {
    // If the run finished, Apply first so Play restarts cleanly.
    if (simRef.current.time >= MAX_SIM_TIME) {
      simRef.current.reset(config);
      setSnapshot(simRef.current.snapshot());
    }
    setRunning((r) => !r);
  }, [config]);

  const handleStep = useCallback(() => {
    const sim = simRef.current;
    if (sim.time < MAX_SIM_TIME) {
      sim.step();
      setSnapshot(sim.snapshot());
    }
  }, []);

  const handleSOS = useCallback(() => {
    simRef.current.requestSOS();
    if (!running) setSnapshot(simRef.current.snapshot());
  }, [running]);

  // Load the curated stress scenario (collision in baseline, avoided with V2X)
  // and start it immediately — one click for the presentation.
  const handleLoadDemoPreset = useCallback(() => {
    setConfig(DEMO_PRESET_CONFIG);
    simRef.current.reset(DEMO_PRESET_CONFIG);
    accumulatorRef.current = 0;
    lastTimeRef.current = 0;
    setSnapshot(simRef.current.snapshot());
    setRunning(true);
    setRunToken((t) => t + 1); // force the loop to (re)start
  }, []);

  // Replay the CURRENT scenario from t=0 (deterministic) and start it again, so
  // the same run can be shown repeatedly on stage.
  const handleResetDemo = useCallback(() => {
    simRef.current.reset(config);
    accumulatorRef.current = 0;
    lastTimeRef.current = 0;
    setSnapshot(simRef.current.snapshot());
    setRunning(true);
    setRunToken((t) => t + 1); // force a clean restart even if already running
  }, [config]);

  const finished = snapshot.time >= MAX_SIM_TIME;

  const isDemoPreset =
    config.vehicleCount === DEMO_PRESET_CONFIG.vehicleCount &&
    config.meanSpeed === DEMO_PRESET_CONFIG.meanSpeed &&
    config.emergencyTime === DEMO_PRESET_CONFIG.emergencyTime &&
    config.v2xPenetration === DEMO_PRESET_CONFIG.v2xPenetration &&
    config.seed === DEMO_PRESET_CONFIG.seed;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo">🛡️</span>
          <div>
            <h1>SafeStop V2X</h1>
            <p>
              Cooperative highway emergency warning — an interactive digital twin
            </p>
          </div>
        </div>
        <div className="clock">
          <span className="clock-label">SIM TIME</span>
          <span className="clock-value">{snapshot.time.toFixed(1)}s</span>
          {finished && <span className="badge">run complete</span>}
        </div>
      </header>

      <div className="demo-bar">
        <div className="demo-bar-text">
          <span className="demo-bar-title">Presentation mode</span>
          <span className="demo-bar-sub">
            One click loads the stress scenario: the baseline crashes, SafeStop
            V2X does not — same seed, identical starting traffic.
          </span>
        </div>
        <div className="demo-bar-actions">
          <button className="btn demo" onClick={handleLoadDemoPreset}>
            🎬 Demo Preset
          </button>
          <button className="btn reset" onClick={handleResetDemo}>
            🔁 Reset Demo
          </button>
          {isDemoPreset && <span className="demo-flag">demo preset loaded</span>}
        </div>
      </div>

      <ControlPanel
        config={config}
        running={running}
        onChange={handleChange}
        onApply={handleApply}
        onToggleRun={handleToggleRun}
        onStep={handleStep}
        onSOS={handleSOS}
      />

      <div className="scenarios">
        <div className="scenario-card">
          <HighwayCanvas
            snapshot={snapshot.hazardOnly}
            highwayLength={config.highwayLength}
            laneCount={config.laneCount}
            title="SCENARIO A — Hazard lights only (today)"
            accent="#b23b3b"
          />
        </div>
        <div className="scenario-card">
          <HighwayCanvas
            snapshot={snapshot.v2x}
            highwayLength={config.highwayLength}
            laneCount={config.laneCount}
            title="SCENARIO B — SafeStop V2X assisted"
            accent="#2f8f5b"
          />
        </div>
      </div>

      <div className="lower">
        <MetricsDashboard
          hazardOnly={snapshot.hazardOnly.metrics}
          v2x={snapshot.v2x.metrics}
        />
        <aside className="legend">
          <h3>Legend</h3>
          <ul>
            <li><span className="dot" style={{ background: "#ffd60a" }} /> Hazard vehicle (impairment onset)</li>
            <li><span className="dot" style={{ background: "#ff9500" }} /> Hazard — suspected (no broadcast)</li>
            <li><span className="dot" style={{ background: "#ff3b30" }} /> Hazard — confirmed (broadcasting)</li>
            <li><span className="dot" style={{ background: "#34c759" }} /> Responding safely</li>
            <li><span className="dot" style={{ background: "#7a8cff" }} /> Connected vehicle (V2X)</li>
            <li><span className="dot" style={{ background: "#4cc9f0" }} /> Normal traffic</li>
            <li><span className="dot" style={{ background: "#6b7280" }} /> Crashed</li>
            <li><span className="dot" style={{ background: "#ffb300" }} /> Active roadside sign (V2I)</li>
          </ul>
          <p className="disclaimer">
            Simulation for demonstration only. Not a production safety controller;
            no medical diagnosis or validated collision-prevention claim.
          </p>
        </aside>
      </div>
    </div>
  );
}
