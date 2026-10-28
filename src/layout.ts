// Responsive HUD/menu stylesheet. The HUD builds its elements with inline
// styles (desktop layout); this sheet adds what inline styles can't: sizes that
// track the viewport (attract / game over / pause scale down on small screens)
// and, on touch devices, a separate layout keyed on orientation, so rotating
// the phone re-flows the HUD and the on-screen controls live.
//
// Touch layout, both orientations: left thumb = steering pad, right thumb =
// GAS with BRK beside it and DRIFT above, flip/pause top-left, status chips
// top-right, speed + fuel in the free space bottom-centre. Landscape puts the
// minimap top-left (the right edge belongs to the pedals); portrait has height
// to spare and puts it top-right under the chips. Elements the touch layout
// moves have their inline position cleared (Hud.setTouchMode), so these rules
// need no !important except to hide things.

const BASE_CSS = `
.nr-attract { overflow-y:auto; padding:16px; box-sizing:border-box; justify-content:safe center !important; }
.nr-a-presents { font-size:clamp(10px, 2.6vw, 15px) !important; letter-spacing:0.8em !important; text-align:center; }
.nr-a-title { font-size:clamp(38px, min(13vw, 15vh), 76px) !important; letter-spacing:0.13em !important; white-space:nowrap; }
.nr-a-nyc { font-size:clamp(18px, min(5.5vw, 7vh), 30px) !important; letter-spacing:0.87em !important; }
.nr-a-coin { margin-top:clamp(18px, 7.8vh, 56px) !important; font-size:clamp(16px, 4.5vw, 24px) !important; letter-spacing:0.33em !important; }
.nr-a-daily { margin-top:clamp(12px, 3.6vh, 26px) !important; }
.nr-a-hint { margin-top:clamp(14px, 6.1vh, 44px) !important; }
.nr-a-stamp { margin-top:clamp(10px, 3.6vh, 26px) !important; }
.nr-go-reason { font-size:clamp(36px, 12vw, 64px) !important; letter-spacing:0.15em !important; text-align:center; }
.nr-go-title { font-size:clamp(16px, 5vw, 26px) !important; letter-spacing:0.3em !important; }
.nr-go-prompt { font-size:clamp(14px, 4vw, 20px) !important; }
.nr-pause-title { font-size:clamp(34px, 11vw, 52px) !important; letter-spacing:0.27em !important; }
.nr-popup { font-size:clamp(22px, 7vw, 34px) !important; letter-spacing:0.22em !important; white-space:nowrap; }
.nr-warning { font-size:clamp(14px, 4.4vw, 22px) !important; letter-spacing:0.25em !important; max-width:calc(100vw - 32px); box-sizing:border-box; }
.nr-touch-only, .nr-rotate-hint { display:none; }
`;

