import * as THREE from 'three';
import type RAPIER_API from '@dimforge/rapier3d-compat';
import { TUNING, G_ALL, G_GROUND, G_CHASSIS, G_BUILDING, G_TRAFFIC, groups } from './tuning';
import { SPAWN, elevationAt } from './city';
import { buildCarModel, type CarModel } from './carModel';
import type { Input } from './input';
import type { Particles } from './particles';

// Rapier DynamicRayCastVehicleController wrapper. Car forward = local +Z.
// Wheel order: 0 FL, 1 FR, 2 RL, 3 RR. RWD by default (TUNING.awd blends).
// Wheel hardpoints/radius come from the car model (real positions when glTF).

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _local = new THREE.Vector3();

export class PlayerVehicle {
  body: RAPIER_API.RigidBody;
  controller: RAPIER_API.DynamicRayCastVehicleController;
  model: CarModel;
  hullColl: RAPIER_API.Collider;
  ballastColl: RAPIER_API.Collider;

  // telemetry
  speed = 0;
  forwardSpeed = 0;
  slipAngle = 0;
  drifting = false;
  braking = false;
  handbraking = false;
  onGround = false;
  /** terrain slope along heading (m per m, + = downhill) from the real DEM */
  slope = 0;

  /** set true when totaled — controller stops driving, chassis tumbles freely */
  disabled = false;
  /** set true when fuel runs out — engine dead, everything else works */
  fuelEmpty = false;

  prevPos = new THREE.Vector3();
  currPos = new THREE.Vector3();
  prevQuat = new THREE.Quaternion();
  currQuat = new THREE.Quaternion();

  private steer = 0;
  private scene: THREE.Scene;
  private world: RAPIER_API.World;
  private RAPIER: typeof RAPIER_API;

  constructor(world: RAPIER_API.World, scene: THREE.Scene, RAPIER: typeof RAPIER_API) {
    this.world = world;
    this.scene = scene;
    this.RAPIER = RAPIER;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(SPAWN.x, 1.2, SPAWN.z)
      .setCanSleep(false)
      .setAngularDamping(0.6)
      .setLinearDamping(0.04);
    this.body = world.createRigidBody(bodyDesc);

    const hullDesc = RAPIER.ColliderDesc.cuboid(0.92, 0.28, 2.15).setFriction(0.35).setRestitution(0.15);
    this.hullColl = world.createCollider(hullDesc, this.body);
    this.hullColl.setCollisionGroups(
      groups(G_CHASSIS, G_GROUND | G_BUILDING | G_TRAFFIC)
    );
    const ballastDesc = RAPIER.ColliderDesc.cuboid(0.55, 0.09, 1.1)
      .setTranslation(0, TUNING.comHeight, 0)
      .setSensor(false);
    this.ballastColl = world.createCollider(ballastDesc, this.body);
    this.ballastColl.setCollisionGroups(groups(G_CHASSIS, 0)); // mass only, no contacts

    this.model = buildCarModel(scene);

    const controller = world.createVehicleController(this.body);
    controller.indexUpAxis = 1;
    controller.setIndexForwardAxis = 2;
    for (const p of this.model.wheelPositions) {
      controller.addWheel(p, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, TUNING.suspRest, this.model.wheelRadius);
    }
    this.controller = controller;

    this.applyTuning();
    this.snapTransforms();
  }

  applyTuning() {
    const t = TUNING;
    this.hullColl.setMass(t.mass * 0.45);
    this.ballastColl.setMass(t.mass * 0.55);
    this.ballastColl.setTranslationWrtParent({ x: 0, y: t.comHeight, z: 0 });
    for (let i = 0; i < 4; i++) {
      const c = this.controller;
      c.setWheelSuspensionRestLength(i, t.suspRest);
      c.setWheelSuspensionStiffness(i, t.suspStiffness);
      c.setWheelSuspensionCompression(i, t.suspDampCompression);
      c.setWheelSuspensionRelaxation(i, t.suspDampRelaxation);
      c.setWheelMaxSuspensionTravel(i, t.suspTravel);
      c.setWheelMaxSuspensionForce(i, 90000);
      c.setWheelFrictionSlip(i, 10.5);
      c.setWheelSideFrictionStiffness(i, i < 2 ? t.frontGrip : t.rearGrip);
      c.setWheelRadius(i, this.model.wheelRadius);
    }
  }

