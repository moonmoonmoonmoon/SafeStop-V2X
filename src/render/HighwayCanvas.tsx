/**
 * HighwayCanvas — renders a single scenario's highway, vehicles, and RSUs.
 *
 * Visualization is intentionally decoupled from the sim: it only reads a
 * WorldSnapshot and draws it. It never mutates simulation state.
 */
import { useEffect, useRef } from "react";
import type { WorldSnapshot } from "../sim/simulation";
import { DriverState } from "../sim/types";

interface Props {
  snapshot: WorldSnapshot;
  highwayLength: number;
  laneCount: number;
  title: string;
  accent: string;
}

const LANE_HEIGHT = 46;
const TOP_PAD = 54;
const SIGN_ROW = 30;

export function HighwayCanvas({
  snapshot,
  highwayLength,
  laneCount,
  title,
  accent,
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
    const roadHeight = laneCount * LANE_HEIGHT;
    const mToPx = width / highwayLength;

    // Clear.
    ctx.clearRect(0, 0, width, cssHeight);

    // Title bar.
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, width, 36);
    ctx.fillStyle = "#fff";
    ctx.font = "600 15px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(title, 14, 18);

    // Road surface.
    ctx.fillStyle = "#2b2f36";
    ctx.fillRect(0, roadTop, width, roadHeight);

    // Lane dividers.
    ctx.strokeStyle = "#5a606b";
    ctx.lineWidth = 2;
    ctx.setLineDash([14, 14]);
    for (let l = 1; l < laneCount; l++) {
      const y = roadTop + l * LANE_HEIGHT;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Road edges.
    ctx.strokeStyle = "#f4c430";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, roadTop);
    ctx.lineTo(width, roadTop);
    ctx.moveTo(0, roadTop + roadHeight);
    ctx.lineTo(width, roadTop + roadHeight);
    ctx.stroke();

    // Roadside signs (VMS).
    for (const rsu of snapshot.rsus) {
      const x = rsu.position * mToPx;
      const active = rsu.signText !== null;
      // Post.
      ctx.strokeStyle = "#8b93a1";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, roadTop - 2);
      ctx.lineTo(x, TOP_PAD + 6);
      ctx.stroke();
      // Sign head.
      ctx.fillStyle = active ? "#ffb300" : "#3a3f47";
      const sw = 12;
      ctx.fillRect(x - sw / 2, TOP_PAD - 4, sw, 12);
      if (active) {
        ctx.fillStyle = "#1a1a1a";
        ctx.font = "700 8px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("!", x, TOP_PAD + 3);
        ctx.textAlign = "left";
      }
    }

    // Vehicles.
    const carLenPx = Math.max(10, 4.5 * mToPx * 2.2); // visually exaggerate length
    const carH = LANE_HEIGHT - 16;
    for (const v of snapshot.vehicles) {
      const x = v.position * mToPx;
      const y = roadTop + v.lane * LANE_HEIGHT + 8;

      let color = "#4cc9f0"; // normal traffic
      if (v.id === snapshot.hazardVehicleId) {
        color =
          v.driverState === DriverState.Confirmed
            ? "#ff3b30"
            : v.driverState === DriverState.Suspected
            ? "#ff9500"
            : "#ffd60a";
      } else if (v.crashed) {
        color = "#6b7280";
      } else if (v.respondingToHazard) {
        color = "#34c759"; // responding safely
      } else if (v.isConnected) {
        color = "#7a8cff"; // connected, idle
      }

      // Crash marker.
      if (v.crashed) {
        ctx.fillStyle = "#6b7280";
      } else {
        ctx.fillStyle = color;
      }
      roundRect(ctx, x - carLenPx / 2, y, carLenPx, carH, 3);
      ctx.fill();

      // Hazard vehicle flashing outline when confirmed.
      if (
        v.id === snapshot.hazardVehicleId &&
        v.driverState === DriverState.Confirmed
      ) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        roundRect(ctx, x - carLenPx / 2, y, carLenPx, carH, 3);
        ctx.stroke();
      }

      if (v.crashed) {
        ctx.fillStyle = "#fff";
        ctx.font = "700 10px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("✕", x, y + carH / 2 + 3);
        ctx.textAlign = "left";
      }
    }

    // Distance ticks.
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px system-ui, sans-serif";
    for (let m = 0; m <= highwayLength; m += 500) {
      const x = m * mToPx;
      ctx.fillText(`${m}m`, x + 2, roadTop + roadHeight + 12);
    }
  }, [snapshot, highwayLength, laneCount, title, accent]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100%",
        height: TOP_PAD + SIGN_ROW + laneCount * LANE_HEIGHT + 24,
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
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
