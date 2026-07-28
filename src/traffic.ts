import * as THREE from 'three';
import type RAPIER_API from '@dimforge/rapier3d-compat';
import { G_GROUND, G_BUILDING, G_CHASSIS, G_PART, G_TRAFFIC, groups } from './tuning';
import {
  EDGES, EDGE_LEN, NODE_EDGES, MAP_EDGE,
  edgePoint, edgeDir, hasSignal, nsGreen, ewGreen, elevationAt,
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
  slot: number;
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

// One car's geometry, expressed as instanced parts. Twelve draw calls per car
// (the old per-car Group) put a ceiling of about a dozen cars on the whole
// game; instanced, the entire fleet costs six regardless of how many there are.
const PART = {
  body: { size: [1.85, 0.6, 4.1] as const, at: [0, -0.07, 0] as const },
  cabin: { size: [1.6, 0.5, 1.9] as const, at: [0, 0.43, -0.3] as const },
};
const WHEEL_AT = [[-0.85, -0.29, 1.35], [0.85, -0.29, 1.35], [-0.85, -0.29, -1.35], [0.85, -0.29, -1.35]] as const;
const HEAD_AT = [[-0.6, -0.07, 2.06], [0.6, -0.07, 2.06]] as const;
const TAIL_AT = [[-0.6, -0.07, -2.06], [0.6, -0.07, -2.06]] as const;

/** the 12 edges of a box, as local-space line-segment endpoints */
function boxEdges(sx: number, sy: number, sz: number, ox: number, oy: number, oz: number): number[] {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const c = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz],
    [-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  const pairs = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  const out: number[] = [];
  for (const [a, b] of pairs) {
    out.push(c[a][0] + ox, c[a][1] + oy, c[a][2] + oz);
    out.push(c[b][0] + ox, c[b][1] + oy, c[b][2] + oz);
  }
  return out;
}
/** local-space edge points for one car (body + cabin) */
const CAR_EDGE_PTS = (() => {
  const b = boxEdges(...PART.body.size, ...PART.body.at);
  const c = boxEdges(...PART.cabin.size, ...PART.cabin.at);
  return Float32Array.from([...b, ...c]);
})();

const off = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };

/** instanced fills + one dynamic wireframe buffer for a fleet of cars */
class CarPool {
  body: THREE.InstancedMesh;
  cabin: THREE.InstancedMesh;
  wheels: THREE.InstancedMesh;
  heads: THREE.InstancedMesh;
  tails: THREE.InstancedMesh;
  lines: THREE.LineSegments;
  private linePos: Float32Array;

