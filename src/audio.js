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
  // ---- Phase 7 batch A (all CC0 Kenney, see CREDITS.md) ----
  crowbarPry: ["crowbar_pry.ogg"],
  crowbarClang: ["crowbar_clang.ogg"],
  chainsawIdle: ["chainsaw_idle.ogg"],
  chainsawCut: ["chainsaw_cut.ogg"],
  chainsawScreech: ["chainsaw_screech.ogg"],
  fuseHiss: ["fuse_hiss.ogg"],
  bounceClink: ["bounce_clink.ogg"],
  wireBeep: ["wire_beep.ogg"],
  stickyThoomp: ["sticky_thoomp.ogg"],
  stickSplat: ["stick_splat.ogg"],
  clusterPop: ["cluster_pop.ogg"],
  clusterCrump: ["cluster_crump.ogg"],
  // ---- Phase 7 batch B: Grab & Force (all CC0 Kenney, see CREDITS.md) ----
  windWhoomp: ["wind_whoomp.ogg"],
  vacuumLoop: ["vacuum_loop.ogg"],
  vacuumThup: ["vacuum_thup.ogg"],
  magnetAttract: ["magnet_attract.ogg"],
  magnetRepel: ["magnet_repel.ogg"],
  gravityHum: ["gravity_hum.ogg"],
  gravityThrow: ["gravity_throw.ogg"],
  grappleLaunch: ["grapple_launch.ogg"],
  grappleAnchor: ["grapple_anchor.ogg"],
  grappleReel: ["grapple_reel.ogg"],
  grappleSnap: ["grapple_snap.ogg"],
  // ---- Phase 7 batch C: Strikes + heavy/vehicular ordnance (CC0 Kenney reuse, see CREDITS.md) ----
  spraySound: ["spray_loop.ogg"],
  propaneClonk: ["propane_clonk.ogg"],
  nukeArm: ["nuke_arm.ogg"],
  nukeKlaxon: ["nuke_klaxon.ogg"],
  nukeBlast: ["nuke_blast.ogg"],
  nukeRumble: ["nuke_rumble.ogg"],
  orbitalCharge: ["orbital_charge.ogg"],
  orbitalZap: ["orbital_zap.ogg"],
  carWhoosh: ["carcannon_whoosh.ogg"],
  carCrash: ["carcannon_crash.ogg"],
  rcMotor: ["rc_motor.ogg"],
  airPlane: ["airstrike_plane.ogg"],
  airFlyby: ["airstrike_flyby.ogg"],
  bombWhistle: ["bomb_whistle.ogg"],
  // ---- Phase 7 batch D: Builders (CC0 Kenney reuse, see CREDITS.md) ----
  foamSpray: ["foam_spray.ogg"],
  foamSplat: ["foam_splat.ogg"],
  foamHarden: ["foam_harden.ogg"],
  rebuildSettle: ["rebuild_settle.ogg"],
  sizeShrink: ["size_shrink.ogg"],
  sizeGrow: ["size_grow.ogg"],
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

  // ---- Phase 7 batch A ----------------------------------------------------------------------

  // Crowbar contact: metal clang on a break, wood pry/creak otherwise.
  crowbarHit(broke) { this._play(broke ? "crowbarClang" : "crowbarPry", { gain: A.clangGain, rate: this._jitter() }); }

  // Managed chainsaw loops (idle always-on while equipped; cut layered while actively chewing a chunk).
  // Built lazily after decode so the buffers exist. Silences both when equipped=false.
  chainsaw(equipped, cutting) {
    if (!this.ready) return;
    if (!this._saw) this._buildSaw();
    if (!this._saw) return;
    const t = this.ctx.currentTime;
    this._saw.idle.gain.gain.setTargetAtTime(equipped ? 0.32 : 0, t, 0.05);
    this._saw.cut.gain.gain.setTargetAtTime(equipped && cutting ? 0.5 : 0, t, 0.05);
  }
  _buildSaw() {
    const mk = (cat) => {
      const bufs = this.buffers[cat];
      if (!bufs || !bufs.length) return null;
      const gain = this.ctx.createGain(); gain.gain.value = 0; gain.connect(this.master);
      const src = this.ctx.createBufferSource(); src.buffer = bufs[0]; src.loop = true; src.connect(gain); src.start();
      return { gain, src };
    };
    const idle = mk("chainsawIdle"), cut = mk("chainsawCut");
    if (!idle && !cut) { this._saw = null; return; }
    this._saw = { idle: idle || { gain: this.ctx.createGain() }, cut: cut || { gain: this.ctx.createGain() } };
  }
  // Metallic screech when the chainsaw bites concrete/metal (nothing detaches). Rate-limited.
  chainsawScreech() {
    const now = this.ctx ? this.ctx.currentTime : 0;
    if (this._lastScreech && now - this._lastScreech < 0.18) return;
    this._lastScreech = now;
    this._play("chainsawScreech", { gain: 0.4, rate: 0.9 + Math.random() * 0.2 });
  }

  // Shared fuse-hiss loop: on while any pipe bomb / sticky is ticking, off otherwise.
  fuse(active) {
    if (!this.ready) return;
    if (!this._fuse) {
      const bufs = this.buffers.fuseHiss;
      if (!bufs || !bufs.length) return;
      const gain = this.ctx.createGain(); gain.gain.value = 0; gain.connect(this.master);
      const src = this.ctx.createBufferSource(); src.buffer = bufs[0]; src.loop = true; src.connect(gain); src.start();
      this._fuse = { gain, src };
    }
    this._fuse.gain.gain.setTargetAtTime(active ? 0.22 : 0, this.ctx.currentTime, 0.08);
  }

  bounceClink(dist) {
    const atten = Math.max(0.2, Math.min(1, 1 / (1 + dist * 0.15)));
    this._play("bounceClink", { gain: 0.5 * atten, rate: this._jitter() });
  }
  wireBeep() { this._play("wireBeep", { gain: A.beepGain }); }
  stickyThoomp() { this._play("stickyThoomp", { gain: 0.6, rate: 0.95 }); }
  stickSplat(dist) {
    const atten = Math.max(0.2, Math.min(1, 1 / (1 + dist * 0.15)));
    this._play("stickSplat", { gain: 0.6 * atten, rate: this._jitter() });
  }
  clusterPop() { this._play("clusterPop", { gain: 0.55, rate: this._jitter() }); }
  // Small bomblet blast, attenuated by distance (lower-gain than the main explosion).
  clusterCrump(dist) {
    const atten = Math.max(0.15, Math.min(1, 1 / (1 + dist * 0.2)));
    this._play("clusterCrump", { gain: A.explosionGain * 0.6 * atten, rate: 0.95 + Math.random() * 0.15 });
  }

  // ---- Phase 7 batch B: Grab & Force ---------------------------------------------------------
  // Generic managed looping source (one per category, gain 0 until driven), built lazily post-decode.
  // Same pattern as the chainsaw/fuse loops; used by the vacuum motor, magnet hums and grapple reel.
  _getLoop(cat) {
    if (!this._mloops) this._mloops = {};
    if (cat in this._mloops) return this._mloops[cat];
    const bufs = this.buffers[cat];
    if (!this.ready || !bufs || !bufs.length) { this._mloops[cat] = null; return null; }
    const gain = this.ctx.createGain(); gain.gain.value = 0; gain.connect(this.master);
    const src = this.ctx.createBufferSource(); src.buffer = bufs[0]; src.loop = true; src.connect(gain); src.start();
    const l = { gain, src }; this._mloops[cat] = l; return l;
  }
  _setLoop(cat, target, tc = 0.05) {
    if (!this.ready) return;
    const l = this._getLoop(cat);
    if (!l) return;
    l.gain.gain.setTargetAtTime(target, this.ctx.currentTime, tc);
  }

  windWhoomp() { this._play("windWhoomp", { gain: 0.6, rate: 0.9 + Math.random() * 0.15 }); }
  // Debris Vacuum motor loop (on while holding LMB) + rate-limited low-gain consume "thup".
  vacuum(active) { this._setLoop("vacuumLoop", active ? 0.3 : 0); }
  vacuumThup(dist) {
    const now = this.ctx ? this.ctx.currentTime : 0;
    if (this._lastThup && now - this._lastThup < 0.1) return; // rate-limit ~10/s
    this._lastThup = now;
    const atten = Math.max(0.15, Math.min(1, 1 / (1 + dist * 0.15)));
    this._play("vacuumThup", { gain: 0.28 * atten, rate: this._jitter() });
  }
  // Magnet hums: distinct attract vs. repel loop; mode = "attract" | "repel" | null.
  magnet(mode) {
    this._setLoop("magnetAttract", mode === "attract" ? 0.32 : 0);
    this._setLoop("magnetRepel", mode === "repel" ? 0.32 : 0);
  }
  // Gravity Gun grab hum (on while a body is held) + throw whump (a short slice of the thruster file).
  gravityHum(active) { this._setLoop("gravityHum", active ? 0.28 : 0); }
  gravityThrow() { this._play("gravityThrow", { gain: 0.5, rate: 1.1, offset: 0, duration: 0.5 }); }
  // Grapple: launch pop, metallic anchor hit, reel loop (on while reeling), rope snap.
  grappleLaunch() { this._play("grappleLaunch", { gain: 0.5, rate: this._jitter() }); }
  grappleAnchor(dist) {
    const atten = Math.max(0.2, Math.min(1, 1 / (1 + dist * 0.12)));
    this._play("grappleAnchor", { gain: 0.55 * atten, rate: this._jitter() });
  }
  grappleReel(active) { this._setLoop("grappleReel", active ? 0.3 : 0); }
  grappleSnap(dist) {
    const atten = Math.max(0.2, Math.min(1, 1 / (1 + dist * 0.12)));
    this._play("grappleSnap", { gain: 0.6 * atten, rate: this._jitter() });
  }

  // ---- Phase 7 batch C: Strikes + heavy/vehicular ordnance -----------------------------------
  // Blast Painter spray loop (managed, on while holding LMB); RC-car electric motor + circling plane loops.
  blastSpray(active) { this._setLoop("spraySound", active ? 0.28 : 0); }
  rcMotor(active) { this._setLoop("rcMotor", active ? 0.3 : 0); }
  airPlaneLoop(active) { this._setLoop("airPlane", active ? 0.18 : 0); }

  propaneClonk(dist) {
    const atten = Math.max(0.2, Math.min(1, 1 / (1 + dist * 0.15)));
    this._play("propaneClonk", { gain: 0.6 * atten, rate: this._jitter() });
  }
  // Nuke: arm blip, accelerating countdown beep (reuses the confirm beep), massive layered blast + rumble
  // tail, and a klaxon. The blast is the biggest CC0 file we have, layered with a low rumble.
  nukeArm() { this._play("nukeArm", { gain: A.beepGain }); }
  nukeBeep() { this._play("beep", { gain: A.beepGain, rate: 1.1 }); }
  nukeKlaxon() { this._play("nukeKlaxon", { gain: 0.5, rate: 0.8 }); }
  nukeBlast(dist) {
    const atten = Math.max(0.3, Math.min(1, 1 / (1 + dist * 0.05)));
    this._play("nukeBlast", { gain: Math.min(1, A.explosionGain * 1.4) * atten, rate: 0.8 });
    this._play("nukeRumble", { gain: 0.6 * atten, rate: 0.8 });
  }
  // Orbital laser: rising charge, accelerating marker beep (reuses confirm beep), sustained beam zap.
  orbitalCharge() { this._play("orbitalCharge", { gain: A.rocketGain, rate: 1.0, offset: 0, duration: 1.2 }); }
  orbitalBeep() { this._play("beep", { gain: A.beepGain * 0.8, rate: 1.3 }); }
  orbitalZap() { this._play("orbitalZap", { gain: 0.6, rate: 0.8 }); }
  // Car Cannon: launch whoosh + heavy crash (chunk impacts also sound via the existing impact voices).
  carCannonWhoosh() { this._play("carWhoosh", { gain: A.rocketGain, rate: 0.85, offset: 0, duration: 0.6 }); }
  carCannonCrash(dist) {
    const atten = Math.max(0.2, Math.min(1, 1 / (1 + dist * 0.12)));
    this._play("carCrash", { gain: A.explosionGain * atten, rate: 0.85 });
  }
  // Airstrike: attack-run flyby whoosh + falling-bomb whistle (impacts reuse the explosion voices).
  airFlyby() { this._play("airFlyby", { gain: 0.55, rate: 0.9 }); }
  bombWhistle() { this._play("bombWhistle", { gain: 0.5, rate: 0.8 }); }

  // ---- Phase 7 batch D: Builders -------------------------------------------------------------
  // Foam Cannon wet-spray loop (managed source, on while holding LMB) + squelchy splat on each landing
  // (rate-limited by the caller) + a subtle hardening "crack-set" when a blob sets into a volume.
  foamSpray(active) { this._setLoop("foamSpray", active ? 0.26 : 0); }
  foamSplat(dist) {
    const atten = Math.max(0.2, Math.min(1, 1 / (1 + dist * 0.15)));
    this._play("foamSplat", { gain: 0.5 * atten, rate: 0.9 + Math.random() * 0.2 });
  }
  foamHarden(dist) {
    const atten = Math.max(0.2, Math.min(1, 1 / (1 + dist * 0.15)));
    this._play("foamHarden", { gain: 0.45 * atten, rate: this._jitter() });
  }
  // Rebuild Gun: reverse-crumble / stone-settling per restored chunk (rate-limited by the caller).
  rebuildSettle(dist) {
    const atten = Math.max(0.2, Math.min(1, 1 / (1 + dist * 0.15)));
    this._play("rebuildSettle", { gain: 0.45 * atten, rate: 0.85 + Math.random() * 0.2 });
  }
  // Size Ray: two DISTINCT sci-fi zaps (shrink vs. grow) — separate files, never a pitch-shifted single one.
  sizeShrink(dist) {
    const atten = Math.max(0.25, Math.min(1, 1 / (1 + dist * 0.12)));
    this._play("sizeShrink", { gain: 0.55 * atten, rate: this._jitter() });
  }
  sizeGrow(dist) {
    const atten = Math.max(0.25, Math.min(1, 1 / (1 + dist * 0.12)));
    this._play("sizeGrow", { gain: 0.55 * atten, rate: this._jitter() });
  }
}
