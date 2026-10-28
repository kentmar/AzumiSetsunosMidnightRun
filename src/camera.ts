import * as THREE from 'three';
import type RAPIER_API from '@dimforge/rapier3d-compat';
import { TUNING, G_ALL, G_BUILDING, groups } from './tuning';
import { WATER_Y, elevationAt } from './city';
import type { PlayerVehicle } from './vehicle';
import type { CrashSystem } from './crash';

// Spring-arm chase camera. Smooth-lerped position + look target; a ray from the
// car to the (smoothed) camera position is cast against buildings every frame
// and the arm is hard-clamped to the hit point so the camera never enters walls.

const _desired = new THREE.Vector3();
const _carPos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _look = new THREE.Vector3();
const _shake = new THREE.Vector3();

/** [forward, up, right] metres in the car's frame; up is above the car */
type V3 = [number, number, number];
interface Shot {
  dur: number;
  fov: [number, number];
  from: V3;
  to: V3;
  lookFrom: V3;
  lookTo: V3;
  /** 'car' (default): offsets read off the car's heading. 'city': off the
   *  car -> midtown axis, and never mirrored, so the skyline stays in frame. */
  anchor?: 'car' | 'city';
}
interface ResolvedShot {
  dur: number;
  fov: [number, number];
  from: THREE.Vector3;
  to: THREE.Vector3;
  lookFrom: THREE.Vector3;
  lookTo: THREE.Vector3;
}

// Midtown's own centre of mass — the Empire State / 5th Avenue cluster. The
// wide shot is framed along the car -> skyline axis rather than the car's
// bumper, so it opens on the city no matter which way the Supra is parked.
const CITY_HEART = new THREE.Vector3(40, 0, -280);

// The intro. Three cuts, each one closer, then the attract orbit.
export const INTRO_SHOTS: Shot[] = [
  // 1 WIDE: high and back, craning down the skyline axis. A long push toward
  //   the towers with the car still far below — the city is the shot.
  {
    dur: 5.6, fov: [62, 52],
    from: [-620, 330, 210], to: [-360, 215, 95],
    lookFrom: [420, 150, -30], lookTo: [320, 60, -15],
    anchor: 'city',
  },
  // 2 MEDIUM: front three-quarter, dropping from roof height to headlight
  //   height as it closes in. First proper look at the Supra.
  {
    dur: 3.4, fov: [42, 37],
    from: [15.5, 5.6, -9.5], to: [6.4, 1.7, -4.6],
    lookFrom: [0.4, 1.0, 0], lookTo: [0.2, 0.8, 0],
  },
  // 3 CLOSE: low and tight along the flank, rear quarter running up to the
  //   front wheel, long lens. Ends with the car still filling the frame.
  {
    dur: 3.2, fov: [34, 34],
    from: [-6.4, 0.85, 6.4], to: [5.2, 0.85, 7.5],
    lookFrom: [-1.0, 0.55, 0], lookTo: [-0.2, 0.55, 0],
  },
];

const ease = (k: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, k)));

function sampleShot(s: ResolvedShot, k: number, pos: THREE.Vector3, look: THREE.Vector3) {
  const e = ease(k);
  pos.lerpVectors(s.from, s.to, e);
  look.lerpVectors(s.lookFrom, s.lookTo, e);
}

export class ChaseCamera {
  cam: THREE.PerspectiveCamera;
  private smoothedPos = new THREE.Vector3(0, 6, -215);
  private smoothedLook = new THREE.Vector3();
  private ray: RAPIER_API.Ray;

  constructor(private world: RAPIER_API.World, RAPIER: typeof RAPIER_API) {
    this.cam = new THREE.PerspectiveCamera(TUNING.camFovBase, innerWidth / innerHeight, 0.1, 4000);
    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  }

  /** hard-place the camera behind the car (run start, respawn, tunnel warp) */
  snap(vehicle: PlayerVehicle) {
    vehicle.worldPosition(_carPos);
    vehicle.forwardDir(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 0.01) _fwd.set(0, 0, 1);
    _fwd.normalize();
    this.smoothedPos.copy(_carPos).addScaledVector(_fwd, -TUNING.camDistance);
    this.smoothedPos.y = _carPos.y + TUNING.camHeight + 0.2;
    this.smoothedLook.copy(_carPos).addScaledVector(_fwd, 2.2);
    this.smoothedLook.y = _carPos.y + 1.0;
    this.cam.position.copy(this.smoothedPos);
    this.cam.lookAt(this.smoothedLook);
  }

  /* ---------- attract intro: three hard cuts, then the orbit ----------
     Shot offsets live in the car's own frame (forward, up, right) so the
     sequence frames the Supra wherever it spawns. Each shot is checked against
     building colliders when the intro starts and mirrored or swung round if a
     tower would fill the lens.                                              */
  private introT = -1; // seconds into the intro; <0 = not playing
  private introShots: ResolvedShot[] = [];
  private introShot = -1;
  /** dev: pin the intro clock (seconds) to inspect a frame; undefined = live */
  introFreeze?: number;

  get introActive() {
    return this.introT >= 0;
  }

