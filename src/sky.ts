import * as THREE from 'three';
import { FOG } from './city';
import { dailyRng, pickWeighted } from './daily';

// Red-storm sky dome, lightning controller, and camera-following rain.
// The look is parameterised (SKY_STATES) so the weather can rotate daily
// without new assets; the red storm stays the default and most common.

type RGB = [number, number, number];

export interface SkyState {
  id: string;
  label: string;
  /** relative odds in the daily rotation */
  weight: number;
  /** dome colours as linear RGB (straight into the shader, no sRGB decode) */
  horizon: RGB;
  mid: RGB;
  top: RGB;
  glow: RGB;
  glowStrength: number;
  /** 0 = clear, 1 = full storm streaks */
  clouds: number;
  /** fraction of the base rain budget (> 1 only on desktop, see Sky) */
  rain: number;
  rainOpacity: number;
  /** seconds between strikes [min, max]; null = no lightning */
  strike: [number, number] | null;
  fogColor: number;
  fogDensity: number;
  hemiSky: number;
  hemiGround: number;
}

export const SKY_STATES: SkyState[] = [
  {
    id: 'red-storm', label: 'RED STORM', weight: 4,
    horizon: [0.26, 0.045, 0.04], mid: [0.085, 0.02, 0.06], top: [0.008, 0.006, 0.02],
    glow: [0.9, 0.25, 0.08], glowStrength: 0.35, clouds: 1,
    rain: 1, rainOpacity: 0.28, strike: [4, 12],
    fogColor: FOG.color, fogDensity: FOG.density,
    hemiSky: 0x5a1d2a, hemiGround: 0x120608,
  },
  {
    id: 'violet-dusk', label: 'CLEAR DUSK', weight: 1,
    horizon: [0.17, 0.05, 0.26], mid: [0.06, 0.025, 0.13], top: [0.006, 0.006, 0.03],
    glow: [1.0, 0.45, 0.35], glowStrength: 0.45, clouds: 0.25,
    rain: 0, rainOpacity: 0, strike: null,
    fogColor: 0x150b22, fogDensity: 0.00055,
    hemiSky: 0x3e2456, hemiGround: 0x0c0814,
  },
  {
    id: 'supercell', label: 'SUPERCELL', weight: 1,
    horizon: [0.16, 0.03, 0.03], mid: [0.045, 0.012, 0.035], top: [0.004, 0.003, 0.01],
    glow: [0.7, 0.16, 0.05], glowStrength: 0.18, clouds: 1.35,
    rain: 1.4, rainOpacity: 0.34, strike: [1.2, 4],
    fogColor: 0x10050b, fogDensity: 0.00095,
    hemiSky: 0x461722, hemiGround: 0x0c0406,
  },
  {
    id: 'teal-fog', label: 'PRE-DAWN FOG', weight: 1,
    horizon: [0.05, 0.19, 0.21], mid: [0.02, 0.07, 0.09], top: [0.004, 0.01, 0.02],
    glow: [0.3, 0.75, 0.72], glowStrength: 0.2, clouds: 0.7,
    rain: 0.3, rainOpacity: 0.18, strike: [14, 30],
    fogColor: 0x0b2026, fogDensity: 0.0016,
    hemiSky: 0x24525a, hemiGround: 0x060c10,
  },
];