  constructor(scene: THREE.Scene, capacity: number, dynamic: boolean) {
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.instanceMatrix.setUsage(dynamic ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
      return m;
    };
    const paint = new THREE.MeshStandardMaterial({ color: 0x111114, metalness: 0.3, roughness: 0.6, ...off });
    const glass = new THREE.MeshStandardMaterial({ color: 0x05070b, metalness: 0.3, roughness: 0.6, ...off });
    const tire = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.9 });
    const head = new THREE.MeshBasicMaterial({ color: 0xfff2cc });
    const tail = new THREE.MeshBasicMaterial({ color: 0xff2222 });
    const wheelGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 10);
    wheelGeo.rotateZ(Math.PI / 2);

    this.body = mk(new THREE.BoxGeometry(...PART.body.size), paint, capacity);
    this.cabin = mk(new THREE.BoxGeometry(...PART.cabin.size), glass, capacity);
    this.wheels = mk(wheelGeo, tire, capacity * 4);
    this.heads = mk(new THREE.BoxGeometry(0.3, 0.12, 0.06), head, capacity * 2);
    this.tails = mk(new THREE.BoxGeometry(0.34, 0.1, 0.06), tail, capacity * 2);
    this.body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);

    const n = CAR_EDGE_PTS.length / 3;
    this.linePos = new Float32Array(capacity * n * 3);
    const col = new Float32Array(capacity * n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(
      dynamic ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9,
    }));
    this.lines.frustumCulled = false;
    geo.setDrawRange(0, 0);
    scene.add(this.lines);
  }

  /** paint one slot; call once per car when its colour is assigned */
  setColor(i: number, color: THREE.Color) {
    this.body.instanceColor!.setXYZ(i, color.r * 0.10, color.g * 0.10, color.b * 0.10);
    this.body.instanceColor!.needsUpdate = true;
    const n = CAR_EDGE_PTS.length / 3;
    const c = this.lines.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let k = 0; k < n; k++) c.setXYZ(i * n + k, color.r, color.g, color.b);
    c.needsUpdate = true;
  }

  /** write one car's transform into every pool */
  write(i: number, pos: THREE.Vector3, quat: THREE.Quaternion, m4: THREE.Matrix4, v3: THREE.Vector3) {
    const put = (inst: THREE.InstancedMesh, slot: number, lx: number, ly: number, lz: number) => {
      v3.set(lx, ly, lz).applyQuaternion(quat).add(pos);
      m4.compose(v3, quat, ONE);
      inst.setMatrixAt(slot, m4);
    };
    put(this.body, i, ...PART.body.at);
    put(this.cabin, i, ...PART.cabin.at);
    for (let w = 0; w < 4; w++) put(this.wheels, i * 4 + w, WHEEL_AT[w][0], WHEEL_AT[w][1], WHEEL_AT[w][2]);
    for (let w = 0; w < 2; w++) put(this.heads, i * 2 + w, HEAD_AT[w][0], HEAD_AT[w][1], HEAD_AT[w][2]);
    for (let w = 0; w < 2; w++) put(this.tails, i * 2 + w, TAIL_AT[w][0], TAIL_AT[w][1], TAIL_AT[w][2]);

    const n = CAR_EDGE_PTS.length / 3;
    for (let k = 0; k < n; k++) {
      v3.set(CAR_EDGE_PTS[k * 3], CAR_EDGE_PTS[k * 3 + 1], CAR_EDGE_PTS[k * 3 + 2])
        .applyQuaternion(quat).add(pos);
      const o = (i * n + k) * 3;
      this.linePos[o] = v3.x; this.linePos[o + 1] = v3.y; this.linePos[o + 2] = v3.z;
    }
  }

  /** how many cars are live */
  setCount(n: number) {
    this.body.count = n;
    this.cabin.count = n;
    this.wheels.count = n * 4;
    this.heads.count = n * 2;
    this.tails.count = n * 2;
    this.lines.geometry.setDrawRange(0, n * (CAR_EDGE_PTS.length / 3));
  }

  flush() {
    this.body.instanceMatrix.needsUpdate = true;
    this.cabin.instanceMatrix.needsUpdate = true;
    this.wheels.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
    this.tails.instanceMatrix.needsUpdate = true;
    (this.lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}

const ONE = new THREE.Vector3(1, 1, 1);
const _m4 = new THREE.Matrix4();
const _lv = new THREE.Vector3();
const _col = new THREE.Color();

export const MAX_TRAFFIC = 90;

export class Traffic {
  cars: TCar[] = [];
  private pool: CarPool;
  /** how many of the pooled cars are actually live */
  live = 0;

  constructor(
    private world: RAPIER_API.World,
    private RAPIER: typeof RAPIER_API,
    private scene: THREE.Scene,
    private particles: Particles,
    count = 12
  ) {
    this.pool = new CarPool(scene, MAX_TRAFFIC, true);
    for (let i = 0; i < MAX_TRAFFIC; i++) this.cars.push(this.spawnCar(i));
    this.setDensity(count);
  }

  /** live traffic count — driven from the tuning panel */
  setDensity(n: number) {
    const want = Math.max(0, Math.min(MAX_TRAFFIC, Math.round(n)));
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      const on = i < want;
      // parked-out cars keep their body but stop colliding and drawing
      c.body.setEnabled(on);
    }
    this.live = want;
    this.pool.setCount(want);
  }

  private spawnCar(slot: number): TCar {
    this.pool.setColor(slot, _col.setHex(CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)]));
    const body = this.world.createRigidBody(this.RAPIER.RigidBodyDesc.kinematicPositionBased());
    const coll = this.world.createCollider(
      this.RAPIER.ColliderDesc.cuboid(HALF.x, HALF.y, HALF.z).setFriction(0.5).setRestitution(0.2),
      body
    );
    coll.setMass(950);
    coll.setCollisionGroups(groups(G_TRAFFIC, G_GROUND | G_BUILDING | G_CHASSIS | G_TRAFFIC | G_PART));
    const car: TCar = {
      slot, body,
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
    // offset to the right of travel direction, then re-seat on the terrain
    _p.x += _d.z * car.laneOff;
    _p.z += -_d.x * car.laneOff;
    _p.y = elevationAt(_p.x, _p.z) + 0.62; // sit ON the terrain, not at sea level
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

    for (let ci = 0; ci < this.live; ci++) {
      const car = this.cars[ci];
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
      for (let oi = 0; oi < this.live; oi++) {
        const other = this.cars[oi];
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
    for (let i = 0; i < this.live; i++) {
      const car = this.cars[i];
      _p.lerpVectors(car.prev.p, car.curr.p, alpha);
      _q.slerpQuaternions(car.prev.q, car.curr.q, alpha);
      this.pool.write(car.slot, _p, _q, _m4, _lv);
    }
    this.pool.flush();
  }
}

// ---------------------------------------------------------------- parked cars
// Kerbside cars are pure scenery plus a collider, so they never simulate. All of
// them together cost the same handful of draw calls the moving fleet does, and
// the positions are derived from the road graph at load — nothing is baked.
export const MAX_PARKED = 4000;

export class ParkedCars {
  private pool: CarPool;
  private slots: { x: number; z: number; yaw: number }[] = [];
  private colliders: RAPIER_API.Collider[] = [];
  private body: RAPIER_API.RigidBody;
  live = 0;

  constructor(
    private world: RAPIER_API.World,
    private RAPIER: typeof RAPIER_API,
    scene: THREE.Scene,
    count: number
  ) {
    this.pool = new CarPool(scene, MAX_PARKED, false);
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

    // candidate kerb slots along every ordinary street, both sides
    const cand: { x: number; z: number; yaw: number }[] = [];
    for (let ei = 0; ei < EDGES.length; ei++) {
      const e = EDGES[ei];
      if (e.cls === 'motorway' || e.cls === 'trunk' || e.cls.endsWith('_link')) continue;
      const len = EDGE_LEN[ei];
      if (len < 34) continue;
      const kerb = Math.max(2.4, e.w / 2 - 1.3);
      for (let sd = 14; sd < len - 14; sd += 7.2) {
        edgePoint(ei, sd, _p);
        edgeDir(ei, sd, _d);
        const yaw = Math.atan2(_d.x, _d.z);
        for (const side of [-1, 1]) {
          const x = _p.x + _d.z * kerb * side;
          const z = _p.z - _d.x * kerb * side;
          if (Math.abs(x) > MAP_EDGE - 60 || Math.abs(z) > MAP_EDGE - 60) continue;
          cand.push({ x, z, yaw: side < 0 ? yaw : yaw + Math.PI });
        }
      }
    }
    // deterministic shuffle so density changes reveal/hide the same cars
    let seed = 20260728;
    for (let i = cand.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [cand[i], cand[j]] = [cand[j], cand[i]];
    }
    this.slots = cand.slice(0, MAX_PARKED);

    for (let i = 0; i < this.slots.length; i++) {
      this.pool.setColor(i, _col.setHex(CAR_COLORS[(i * 7) % CAR_COLORS.length]));
      const sl = this.slots[i];
      _p.set(sl.x, elevationAt(sl.x, sl.z) + 0.62, sl.z);
      _q.setFromAxisAngle(UP, sl.yaw);
      this.pool.write(i, _p, _q, _m4, _lv);
    }
    this.pool.flush();
    this.setDensity(count);
  }

  /** how many kerbside cars exist; rebuilds their colliders */
  setDensity(n: number) {
    const want = Math.max(0, Math.min(this.slots.length, Math.round(n)));
    for (const c of this.colliders) this.world.removeCollider(c, false);
    this.colliders.length = 0;
    for (let i = 0; i < want; i++) {
      const sl = this.slots[i];
      const c = this.world.createCollider(
        this.RAPIER.ColliderDesc.cuboid(HALF.x, HALF.y, HALF.z)
          .setTranslation(sl.x, elevationAt(sl.x, sl.z) + 0.62, sl.z)
          .setRotation({ x: 0, y: Math.sin(sl.yaw / 2), z: 0, w: Math.cos(sl.yaw / 2) })
          .setFriction(0.6),
        this.body
      );
      c.setCollisionGroups(groups(G_TRAFFIC, G_CHASSIS | G_TRAFFIC | G_PART));
      this.colliders.push(c);
    }
    this.live = want;
    this.pool.setCount(want);
  }
}
