// Location emulation panel + lightweight 3D trail viz.
//
// Drives `xcrun simctl location <udid> set <lat>,<lng>` on a fixed cadence
// while a requestAnimationFrame loop advances the player position along a
// pre-densified route. The route is rendered to a 2D canvas with a manual
// orbiting orthographic camera — same family as Any Distance's RouteScene
// (extruded ribbon + ground plane shadow) but flat-shaded so we don't pull
// in WebGL or a 3D library.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  DEFAULT_TRAILS,
  defaultSpeed,
  pointAtDistance,
  prepareTrail,
  type PreparedTrail,
  type Trail,
  type TrailMode,
} from "./trails";

interface ExecResult { stdout: string; stderr: string; exitCode: number }
type ExecFn = (cmd: string) => Promise<ExecResult>;

const SPEED_MULTIPLIERS = [1, 2, 5, 20] as const;
type SpeedMultiplier = (typeof SPEED_MULTIPLIERS)[number];

/** simctl set cadence — match real CoreLocation's typical 1Hz update rate. */
const LOCATION_PUSH_INTERVAL_MS = 1000;

interface PlaybackState {
  status: "idle" | "playing" | "paused";
  /** Arc-length offset (meters) along the prepared trail. */
  arc: number;
  /** Wall-clock elapsed time while playing, milliseconds. */
  elapsedMs: number;
}

const INITIAL_PLAYBACK: PlaybackState = { status: "idle", arc: 0, elapsedMs: 0 };

// ─── Tool component ────────────────────────────────────────────────────────

