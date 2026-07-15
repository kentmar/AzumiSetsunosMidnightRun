import * as THREE from 'three';

// Red-storm sky dome, lightning controller, and camera-following rain.

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
uniform float uLightning;
uniform float uTime;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.1; a *= 0.5; }
  return v;
}

void main() {
  float h = clamp(vDir.y, 0.0, 1.0);
  // wireframe restyle: darker storm, red kept as a low ember at the horizon
  vec3 horizon = vec3(0.26, 0.045, 0.04);
  vec3 mid     = vec3(0.085, 0.02, 0.06);
  vec3 top     = vec3(0.008, 0.006, 0.02);
  vec3 col = mix(horizon, mid, smoothstep(0.0, 0.22, h));
  col = mix(col, top, smoothstep(0.18, 0.65, h));

  // sunset glow low in the south-west
  float glow = pow(max(dot(normalize(vDir), normalize(vec3(-0.4, 0.03, -1.0))), 0.0), 6.0);
  col += vec3(0.9, 0.25, 0.08) * glow * (1.0 - h * 2.0) * 0.35;

  // storm cloud streaks
  vec2 cuv = vDir.xz / max(vDir.y + 0.25, 0.08);
  float clouds = fbm(cuv * 1.4 + vec2(uTime * 0.008, uTime * 0.003));
  col *= 1.0 - clouds * 0.45 * smoothstep(0.02, 0.3, h);
  // lightning brightens cloud undersides
  col += vec3(0.75, 0.8, 1.0) * uLightning * (0.25 + clouds * 0.8) * smoothstep(0.0, 0.35, h + 0.15);

  gl_FragColor = vec4(col, 1.0);
}
`;

export class Sky {
  dome: THREE.Mesh;
  uniforms = {
    uLightning: { value: 0 },
    uTime: { value: 0 },
  };
  hemi: THREE.HemisphereLight;
  flash: THREE.DirectionalLight;
  /** 0-1 current lightning intensity, read by city/road materials */
  lightning01 = 0;

  private nextStrike = 3;
  private strikeT = -1;
  private rain: THREE.LineSegments;
  private rainPos: Float32Array;
  private rainVel: Float32Array;
  private RAIN_N = 900;
  private RAIN_BOX = new THREE.Vector3(110, 55, 110);

  constructor(scene: THREE.Scene, quality = 1) {
    this.RAIN_N = Math.max(150, Math.round(900 * quality));
    const geo = new THREE.SphereGeometry(2400, 32, 20);
    const mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    this.hemi = new THREE.HemisphereLight(0x5a1d2a, 0x120608, 2.2);
    scene.add(this.hemi);
    const fill = new THREE.DirectionalLight(0x883344, 0.55);
    fill.position.set(-300, 400, -600);
    scene.add(fill);

    this.flash = new THREE.DirectionalLight(0xbfd4ff, 0);
    this.flash.position.set(200, 500, 100);
    scene.add(this.flash);

    // rain as short line streaks
    this.rainPos = new Float32Array(this.RAIN_N * 6);
    this.rainVel = new Float32Array(this.RAIN_N);
    const b = this.RAIN_BOX;
    for (let i = 0; i < this.RAIN_N; i++) {
      this.resetDrop(i, Math.random() * b.y, new THREE.Vector3());
    }
    const rgeo = new THREE.BufferGeometry();
    rgeo.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    const rmat = new THREE.LineBasicMaterial({
      color: 0x8899bb,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.rain = new THREE.LineSegments(rgeo, rmat);
    this.rain.frustumCulled = false;
    scene.add(this.rain);
  }

  private resetDrop(i: number, y: number, center: THREE.Vector3) {
    const b = this.RAIN_BOX;
    const x = center.x + (Math.random() - 0.5) * b.x;
    const z = center.z + (Math.random() - 0.5) * b.z;
    const v = 38 + Math.random() * 22;
    this.rainVel[i] = v;
    const len = v * 0.022;
    const o = i * 6;
    this.rainPos[o] = x;
    this.rainPos[o + 1] = y;
    this.rainPos[o + 2] = z;
    this.rainPos[o + 3] = x + 1.5 * 0.022 * v * 0.06;
    this.rainPos[o + 4] = y + len;
    this.rainPos[o + 5] = z;
  }

  update(dt: number, camPos: THREE.Vector3) {
    this.uniforms.uTime.value += dt;
    this.dome.position.set(camPos.x, 0, camPos.z);

    // lightning state machine: idle -> strike (flickery envelope ~0.5s)
    this.nextStrike -= dt;
    if (this.nextStrike <= 0 && this.strikeT < 0) {
      this.strikeT = 0;
      this.nextStrike = 4 + Math.random() * 8;
      this.flash.position.set(
        camPos.x + (Math.random() - 0.5) * 1200,
        500,
        camPos.z + (Math.random() - 0.5) * 1200
      );
    }
    if (this.strikeT >= 0) {
      this.strikeT += dt;
      const t = this.strikeT;
      // two flickers then decay
      const env =
        Math.max(0, 1 - t * 6) +
        Math.max(0, 0.7 - Math.abs(t - 0.22) * 8) +
        Math.max(0, 0.4 - Math.abs(t - 0.38) * 6);
      this.lightning01 = Math.min(1, env);
      if (t > 0.6) {
        this.strikeT = -1;
        this.lightning01 = 0;
      }
    } else {
      this.lightning01 = 0;
    }
    this.uniforms.uLightning.value = this.lightning01;
    this.flash.intensity = this.lightning01 * 3.2;
    this.hemi.intensity = 2.2 + this.lightning01 * 3.5;

    // rain
    const b = this.RAIN_BOX;
    for (let i = 0; i < this.RAIN_N; i++) {
      const o = i * 6;
      const fall = this.rainVel[i] * dt;
      this.rainPos[o + 1] -= fall;
      this.rainPos[o + 4] -= fall;
      if (this.rainPos[o + 1] < 0) {
        this.resetDrop(i, b.y * (0.7 + Math.random() * 0.3), camPos);
      } else {
        // keep drops loosely tethered to the camera horizontally
        if (Math.abs(this.rainPos[o] - camPos.x) > b.x * 0.6) {
          this.rainPos[o] = camPos.x + (Math.random() - 0.5) * b.x;
          this.rainPos[o + 3] = this.rainPos[o];
        }
        if (Math.abs(this.rainPos[o + 2] - camPos.z) > b.z * 0.6) {
          this.rainPos[o + 2] = camPos.z + (Math.random() - 0.5) * b.z;
          this.rainPos[o + 5] = this.rainPos[o + 2];
        }
      }
    }
    (this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
