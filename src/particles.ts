import * as THREE from 'three';

interface P {
  alive: boolean;
  life: number;
  maxLife: number;
  vel: THREE.Vector3;
  grow: number;
  baseColor: THREE.Color;
}

class Pool {
  geo: THREE.BufferGeometry;
  points: THREE.Points;
  pos: Float32Array;
  col: Float32Array;
  parts: P[] = [];
  cursor = 0;
  gravity: number;

  constructor(scene: THREE.Scene, count: number, size: number, gravity: number, tex: THREE.Texture) {
    this.gravity = gravity;
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.pos.fill(99999);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const mat = new THREE.PointsMaterial({
      size,
      map: tex,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    for (let i = 0; i < count; i++) {
      this.parts.push({
        alive: false,
        life: 0,
        maxLife: 1,
        vel: new THREE.Vector3(),
        grow: 0,
        baseColor: new THREE.Color(),
      });
    }
  }

  spawn(pos: THREE.Vector3, vel: THREE.Vector3, life: number, color: THREE.Color) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.parts.length;
    const p = this.parts[i];
    p.alive = true;
    p.life = life;
    p.maxLife = life;
    p.vel.copy(vel);
    p.baseColor.copy(color);
    this.pos[i * 3] = pos.x;
    this.pos[i * 3 + 1] = pos.y;
    this.pos[i * 3 + 2] = pos.z;
  }

  update(dt: number) {
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        this.pos[i * 3 + 1] = 99999;
        continue;
      }
      p.vel.y -= this.gravity * dt;
      this.pos[i * 3] += p.vel.x * dt;
      this.pos[i * 3 + 1] += p.vel.y * dt;
      this.pos[i * 3 + 2] += p.vel.z * dt;
      const f = p.life / p.maxLife;
      this.col[i * 3] = p.baseColor.r * f;
      this.col[i * 3 + 1] = p.baseColor.g * f;
      this.col[i * 3 + 2] = p.baseColor.b * f;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}

function makeDotTexture(soft: boolean): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(soft ? 0.25 : 0.5, soft ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _c = new THREE.Color();

export class Particles {
  sparks: Pool;
  smoke: Pool;
  flow: Pool;
  drag: Pool;

  constructor(scene: THREE.Scene) {
    this.sparks = new Pool(scene, 500, 0.16, 14, makeDotTexture(false));
    this.smoke = new Pool(scene, 250, 1.6, -1.2, makeDotTexture(true));
    this.flow = new Pool(scene, 400, 0.12, 0.9, makeDotTexture(false));
    this.drag = new Pool(scene, 300, 0.04, 0, makeDotTexture(false));
  }

  /** terrain-slope readout. Downhill (slope > 0): blue energy spills off the
   *  tail and falls back into the camera's view. Uphill: tiny single-pixel red
   *  drag lines appear ahead and sweep back over the hood, dying at the glass. */
  slopeFlow(pos: THREE.Vector3, fwd: THREE.Vector3, vel: THREE.Vector3, slope: number) {
    if (slope > 0) {
      const n = Math.random() < 0.4 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const back = 2.4 + Math.random() * 1.2;
        _v2.set(
          pos.x - fwd.x * back + (Math.random() - 0.5) * 1.5,
          pos.y + 0.55 + Math.random() * 0.5,
          pos.z - fwd.z * back + (Math.random() - 0.5) * 1.5
        );
        // slower than the car -> recedes off the tail toward the camera
        _v.copy(vel).multiplyScalar(0.55 + Math.random() * 0.15);
        _v.y = -0.4 - Math.random() * 0.6;
        _c.setRGB(0.15, 0.45 + Math.random() * 0.25, 1.0);
        this.flow.spawn(_v2, _v, 0.5 + Math.random() * 0.25, _c);
      }
    } else {
      // singular, small: one thin line per emit
      const ahead = 3.2 + Math.random() * 1.4;
      _v2.set(
        pos.x + fwd.x * ahead + (Math.random() - 0.5) * 1.3,
        pos.y + 0.72 + Math.random() * 0.25,
        pos.z + fwd.z * ahead + (Math.random() - 0.5) * 1.3
      );
      // half the car's speed: the hood overtakes it, then it dies at the glass
      _v.copy(vel).multiplyScalar(0.5);
      _v.y = 0.15;
      _c.setRGB(1.0, 0.13 + Math.random() * 0.1, 0.07);
      this.drag.spawn(_v2, _v, 0.26 + Math.random() * 0.12, _c);
    }
  }

  burstSparks(pos: THREE.Vector3, dir: THREE.Vector3, count: number, speed: number) {
    for (let i = 0; i < count; i++) {
      _v.set(
        (Math.random() - 0.5) * 2,
        Math.random() * 0.9 + 0.15,
        (Math.random() - 0.5) * 2
      )
        .normalize()
        .multiplyScalar(speed * (0.4 + Math.random() * 0.8))
        .addScaledVector(dir, speed * 0.4);
      _c.setRGB(1.0, 0.55 + Math.random() * 0.35, 0.15 + Math.random() * 0.2);
      this.sparks.spawn(pos, _v, 0.35 + Math.random() * 0.5, _c);
    }
  }

  burstSmoke(pos: THREE.Vector3, count: number, tint = 0.32) {
    for (let i = 0; i < count; i++) {
      _v.set((Math.random() - 0.5) * 3, Math.random() * 2 + 0.5, (Math.random() - 0.5) * 3);
      const g = tint * (0.6 + Math.random() * 0.5);
      _c.setRGB(g, g, g * 1.05);
      this.smoke.spawn(pos, _v, 0.9 + Math.random() * 1.2, _c);
    }
  }

  tireSmoke(pos: THREE.Vector3, vel: THREE.Vector3) {
    _v.copy(vel).multiplyScalar(0.25);
    _v.y = 0.8 + Math.random() * 0.8;
    _v.x += (Math.random() - 0.5) * 1.5;
    _v.z += (Math.random() - 0.5) * 1.5;
    const g = 0.16 + Math.random() * 0.08;
    _c.setRGB(g, g, g * 1.1);
    this.smoke.spawn(pos, _v, 0.5 + Math.random() * 0.4, _c);
  }

  update(dt: number) {
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.flow.update(dt);
    this.drag.update(dt);
  }
}