  /** begin the cinematic: called whenever the game enters the attract screen */
  startIntro(vehicle: PlayerVehicle) {
    vehicle.worldPosition(_carPos);
    vehicle.forwardDir(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 0.01) _fwd.set(0, 0, 1);
    _fwd.normalize();
    const center = _carPos.clone();
    // axis for city-anchored shots: from the car toward midtown's heart
    const cityAxis = CITY_HEART.clone().sub(center).setY(0);
    if (cityAxis.lengthSq() < 1) cityAxis.copy(_fwd);
    cityAxis.normalize();
    this.introShots = INTRO_SHOTS.map((s) =>
      this.resolveShot(s, center, s.anchor === 'city' ? cityAxis : _fwd, s.anchor === 'city')
    );
    this.introT = 0;
    this.introShot = -1;
  }

  /** any key or tap: drop straight into the orbit */
  skipIntro() {
    if (this.introT < 0) return;
    this.introT = -1;
    this.landOrbit = true;
  }

  private landOrbit = false;

  /** pick the facing (as authored, mirrored, or swung round) with the clearest sightlines */
  private resolveShot(s: Shot, center: THREE.Vector3, fwd: THREE.Vector3, lockFwd = false): ResolvedShot {
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    // [fwdSign, sideSign] — a city-anchored shot may only flip sides, never
    // turn its back on the skyline
    const variants: [number, number][] = lockFwd
      ? [[1, 1], [1, -1]]
      : [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    let best: ResolvedShot | null = null;
    let bestBlocked = Infinity;
    for (const [fs, ss] of variants) {
      const f = fwd.clone().multiplyScalar(fs);
      const r = right.clone().multiplyScalar(ss);
      const toWorld = (o: V3, out = new THREE.Vector3()) =>
        out.copy(center).addScaledVector(f, o[0]).addScaledVector(r, o[2]).setY(center.y + o[1]);
      const shot: ResolvedShot = {
        dur: s.dur, fov: s.fov,
        from: toWorld(s.from), to: toWorld(s.to),
        lookFrom: toWorld(s.lookFrom), lookTo: toWorld(s.lookTo),
      };
      let blocked = 0;
      for (const k of [0, 0.5, 1]) {
        sampleShot(shot, k, _origin, _look);
        if (!this.clearLine(_look, _origin)) blocked++;
      }
      if (blocked < bestBlocked) {
        best = shot;
        bestBlocked = blocked;
      }
      if (blocked === 0) break;
    }
    return best!;
  }

  private clearLine(a: THREE.Vector3, b: THREE.Vector3) {
    _arm.copy(b).sub(a);
    const len = _arm.length();
    if (len < 0.01) return true;
    _arm.divideScalar(len);
    this.ray.origin.x = a.x;
    this.ray.origin.y = a.y;
    this.ray.origin.z = a.z;
    this.ray.dir.x = _arm.x;
    this.ray.dir.y = _arm.y;
    this.ray.dir.z = _arm.z;
    return !this.world.castRay(this.ray, len, true, undefined, groups(G_ALL, G_BUILDING));
  }

  /** advance the intro; returns false once it has handed over to the orbit */
  private playIntro(dt: number) {
    if (this.introFreeze !== undefined) this.introT = this.introFreeze;
    else this.introT += dt;
    let t = this.introT;
    let i = 0;
    while (i < this.introShots.length && t >= this.introShots[i].dur) {
      t -= this.introShots[i].dur;
      i++;
    }
    if (i >= this.introShots.length) {
      this.introT = -1;
      this.landOrbit = true;
      return false;
    }
    const shot = this.introShots[i];
    const k = t / shot.dur;
    sampleShot(shot, k, _desired, _look);
    // never under the street: the city has real altimetry
    const floor = elevationAt(_desired.x, _desired.z) + 0.35;
    if (_desired.y < floor) _desired.y = floor;
    // hard cut: every shot is placed exactly, no smoothing between them
    this.smoothedPos.copy(_desired);
    this.smoothedLook.copy(_look);
    this.introShot = i;
    this.cam.position.copy(_desired);
    this.cam.lookAt(_look);
    this.cam.fov = shot.fov[0] + (shot.fov[1] - shot.fov[0]) * k;
    this.cam.updateProjectionMatrix();
    return true;
  }

  /** attract screen: the intro cuts, then the slow orbit */
  attract(t: number, center: THREE.Vector3, dt = 1 / 60) {
    if (this.introT >= 0 && this.playIntro(dt)) return;
    const r = 14;
    const a = t * 0.18;
    _desired.set(center.x + Math.sin(a) * r, center.y + 4.5, center.z + Math.cos(a) * r);
    if (this.landOrbit) {
      // final cut lands exactly on the orbit track — no drift-in, so the
      // attract rotation looks and feels the same as it always has
      this.landOrbit = false;
      this.smoothedPos.copy(_desired);
      this.smoothedLook.set(center.x, center.y + 1, center.z);
      this.cam.fov = 58;
      this.cam.updateProjectionMatrix();
    }
    this.smoothedPos.lerp(_desired, 0.03);
    this.cam.position.copy(this.smoothedPos);
    this.smoothedLook.lerp(_look.set(center.x, center.y + 1, center.z), 0.05);
    this.cam.lookAt(this.smoothedLook);
    this.cam.fov += (58 - this.cam.fov) * 0.02;
    this.cam.updateProjectionMatrix();
  }

  update(dt: number, vehicle: PlayerVehicle, crash: CrashSystem) {
    const t = TUNING;
    vehicle.worldPosition(_carPos);

    if (crash.crashCamActive) {
      // impact override: swing to the dramatic angle, keep looking at the car
      this.smoothedPos.lerp(crash.crashCamPos, 1 - Math.exp(-6 * dt));
      this.smoothedLook.lerp(_look.copy(_carPos).add(_dir.set(0, 0.8, 0)), 1 - Math.exp(-10 * dt));
      this.applyShake(crash.shake);
      this.cam.lookAt(this.smoothedLook);
      this.cam.fov += (55 - this.cam.fov) * (1 - Math.exp(-4 * dt));
      this.cam.updateProjectionMatrix();
      return;
    }

    vehicle.forwardDir(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 0.01) _fwd.set(0, 0, 1);
    _fwd.normalize();

    // in a drift, trail the velocity vector for cinematic framing
    vehicle.velocity(_vel);
    _vel.y = 0;
    const speed01 = Math.min(1, vehicle.speed / t.maxSpeed);
    _dir.copy(_fwd);
    if (vehicle.drifting && _vel.lengthSq() > 4) {
      _vel.normalize();
      _dir.lerp(_vel, t.camDriftTrail).normalize();
    }
    // reversing: look behind
    if (vehicle.forwardSpeed < -2) _dir.copy(_fwd).multiplyScalar(-1);

    const dist = t.camDistance * (1 + 0.4 * speed01);
    const height = t.camHeight * (1 - 0.18 * speed01) + 0.2;
    _desired.copy(_carPos).addScaledVector(_dir, -dist);
    _desired.y = _carPos.y + height;

    // teleport detection (spawn/respawn): snap instead of flying across the map
    if (this.smoothedPos.distanceToSquared(_carPos) > 60 * 60) {
      this.smoothedPos.copy(_desired);
      this.smoothedLook.copy(_carPos);
    }

    // spring-arm smoothing (latency presses the view on hard accel)
    const k = 1 - Math.exp(-t.camLag * dt);
    this.smoothedPos.lerp(_desired, k);

    // collision: car -> camera; clamp arm so we never enter a building
    _origin.copy(_carPos).add(_look.set(0, 0.9, 0));
    _arm.copy(this.smoothedPos).sub(_origin);
    const armLen = _arm.length();
    if (armLen > 0.3) {
      _arm.divideScalar(armLen);
      this.ray.origin.x = _origin.x;
      this.ray.origin.y = _origin.y;
      this.ray.origin.z = _origin.z;
      this.ray.dir.x = _arm.x;
      this.ray.dir.y = _arm.y;
      this.ray.dir.z = _arm.z;
      const hit = this.world.castRay(this.ray, armLen, true, undefined, groups(G_ALL, G_BUILDING));
      if (hit) {
        const d = Math.max(0.8, hit.timeOfImpact - 0.35);
        this.smoothedPos.copy(_origin).addScaledVector(_arm, d);
      }
    }
    // keep the camera out of the road, but follow the car into the tunnel
    // sub-layer instead of snapping back to street level
    const minY = Math.min(0.4, _carPos.y + 0.9);
    if (this.smoothedPos.y < minY) this.smoothedPos.y = minY;
    // past the seawall the camera stays locked above the surface while the car sinks
    if (vehicle.underwater && this.smoothedPos.y < WATER_Y + 0.7) {
      this.smoothedPos.y = WATER_Y + 0.7;
    }

    // look target slightly ahead of the car
    _look.copy(_carPos).addScaledVector(_fwd, 2.2 + 4 * speed01);
    _look.y = _carPos.y + 1.0;
    this.smoothedLook.lerp(_look, 1 - Math.exp(-8 * dt));

    // shake: crash + high-speed rumble
    this.applyShake(crash.shake + speed01 * speed01 * 0.045);
    this.cam.lookAt(this.smoothedLook);

    // FOV widens with speed
    const fovT = Math.pow(speed01, 1.25);
    const targetFov = t.camFovBase + (t.camFovMax - t.camFovBase) * fovT + (vehicle.drifting ? 2 : 0);
    this.cam.fov += (targetFov - this.cam.fov) * (1 - Math.exp(-5 * dt));
    this.cam.updateProjectionMatrix();
  }

  private applyShake(mag: number) {
    _shake.set(
      (Math.random() - 0.5) * mag * 0.3,
      (Math.random() - 0.5) * mag * 0.22,
      (Math.random() - 0.5) * mag * 0.3
    );
    this.cam.position.copy(this.smoothedPos).add(_shake);
  }

  resize() {
    this.cam.aspect = innerWidth / innerHeight;
    this.cam.updateProjectionMatrix();
  }
}
