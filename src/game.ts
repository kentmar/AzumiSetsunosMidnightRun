import * as THREE from 'three';
import { TUNING } from './tuning';
import {
  BORDER, SPAWN as CITY_SPAWN, SPAWN_YAW, nearestEdgePoint, type City,
} from './city';
import type { PlayerVehicle } from './vehicle';
import type { CrashSystem } from './crash';
import type { Hud } from './hud';
import type { Input } from './input';

// Arcade shell: attract -> running -> game over -> continue-for-a-credit.
// Owns credits, fuel, the checkpoint sprint, gas pickups, and the boundary.

export type GameState = 'attract' | 'running' | 'gameover';

const CHECKPOINT_COUNT = 6;
const SPAWN = CITY_SPAWN;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class Game {
  state: GameState = 'attract';
  credits = 1;
  fuel = 100;
  simTime = 0;
  /** set by main: snaps the chase camera behind the car after any teleport */
  onRespawn?: () => void;

  private cpIndex = 0;
  private cpTargets: THREE.Vector3[] = [];
  private ring: THREE.Mesh;
  private beacon: THREE.Mesh;
  private gasCans: { mesh: THREE.Mesh; pos: THREE.Vector3 }[] = [];
  private goCountdown = 0;
  private goReason: string | null = null;
  private warn01 = 0;
  private bounceCd = 0;
  private portalCd = 0;
  private sinking = 0; // seconds under the river; 0 = on land

  constructor(
    private scene: THREE.Scene,
    private city: City,
    private vehicle: PlayerVehicle,
    private crash: CrashSystem,
    private hud: Hud,
    input: Input
  ) {
    // checkpoint ring + sky beacon
    // blue wireframe sphere you drive through (2× the old ring)
    this.ring = new THREE.Mesh(
      new THREE.SphereGeometry(8.4, 18, 12),
      new THREE.MeshBasicMaterial({
        color: 0x3d9bff, wireframe: true, transparent: true, opacity: 0.8,
      })
    );
    this.ring.visible = false;
    scene.add(this.ring);
    this.beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 1.6, 260, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x3d9bff,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    this.beacon.visible = false;
    scene.add(this.beacon);

    // gas pickups
    const gasMat = new THREE.MeshBasicMaterial({ color: 0x53ff8e });
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.75, 0.4), gasMat);
      const pos = this.city.randomLanePoint();
      mesh.position.set(pos.x, 0.9, pos.z);
      this.scene.add(mesh);
      this.gasCans.push({ mesh, pos });
    }

    input.onPress('Enter', () => {
      if (this.state === 'attract' && this.credits > 0) this.start();
      else if (this.state === 'gameover' && this.credits > 0) this.continueRun();
    });
    input.onPress('KeyC', () => {
      this.credits++;
      this.hud.setCredits(this.credits);
      if (this.state === 'running') this.hud.popup('CREDIT +1');
    });
    input.onPress('KeyR', () => {
      if (this.state !== 'running') return;
      // the surface rescue just nudges you upward, which strands you inside a
      // tunnel — put the car back on the bore centreline facing the exit
      this.vehicle.worldPosition(_v);
      const t = this.city.tunnelRescue(_v);
      if (t) {
        this.vehicle.reset(t.pos, t.yaw);
        this.onRespawn?.();
        this.hud.popup('TUNNEL RESCUE');
      } else this.vehicle.rescue();
    });

    this.hud.setCredits(this.credits);
    this.hud.showAttract(true);
    this.vehicle.reset(SPAWN, SPAWN_YAW);
  }

  private start() {
    this.credits--;
    this.fuel = 100;
    this.vehicle.fuelEmpty = false;
    this.sinking = 0;
    this.vehicle.body.setLinearDamping(0);
    this.crash.repair();
    this.vehicle.reset(SPAWN, SPAWN_YAW);
    this.rollCheckpoints();
    this.state = 'running';
    this.hud.showAttract(false);
    this.hud.showGameOver(null, 0, 0);
    this.hud.setCredits(this.credits);
    this.hud.popup('GO!');
    this.onRespawn?.();
  }

  private continueRun() {
    this.credits--;
    this.fuel = 100;
    this.vehicle.fuelEmpty = false;
    this.sinking = 0;
    this.vehicle.body.setLinearDamping(0);
    this.crash.repair();
    // respawn on the nearest real road, heading along it
    this.vehicle.worldPosition(_v);
    _v.x = THREE.MathUtils.clamp(_v.x, BORDER.minX + 80, BORDER.maxX - 80);
    _v.z = THREE.MathUtils.clamp(_v.z, BORDER.minZ + 80, BORDER.maxZ - 80);
    const road = nearestEdgePoint(_v);
    const yaw = Math.atan2(road.dir.x, road.dir.z);
    this.vehicle.reset(road.point, yaw);
    this.state = 'running';
    this.goReason = null;
    this.hud.showGameOver(null, 0, 0);
    this.hud.setCredits(this.credits);
    this.hud.popup('CONTINUE');
    this.onRespawn?.();
  }

  /** current checkpoint ring position (minimap) */
  get checkpointTarget(): THREE.Vector3 | null {
    return this.state === 'running' ? this.cpTargets[this.cpIndex] ?? null : null;
  }

  /** gas pickup positions (minimap) */
  get gasPositions(): THREE.Vector3[] {
    return this.gasCans.map((c) => c.pos);
  }

  /** wired to CrashSystem.onTotaled */
  onTotaled(reason: string) {
    if (this.state !== 'running') return;
    this.state = 'gameover';
    this.goReason = reason;
    this.goCountdown = 9.9;
  }

  private rollCheckpoints() {
    this.cpTargets = [];
    const pool = [...this.city.intersections].filter(
      (p) =>
        p.x > BORDER.minX + 100 && p.x < BORDER.maxX - 100 &&
        p.z > BORDER.minZ + 100 && p.z < BORDER.maxZ - 100
    );
    for (let i = 0; i < CHECKPOINT_COUNT && pool.length; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      this.cpTargets.push(pool.splice(idx, 1)[0].clone());
    }
    this.cpIndex = 0;
    this.pointRingAtCurrent();
    this.hud.setCheckpoints(0, this.cpTargets.length);
  }

  private pointRingAtCurrent() {
    const t = this.cpTargets[this.cpIndex];
    if (!t) return;
    this.ring.position.set(t.x, 5.0, t.z);
    this.beacon.position.set(t.x, 130, t.z);
    this.ring.visible = true;
    this.beacon.visible = true;
  }

  fixedUpdate(dt: number) {
    this.simTime += dt;
    if (this.state !== 'running') return;

    // fuel — descending conserves it, climbing burns extra (real DEM slope)
    if (!this.crash.totaled) {
      const slopeEco = THREE.MathUtils.clamp(1 - this.vehicle.slope * 26, 0.4, 1.8);
      this.fuel -= (TUNING.fuelDrainBase + this.vehicle.speed * TUNING.fuelDrainSpeed * slopeEco) * dt;
      if (this.fuel <= 0) {
        this.fuel = 0;
        this.vehicle.fuelEmpty = true;
        if (this.vehicle.speed < 1.2) this.crash.forceTotal('OUT OF FUEL');
      }
    }

    this.vehicle.worldPosition(_v);

    // north/south mirror perimeter (east/west is the river — handled below)
    const B = BORDER;
    const dEdge = Math.min(_v.z - B.minZ, B.maxZ - _v.z);
    this.warn01 = THREE.MathUtils.clamp(1 - dEdge / 140, 0, 1);
    this.bounceCd -= dt;
    if (dEdge < 0 && this.bounceCd <= 0 && !this.crash.totaled) {
      this.bounceCd = 1.2;
      const vel = this.vehicle.velocity(_v2);
      vel.z = -vel.z;
      vel.multiplyScalar(0.3);
      if (vel.length() < 7) vel.setLength(7); // always clears the wall
      this.vehicle.body.setTranslation(
        { x: _v.x, y: _v.y, z: THREE.MathUtils.clamp(_v.z, B.minZ + 3, B.maxZ - 3) },
        true
      );
      this.vehicle.body.setLinvel({ x: vel.x, y: Math.abs(vel.y) * 0.2, z: vel.z }, true);
      this.fuel = Math.max(0, this.fuel - 8);
      this.hud.popup('MIRROR PERIMETER — FUEL −8');
      this.hud.flash(0.6);
    }

    // river edges: smash the seawall fence, then you're sinking — camera stays
    // above the surface; a few seconds under and the run is over
    // only at street level — the tunnels run out under the river, and being
    // below the riverbed is not the same as being in it
    const inWater = _v.y > -2 &&
      (_v.x < this.city.shoreWest(_v.z) || _v.x > this.city.shoreEast(_v.z));
    this.vehicle.underwater = inWater;
    if (inWater && !this.crash.totaled) {
      if (this.sinking === 0) {
        this.city.breakFence(_v, 12);
        this.vehicle.body.setLinearDamping(1.6);
        this.hud.popup('SEAWALL BREACHED');
        this.hud.flash(0.5);
      }
      this.sinking += dt;
      if (this.sinking > 2.4) {
        this.crash.forceTotal(_v.x < 0 ? 'THE HUDSON CLAIMS ANOTHER' : 'LOST TO THE EAST RIVER');
      }
    } else if (this.sinking > 0 && !inWater) {
      this.sinking = 0;
      this.vehicle.body.setLinearDamping(0);
    }

    // tunnel warp: Lincoln ↔ Queens–Midtown
    this.portalCd -= dt;
    if (this.portalCd <= 0 && !this.crash.totaled && this.city.portals.length >= 2) {
      for (let i = 0; i < this.city.portals.length; i++) {
        const p = this.city.portals[i];
        const dx = _v.x - p.pos.x;
        const dz = _v.z - p.pos.z;
        if (dx * dx + dz * dz < 90) {
          const other = this.city.portals[(i + 1) % this.city.portals.length];
          const speed = Math.max(10, this.vehicle.speed * 0.85);
          const ex = Math.sin(other.exitYaw);
          const ez = Math.cos(other.exitYaw);
          // the light wall delivers you to the OTHER tunnel's street mouth
          const dest = other.mouth ?? other.pos;
          this.vehicle.reset(_v2.set(dest.x + ex * 12, 0, dest.z + ez * 12), other.exitYaw);
          this.vehicle.body.setLinvel({ x: ex * speed, y: 0, z: ez * speed }, true);
          this.portalCd = 4;
          this.hud.popup(`${p.name} → ${other.name}`);
          this.hud.flash(0.8);
          this.onRespawn?.();
          break;
        }
      }
    }

    // checkpoints
    const cp = this.cpTargets[this.cpIndex];
    if (cp && !this.crash.totaled) {
      const dx = _v.x - cp.x;
      const dz = _v.z - cp.z;
      if (dx * dx + dz * dz < 72) {
        this.cpIndex++;
        this.hud.setCheckpoints(this.cpIndex, this.cpTargets.length);
        if (this.cpIndex >= this.cpTargets.length) {
          this.credits++;
          this.hud.setCredits(this.credits);
          this.hud.popup('RACE COMPLETE — CREDIT +1');
          this.rollCheckpoints();
        } else {
          this.hud.popup('CHECKPOINT');
          this.pointRingAtCurrent();
        }
      }
    }

    // gas pickups
    for (const can of this.gasCans) {
      const dx = _v.x - can.pos.x;
      const dz = _v.z - can.pos.z;
      if (dx * dx + dz * dz < 14) {
        this.fuel = Math.min(100, this.fuel + 45);
        this.vehicle.fuelEmpty = this.fuel <= 0;
        this.hud.popup('FUEL +45');
        const np = this.city.randomLanePoint();
        can.pos.copy(np);
        can.mesh.position.set(np.x, 0.9, np.z);
      }
    }
  }

  /** real-time (unscaled) per-frame update */
  update(dt: number, mphSource: PlayerVehicle) {
    // spinny bits
    this.ring.rotation.y += dt * 0.5;
    const bob = Math.sin(performance.now() * 0.004) * 0.15;
    for (const can of this.gasCans) {
      can.mesh.rotation.y += dt * 2;
      can.mesh.position.y = 0.9 + bob;
    }

    if (this.state === 'running') {
      const mph = mphSource.forwardSpeed * 2.237;
      this.hud.setSpeed(mph, mphSource.forwardSpeed < -0.5 ? 'R' : 'D');
      this.hud.setFuel(this.fuel / 100);
      this.hud.setHealth(this.crash.health / 100);
      this.hud.setWarning(this.warn01 > 0 ? this.warn01 : null);
    } else if (this.state === 'gameover') {
      this.goCountdown -= dt;
      this.hud.setWarning(null);
      this.hud.showGameOver(this.goReason ?? 'WRECKED', this.credits, Math.max(0, this.goCountdown));
      if (this.goCountdown <= 0) {
        this.state = 'attract';
        this.goReason = null;
        this.sinking = 0;
        this.vehicle.body.setLinearDamping(0);
        this.crash.repair();
        this.vehicle.reset(SPAWN, SPAWN_YAW);
        this.hud.showGameOver(null, 0, 0);
        this.hud.showAttract(true);
        this.ring.visible = false;
        this.beacon.visible = false;
      }
    }
    this.hud.update(dt);
  }
}
