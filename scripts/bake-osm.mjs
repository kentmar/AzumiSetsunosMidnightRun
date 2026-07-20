// Bake v2: real midtown Manhattan from OpenStreetMap → src/assets/midtown.json
// - Buildings: real footprints + heights (extruded boxes in-game)
// - Roads: REAL polyline geometry (Broadway diagonal, FDR, West Side Highway),
//   split into graph edges at shared intersection nodes, with one-way flags.
// Game space: meters, rotated 29 deg so the avenue grid runs along +Z.
// Usage: node scripts/bake-osm.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const BBOX = [40.734, -74.018, 40.759, -73.958]; // generous fetch; cropped in game space below
const LAT0 = (BBOX[0] + BBOX[2]) / 2;
const LON0 = (BBOX[1] + BBOX[3]) / 2;
const THETA = (29 * Math.PI) / 180; // Manhattan grid bearing
const M_PER_LAT = 111132;
const M_PER_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

const ROAD_CLASSES = {
  motorway: { w: 22, major: true },
  motorway_link: { w: 10, major: false },
  trunk: { w: 20, major: true },
  trunk_link: { w: 10, major: false },
  primary: { w: 27, major: true },
  primary_link: { w: 10, major: false },
  secondary: { w: 21, major: true },
  secondary_link: { w: 10, major: false },
  tertiary: { w: 16, major: false },
  residential: { w: 14, major: false },
  unclassified: { w: 13, major: false },
};

// three.js is right-handed: with +x = east, north must map to -z, otherwise
// the whole world renders as a mirror image of real Manhattan (east on your
// left when driving uptown). Avenues run along -z (uptown).
function toGame(lat, lon) {
  const e = (lon - LON0) * M_PER_LON;
  const n = (lat - LAT0) * M_PER_LAT;
  return [
    e * Math.cos(THETA) - n * Math.sin(THETA),
    -(e * Math.sin(THETA) + n * Math.cos(THETA)),
  ];
}

function toLatLon(x, z) {
  const e = x * Math.cos(THETA) - z * Math.sin(THETA);
  const n = -x * Math.sin(THETA) - z * Math.cos(THETA);
  return [LAT0 + n / M_PER_LAT, LON0 + e / M_PER_LON];
}

// ---- real elevation via AWS Terrain Tiles (terrarium PNG, USGS NED for NYC) ----

/** minimal PNG decoder (8-bit, non-interlaced gray/RGB/RGBA) — no deps */
function decodePNG(buf) {
  let off = 8;
  let w = 0, h = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported png (bit depth/interlace)');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!ch) throw new Error(`unsupported png color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= ch && prev ? prev[x - ch] : 0;
      let v = raw[p + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    p += stride;
  }
  return { w, h, ch, data: out };
}