export function LocationEmulationTool({
  udid,
  exec,
}: {
  udid: string;
  exec: ExecFn;
}) {
  const [open, setOpen] = useState(true);
  const [trailId, setTrailId] = useState<string>(DEFAULT_TRAILS[0]!.id);
  const [mode, setMode] = useState<TrailMode>(DEFAULT_TRAILS[0]!.mode);
  const [multiplier, setMultiplier] = useState<SpeedMultiplier>(1);
  const [playback, setPlayback] = useState<PlaybackState>(INITIAL_PLAYBACK);
  const [error, setError] = useState<string | null>(null);

  const trail = useMemo<Trail>(
    () => DEFAULT_TRAILS.find((t) => t.id === trailId) ?? DEFAULT_TRAILS[0]!,
    [trailId],
  );
  const prepared = useMemo(() => prepareTrail(trail), [trail]);

  // ── Animator ─────────────────────────────────────────────────────────────
  // Ref-mirrored state so the rAF callback (which captures across renders)
  // can read the latest values without re-subscribing.
  const arcRef = useRef(0);
  const statusRef = useRef<PlaybackState["status"]>("idle");
  const speedRef = useRef(defaultSpeed(mode) * multiplier);
  const elapsedRef = useRef(0);
  const trailRef = useRef(prepared);

  useEffect(() => { speedRef.current = defaultSpeed(mode) * multiplier; }, [mode, multiplier]);
  useEffect(() => {
    trailRef.current = prepared;
    // Reset progress when the route changes.
    arcRef.current = 0;
    elapsedRef.current = 0;
    statusRef.current = "idle";
    setPlayback(INITIAL_PLAYBACK);
  }, [prepared]);

  // Visualisation tick — runs continuously even while paused/idle so the
  // camera keeps spinning lazily.
  const cameraAngleRef = useRef(0);
  const lastFrameRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let raf = 0;
    const tick = (ts: number) => {
      const last = lastFrameRef.current;
      const dt = last == null ? 16 : Math.min(64, ts - last);
      lastFrameRef.current = ts;

      cameraAngleRef.current = (cameraAngleRef.current + dt * 0.00012) % (Math.PI * 2);

      if (statusRef.current === "playing") {
        const advance = (speedRef.current * dt) / 1000;
        arcRef.current += advance;
        elapsedRef.current += dt;
        const total = trailRef.current.totalDistance;
        if (!trailRef.current.trail.loop && arcRef.current >= total) {
          arcRef.current = total;
          statusRef.current = "paused";
          // Surface the stop to React state so the UI updates the toggle.
          setPlayback({ status: "paused", arc: total, elapsedMs: elapsedRef.current });
        }
      }

      const canvas = canvasRef.current;
      if (canvas) {
        renderScene(canvas, trailRef.current, arcRef.current, cameraAngleRef.current);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Periodically reflect arc/elapsed into React state for the stats row,
  // throttled to keep re-renders cheap (the 60fps animation lives in refs).
  useEffect(() => {
    const id = setInterval(() => {
      if (statusRef.current === "playing") {
        setPlayback({
          status: "playing",
          arc: arcRef.current,
          elapsedMs: elapsedRef.current,
        });
      }
    }, 250);
    return () => clearInterval(id);
  }, []);

  // ── simctl bridge ────────────────────────────────────────────────────────
  // Push the current lat/lng to the simulator on a fixed cadence whenever
  // we're playing. Skipped while paused/idle so the simulator can hold its
  // last position. On stop we run `... clear`.
  useEffect(() => {
    if (playback.status !== "playing") return;
    let cancelled = false;
    let lastPushed = 0;
    let inflight: Promise<unknown> | null = null;

    const push = async () => {
      if (cancelled || inflight) return;
      const now = Date.now();
      if (now - lastPushed < LOCATION_PUSH_INTERVAL_MS) return;
      lastPushed = now;
      const pt = pointAtDistance(trailRef.current, arcRef.current);
      const cmd = `xcrun simctl location ${udid} set ${pt.lat.toFixed(7)},${pt.lng.toFixed(7)}`;
      inflight = exec(cmd).then((res) => {
        if (cancelled) return;
        if (res.exitCode !== 0) {
          setError(parseSimctlError(res.stderr) || "simctl location set failed");
        } else {
          setError(null);
        }
      }).catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }).finally(() => { inflight = null; });
    };

    void push();
    const id = setInterval(push, LOCATION_PUSH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [playback.status, udid, exec]);

  // ── Controls ─────────────────────────────────────────────────────────────
  const onPlayPause = useCallback(() => {
    if (statusRef.current === "playing") {
      statusRef.current = "paused";
      setPlayback((p: PlaybackState) => ({ ...p, status: "paused" }));
      return;
    }
    // Restart from 0 if we ran off the end of a non-loop trail.
    if (arcRef.current >= trailRef.current.totalDistance && !trailRef.current.trail.loop) {
      arcRef.current = 0;
      elapsedRef.current = 0;
    }
    statusRef.current = "playing";
    setPlayback((p: PlaybackState) => ({
      ...p,
      status: "playing",
      arc: arcRef.current,
      elapsedMs: elapsedRef.current,
    }));
  }, []);

  const onStop = useCallback(() => {
    statusRef.current = "idle";
    arcRef.current = 0;
    elapsedRef.current = 0;
    setPlayback(INITIAL_PLAYBACK);
    void exec(`xcrun simctl location ${udid} clear`).then((res) => {
      if (res.exitCode !== 0) setError(parseSimctlError(res.stderr) || null);
      else setError(null);
    });
  }, [exec, udid]);

  const onTrailChange = useCallback((id: string) => {
    setTrailId(id);
    const next = DEFAULT_TRAILS.find((t) => t.id === id);
    if (next) setMode(next.mode);
  }, []);

  // Stop simulating + clear the device's position when the panel unmounts so
  // we don't leave the simulator parked on the last waypoint.
  useEffect(() => () => {
    if (statusRef.current !== "idle") {
      void exec(`xcrun simctl location ${udid} clear`).catch(() => {});
    }
  }, [exec, udid]);

  // ── Render ───────────────────────────────────────────────────────────────
  const playing = playback.status === "playing";
  const headerStatus = playing
    ? `${formatDistance(playback.arc)} · ${formatDuration(playback.elapsedMs)}`
    : `${formatDistance(prepared.totalDistance)} total`;

  return (
    <div style={{ ...sectionStyle, padding: "8px 12px 12px" }}>
      <button
        type="button"
        onClick={() => setOpen((v: boolean) => !v)}
        style={toggleStyle}
        aria-expanded={open}
      >
        <span style={titleStyle}>Location</span>
        <span style={statusStyle}>
          <span
            style={{
              ...dotStyle,
              background: playing ? "#4ade80" : prepared.totalDistance > 0 ? "rgba(255,255,255,0.3)" : "transparent",
              boxShadow: playing ? "0 0 6px rgba(74,222,128,0.7)" : "none",
            }}
          />
          {headerStatus}
        </span>
        <Chevron open={open} />
      </button>

      {open && (
        <>
          <div style={pickerRowStyle}>
            <select
              value={trailId}
              onChange={(e) => onTrailChange((e.target as HTMLSelectElement).value)}
              style={selectStyle}
              aria-label="Trail"
            >
              {DEFAULT_TRAILS.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <div style={trailMetaStyle}>{trail.description}</div>
          </div>

          <div style={canvasWrapStyle}>
            <canvas ref={canvasRef} style={canvasStyle} />
            <ElevationBadges prepared={prepared} />
          </div>

          <div style={statRowStyle}>
            <Stat label="Distance" value={formatDistance(playback.arc)} />
            <Stat label="Pace" value={formatPace(speedRef.current)} />
            <Stat label="Elapsed" value={formatDuration(playback.elapsedMs)} />
          </div>

          <div style={controlsRowStyle}>
            <button
              type="button"
              onClick={onPlayPause}
              style={{
                ...primaryBtnStyle,
                background: playing ? "rgba(255,255,255,0.16)" : "#34d399",
                color: playing ? "#fff" : "#062018",
              }}
              aria-pressed={playing}
              title={playing ? "Pause" : "Play"}
            >
              {playing ? <PauseGlyph /> : <PlayGlyph />}
              <span>{playing ? "Pause" : "Play"}</span>
            </button>
            <button
              type="button"
              onClick={onStop}
              style={ghostBtnStyle}
              disabled={playback.status === "idle" && playback.arc === 0}
              title="Stop and clear simulated location"
            >
              <StopGlyph />
              <span>Stop</span>
            </button>
          </div>

          <div style={modeRowStyle}>
            <Segmented
              ariaLabel="Transport mode"
              value={mode}
              onChange={(v) => setMode(v as TrailMode)}
              options={[
                { value: "walk", label: "Walk" },
                { value: "run", label: "Run" },
                { value: "cycle", label: "Cycle" },
                { value: "drive", label: "Drive" },
              ]}
            />
            <Segmented
              ariaLabel="Speed multiplier"
              value={String(multiplier)}
              onChange={(v) => setMultiplier(Number(v) as SpeedMultiplier)}
              options={SPEED_MULTIPLIERS.map((m) => ({ value: String(m), label: `${m}×` }))}
            />
          </div>

          {error && <div style={errorStyle}>{error}</div>}
        </>
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

const Stat = memo(function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={statColStyle}>
      <div style={statLabelStyle}>{label}</div>
      <div style={statValueStyle}>{value}</div>
    </div>
  );
});

function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} style={segGroupStyle}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{
              ...segBtnStyle,
              background: active ? "rgba(255,255,255,0.12)" : "transparent",
              color: active ? "#fff" : "rgba(255,255,255,0.6)",
            }}
            aria-pressed={active}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ElevationBadges({ prepared }: { prepared: PreparedTrail }) {
  if (prepared.rawMaxAlt - prepared.rawMinAlt < 5) return null;
  return (
    <>
      <div style={{ ...badgeStyle, top: 8, left: 10 }}>
        <ArrowGlyph dir="up" /> {formatElevation(prepared.rawMaxAlt)}
      </div>
      <div style={{ ...badgeStyle, top: 8, right: 10 }}>
        <ArrowGlyph dir="down" /> {formatElevation(prepared.rawMinAlt)}
      </div>
    </>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ transition: "transform 0.15s", transform: open ? "rotate(180deg)" : "rotate(0deg)", color: "rgba(255,255,255,0.5)" }}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function PlayGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="6,4 20,12 6,20" />
    </svg>
  );
}
function PauseGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}
function StopGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </svg>
  );
}
function ArrowGlyph({ dir }: { dir: "up" | "down" }) {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"
      style={{ marginRight: 3 }}>
      {dir === "up" ? <polygon points="12,4 20,18 4,18" /> : <polygon points="4,6 20,6 12,20" />}
    </svg>
  );
}