  update(input: Input, dt: number) {
    if (this.disabled) return;
    const t = TUNING;
    const c = this.controller;

    // pseudo-gravity along the REAL terrain slope. slopeForce is a gravity
    // multiplier: 1 ≈ physically true m·g·sin(θ), default exaggerates for feel.
    this.slope = 0;
    if (t.slopeForce > 0) {
      const pos = this.body.translation();
      const rot = this.body.rotation();
      _fwd.set(0, 0, 1).applyQuaternion(_q.set(rot.x, rot.y, rot.z, rot.w));
      _fwd.y = 0;
      if (_fwd.lengthSq() > 0.1) {
        _fwd.normalize();
        const look = 16;
        this.slope =
          (elevationAt(pos.x, pos.z) - elevationAt(pos.x + _fwd.x * look, pos.z + _fwd.z * look)) / look;
        if (Math.abs(this.slope) > 0.004) {
          const imp = this.slope * t.slopeForce * 9.8 * t.mass * dt;
          this.body.applyImpulse({ x: _fwd.x * imp, y: 0, z: _fwd.z * imp }, true);
        }
      }
    }

    // velocity in chassis space
    const lv = this.body.linvel();
    _vel.set(lv.x, lv.y, lv.z);
    this.speed = _vel.length();
    const rot = this.body.rotation();
    _q.set(rot.x, rot.y, rot.z, rot.w);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    this.forwardSpeed = _vel.dot(_fwd);
    _local.copy(_vel).applyQuaternion(_q.clone().invert());
    this.slipAngle =
      this.speed > 3 ? Math.atan2(Math.abs(_local.x), Math.abs(_local.z)) : 0;
    this.drifting = this.slipAngle > 0.16 && this.speed > 6;
    this.onGround =
      c.wheelIsInContact(0) || c.wheelIsInContact(1) || c.wheelIsInContact(2) || c.wheelIsInContact(3);

    // ---- steering (tightens with speed) ----
    const steerMax = t.steerMax / (1 + Math.max(0, this.forwardSpeed) * t.steerSpeedDrop);
    const target = input.steer * steerMax;
    const k = 1 - Math.exp(-t.steerSpeed * dt);
    this.steer += (target - this.steer) * k;
    c.setWheelSteering(0, this.steer);
    c.setWheelSteering(1, this.steer);

    // ---- engine / brakes ----
    let drive = 0;
    let brake = 0.7; // rolling drag
    this.braking = false;
    this.handbraking = input.handbrake;

    const falloff = Math.max(0, 1 - Math.max(0, this.forwardSpeed) / t.maxSpeed);
    if (input.throttle > 0 && !this.fuelEmpty) {
      if (this.forwardSpeed < -0.5) {
        brake = t.brakeForce; // braking out of reverse
        this.braking = true;
      } else {
        drive = t.enginePower * (0.3 + 0.7 * falloff);
      }
    }
    if (input.brake > 0) {
      if (this.forwardSpeed > 0.5) {
        brake = t.brakeForce;
        this.braking = true;
      } else if (!this.fuelEmpty) {
        drive = this.forwardSpeed > -13 ? -t.enginePower * 0.45 : 0; // reverse
      }
    }

    const rearForce = drive * (1 - 0.5 * t.awd);
    const frontForce = drive * 0.5 * t.awd;
    c.setWheelEngineForce(0, frontForce / 2);
    c.setWheelEngineForce(1, frontForce / 2);
    c.setWheelEngineForce(2, rearForce / 2);
    c.setWheelEngineForce(3, rearForce / 2);

    // front-biased brakes = nose dive
    c.setWheelBrake(0, brake * 0.62);
    c.setWheelBrake(1, brake * 0.62);
    c.setWheelBrake(2, brake * 0.38 + (input.handbrake ? t.brakeForce * 1.1 : 0));
    c.setWheelBrake(3, brake * 0.38 + (input.handbrake ? t.brakeForce * 1.1 : 0));

    // ---- tire model: rear grip fades past slip threshold + handbrake cut ----
    const slipFade = THREE.MathUtils.smoothstep(this.slipAngle, 0.16, 0.62);
    let rearGrip = t.rearGrip * (1 - t.driftGripDrop * slipFade);
    // power-on oversteer
    rearGrip *= 1 - 0.12 * input.throttle * Math.abs(this.steer) / Math.max(0.05, steerMax);
    if (input.handbrake) rearGrip = t.rearGrip * t.handbrakeGripCut;
    c.setWheelSideFrictionStiffness(2, rearGrip);
    c.setWheelSideFrictionStiffness(3, rearGrip);
    c.setWheelSideFrictionStiffness(0, t.frontGrip);
    c.setWheelSideFrictionStiffness(1, t.frontGrip);

    // drift recoverability: damp yaw as slip grows so it doesn't snap around
    this.body.setAngularDamping(0.6 + slipFade * 1.4);

    // downforce
    if (this.onGround) {
      const df = t.downforce * this.speed * this.speed * dt;
      this.body.applyImpulse({ x: 0, y: -df, z: 0 }, true);
    }

    c.updateVehicle(dt, undefined, groups(G_ALL, G_GROUND));
  }

