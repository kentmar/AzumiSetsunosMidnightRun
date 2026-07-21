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

// Buildings with concave footprints (ratio > 1.20): use exact trimesh colliders
// to avoid convex-hull overfill that causes phantom walls. Index into buildings[].
// (Lowered from 1.30 to catch additional concave cases like courtyards)
const TRIMESH_BUILDINGS = new Set([6, 15, 26, 27, 36, 46, 56, 64, 82, 95, 102, 105, 116, 120, 121, 124, 132, 133, 134, 139, 140, 141, 142, 148, 151, 152, 154, 155, 156, 157, 158, 159, 160, 161, 163, 164, 167, 169, 171, 172, 173, 174, 175, 176, 177, 184, 189, 191, 192, 193, 195, 196, 197, 198, 200, 203, 204, 205, 208, 215, 216, 217, 221, 223, 227, 228, 229, 230, 231, 232, 236, 237, 243, 244, 246, 247, 250, 251, 253, 254, 257, 260, 263, 264, 265, 266, 271, 272, 273, 274, 275, 276, 278, 281, 282, 284, 285, 287, 288, 290, 291, 294, 295, 297, 303, 304, 305, 307, 308, 309, 310, 317, 318, 321, 322, 325, 330, 332, 335, 338, 342, 343, 352, 355, 356, 357, 360, 366, 367, 368, 369, 370, 371, 372, 373, 376, 384, 385, 390, 391, 397, 401, 404, 407, 408, 411, 412, 414, 415, 416, 420, 424, 425, 430, 431, 432, 435, 436, 437, 439, 440, 442, 444, 445, 448, 449, 450, 457, 458, 459, 460, 463, 468, 469, 470, 471, 472, 473, 474, 475, 477, 478, 479, 481, 482, 483, 491, 495, 497, 498, 500, 502, 504, 506, 512, 516, 517, 518, 523, 526, 528, 535, 537, 539, 542, 547, 548, 549, 553, 554, 560, 561, 562, 563, 564, 565, 567, 584, 586, 589, 591, 592, 594, 602, 603, 607, 610, 612, 613, 614, 617, 620, 621, 634, 638, 639, 642, 645, 647, 648, 650, 654, 655, 660, 663, 664, 665, 666, 667, 668, 669, 671, 673, 676, 678, 679, 680, 681, 686, 689, 694, 695, 698, 705, 706, 707, 711, 712, 713, 714, 715, 716, 717, 720, 723, 727, 731, 732, 733, 735, 737, 738, 740, 744, 745, 750, 756, 757, 759, 770, 773, 782, 785, 787, 793, 794, 801, 804, 806, 807, 809, 811, 813, 820, 825, 828, 831, 835, 845, 847, 848, 852, 853, 854, 855, 856, 857, 860, 863, 864, 872, 877, 880, 881, 884, 886, 898, 899, 909, 920, 921, 925, 926, 927, 928, 930, 932, 938, 939, 940, 941, 943, 945, 946, 947, 956, 959, 962, 972, 973, 974, 978, 984, 986, 988, 1008, 1013, 1018, 1020, 1023, 1036, 1039, 1042, 1045, 1057, 1059, 1060, 1061, 1062, 1071, 1073, 1081, 1085, 1087, 1097, 1098, 1101, 1103, 1104, 1110, 1112, 1114, 1115, 1122, 1126, 1127, 1129, 1131, 1132, 1133, 1141, 1151, 1154, 1155, 1156, 1157, 1165, 1167, 1175, 1182, 1183, 1187, 1202, 1218, 1220, 1224, 1229, 1231, 1235, 1237, 1238, 1240, 1242, 1243, 1246, 1249, 1251, 1263, 1266, 1267, 1271, 1272, 1278, 1279, 1282, 1283, 1285, 1286, 1298, 1301, 1304, 1309, 1313, 1314, 1315, 1317, 1319, 1322, 1324, 1326, 1332, 1338, 1339, 1348, 1350, 1357, 1360, 1364, 1374, 1378, 1380, 1383, 1384, 1389, 1396, 1397, 1403, 1406, 1408, 1409, 1410, 1412, 1416, 1420, 1434, 1444, 1447, 1448, 1450, 1456, 1461, 1462, 1464, 1467, 1470, 1471, 1472, 1473, 1477, 1483, 1488, 1493, 1494, 1497, 1499, 1501, 1502, 1503, 1508, 1515, 1516, 1527, 1531, 1540, 1551, 1555, 1559, 1564, 1565, 1568, 1569, 1571, 1572, 1573, 1577, 1592, 1598, 1599, 1601, 1602, 1603, 1607, 1611, 1613, 1620, 1623, 1628, 1631, 1635, 1639, 1641, 1652, 1654, 1655, 1660, 1661, 1666, 1674, 1675, 1678, 1680, 1687, 1692, 1697, 1698, 1699, 1703, 1704, 1707, 1709, 1710, 1711, 1722, 1723, 1727, 1730, 1734, 1735, 1737, 1740, 1744, 1746, 1747, 1750, 1752, 1753, 1754, 1755, 1757, 1760, 1770, 1774, 1776, 1779, 1780, 1782, 1790, 1791, 1792, 1793, 1797, 1798, 1799, 1800, 1805, 1806, 1808, 1812, 1813, 1816, 1817, 1818, 1819, 1820, 1822, 1826, 1833, 1846, 1848, 1851, 1852, 1855, 1856, 1858, 1861, 1869, 1875, 1877, 1880, 1881, 1882, 1883, 1885, 1896, 1899, 1903, 1907, 1908, 1915, 1918, 1921, 1922, 1923, 1924, 1932, 1933, 1934, 1935, 1937, 1938, 1948, 1954, 1955, 1960, 1961, 1962, 1969, 1971, 1977, 1985, 1990, 1999, 2003, 2009, 2013, 2015, 2020, 2023, 2029, 2034, 2039, 2040, 2042, 2049, 2054, 2057, 2060, 2063, 2065, 2067, 2075, 2080, 2088, 2090, 2095, 2100, 2101, 2112, 2113, 2116, 2121, 2127, 2131, 2135, 2136, 2138, 2159, 2162, 2163, 2166, 2170, 2173, 2178, 2179, 2183, 2188, 2189, 2191, 2192, 2194, 2195, 2200, 2216, 2218, 2220, 2224, 2227, 2228, 2230, 2242, 2243, 2244, 2246, 2247, 2251, 2252, 2254, 2255, 2256, 2257, 2264, 2266, 2268, 2270, 2271, 2279, 2281, 2282, 2283, 2292, 2297, 2299, 2307, 2308, 2309, 2312, 2313, 2315, 2318, 2320, 2321, 2325, 2329, 2349, 2351, 2353, 2354, 2355, 2356, 2357, 2358, 2359, 2360, 2361, 2365, 2366, 2375, 2376, 2381, 2383, 2384, 2385, 2388, 2390, 2391, 2394, 2395, 2399]);

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
  // GM-verified drops: subway-station polygons drawn over open plazas —
  // they read as solid buildings but block real drivable space
  if (name && /^34th Street–Herald Square$/.test(name)) continue;
  buildings.push({ pts, h: r1(h), s: r1(Math.random() * 100), area, ...(name ? { name } : {}) });
}
buildings.sort((a, b) => b.area * b.h - a.area * a.h);
buildings = buildings.slice(0, 2400);
for (let i = 0; i < buildings.length; i++) {
  const b = buildings[i];
  delete b.area;
  if (TRIMESH_BUILDINGS.has(i)) b.exact = 1; // mark for trimesh collider in physics
}
console.log('buildings kept:', buildings.length, 'exact colliders:', buildings.filter(b => b.exact).length);

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
