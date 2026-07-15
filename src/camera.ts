import * as THREE from 'three';
import type RAPIER_API from '@dimforge/rapier3d-compat';
import { TUNING, G_ALL, G_BUILDING, groups } from './tuning';
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

  /** slow orbit for the attract screen */
  attract(t: number, center: THREE.Vector3) {
    const r = 14;
    const a = t * 0.18;
    _desired.set(center.x + Math.sin(a) * r, center.y + 4.5, center.z + Math.cos(a) * r);
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
    if (this.smoothedPos.y < 0.4) this.smoothedPos.y = 0.4;

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