/** tonight's weather: seeded by the local date, identical for every player */
export function dailySkyState(dateKey: string): SkyState {
  return pickWeighted(SKY_STATES, dailyRng(dateKey, 'sky')());
}

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
uniform vec3 uHorizon;
uniform vec3 uMid;
uniform vec3 uTop;
uniform vec3 uGlow;
uniform float uGlowStrength;
uniform float uClouds;

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
  // (colours come from the active SkyState)
  vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.22, h));
  col = mix(col, uTop, smoothstep(0.18, 0.65, h));

  // sunset glow low in the south-west
  float glow = pow(max(dot(normalize(vDir), normalize(vec3(-0.4, 0.03, -1.0))), 0.0), 6.0);
  col += uGlow * glow * (1.0 - h * 2.0) * uGlowStrength;

  // storm cloud streaks
  vec2 cuv = vDir.xz / max(vDir.y + 0.25, 0.08);
  float clouds = fbm(cuv * 1.4 + vec2(uTime * 0.008, uTime * 0.003));
  col *= 1.0 - clamp(clouds * 0.45 * uClouds, 0.0, 0.9) * smoothstep(0.02, 0.3, h);
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
    uHorizon: { value: new THREE.Color() },
    uMid: { value: new THREE.Color() },
    uTop: { value: new THREE.Color() },
    uGlow: { value: new THREE.Color() },
    uGlowStrength: { value: 0.35 },
    uClouds: { value: 1 },
  };
  state: SkyState = SKY_STATES[0];
  hemi: THREE.HemisphereLight;
  flash: THREE.DirectionalLight;
  /** 0-1 current lightning intensity, read by city/road materials */
  lightning01 = 0;

  private nextStrike = 3;
  private strikeT = -1;
  private rain: THREE.LineSegments;
  private rainPos: Float32Array;
  private rainVel: Float32Array;
  private RAIN_N = 900; // allocated drops (the heaviest state's budget)
  private rainBase = 900; // drops at rain = 1
  private rainActive = 900; // drops currently simulated + drawn
  private rainMat: THREE.LineBasicMaterial;
  private RAIN_BOX = new THREE.Vector3(110, 55, 110);

  constructor(private scene: THREE.Scene, quality = 1) {
    this.rainBase = Math.max(150, Math.round(900 * quality));
    // a heavier storm may add drops on desktop only; touch never exceeds its
    // lighter base budget, so mobile cost is unchanged in every state
    const maxRain = Math.max(...SKY_STATES.map((st) => st.rain));
    this.RAIN_N = quality < 1 ? this.rainBase : Math.round(this.rainBase * maxRain);
    this.rainActive = this.rainBase;
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
    const rmat = (this.rainMat = new THREE.LineBasicMaterial({
      color: 0x8899bb,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    this.rain = new THREE.LineSegments(rgeo, rmat);
    this.rain.frustumCulled = false;
    scene.add(this.rain);
    this.setState(SKY_STATES[0]);
  }

  /** swap the weather: dome colours, rain budget, strike rate, scene fog.
   *  (City shaders carry their own fog uniforms — main mirrors fog there.) */
  setState(st: SkyState) {
    this.state = st;
    const u = this.uniforms;
    u.uHorizon.value.setRGB(...st.horizon, THREE.LinearSRGBColorSpace);
    u.uMid.value.setRGB(...st.mid, THREE.LinearSRGBColorSpace);
    u.uTop.value.setRGB(...st.top, THREE.LinearSRGBColorSpace);
    u.uGlow.value.setRGB(...st.glow, THREE.LinearSRGBColorSpace);
    u.uGlowStrength.value = st.glowStrength;
    u.uClouds.value = st.clouds;
    this.rainActive = Math.min(this.RAIN_N, Math.round(this.rainBase * st.rain));
    this.rain.geometry.setDrawRange(0, this.rainActive * 2);
    this.rain.visible = this.rainActive > 0;
    this.rainMat.opacity = st.rainOpacity;
    this.hemi.color.setHex(st.hemiSky);
    this.hemi.groundColor.setHex(st.hemiGround);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.setHex(st.fogColor);
      this.scene.fog.density = st.fogDensity;
    }
    this.strikeT = -1;
    this.lightning01 = 0;
    this.nextStrike = st.strike ? st.strike[0] : Infinity;
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
    const strike = this.state.strike;
    if (strike && this.nextStrike <= 0 && this.strikeT < 0) {
      this.strikeT = 0;
      this.nextStrike = strike[0] + Math.random() * (strike[1] - strike[0]);
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
    for (let i = 0; i < this.rainActive; i++) {
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
