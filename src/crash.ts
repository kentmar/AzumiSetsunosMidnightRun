import * as THREE from 'three';
import type RAPIER_API from '@dimforge/rapier3d-compat';
import { TUNING, G_ALL, G_GROUND, G_BUILDING, G_PART, G_TRAFFIC, groups } from './tuning';
import type { PlayerVehicle } from './vehicle';
import type { Particles } from './particles';

// Burnout-lite impact system. Impacts are detected as one-step velocity deltas on
// the chassis (robust, no contact-event plumbing): glancing hits dent + shed a
// panel + cost health; hard hits total the car, shedding wheels + panels, with
// slow-mo + crash cam + shake resolving into the credit-continue loop.

interface Detached {
  body: RAPIER_API.RigidBody;
  mesh: THREE.Object3D;
  prev: { p: THREE.Vector3; q: THREE.Quaternion };
  curr: { p: THREE.Vector3; q: THREE.Quaternion };
  ttl: number;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _cp = new THREE.Vector3();
const _cd = new THREE.Vector3();
const _cq = new THREE.Quaternion();

export class CrashSystem {
  health = 100;
  totaled = false;
  timeScale = 1;
  shake = 0;

  crashCamActive = false;
  crashCamPos = new THREE.Vector3();

  private slowmoT = 0;
  private easeT = 0;
  private graceT = 1.5;
  private resolveT = -1;
  private resolveReason = '';
  private prevVel = new THREE.Vector3();
  private detached: Detached[] = [];
  private crashCamT = 0;

  constructor(
    private world: RAPIER_API.World,
    private RAPIER: typeof RAPIER_API,
    private scene: THREE.Scene,
    private vehicle: PlayerVehicle,
    private particles: Particles,
    private onFlash: (strength: number) => void,
    private onTotaled: (reason: string) => void
  ) {
    vehicle.velocity(this.prevVel);
  }

  /** call right after world.step(); dt = fixed step */
  postStep(dt: number) {
    this.vehicle.velocity(_v);
    _v2.copy(this.prevVel);
    this.prevVel.copy(_v);
    if (this.graceT > 0) {
      this.graceT -= dt;
      return;
    }
    if (this.totaled) return;

    const dv = _v2.sub(_v).length(); // (prev - now): points toward the obstacle
    if (dv < TUNING.crashDvGlance) return;
    const impactDir = _v2.normalize(); // world-space direction of the hit
    this.impact(dv, impactDir);
  }

  private impact(dv: number, dirWorld: THREE.Vector3) {
    const hard = dv >= TUNING.crashDvHard;
    this.health -= (dv - TUNING.crashDvGlance) * 6 + 4;

    // local direction decides which panels take it
    const r = this.vehicle.body.rotation();
    _qi.set(r.x, r.y, r.z, r.w).invert();
    _v.copy(dirWorld).applyQuaternion(_qi);

    this.vehicle.worldPosition(_p).addScaledVector(dirWorld, 1.8);
    _p.y = Math.max(_p.y, 0.4);

    this.particles.burstSparks(_p, dirWorld, Math.min(60, 14 + dv * 4), 6 + dv * 0.6);
    if (dv > 6) this.particles.burstSmoke(_p, Math.min(20, Math.floor(dv * 1.6)));

    this.crumple(dirWorld, _p, dv);

    // shed panels by impact side
    const shed: string[] = [];
    if (_v.z > 0.5) {
      shed.push('frontBumper');
      if (dv > 7) shed.push('hood');
    } else if (_v.z < -0.5) {
      shed.push('rearBumper');
    }
    if (_v.x > 0.55) shed.push('doorL');
    if (_v.x < -0.55) shed.push('doorR');
    if (shed.length === 0 && dv > 6) shed.push('frontBumper');

    const willTotal = hard || this.health <= 0;
    if (willTotal) {
      shed.push('hood', 'frontBumper', 'rearBumper', 'doorL', 'doorR');
    }
    for (const name of shed) this.detachPart(name, dirWorld, dv);

    this.shake = Math.min(1.6, (dv / 9) * TUNING.crashShake);
    this.onFlash(Math.min(1, dv / 14));

    if (willTotal) this.total('WRECKED', dirWorld, dv);
    else this.graceT = 0.35; // don't double-count one collision
  }

