// audio.js - real CC0 sound-file playback (fetched AudioBuffers); engine loop, footsteps, impacts, weapons. Assets are CC0, see assets/audio/CREDITS.md.
import { CONFIG } from "./config.js";

const A = CONFIG.audio;
// Persistent looping vehicle categories: one always-on source each, gain 0 until selected.
const LOOP_CATS = ["engine", "rotor", "plane", "hover", "boat"];
const BASE = new URL("../assets/audio/", import.meta.url);
const FILES = {
  footstep: ["footstep_0.ogg", "footstep_1.ogg", "footstep_2.ogg", "footstep_3.ogg"],
  impact: ["impact_0.ogg", "impact_1.ogg", "impact_2.ogg"],
  engine: ["engine_loop.ogg"],
  rotor: ["rotor_loop.ogg"],
  plane: ["plane_loop.ogg"],
  hover: ["hover_loop.ogg"],
  boat: ["boat_loop.ogg"],
  swing: ["swing.ogg"],
  clang: ["clang.ogg"],
  thud: ["thud.ogg"],
  gunshot: ["gunshot.wav"],
  c4place: ["c4_place.ogg"],
  beep: ["detonate_beep.ogg"],
  explosion: ["explosion_0.ogg", "explosion_1.ogg"],
  rocket: ["rocket_launch.ogg"],
};

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.footPhase = 0;
    this.buffers = {};
    this._impactActive = 0;
    // Prefetch raw bytes at page load so decode after the first gesture is instant.
    this._raw = {};
    for (const [k, list] of Object.entries(FILES)) {
      this._raw[k] = list.map((f) =>
        fetch(new URL(f, BASE)).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null)
      );
    }
  }

  async resume() {
    if (this.ready) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
    if (this._resuming) { if (this.ctx && this.ctx.state === "suspended") this.ctx.resume(); return; }
    this._resuming = true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = A.masterGain;
    this.master.connect(this.ctx.destination);
    await this._decodeAll();
    this._startLoops();
    this.ready = true;
  }

  async _decodeAll() {
    for (const [k, proms] of Object.entries(this._raw)) {
      const arrs = await Promise.all(proms);
      const bufs = [];
      for (const a of arrs) {
        if (!a) continue;
        try { bufs.push(await this.ctx.decodeAudioData(a.slice(0))); } catch (e) {}
      }
      this.buffers[k] = bufs;
    }
    this._raw = null;
  }

  _jitter() { return 1 + (Math.random() * 2 - 1) * A.pitchJitter; }

  _play(cat, opts) {
    if (!this.ready) return null;
    const bufs = this.buffers[cat];
    if (!bufs || !bufs.length) return null;
    const o = opts || {};
    const buf = bufs[(Math.random() * bufs.length) | 0];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = o.rate == null ? 1 : o.rate;
    const g = this.ctx.createGain();
    g.gain.value = o.gain == null ? 1 : o.gain;
    src.connect(g).connect(o.dest || this.master);
    const t = this.ctx.currentTime;
    if (o.duration != null) src.start(t, o.offset || 0, o.duration);
    else src.start(t, o.offset || 0);
    return { src, g };
  }

  // One persistent looping source per vehicle category, each at gain 0.
  _startLoops() {
    this.loops = {};
    for (const cat of LOOP_CATS) {
      const bufs = this.buffers[cat];
      if (!bufs || !bufs.length) continue;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.master);
      const src = this.ctx.createBufferSource();
      src.buffer = bufs[0];
      src.loop = true;
      src.connect(gain);
      src.start();
      this.loops[cat] = { src, gain };
    }
  }

  // Drive the piloted vehicle's loop category from its profile; ramp every other category to 0.
  // profile: { loop, rateIdle, rateMax, gainIdle, gainMax }. speedNorm 0..1. driving: bool.
  setEngine(profile, speedNorm, driving) {
    if (!this.ready || !this.loops) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1, Math.max(0, speedNorm || 0));
    const active = driving && profile ? profile.loop : null;
    for (const cat of LOOP_CATS) {
      const l = this.loops[cat];
      if (!l) continue;
      if (cat === active) {
        const rate = profile.rateIdle + (profile.rateMax - profile.rateIdle) * s;
        const gain = profile.gainIdle + (profile.gainMax - profile.gainIdle) * s;
        l.src.playbackRate.setTargetAtTime(rate, t, A.engineRateSmooth);
        l.gain.gain.setTargetAtTime(gain, t, A.engineGainSmooth);
      } else {
        l.gain.gain.setTargetAtTime(0, t, A.engineGainSmooth);
      }
    }
  }

  footstepTick(dt, hspeed, sprint) {
    if (!this.ready) return;
    if (hspeed < 0.3) { this.footPhase = 0.5; return; }
    const stepsPerMeter = sprint ? 0.75 : 0.95;
    this.footPhase += hspeed * stepsPerMeter * dt;
    if (this.footPhase >= 1) {
      this.footPhase -= 1;
      this._play("footstep", { gain: (sprint ? 0.5 : 0.35) * 2 * A.footstepGain, rate: this._jitter() });
    }
  }

  // Debris / structure impact; louder with force, capped polyphony.
  impact(force) {
    if (!this.ready) return;
    if (this._impactActive >= A.impactVoices) return;
    const gain = Math.min(0.9, A.impactGainBase + A.impactGainScale * Math.log10(Math.max(10, force)));
    const v = this._play("impact", { gain, rate: this._jitter() });
    if (!v) return;
    this._impactActive++;
    v.src.onended = () => { this._impactActive--; };
  }

  // Melee whoosh.
  swing() { this._play("swing", { gain: A.swingGain, rate: this._jitter() }); }

  // Melee contact: metallic ring if a chunk broke, else a dull thud.
  clang(broke) {
    this._play(broke ? "clang" : "thud", { gain: A.clangGain, rate: this._jitter() });
  }

  // Shotgun blast.
  gunshot() { this._play("gunshot", { gain: A.gunshotGain, rate: A.gunshotRate }); }

  // C4 placement click.
  placeCharge() { this._play("c4place", { gain: A.placeGain, rate: this._jitter() }); }

  // Detonator arm blip.
  armBeep() { this._play("beep", { gain: A.beepGain }); }

  // Explosion boom, attenuated by distance.
  explosion(dist) {
    const atten = Math.max(0.15, Math.min(1, 1 / (1 + dist * 0.15)));
    this._play("explosion", { gain: A.explosionGain * atten, rate: 0.9 + Math.random() * 0.15 });
  }

  // Rocket launch whoosh (short slice of the thruster loop).
  rocketLaunch() {
    this._play("rocket", { gain: A.rocketGain, rate: A.rocketRate, offset: 0, duration: A.rocketSlice });
  }
}
