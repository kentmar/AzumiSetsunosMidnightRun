# NIGHT RUN: NYC

Browser arcade-racing prototype — Midnight Club / NFS / Burnout lineage — set in a
stylized night-storm Manhattan. Three.js rendering + Rapier (WASM) raycast-vehicle
physics, fixed 60 Hz timestep decoupled from render with interpolation.

## Run it

```bash
npm i
npm run dev        # → http://localhost:5173
```

**Controls:** `W/↑` throttle · `S/↓` brake + reverse · `A D / ← →` steer ·
`SPACE` handbrake (drift) · `R` flip rescue · `C` insert coin · `ENTER` start / continue ·
`P` tuning panel · `ESC` pause

## Where things live

| System | File | Notes |
|---|---|---|
| **Vehicle tuning** | [src/tuning.ts](src/tuning.ts) | The `TUNING` block: mass, enginePower, brakeForce, suspension, front/rear grip, handbrakeGripCut, steer, downforce, comHeight… Live-editable via the **P** panel (persists to localStorage, COPY JSON button). |
| Vehicle physics | [src/vehicle.ts](src/vehicle.ts) | Rapier `DynamicRayCastVehicleController`, 4 suspension rays, RWD (AWD slider), slip-angle-driven rear grip fade, handbrake grip cut, low ballast for `comHeight`. |
| **Crash system** | [src/crash.ts](src/crash.ts) | Burnout-lite: one-step Δv impact detection, detachable hood/bumpers/doors/wheels as rigid bodies, vertex-displacement crumple, slow-mo (`crashSlowmo`), crash cam, shake, health → TOTALED → credit-continue. Thresholds in `TUNING.crashDv*`. |
| **Camera** | [src/camera.ts](src/camera.ts) | Spring-arm chase cam; building-collision ray hard-clamps the arm (never clips); FOV 62→82 with speed; drift trails the velocity vector; crash-cam override. `TUNING.cam*`. |
| **City (real OSM)** | [src/city.ts](src/city.ts) | Real midtown Manhattan from OpenStreetMap: 1700 true building footprints + heights (Empire State, One Vanderbilt, 432 Park…), all 16 real avenues (one-way, real positions) + 37 cross-streets, merged into one draw call with world-space lit windows, storefront glow, neon signs, streetlights, phased signals, skyline ring, bridge towers. Data: [src/assets/midtown.json](src/assets/midtown.json). |
| OSM bake | [scripts/bake-osm.mjs](scripts/bake-osm.mjs) | One-time Overpass fetch → projects + rotates 29° so the Manhattan grid is axis-aligned → writes the JSON above. Re-run to change the bounding box; the game itself needs no network. |
| Car model | [src/carModel.ts](src/carModel.ts) | glTF Ferrari 458 (three.js example model, credit **vecarz**; Draco-compressed, decoder in `public/draco/`). Real wheel nodes drive physics hardpoints; color-matched detach panels; procedural greybox fallback if the file is missing. |
| Sky / storm | [src/sky.ts](src/sky.ts) | Red-sunset dome shader, lightning flashes (lights streets + windows), rain streaks. |
| Traffic | [src/traffic.ts](src/traffic.ts) | ~11 lane-following kinematic cars that stop at lights; convert to dynamic bodies and go flying when rammed. |
| Game loop | [src/game.ts](src/game.ts) | Attract / credits / checkpoint sprint (+1 credit per set) / fuel + gas pickups / bridge-boundary detonation. |
| HUD | [src/hud.ts](src/hud.ts) | Tactical amber/cyan: big MPH, fuel, integrity, credits, checkpoints, boundary warning. |
| Bootstrap | [src/main.ts](src/main.ts) | 60 Hz fixed-step accumulator (slow-mo scales sim time), render interpolation, one-shot cubemap for wet-road/paint reflections. `window.NR` = debug handle. |

## Feel-tuning workflow

1. Press **P** in game — sliders bind directly to `TUNING`; vehicle keys re-apply physics live.
2. Iterate grip balance (`frontGrip` vs `rearGrip`), `suspStiffness`/damping for body roll,
   `handbrakeGripCut` for drift entry, `crashDvHard` for how survivable crashes are.
3. **COPY JSON** and paste the values into `src/tuning.ts` to make them the new defaults.

## Scope guards honored

No soft-body/FEM (detachable rigid parts + crumple + slow-mo only), no multiplayer/payments
(credits are a local integer), no *streamed* map tiles (the OSM data is baked to a static
JSON at build time), pure client-side web.

Not yet in this pass: audio, gamepad, skid marks, persistent scores, Google Photorealistic
3D Tiles mode (possible later; needs a billed Google Cloud API key).
