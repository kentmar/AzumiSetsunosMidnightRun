// Tactical high-contrast DOM HUD: big MPH, fuel, integrity, credits, checkpoints,
// boundary warning, plus the attract / game-over arcade overlays.

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

const BAR_WRAP = (w: number) => `
  width:${w}px;height:14px;border:1px solid rgba(255,255,255,0.35);
  background:rgba(0,0,0,0.45);padding:2px;box-sizing:border-box;`;

export class Hud {
  root: HTMLDivElement;
  private mph: HTMLDivElement;
  private gear: HTMLDivElement;
  private fuelFill: HTMLDivElement;
  private fuelLabel: HTMLDivElement;
  private healthFill: HTMLDivElement;
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
  private popupT = 0;

  constructor() {
    this.root = document.createElement('div');
    this.root.style.cssText = `position:fixed;inset:0;pointer-events:none;color:${AMBER};
      font-family:"Avenir Next","Segoe UI",Roboto,sans-serif;z-index:10;
      font-variant-numeric:tabular-nums;text-transform:uppercase;`;
    document.body.appendChild(this.root);

    el(this.root, `position:absolute;inset:0;background:radial-gradient(ellipse at center,
      transparent 55%, rgba(0,0,0,0.5) 100%);`);

    // speed block, bottom-left
    const speedBox = el(this.root, `position:absolute;left:34px;bottom:26px;
      border-left:3px solid ${AMBER};padding-left:14px;text-shadow:0 0 12px rgba(255,150,40,0.6);`);
    this.speedBox = speedBox;
    this.mph = el(speedBox, `font-size:74px;font-weight:800;line-height:0.95;letter-spacing:1px;`, '0');
    const row = el(speedBox, `display:flex;gap:14px;align-items:baseline;`);
    el(row, `font-size:15px;letter-spacing:5px;opacity:0.85;`, 'MPH');
    this.gear = el(row, `font-size:15px;letter-spacing:3px;color:${CYAN};`, 'D');

    // fuel, bottom-center
    const fuelBox = el(this.root, `position:absolute;left:50%;transform:translateX(-50%);bottom:30px;text-align:center;`);
    this.fuelBox = fuelBox;
    this.fuelLabel = el(fuelBox, `font-size:11px;letter-spacing:5px;margin-bottom:5px;opacity:0.9;`, 'FUEL');
    const fuelBar = el(fuelBox, BAR_WRAP(260));
    this.fuelFill = el(fuelBar, `height:100%;width:100%;background:${AMBER};box-shadow:0 0 10px rgba(255,170,60,0.8);`);

    // integrity, top-left
    const hBox = el(this.root, `position:absolute;left:34px;top:26px;`);
    el(hBox, `font-size:11px;letter-spacing:5px;margin-bottom:5px;opacity:0.9;`, 'INTEGRITY');
    const hBar = el(hBox, BAR_WRAP(190));
    this.healthFill = el(hBar, `height:100%;width:100%;background:${CYAN};box-shadow:0 0 10px rgba(80,220,255,0.7);`);

    // credits + checkpoints, top-right
    const tr = el(this.root, `position:absolute;right:34px;top:26px;text-align:right;font-size:17px;
      letter-spacing:3px;line-height:1.7;text-shadow:0 0 10px rgba(255,150,40,0.5);`);
    this.credits = el(tr, '', 'CREDITS 1');
    this.checkpoints = el(tr, `color:${CYAN};text-shadow:0 0 10px rgba(80,220,255,0.5);`, '');

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
  private speedBox!: HTMLDivElement;
  private fuelBox!: HTMLDivElement;
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
    this.speedBox.style.bottom = '130px';
    this.speedBox.style.left = '22px';
    this.mph.style.fontSize = '52px';
    this.fuelBox.style.bottom = '8px';
    this.fuelBox.style.left = '40%';
    (this.fuelFill.parentElement as HTMLElement).style.width = '150px';
  }

  setSpeed(mph: number, gear: string) {
    this.mph.textContent = String(Math.round(Math.abs(mph)));
    this.gear.textContent = gear;
  }
  setFuel(f01: number) {
    const pc = Math.max(0, Math.min(1, f01));
    this.fuelFill.style.width = `${pc * 100}%`;
    const low = pc < 0.22;
    this.fuelFill.style.background = low ? RED : AMBER;
    this.fuelLabel.style.color = low ? RED : AMBER;
  }
  setHealth(h01: number) {
    const pc = Math.max(0, Math.min(1, h01));
    this.healthFill.style.width = `${pc * 100}%`;
    this.healthFill.style.background = pc < 0.3 ? RED : CYAN;
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
  popup(text: string) {
    this.popupEl.textContent = text;
    this.popupEl.style.opacity = '1';
    this.popupT = 1.4;
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
