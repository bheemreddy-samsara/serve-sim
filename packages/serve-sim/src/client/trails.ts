// Default trails for the location emulation panel + the math used to drive
// the 3D viz and the per-frame simctl location updates.
//
// Coordinates are real-world WGS-84 lat/lng; elevation is meters above sea
// level. We pre-densify each route with Catmull-Rom interpolation so both
// the renderer and the animator share a single arc-length-parameterised
// point list, which makes "advance N meters per frame" a trivial lookup.

export type TrailMode = "walk" | "run" | "cycle" | "drive";

export interface Waypoint {
  lat: number;
  lng: number;
  /** Altitude in meters. Optional; defaults to 0. */
  alt?: number;
}

export interface Trail {
  id: string;
  name: string;
  /** Short human-readable hint shown beneath the trail name. */
  description: string;
  /** Default transport mode the trail was authored for. */
  mode: TrailMode;
  waypoints: Waypoint[];
  /** True when the route returns to its starting point — animation loops. */
  loop?: boolean;
}

export interface RoutePoint {
  /** East offset from origin, meters. */
  x: number;
  /** Down (south is +z) offset from origin, meters. */
  z: number;
  /** Altitude in meters, relative to per-trail minimum (always >= 0). */
  y: number;
  /** Cumulative arc length along the route, meters (3D distance). */
  arc: number;
  /** Original geographic lat/lng — fed to `simctl location set`. */
  lat: number;
  lng: number;
}

export interface PreparedTrail {
  trail: Trail;
  origin: { lat: number; lng: number };
  points: RoutePoint[];
  totalDistance: number;
  /** AABB of the densified route, used to fit the camera. */
  bounds: { x: [number, number]; z: [number, number]; y: [number, number] };
  /** Min/max raw altitude in meters; for elevation labels. */
  rawMinAlt: number;
  rawMaxAlt: number;
}

const EARTH_RADIUS_M = 6_371_000;

/** Equirectangular projection of (lat,lng) to local meters around an origin. */
export function projectLatLng(
  lat: number,
  lng: number,
  origin: { lat: number; lng: number },
): { x: number; z: number } {
  const latRad = (origin.lat * Math.PI) / 180;
  const dLat = ((lat - origin.lat) * Math.PI) / 180;
  const dLng = ((lng - origin.lng) * Math.PI) / 180;
  return {
    x: dLng * Math.cos(latRad) * EARTH_RADIUS_M,
    z: -dLat * EARTH_RADIUS_M,
  };
}

