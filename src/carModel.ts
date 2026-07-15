import * as THREE from 'three';

// Player car visuals. Two paths:
//  - glTF template (three.js example Ferrari 458, model credit: vecarz) with
//    real wheel nodes reparented into steer/spin rigs, or
//  - procedural greybox fallback when the model fails to load.
// Detachable panels (hood/bumpers/doors) are simple color-matched boxes; on the
// glTF car they stay hidden until the crash system flings them off.

export interface CarPart {
  name: string;
  mesh: THREE.Mesh;
  size: THREE.Vector3;
  localPos: THREE.Vector3;
  attached: boolean;
}

export interface CarModel {
  group: THREE.Group;
  parts: Map<string, CarPart>;
  wheels: THREE.Object3D[];
  /** physics wheel attach points (chassis-local); from the glTF when loaded */
  wheelPositions: THREE.Vector3[];
  wheelRadius: number;
  shell: THREE.Mesh;
  shellBasePositions: Float32Array;
  brakeMat: THREE.MeshStandardMaterial;
  headlights: THREE.SpotLight[];
  dispose(): void;
}

const BODY_COLOR = 0xc7472e; // burnt orange-red
const EDGE_COLOR = 0xff6a3d; // player wireframe glow

// Optional glTF template. When set, buildCarModel clones it.
// (Unused in the wireframe restyle — the procedural car IS the aesthetic.)
let carTemplate: THREE.Group | null = null;
export function setCarTemplate(scene: THREE.Group) {
  carTemplate = scene;
}

/** glowing edge lines on top of a near-black fill (hidden-line look) */
export function addEdgeLines(mesh: THREE.Mesh, color: number, opacity = 0.95): THREE.LineSegments {
  const line = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry as THREE.BufferGeometry, 20),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity })
  );
  mesh.add(line);
  return line;
}

const WHEEL_ATTACH_Y = -0.1; // suspension hardpoint height on the chassis

function makeBlobShadow(group: THREE.Group) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 5.4),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -0.62;
  group.add(shadow);
}

function makeLightRig(group: THREE.Group, halfLen: number) {
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xfff2cc,
    emissiveIntensity: 3.5,
  });
  const brakeMat = new THREE.MeshStandardMaterial({
    color: 0x330000,
    emissive: 0xff1a1a,
    emissiveIntensity: 1.2,
  });
  for (const sx of [-0.55, 0.55]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.05), headMat);
    h.position.set(sx, 0.08, halfLen - 0.04);
    group.add(h);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.09, 0.05), brakeMat);
    t.position.set(sx, 0.12, -halfLen + 0.04);
    group.add(t);
  }
  const headlights: THREE.SpotLight[] = [];
  for (const sx of [-0.55, 0.55]) {
    const sp = new THREE.SpotLight(0xfff0d0, 260, 80, 0.5, 0.45, 1.4);
    sp.position.set(sx, 0.25, halfLen - 0.2);
    const tgt = new THREE.Object3D();
    tgt.position.set(sx * 0.5, -0.6, 30);
    group.add(tgt);
    sp.target = tgt;
    group.add(sp);
    headlights.push(sp);
  }
  // faint "streetlight kiss" so the body paint reads at night
  const fill = new THREE.PointLight(0xffe8d0, 18, 7, 1.6);
  fill.position.set(0, 2.4, 0);
  group.add(fill);
  return { brakeMat, headlights };
}

