import type { Input } from './input';
import { installHudStyles } from './layout';

// On-screen touch controls. They write into Input.virtual, so the vehicle code
// is agnostic about where input comes from. Pointer events (not touch events)
// so multi-touch works per-control and desktop clicks work for testing.
// Geometry lives in layout.ts (orientation-aware); this file is behaviour only.

export const IS_TOUCH =
  typeof window !== 'undefined' &&
  ('ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    new URLSearchParams(location.search).has('touch'));

// steering pad response: dead band around the centre line, full lock
// before the thumb reaches the pad's outer edge
const STEER_DEAD = 0.14;
const STEER_FULL = 0.62;

export class TouchControls {
  root: HTMLDivElement;

  constructor(input: Input, onTap: () => void) {
    installHudStyles(true);
    this.root = document.createElement('div');
    this.root.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:20;
      font-family:"Avenir Next","Segoe UI",Roboto,sans-serif;`;
    document.body.appendChild(this.root);

    this.steerPad(input);

    // pedals: GAS under the right thumb, BRK one roll to the left, DRIFT above
    this.btn('nr-gas', 'GAS',
      () => { input.virtual.throttle = 1; },
      () => { input.virtual.throttle = 0; });
    this.btn('nr-brk', 'BRK',
      () => { input.virtual.brake = 1; },
      () => { input.virtual.brake = 0; });
    this.btn('nr-drift', 'DRIFT',
      () => { input.virtual.handbrake = true; },
      () => { input.virtual.handbrake = false; });

    // flip rescue + pause, top-left
    const key = (code: string) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code }));
    };
    this.btn('nr-util nr-util-reset', '&#10227;', () => key('KeyR'), () => {});
    this.btn('nr-util nr-util-pause', '&#10074;&#10074;', () => key('Escape'), () => {});

    // tap anywhere (not on a control) = coin/start on attract & game-over screens
    window.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-nrbtn]')) return;
      onTap();
    });
  }

  /** one wide pad: where the thumb sits left/right of centre is the steer
   *  amount, so sliding across flips direction without lifting */
  private steerPad(input: Input) {
    const pad = document.createElement('div');
    pad.className = 'nr-tc nr-steer';
    pad.dataset.nrbtn = '1';
    pad.innerHTML = '<span class="nr-steer-l">&#9664;</span><i></i><span class="nr-steer-r">&#9654;</span>';
    let active: number | null = null;

    const apply = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2 - 1; // -1 left edge .. +1 right edge
      const m = Math.abs(x);
      const s = m < STEER_DEAD ? 0 : Math.min(1, (m - STEER_DEAD) / (STEER_FULL - STEER_DEAD));
      input.virtual.steer = -Math.sign(x) * s; // +1 = left in the vehicle's convention
      pad.classList.toggle('l', s > 0 && x < 0);
      pad.classList.toggle('r', s > 0 && x > 0);
    };
    const release = () => {
      active = null;
      input.virtual.steer = 0;
      pad.classList.remove('l', 'r');
    };
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (active !== null) return;
      active = e.pointerId;
      try {
        pad.setPointerCapture(e.pointerId); // keep tracking if the thumb slides off
      } catch { /* synthetic pointers can't be captured */ }
      apply(e);
    });
    pad.addEventListener('pointermove', (e) => {
      if (e.pointerId === active) apply(e);
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      pad.addEventListener(ev, (e) => {
        if (e.pointerId === active) release();
      });
    }
    this.root.appendChild(pad);
  }

  private btn(cls: string, html: string, on: () => void, off: () => void) {
    const b = document.createElement('div');
    b.className = `nr-tc ${cls}`;
    b.innerHTML = html;
    b.dataset.nrbtn = '1';
    const down = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        b.setPointerCapture(e.pointerId); // keeps release firing if finger slides off
      } catch { /* synthetic pointers can't be captured */ }
      b.classList.add('on');
      on();
    };
    const up = (e: PointerEvent) => {
      e.preventDefault();
      b.classList.remove('on');
      off();
    };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    this.root.appendChild(b);
    return b;
  }
}