  private total(reason: string, dirWorld: THREE.Vector3, dv: number) {
    this.totaled = true;
    this.vehicle.disabled = true;
    this.health = 0;
    for (let i = 0; i < 4; i++) this.detachWheel(i, dirWorld, dv);
    for (const n of ['hood', 'frontBumper', 'rearBumper', 'doorL', 'doorR']) {
      this.detachPart(n, dirWorld, dv);
    }
    // kick the dead chassis so it tumbles
    const m = TUNING.mass;
    this.vehicle.body.applyImpulse({ x: dirWorld.x * -m * 1.5, y: m * 3.2, z: dirWorld.z * -m * 1.5 }, true);
    this.vehicle.body.applyTorqueImpulse(
      { x: (Math.random() - 0.5) * m * 3, y: (Math.random() - 0.5) * m * 2, z: (Math.random() - 0.5) * m * 3 },
      true
    );

    // slow-mo + crash cam
    this.slowmoT = TUNING.crashSlowmoTime;
    this.easeT = 0;
    this.timeScale = TUNING.crashSlowmo;
    this.crashCamT = 1.9;
    this.crashCamActive = true;
    this.vehicle.worldPosition(_p);
    _v.copy(dirWorld).cross(_v2.set(0, 1, 0)).normalize();
    if (_v.lengthSq() < 0.1) _v.set(1, 0, 0);
    this.crashCamPos
      .copy(_p)
      .addScaledVector(_v, Math.random() < 0.5 ? 7.5 : -7.5)
      .addScaledVector(dirWorld, -3)
      .add(_v2.set(0, 2.8, 0));
    this.shake = 1.6 * TUNING.crashShake;

    this.resolveT = 2.1;
    this.resolveReason = reason;
    this.particles.burstSmoke(_p, 26);
  }

  /** boundary detonation / out-of-fuel: total without a collision */
  forceTotal(reason: string) {
    if (this.totaled) return;
    this.vehicle.velocity(_v);
    const dir = _v.lengthSq() > 1 ? _v.normalize() : _v.set(0, 0, 1);
    this.vehicle.worldPosition(_p);
    this.particles.burstSparks(_p, dir, 70, 12);
    this.particles.burstSmoke(_p, 30);
    this.onFlash(1);
    this.total(reason, dir, 12);
  }

  private detachPart(name: string, dirWorld: THREE.Vector3, dv: number) {
    const part = this.vehicle.model.parts.get(name);
    if (!part || !part.attached) return;
    part.attached = false;
    part.mesh.visible = true; // glTF car keeps panels hidden until they fly off

    part.mesh.getWorldPosition(_p);
    part.mesh.getWorldQuaternion(_q);
    this.vehicle.model.group.remove(part.mesh);
    this.scene.add(part.mesh);
    part.mesh.position.copy(_p);
    part.mesh.quaternion.copy(_q);

    const desc = this.RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(_p.x, _p.y, _p.z)
      .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
      .setAngularDamping(0.8)
      .setLinearDamping(0.25);
    const body = this.world.createRigidBody(desc);
    const coll = this.world.createCollider(
      this.RAPIER.ColliderDesc.cuboid(part.size.x / 2, part.size.y / 2, part.size.z / 2)
        .setFriction(0.6)
        .setRestitution(0.35),
      body
    );
    coll.setMass(14);
    coll.setCollisionGroups(groups(G_PART, G_GROUND | G_BUILDING | G_PART | G_TRAFFIC));

    this.vehicle.velocity(_v);
    body.setLinvel(
      {
        x: _v.x * 0.75 + (Math.random() - 0.5) * 5,
        y: Math.abs(_v.y) * 0.4 + 2.5 + Math.random() * dv * 0.35,
        z: _v.z * 0.75 + (Math.random() - 0.5) * 5,
      },
      true
    );
    body.setAngvel(
      { x: (Math.random() - 0.5) * 14, y: (Math.random() - 0.5) * 14, z: (Math.random() - 0.5) * 14 },
      true
    );
    this.track(body, part.mesh);
  }

  private detachWheel(i: number, _dirWorld: THREE.Vector3, dv: number) {
    const wheel = this.vehicle.model.wheels[i];
    if (!wheel.visible) return;
    wheel.getWorldPosition(_p);
    wheel.getWorldQuaternion(_q);
    wheel.visible = false;

    // clone a standalone wheel mesh
    const mesh = wheel.clone(true);
    mesh.visible = true;
    this.scene.add(mesh);
    mesh.position.copy(_p);
    mesh.quaternion.copy(_q);

    const desc = this.RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(_p.x, _p.y, _p.z)
      .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
      .setAngularDamping(1.2)
      .setLinearDamping(0.3);
    const body = this.world.createRigidBody(desc);
    const rot = Math.SQRT1_2;
    const coll = this.world.createCollider(
      this.RAPIER.ColliderDesc.cylinder(0.14, 0.35)
        .setRotation({ x: 0, y: 0, z: rot, w: rot }) // axis -> local X
        .setFriction(0.9)
        .setRestitution(0.4),
      body
    );
    coll.setMass(20);
    coll.setCollisionGroups(groups(G_PART, G_GROUND | G_BUILDING | G_PART | G_TRAFFIC));

    this.vehicle.velocity(_v);
    body.setLinvel(
      {
        x: _v.x * 0.8 + (Math.random() - 0.5) * (4 + dv * 0.5),
        y: 3 + Math.random() * dv * 0.45,
        z: _v.z * 0.8 + (Math.random() - 0.5) * (4 + dv * 0.5),
      },
      true
    );
    body.setAngvel(
      { x: (Math.random() - 0.5) * 20, y: (Math.random() - 0.5) * 8, z: (Math.random() - 0.5) * 20 },
      true
    );
    this.track(body, mesh);
  }

