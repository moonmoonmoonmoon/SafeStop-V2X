/**
 * HighwayCanvas — renders a single scenario's highway, vehicles, shoulder, RSUs,
 * and V2X communication propagation. Pure view: it only reads a WorldSnapshot and
 * draws it; it never mutates simulation state.
 *
 * Key readability choices:
 *  - A ZOOMED viewport (viewStart..viewEnd, in meters) frames the action so cars
 *    and gaps are large and legible instead of a 2000 m strip where everything
 *    collapses to a few pixels. The SAME window is used for both scenarios so the
 *    side-by-side comparison lines up.
 *  - A clearly marked SHOULDER lane sits below the travel lanes.
 *  - Vehicles are coloured by ROLE (unalerted / alerted / braking / yielding /
 *    emergency / crashed) so the animation is understandable at a glance.
 *  - Lateral (lane-change) motion is drawn from the continuous laneF field.
 *  - When the emergency vehicle is broadcasting, expanding rings visualise the
 *    V2X message reaching connected vehicles and roadside units.
 */
import { useEffect, useRef } from "react";
import type { WorldSnapshot } from "../sim/simulation";
import { DriverState, VehicleRole } from "../sim/types";

interface Props {
  snapshot: WorldSnapshot;
  laneCount: number;
  /** Shared viewport window in meters (same for both scenarios). */
  viewStart: number;
  viewEnd: number;
  /** Whether the emergency vehicle is broadcasting (drives the V2X rings). */
  broadcasting: boolean;
  /** Communication range (m) for the propagation ring. */
  commRange: number;
  title: string;
  accent: string;
  /** Sim time (s), used to animate the propagation rings. */
  time: number;
}

const LANE_HEIGHT = 60;
const TOP_PAD = 34;
const SIGN_ROW = 40;
const SHOULDER_HATCH = "#3a3326";

const ROLE_COLORS: Record<VehicleRole, string> = {
  [VehicleRole.Normal]: "#4cc9f0",
  [VehicleRole.Unalerted]: "#4cc9f0",
  [VehicleRole.Alerted]: "#ffd166",
  [VehicleRole.Braking]: "#ff7a45",
  [VehicleRole.Yielding]: "#b388ff",
  [VehicleRole.Emergency]: "#ff3b30",
};