// ─── 3D renderer ───────────────────────────────────────────────────────────

function renderScene(
  canvas: HTMLCanvasElement,
  prepared: PreparedTrail,
  currentArc: number,
  cameraAngle: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Resize to container if needed (HiDPI).
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // Background — radial vignette for that "scene viewport" feel.
  const bg = ctx.createRadialGradient(
    cssW * 0.5, cssH * 0.55, Math.min(cssW, cssH) * 0.2,
    cssW * 0.5, cssH * 0.55, Math.max(cssW, cssH) * 0.85,
  );
  bg.addColorStop(0, "#1a1a1d");
  bg.addColorStop(1, "#0a0a0c");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, cssW, cssH);

  const { points, bounds } = prepared;
  if (points.length < 2) return;

  // Camera: orbit around y-axis, fixed 30° down-tilt, orthographic.
  const tiltRad = (28 * Math.PI) / 180;
  const sinT = Math.sin(tiltRad);
  const cosT = Math.cos(tiltRad);
  const sinA = Math.sin(cameraAngle);
  const cosA = Math.cos(cameraAngle);

  const cx = (bounds.x[0] + bounds.x[1]) / 2;
  const cz = (bounds.z[0] + bounds.z[1]) / 2;

  // Find orthographic scale that fits the rotated bbox in the canvas. We use
  // the diagonal of (xExtent, zExtent) since the rotation can swing both
  // dimensions to either screen axis.
  const xExtent = bounds.x[1] - bounds.x[0];
  const zExtent = bounds.z[1] - bounds.z[0];
  const yExtent = bounds.y[1] - bounds.y[0];
  // Vertical extent on screen: tilted route plane (cosT * zExtent) plus
  // elevation projected through sinT.
  const fitW = Math.max(xExtent, zExtent) * 1.05;
  const fitH = Math.max(zExtent * cosT + yExtent * sinT, xExtent * 0.4) * 1.15;
  const padX = cssW * 0.08;
  const padY = cssH * 0.18; // extra room at top for elevation badges
  const scale = Math.min(
    (cssW - padX * 2) / fitW,
    (cssH - padY * 2) / fitH,
  );

  // Vertical exaggeration — real ridges look pancake-flat in plain ortho.
  // Cap at 12× and scale down on big xy extents so flat trails stay flat.
  const elevationGain = yExtent < 1
    ? 1
    : Math.min(12, 60 / Math.max(20, yExtent));

  const project = (x: number, y: number, z: number) => {
    const px = (x - cx);
    const pz = (z - cz);
    // Rotate around y axis.
    const rx = px * cosA + pz * sinA;
    const rz = -px * sinA + pz * cosA;
    // Tilt around x axis (rotate (rz, y) plane).
    const ty = y * elevationGain;
    const sy = ty * cosT - rz * sinT;
    const sz = ty * sinT + rz * cosT;
    return {
      sx: cssW / 2 + rx * scale,
      sy: cssH * 0.55 - sy * scale,
      depth: sz,
    };
  };

  // Draw a faint ground reference: rectangular footprint (xz projected) under
  // the trail. Provides spatial anchoring without a full grid.
  drawGroundFootprint(ctx, project, bounds);

  // Project all dense points once.
  const projected = points.map((p) => {
    const top = project(p.x, p.y, p.z);
    const bot = project(p.x, 0, p.z);
    return { p, top, bot };
  });

  // Draw the extruded ribbon: per-segment quad with a vertical gradient that
  // fades from the lit top edge into transparent ground.
  for (let i = 1; i < projected.length; i++) {
    const a = projected[i - 1]!;
    const b = projected[i]!;
    const grad = ctx.createLinearGradient(
      (a.top.sx + b.top.sx) / 2,
      (a.top.sy + b.top.sy) / 2,
      (a.bot.sx + b.bot.sx) / 2,
      (a.bot.sy + b.bot.sy) / 2,
    );
    grad.addColorStop(0, "rgba(255,255,255,0.32)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(a.top.sx, a.top.sy);
    ctx.lineTo(b.top.sx, b.top.sy);
    ctx.lineTo(b.bot.sx, b.bot.sy);
    ctx.lineTo(a.bot.sx, a.bot.sy);
    ctx.closePath();
    ctx.fill();
  }

  // Ground-projected shadow line — a thin softer stroke that shows the route
  // footprint regardless of elevation.
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < projected.length; i++) {
    const { bot } = projected[i]!;
    if (i === 0) ctx.moveTo(bot.sx, bot.sy);
    else ctx.lineTo(bot.sx, bot.sy);
  }
  ctx.stroke();

  // Top edge — bright crisp line that reads as the elevation profile.
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i < projected.length; i++) {
    const { top } = projected[i]!;
    if (i === 0) ctx.moveTo(top.sx, top.sy);
    else ctx.lineTo(top.sx, top.sy);
  }
  ctx.stroke();

  // Travelled portion — thicker, slightly warmer overlay up to currentArc.
  const cutoff = currentArc;
  ctx.strokeStyle = "#f9d2a4";
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < projected.length; i++) {
    const { p, top } = projected[i]!;
    if (p.arc > cutoff) break;
    if (!started) { ctx.moveTo(top.sx, top.sy); started = true; }
    else ctx.lineTo(top.sx, top.sy);
  }
  if (started) ctx.stroke();

  // Character marker — glow + dot at the interpolated current position.
  const cur = pointAtDistance(prepared, currentArc);
  const m = project(cur.x, cur.y, cur.z);
  const mGround = project(cur.x, 0, cur.z);
  // Stem from ground to top so the character "stands" on the trail.
  ctx.strokeStyle = "rgba(249,210,164,0.45)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mGround.sx, mGround.sy);
  ctx.lineTo(m.sx, m.sy);
  ctx.stroke();
  // Glow
  const glow = ctx.createRadialGradient(m.sx, m.sy, 0, m.sx, m.sy, 16);
  glow.addColorStop(0, "rgba(255,255,255,0.55)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(m.sx, m.sy, 16, 0, Math.PI * 2);
  ctx.fill();
  // Body
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(m.sx, m.sy, 3.8, 0, Math.PI * 2);
  ctx.fill();
}