function makeParts(
  group: THREE.Group,
  paint: THREE.Material,
  dark: THREE.Material,
  halfLen: number,
  visible: boolean
): Map<string, CarPart> {
  const parts = new Map<string, CarPart>();
  const add = (name: string, size: THREE.Vector3, pos: THREE.Vector3, mat: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat);
    mesh.position.copy(pos);
    mesh.visible = visible;
    addEdgeLines(mesh, EDGE_COLOR, 0.85);
    group.add(mesh);
    parts.set(name, { name, mesh, size, localPos: pos.clone(), attached: true });
  };
  add('hood', new THREE.Vector3(1.6, 0.07, 1.25), new THREE.Vector3(0, 0.3, halfLen * 0.6), paint);
  add('frontBumper', new THREE.Vector3(1.9, 0.25, 0.34), new THREE.Vector3(0, -0.16, halfLen - 0.1), dark);
  add('rearBumper', new THREE.Vector3(1.9, 0.25, 0.34), new THREE.Vector3(0, -0.16, -halfLen + 0.1), dark);
  add('doorL', new THREE.Vector3(0.09, 0.4, 1.4), new THREE.Vector3(0.95, 0.05, -0.15), paint);
  add('doorR', new THREE.Vector3(0.09, 0.4, 1.4), new THREE.Vector3(-0.95, 0.05, -0.15), paint);
  return parts;
}

// ---------------------------------------------------------------- glTF path
function buildFromTemplate(scene: THREE.Scene, template: THREE.Group): CarModel {
  const group = new THREE.Group();
  const car = template.clone(true);

  // find wheels + body in the clone
  const wheelNames = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'];
  const wheelNodes = wheelNames.map((n) => car.getObjectByName(n) ?? null);
  const bodyMesh = car.getObjectByName('body') as THREE.Mesh | null;

  // face +z: front wheels must have z > 0
  car.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  if (wheelNodes[0]) {
    wheelNodes[0].getWorldPosition(p);
    if (p.z < 0) car.rotation.y += Math.PI;
    car.updateMatrixWorld(true);
  }

  // measure wheels in car space
  const wheelWorld = wheelNodes.map((n) => {
    const v = new THREE.Vector3();
    if (n) n.getWorldPosition(v);
    return v;
  });
  const center = wheelWorld
    .reduce((s, v) => s.add(v), new THREE.Vector3())
    .multiplyScalar(0.25);
  const wheelRadius = Math.max(0.28, Math.min(0.4, center.y > 0.05 ? center.y : 0.33));

  // recolor body paint, brighten reflections
  car.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial;
      if (std.name === 'Body_Color') {
        std.color = new THREE.Color(BODY_COLOR);
        std.envMapIntensity = 1.3;
        std.metalness = 0.8;
        std.roughness = 0.28;
      }
    }
  });

  // wheel rigs at physics hardpoints; reparent glTF wheels into them recentered
  const wheels: THREE.Object3D[] = [];
  const wheelPositions: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const rig = new THREE.Group();
    const w = wheelWorld[i];
    wheelPositions.push(new THREE.Vector3(w.x - center.x, WHEEL_ATTACH_Y, w.z - center.z));
    const node = wheelNodes[i];
    if (node) {
      node.parent?.remove(node);
      node.position.set(0, 0, 0);
      node.rotation.set(0, 0, 0);
      rig.add(node);
    }
    group.add(rig);
    wheels.push(rig);
  }

  // body: align the model's wheel centers with the rig rest pose
  const REST_WHEEL_Y = WHEEL_ATTACH_Y - 0.24; // settled suspension height
  car.position.set(-center.x, REST_WHEEL_Y - center.y, -center.z);
  group.add(car);

  // shell for crumple: clone geometry so the shared template stays pristine
  let shell: THREE.Mesh;
  if (bodyMesh) {
    bodyMesh.geometry = bodyMesh.geometry.clone();
    shell = bodyMesh;
  } else {
    shell = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 4.2), new THREE.MeshStandardMaterial());
    shell.visible = false;
    group.add(shell);
  }
  const shellBasePositions = new Float32Array(
    (shell.geometry.attributes.position as THREE.BufferAttribute).array
  );

  const bbox = new THREE.Box3().setFromObject(car);
  const halfLen = Math.max(2.0, (bbox.max.z - bbox.min.z) / 2 - 0.05);

  const paint = new THREE.MeshStandardMaterial({
    color: BODY_COLOR, metalness: 0.75, roughness: 0.32, envMapIntensity: 1.2,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a20, metalness: 0.5, roughness: 0.5 });
  const parts = makeParts(group, paint, dark, halfLen, false);
  const { brakeMat, headlights } = makeLightRig(group, halfLen);
  makeBlobShadow(group);

  scene.add(group);
  return {
    group,
    parts,
    wheels,
    wheelPositions,
    wheelRadius,
    shell,
    shellBasePositions,
    brakeMat,
    headlights,
    dispose() {
      scene.remove(group);
      shell.geometry.dispose(); // only the cloned crumple geometry
      for (const part of parts.values()) part.mesh.geometry.dispose();
    },
  };
}

