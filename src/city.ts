import * as THREE from 'three';
import type RAPIER_API from '@dimforge/rapier3d-compat';
import { G_ALL, G_BUILDING, G_GROUND, groups } from './tuning';
import { addEdgeLines } from './carModel';
import DATA from './assets/midtown.json';

// Real midtown Manhattan from OpenStreetMap (scripts/bake-osm.mjs, v2):
// - buildings: true footprints + heights, extruded
// - roads: TRUE polyline geometry (Broadway's diagonal, FDR, West Side Highway)
//   as a graph of edges split at real intersection nodes — rendered as wet
//   asphalt ribbons and drivable by the traffic AI.

export interface RoadEdge {
  pts: [number, number][];
  a: number;
  b: number;
  w: number;
  cls: string;
  ow: number;
  major: number;
  name?: string;
}

export const EDGES: RoadEdge[] = DATA.edges as RoadEdge[];
export const NODES: [number, number][] = DATA.nodes as [number, number][];
export const NODE_DEGREE: number[] = DATA.degree as number[];

// per-edge cumulative segment lengths + total, for param-by-meters travel
export const EDGE_CUM: number[][] = [];
export const EDGE_LEN: number[] = [];
// node -> incident edge indices
export const NODE_EDGES: number[][] = NODES.map(() => []);
for (let i = 0; i < EDGES.length; i++) {
  const e = EDGES[i];
  const cum = [0];
  for (let k = 1; k < e.pts.length; k++) {
    cum.push(cum[k - 1] + Math.hypot(e.pts[k][0] - e.pts[k - 1][0], e.pts[k][1] - e.pts[k - 1][1]));
  }
  EDGE_CUM.push(cum);
  EDGE_LEN.push(cum[cum.length - 1]);
  NODE_EDGES[e.a].push(i);
  NODE_EDGES[e.b].push(i);
}

const EXT = DATA.extent;
export const MAP_EDGE =
  Math.max(Math.abs(EXT.minX), EXT.maxX, Math.abs(EXT.minZ), EXT.maxZ) + 60;
export const WARN_START = MAP_EDGE - 90;
export const FOG = { color: 0x160710, density: 0.00075 };

/** playable rectangle (23rd–40th, river to river); the mirror perimeter */
export const BORDER = {
  minX: EXT.minX - 40,
  maxX: EXT.maxX + 40,
  minZ: EXT.minZ - 40,
  maxZ: EXT.maxZ + 40,
};

/** river surface height: above the (flat) driving plane, so crossing the
 *  seawall visually puts the car UNDER the water */
export const WATER_Y = 2.1;

export interface TunnelPortal {
  name: string;
  pos: THREE.Vector3;
  exitYaw: number;
}

/** tunnel mouths located from real OSM edge names (crosstown warp points) */
export function findTunnelPortals(): TunnelPortal[] {
  const out: TunnelPortal[] = [];
  const locate = (re: RegExp, name: string) => {
    let best: [number, number] | null = null;
    for (const e of EDGES) {
      if (!e.name || !re.test(e.name)) continue;
      // the point closest to the city's center axis = the inland mouth
      for (const p of e.pts) if (!best || Math.abs(p[0]) < Math.abs(best[0])) best = p;
    }
    if (best) {
      out.push({
        name,
        pos: new THREE.Vector3(best[0], 0, best[1]),
        exitYaw: best[0] < 0 ? Math.PI / 2 : -Math.PI / 2, // exit facing downtown core
      });
    }
  };
  locate(/Lincoln Tunnel/i, 'LINCOLN TUNNEL');
  locate(/^Tunnel (Approach|Exit) Street$/i, 'QUEENS–MIDTOWN TUNNEL');
  return out;
}

/** bake provenance (shown in the attract screen) */
export const META: { baked: string; source: string } = DATA.meta;

/** real elevation grid (game-space, meters) + bilinear sampler */
export const HGRID: { n: number; half: number; data: number[] } = DATA.hgrid;
export function elevationAt(x: number, z: number): number {
  const { n, half, data } = HGRID;
  const fx = THREE.MathUtils.clamp(((x + half) / (2 * half)) * (n - 1), 0, n - 1.001);
  const fz = THREE.MathUtils.clamp(((z + half) / (2 * half)) * (n - 1), 0, n - 1.001);
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const tx = fx - x0, tz = fz - z0;
  const h00 = data[z0 * n + x0];
  const h10 = data[z0 * n + Math.min(n - 1, x0 + 1)];
  const h01 = data[Math.min(n - 1, z0 + 1) * n + x0];
  const h11 = data[Math.min(n - 1, z0 + 1) * n + Math.min(n - 1, x0 + 1)];
  return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
}

/** point at s meters along an edge (in pts order) */
export function edgePoint(ei: number, s: number, out: THREE.Vector3): THREE.Vector3 {
  const e = EDGES[ei];
  const cum = EDGE_CUM[ei];
  const len = EDGE_LEN[ei];
  const t = Math.max(0, Math.min(len, s));
  let k = 1;
  while (k < cum.length - 1 && cum[k] < t) k++;
  const segLen = cum[k] - cum[k - 1] || 1;
  const f = (t - cum[k - 1]) / segLen;
  const p0 = e.pts[k - 1];
  const p1 = e.pts[k];
  return out.set(p0[0] + (p1[0] - p0[0]) * f, 0, p0[1] + (p1[1] - p0[1]) * f);
}

/** unit direction at s meters along an edge (in pts order) */
export function edgeDir(ei: number, s: number, out: THREE.Vector3): THREE.Vector3 {
  const e = EDGES[ei];
  const cum = EDGE_CUM[ei];
  let k = 1;
  while (k < cum.length - 1 && cum[k] < s) k++;
  const p0 = e.pts[k - 1];
  const p1 = e.pts[k];
  out.set(p1[0] - p0[0], 0, p1[1] - p0[1]);
  return out.lengthSq() > 0 ? out.normalize() : out.set(0, 0, 1);
}

/** closest point on the road network (brute force; fine for occasional calls) */
export function nearestEdgePoint(
  pos: THREE.Vector3
): { edge: number; s: number; point: THREE.Vector3; dir: THREE.Vector3; distSq: number } {
  let best = { edge: 0, s: 0, distSq: Infinity };
  for (let i = 0; i < EDGES.length; i++) {
    const e = EDGES[i];
    for (let k = 1; k < e.pts.length; k++) {
      const ax = e.pts[k - 1][0], az = e.pts[k - 1][1];
      const bx = e.pts[k][0], bz = e.pts[k][1];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz || 1;
      let t = ((pos.x - ax) * dx + (pos.z - az) * dz) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + dx * t, pz = az + dz * t;
      const d2 = (pos.x - px) ** 2 + (pos.z - pz) ** 2;
      if (d2 < best.distSq) best = { edge: i, s: EDGE_CUM[i][k - 1] + Math.sqrt(l2) * t, distSq: d2 };
    }
  }
  const point = edgePoint(best.edge, best.s, new THREE.Vector3());
  const dir = edgeDir(best.edge, best.s, new THREE.Vector3());
  return { ...best, point, dir };
}