function drawGroundFootprint(
  ctx: CanvasRenderingContext2D,
  project: (x: number, y: number, z: number) => { sx: number; sy: number; depth: number },
  bounds: PreparedTrail["bounds"],
) {
  // Pad the footprint slightly larger than the route so the ribbon looks
  // like it's resting on a platform.
  const padX = Math.max(20, (bounds.x[1] - bounds.x[0]) * 0.15);
  const padZ = Math.max(20, (bounds.z[1] - bounds.z[0]) * 0.15);
  const x0 = bounds.x[0] - padX;
  const x1 = bounds.x[1] + padX;
  const z0 = bounds.z[0] - padZ;
  const z1 = bounds.z[1] + padZ;
  const corners = [
    project(x0, 0, z0),
    project(x1, 0, z0),
    project(x1, 0, z1),
    project(x0, 0, z1),
  ];
  ctx.fillStyle = "rgba(255,255,255,0.025)";
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(corners[0]!.sx, corners[0]!.sy);
  for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i]!.sx, corners[i]!.sy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

// ─── Formatting ────────────────────────────────────────────────────────────

function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters.toFixed(0)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatPace(speedMs: number): string {
  if (speedMs <= 0) return "—";
  // Drive speeds: km/h. Walking/running: minutes per km.
  if (speedMs > 7) return `${(speedMs * 3.6).toFixed(0)} km/h`;
  const secPerKm = 1000 / speedMs;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${s.toString().padStart(2, "0")}/km`;
}

function formatElevation(meters: number): string {
  return `${meters.toFixed(0)} m`;
}

function parseSimctlError(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  // Strip the leading "An error was encountered processing the command" noise.
  const m = trimmed.match(/Reason:\s*(.+)$/m);
  if (m) return m[1]!;
  return trimmed.split("\n").slice(-1)[0] ?? trimmed;
}

// ─── Styles ────────────────────────────────────────────────────────────────

const sectionStyle: CSSProperties = {
  background: "#1c1c1e",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 10,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const toggleStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr auto",
  alignItems: "center",
  gap: 8,
  background: "transparent",
  border: "none",
  color: "#eee",
  padding: 0,
  margin: 0,
  cursor: "pointer",
  width: "100%",
  textAlign: "left",
};

const titleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "rgba(255,255,255,0.5)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const statusStyle: CSSProperties = {
  fontSize: 11,
  color: "rgba(255,255,255,0.55)",
  fontFamily: "ui-monospace, monospace",
  display: "flex",
  alignItems: "center",
  gap: 6,
  justifySelf: "end",
};

const dotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  transition: "background 0.2s, box-shadow 0.2s",
};

const pickerRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const selectStyle: CSSProperties = {
  appearance: "none",
  WebkitAppearance: "none",
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 6,
  color: "#eee",
  fontSize: 12,
  padding: "6px 8px",
  fontFamily: "inherit",
  cursor: "pointer",
};

const trailMetaStyle: CSSProperties = {
  fontSize: 10,
  color: "rgba(255,255,255,0.45)",
};

const canvasWrapStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  aspectRatio: "16 / 11",
  borderRadius: 10,
  overflow: "hidden",
  background: "#0a0a0c",
  border: "1px solid rgba(255,255,255,0.06)",
};

const canvasStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "block",
};

const badgeStyle: CSSProperties = {
  position: "absolute",
  background: "rgba(20,20,22,0.65)",
  color: "rgba(255,255,255,0.85)",
  fontSize: 10,
  fontFamily: "ui-monospace, monospace",
  padding: "2px 6px",
  borderRadius: 5,
  display: "flex",
  alignItems: "center",
  letterSpacing: "0.02em",
  border: "1px solid rgba(255,255,255,0.06)",
};

const statRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: 6,
};

const statColStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 6,
  padding: "5px 7px",
  minWidth: 0,
};

const statLabelStyle: CSSProperties = {
  fontSize: 9,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "rgba(255,255,255,0.45)",
};

const statValueStyle: CSSProperties = {
  fontSize: 12,
  fontFamily: "ui-monospace, monospace",
  color: "#fff",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const controlsRowStyle: CSSProperties = {
  display: "flex",
  gap: 6,
};

const primaryBtnStyle: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: "8px 10px",
  border: "none",
  borderRadius: 7,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
};

const ghostBtnStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: "8px 12px",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 7,
  fontSize: 12,
  fontWeight: 500,
  background: "transparent",
  color: "rgba(255,255,255,0.85)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const modeRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const segGroupStyle: CSSProperties = {
  display: "flex",
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 7,
  padding: 2,
  gap: 2,
};

const segBtnStyle: CSSProperties = {
  flex: 1,
  border: "none",
  borderRadius: 5,
  padding: "5px 8px",
  fontSize: 11,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
  transition: "background 0.12s, color 0.12s",
};

const errorStyle: CSSProperties = {
  background: "rgba(248,113,113,0.08)",
  border: "1px solid rgba(248,113,113,0.2)",
  color: "#fca5a5",
  fontSize: 11,
  padding: "6px 8px",
  borderRadius: 6,
};

