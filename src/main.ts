import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { TUNING } from './tuning';
import { Input } from './input';
import { TouchControls, IS_TOUCH } from './touch';
import { Particles } from './particles';
import { Sky } from './sky';
import { City, FOG, SPAWN, META } from './city';
import { PlayerVehicle } from './vehicle';
import { CrashSystem } from './crash';
import { ChaseCamera } from './camera';
import { Traffic } from './traffic';
import { Hud } from './hud';
import { Panel } from './panel';
import { Game } from './game';
import { Minimap } from './minimap';

// Boot + fixed-timestep (60 Hz) physics loop decoupled from render, with
// interpolation. crash.timeScale drives the slow-mo.

const FIXED_DT = 1 / 60;
const IDLE_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: false };

async function boot() {
  await RAPIER.init();

  // mobile preset: no MSAA, 1x pixels, lighter rain — bloom hides most of it
  const renderer = new THREE.WebGLRenderer({ antialias: !IS_TOUCH, powerPreference: 'high-performance' });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(IS_TOUCH ? 1 : Math.min(devicePixelRatio, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  document.getElementById('app')!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(FOG.color, FOG.density);

  const world = new RAPIER.World({ x: 0, y: -10.5, z: 0 });

  // wireframe restyle: the procedural hidden-line car IS the look — no glTF,
  // which drops ~2MB of model + Draco decoder from the load
  const input = new Input();
  const hud = new Hud();
  const sky = new Sky(scene, IS_TOUCH ? 0.45 : 1);
  const city = new City(scene, world, RAPIER);
  const particles = new Particles(scene);
  const vehicle = new PlayerVehicle(world, scene, RAPIER);
  const chase = new ChaseCamera(world, RAPIER);

  let game: Game;
  const crash = new CrashSystem(
    world,
    RAPIER,
    scene,
    vehicle,
    particles,
    (s) => hud.flash(s),
    (reason) => game.onTotaled(reason)
  );
  const traffic = new Traffic(world, RAPIER, scene, particles, 11);
  game = new Game(scene, city, vehicle, crash, hud, input);
  game.onRespawn = () => chase.snap(vehicle);
  const minimap = new Minimap(hud.root, IS_TOUCH);

  if (IS_TOUCH) {
    hud.setTouchMode();
    const key = (code: string) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code }));
    };
    new TouchControls(input, () => {
      // tap = coin + start on the attract / game-over screens
      if (game.state !== 'running') {
        key('KeyC');
        setTimeout(() => key('Enter'), 90);
      }
    });
  }

  hud.setDataStamp(
    `REAL MIDTOWN MANHATTAN 1:1 — MAP DATA © ${META.source.toUpperCase()} — BAKED ${META.baked} (npm run bake to refresh)`
  );

  const panel = new Panel(() => vehicle.applyTuning());
  input.onPress('KeyP', () => panel.toggle());

  let paused = false;
  const setPaused = (v: boolean) => {
    paused = v;
    hud.showPause(paused);
  };
  // fullscreen map (M / MAP button); sim freezes while it's open
  let mapOpen = false;
  const setMap = (v: boolean) => {
    mapOpen = v;
    minimap.toggleFull(v);
  };
  minimap.requestToggle = () => setMap(!mapOpen);
  input.onPress('KeyM', () => {
    if (game.state === 'running' || mapOpen) setMap(!mapOpen);
  });
  input.onPress('Escape', () => {
    if (mapOpen) setMap(false);
    else setPaused(!paused);
  });
  // any intent-to-play key wakes the game (stray Escape shouldn't strand it)
  for (const code of ['Enter', 'KeyW', 'ArrowUp', 'KeyC', 'Space']) {
    input.onPress(code, () => {
      if (paused) setPaused(false);
      if (mapOpen) setMap(false);
    });
  }

  // one-shot cubemap of the storm sky + city for wet-road + car-paint reflections
  // (env-map cube render removed with the wireframe restyle — nothing reflective left)
  sky.update(0.016, SPAWN);

  // post: bloom sells the neon-in-rain look
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, chase.cam));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(innerWidth, innerHeight),
    0.38, // strength
    0.45, // radius
    0.78 // threshold
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
    chase.resize();
  });

  // ---- main loop ----
  let last = performance.now();
  let acc = 0;
  let fpsAcc = 0;
  let fpsN = 0;
  let fpsT = 0;
  const camPos = new THREE.Vector3();
  const mapFwd = new THREE.Vector3();

  let lastRender = 0;
  function frame(now: number) {
    requestAnimationFrame(frame);
    // optional render cap (panel: fpsCap); physics still steps at a fixed 60 Hz
    if (TUNING.fpsCap > 0 && now - lastRender < 1000 / TUNING.fpsCap - 0.1) return;
    lastRender = now;
    const realDt = Math.min((now - last) / 1000, 0.1);
    last = now;

    if (mapOpen) {
      vehicle.worldPosition(camPos);
      minimap.renderFull(camPos, vehicle.forwardDir(mapFwd), game.checkpointTarget, game.gasPositions);
      composer.render(); // sim frozen behind the map
      return;
    }
    if (paused) {
      composer.render(); // frozen frame
      return;
    }

    // slow-mo scales the simulation, not the render
    acc += realDt * crash.timeScale;
    let steps = 0;
    while (acc >= FIXED_DT && steps < 5) {
      game.fixedUpdate(FIXED_DT);
      vehicle.update(game.state === 'running' ? input : (IDLE_INPUT as Input), FIXED_DT);
      traffic.fixedUpdate(FIXED_DT, game.simTime, vehicle);
      world.step();
      vehicle.postStep();
      crash.postStep(FIXED_DT);
      crash.postStepDetached();
      acc -= FIXED_DT;
      steps++;
    }
    if (steps === 5) acc = 0; // dropped frames: don't spiral

    crash.update(realDt);
    const alpha = THREE.MathUtils.clamp(acc / FIXED_DT, 0, 1);
    vehicle.syncVisuals(alpha);
    vehicle.emitEffects(particles);
    crash.syncDetached(alpha);
    traffic.sync(alpha);
    particles.update(realDt * crash.timeScale);

    if (game.state === 'attract') {
      vehicle.worldPosition(camPos);
      chase.attract(now / 1000, camPos);
    } else {
      chase.update(realDt, vehicle, crash);
    }
    sky.update(realDt, chase.cam.position);
    city.update(game.simTime, sky.lightning01, vehicle.currPos);
    game.update(realDt, vehicle);

    vehicle.worldPosition(camPos);
    minimap.update(
      game.state === 'running',
      camPos,
      vehicle.forwardDir(mapFwd),
      game.checkpointTarget,
      game.gasPositions
    );

    fpsAcc += realDt;
    fpsN++;
    fpsT += realDt;
    if (fpsT > 0.5) {
      hud.setFps(fpsN / fpsAcc);
      fpsAcc = 0;
      fpsN = 0;
      fpsT = 0;
    }

    composer.render();
  }
  requestAnimationFrame(frame);

  // debug/inspection handle (dev only)
  (window as unknown as Record<string, unknown>).NR = {
    game, vehicle, crash, chase, world, scene, traffic, minimap,
  };
}

boot();
