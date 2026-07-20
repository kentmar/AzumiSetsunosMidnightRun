import * as THREE from 'three';
import { EDGES, MAP_EDGE, elevationAt } from './city';
import DATA from './assets/midtown.json';

// Rotating car-up minimap (Midnight Club style): heading always points up, the
// map turns around you. (The fullscreen M map stays north-up.) The full OSM map
// — building footprints + real road network — is pre-rendered once to an
// offscreen canvas; each frame we blit a rotated crop and overlay live markers.

const VIEW_METERS = 520; // world meters shown across the minimap diameter

export class Minimap {
  private wrap: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private baseScale: number; // base px per meter
  private crossStreet: HTMLDivElement;
  private dpr = Math.min(devicePixelRatio, 2);
  private size: number;

  // fullscreen map overlay
  fullOpen = false;
  /** set by main; invoked by the MAP button and overlay taps */
  requestToggle?: () => void;
  private fullWrap!: HTMLDivElement;
  private fullCanvas!: HTMLCanvasElement;
  private fullCtx!: CanvasRenderingContext2D;
  private fullLabel!: HTMLDivElement;

  constructor(parent: HTMLElement, compact = false) {
    this.size = compact ? 146 : 224;
    const pos = compact
      ? 'right:12px;top:calc(96px + env(safe-area-inset-top));'
      : 'right:26px;bottom:24px;';
    this.wrap = document.createElement('div');
    this.wrap.style.cssText = `position:absolute;${pos}width:${this.size}px;
      display:none;pointer-events:none;`;
    parent.appendChild(this.wrap);

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.size * this.dpr;
    this.canvas.height = this.size * this.dpr;
    this.canvas.style.cssText = `width:${this.size}px;height:${this.size}px;border-radius:50%;
      border:2px solid rgba(255,184,77,0.5);background:rgba(6,4,10,0.72);
      box-shadow:0 0 18px rgba(0,0,0,0.6), inset 0 0 30px rgba(0,0,0,0.5);`;
    this.wrap.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.crossStreet = document.createElement('div');
    this.crossStreet.style.cssText = `margin-top:6px;text-align:center;font-size:11px;
      letter-spacing:2px;color:#ffb84d;text-shadow:0 0 8px rgba(255,150,40,0.6);
      text-transform:uppercase;white-space:nowrap;`;
    this.wrap.appendChild(this.crossStreet);

    const mapBtn = document.createElement('div');
    mapBtn.textContent = compact ? 'MAP' : 'MAP [M]';
    mapBtn.style.cssText = `margin:6px auto 0;width:max-content;padding:4px 14px;
      font-size:11px;letter-spacing:3px;color:#58e6ff;border:1px solid rgba(88,230,255,0.5);
      border-radius:12px;background:rgba(6,4,10,0.6);pointer-events:auto;cursor:pointer;
      text-shadow:0 0 8px rgba(88,230,255,0.6);`;
    mapBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.requestToggle?.();
    });
    this.wrap.appendChild(mapBtn);

    this.buildFullOverlay();

    // ---- pre-render the whole city once ----
    this.baseScale = 2048 / (MAP_EDGE * 2);
    this.base = document.createElement('canvas');
    this.base.width = 2048;
    this.base.height = 2048;
    const b = this.base.getContext('2d')!;
    const toPx = (wx: number, wz: number): [number, number] => [
      (wx + MAP_EDGE) * this.baseScale,
      (wz + MAP_EDGE) * this.baseScale, // north = -z (uptown) = up
    ];

    // real topographic contour underlay (2 m isolines from the baked USGS grid)
    {
      const R = 512;
      const tmp = document.createElement('canvas');
      tmp.width = tmp.height = R;
      const tctx = tmp.getContext('2d')!;
      const img = tctx.createImageData(R, R);
      const worldOf = (p: number) => (p / (R - 1)) * MAP_EDGE * 2 - MAP_EDGE;
      const hAt: number[] = new Array(R * R);
      for (let py = 0; py < R; py++) {
        for (let px = 0; px < R; px++) {
          hAt[py * R + px] = elevationAt(worldOf(px), worldOf(py));
        }
      }
      // thermal ramp: cold blue at sea level -> hot red at the highest ground
      let hMin = Infinity, hMax = -Infinity;
      for (const h of hAt) {
        if (h < hMin) hMin = h;
        if (h > hMax) hMax = h;
      }
      const range = Math.max(1, hMax - hMin);
      const ramp = (t: number): [number, number, number] => {
        const stops: [number, number, number][] = [
          [10, 40, 190], [13, 140, 158], [217, 133, 26], [255, 33, 18],
        ];
        const f = Math.min(0.999, Math.max(0, t)) * 3;
        const i = Math.floor(f);
        const k = f - i;
        return [
          stops[i][0] + (stops[i + 1][0] - stops[i][0]) * k,
          stops[i][1] + (stops[i + 1][1] - stops[i][1]) * k,
          stops[i][2] + (stops[i + 1][2] - stops[i][2]) * k,
        ];
      };
      for (let py = 0; py < R - 1; py++) {
        for (let px = 0; px < R - 1; px++) {
          const h = hAt[py * R + px];
          const i = (py * R + px) * 4;
          if (h < 0.9) {
            // river: flat cold fill
            img.data[i] = 14;
            img.data[i + 1] = 42;
            img.data[i + 2] = 92;
            img.data[i + 3] = 80;
            continue;
          }
          const crosses =
            Math.floor(h / 2) !== Math.floor(hAt[py * R + px + 1] / 2) ||
            Math.floor(h / 2) !== Math.floor(hAt[(py + 1) * R + px] / 2);
          if (!crosses) continue;
          const major =
            Math.floor(h / 10) !== Math.floor(hAt[py * R + px + 1] / 10) ||
            Math.floor(h / 10) !== Math.floor(hAt[(py + 1) * R + px] / 10);
          const [r, g, b] = ramp((h - hMin) / range);
          img.data[i] = r;
          img.data[i + 1] = g;
          img.data[i + 2] = b;
          img.data[i + 3] = major ? 200 : 110;
        }
      }
      tctx.putImageData(img, 0, 0);
      b.drawImage(tmp, 0, 0, R, R, 0, 0, this.base.width, this.base.height);
    }

    // buildings, brighter with height
    for (const bld of DATA.buildings) {
      const a = Math.min(0.42, 0.10 + bld.h * 0.001);
      b.fillStyle = `rgba(190,200,235,${a})`;
      b.beginPath();
      const pts = bld.pts as [number, number][];
      pts.forEach(([x, z], i) => {
        const [px, py] = toPx(x, z);
        i === 0 ? b.moveTo(px, py) : b.lineTo(px, py);
      });
      b.closePath();
      b.fill();
    }
    // real road network polylines
    b.lineCap = 'round';
    b.lineJoin = 'round';
    for (const e of EDGES) {
      b.strokeStyle = e.major ? 'rgba(255,214,150,0.8)' : 'rgba(255,214,150,0.45)';
      b.lineWidth = Math.max(1.5, e.w * this.baseScale * 0.85);
      b.beginPath();
      e.pts.forEach(([x, z], i) => {
        const [px, py] = toPx(x, z);
        i === 0 ? b.moveTo(px, py) : b.lineTo(px, py);
      });
      b.stroke();
    }
    // boundary = detonation line
    b.strokeStyle = 'rgba(255,60,70,0.9)';
    b.lineWidth = 5;
    const [bx0, by0] = toPx(-MAP_EDGE + 12, -MAP_EDGE + 12);
    const [bx1, by1] = toPx(MAP_EDGE - 12, MAP_EDGE - 12);
    b.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
  }

  private buildFullOverlay() {
    this.fullWrap = document.createElement('div');
    this.fullWrap.style.cssText = `position:fixed;inset:0;z-index:30;display:none;
      flex-direction:column;align-items:center;justify-content:center;gap:10px;
      background:rgba(4,2,8,0.9);pointer-events:auto;cursor:pointer;
      font-family:"Avenir Next","Segoe UI",Roboto,sans-serif;text-transform:uppercase;`;
    document.body.appendChild(this.fullWrap);

    const title = document.createElement('div');
    title.textContent = 'MIDTOWN MANHATTAN — REAL 1:1 MAP';
    title.style.cssText = `font-size:15px;letter-spacing:6px;color:#ffb84d;
      text-shadow:0 0 12px rgba(255,150,40,0.6);`;
    this.fullWrap.appendChild(title);

    this.fullCanvas = document.createElement('canvas');
    this.fullCanvas.width = 1024;
    this.fullCanvas.height = 1024;
    this.fullCanvas.style.cssText = `width:min(86vmin, 900px);height:min(86vmin, 900px);
      border:1px solid rgba(255,184,77,0.4);border-radius:8px;
      box-shadow:0 0 40px rgba(0,0,0,0.8);`;
    this.fullWrap.appendChild(this.fullCanvas);
    this.fullCtx = this.fullCanvas.getContext('2d')!;

    this.fullLabel = document.createElement('div');
    this.fullLabel.style.cssText = `font-size:12px;letter-spacing:3px;color:#ffb84d;`;
    this.fullWrap.appendChild(this.fullLabel);

    const hint = document.createElement('div');
    hint.textContent = 'M / ESC / TAP TO CLOSE';
    hint.style.cssText = `font-size:10px;letter-spacing:3px;color:#58e6ff;opacity:0.7;`;
    this.fullWrap.appendChild(hint);

    this.fullWrap.addEventListener('pointerdown', () => this.requestToggle?.());
  }

  toggleFull(open: boolean) {
    this.fullOpen = open;
    this.fullWrap.style.display = open ? 'flex' : 'none';
  }

  /** draw the whole-city map (north-up) with live markers; call while open */
  renderFull(
    pos: THREE.Vector3,
    forward: THREE.Vector3,
    checkpoint: THREE.Vector3 | null,
    gas: THREE.Vector3[]
  ) {
    if (!this.fullOpen) return;
    const ctx = this.fullCtx;
    const S = this.fullCanvas.width;
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(this.base, 0, 0, this.base.width, this.base.height, 0, 0, S, S);

    const toPx = (wx: number, wz: number): [number, number] => [
      ((wx + MAP_EDGE) / (2 * MAP_EDGE)) * S,
      ((wz + MAP_EDGE) / (2 * MAP_EDGE)) * S, // north = -z = up
    ];
    const dot = (wp: THREE.Vector3, color: string, r: number) => {
      const [px, py] = toPx(wp.x, wp.z);
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    };
    for (const g of gas) dot(g, '#3dff8e', 5);
    if (checkpoint) {
      dot(checkpoint, '#41a8ff', 8 + Math.sin(performance.now() * 0.006) * 2.5);
    }

    // player arrow, rotated to heading (north-up map; north = -z)
    const [px, py] = toPx(pos.x, pos.z);
    const yaw = Math.atan2(forward.x, -forward.z);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(yaw);
    ctx.fillStyle = '#ffb84d';
    ctx.shadowColor = '#ffb84d';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(8, 10);
    ctx.lineTo(0, 5);
    ctx.lineTo(-8, 10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    this.fullLabel.textContent = this.crossStreet.textContent || '';
  }

  /** call once per frame */
  update(
    visible: boolean,
    pos: THREE.Vector3,
    forward: THREE.Vector3,
    checkpoint: THREE.Vector3 | null,
    gas: THREE.Vector3[]
  ) {
    if (!visible) {
      this.wrap.style.display = 'none';
      return;
    }
    this.wrap.style.display = 'block';

    const ctx = this.ctx;
    const D = this.size * this.dpr;
    const c = D / 2;
    const yaw = Math.atan2(forward.x, -forward.z); // screen heading; north = -z
    const pxPerM = D / VIEW_METERS;

    ctx.clearRect(0, 0, D, D);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, c - 2, 0, Math.PI * 2);
    ctx.clip();

    // rotated crop of the pre-rendered city: car heading = screen up
    ctx.translate(c, c);
    ctx.rotate(-yaw);
    const srcHalf = (VIEW_METERS / 2) * this.baseScale * 1.5;
    const sx = (pos.x + MAP_EDGE) * this.baseScale - srcHalf;
    const sy = (pos.z + MAP_EDGE) * this.baseScale - srcHalf;
    const destHalf = (D / 2) * 1.5;
    ctx.drawImage(this.base, sx, sy, srcHalf * 2, srcHalf * 2, -destHalf, -destHalf, destHalf * 2, destHalf * 2);

    // live markers (world offsets, north-up inside the rotated frame)
    const mark = (wp: THREE.Vector3, color: string, r: number, clampEdge: boolean) => {
      let mx = (wp.x - pos.x) * pxPerM;
      let my = (wp.z - pos.z) * pxPerM; // north = -z = up on screen
      const d = Math.hypot(mx, my);
      const lim = c - 12 * this.dpr;
      if (d > lim) {
        if (!clampEdge) return;
        mx = (mx / d) * lim;
        my = (my / d) * lim;
      }
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8 * this.dpr;
      ctx.beginPath();
      ctx.arc(mx, my, r * this.dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    };
    for (const g of gas) mark(g, '#3dff8e', 3, false);
    if (checkpoint) {
      const pulse = 4.5 + Math.sin(performance.now() * 0.006) * 1.5;
      mark(checkpoint, '#41a8ff', pulse, true);
    }

    // compass N: rides the map's north edge, glyph kept upright
    ctx.save();
    ctx.translate(0, -(c - 13 * this.dpr));
    ctx.rotate(yaw);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `${10 * this.dpr}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', 0, 0);
    ctx.restore();
    ctx.restore();

    // player arrow, always center pointing up
    ctx.save();
    ctx.translate(c, c);
    ctx.fillStyle = '#ffb84d';
    ctx.shadowColor = '#ffb84d';
    ctx.shadowBlur = 10 * this.dpr;
    ctx.beginPath();
    const s = this.dpr;
    ctx.moveTo(0, -7 * s);
    ctx.lineTo(5 * s, 6 * s);
    ctx.lineTo(0, 3 * s);
    ctx.lineTo(-5 * s, 6 * s);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // nearest cross street (throttled: full-network scan is ~10k segment tests)
    const now = performance.now();
    if (now - this.lastStreetScan > 500) {
      this.lastStreetScan = now;
      this.crossStreet.textContent = this.findCrossStreets(pos);
    }
  }

  private lastStreetScan = 0;

  /** two nearest differently-named roads, e.g. "Broadway × West 47th Street" */
  private findCrossStreets(pos: THREE.Vector3): string {
    let d1 = Infinity, n1 = '';
    let d2 = Infinity, n2 = '';
    for (let i = 0; i < EDGES.length; i++) {
      const e = EDGES[i];
      if (!e.name) continue;
      for (let k = 1; k < e.pts.length; k++) {
        const ax = e.pts[k - 1][0], az = e.pts[k - 1][1];
        const bx = e.pts[k][0], bz = e.pts[k][1];
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        let t = ((pos.x - ax) * dx + (pos.z - az) * dz) / l2;
        t = Math.max(0, Math.min(1, t));
        const ddx = pos.x - (ax + dx * t);
        const ddz = pos.z - (az + dz * t);
        const d = ddx * ddx + ddz * ddz;
        if (d < d1 && e.name !== n2) {
          if (e.name !== n1) { d2 = d1; n2 = n1; }
          d1 = d; n1 = e.name;
        } else if (d < d2 && e.name !== n1) {
          d2 = d; n2 = e.name;
        }
      }
    }
    if (!n1) return '';
    return n2 && d2 < 90 * 90 ? `${n1} × ${n2}` : n1;
  }
}