const TOUCH_CSS = `
body.nr-touch {
  --gl: max(12px, env(safe-area-inset-left));
  --gr: max(12px, env(safe-area-inset-right));
  --gt: max(10px, env(safe-area-inset-top));
  --gb: max(12px, env(safe-area-inset-bottom));
  /* control geometry; portrait and short-landscape override below */
  --steer-w: 212px; --steer-h: 104px;
  --gas-w: 104px; --gas-h: 124px;
  --brk-w: 88px; --brk-h: 96px;
  --drift-h: 52px; --gap: 10px;
  -webkit-touch-callout: none;
}
@media (orientation: portrait) {
  body.nr-touch { --steer-w: 156px; --steer-h: 92px; --gas-w: 86px; --gas-h: 100px;
    --brk-w: 72px; --brk-h: 80px; --drift-h: 46px; --gap: 8px; }
}
@media (orientation: landscape) and (max-height: 400px) {
  body.nr-touch { --steer-w: 190px; --steer-h: 92px; --gas-w: 96px; --gas-h: 104px;
    --brk-w: 80px; --brk-h: 84px; --drift-h: 46px; }
}

/* ---- on-screen controls ---- */
.nr-tc { position:absolute; display:flex; align-items:center; justify-content:center; box-sizing:border-box;
  border:2px solid rgba(255,184,77,0.55); border-radius:18px; background:rgba(10,6,14,0.45);
  color:#ffb84d; font-weight:800; letter-spacing:2px; text-shadow:0 0 10px rgba(255,150,40,0.6);
  pointer-events:auto; touch-action:none; user-select:none; -webkit-user-select:none; }
.nr-tc.on { background:rgba(255,184,77,0.28); }
.nr-steer { left:var(--gl); bottom:var(--gb); width:var(--steer-w); height:var(--steer-h);
  justify-content:space-between; font-size:30px; }
.nr-steer > span { flex:1; display:flex; align-items:center; justify-content:center; height:100%;
  border-radius:16px; transition:background 0.06s; }
.nr-steer.l > .nr-steer-l, .nr-steer.r > .nr-steer-r { background:rgba(255,184,77,0.3); }
.nr-steer > i { width:1px; height:56%; background:rgba(255,184,77,0.35); }
.nr-gas { right:var(--gr); bottom:var(--gb); width:var(--gas-w); height:var(--gas-h); font-size:20px;
  border-color:rgba(90,230,140,0.6); color:#5ae68c; }
.nr-gas.on { background:rgba(90,230,140,0.26); }
.nr-brk { right:calc(var(--gr) + var(--gas-w) + var(--gap)); bottom:var(--gb); width:var(--brk-w); height:var(--brk-h);
  font-size:16px; border-color:rgba(255,80,90,0.6); color:#ff5a5f; }
.nr-brk.on { background:rgba(255,80,90,0.26); }
.nr-drift { right:var(--gr); bottom:calc(var(--gb) + var(--gas-h) + var(--gap)); width:var(--gas-w); height:var(--drift-h);
  font-size:14px; border-color:rgba(88,230,255,0.6); color:#58e6ff; }
.nr-drift.on { background:rgba(88,230,255,0.24); }
.nr-util { top:var(--gt); width:46px; height:46px; border-radius:14px; font-size:20px; opacity:0.85; }
.nr-util-reset { left:var(--gl); }
.nr-util-pause { left:calc(var(--gl) + 54px); font-size:13px; }

/* menus own the screen: no pedals, no driving HUD behind the title */
body.nr-menu .nr-tc, body.nr-menu .nr-chrome { display:none !important; }

/* ---- driving HUD ---- */
.nr-touch .nr-compass, .nr-touch .nr-odo, .nr-touch .nr-trip, .nr-touch .nr-fuelcol,
.nr-touch .nr-rev, .nr-touch .nr-fps, .nr-touch .nr-int-label, .nr-touch .nr-minimap-btn { display:none !important; }
.nr-touch .nr-touch-only { display:block; }
.nr-touch .nr-integrity { left:calc(var(--gl) + 110px); top:calc(var(--gt) + 12px); }
.nr-touch .nr-status { right:var(--gr); top:var(--gt); gap:4px !important; }
.nr-touch .nr-chip { font-size:11px !important; padding:3px 9px !important; }
/* speed beside the pedals, clear of the car (which owns bottom-centre) */
.nr-touch .nr-speed { right:calc(var(--gr) + var(--gas-w) + var(--gap) + var(--brk-w) + 14px); bottom:var(--gb);
  padding:6px 12px 8px; border-radius:12px; background:rgba(6,4,10,0.55); }
.nr-touch .nr-minimap { left:var(--gl); top:calc(var(--gt) + 58px); }
.nr-touch .nr-minimap canvas { pointer-events:auto; cursor:pointer; }
.nr-touch .nr-xstreet { font-size:9px !important; white-space:normal !important; line-height:1.4; }
.nr-touch .nr-warning { top:calc(var(--gt) + 64px) !important; }
@media (orientation: landscape) and (max-width: 799px) {
  /* narrow landscape: no room beside the car, ride under the status chips */
  .nr-touch .nr-speed { bottom:auto; right:var(--gr); top:calc(var(--gt) + 62px); padding:4px 10px; }
  /* one low row (speed · MPH · gear · fuel) so it clears DRIFT on short screens */
  .nr-touch .nr-speed-mid { flex-direction:row !important; align-items:center !important; gap:10px; }
  .nr-touch .nr-speed-mid > * { margin-top:0 !important; }
  .nr-touch .nr-speed-mid > .nr-touch-only { width:56px !important; }
}
@media (orientation: portrait) {
  .nr-touch .nr-integrity { left:var(--gl); top:calc(var(--gt) + 56px); }
  .nr-touch .nr-minimap { left:auto; right:var(--gr); top:calc(var(--gt) + 86px); }
  /* portrait: the car fills the lower half, the sky column top-left is free */
  .nr-touch .nr-speed { right:auto; bottom:auto; left:var(--gl); top:calc(var(--gt) + 96px); }
  .nr-touch .nr-warning { top:calc(var(--gt) + 230px) !important; }
}

/* ---- attract / menus ---- */
.nr-touch .nr-a-coin { border:2px solid rgba(255,184,77,0.75); border-radius:14px; padding:14px 30px;
  background:rgba(40,16,4,0.55); box-shadow:0 0 22px rgba(255,140,40,0.35); }
.nr-touch .nr-a-hint { font-size:11px !important; letter-spacing:0.15em !important; }
.nr-touch .nr-a-stamp { font-size:9px !important; letter-spacing:0.08em !important; line-height:1.5 !important; opacity:0.45 !important; }
.nr-touch .nr-a-daily { line-height:1.7 !important; padding:10px 16px !important; }
.nr-touch .nr-pause { pointer-events:auto; }
@media (orientation: portrait) {
  .nr-touch .nr-rotate-hint { display:block; }
}
@media (orientation: landscape) and (max-height: 500px) {
  .nr-touch .nr-a-hint { display:none; }
  .nr-touch .nr-a-presents { margin-bottom:4px !important; }
  .nr-touch .nr-a-coin { padding:10px 26px; }
  .nr-touch .nr-a-daily { line-height:1.45 !important; padding:6px 14px !important; }
}
`;

let installed = 0;

/** inject the base sheet, plus the touch layout when `touch` (idempotent) */
export function installHudStyles(touch: boolean) {
  const want = touch ? 2 : 1;
  if (installed >= want) return;
  const style = document.createElement('style');
  style.textContent = (installed < 1 ? BASE_CSS : '') + (touch ? TOUCH_CSS : '');
  document.head.appendChild(style);
  if (touch) document.body.classList.add('nr-touch');
  installed = want;
}
