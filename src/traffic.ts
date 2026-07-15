import * as THREE from 'three';
import type RAPIER_API from '@dimforge/rapier3d-compat';
import { G_GROUND, G_BUILDING, G_CHASSIS, G_PART, G_TRAFFIC, groups } from './tuning';
import {
  EDGES, EDGE_LEN, NODE_EDGES, MAP_EDGE,
  edgePoint, edgeDir, hasSignal, nsGreen, ewGreen,
} from './city';
import { addEdgeLines } from './carModel';
import type { PlayerVehicle } from './vehicle';
import type { Particles } from './particles';

// Ambient traffic on the REAL road graph: cars follow polyline edges (Broadway's
// diagonal, FDR curves), pick a random legal turn at each intersection node,
// stop at red signals, and convert to dynamic ragdolls when the player rams them.

const CAR_COLORS = [0xf7b90f, 0xf7b90f, 0xf7b90f, 0x2a2a33, 0x8a1420, 0x1c3a5e, 0x3d3d46, 0xcccccc];
const HALF = { x: 0.95, y: 0.55, z: 2.1 };

interface TCar {
  mesh: THREE.Group;
  body: RAPIER_API.RigidBody;
  edge: number;
  s: number; // meters along edge polyline (in pts order)
  rev: boolean; // traveling b->a (only on two-way edges)
  laneOff: number;
  speed: number;
  targetSpeed: number;
  yaw: number;
  wrecked: boolean;
  respawnT: number;
  prev: { p: THREE.Vector3; q: THREE.Quaternion };
  curr: { p: THREE.Vector3; q: THREE.Quaternion };
}

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

function buildTrafficCarMesh(color: number): THREE.Group {
  const outer = new THREE.Group();
  const g = new THREE.Group();
  g.position.y = -0.62;
  outer.add(g);
  // hidden-line wireframe: near-black fill, edges carry the paint color
  const off = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const fill = new THREE.Color(color).multiplyScalar(0.10);
  const paint = new THREE.MeshStandardMaterial({ color: fill, metalness: 0.3, roughness: 0.6, ...off });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.6, 4.1), paint);
  body.position.y = 0.55;
  addEdgeLines(body, color, 0.9);
  g.add(body);
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.5, 1.9),
    new THREE.MeshStandardMaterial({ color: 0x05070b, metalness: 0.3, roughness: 0.6, ...off })
  );
  cabin.position.set(0, 1.05, -0.3);
  addEdgeLines(cabin, color, 0.45);
  g.add(cabin);
  const headMat = new THREE.MeshBasicMaterial({ color: 0xfff2cc });
  const tailMat = new THREE.MeshBasicMaterial({ color: 0xff2222 });
  for (const sx of [-0.6, 0.6]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.06), headMat);
    h.position.set(sx, 0.55, 2.06);
    g.add(h);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.06), tailMat);
    t.position.set(sx, 0.55, -2.06);
    g.add(t);
  }
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.9 });
  for (const [sx, sz] of [[-0.85, 1.35], [0.85, 1.35], [-0.85, -1.35], [0.85, -1.35]]) {
    const geo = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 12);
    geo.rotateZ(Math.PI / 2);
    const w = new THREE.Mesh(geo, tireMat);
    w.position.set(sx, 0.33, sz);
    g.add(w);
  }
  return outer;
}

export class Traffic {
  cars: TCar[] = [];

  constructor(
    private world: RAPIER_API.World,
    private RAPIER: typeof RAPIER_API,
    private scene: THREE.Scene,
    private particles: Particles,
    count = 12
  ) {
    for (let i = 0; i < count; i++) this.cars.push(this.spawnCar());
  }

