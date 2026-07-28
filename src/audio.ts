import { TUNING } from './tuning';

// Procedural audio — no sample assets. Everything is synthesised in Web Audio,
// which keeps the whole soundtrack at ~0 bytes (matching the wireframe car and
// the baked city) and lets the engine track RPM continuously instead of
// crossfading recorded loop layers.
//
//   engine  (saw stack + induction noise) ┐
//   turbo   (whistle + blow-off)          ├─ dry ──┬──────────────> master ─> out
//   tyres   (filtered noise)              │        └─ convolver ───┘
//   impacts (noise burst + body thump)  ──┘           (tunnels)
//
// Everything below is driven from state the game already computes: no new
// physics, no new bookkeeping.

export interface AudioState {
  running: boolean;
  speed: number; // m/s
  throttle: number; // 0..1
  drifting: boolean;
  onGround: boolean;
  /** engine cut: totaled or out of fuel */
  dead: boolean;
  inTunnel: boolean;
  /** crash slow-mo; bends the whole mix down with the sim */
  timeScale: number;
}

const IDLE_RPM = 850;
const MAX_RPM = 7200;
// Arcade gearbox — AUDIO ONLY. The physics has no transmission, but a single
// rising whine across the whole speed range sounds like a vacuum cleaner;
// shift points are what make an engine read as an engine.
const GEAR_TOP = [12, 22, 33, 45, 62]; // m/s at redline in each gear
const FIRING_ORDER = 3; // inline-6, four-stroke: 3 power strokes per revolution
const SHIFT_TIME = 0.18; // length of the shift cut

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private dry!: GainNode;
  private verbSend!: GainNode;

  // engine
  private oscA!: OscillatorNode;
  private oscB!: OscillatorNode;
  private oscSub!: OscillatorNode;
  private engFilter!: BiquadFilterNode;
  private engGain!: GainNode;
  private induction!: GainNode;
  // turbo
  private whistle!: OscillatorNode;
  private whistleGain!: GainNode;
  // tyres
  private tyreGain!: GainNode;

  private noiseBuf!: AudioBuffer;
  private gear = 0;
  private rpm = IDLE_RPM;
  private boost = 0;
  private prevThrottle = 0;
  private shiftT = 0;
  private started = false;

  get isOn() {
    return this.started;
  }

  /** must be called from a user gesture (INSERT COIN / Enter / first tap) */
  start() {
    if (this.started) return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.started = true;
    const ctx = new Ctx();
    this.ctx = ctx;
    void ctx.resume();

    this.noiseBuf = this.makeNoise(ctx, 2);

    this.master = ctx.createGain();
    this.master.gain.value = TUNING.audioVolume;
    this.master.connect(ctx.destination);

    this.dry = ctx.createGain();
    this.dry.gain.value = 1;
    this.dry.connect(this.master);

    // tunnel acoustics: a procedurally generated impulse response, so the
    // bores go cavernous the moment you dive under the street
    const verb = ctx.createConvolver();
    verb.buffer = this.makeImpulse(ctx, 1.6, 3.2);
    this.verbSend = ctx.createGain();
    this.verbSend.gain.value = 0;
    this.verbSend.connect(verb);
    verb.connect(this.master);

    // ---- engine ----
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 600;
    this.engFilter.Q.value = 0.7;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilter.connect(this.engGain);
    this.fan(this.engGain);

    // A sawtooth carries every harmonic at 1/n, which is precisely what "buzzy"
    // sounds like. A real engine's spectrum rolls off far faster and leans on
    // the low orders, so build custom waves instead of using the stock shapes.
    const engineWave = (rolloff: number, n = 20) => {
      const real = new Float32Array(n + 1);
      const imag = new Float32Array(n + 1);
      for (let h = 1; h <= n; h++) {
        // even orders sit back a little: gives the lumpy six-cylinder beat
        imag[h] = Math.pow(h, -rolloff) * (h % 2 === 0 ? 0.7 : 1);
      }
      return ctx.createPeriodicWave(real, imag);
    };
    const mkOsc = (wave: PeriodicWave | null, type: OscillatorType, gain: number) => {
      const o = ctx.createOscillator();
      if (wave) o.setPeriodicWave(wave); else o.type = type;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(this.engFilter);
      o.start();
      return o;
    };
    this.oscA = mkOsc(engineWave(1.7), 'sawtooth', 0.55);
    this.oscB = mkOsc(engineWave(2.3), 'sawtooth', 0.26);
    this.oscSub = mkOsc(null, 'triangle', 0.30); // triangle, not square: body without edge
    this.oscB.detune.value = 7; // slight beat: stops it sounding like one tone

    // induction/intake roar
    const indSrc = ctx.createBufferSource();
    indSrc.buffer = this.noiseBuf;
    indSrc.loop = true;
    const indBp = ctx.createBiquadFilter();
    indBp.type = 'bandpass';
    indBp.frequency.value = 420;
    indBp.Q.value = 0.7;
    this.induction = ctx.createGain();
    this.induction.gain.value = 0;
    indSrc.connect(indBp);
    indBp.connect(this.induction);
    this.fan(this.induction);
    indSrc.start();

    // ---- turbo (it IS a Turbo A) ----
    this.whistle = ctx.createOscillator();
    this.whistle.type = 'sine';
    this.whistleGain = ctx.createGain();
    this.whistleGain.gain.value = 0;
    this.whistle.connect(this.whistleGain);
    this.fan(this.whistleGain);
    this.whistle.start();

    // ---- tyres ----
    const tSrc = ctx.createBufferSource();
    tSrc.buffer = this.noiseBuf;
    tSrc.loop = true;
    const tBp = ctx.createBiquadFilter();
    tBp.type = 'bandpass';
    tBp.frequency.value = 1500;
    tBp.Q.value = 4.5;
    this.tyreGain = ctx.createGain();
    this.tyreGain.gain.value = 0;
    tSrc.connect(tBp);
    tBp.connect(this.tyreGain);
    this.fan(this.tyreGain);
    tSrc.start();

    // browsers suspend audio with the tab; resume when we come back
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  /** route a source to both the dry bus and the reverb send */
  private fan(node: AudioNode) {
    node.connect(this.dry);
    node.connect(this.verbSend);
  }

  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** exponentially decaying noise = a serviceable room impulse response */
  private makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
      }
    }
    return buf;
  }

  /** per-frame; smooths every parameter so nothing zippers */
  update(dt: number, s: AudioState) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.master.gain.value += (TUNING.audioVolume - this.master.gain.value) * 0.2;
    const t = ctx.currentTime;
    const k = Math.min(1, dt * 12); // parameter smoothing

    // ---- fake gearbox ----
    const sp = Math.abs(s.speed);
    let g = 0;
    while (g < GEAR_TOP.length - 1 && sp > GEAR_TOP[g]) g++;
    if (g !== this.gear) {
      this.shiftT = SHIFT_TIME;
      this.gear = g;
    }
    this.shiftT = Math.max(0, this.shiftT - dt);
    const lo = g === 0 ? 0 : GEAR_TOP[g - 1];
    const span = Math.max(1, GEAR_TOP[g] - lo);
    const rpm01 = Math.min(1.05, (sp - lo) / span);
    const targetRpm = s.dead
      ? 0
      : IDLE_RPM + rpm01 * (MAX_RPM - IDLE_RPM) + (s.throttle > 0.05 ? 260 : 0);
    this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * (s.dead ? 2.5 : 7));

    // firing frequency, bent by slow-mo along with the rest of the sim
    const f = Math.max(8, (this.rpm / 60) * FIRING_ORDER) * Math.max(0.2, s.timeScale);
    this.oscA.frequency.setTargetAtTime(f, t, 0.02);
    this.oscB.frequency.setTargetAtTime(f * 2.008, t, 0.02);
    this.oscSub.frequency.setTargetAtTime(f * 0.5, t, 0.02);

    const load = s.throttle;
    const alive = s.running && !s.dead ? 1 : 0;
    // smooth bell-shaped cut: deepest mid-shift, recovers cleanly
    const shiftDuck = 1 - 0.55 * Math.sin((this.shiftT / SHIFT_TIME) * Math.PI);
    const engTarget = alive * shiftDuck * (0.10 + 0.155 * load + 0.09 * rpm01) * TUNING.audioEngine;
    this.engGain.gain.value += (engTarget - this.engGain.gain.value) * k;
    const cutoff = 300 + load * 1250 + rpm01 * 1350;
    this.engFilter.frequency.setTargetAtTime(cutoff, t, 0.05);
    const indTarget = alive * (0.02 + 0.085 * load * (0.3 + rpm01)) * TUNING.audioEngine;
    this.induction.gain.value += (indTarget - this.induction.gain.value) * k;

    // ---- turbo: spools on sustained throttle, chirps on lift ----
    const spoolRate = load > 0.5 && rpm01 > 0.25 ? dt * 1.1 : -dt * 2.2;
    this.boost = Math.max(0, Math.min(1, this.boost + spoolRate));
    this.whistle.frequency.setTargetAtTime(1150 + this.boost * 1700 + rpm01 * 600, t, 0.05);
    const wTarget = alive * this.boost * 0.009 * TUNING.audioTurbo;
    this.whistleGain.gain.value += (wTarget - this.whistleGain.gain.value) * k;
    if (this.prevThrottle > 0.55 && load < 0.15 && this.boost > 0.45) this.blowOff();
    this.prevThrottle = load;

    // ---- tyres ----
    const slide = s.drifting && s.onGround ? Math.min(1, sp / 16) : 0;
    const tTarget = alive * slide * 0.13;
    this.tyreGain.gain.value += (tTarget - this.tyreGain.gain.value) * k;

    // ---- tunnels ----
    const verbTarget = s.inTunnel ? 0.5 : 0.02;
    this.verbSend.gain.value += (verbTarget - this.verbSend.gain.value) * Math.min(1, dt * 2.2);
  }

  /** crash impact, scaled by the same delta-v the crash system already computes */
  impact(dv: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const amt = Math.min(1, dv / 14);

    // metal: filtered noise burst
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700 + dv * 90;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    const peak = 0.22 + amt * 0.5;
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16 + amt * 0.5);
    src.connect(bp); bp.connect(g); this.fan(g);
    src.start(t);
    src.stop(t + 0.9);

    // body: a low thump that drops in pitch
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150 + amt * 60, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.22);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.16 + amt * 0.42, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(og); this.fan(og);
    o.start(t);
    o.stop(t + 0.4);
  }

  private blowOff() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.boost = 0;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.setValueAtTime(2600, t);
    hp.frequency.exponentialRampToValueAtTime(1200, t + 0.18);
    hp.Q.value = 1.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.06 * TUNING.audioTurbo, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    src.connect(hp); hp.connect(g); this.fan(g);
    src.start(t);
    src.stop(t + 0.3);
  }

  /** dev probe: RMS level + engine state, for verifying the mix without ears */
  private analyser: AnalyserNode | null = null;
  probe() {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (!this.analyser) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.master.connect(this.analyser);
    }
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return {
      rms: Math.sqrt(sum / buf.length),
      rpm: Math.round(this.rpm),
      gear: this.gear + 1,
      boost: +this.boost.toFixed(2),
      verb: +this.verbSend.gain.value.toFixed(2),
      ctx: ctx.state,
    };
  }

  /** short UI blip (checkpoint, credit) */
  blip(freq = 880, dur = 0.12, vol = 0.09) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 1.5, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.dry);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
}
