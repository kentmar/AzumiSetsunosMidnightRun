import type { Input } from './input';

// On-screen touch controls. They write into Input.virtual, so the vehicle code
// is agnostic about where input comes from. Pointer events (not touch events)
// so multi-touch works per-button and desktop clicks work for testing.

export const IS_TOUCH =
  typeof window !== 'undefined' &&
  ('ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    new URLSearchParams(location.search).has('touch'));

const BTN_BASE = `
  position:absolute;display:flex;align-items:center;justify-content:center;
  border:2px solid rgba(255,184,77,0.55);border-radius:18px;
  background:rgba(10,6,14,0.45);color:#ffb84d;font-weight:800;
  letter-spacing:2px;text-shadow:0 0 10px rgba(255,150,40,0.6);
  pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;`;

export class TouchControls {
  root: HTMLDivElement;

  constructor(input: Input, onTap: () => void) {
    this.root = document.createElement('div');
    this.root.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:20;
      font-family:"Avenir Next","Segoe UI",Roboto,sans-serif;`;
    document.body.appendChild(this.root);

    // steer, bottom-left
    this.btn('&#9664;', `left:calc(16px + env(safe-area-inset-left));bottom:calc(22px + env(safe-area-inset-bottom));width:84px;height:84px;font-size:30px;`,
      () => { input.virtual.steer = 1; },
      () => { if (input.virtual.steer === 1) input.virtual.steer = 0; });
    this.btn('&#9654;', `left:calc(112px + env(safe-area-inset-left));bottom:calc(22px + env(safe-area-inset-bottom));width:84px;height:84px;font-size:30px;`,
      () => { input.virtual.steer = -1; },
      () => { if (input.virtual.steer === -1) input.virtual.steer = 0; });

    // pedals: single column on the right so narrow portrait screens never overlap
    this.btn('GAS', `right:calc(16px + env(safe-area-inset-right));bottom:calc(22px + env(safe-area-inset-bottom));width:96px;height:96px;font-size:19px;border-color:rgba(90,230,140,0.6);color:#5ae68c;`,
      () => { input.virtual.throttle = 1; },
      () => { input.virtual.throttle = 0; });
    this.btn('BRK', `right:calc(16px + env(safe-area-inset-right));bottom:calc(128px + env(safe-area-inset-bottom));width:96px;height:64px;font-size:16px;border-color:rgba(255,80,90,0.6);color:#ff5a5f;`,
      () => { input.virtual.brake = 1; },
      () => { input.virtual.brake = 0; });
    this.btn('DRIFT', `right:calc(16px + env(safe-area-inset-right));bottom:calc(202px + env(safe-area-inset-bottom));width:96px;height:52px;font-size:15px;border-color:rgba(88,230,255,0.6);color:#58e6ff;`,
      () => { input.virtual.handbrake = true; },
      () => { input.virtual.handbrake = false; });

    // small utility buttons, top-left under the integrity bar
    const key = (code: string) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code }));
    };
    this.btn('&#10227;', `left:calc(16px + env(safe-area-inset-left));top:calc(64px + env(safe-area-inset-top));width:46px;height:40px;font-size:20px;opacity:0.8;`,
      () => key('KeyR'), () => {});
    this.btn('&#10074;&#10074;', `left:calc(70px + env(safe-area-inset-left));top:calc(64px + env(safe-area-inset-top));width:46px;height:40px;font-size:13px;opacity:0.8;`,
      () => key('Escape'), () => {});

    // tap anywhere (not on a button) = coin/start on attract & game-over screens
    window.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement | null)?.dataset?.nrbtn) return;
      onTap();
    });
  }

  private btn(html: string, style: string, on: () => void, off: () => void) {
    const b = document.createElement('div');
    b.style.cssText = BTN_BASE + style;
    b.innerHTML = html;
    b.dataset.nrbtn = '1';
    const down = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        b.setPointerCapture(e.pointerId); // keeps release firing if finger slides off
      } catch { /* synthetic pointers can't be captured */ }
      b.style.background = 'rgba(255,184,77,0.28)';
      on();
    };
    const up = (e: PointerEvent) => {
      e.preventDefault();
      b.style.background = 'rgba(10,6,14,0.45)';
      off();
    };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    this.root.appendChild(b);
    return b;
  }
}