export function HighwayCanvas({
  snapshot,
  laneCount,
  viewStart,
  viewEnd,
  broadcasting,
  commRange,
  title,
  accent,
  time,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const width = cssWidth;
    const roadTop = TOP_PAD + SIGN_ROW;
    const span = Math.max(1, viewEnd - viewStart);
    const mToPx = width / span;
    const xOf = (posM: number) => (posM - viewStart) * mToPx;

    ctx.clearRect(0, 0, width, cssHeight);

    // Title bar.
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, width, TOP_PAD);
    ctx.fillStyle = "#fff";
    ctx.font = "600 14px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(title, 12, TOP_PAD / 2);

    // Travel lanes surface.
    const travelHeight = laneCount * LANE_HEIGHT;
    ctx.fillStyle = "#2b2f36";
    ctx.fillRect(0, roadTop, width, travelHeight);

    // Shoulder lane (hatched, clearly distinct).
    const shoulderTop = roadTop + travelHeight;
    ctx.fillStyle = "#23201a";
    ctx.fillRect(0, shoulderTop, width, LANE_HEIGHT);
    ctx.strokeStyle = SHOULDER_HATCH;
    ctx.lineWidth = 2;
    for (let x = -LANE_HEIGHT; x < width; x += 16) {
      ctx.beginPath();
      ctx.moveTo(x, shoulderTop + LANE_HEIGHT);
      ctx.lineTo(x + LANE_HEIGHT, shoulderTop);
      ctx.stroke();
    }
    ctx.fillStyle = "#b9a46a";
    ctx.font = "700 10px system-ui, sans-serif";
    ctx.fillText("SHOULDER", 10, shoulderTop + LANE_HEIGHT / 2);

    // Lane dividers.
    ctx.strokeStyle = "#5a606b";
    ctx.lineWidth = 2;
    ctx.setLineDash([16, 16]);
    for (let l = 1; l < laneCount; l++) {
      const y = roadTop + l * LANE_HEIGHT;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Solid edge line between travel lanes and shoulder.
    ctx.strokeStyle = "#f4c430";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, roadTop);
    ctx.lineTo(width, roadTop);
    ctx.moveTo(0, shoulderTop);
    ctx.lineTo(width, shoulderTop);
    ctx.stroke();

    const laneCenterY = (laneF: number) =>
      roadTop + laneF * LANE_HEIGHT + LANE_HEIGHT / 2;

    // --- V2X propagation rings from the emergency vehicle ---
    const emergency = snapshot.vehicles.find(
      (v) => v.id === snapshot.hazardVehicleId
    );
    if (broadcasting && emergency) {
      const ex = xOf(emergency.position);
      const ey = laneCenterY(emergency.laneF);
      // Two expanding rings cycling over ~1.2 s, capped at commRange.
      for (let r = 0; r < 2; r++) {
        const phase = (time * 0.8 + r * 0.5) % 1;
        const radiusM = phase * commRange;
        const radiusPx = radiusM * mToPx;
        ctx.strokeStyle = `rgba(90, 200, 250, ${0.5 * (1 - phase)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(ex, ey, radiusPx, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Draw links to connected, alerted vehicles in view.
      for (const v of snapshot.vehicles) {
        if (v.id === emergency.id || !v.isConnected || !v.advisoryActive) continue;
        if (v.position < viewStart || v.position > viewEnd) continue;
        ctx.strokeStyle = "rgba(90, 200, 250, 0.25)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(xOf(v.position), laneCenterY(v.laneF));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // --- Roadside signs (VMS) ---
    for (const rsu of snapshot.rsus) {
      if (rsu.position < viewStart - 50 || rsu.position > viewEnd + 50) continue;
      const x = xOf(rsu.position);
      const active = rsu.signText !== null;
      ctx.strokeStyle = "#8b93a1";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, roadTop - 2);
      ctx.lineTo(x, TOP_PAD + 8);
      ctx.stroke();
      // Sign board.
      const bw = active ? 150 : 14;
      const bh = 20;
      ctx.fillStyle = active ? "#ffb300" : "#3a3f47";
      roundRect(ctx, x - bw / 2, TOP_PAD + 2, bw, bh, 4);
      ctx.fill();
      if (active) {
        ctx.fillStyle = "#1a1a1a";
        ctx.font = "700 10px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("EMERGENCY AHEAD — SLOW", x, TOP_PAD + 12);
        ctx.textAlign = "left";
      }
    }

    // --- Vehicles ---
    const carLenPx = Math.max(14, 4.5 * mToPx);
    const carH = LANE_HEIGHT - 22;
    for (const v of snapshot.vehicles) {
      if (v.position < viewStart - 20 || v.position > viewEnd + 20) continue;
      const x = xOf(v.position);
      const cy = laneCenterY(v.laneF);
      const y = cy - carH / 2;

      let color = ROLE_COLORS[v.role] ?? "#4cc9f0";
      if (v.crashed) color = "#6b7280";
      const isEmergency = v.id === snapshot.hazardVehicleId;
      if (isEmergency && !v.crashed) {
        color =
          v.driverState === DriverState.Confirmed
            ? "#ff3b30"
            : v.driverState === DriverState.Suspected
            ? "#ff9500"
            : "#ffd60a";
      }

      ctx.fillStyle = color;
      roundRect(ctx, x - carLenPx / 2, y, carLenPx, carH, 4);
      ctx.fill();

      // Emergency vehicle: white flashing outline + beacon when active.
      if (isEmergency && v.driverState !== DriverState.Normal && !v.crashed) {
        ctx.strokeStyle = Math.floor(time * 4) % 2 ? "#ffffff" : "#ff3b30";
        ctx.lineWidth = 2.5;
        roundRect(ctx, x - carLenPx / 2, y, carLenPx, carH, 4);
        ctx.stroke();
      }

      // Crash marker.
      if (v.crashed) {
        ctx.fillStyle = "#fff";
        ctx.font = "700 12px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("✕", x, cy + 4);
        ctx.textAlign = "left";
      }
    }

    // --- Distance ticks (every 50 m within the window) ---
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px system-ui, sans-serif";
    const firstTick = Math.ceil(viewStart / 50) * 50;
    for (let m = firstTick; m <= viewEnd; m += 50) {
      const x = xOf(m);
      ctx.fillText(`${m}m`, x + 2, shoulderTop + LANE_HEIGHT + 12);
    }
  }, [
    snapshot,
    laneCount,
    viewStart,
    viewEnd,
    broadcasting,
    commRange,
    title,
    accent,
    time,
  ]);

  const totalHeight =
    TOP_PAD + SIGN_ROW + (laneCount + 1) * LANE_HEIGHT + 22; // +1 shoulder row

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100%",
        height: totalHeight,
        display: "block",
        borderRadius: 10,
        background: "#1b1e24",
      }}
    />
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
