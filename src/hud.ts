// Tactical high-contrast DOM HUD: big MPH, fuel, integrity, credits, checkpoints,
// boundary warning, plus the attract / game-over arcade overlays.

import { MAX_RPM, REDLINE_RPM } from './vehicle';

const AMBER = '#ffb84d';
const CYAN = '#58e6ff';
const RED = '#ff4455';

function el(parent: HTMLElement, style: string, html = ''): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = style;
  d.innerHTML = html;
  parent.appendChild(d);
  return d;
}

const DIM = 'rgba(255,255,255,0.20)';

/** corner-bracket frame, the motif that ties the whole cluster together */
function brackets(host: HTMLElement, color: string, size = 6) {
  // only promote static elements — absolutely-positioned hosts must keep theirs
  if (!host.style.position) host.style.position = 'relative';
  const mk = (css: string) => {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;width:${size}px;height:${size}px;${css}`;
    host.appendChild(d);
  };
  mk(`left:0;top:0;border-left:1px solid ${color};border-top:1px solid ${color};`);
  mk(`right:0;top:0;border-right:1px solid ${color};border-top:1px solid ${color};`);
  mk(`left:0;bottom:0;border-left:1px solid ${color};border-bottom:1px solid ${color};`);
  mk(`right:0;bottom:0;border-right:1px solid ${color};border-bottom:1px solid ${color};`);
}

export class Hud {
  root: HTMLDivElement;
  private mph: HTMLDivElement;
  private gear: HTMLDivElement;
  private fuelLabel: HTMLDivElement;
  private credits: HTMLDivElement;
  private checkpoints: HTMLDivElement;
  private warning: HTMLDivElement;
  private popupEl: HTMLDivElement;
  private flashEl: HTMLDivElement;
  private attractEl: HTMLDivElement;
  private gameOverEl: HTMLDivElement;
  private goReason: HTMLDivElement;
  private goPrompt: HTMLDivElement;
  private fpsEl: HTMLDivElement;
  private odo!: HTMLDivElement;
  private cluster!: HTMLDivElement;
  private fuelGauge!: SVGLineElement[];
  private revGauge!: SVGLineElement[];
  private fuelReadout!: HTMLDivElement;
  private revReadout!: HTMLDivElement;
  private healthSegs!: HTMLDivElement[];
  private driveSummary!: HTMLDivElement;
  private dsTrip!: HTMLDivElement;
  private dsOdo!: HTMLDivElement;
  private dsTime!: HTMLDivElement;
  private compassRing!: SVGGElement;
  private compassLabel!: SVGTextElement;
  private runSeconds = 0;
  private popupT = 0;

  constructor() {
    this.root = document.createElement('div');
    this.root.style.cssText = `position:fixed;inset:0;pointer-events:none;color:${AMBER};
      font-family:"Avenir Next","Segoe UI",Roboto,sans-serif;z-index:10;
      font-variant-numeric:tabular-nums;text-transform:uppercase;`;
    document.body.appendChild(this.root);

    el(this.root, `position:absolute;inset:0;background:radial-gradient(ellipse at center,
      transparent 55%, rgba(0,0,0,0.5) 100%);`);

    // ================= instrument cluster (bottom centre) =================
    // Bowed segmented gauges flank a thin technical speed readout; every value
    // sits in a corner-bracket frame.
    const cluster = el(this.root, `position:absolute;left:26px;bottom:16px;
      display:flex;align-items:flex-end;gap:14px;`);
    this.cluster = cluster;

    const fuelCol = el(cluster, `display:flex;flex-direction:column;align-items:center;gap:6px;`);
    el(fuelCol, `font-size:9px;letter-spacing:3px;opacity:0.55;`, '100%');
    this.fuelGauge = this.buildArcGauge(fuelCol, -1);
    this.fuelReadout = el(fuelCol, `font-size:17px;letter-spacing:1px;color:${AMBER};
      padding:3px 10px;min-width:44px;text-align:center;`, '100');
    brackets(this.fuelReadout, 'rgba(255,184,77,0.55)');
    this.fuelLabel = el(fuelCol, `font-size:9px;letter-spacing:3px;opacity:0.7;`, 'FUEL %');

    // centre column: speed, gear, odometer
    const mid = el(cluster, `display:flex;flex-direction:column;align-items:center;
      padding:0 10px 6px;background-image:radial-gradient(rgba(255,255,255,0.10) 1px, transparent 1px);
      background-size:11px 11px;background-position:center 12px;background-repeat:round;`);
    this.mph = el(mid, `font-size:78px;font-weight:300;line-height:0.9;letter-spacing:-1px;
      color:#fff;text-shadow:0 0 18px rgba(255,255,255,0.35);`, '0');
    el(mid, `font-size:12px;letter-spacing:7px;opacity:0.8;margin-top:2px;color:#fff;`, 'MPH');
    this.gear = el(mid, `font-size:16px;letter-spacing:2px;color:${AMBER};margin-top:10px;
      padding:2px 12px;`, 'G1');
    brackets(this.gear, 'rgba(255,184,77,0.5)', 5);
    this.odo = el(mid, `font-size:12px;letter-spacing:2px;opacity:0.62;margin-top:7px;
      white-space:nowrap;color:#fff;`, '0.0 mi');

    const revCol = el(cluster, `display:flex;flex-direction:column;align-items:center;gap:6px;`);
    el(revCol, `font-size:9px;letter-spacing:3px;opacity:0.55;color:${RED};`, 'REDLINE');
    this.revGauge = this.buildArcGauge(revCol, 1);
    this.revReadout = el(revCol, `font-size:17px;letter-spacing:1px;color:${CYAN};
      padding:3px 10px;min-width:52px;text-align:center;`, '850');
    brackets(this.revReadout, 'rgba(88,230,255,0.55)');
    el(revCol, `font-size:9px;letter-spacing:3px;opacity:0.7;`, 'RPM');

    // ---- compass rose, bottom-left ----
    this.buildCompass();

    // ---- integrity, top-left (segmented + bracketed) ----
    const hBox = el(this.root, `position:absolute;left:34px;top:26px;`);
    el(hBox, `font-size:10px;letter-spacing:5px;margin-bottom:6px;opacity:0.85;`, 'INTEGRITY');
    const hFrame = el(hBox, `padding:5px 7px;`);
    brackets(hFrame, 'rgba(255,255,255,0.35)');
    this.healthSegs = [];
    const hRow = el(hFrame, `display:flex;gap:3px;`);
    for (let i = 0; i < 20; i++) {
      this.healthSegs.push(el(hRow, `width:8px;height:12px;background:${CYAN};`));
    }

    // ---- credits + checkpoints, top-right ----
    const tr = el(this.root, `position:absolute;right:34px;top:26px;text-align:right;
      display:flex;flex-direction:column;align-items:flex-end;gap:8px;`);
    this.credits = el(tr, `font-size:15px;letter-spacing:3px;padding:4px 12px;`, 'CREDITS 1');
    brackets(this.credits, 'rgba(255,184,77,0.45)', 5);
    this.checkpoints = el(tr, `font-size:15px;letter-spacing:3px;color:${CYAN};padding:4px 12px;`, '');
    brackets(this.checkpoints, 'rgba(88,230,255,0.45)', 5);

    // ---- drive summary, right side ----
    const ds = el(this.root, `position:absolute;right:34px;top:46%;transform:translateY(-50%);
      padding:13px 14px;width:158px;box-sizing:border-box;`);
    this.driveSummary = ds;
    brackets(ds, 'rgba(255,255,255,0.30)', 8);
    el(ds, `font-size:10px;letter-spacing:3px;opacity:0.8;text-align:center;margin-bottom:10px;
      color:#fff;white-space:nowrap;`, 'DRIVE SUMMARY');
    const dsRow = (glyph: string) => {
      const r = el(ds, `display:flex;align-items:center;justify-content:space-between;
        gap:14px;margin-top:9px;`);
      el(r, `font-size:15px;opacity:0.65;`, glyph);
      const v = el(r, `text-align:right;`);
      const num = el(v, `font-size:19px;font-weight:300;color:#fff;line-height:1;`, '0.0');
      const unit = el(v, `font-size:10px;letter-spacing:1px;color:${AMBER};margin-top:2px;`, '');
      return { num, unit };
    };
    const rTrip = dsRow('&#10230;');
    const rOdo = dsRow('&#9186;');
    const rTime = dsRow('&#9201;');
    this.dsTrip = rTrip.num; rTrip.unit.textContent = 'mi trip';
    this.dsOdo = rOdo.num; rOdo.unit.textContent = 'mi total';
    this.dsTime = rTime.num; rTime.unit.textContent = 'min:sec';

    // boundary warning, top-center
    this.warning = el(this.root, `position:absolute;left:50%;transform:translateX(-50%);top:56px;
      font-size:22px;font-weight:700;letter-spacing:6px;color:${RED};text-align:center;
      text-shadow:0 0 16px rgba(255,40,60,0.9);display:none;
      border:1px solid ${RED};padding:8px 22px;background:rgba(60,0,8,0.45);`);

    // center popup
    this.popupEl = el(this.root, `position:absolute;left:50%;top:34%;transform:translate(-50%,-50%);
      font-size:34px;font-weight:800;letter-spacing:8px;color:${CYAN};opacity:0;
      text-shadow:0 0 20px rgba(80,220,255,0.9);transition:opacity 0.2s;`);

    // impact flash
    this.flashEl = el(this.root, `position:absolute;inset:0;background:#fff;opacity:0;`);

    // pause overlay
    this.pauseEl = el(this.root, `position:absolute;inset:0;display:none;flex-direction:column;
      align-items:center;justify-content:center;background:rgba(4,2,8,0.55);`);
    el(this.pauseEl, `font-size:52px;font-weight:900;letter-spacing:14px;
      text-shadow:0 0 24px rgba(255,150,40,0.8);`, 'PAUSED');
    el(this.pauseEl, `font-size:14px;letter-spacing:4px;margin-top:18px;color:${CYAN};`,
      'ESC TO RESUME');

    this.fpsEl = el(this.root, `position:absolute;right:8px;bottom:6px;font-size:10px;opacity:0.5;letter-spacing:2px;`);

    // ---- attract screen ----
    this.attractEl = el(this.root, `position:absolute;inset:0;display:flex;flex-direction:column;
      align-items:center;justify-content:center;background:rgba(5,2,6,0.35);`);
    el(this.attractEl, `font-size:15px;letter-spacing:12px;color:${CYAN};margin-bottom:10px;`, 'MIDNIGHT ARCADE PRESENTS');
    el(this.attractEl, `font-size:76px;font-weight:900;letter-spacing:10px;line-height:1;
      text-shadow:0 0 30px rgba(255,90,40,0.9),0 0 60px rgba(255,40,40,0.5);`, 'NIGHT RUN');
    el(this.attractEl, `font-size:30px;font-weight:700;letter-spacing:26px;color:${RED};
      text-shadow:0 0 20px rgba(255,60,60,0.8);margin-top:4px;`, 'N Y C');
    const coin = el(this.attractEl, `font-size:24px;letter-spacing:8px;margin-top:56px;font-weight:700;`, 'INSERT COIN [ C ]');
    coin.animate([{ opacity: 1 }, { opacity: 0.15 }, { opacity: 1 }], { duration: 1300, iterations: Infinity });
    this.coinEl = coin;
    this.attractCreditLine = el(this.attractEl, `font-size:16px;letter-spacing:4px;margin-top:14px;color:${CYAN};`, '');
    this.hintEl = el(this.attractEl, `font-size:12px;letter-spacing:3px;margin-top:44px;opacity:0.75;line-height:2;text-align:center;`,
      'W/&#8593; THROTTLE &nbsp; S/&#8595; BRAKE &nbsp; A D STEER &nbsp; SPACE HANDBRAKE<br/>R FLIP RESCUE &nbsp; P TUNING PANEL &nbsp; RUN THE BLUE RINGS &nbsp; TUNNELS WARP CROSSTOWN');
    this.dataStampEl = el(this.attractEl, `font-size:10px;letter-spacing:2px;margin-top:26px;opacity:0.5;text-align:center;line-height:1.8;`);

    // ---- game over ----
    this.gameOverEl = el(this.root, `position:absolute;inset:0;display:none;flex-direction:column;
      align-items:center;justify-content:center;background:rgba(20,0,4,0.45);`);
    this.goReason = el(this.gameOverEl, `font-size:64px;font-weight:900;letter-spacing:10px;color:${RED};
      text-shadow:0 0 30px rgba(255,40,60,0.9);`, 'WRECKED');
    el(this.gameOverEl, `font-size:26px;letter-spacing:8px;margin-top:20px;`, 'GAME OVER');
    this.goPrompt = el(this.gameOverEl, `font-size:20px;letter-spacing:4px;margin-top:40px;color:${CYAN};text-align:center;line-height:2;`);
  }

  private attractCreditLine!: HTMLDivElement;
  private pauseEl!: HTMLDivElement;
  private coinEl!: HTMLDivElement;
  private hintEl!: HTMLDivElement;
  private dataStampEl!: HTMLDivElement;

  /** map provenance line on the attract screen */
  setDataStamp(text: string) {
    this.dataStampEl.textContent = text;
  }

  showPause(v: boolean) {
    this.pauseEl.style.display = v ? 'flex' : 'none';
  }

  private touchMode = false;

  /** compact layout + touch wording, leaves room for on-screen controls */
  setTouchMode() {
    this.touchMode = true;
    this.coinEl.textContent = 'TAP TO START';
    this.hintEl.innerHTML =
      'ON-SCREEN PEDALS &nbsp; DRIFT = HANDBRAKE<br/>&#10227; FLIP RESCUE &nbsp; &#10074;&#10074; PAUSE &nbsp; RUN THE BLUE RINGS';
    // compact the cluster and hide the side panels: thumbs need the corners
    this.mph.style.fontSize = '48px';
    this.cluster.style.bottom = '96px';
    this.cluster.style.transform = 'translateX(-50%) scale(0.72)';
    this.cluster.style.transformOrigin = 'bottom center';
    this.driveSummary.style.display = 'none';
  }

  /** bowed segmented column — the signature gauge of the cluster.
   *  side -1 bulges left, +1 bulges right, mirroring around the speed. */
  private buildArcGauge(host: HTMLElement, side: -1 | 1): SVGLineElement[] {
    const N = 26, H = 168, BOW = 13, HALF = 7.5;
    let lines = '';
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) / N;
      const y = 6 + H * (1 - t);
      const cx = 22 + side * BOW * Math.sin(Math.PI * t);
      lines += `<line x1="${(cx - HALF).toFixed(2)}" y1="${y.toFixed(2)}"
        x2="${(cx + HALF).toFixed(2)}" y2="${y.toFixed(2)}"
        stroke="${DIM}" stroke-width="3.4" stroke-linecap="butt"/>`;
    }
    const box = el(host, `width:44px;height:180px;`);
    box.innerHTML = `<svg viewBox="0 0 44 180" width="44" height="180">${lines}</svg>`;
    return Array.from(box.querySelectorAll('line')) as unknown as SVGLineElement[];
  }

  private fillGauge(segs: SVGLineElement[], v01: number, color: string, hotFrom = 2) {
    const n = segs.length;
    const lit = Math.round(Math.max(0, Math.min(1, v01)) * n);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const on = i < lit;
      segs[i].setAttribute('stroke', on ? (t >= hotFrom ? RED : color) : DIM);
    }
  }

  /** rotating compass rose, bottom-left */
  private buildCompass() {
    let ticks = '';
    for (let d = 0; d < 360; d += 5) {
      const major = d % 45 === 0;
      const a = ((d - 90) * Math.PI) / 180;
      const r0 = major ? 34 : 38, r1 = 42;
      ticks += `<line x1="${(50 + r0 * Math.cos(a)).toFixed(2)}" y1="${(50 + r0 * Math.sin(a)).toFixed(2)}"
        x2="${(50 + r1 * Math.cos(a)).toFixed(2)}" y2="${(50 + r1 * Math.sin(a)).toFixed(2)}"
        stroke="rgba(255,255,255,${major ? 0.7 : 0.3})" stroke-width="${major ? 1.4 : 0.7}"/>`;
    }
    ['N', 'E', 'S', 'W'].forEach((c, i) => {
      const a = ((i * 90 - 90) * Math.PI) / 180;
      ticks += `<text x="${(50 + 26 * Math.cos(a)).toFixed(2)}" y="${(50 + 26 * Math.sin(a) + 3).toFixed(2)}"
        text-anchor="middle" font-size="9" fill="${c === 'N' ? AMBER : 'rgba(255,255,255,0.75)'}"
        font-family="inherit">${c}</text>`;
    });
    const box = el(this.root, `position:absolute;left:30px;top:74px;width:104px;height:104px;opacity:0.92;`);
    box.innerHTML = `
      <svg viewBox="0 0 100 100" width="104" height="104">
        <circle cx="50" cy="50" r="45" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="0.8"/>
        <circle cx="50" cy="50" r="20" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="0.8"/>
        <g id="cring">${ticks}</g>
        <polygon points="50,4 46.5,11 53.5,11" fill="${AMBER}"/>
        <text id="chead" x="50" y="56" text-anchor="middle" font-size="22" font-weight="300"
          fill="${AMBER}" font-family="inherit">N</text>
      </svg>`;
    this.compassRing = box.querySelector('#cring') as SVGGElement;
    this.compassLabel = box.querySelector('#chead') as SVGTextElement;
  }

  /** heading in degrees, 0 = north */
  setCompass(deg: number) {
    const d = ((deg % 360) + 360) % 360;
    this.compassRing.setAttribute('transform', `rotate(${(-d).toFixed(1)} 50 50)`);
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    this.compassLabel.textContent = names[Math.round(d / 45) % 8];
  }

  /** rev column + numeric readout; the top of the bar is the red zone */
  setRev(rpm: number, gear: number) {
    const r = Math.max(0, Math.min(MAX_RPM, rpm));
    this.fillGauge(this.revGauge, r / MAX_RPM, CYAN, REDLINE_RPM / MAX_RPM);
    this.revReadout.textContent = String(Math.round(r));
    this.revReadout.style.color = r >= REDLINE_RPM ? RED : CYAN;
    void gear;
  }

  /** trip + lifetime distance, in miles */
  setOdo(tripMeters: number, totalMeters: number) {
    const mi = (m: number) => (m / 1609.34).toFixed(1);
    this.odo.textContent = `${mi(totalMeters)} mi`;
    this.dsTrip.textContent = mi(tripMeters);
    this.dsOdo.textContent = mi(totalMeters);
  }

  /** elapsed run time for the drive summary */
  setRunTime(seconds: number) {
    this.runSeconds = seconds;
    const m = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    this.dsTime.textContent = `${m}:${String(sec).padStart(2, '0')}`;
  }

  setSpeed(mph: number, gear: string) {
    this.mph.textContent = String(Math.round(Math.abs(mph)));
    this.gear.textContent = gear;
  }
  setFuel(f01: number) {
    const pc = Math.max(0, Math.min(1, f01));
    const low = pc < 0.22;
    this.fillGauge(this.fuelGauge, pc, low ? RED : AMBER);
    this.fuelReadout.textContent = String(Math.round(pc * 100));
    this.fuelReadout.style.color = low ? RED : AMBER;
    this.fuelLabel.style.color = low ? RED : AMBER;
  }
  setHealth(h01: number) {
    const pc = Math.max(0, Math.min(1, h01));
    const lit = Math.round(pc * this.healthSegs.length);
    for (let i = 0; i < this.healthSegs.length; i++) {
      this.healthSegs[i].style.background = i < lit ? (pc < 0.3 ? RED : CYAN) : DIM;
    }
  }
  setCredits(n: number) {
    this.credits.textContent = `CREDITS ${n}`;
    this.attractCreditLine.textContent =
      n > 0 ? `${n} CREDIT${n > 1 ? 'S' : ''} — PRESS ENTER TO START` : 'NO CREDITS';
  }
  setCheckpoints(k: number, n: number) {
    this.checkpoints.textContent = `CHECKPOINT ${k}/${n}`;
  }
  setWarning(w01: number | null) {
    if (w01 === null || w01 <= 0) {
      this.warning.style.display = 'none';
      return;
    }
    this.warning.style.display = 'block';
    this.warning.innerHTML = `&#9888; MIRROR PERIMETER &#9888;<br/>
      <span style="font-size:14px;letter-spacing:3px;">REBOUND AT 30% SPEED — FUEL COST · ${(Math.min(1, w01) * 100).toFixed(0)}%</span>`;
    this.warning.style.opacity = String(0.5 + 0.5 * Math.sin(performance.now() * 0.02));
  }
  /** set by main: lets audio sting checkpoints/credits */
  onPopup?: (text: string) => void;

  popup(text: string) {
    this.popupEl.textContent = text;
    this.popupEl.style.opacity = '1';
    this.popupT = 1.4;
    this.onPopup?.(text);
  }
  flash(strength: number) {
    this.flashEl.animate(
      [{ opacity: String(0.85 * strength) }, { opacity: '0' }],
      { duration: 320, easing: 'ease-out' }
    );
  }
  showAttract(v: boolean) {
    this.attractEl.style.display = v ? 'flex' : 'none';
  }
  showGameOver(reason: string | null, credits: number, countdown: number) {
    if (!reason) {
      this.gameOverEl.style.display = 'none';
      return;
    }
    this.gameOverEl.style.display = 'flex';
    this.goReason.textContent = reason;
    const cont = this.touchMode ? 'TAP TO CONTINUE' : 'CONTINUE? PRESS ENTER';
    const coin = this.touchMode ? 'TAP TO CONTINUE' : 'INSERT COIN [ C ]';
    this.goPrompt.innerHTML =
      credits > 0
        ? `${cont} — 1 CREDIT<br/><span style="font-size:34px;">${Math.ceil(countdown)}</span>`
        : `${coin}<br/><span style="font-size:34px;">${Math.ceil(countdown)}</span>`;
  }
  setFps(fps: number) {
    this.fpsEl.textContent = `${fps.toFixed(0)} FPS`;
  }
  update(dt: number) {
    if (this.popupT > 0) {
      this.popupT -= dt;
      if (this.popupT <= 0) this.popupEl.style.opacity = '0';
    }
  }
}
