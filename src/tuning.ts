// Central live-tunable parameter block. The dev panel (P key) binds sliders to
// these values; vehicle.applyTuning() must be called after changing vehicle keys.

export const TUNING = {
  // ---- vehicle ----
  mass: 1250,            // kg
  enginePower: 9500,     // N total drive force at standstill
  brakeForce: 55,        // per-wheel brake strength (bullet-style)
  suspStiffness: 34,     // suspension spring (per-mass, bullet-style)
  suspDampCompression: 3.4,
  suspDampRelaxation: 4.8,
  suspTravel: 0.24,      // m
  suspRest: 0.32,        // m
  frontGrip: 1.12,       // side friction stiffness, front axle
  rearGrip: 0.98,        // side friction stiffness, rear axle
  handbrakeGripCut: 0.2, // rear grip multiplier while SPACE held
  driftGripDrop: 0.35,   // how much rear grip fades as slip angle grows
  steerSpeed: 7.0,       // how fast steering approaches target
  steerMax: 0.6,         // rad at standstill
  steerSpeedDrop: 0.02,  // steering tightens with speed
  downforce: 3.2,        // N per (m/s)^2
  slopeForce: 2.2,       // pseudo-gravity impulse down terrain slopes (tunable)
  comHeight: -0.28,      // ballast height relative to chassis center (lower = more stable)
  maxSpeed: 57,          // m/s (~127 mph)
  awd: 0,                // 0 = RWD, 1 = AWD

  // ---- camera ----
  camDistance: 6.6,
  camHeight: 2.5,
  camFovBase: 62,
  camFovMax: 82,
  camLag: 4.6,
  camDriftTrail: 0.45,   // how much the camera follows velocity vs facing in a drift
  fpsCap: 0,             // render fps limit; 0 = uncapped (physics always 60 Hz)

  // ---- crash ----
  crashDvGlance: 4.2,    // m/s velocity delta in one step = glancing hit
  crashDvHard: 10.5,     // m/s velocity delta = totaled
  crashSlowmo: 0.25,     // timescale during impact slow-mo
  crashSlowmoTime: 0.85, // seconds of slow-mo
  crashShake: 1.0,       // screen shake multiplier

  // ---- world ----
  fuelDrainBase: 0.32,   // fuel/s at rest
  fuelDrainSpeed: 0.022, // extra fuel/s per m/s
};

export type Tuning = typeof TUNING;
export const TUNING_DEFAULTS: Tuning = { ...TUNING };

// Collision group bits (memberships << 16 | filter)
export const G_GROUND = 0x0001;
export const G_BUILDING = 0x0002;
export const G_CHASSIS = 0x0004;
export const G_PART = 0x0008;
export const G_TRAFFIC = 0x0010;
export const G_ALL = 0xffff;

export function groups(member: number, filter: number): number {
  return (member << 16) | filter;
}