// spawn arriving through the Lincoln Tunnel gate (7th Avenue as fallback)
function pickSpawn(): { pos: THREE.Vector3; yaw: number } {
  const portals = findTunnelPortals();
  const lincoln = portals.find((p) => /LINCOLN/.test(p.name)) ?? portals[0];
  if (lincoln) {
    const dir = new THREE.Vector3(Math.sin(lincoln.exitYaw), 0, Math.cos(lincoln.exitYaw));
    // aim ~30m out of the gate, then snap to the nearest real road so the
    // spawn is guaranteed on-street (the raw offset can land inside a block)
    const target = lincoln.pos.clone().addScaledVector(dir, 30);
    const road = nearestEdgePoint(target);
    const away = road.point.clone().sub(lincoln.pos);
    if (road.dir.dot(away) < 0) road.dir.multiplyScalar(-1); // face away from the gate
    return { pos: road.point, yaw: Math.atan2(road.dir.x, road.dir.z) };
  }
  let ei = EDGES.findIndex((e) => e.name === '7th Avenue' && EDGE_LEN[EDGES.indexOf(e)] > 80);
  if (ei < 0) {
    let bestLen = 0;
    EDGES.forEach((e, i) => {
      if (e.major && EDGE_LEN[i] > bestLen) { bestLen = EDGE_LEN[i]; ei = i; }
    });
  }
  const pos = edgePoint(ei, EDGE_LEN[ei] / 2, new THREE.Vector3());
  const dir = edgeDir(ei, EDGE_LEN[ei] / 2, new THREE.Vector3());
  return { pos, yaw: Math.atan2(dir.x, dir.z) };
}
const spawnInfo = pickSpawn();
export const SPAWN = spawnInfo.pos;
export const SPAWN_YAW = spawnInfo.yaw;

// traffic signal phasing (shared with traffic AI); axis = dominant travel dir
const CYCLE = 22;
export function nsGreen(t: number) {
  return (t % CYCLE) < 9.5;
}
export function ewGreen(t: number) {
  const m = t % CYCLE;
  return m >= 11 && m < 20.5;
}
export function hasSignal(node: number) {
  return NODE_DEGREE[node] >= 3;
}

const BUILDING_VERT = /* glsl */ `
attribute float aSeed;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vSeed;
varying float vDist;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normal;
  vSeed = aSeed;
  vec4 mv = viewMatrix * wp;
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const BUILDING_FRAG = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vSeed;
varying float vDist;
uniform float uLightning;
uniform vec3 uFogColor;
uniform float uFogDensity;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec3 n = normalize(vNormal);
  float up = max(n.y, 0.0);
  // hidden-line style: fills stay near-black so wireframe edges + windows read
  vec3 col = vec3(0.010, 0.011, 0.020) * (0.55 + 1.1 * up);
  float rim = pow(max(dot(n, normalize(vec3(-0.4, 0.2, -1.0))), 0.0), 2.0);
  col += vec3(0.30, 0.07, 0.09) * rim * 0.10;

  if (abs(n.y) < 0.4) {
    float u = dot(vWorldPos.xz, vec2(-n.z, n.x));
    float v = vWorldPos.y;
    vec2 cell = vec2(floor(u / 2.4), floor(v / 3.1));
    vec2 f = vec2(fract(u / 2.4), fract(v / 3.1));
    float inWin = step(0.18, f.x) * step(f.x, 0.82) * step(0.28, f.y) * step(f.y, 0.78);
    float h1 = hash(cell + vSeed * 17.0);
    float lit = step(h1, 0.072); // ~30% of the previous window density
    vec3 winCol = mix(vec3(1.0, 0.70, 0.40), vec3(0.55, 0.75, 1.0),
                      step(0.78, hash(cell * 1.7 + vSeed)));
    col += inWin * lit * winCol * (0.35 + 0.65 * hash(cell * 3.1 + vSeed)) * 0.85;
    if (v < 4.5 && v > 0.3) {
      float sf = hash(vec2(floor(u / 9.0), vSeed * 31.0));
      vec3 sfCol = mix(vec3(1.0, 0.42, 0.65), vec3(0.35, 0.95, 0.85), step(0.5, sf));
      col += step(sf, 0.6) * sfCol * 0.6 * smoothstep(4.5, 2.0, v);
    }
  }

  col += (col + vec3(0.30, 0.34, 0.48) * (0.4 + 0.6 * up)) * uLightning * 0.9;

  float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vDist * vDist);
  col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}
`;

function rand(a: number, b: number) {
  return a + Math.random() * (b - a);
}