// ---------------------------------------------------------- procedural path
function buildProcedural(scene: THREE.Scene): CarModel {
  const group = new THREE.Group();

  // hidden-line wireframe: near-black fills + glowing edges
  const off = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const paint = new THREE.MeshStandardMaterial({
    color: 0x170a06, metalness: 0.4, roughness: 0.6, ...off,
  });
  const darkPaint = new THREE.MeshStandardMaterial({ color: 0x0a0a0e, metalness: 0.3, roughness: 0.6, ...off });
  const glass = new THREE.MeshStandardMaterial({ color: 0x040609, metalness: 0.5, roughness: 0.4, ...off });
  void BODY_COLOR;

  const shellGeo = new THREE.BoxGeometry(1.84, 0.52, 4.3, 4, 2, 10);
  const shell = new THREE.Mesh(shellGeo, paint);
  shell.position.set(0, 0.02, 0);
  group.add(shell);
  const shellEdges = addEdgeLines(shell, EDGE_COLOR);
  shell.userData.rebuildEdges = () => {
    shellEdges.geometry.dispose();
    shellEdges.geometry = new THREE.EdgesGeometry(shellGeo, 20);
  };
  const shellBasePositions = new Float32Array(
    (shellGeo.attributes.position as THREE.BufferAttribute).array
  );

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.44, 2.0), glass);
  cabin.position.set(0, 0.46, -0.35);
  addEdgeLines(cabin, 0x58e6ff, 0.55);
  group.add(cabin);

  const parts = makeParts(group, paint, darkPaint, 2.15, true);
  const { brakeMat, headlights } = makeLightRig(group, 2.15);

  const tireMat = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.9 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0x8a8a92, metalness: 0.9, roughness: 0.3 });
  const wheels: THREE.Object3D[] = [];
  const wheelPositions = [
    new THREE.Vector3(0.82, WHEEL_ATTACH_Y, 1.42),
    new THREE.Vector3(-0.82, WHEEL_ATTACH_Y, 1.42),
    new THREE.Vector3(0.82, WHEEL_ATTACH_Y, -1.42),
    new THREE.Vector3(-0.82, WHEEL_ATTACH_Y, -1.42),
  ];
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Group();
    const tireGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.28, 14);
    tireGeo.rotateZ(Math.PI / 2);
    const tire = new THREE.Mesh(tireGeo, tireMat);
    addEdgeLines(tire, 0x8a9aad, 0.5); // rim circles so wheel spin reads
    w.add(tire);
    const hubGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.3, 8);
    hubGeo.rotateZ(Math.PI / 2);
    w.add(new THREE.Mesh(hubGeo, hubMat));
    group.add(w);
    wheels.push(w);
  }

  makeBlobShadow(group);
  scene.add(group);

  return {
    group,
    parts,
    wheels,
    wheelPositions,
    wheelRadius: 0.35,
    shell,
    shellBasePositions,
    brakeMat,
    headlights,
    dispose() {
      scene.remove(group);
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
    },
  };
}

export function buildCarModel(scene: THREE.Scene): CarModel {
  return carTemplate ? buildFromTemplate(scene, carTemplate) : buildProcedural(scene);
}