  private track(body: RAPIER_API.RigidBody, mesh: THREE.Object3D) {
    const p = body.translation();
    const r = body.rotation();
    const d: Detached = {
      body,
      mesh,
      prev: { p: new THREE.Vector3(p.x, p.y, p.z), q: new THREE.Quaternion(r.x, r.y, r.z, r.w) },
      curr: { p: new THREE.Vector3(p.x, p.y, p.z), q: new THREE.Quaternion(r.x, r.y, r.z, r.w) },
      ttl: 14,
    };
    this.detached.push(d);
  }

  /** cheap vertex-displacement dent on the shell, in shell-local space so it
   *  works for both the greybox box and the glTF body mesh */
  private crumple(dirWorld: THREE.Vector3, impactWorld: THREE.Vector3, dv: number) {
    const shell = this.vehicle.model.shell;
    const geo = shell.geometry as THREE.BufferGeometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    shell.updateWorldMatrix(true, false);
    _cp.copy(impactWorld);
    shell.worldToLocal(_cp);
    shell.getWorldQuaternion(_cq).invert();
    _cd.copy(dirWorld).applyQuaternion(_cq);
    const strength = Math.min(0.3, 0.08 + dv * 0.016);
    const R = 1.4;
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - _cp.x;
      const dy = pos.getY(i) - _cp.y;
      const dz = pos.getZ(i) - _cp.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < R) {
        const f = (1 - d / R) * strength;
        pos.setXYZ(
          i,
          pos.getX(i) - _cd.x * f,
          pos.getY(i) - _cd.y * f * 0.4,
          pos.getZ(i) - _cd.z * f
        );
      }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    // wireframe restyle: regenerate the glow edges so they follow the dent
    (shell.userData.rebuildEdges as (() => void) | undefined)?.();
  }

  /** per-step bookkeeping for detached parts */
  postStepDetached() {
    for (const d of this.detached) {
      d.prev.p.copy(d.curr.p);
      d.prev.q.copy(d.curr.q);
      const p = d.body.translation();
      const r = d.body.rotation();
      d.curr.p.set(p.x, p.y, p.z);
      d.curr.q.set(r.x, r.y, r.z, r.w);
    }
  }

  syncDetached(alpha: number) {
    for (const d of this.detached) {
      d.mesh.position.lerpVectors(d.prev.p, d.curr.p, alpha);
      d.mesh.quaternion.slerpQuaternions(d.prev.q, d.curr.q, alpha);
    }
  }

  /** real (unscaled) dt */
  update(dt: number) {
    this.shake = Math.max(0, this.shake - dt * 2.2);

    if (this.slowmoT > 0) {
      this.slowmoT -= dt;
      this.timeScale = TUNING.crashSlowmo;
      if (this.slowmoT <= 0) this.easeT = 0.35;
    } else if (this.easeT > 0) {
      this.easeT -= dt;
      const f = 1 - Math.max(0, this.easeT / 0.35);
      this.timeScale = TUNING.crashSlowmo + (1 - TUNING.crashSlowmo) * f;
    } else {
      this.timeScale = 1;
    }

    if (this.crashCamT > 0) {
      this.crashCamT -= dt;
      if (this.crashCamT <= 0) this.crashCamActive = false;
    }

    if (this.resolveT > 0) {
      this.resolveT -= dt;
      if (this.resolveT <= 0) {
        this.resolveT = -1;
        this.onTotaled(this.resolveReason);
      }
    }

    for (let i = this.detached.length - 1; i >= 0; i--) {
      const d = this.detached[i];
      d.ttl -= dt;
      if (d.ttl <= 0) {
        this.world.removeRigidBody(d.body);
        this.scene.remove(d.mesh);
        this.detached.splice(i, 1);
      }
    }
  }

  /** continue-for-a-credit: fresh car */
  repair() {
    for (const d of this.detached) {
      this.world.removeRigidBody(d.body);
      this.scene.remove(d.mesh);
    }
    this.detached.length = 0;
    this.health = 100;
    this.totaled = false;
    this.timeScale = 1;
    this.slowmoT = 0;
    this.easeT = 0;
    this.crashCamActive = false;
    this.crashCamT = 0;
    this.shake = 0;
    this.graceT = 1.5;
    this.vehicle.rebuildVisual();
    this.vehicle.velocity(this.prevVel);
  }
}