/** monotone-chain 2D convex hull; physics + debug outline share this shape */
function convexHull2D(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length <= 3) return p;
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function makeGlowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,210,150,0.85)');
  g.addColorStop(0.4, 'rgba(255,190,120,0.25)');
  g.addColorStop(1, 'rgba(255,180,100,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function makeSkylineTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, c.width, c.height);
  let x = 0;
  while (x < c.width) {
    const w = 14 + Math.random() * 40;
    const h = 30 + Math.pow(Math.random(), 1.8) * 170;
    ctx.fillStyle = 'rgba(16,8,16,0.96)';
    ctx.fillRect(x, c.height - h, w, h);
    ctx.fillStyle = 'rgba(255,190,120,0.75)';
    for (let wy = c.height - h + 4; wy < c.height - 4; wy += 6) {
      for (let wx = x + 3; wx < x + w - 3; wx += 5) {
        if (Math.random() < 0.16) ctx.fillRect(wx, wy, 1.6, 2.2);
      }
    }
    x += w + rand(2, 18);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.x = 3;
  return t;
}

const NEON_WORDS = [
  'NIGHT RUN', 'LIVE', 'HOTEL', 'RAMEN', '24 HR', 'CLUB VOLT', 'PIZZA',
  'BODEGA', 'KARAOKE', 'ARCADE', 'DINER', 'THEATRE', 'JAZZ', 'TATTOO',
];
const NEON_COLORS = ['#ff2d78', '#2dffb8', '#31c8ff', '#ffe14d', '#c86bff', '#ff7a2d'];

function makeNeonTexture(word: string, color: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 192;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.strokeRect(10, 10, c.width - 20, c.height - 20);
  ctx.font = `900 ${word.length > 7 ? 74 : 96}px "Arial Black", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = 26;
  ctx.fillStyle = color;
  ctx.fillText(word, c.width / 2, c.height / 2);
  ctx.fillText(word, c.width / 2, c.height / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface BuildingBox {
  minX: number; maxX: number; minZ: number; maxZ: number; h: number;
}

export class City {
  /** real junction positions (degree >= 3), for checkpoints etc. */
  intersections: THREE.Vector3[] = [];
  buildingUniforms: {
    uLightning: { value: number };
    uFogColor: { value: THREE.Color };
    uFogDensity: { value: number };
  };
  private groundUniforms!: {
    uLightning: { value: number };
    uFogColor: { value: THREE.Color };
    uFogDensity: { value: number };
    uHeight: { value: THREE.DataTexture };
    uHMin: { value: number };
    uHRange: { value: number };
    uHHalf: { value: number };
  };
  private roadMat: THREE.MeshStandardMaterial;
  private waterUniforms!: {
    uTime: { value: number };
    uLightning: { value: number };
    uHeight: { value: THREE.DataTexture };
    uHMin: { value: number };
    uHRange: { value: number };
    uHHalf: { value: number };
    uFogColor: { value: THREE.Color };
    uFogDensity: { value: number };
  };
  private walls: { mat: THREE.ShaderMaterial; cx: number; cz: number }[] = [];
  /** crosstown tunnel warp gates (Lincoln ↔ Queens–Midtown) */
  portals: TunnelPortal[] = [];
  private nsHeads!: THREE.InstancedMesh;
  private ewHeads!: THREE.InstancedMesh;
  private signalNodes: number[] = [];
  private lastNs = true;
  private lastEw = false;
  private boxes: BuildingBox[] = [];
  private hulls: [number, number][][] = [];
  private debugLines: THREE.LineSegments | null = null;
  private debugScene!: THREE.Scene;
  // GM ghost-delete support: per-building collider + vertex range in the merged geometry
  private world!: RAPIER_API.World;
  private buildingsGeo!: THREE.BufferGeometry;
  private bMeta: { coll: RAPIER_API.Collider; vStart: number; vCount: number; name?: string; gone: boolean }[] = [];
  // breakable seawall fence + marched shoreline (west/east river edges)
  private fence!: { geo: THREE.BufferGeometry; segs: { x: number; z: number; vStart: number; vCount: number; alive: boolean }[] };
  private shoreWArr: number[] = [];
  private shoreEArr: number[] = [];
  private shoreDz = 14;

  constructor(scene: THREE.Scene, world: RAPIER_API.World, RAPIER: typeof RAPIER_API) {
    this.buildingUniforms = {
      uLightning: { value: 0 },
      uFogColor: { value: new THREE.Color(FOG.color) },
      uFogDensity: { value: FOG.density },
    };

    for (let i = 0; i < NODES.length; i++) {
      if (NODE_DEGREE[i] >= 3) {
        const [x, z] = NODES[i];
        if (x > BORDER.minX + 60 && x < BORDER.maxX - 60 && z > BORDER.minZ + 60 && z < BORDER.maxZ - 60) {
          this.intersections.push(new THREE.Vector3(x, 0, z));
        }
      }
    }

    // ---- ground: REAL topographic contours (USGS elevation baked into HGRID) ----
    const n = HGRID.n;
    let hMin = Infinity, hMax = -Infinity;
    for (const h of HGRID.data) {
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;
    }
    const hTexData = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) {
      hTexData[i] = Math.round(((HGRID.data[i] - hMin) / Math.max(1, hMax - hMin)) * 255);
    }
    const hTex = new THREE.DataTexture(hTexData, n, n, THREE.RedFormat, THREE.UnsignedByteType);
    hTex.minFilter = THREE.LinearFilter;
    hTex.magFilter = THREE.LinearFilter;
    hTex.wrapS = THREE.ClampToEdgeWrapping;
    hTex.wrapT = THREE.ClampToEdgeWrapping;
    hTex.needsUpdate = true;

    this.groundUniforms = {
      uLightning: { value: 0 },
      uFogColor: { value: new THREE.Color(FOG.color) },
      uFogDensity: { value: FOG.density },
      uHeight: { value: hTex },
      uHMin: { value: hMin },
      uHRange: { value: Math.max(1, hMax - hMin) },
      uHHalf: { value: HGRID.half },
    };
    const groundMat = new THREE.ShaderMaterial({
      uniforms: this.groundUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vWorldPos;
        varying float vDist;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vec4 mv = viewMatrix * wp;
          vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vWorldPos;
        varying float vDist;
        uniform float uLightning;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform sampler2D uHeight;
        uniform float uHMin;
        uniform float uHRange;
        uniform float uHHalf;
        // thermal ramp: cold blue (sea level) -> teal -> amber -> hot red (peak)
        vec3 ramp(float t) {
          vec3 c1 = vec3(0.04, 0.16, 0.75);
          vec3 c2 = vec3(0.05, 0.55, 0.62);
          vec3 c3 = vec3(0.85, 0.52, 0.10);
          vec3 c4 = vec3(1.00, 0.13, 0.07);
          return t < 0.33 ? mix(c1, c2, t / 0.33)
               : t < 0.66 ? mix(c2, c3, (t - 0.33) / 0.33)
               : mix(c3, c4, (t - 0.66) / 0.34);
        }
        void main() {
          vec2 uv = (vWorldPos.xz + uHHalf) / (2.0 * uHHalf);
          float h01 = texture2D(uHeight, uv).r;
          float h = uHMin + h01 * uHRange;
          // AA iso lines: minor every 2 m, major every 10 m of real elevation
          float g2 = h / 2.0;
          float d2 = abs(fract(g2 + 0.5) - 0.5) / max(fwidth(g2), 1e-5);
          float minor = 1.0 - min(d2 * 0.7, 1.0);
          float g10 = h / 10.0;
          float d10 = abs(fract(g10 + 0.5) - 0.5) / max(fwidth(g10), 1e-5);
          float major = 1.0 - min(d10 * 0.7, 1.0);
          vec3 line = ramp(h01);
          vec3 col = vec3(0.006, 0.007, 0.012)
            + line * (minor * 0.30 + major * 0.85);
          col += vec3(0.10, 0.12, 0.18) * uLightning;
          float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vDist * vDist);
          gl_FragColor = vec4(mix(col, uFogColor, clamp(fogF, 0.0, 1.0)), 1.0);
        }`,
    });
    const groundSize = MAP_EDGE * 2 + 900;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    scene.add(ground);
    const gBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const gColl = world.createCollider(
      RAPIER.ColliderDesc.cuboid(groundSize / 2, 0.5, groundSize / 2).setTranslation(0, -0.5, 0),
      gBody
    );
    gColl.setCollisionGroups(groups(G_GROUND, G_ALL));
    gColl.setFriction(1.0);

    // matte near-black fill; the glow comes from edge lines + markings
    this.roadMat = new THREE.MeshStandardMaterial({
      color: 0x07070c,
      roughness: 0.5,
      metalness: 0.3,
    });
    this.buildRoads(scene);
    this.buildMarkings(scene);
    this.buildBuildings(scene, world, RAPIER);
    this.buildNeon(scene);
    this.buildStreetLights(scene);
    this.buildSignals(scene);
    this.buildSkyline(scene);
    this.buildWater(scene);
    this.buildBorderWalls(scene);
    this.buildOuterSkyline(scene);
    this.buildShoreFence(scene);
    this.buildPortals(scene);
    this.debugScene = scene;
  }

  /** GM: permanently ghost one building — collider removed, geometry flattened */
  ghostBuilding(i: number): { index: number; name?: string } | null {
    const m = this.bMeta[i];
    if (!m || m.gone) return null;
    m.gone = true;
    this.world.removeCollider(m.coll, true);
    const attr = this.buildingsGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let v = m.vStart; v < m.vStart + m.vCount; v++) attr.setY(v, 0.03);
    attr.needsUpdate = true;
    return { index: i, name: m.name };
  }

  /** GM: ghost whatever building the given point is inside/near (hold-V drive-through) */
  ghostBuildingAt(p: THREE.Vector3, reach = 1.4): { index: number; name?: string } | null {
    for (let i = 0; i < this.boxes.length; i++) {
      if (this.bMeta[i]?.gone) continue;
      const b = this.boxes[i];
      if (p.x > b.minX - reach && p.x < b.maxX + reach && p.z > b.minZ - reach && p.z < b.maxZ + reach) {
        return this.ghostBuilding(i);
      }
    }
    return null;
  }

  /** landside x of the west/east shoreline at a given z (from the marched DEM) */
  shoreWest(z: number): number {
    const k = THREE.MathUtils.clamp(Math.round((z - BORDER.minZ) / this.shoreDz), 0, this.shoreWArr.length - 1);
    const v = this.shoreWArr[k];
    return isFinite(v) ? v : BORDER.minX;
  }
  shoreEast(z: number): number {
    const k = THREE.MathUtils.clamp(Math.round((z - BORDER.minZ) / this.shoreDz), 0, this.shoreEArr.length - 1);
    const v = this.shoreEArr[k];
    return isFinite(v) ? v : BORDER.maxX;
  }

  /** smash the seawall fence near a point; true if any segment broke */
  breakFence(p: THREE.Vector3, r = 12): boolean {
    let hit = false;
    const attr = this.fence.geo.getAttribute('position') as THREE.BufferAttribute;
    for (const s of this.fence.segs) {
      if (!s.alive) continue;
      const dx = s.x - p.x, dz = s.z - p.z;
      if (dx * dx + dz * dz < r * r) {
        s.alive = false;
        hit = true;
        for (let v = s.vStart; v < s.vStart + s.vCount; v++) attr.setXYZ(v, 0, -5, 0);
      }
    }
    if (hit) attr.needsUpdate = true;
    return hit;
  }

  /** GM mode: red curb-level outlines of the ACTUAL physics colliders, so
   *  collider-vs-road discrepancies are visible at a glance (built lazily) */
  setDebug(on: boolean) {
    if (on && !this.debugLines) {
      const pos: number[] = [];
      const Y = 0.3;
      for (const hull of this.hulls) {
        for (let i = 0; i < hull.length; i++) {
          const [x1, z1] = hull[i];
          const [x2, z2] = hull[(i + 1) % hull.length];
          pos.push(x1, Y, z1, x2, Y, z2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      this.debugLines = new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({
          color: 0xff2233,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      this.debugLines.frustumCulled = false;
      this.debugScene.add(this.debugLines);
    }
    if (this.debugLines) this.debugLines.visible = on;
  }

  /** rivers past the highways: animated wave grid drawn only where the real
   *  DEM says water (h ≈ 0) — one plane, one shader, zero extra data */
  private buildWater(scene: THREE.Scene) {
    this.waterUniforms = {
      uTime: { value: 0 },
      uLightning: { value: 0 },
      uHeight: this.groundUniforms.uHeight,
      uHMin: this.groundUniforms.uHMin,
      uHRange: this.groundUniforms.uHRange,
      uHHalf: this.groundUniforms.uHHalf,
      uFogColor: { value: new THREE.Color(FOG.color) },
      uFogDensity: { value: FOG.density },
    };
    const size = HGRID.half * 2;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.waterUniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vWorldPos;
        varying float vDist;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vec4 mv = viewMatrix * wp;
          vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vWorldPos;
        varying float vDist;
        uniform float uTime;
        uniform float uLightning;
        uniform sampler2D uHeight;
        uniform float uHMin;
        uniform float uHRange;
        uniform float uHHalf;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        void main() {
          vec2 uv = (vWorldPos.xz + uHHalf) / (2.0 * uHHalf);
          float h = uHMin + texture2D(uHeight, uv).r * uHRange;
          float water = 1.0 - smoothstep(0.5, 1.8, h);
          if (water < 0.03) discard;
          vec2 p = vWorldPos.xz;
          // drifting wave grid: two warped line families + a long swell
          float swell = sin(p.x * 0.012 + uTime * 0.7) * sin(p.y * 0.015 - uTime * 0.55);
          float gx = abs(fract(p.x * 0.035 + 0.14 * sin(p.y * 0.045 + uTime * 0.8)) - 0.5);
          float gz = abs(fract(p.y * 0.035 + 0.14 * sin(p.x * 0.045 + uTime * 0.65)) - 0.5);
          float line = max(smoothstep(0.10, 0.0, gx), smoothstep(0.10, 0.0, gz));
          vec3 col = vec3(0.008, 0.020, 0.045)
            + vec3(0.05, 0.24, 0.42) * line * (0.45 + 0.55 * swell)
            + vec3(0.02, 0.08, 0.14) * (swell * 0.5 + 0.5) * 0.35;
          col += vec3(0.14, 0.20, 0.30) * uLightning;
          float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vDist * vDist);
          col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));
          gl_FragColor = vec4(col, water * 0.95);
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = WATER_Y; // above the flat driving plane: cars can go UNDER
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  /** north/south: the last row of buildings is the natural barrier — only the
   *  avenue gaps get pulsing blockade panels at the border line */
  private buildBorderWalls(scene: THREE.Scene) {
    const H = 11;
    const spots: { x: number; z: number; w: number }[] = [];
    for (const at of [BORDER.minZ, BORDER.maxZ]) {
      for (const e of EDGES) {
        for (const end of [e.pts[0], e.pts[e.pts.length - 1]]) {
          if (Math.abs(end[1] - at) > 70) continue;
          const x = end[0];
          if (x < BORDER.minX + 25 || x > BORDER.maxX - 25) continue;
          if (spots.some((s) => Math.abs(s.x - x) < 16 && Math.abs(s.z - at) < 90)) continue;
          spots.push({ x, z: at + (at > 0 ? -6 : 6), w: e.w + 14 });
        }
      }
    }
    for (const d of spots) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uOp: { value: 0 }, uTime: { value: 0 } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */ `
          varying vec2 vLocal;
          void main() {
            vLocal = position.xy;
            gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          varying vec2 vLocal;
          uniform float uOp;
          uniform float uTime;
          void main() {
            if (uOp < 0.004) discard;
            float gx = abs(fract(vLocal.x / 9.0) - 0.5);
            float gy = abs(fract((vLocal.y + 13.0) / 6.5) - 0.5);
            float line = max(smoothstep(0.05, 0.0, gx), smoothstep(0.07, 0.0, gy));
            float pulse = 0.55 + 0.45 * sin(uTime * 6.0 + vLocal.x * 0.06);
            float a = uOp * pulse * (line + 0.04);
            gl_FragColor = vec4(vec3(1.0, 0.16, 0.22) * (0.4 + line), a);
          }`,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(d.w, H), mat);
      mesh.position.set(d.x, H / 2, d.z);
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.walls.push({ mat, cx: d.x, cz: d.z });
    }
  }

  /** placeholder city beyond the north/south borders: two rows of dark towers
   *  so the uptown/downtown views read as "Manhattan keeps going" (scenery only) */
  private buildOuterSkyline(scene: THREE.Scene) {
    const boxes: { x: number; z: number; w: number; d: number; h: number }[] = [];
    for (const side of [-1, 1]) {
      const at = side < 0 ? BORDER.minZ : BORDER.maxZ;
      for (let row = 0; row < 2; row++) {
        const zc = at + side * (75 + row * 115);
        let x = BORDER.minX + 50;
        while (x < BORDER.maxX - 50) {
          const w = rand(26, 52);
          boxes.push({ x: x + w / 2, z: zc + rand(-22, 22), w, d: rand(32, 66), h: rand(16, 62) + row * 22 });
          x += w + rand(24, 52);
        }
      }
    }
    const fill = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x04050a }),
      boxes.length
    );
    const m4 = new THREE.Matrix4();
    const lpos: number[] = [];
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      m4.makeScale(b.w, b.h, b.d).setPosition(b.x, b.h / 2, b.z);
      fill.setMatrixAt(i, m4);
      // vertical + roof edge lines only (silhouette wireframe, half the verts)
      const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2;
      const z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
      for (const [ex, ez] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] as [number, number][]) {
        lpos.push(ex, 0, ez, ex, b.h, ez);
      }
      lpos.push(x0, b.h, z0, x1, b.h, z0, x1, b.h, z0, x1, b.h, z1);
      lpos.push(x1, b.h, z1, x0, b.h, z1, x0, b.h, z1, x0, b.h, z0);
    }
    fill.instanceMatrix.needsUpdate = true;
    scene.add(fill);
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.Float32BufferAttribute(lpos, 3));
    const lines = new THREE.LineSegments(
      lgeo,
      new THREE.LineBasicMaterial({ color: 0x16404e, transparent: true, opacity: 0.55 })
    );
    scene.add(lines);
  }

  /** breakable amber fence along the marched real shoreline (both rivers) */
  private buildShoreFence(scene: THREE.Scene) {
    const step = this.shoreDz;
    // DEM march (west margin is pier-smeared, so its threshold is looser)…
    const march = (dir: -1 | 1, thresh: number): number[] => {
      const arr: number[] = [];
      for (let z = BORDER.minZ; z <= BORDER.maxZ; z += step) {
        let found = NaN;
        for (let x = dir < 0 ? -1250 : 1150; dir < 0 ? x > BORDER.minX : x < BORDER.maxX; x += dir * 6) {
          if (elevationAt(x, z) < thresh) { found = x - dir * 5; break; }
        }
        arr.push(found);
      }
      return arr;
    };
    const mW = march(-1, 2.45);
    const mE = march(1, 1.2);
    // …anchored by the outermost real road per z-band (the shoreline highways):
    // the fence always sits just past the last drivable ribbon, never on it
    const bins = mW.length;
    const wRoad = new Array<number>(bins).fill(Infinity);
    const eRoad = new Array<number>(bins).fill(-Infinity);
    for (const e of EDGES) {
      for (const p of e.pts) {
        const k0 = Math.round((p[1] - BORDER.minZ) / step);
        // splat into a 5-band window so sparse corner bands still get anchored
        for (let k = k0 - 2; k <= k0 + 2; k++) {
          if (k < 0 || k >= bins) continue;
          if (p[0] < wRoad[k]) wRoad[k] = p[0];
          if (p[0] > eRoad[k]) eRoad[k] = p[0];
        }
      }
    }
    // fill road-anchor gaps from neighbors, combine, then 3-tap smooth
    for (let k = 0; k < bins; k++) {
      if (!isFinite(wRoad[k])) wRoad[k] = wRoad[k - 1] ?? -1500;
      if (!isFinite(eRoad[k])) eRoad[k] = eRoad[k - 1] ?? 1400;
    }
    const combine = (dem: number[], road: number[], dir: -1 | 1): number[] => {
      const out = new Array<number>(bins);
      for (let k = 0; k < bins; k++) {
        const anchor = road[k] + dir * 26;
        const d = dem[k];
        out[k] = dir < 0
          ? Math.max(BORDER.minX + 12, Math.min(isFinite(d) ? d : Infinity, anchor))
          : Math.min(BORDER.maxX - 12, Math.max(isFinite(d) ? d : -Infinity, anchor));
      }
      for (let k = 1; k < bins - 1; k++) out[k] = (out[k - 1] + out[k] + out[k + 1]) / 3;
      return out;
    };
    this.shoreWArr = combine(mW, wRoad, -1);
    this.shoreEArr = combine(mE, eRoad, 1);

    const lpos: number[] = [];
    const segs: { x: number; z: number; vStart: number; vCount: number; alive: boolean }[] = [];
    const addSide = (arr: number[]) => {
      for (let k = 0; k < arr.length - 1; k++) {
        const x1 = arr[k], x2 = arr[k + 1];
        if (!isFinite(x1) || !isFinite(x2) || Math.abs(x2 - x1) > 60) continue;
        const z1 = BORDER.minZ + k * step, z2 = z1 + step;
        const vStart = lpos.length / 3;
        lpos.push(x1, 0.55, z1, x2, 0.55, z2);
        lpos.push(x1, 1.15, z1, x2, 1.15, z2);
        lpos.push(x1, 0, z1, x1, 1.35, z1);
        segs.push({ x: (x1 + x2) / 2, z: (z1 + z2) / 2, vStart, vCount: lpos.length / 3 - vStart, alive: true });
      }
    };
    addSide(this.shoreWArr);
    addSide(this.shoreEArr);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(lpos, 3));
    const lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        color: 0xffb347, transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    lines.frustumCulled = false;
    scene.add(lines);
    this.fence = { geo, segs };
  }

  /** glowing crosstown warp gates at the real tunnel mouths */
  private buildPortals(scene: THREE.Scene) {
    this.portals = findTunnelPortals();
    const glowTex = makeGlowTexture();
    for (const p of this.portals) {
      const g = new THREE.Group();
      g.position.copy(p.pos);
      g.rotation.y = p.exitYaw;
      const dark = new THREE.MeshStandardMaterial({
        color: 0x0a0c12, roughness: 0.6,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      for (const sx of [-5.5, 5.5]) {
        const pylon = new THREE.Mesh(new THREE.BoxGeometry(1.4, 9, 1.4), dark);
        pylon.position.set(sx, 4.5, 0);
        addEdgeLines(pylon, 0x35d5ff, 0.95);
        g.add(pylon);
      }
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(12.4, 1.4, 1.4), dark);
      lintel.position.set(0, 9.2, 0);
      addEdgeLines(lintel, 0x35d5ff, 0.95);
      g.add(lintel);
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(10.6, 8.6),
        new THREE.MeshBasicMaterial({
          map: glowTex, color: 0x35d5ff, transparent: true, opacity: 0.65,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        })
      );
      glow.position.set(0, 4.4, 0);
      g.add(glow);
      scene.add(g);
    }
  }

  /** dark ribbons along every real polyline + glowing boundary lines */
  private buildRoads(scene: THREE.Scene) {
    const pos: number[] = [];
    const idx: number[] = [];
    const lpos: number[] = []; // road edge lines
    const Y = 0.016;

    for (let ei = 0; ei < EDGES.length; ei++) {
      const e = EDGES[ei];
      const half = e.w / 2;
      const base = pos.length / 3;
      let px1 = 0, pz1 = 0, px2 = 0, pz2 = 0;
      for (let k = 0; k < e.pts.length; k++) {
        // averaged direction at the point for smooth joins
        const p = e.pts[k];
        const pPrev = e.pts[Math.max(0, k - 1)];
        const pNext = e.pts[Math.min(e.pts.length - 1, k + 1)];
        let dx = pNext[0] - pPrev[0];
        let dz = pNext[1] - pPrev[1];
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        const nx = dz, nz = -dx; // perpendicular
        const x1 = p[0] + nx * half, z1 = p[1] + nz * half;
        const x2 = p[0] - nx * half, z2 = p[1] - nz * half;
        pos.push(x1, Y, z1, x2, Y, z2);
        if (k > 0) {
          lpos.push(px1, 0.05, pz1, x1, 0.05, z1);
          lpos.push(px2, 0.05, pz2, x2, 0.05, z2);
        }
        px1 = x1; pz1 = z1; px2 = x2; pz2 = z2;
      }
      for (let k = 0; k < e.pts.length - 1; k++) {
        const v = base + k * 2;
        idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    }

    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.Float32BufferAttribute(lpos, 3));
    const roadLines = new THREE.LineSegments(
      lgeo,
      new THREE.LineBasicMaterial({
        color: 0x1e4a66,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    roadLines.frustumCulled = false;
    scene.add(roadLines);

    // intersection patches: discs under the ribbons
    const YP = 0.012;
    const SEG = 10;
    for (let ni = 0; ni < NODES.length; ni++) {
      const inc = NODE_EDGES[ni];
      if (!inc.length) continue;
      let r = 0;
      for (const ei of inc) r = Math.max(r, EDGES[ei].w / 2);
      r += 0.4;
      const [cx, cz] = NODES[ni];
      const base = pos.length / 3;
      pos.push(cx, YP, cz);
      for (let s = 0; s < SEG; s++) {
        const a = (s / SEG) * Math.PI * 2;
        pos.push(cx + Math.cos(a) * r, YP, cz + Math.sin(a) * r);
      }
      for (let s = 0; s < SEG; s++) {
        idx.push(base, base + 1 + s, base + 1 + ((s + 1) % SEG));
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const n = pos.length / 3;
    const normals = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) normals[i * 3 + 1] = 1;
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, this.roadMat);
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  private buildMarkings(scene: THREE.Scene) {
    interface Dash { x: number; z: number; yaw: number; c: THREE.Color }
    const yellow = new THREE.Color(0.75, 0.6, 0.2);
    const white = new THREE.Color(0.5, 0.5, 0.56);
    const dashes: Dash[] = [];
    const p = new THREE.Vector3();
    const d = new THREE.Vector3();
    for (let ei = 0; ei < EDGES.length; ei++) {
      const e = EDGES[ei];
      const len = EDGE_LEN[ei];
      for (let s = 4; s < len - 2; s += 9) {
        edgePoint(ei, s, p);
        edgeDir(ei, s, d);
        const yaw = Math.atan2(d.x, d.z);
        if (e.ow === 0) {
          // two-way: double yellow center
          const nx = d.z, nz = -d.x;
          dashes.push({ x: p.x + nx * 0.35, z: p.z + nz * 0.35, yaw, c: yellow });
          dashes.push({ x: p.x - nx * 0.35, z: p.z - nz * 0.35, yaw, c: yellow });
        } else {
          dashes.push({ x: p.x, z: p.z, yaw, c: white });
        }
        if (e.major) {
          const nx = d.z, nz = -d.x;
          const off = e.w / 4;
          dashes.push({ x: p.x + nx * off, z: p.z + nz * off, yaw, c: white });
          dashes.push({ x: p.x - nx * off, z: p.z - nz * off, yaw, c: white });
        }
      }
    }
    const geo = new THREE.BoxGeometry(0.16, 0.02, 2.8);
    const inst = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }), dashes.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    dashes.forEach((it, i) => {
      q.setFromAxisAngle(up, it.yaw);
      m.compose(new THREE.Vector3(it.x, 0.03, it.z), q, new THREE.Vector3(1, 1, 1));
      inst.setMatrixAt(i, m);
      inst.setColorAt(i, it.c);
    });
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
  }

  private buildBuildings(scene: THREE.Scene, world: RAPIER_API.World, RAPIER: typeof RAPIER_API) {
    const pos: number[] = [];
    const nor: number[] = [];
    const seed: number[] = [];
    const idx: number[] = [];
    const v2: THREE.Vector2[] = [];

    const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world = world;

    for (const b of DATA.buildings) {
      const vStart = pos.length / 3;
      let pts = b.pts as [number, number][];
      let area = 0;
      for (let i = 0; i < pts.length; i++) {
        const [x1, z1] = pts[i];
        const [x2, z2] = pts[(i + 1) % pts.length];
        area += x1 * z2 - x2 * z1;
      }
      if (area < 0) pts = [...pts].reverse();

      const h = b.h;
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;

      for (let i = 0; i < pts.length; i++) {
        const [x1, z1] = pts[i];
        const [x2, z2] = pts[(i + 1) % pts.length];
        minX = Math.min(minX, x1); maxX = Math.max(maxX, x1);
        minZ = Math.min(minZ, z1); maxZ = Math.max(maxZ, z1);
        const dx = x2 - x1, dz = z2 - z1;
        const len = Math.hypot(dx, dz) || 1;
        const nx = dz / len, nz = -dx / len;
        const vi = pos.length / 3;
        pos.push(x1, 0, z1, x2, 0, z2, x2, h, z2, x1, h, z1);
        nor.push(nx, 0, nz, nx, 0, nz, nx, 0, nz, nx, 0, nz);
        seed.push(b.s, b.s, b.s, b.s);
        idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
      }

      v2.length = 0;
      for (const [x, z] of pts) v2.push(new THREE.Vector2(x, z));
      const tris = THREE.ShapeUtils.triangulateShape(v2, []);
      const roofBase = pos.length / 3;
      for (const [x, z] of pts) {
        pos.push(x, h, z);
        nor.push(0, 1, 0);
        seed.push(b.s);
      }
      for (const t of tris) idx.push(roofBase + t[0], roofBase + t[2], roofBase + t[1]);

      // exact trimesh for buildings with concave footprints (courtyard/L-shape);
      // convex hull for the rest (convex hulls are cheaper but bulge into streets
      // for rotated/L-shaped buildings off the grid)
      let desc: RAPIER_API.ColliderDesc;
      if ((b as any).exact) {
        // WALLS-ONLY trimesh following the exact (possibly concave) footprint.
        // No top/bottom faces: a fan over a concave outline creates ground-level
        // triangles that poke into the street — the phantom walls we're killing.
        const nv = pts.length;
        const verts = new Float32Array(nv * 2 * 3);
        for (let i = 0; i < nv; i++) {
          verts.set([pts[i][0], 0, pts[i][1]], i * 3);
          verts.set([pts[i][0], h, pts[i][1]], (nv + i) * 3);
        }
        const indices: number[] = [];
        for (let i = 0; i < nv; i++) {
          const j = (i + 1) % nv;
          indices.push(i, j, nv + i, j, nv + j, nv + i);
        }
        desc = RAPIER.ColliderDesc.trimesh(verts, new Uint32Array(indices));
      } else {
        // convex hull (fast, used for most buildings)
        const hull = convexHull2D(pts);
        const verts = new Float32Array(hull.length * 2 * 3);
        hull.forEach(([hx, hz], k) => {
          verts.set([hx, 0, hz], k * 6);
          verts.set([hx, h, hz], k * 6 + 3);
        });
        desc =
          RAPIER.ColliderDesc.convexHull(verts) ??
          RAPIER.ColliderDesc.cuboid((maxX - minX) / 2, h / 2, (maxZ - minZ) / 2)
            .setTranslation((minX + maxX) / 2, h / 2, (minZ + maxZ) / 2);
        this.hulls.push(hull);
      }
      const coll = world.createCollider(desc, wallBody);
      coll.setCollisionGroups(groups(G_BUILDING, G_ALL));
      coll.setFriction(0.4);
      this.boxes.push({ minX, maxX, minZ, maxZ, h });
      this.bMeta.push({
        coll, vStart, vCount: pos.length / 3 - vStart,
        name: (b as { name?: string }).name, gone: false,
      });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
    geo.setIndex(idx);
    this.buildingsGeo = geo;
    const mat = new THREE.ShaderMaterial({
      vertexShader: BUILDING_VERT,
      fragmentShader: BUILDING_FRAG,
      uniforms: this.buildingUniforms,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);

    this.buildBuildingWireframe(scene);
  }

  /** structured glowing edges from the real footprints: vertical corners,
   *  roofline, ground ring + floor rings — the wireframe IS the map data */
  private buildBuildingWireframe(scene: THREE.Scene) {
    const pos: number[] = [];
    const col: number[] = [];
    const cyan = new THREE.Color(0.30, 0.72, 1.0);
    const amber = new THREE.Color(1.0, 0.62, 0.22);
    const c = new THREE.Color();

    const pushLine = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) => {
      pos.push(x1, y1, z1, x2, y2, z2);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };

    for (const b of DATA.buildings) {
      const pts = b.pts as [number, number][];
      const h = b.h;
      const named = 'name' in b && !!(b as { name?: string }).name;
      // landmarks glow amber; the rest vary in cyan intensity per building
      const glow = named ? 1.0 : 0.28 + (b.s % 10) * 0.05;
      c.copy(named ? amber : cyan).multiplyScalar(glow);

      for (let i = 0; i < pts.length; i++) {
        const [x1, z1] = pts[i];
        const [x2, z2] = pts[(i + 1) % pts.length];
        pushLine(x1, 0, z1, x1, h, z1); // vertical corner
        pushLine(x1, h, z1, x2, h, z2); // roofline
        pushLine(x1, 0.05, z1, x2, 0.05, z2); // ground ring
      }
      // floor rings for the scan-line read; capped so towers stay cheap
      const rings = Math.min(6, Math.floor(h / 18));
      for (let r = 1; r <= rings; r++) {
        const y = (h / (rings + 1)) * r;
        const dim = 0.35;
        const cr = c.r * dim, cg = c.g * dim, cb = c.b * dim;
        for (let i = 0; i < pts.length; i++) {
          const [x1, z1] = pts[i];
          const [x2, z2] = pts[(i + 1) % pts.length];
          pos.push(x1, y, z1, x2, y, z2);
          col.push(cr, cg, cb, cr, cg, cb);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    scene.add(lines);
  }

  /** neon signs on facades near major roads */
  private buildNeon(scene: THREE.Scene) {
    const textures = NEON_WORDS.map((w, i) =>
      makeNeonTexture(w, NEON_COLORS[i % NEON_COLORS.length])
    );
    interface Spot { x: number; y: number; z: number; rotY: number; s: number }
    const spots: Spot[][] = textures.map(() => []);

    // coarse pass: building center vs major-edge segment midpoints
    const majorPts: { x: number; z: number }[] = [];
    const p = new THREE.Vector3();
    for (let ei = 0; ei < EDGES.length; ei++) {
      if (!EDGES[ei].major) continue;
      for (let s = 0; s < EDGE_LEN[ei]; s += 25) {
        edgePoint(ei, s, p);
        majorPts.push({ x: p.x, z: p.z });
      }
    }

    for (const box of this.boxes) {
      if (box.h < 10 || Math.random() > 0.3) continue;
      const cx = (box.minX + box.maxX) / 2;
      const cz = (box.minZ + box.maxZ) / 2;
      let best: { x: number; z: number } | null = null;
      let bestD = 45 * 45;
      for (const mp of majorPts) {
        const d = (mp.x - cx) ** 2 + (mp.z - cz) ** 2;
        if (d < bestD) { bestD = d; best = mp; }
      }
      if (!best) continue;
      const dx = best.x - cx;
      const dz = best.z - cz;
      const width = Math.min(box.maxX - box.minX, box.maxZ - box.minZ);
      if (width < 8) continue;
      let spot: Spot;
      if (Math.abs(dx) > Math.abs(dz)) {
        const zc = cz + rand(-0.2, 0.2) * (box.maxZ - box.minZ) * 0.5;
        spot = dx > 0
          ? { x: box.maxX + 0.4, y: 0, z: zc, rotY: Math.PI / 2, s: 0 }
          : { x: box.minX - 0.4, y: 0, z: zc, rotY: -Math.PI / 2, s: 0 };
      } else {
        const xc = cx + rand(-0.2, 0.2) * (box.maxX - box.minX) * 0.5;
        spot = dz > 0
          ? { x: xc, y: 0, z: box.maxZ + 0.4, rotY: 0, s: 0 }
          : { x: xc, y: 0, z: box.minZ - 0.4, rotY: Math.PI, s: 0 };
      }
      spot.s = Math.min(10, Math.max(4.5, width * 0.35));
      spot.y = rand(6, Math.min(24, box.h - 4));
      spots[Math.floor(Math.random() * textures.length)].push(spot);
    }

    const geo = new THREE.PlaneGeometry(1, 0.375);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const UP = new THREE.Vector3(0, 1, 0);
    textures.forEach((tex, ti) => {
      const list = spots[ti];
      if (!list.length) return;
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((sp, i) => {
        q.setFromAxisAngle(UP, sp.rotY);
        m.compose(new THREE.Vector3(sp.x, sp.y, sp.z), q, new THREE.Vector3(sp.s, sp.s, 1));
        inst.setMatrixAt(i, m);
      });
      inst.instanceMatrix.needsUpdate = true;
      scene.add(inst);
    });
  }

  private buildStreetLights(scene: THREE.Scene) {
    const positions: { x: number; z: number; ox: number; oz: number }[] = [];
    const p = new THREE.Vector3();
    const d = new THREE.Vector3();
    for (let ei = 0; ei < EDGES.length; ei++) {
      if (!EDGES[ei].major) continue;
      const half = EDGES[ei].w / 2 + 1.5;
      let side = 1;
      for (let s = 12; s < EDGE_LEN[ei]; s += 48) {
        edgePoint(ei, s, p);
        edgeDir(ei, s, d);
        positions.push({ x: p.x + d.z * half * side, z: p.z - d.x * half * side, ox: -d.z * side, oz: d.x * side });
        side = -side;
      }
    }
    const n = positions.length;
    if (!n) return;
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 5.6, 6);
    poleGeo.translate(0, 2.8, 0);
    const poles = new THREE.InstancedMesh(
      poleGeo,
      new THREE.MeshStandardMaterial({ color: 0x22222a, roughness: 0.7 }),
      n
    );
    const headGeo = new THREE.BoxGeometry(0.55, 0.16, 0.3);
    const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshBasicMaterial({ color: 0xffd9a0 }), n);
    const glowGeo = new THREE.PlaneGeometry(7, 7);
    glowGeo.rotateX(-Math.PI / 2);
    const glows = new THREE.InstancedMesh(
      glowGeo,
      new THREE.MeshBasicMaterial({
        map: makeGlowTexture(),
        transparent: true,
        opacity: 0.11,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      n
    );
    const m = new THREE.Matrix4();
    positions.forEach((pt, i) => {
      m.makeTranslation(pt.x, 0, pt.z);
      poles.setMatrixAt(i, m);
      m.makeTranslation(pt.x + pt.ox * 0.9, 5.65, pt.z + pt.oz * 0.9);
      heads.setMatrixAt(i, m);
      m.makeTranslation(pt.x + pt.ox * 0.9, 0.06, pt.z + pt.oz * 0.9);
      glows.setMatrixAt(i, m);
    });
    scene.add(poles, heads, glows);
  }

  private buildSignals(scene: THREE.Scene) {
    this.signalNodes = [];
    for (let i = 0; i < NODES.length; i++) if (NODE_DEGREE[i] >= 3) this.signalNodes.push(i);
    const count = this.signalNodes.length;
    const headGeo = new THREE.BoxGeometry(0.4, 0.9, 0.4);
    const mkInst = () =>
      new THREE.InstancedMesh(headGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), count);
    this.nsHeads = mkInst();
    this.ewHeads = mkInst();
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.09, 4.4, 6);
    poleGeo.translate(0, 2.2, 0);
    const poles = new THREE.InstancedMesh(
      poleGeo,
      new THREE.MeshStandardMaterial({ color: 0x1e1e26, roughness: 0.7 }),
      count
    );
    const m = new THREE.Matrix4();
    this.signalNodes.forEach((ni, i) => {
      const [x, z] = NODES[ni];
      let r = 6;
      for (const ei of NODE_EDGES[ni]) r = Math.max(r, EDGES[ei].w / 2 + 2);
      const px = x + r * 0.7;
      const pz = z + r * 0.7;
      m.makeTranslation(px, 0, pz);
      poles.setMatrixAt(i, m);
      m.makeTranslation(px, 4.4, pz - 0.5);
      this.nsHeads.setMatrixAt(i, m);
      m.makeTranslation(px - 0.5, 4.4, pz);
      this.ewHeads.setMatrixAt(i, m);
    });
    scene.add(poles, this.nsHeads, this.ewHeads);
    this.applySignalColors(true, false);
  }

  private applySignalColors(ns: boolean, ew: boolean) {
    const green = new THREE.Color(0.15, 1.0, 0.45);
    const red = new THREE.Color(1.0, 0.15, 0.2);
    for (let i = 0; i < this.signalNodes.length; i++) {
      this.nsHeads.setColorAt(i, ns ? green : red);
      this.ewHeads.setColorAt(i, ew ? green : red);
    }
    this.nsHeads.instanceColor!.needsUpdate = true;
    this.ewHeads.instanceColor!.needsUpdate = true;
  }

  private buildSkyline(scene: THREE.Scene) {
    const tex = makeSkylineTexture();
    const r = MAP_EDGE + 900;
    const geo = new THREE.CylinderGeometry(r, r, 320, 48, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.position.y = 158;
    ring.renderOrder = -5;
    scene.add(ring);
  }

  setEnvMap(_tex: THREE.Texture) {
    // wireframe restyle: no reflective surfaces left; kept for API compatibility
  }

  /** random point on a major road, for pickups */
  randomLanePoint(): THREE.Vector3 {
    for (let tries = 0; tries < 40; tries++) {
      const ei = Math.floor(Math.random() * EDGES.length);
      const e = EDGES[ei];
      if (!e.major || EDGE_LEN[ei] < 40) continue;
      const out = new THREE.Vector3();
      edgePoint(ei, rand(15, EDGE_LEN[ei] - 15), out);
      if (out.x < BORDER.minX + 60 || out.x > BORDER.maxX - 60 || out.z < BORDER.minZ + 60 || out.z > BORDER.maxZ - 60) continue;
      const d = edgeDir(ei, EDGE_LEN[ei] / 2, new THREE.Vector3());
      out.x += d.z * rand(-e.w / 4, e.w / 4);
      out.z += -d.x * rand(-e.w / 4, e.w / 4);
      return out;
    }
    return SPAWN.clone();
  }

  update(time: number, lightning01: number, playerPos?: THREE.Vector3) {
    this.buildingUniforms.uLightning.value = lightning01;
    this.groundUniforms.uLightning.value = lightning01;
    this.waterUniforms.uTime.value = time;
    this.waterUniforms.uLightning.value = lightning01;
    if (playerPos) {
      for (const w of this.walls) {
        const d = Math.hypot(w.cx - playerPos.x, w.cz - playerPos.z);
        w.mat.uniforms.uOp.value = Math.pow(THREE.MathUtils.clamp(1 - d / 130, 0, 1), 1.5);
        w.mat.uniforms.uTime.value = time;
      }
    }
    const ns = nsGreen(time);
    const ew = ewGreen(time);
    if (ns !== this.lastNs || ew !== this.lastEw) {
      this.lastNs = ns;
      this.lastEw = ew;
      this.applySignalColors(ns, ew);
    }
  }
}