  /** call right after world.step() */
  postStep() {
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    const p = this.body.translation();
    const r = this.body.rotation();
    this.currPos.set(p.x, p.y, p.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
  }

  private snapTransforms() {
    const p = this.body.translation();
    const r = this.body.rotation();
    this.currPos.set(p.x, p.y, p.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
  }

  syncVisuals(alpha: number) {
    const g = this.model.group;
    g.position.lerpVectors(this.prevPos, this.currPos, alpha);
    g.quaternion.slerpQuaternions(this.prevQuat, this.currQuat, alpha);

    for (let i = 0; i < 4; i++) {
      const w = this.model.wheels[i];
      if (!w.visible) continue;
      const susp = this.controller.wheelSuspensionLength(i) ?? TUNING.suspRest;
      const conn = this.model.wheelPositions[i];
      w.position.set(conn.x, conn.y - susp, conn.z);
      w.rotation.order = 'YXZ';
      w.rotation.y = this.controller.wheelSteering(i) ?? 0;
      w.rotation.x = this.controller.wheelRotation(i) ?? 0;
    }

    this.model.brakeMat.emissiveIntensity =
      this.braking || this.handbraking ? 7 : 1.2;
  }

  /** tire smoke while drifting + slope flow/drag streaks; call per render frame */
  emitEffects(particles: Particles) {
    if (this.disabled) return;

    // slope readout: blue spill off the tail on descents, red hood-drag climbing
    if (this.onGround && this.speed > 5 && Math.abs(this.slope) > 0.005) {
      if (Math.random() < Math.min(0.95, Math.abs(this.slope) * 55)) {
        this.worldPosition(_v);
        this.forwardDir(_fwd);
        const lv = this.body.linvel();
        _vel.set(lv.x, lv.y, lv.z);
        particles.slopeFlow(_v, _fwd, _vel, this.slope);
      }
    }

    if (!this.drifting || !this.onGround) return;
    if (Math.random() < 0.7) {
      for (const i of [2, 3]) {
        const cp = this.controller.wheelContactPoint(i);
        if (cp) {
          _v.set(cp.x, cp.y + 0.15, cp.z);
          const lv = this.body.linvel();
          _vel.set(lv.x, lv.y, lv.z);
          particles.tireSmoke(_v, _vel);
        }
      }
    }
  }

  worldPosition(out: THREE.Vector3): THREE.Vector3 {
    const p = this.body.translation();
    return out.set(p.x, p.y, p.z);
  }

  forwardDir(out: THREE.Vector3): THREE.Vector3 {
    const r = this.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    return out.set(0, 0, 1).applyQuaternion(_q);
  }

  velocity(out: THREE.Vector3): THREE.Vector3 {
    const lv = this.body.linvel();
    return out.set(lv.x, lv.y, lv.z);
  }

  reset(pos: THREE.Vector3, yaw: number) {
    this.body.setTranslation({ x: pos.x, y: pos.y + 1.0, z: pos.z }, true);
    _q.setFromAxisAngle(_v.set(0, 1, 0), yaw);
    this.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = 0;
    this.disabled = false;
    this.snapTransforms();
    this.syncVisuals(1);
  }

  /** flip rescue (R key): set upright at current spot, keep heading */
  rescue() {
    if (this.disabled) return;
    const p = this.body.translation();
    _fwd.set(0, 0, 1).applyQuaternion(
      _q.set(this.body.rotation().x, this.body.rotation().y, this.body.rotation().z, this.body.rotation().w)
    );
    const yaw = Math.atan2(_fwd.x, _fwd.z);
    this.reset(_v.set(p.x, p.y + 0.4, p.z), yaw);
  }

  /** fresh visual shell after a continue */
  rebuildVisual() {
    this.model.dispose();
    this.model = buildCarModel(this.scene);
    this.syncVisuals(1);
  }
}