  private spawnCar(): TCar {
    const mesh = buildTrafficCarMesh(CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)]);
    this.scene.add(mesh);
    const body = this.world.createRigidBody(this.RAPIER.RigidBodyDesc.kinematicPositionBased());
    const coll = this.world.createCollider(
      this.RAPIER.ColliderDesc.cuboid(HALF.x, HALF.y, HALF.z).setFriction(0.5).setRestitution(0.2),
      body
    );
    coll.setMass(950);
    coll.setCollisionGroups(groups(G_TRAFFIC, G_GROUND | G_BUILDING | G_CHASSIS | G_TRAFFIC | G_PART));
    const car: TCar = {
      mesh, body,
      edge: 0, s: 0, rev: false, laneOff: 0,
      speed: 0, targetSpeed: 8 + Math.random() * 5, yaw: 0,
      wrecked: false, respawnT: 0,
      prev: { p: new THREE.Vector3(), q: new THREE.Quaternion() },
      curr: { p: new THREE.Vector3(), q: new THREE.Quaternion() },
    };
    this.placeOnLane(car);
    return car;
  }

  /** put the car on a random edge; keep near the player when `near` is given */
  private placeOnLane(car: TCar, near?: THREE.Vector3) {
    for (let tries = 0; tries < 60; tries++) {
      const ei = Math.floor(Math.random() * EDGES.length);
      if (EDGE_LEN[ei] < 30) continue;
      const s = 5 + Math.random() * (EDGE_LEN[ei] - 10);
      edgePoint(ei, s, _p);
      if (Math.abs(_p.x) > MAP_EDGE - 60 || Math.abs(_p.z) > MAP_EDGE - 60) continue;
      if (near) {
        const d = (_p.x - near.x) ** 2 + (_p.z - near.z) ** 2;
        if (d > 420 * 420 || d < 40 * 40) continue;
      }
      const e = EDGES[ei];
      car.edge = ei;
      car.s = s;
      car.rev = e.ow === 0 && Math.random() < 0.5;
      car.laneOff = e.w >= 18 ? e.w / 4 - 1 : Math.max(1.8, e.w / 4);
      car.speed = car.targetSpeed * 0.5;
      car.wrecked = false;
      this.pose(car);
      car.body.setTranslation({ x: _p.x, y: _p.y, z: _p.z }, true);
      car.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
      car.prev.p.copy(_p); car.prev.q.copy(_q);
      car.curr.p.copy(_p); car.curr.q.copy(_q);
      return;
    }
  }

  /** compute _p/_q pose from edge param (+ right-side lane offset) */
  private pose(car: TCar) {
    edgePoint(car.edge, car.s, _p);
    edgeDir(car.edge, car.s, _d);
    if (car.rev) _d.multiplyScalar(-1);
    // offset to the right of travel direction
    _p.x += _d.z * car.laneOff;
    _p.z += -_d.x * car.laneOff;
    _p.y = 0.62;
    const targetYaw = Math.atan2(_d.x, _d.z);
    // smooth heading so polyline corners don't snap
    let dy = targetYaw - car.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    car.yaw += dy * 0.25;
    _q.setFromAxisAngle(UP, car.yaw);
  }

  /** pick the next edge at the node the car just reached */
  private nextEdge(car: TCar) {
    const node = car.rev ? EDGES[car.edge].a : EDGES[car.edge].b;
    const options: { edge: number; rev: boolean }[] = [];
    for (const ei of NODE_EDGES[node]) {
      const e = EDGES[ei];
      if (EDGE_LEN[ei] < 8) continue;
      if (e.a === node) options.push({ edge: ei, rev: false });
      else if (e.b === node && e.ow === 0) options.push({ edge: ei, rev: true });
    }
    // avoid immediate U-turn when there's a choice
    const forwardOpts = options.filter((o) => o.edge !== car.edge);
    const pick = (forwardOpts.length ? forwardOpts : options)[
      Math.floor(Math.random() * Math.max(1, (forwardOpts.length ? forwardOpts : options).length))
    ];
    if (!pick) {
      this.placeOnLane(car); // dead end: relocate
      return;
    }
    car.edge = pick.edge;
    car.rev = pick.rev;
    car.s = pick.rev ? EDGE_LEN[pick.edge] : 0;
    const e = EDGES[pick.edge];
    car.laneOff = e.w >= 18 ? e.w / 4 - 1 : Math.max(1.8, e.w / 4);
  }

  fixedUpdate(dt: number, time: number, player: PlayerVehicle) {
    player.worldPosition(_v);
    const px = _v.x;
    const pz = _v.z;
    player.velocity(_v);
    const playerSpeed = _v.length();
    const pvx = _v.x, pvz = _v.z;

    for (const car of this.cars) {
      if (car.wrecked) {
        car.respawnT -= dt;
        this.readBody(car);
        if (car.respawnT <= 0) {
          car.body.setBodyType(this.RAPIER.RigidBodyType.KinematicPositionBased, true);
          _p.set(px, 0, pz);
          this.placeOnLane(car, _p);
        }
        continue;
      }

      const bp = car.body.translation();
      const dx = bp.x - px;
      const dz = bp.z - pz;
      const distSq = dx * dx + dz * dz;

      // teleport far-away cars back into the ambient bubble
      if (distSq > 550 * 550) {
        _p.set(px, 0, pz);
        this.placeOnLane(car, _p);
        continue;
      }

      // rammed by the player -> ragdoll
      if (distSq < 12 && playerSpeed > 6 && !player.disabled) {
        car.wrecked = true;
        car.respawnT = 16;
        car.body.setBodyType(this.RAPIER.RigidBodyType.Dynamic, true);
        car.body.applyImpulse({ x: pvx * 700, y: 1800 + playerSpeed * 60, z: pvz * 700 }, true);
        car.body.applyTorqueImpulse(
          { x: (Math.random() - 0.5) * 4000, y: (Math.random() - 0.5) * 3000, z: (Math.random() - 0.5) * 4000 },
          true
        );
        _p.set(bp.x, bp.y + 0.5, bp.z);
        _v.set(pvx, 0, pvz).normalize();
        this.particles.burstSparks(_p, _v, 30, 8);
        this.particles.burstSmoke(_p, 10);
        this.readBody(car);
        continue;
      }

      // --- desired speed ---
      let desired = car.targetSpeed;
      const e = EDGES[car.edge];
      const len = EDGE_LEN[car.edge];
      const remaining = car.rev ? car.s : len - car.s;
      const endNode = car.rev ? e.a : e.b;

      // signals: phase by dominant travel axis
      if (hasSignal(endNode) && remaining < 26) {
        edgeDir(car.edge, car.s, _d);
        if (car.rev) _d.multiplyScalar(-1);
        const isNS = Math.abs(_d.z) >= Math.abs(_d.x);
        const green = isNS ? nsGreen(time) : ewGreen(time);
        if (!green && remaining > 3) {
          desired = Math.min(desired, Math.max(0, (remaining - 9) * 0.6));
        }
      } else if (remaining < 18) {
        desired = Math.min(desired, 7); // ease through turns
      }

      // keep gap to cars ahead on the same edge + direction
      for (const other of this.cars) {
        if (other === car || other.wrecked || other.edge !== car.edge || other.rev !== car.rev) continue;
        const gap = car.rev ? car.s - other.s : other.s - car.s;
        if (gap > 0 && gap < 11) desired = Math.min(desired, gap < 6 ? 0 : other.speed);
      }

      // brake for the player directly ahead
      if (distSq < 20 * 20) {
        edgeDir(car.edge, car.s, _d);
        if (car.rev) _d.multiplyScalar(-1);
        const ahead = -(dx * _d.x + dz * _d.z); // player pos relative to car, along travel dir
        const lateral = Math.abs(-dx * _d.z + dz * _d.x);
        if (ahead > 0 && ahead < 17 && lateral < 3.5) {
          desired = Math.min(desired, Math.max(0, (ahead - 6) * 0.8));
        }
      }

      car.speed += THREE.MathUtils.clamp(desired - car.speed, -9 * dt, 4 * dt);
      car.s += car.speed * dt * (car.rev ? -1 : 1);
      if (car.rev ? car.s <= 0 : car.s >= len) this.nextEdge(car);

      this.pose(car);
      car.body.setNextKinematicTranslation({ x: _p.x, y: _p.y, z: _p.z });
      car.body.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
      this.readBody(car);
    }
  }

  private readBody(car: TCar) {
    car.prev.p.copy(car.curr.p);
    car.prev.q.copy(car.curr.q);
    const p = car.body.translation();
    const r = car.body.rotation();
    car.curr.p.set(p.x, p.y, p.z);
    car.curr.q.set(r.x, r.y, r.z, r.w);
  }

  sync(alpha: number) {
    for (const car of this.cars) {
      car.mesh.position.lerpVectors(car.prev.p, car.curr.p, alpha);
      car.mesh.quaternion.slerpQuaternions(car.prev.q, car.curr.q, alpha);
    }
  }
}