async function bakeElevation(halfSize) {
  const Z = 14;
  const scale = 2 ** Z;
  const tile = (lat, lon) => {
    const xt = ((lon + 180) / 360) * scale;
    const rad = (lat * Math.PI) / 180;
    const yt = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale;
    return [xt, yt];
  };

  // tile range covering the grid corners (+ margin)
  const corners = [
    toLatLon(-halfSize, -halfSize), toLatLon(halfSize, -halfSize),
    toLatLon(-halfSize, halfSize), toLatLon(halfSize, halfSize),
  ];
  let tx0 = Infinity, tx1 = -Infinity, ty0 = Infinity, ty1 = -Infinity;
  for (const [lat, lon] of corners) {
    const [xt, yt] = tile(lat, lon);
    tx0 = Math.min(tx0, Math.floor(xt)); tx1 = Math.max(tx1, Math.floor(xt));
    ty0 = Math.min(ty0, Math.floor(yt)); ty1 = Math.max(ty1, Math.floor(yt));
  }
  console.log(`  terrain tiles z${Z}: x ${tx0}-${tx1}, y ${ty0}-${ty1}`);
  const tiles = new Map();
  for (let x = tx0; x <= tx1; x++) {
    for (let y = ty0; y <= ty1; y++) {
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`terrain tile ${res.status} (${url})`);
      tiles.set(`${x},${y}`, decodePNG(Buffer.from(await res.arrayBuffer())));
    }
  }

  // terrarium: elevation = (R*256 + G + B/256) - 32768, bilinear-sampled
  const elevAtPixel = (gx, gy) => {
    const x = Math.floor(gx / 256), y = Math.floor(gy / 256);
    const t = tiles.get(`${x},${y}`);
    if (!t) return 0;
    const px = Math.min(255, gx - x * 256), py = Math.min(255, gy - y * 256);
    const i = (py * t.w + px) * t.ch;
    return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768;
  };
  const sample = (lat, lon) => {
    const [xt, yt] = tile(lat, lon);
    const gx = xt * 256 - 0.5, gy = yt * 256 - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    return (
      elevAtPixel(x0, y0) * (1 - fx) * (1 - fy) +
      elevAtPixel(x0 + 1, y0) * fx * (1 - fy) +
      elevAtPixel(x0, y0 + 1) * (1 - fx) * fy +
      elevAtPixel(x0 + 1, y0 + 1) * fx * fy
    );
  };

  const N = 96;
  const step = (halfSize * 2) / (N - 1);
  const data = new Array(N * N);
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const [lat, lon] = toLatLon(-halfSize + ix * step, -halfSize + iz * step);
      data[iz * N + ix] = Math.round(Math.max(0, sample(lat, lon)) * 10) / 10;
    }
  }
  return { n: N, half: halfSize, data };
}

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function overpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'night-run-nyc-bake/2.0 (one-time asset bake)',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`overpass ${res.status} (${url})`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      console.log(`  retry ${attempt + 1}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function indexNodes(data) {
  const nodes = new Map();
  for (const el of data.elements) if (el.type === 'node') nodes.set(el.id, [el.lat, el.lon]);
  return nodes;
}

function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i];
    const [x2, z2] = pts[(i + 1) % pts.length];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a / 2);
}

const r1 = (v) => Math.round(v * 10) / 10;
const bboxStr = BBOX.join(',');

// playfield: 23rd St (bottom) → 40th St (top), cropped along the street grid
// (game z runs uptown, so a z-range crop keeps edges parallel to the streets)
const Z_23RD = toGame(40.74055, -73.9896)[1]; // 23rd & 5th
const Z_40TH = toGame(40.75274, -73.9823)[1]; // 40th & 5th
const Z_LO = Math.min(Z_23RD, Z_40TH) - 45;
const Z_HI = Math.max(Z_23RD, Z_40TH) + 45;
// x crop: just past the shoreline highways (drops across-the-river geometry)
const X_LO = -1890; // ~60m west of West Side Highway
const X_HI = 1640;  // ~60m east of FDR Drive
console.log(`crop: z ${Math.round(Z_LO)} (23rd St) … ${Math.round(Z_HI)} (40th St), x ${X_LO}…${X_HI}`);

console.log('fetching buildings…');
const bData = await overpass(
  `[out:json][timeout:120];(way["building"](${bboxStr}););out body;>;out skel qt;`
);
console.log('fetching roads…');
const clsRegex = Object.keys(ROAD_CLASSES).join('|');
const sData = await overpass(
  `[out:json][timeout:90];(way["highway"~"^(${clsRegex})$"](${bboxStr}););out body;>;out skel qt;`
);

// ---------------- buildings ----------------
const bNodes = indexNodes(bData);
let buildings = [];
for (const el of bData.elements) {
  if (el.type !== 'way' || !el.tags?.building || !el.nodes) continue;
  if (el.nodes[0] !== el.nodes[el.nodes.length - 1]) continue;
  const pts = [];
  for (const id of el.nodes.slice(0, -1)) {
    const n = bNodes.get(id);
    if (!n) continue;
    const [x, z] = toGame(n[0], n[1]);
    pts.push([r1(x), r1(z)]);
  }
  if (pts.length < 3) continue;
  const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  if (cz < Z_LO || cz > Z_HI || cx < X_LO || cx > X_HI) continue; // outside playfield
  const area = polyArea(pts);
  if (area < 90) continue;
  let h = parseFloat(el.tags.height ?? '');
  if (!isFinite(h)) {
    const lv = parseFloat(el.tags['building:levels'] ?? '');
    h = isFinite(lv) ? lv * 3.3 : 14 + Math.random() * 28;
  }
  h = Math.min(h, 450);
  const name = el.tags.name;
  buildings.push({ pts, h: r1(h), s: r1(Math.random() * 100), area, ...(name ? { name } : {}) });
}
buildings.sort((a, b) => b.area * b.h - a.area * a.h);
buildings = buildings.slice(0, 2400);
for (const b of buildings) delete b.area;
console.log('buildings kept:', buildings.length);

// ---------------- road graph ----------------
const sNodes = indexNodes(sData);
const ways = [];
const nodeUse = new Map(); // osm node id -> count across kept ways
for (const el of sData.elements) {
  if (el.type !== 'way' || !el.nodes || el.nodes.length < 2) continue;
  const cls = el.tags?.highway;
  const spec = ROAD_CLASSES[cls];
  if (!spec) continue;
  // underground segments would draw through city blocks
  if (el.tags?.tunnel && el.tags.tunnel !== 'no') continue;
  if (parseFloat(el.tags?.layer ?? '0') < 0) continue;
  let allIds = el.nodes.filter((id) => sNodes.has(id));
  if (allIds.length < 2) continue;
  let oneway = el.tags?.oneway === 'yes' || cls.startsWith('motorway') ? 1 : 0;
  if (el.tags?.oneway === '-1') {
    allIds = [...allIds].reverse();
    oneway = 1;
  }
  // crop to the 23rd–40th band: split into contiguous in-range runs
  const inRange = (id) => {
    const [x, z] = toGame(...sNodes.get(id));
    return z >= Z_LO && z <= Z_HI && x >= X_LO && x <= X_HI;
  };
  const runs = [];
  let run = [];
  for (const id of allIds) {
    if (inRange(id)) run.push(id);
    else {
      if (run.length >= 2) runs.push(run);
      run = [];
    }
  }
  if (run.length >= 2) runs.push(run);

  for (const ids of runs) {
    ways.push({ ids, cls, spec, oneway, name: el.tags?.name ?? '' });
    for (const id of ids) nodeUse.set(id, (nodeUse.get(id) ?? 0) + 1);
    // endpoints always count as junction candidates so edges connect
    nodeUse.set(ids[0], (nodeUse.get(ids[0]) ?? 0) + 1);
    nodeUse.set(ids[ids.length - 1], (nodeUse.get(ids[ids.length - 1]) ?? 0) + 1);
  }
}

// graph nodes = osm nodes used by ≥2 way passes
const nodeIdx = new Map();
const nodes = [];
const nodeDegree = [];
function graphNode(id) {
  if (nodeIdx.has(id)) return nodeIdx.get(id);
  const [x, z] = toGame(...sNodes.get(id));
  const i = nodes.length;
  nodeIdx.set(id, i);
  nodes.push([r1(x), r1(z)]);
  nodeDegree.push(0);
  return i;
}

const edges = [];
for (const w of ways) {
  let segIds = [w.ids[0]];
  for (let k = 1; k < w.ids.length; k++) {
    segIds.push(w.ids[k]);
    const isJunction = (nodeUse.get(w.ids[k]) ?? 0) >= 2;
    const isLast = k === w.ids.length - 1;
    if (isJunction || isLast) {
      if (segIds.length >= 2) {
        const a = graphNode(segIds[0]);
        const b = graphNode(segIds[segIds.length - 1]);
        // polyline, simplified: keep points >3.5m apart
        const pts = [];
        for (const id of segIds) {
          const [x, z] = toGame(...sNodes.get(id));
          const last = pts[pts.length - 1];
          if (!last || Math.hypot(x - last[0], z - last[1]) > 3.5) pts.push([r1(x), r1(z)]);
        }
        const [ex, ez] = toGame(...sNodes.get(segIds[segIds.length - 1]));
        const lastPt = pts[pts.length - 1];
        if (Math.hypot(ex - lastPt[0], ez - lastPt[1]) > 0.1) pts.push([r1(ex), r1(ez)]);
        if (pts.length >= 2) {
          let len = 0;
          for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
          if (len > 6) {
            edges.push({
              pts, a, b, w: w.spec.w, cls: w.cls, ow: w.oneway,
              major: w.spec.major ? 1 : 0,
              ...(w.name ? { name: w.name } : {}),
            });
            nodeDegree[a]++;
            nodeDegree[b]++;
          }
        }
      }
      segIds = [w.ids[k]];
    }
  }
}
console.log('graph nodes:', nodes.length, 'edges:', edges.length);
const junctions = nodes.map((p, i) => ({ p, d: nodeDegree[i] })).filter((n) => n.d >= 3);
console.log('junctions (deg>=3):', junctions.length);
const named = [...new Set(edges.map((e) => e.name).filter(Boolean))];
console.log('named roads sample:', named.filter((n) => /Broadway|FDR|Miller|9A|Highway|Tunnel/i.test(n)));

const xs = buildings.flatMap((b) => b.pts.map((p) => p[0]));
const zs = buildings.flatMap((b) => b.pts.map((p) => p[1]));
const extent = {
  minX: Math.round(Math.min(...xs)),
  maxX: Math.round(Math.max(...xs)),
  minZ: Math.round(Math.min(...zs)),
  maxZ: Math.round(Math.max(...zs)),
};
console.log('extent:', extent);

console.log('fetching real elevation (USGS/Mapzen terrain tiles)…');
// wide margin so the water shader has real river data well past the shoreline
const halfSize =
  Math.max(Math.abs(extent.minX), extent.maxX, Math.abs(extent.minZ), extent.maxZ) + 700;
const hgrid = await bakeElevation(halfSize);
const hs = hgrid.data;
console.log('elevation range:', Math.min(...hs), '…', Math.max(...hs), 'm');

const meta = {
  baked: new Date().toISOString().slice(0, 10),
  source: 'OpenStreetMap contributors (ODbL) · USGS/Mapzen terrain tiles',
  bbox: BBOX,
  crop: '23rd St – 40th St, river to river',
};

mkdirSync(new URL('../src/assets', import.meta.url), { recursive: true });
const out = { version: 3, theta: 29, meta, extent, hgrid, buildings, nodes, degree: nodeDegree, edges };
writeFileSync(new URL('../src/assets/midtown.json', import.meta.url), JSON.stringify(out));
console.log('wrote src/assets/midtown.json');