/** Inverse of `projectLatLng` — local meters back to geographic. */
export function unprojectMeters(
  x: number,
  z: number,
  origin: { lat: number; lng: number },
): { lat: number; lng: number } {
  const latRad = (origin.lat * Math.PI) / 180;
  const dLat = (-z / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = (x / (EARTH_RADIUS_M * Math.cos(latRad))) * (180 / Math.PI);
  return { lat: origin.lat + dLat, lng: origin.lng + dLng };
}

interface RawPoint { x: number; z: number; y: number; rawAlt: number }

/** Centripetal Catmull-Rom interpolation between p1 and p2 using p0/p3 as
 *  tangent neighbours. Returns the position at parameter t in [0,1]. */
function catmullRom(
  p0: RawPoint, p1: RawPoint, p2: RawPoint, p3: RawPoint,
  t: number,
): RawPoint {
  const t2 = t * t;
  const t3 = t2 * t;
  const a = (v0: number, v1: number, v2: number, v3: number) =>
    0.5 * (
      (2 * v1) +
      (-v0 + v2) * t +
      (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2 +
      (-v0 + 3 * v1 - 3 * v2 + v3) * t3
    );
  return {
    x: a(p0.x, p1.x, p2.x, p3.x),
    z: a(p0.z, p1.z, p2.z, p3.z),
    y: a(p0.y, p1.y, p2.y, p3.y),
    rawAlt: a(p0.rawAlt, p1.rawAlt, p2.rawAlt, p3.rawAlt),
  };
}

/** Resample a polyline at fixed segment length `step` (meters), smoothing
 *  with Catmull-Rom. Returns the densified raw points. */
function densify(
  raw: RawPoint[],
  step: number,
  closed: boolean,
): RawPoint[] {
  if (raw.length < 2) return raw.slice();

  const out: RawPoint[] = [];
  const n = raw.length;
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const p0 = raw[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!;
    const p1 = raw[i % n]!;
    const p2 = raw[(i + 1) % n]!;
    const p3 = raw[closed ? (i + 2) % n : Math.min(n - 1, i + 2)]!;
    const dx = p2.x - p1.x;
    const dz = p2.z - p1.z;
    const segLen = Math.hypot(dx, dz);
    const subdivisions = Math.max(2, Math.ceil(segLen / step));
    for (let s = 0; s < subdivisions; s++) {
      const t = s / subdivisions;
      out.push(catmullRom(p0, p1, p2, p3, t));
    }
  }
  if (!closed) out.push(raw[n - 1]!);
  return out;
}

export function prepareTrail(trail: Trail): PreparedTrail {
  if (trail.waypoints.length < 2) {
    throw new Error(`Trail ${trail.id} needs at least 2 waypoints`);
  }

  // Origin = arithmetic mean of waypoints. Equirectangular distortion is
  // negligible at the scales we care about (< few km).
  const origin = {
    lat: trail.waypoints.reduce((s, w) => s + w.lat, 0) / trail.waypoints.length,
    lng: trail.waypoints.reduce((s, w) => s + w.lng, 0) / trail.waypoints.length,
  };

  const rawAlts = trail.waypoints.map((w) => w.alt ?? 0);
  const rawMinAlt = Math.min(...rawAlts);
  const rawMaxAlt = Math.max(...rawAlts);

  const raw: RawPoint[] = trail.waypoints.map((w) => {
    const { x, z } = projectLatLng(w.lat, w.lng, origin);
    const rawAlt = w.alt ?? 0;
    return { x, z, y: rawAlt - rawMinAlt, rawAlt };
  });

  const dense = densify(raw, 8, !!trail.loop);

  // Build arc-length parameterised RoutePoints.
  const points: RoutePoint[] = [];
  let arc = 0;
  for (let i = 0; i < dense.length; i++) {
    const cur = dense[i]!;
    if (i > 0) {
      const prev = dense[i - 1]!;
      arc += Math.hypot(cur.x - prev.x, cur.z - prev.z, cur.y - prev.y);
    }
    const { lat, lng } = unprojectMeters(cur.x, cur.z, origin);
    points.push({ x: cur.x, z: cur.z, y: cur.y, arc, lat, lng });
  }

  // AABB
  let xmin = Infinity, xmax = -Infinity;
  let zmin = Infinity, zmax = -Infinity;
  let ymin = Infinity, ymax = -Infinity;
  for (const p of points) {
    if (p.x < xmin) xmin = p.x;
    if (p.x > xmax) xmax = p.x;
    if (p.z < zmin) zmin = p.z;
    if (p.z > zmax) zmax = p.z;
    if (p.y < ymin) ymin = p.y;
    if (p.y > ymax) ymax = p.y;
  }

  return {
    trail,
    origin,
    points,
    totalDistance: points[points.length - 1]!.arc,
    bounds: { x: [xmin, xmax], y: [ymin, ymax], z: [zmin, zmax] },
    rawMinAlt,
    rawMaxAlt,
  };
}

/** Lookup the route point at a given arc-length offset (meters), interpolating
 *  between the two flanking dense points. Wraps around for `loop` trails. */
export function pointAtDistance(p: PreparedTrail, distance: number): RoutePoint {
  const total = p.totalDistance;
  if (total === 0) return p.points[0]!;
  let d = distance;
  if (p.trail.loop) {
    d = ((d % total) + total) % total;
  } else {
    if (d <= 0) return p.points[0]!;
    if (d >= total) return p.points[p.points.length - 1]!;
  }

  // Binary search for the segment containing `d`.
  let lo = 0;
  let hi = p.points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (p.points[mid]!.arc <= d) lo = mid; else hi = mid;
  }
  const a = p.points[lo]!;
  const b = p.points[hi]!;
  const span = b.arc - a.arc;
  const t = span === 0 ? 0 : (d - a.arc) / span;
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    y: a.y + (b.y - a.y) * t,
    arc: d,
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
}

/** Default speed in meters / second for a transport mode. */
export function defaultSpeed(mode: TrailMode): number {
  switch (mode) {
    case "walk": return 1.4;
    case "run": return 3.0;
    case "cycle": return 5.5;
    case "drive": return 13.4;
  }
}

export function modeLabel(mode: TrailMode): string {
  switch (mode) {
    case "walk": return "Walk";
    case "run": return "Run";
    case "cycle": return "Cycle";
    case "drive": return "Drive";
  }
}

// ─── Default trails ───────────────────────────────────────────────────────
//
// Hand-authored to look good in 3D — they're not literal GPS recordings.
// Each is centered on a real place so the lat/lng feeding `simctl location
// set` lands in a sensible spot for apps that geocode (Maps, Weather, ...).

/** Apple Park ring road — gentle near-circular loop. */
const APPLE_PARK_LOOP: Waypoint[] = [
  { lat: 37.33530, lng: -122.00940, alt: 70 },
  { lat: 37.33620, lng: -122.00750, alt: 71 },
  { lat: 37.33680, lng: -122.00510, alt: 73 },
  { lat: 37.33640, lng: -122.00280, alt: 75 },
  { lat: 37.33470, lng: -122.00150, alt: 76 },
  { lat: 37.33260, lng: -122.00150, alt: 75 },
  { lat: 37.33090, lng: -122.00280, alt: 73 },
  { lat: 37.33050, lng: -122.00510, alt: 71 },
  { lat: 37.33110, lng: -122.00750, alt: 70 },
  { lat: 37.33260, lng: -122.00910, alt: 70 },
];

/** Golden Gate Bridge crossing — long mostly-straight span. */
const GOLDEN_GATE_BRIDGE: Waypoint[] = [
  { lat: 37.80730, lng: -122.47540, alt: 30 },
  { lat: 37.80870, lng: -122.47545, alt: 50 },
  { lat: 37.81020, lng: -122.47550, alt: 67 },
  { lat: 37.81360, lng: -122.47558, alt: 75 },
  { lat: 37.81700, lng: -122.47568, alt: 75 },
  { lat: 37.82040, lng: -122.47578, alt: 70 },
  { lat: 37.82380, lng: -122.47588, alt: 50 },
  { lat: 37.82570, lng: -122.47600, alt: 35 },
];

/** Mt. Tam fire road — climbs a ridge with a peak in the middle. */
const TAM_RIDGE_HIKE: Waypoint[] = [
  { lat: 37.92330, lng: -122.59750, alt: 240 },
  { lat: 37.92410, lng: -122.59600, alt: 320 },
  { lat: 37.92520, lng: -122.59470, alt: 410 },
  { lat: 37.92620, lng: -122.59310, alt: 530 },
  { lat: 37.92740, lng: -122.59180, alt: 640 },
  { lat: 37.92880, lng: -122.59060, alt: 720 },
  { lat: 37.93040, lng: -122.58980, alt: 785 },
  { lat: 37.93200, lng: -122.58910, alt: 800 },
  { lat: 37.93360, lng: -122.58840, alt: 770 },
  { lat: 37.93500, lng: -122.58760, alt: 700 },
  { lat: 37.93620, lng: -122.58660, alt: 620 },
  { lat: 37.93720, lng: -122.58520, alt: 510 },
  { lat: 37.93790, lng: -122.58370, alt: 400 },
];

/** Central Park reservoir loop. */
const CENTRAL_PARK_RESERVOIR: Waypoint[] = [
  { lat: 40.78580, lng: -73.96320, alt: 18 },
  { lat: 40.78700, lng: -73.96250, alt: 19 },
  { lat: 40.78820, lng: -73.96200, alt: 19 },
  { lat: 40.78940, lng: -73.96190, alt: 20 },
  { lat: 40.79050, lng: -73.96270, alt: 20 },
  { lat: 40.79100, lng: -73.96400, alt: 19 },
  { lat: 40.79090, lng: -73.96560, alt: 18 },
  { lat: 40.79020, lng: -73.96690, alt: 17 },
  { lat: 40.78900, lng: -73.96790, alt: 16 },
  { lat: 40.78760, lng: -73.96820, alt: 16 },
  { lat: 40.78630, lng: -73.96780, alt: 16 },
  { lat: 40.78540, lng: -73.96680, alt: 17 },
  { lat: 40.78510, lng: -73.96540, alt: 17 },
  { lat: 40.78530, lng: -73.96400, alt: 18 },
];

/** Pacific Coast Highway — sweeping coastal drive south of San Francisco. */
const PCH_PACIFICA: Waypoint[] = [
  { lat: 37.59500, lng: -122.50100, alt: 6 },
  { lat: 37.59100, lng: -122.50320, alt: 18 },
  { lat: 37.58730, lng: -122.50480, alt: 32 },
  { lat: 37.58320, lng: -122.50580, alt: 48 },
  { lat: 37.57890, lng: -122.50620, alt: 65 },
  { lat: 37.57450, lng: -122.50580, alt: 78 },
  { lat: 37.57020, lng: -122.50450, alt: 86 },
  { lat: 37.56610, lng: -122.50250, alt: 90 },
  { lat: 37.56210, lng: -122.50000, alt: 84 },
  { lat: 37.55840, lng: -122.49710, alt: 70 },
  { lat: 37.55510, lng: -122.49380, alt: 52 },
  { lat: 37.55230, lng: -122.49000, alt: 33 },
];

export const DEFAULT_TRAILS: Trail[] = [
  {
    id: "apple-park-loop",
    name: "Apple Park Loop",
    description: "Cupertino • flat ring road",
    mode: "walk",
    waypoints: APPLE_PARK_LOOP,
    loop: true,
  },
  {
    id: "golden-gate",
    name: "Golden Gate Crossing",
    description: "San Francisco • bridge span",
    mode: "run",
    waypoints: GOLDEN_GATE_BRIDGE,
  },
  {
    id: "tam-ridge",
    name: "Mt. Tam Ridge",
    description: "Marin • 240→800m climb",
    mode: "walk",
    waypoints: TAM_RIDGE_HIKE,
  },
  {
    id: "central-park",
    name: "Reservoir Loop",
    description: "Central Park • 2.5 km",
    mode: "run",
    waypoints: CENTRAL_PARK_RESERVOIR,
    loop: true,
  },
  {
    id: "pch-pacifica",
    name: "Pacific Coast Hwy",
    description: "Pacifica • coastal drive",
    mode: "drive",
    waypoints: PCH_PACIFICA,
  },
];
