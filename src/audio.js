// audio.js - CC0 sound-file playback (fetched AudioBuffers): buses + limiter, material-aware impacts, managed loops. Assets are CC0, see assets/audio/CREDITS.md.
import { CONFIG } from "./config.js";

const A = CONFIG.audio;
const BASE = new URL("../assets/audio/", import.meta.url);

// ---------------------------------------------------------------------------------------------
// Mix constants. These live here on purpose: config.js is shared/owned elsewhere, and everything
// below is pure mixing detail (bus trims, voice caps, attenuation refs) with no gameplay meaning.
// ---------------------------------------------------------------------------------------------
const BUS_GAIN = {
  world: 0.85,   // structure impacts, debris, crumble - the constant bed of a demolition game
  weapon: 0.90,  // guns, explosions, tool one-shots
  tool: 0.70,    // held-tool loops (chainsaw, vacuum, spray, hums)
  vehicle: 0.70, // engine / rotor / prop / hover / boat loops
  player: 0.55,  // footsteps, jump, land, water
  ui: 0.60,      // beeps, clicks, klaxon
  amb: 0.30,     // map ambience beds
};
// Master limiter: catches stacked explosions + debris storms instead of letting them clip.
const LIMITER = { threshold: -8, knee: 6, ratio: 12, attack: 0.003, release: 0.22 };
// Per-category polyphony caps (default DEFAULT_VOICES). Stops a collapsing building eating the mix.
const VOICES = {
  impact: 7, impactWood: 5, impactMetal: 5, impactGlass: 4, debris: 5, crumble: 4,
  explosion: 4, explosionSmall: 5, footstep: 3, land: 2,
};
const DEFAULT_VOICES = 4;
const MAX_TOTAL_VOICES = 26;
// Inverse-distance attenuation reference (metres): gain = ref / (ref + dist), floored per call.
const ATT_NEAR = 7, ATT_MID = 12, ATT_FAR = 26;
const CULL_GAIN = 0.02;      // below this a world sound is skipped entirely (frees a voice)
const LOOP_FADE = 0.07;      // time-constant for managed loop gain ramps (click-free start/stop)
const PAN_SPREAD = 0.45;     // random stereo placement for world one-shots
const IMPACT_TRIM = 0.75;    // the new impact set is hotter than the old Kenney blips
const FOOT_GAIN = 0.42;
const FETCH_CONCURRENCY = 8;

// Category -> file list. Several categories share a file on purpose; the loader de-dupes by name,
// so a shared file is fetched and decoded exactly once.
const FILES = {
  // ---- player -------------------------------------------------------------------------------
  footstep: ["footstep_concrete_0.ogg", "footstep_concrete_1.ogg", "footstep_concrete_2.ogg",
             "footstep_concrete_3.ogg", "footstep_concrete_4.ogg", "footstep_concrete_5.ogg"],
  footstepSand: ["footstep_sand_0.ogg", "footstep_sand_1.ogg", "footstep_sand_2.ogg", "footstep_sand_3.ogg"],
  footstepWood: ["footstep_wood_0.ogg", "footstep_wood_1.ogg", "footstep_wood_2.ogg", "footstep_wood_3.ogg"],
  footstepMetal: ["footstep_metal_0.ogg", "footstep_metal_1.ogg", "footstep_metal_2.ogg", "footstep_metal_3.ogg"],
  jump: ["jump_0.ogg", "jump_1.ogg"],
  land: ["land_0.ogg", "land_1.ogg", "land_2.ogg"],
  splash: ["splash_0.ogg", "splash_1.ogg", "splash_2.ogg"],
  wade: ["wade_loop.ogg"],
  ambWind: ["amb_wind.ogg"],
  ambCity: ["amb_city.ogg"],

  // ---- destruction --------------------------------------------------------------------------
  impact: ["impact_concrete_0.ogg", "impact_concrete_1.ogg", "impact_concrete_2.ogg",
           "impact_concrete_3.ogg", "impact_concrete_4.ogg"],
  impactWood: ["impact_wood_0.ogg", "impact_wood_1.ogg", "impact_wood_2.ogg", "impact_wood_3.ogg", "impact_wood_4.ogg"],
  impactMetal: ["impact_metal_0.ogg", "impact_metal_1.ogg", "impact_metal_2.ogg", "impact_metal_3.ogg", "impact_metal_4.ogg"],
  impactGlass: ["impact_glass_0.ogg", "impact_glass_1.ogg", "impact_glass_2.ogg", "impact_glass_3.ogg"],
  debris: ["debris_0.ogg", "debris_1.ogg", "debris_2.ogg", "debris_3.ogg", "debris_4.ogg"],
  crumble: ["crumble_0.ogg", "crumble_1.ogg", "crumble_2.ogg"],

  // ---- vehicle loops ------------------------------------------------------------------------
  engineCar: ["engine_car_loop.ogg"],
  engineDiesel: ["engine_diesel_loop.ogg"],
  rotor: ["rotor_loop.ogg"],
  plane: ["plane_loop.ogg"],
  hover: ["hover_loop.ogg"],
  boat: ["boat_loop.ogg"],

  // ---- melee / core weapons -----------------------------------------------------------------
  swing: ["swing_0.ogg", "swing_1.ogg", "swing_2.ogg", "swing_3.ogg", "swing_4.ogg"],
  clang: ["clang_0.ogg", "clang_1.ogg", "clang_2.ogg"],
  thud: ["thud_0.ogg", "thud_1.ogg", "thud_2.ogg"],
  gunshot: ["shotgun_0.ogg", "shotgun_1.ogg", "shotgun_2.ogg"],
  c4place: ["c4_place.ogg"],
  beep: ["detonate_beep.ogg"],
  explosion: ["explosion_0.ogg", "explosion_1.ogg", "explosion_2.ogg", "explosion_3.ogg"],
  explosionSmall: ["explosion_small_0.ogg", "explosion_small_1.ogg", "explosion_small_2.ogg"],
  explosionHuge: ["explosion_huge.ogg"],
  explosionRumble: ["explosion_rumble.ogg"],
  rocket: ["rocket_launch.ogg"],

  // ---- phase 7 batch A ----------------------------------------------------------------------
  crowbarPry: ["crowbar_pry_0.ogg", "crowbar_pry_1.ogg", "crowbar_pry_2.ogg"],
  crowbarClang: ["crowbar_clang_0.ogg", "crowbar_clang_1.ogg", "crowbar_clang_2.ogg"],
  chainsawIdle: ["chainsaw_idle.ogg"],
  chainsawCut: ["chainsaw_cut.ogg"],
  chainsawScreech: ["chainsaw_screech_0.ogg", "chainsaw_screech_1.ogg", "chainsaw_screech_2.ogg"],
  fuseHiss: ["fuse_hiss.ogg"],
  bounceClink: ["bounce_clink_0.ogg", "bounce_clink_1.ogg", "bounce_clink_2.ogg"],
  wireBeep: ["wire_beep.ogg"],
  stickyThoomp: ["sticky_thoomp_0.ogg", "sticky_thoomp_1.ogg"],
  stickSplat: ["stick_splat_0.ogg", "stick_splat_1.ogg", "stick_splat_2.ogg"],
  clusterPop: ["cluster_pop_0.ogg", "cluster_pop_1.ogg", "cluster_pop_2.ogg"],

  // ---- phase 7 batch B: grab & force ---------------------------------------------------------
  windWhoomp: ["wind_whoomp_0.ogg", "wind_whoomp_1.ogg", "wind_whoomp_2.ogg"],
  vacuumLoop: ["vacuum_loop.ogg"],
  vacuumThup: ["vacuum_thup_0.ogg", "vacuum_thup_1.ogg", "vacuum_thup_2.ogg"],
  magnetAttract: ["magnet_attract.ogg"],
  magnetRepel: ["magnet_repel.ogg"],
  gravityHum: ["gravity_hum.ogg"],
  gravityThrow: ["gravity_throw.ogg"],
  grappleLaunch: ["grapple_launch.ogg"],
  grappleAnchor: ["grapple_anchor_0.ogg", "grapple_anchor_1.ogg", "grapple_anchor_2.ogg"],
  grappleReel: ["grapple_reel.ogg"],
  grappleSnap: ["grapple_snap_0.ogg", "grapple_snap_1.ogg"],

  // ---- phase 7 batch C: strikes + heavy ordnance ----------------------------------------------
  spraySound: ["spray_loop.ogg"],
  propaneClonk: ["propane_clonk_0.ogg", "propane_clonk_1.ogg"],
  nukeArm: ["nuke_arm.ogg"],
  nukeKlaxon: ["nuke_klaxon.ogg"],
  orbitalCharge: ["orbital_charge.ogg"],
  orbitalZap: ["orbital_zap.ogg"],
  carWhoosh: ["car_whoosh.ogg"],
  carCrash: ["car_crash_0.ogg", "car_crash_1.ogg"],
  rcMotor: ["rc_motor.ogg"],
  airPlane: ["plane_loop.ogg"],          // same prop loop as the flyable plane
  airFlyby: ["airstrike_flyby.ogg"],
  bombWhistle: ["bomb_whistle.ogg"],

  // ---- phase 7 batch D: builders --------------------------------------------------------------
  foamSpray: ["foam_spray.ogg"],
  foamSplat: ["foam_splat_0.ogg", "foam_splat_1.ogg", "foam_splat_2.ogg", "foam_splat_3.ogg"],
  foamHarden: ["foam_harden_0.ogg", "foam_harden_1.ogg"],
  rebuildSettle: ["rebuild_settle_0.ogg", "rebuild_settle_1.ogg", "rebuild_settle_2.ogg"],
  sizeShrink: ["size_shrink.ogg"],
  sizeGrow: ["size_grow.ogg"],
};

// Persistent vehicle loops: one always-on source per entry, gain 0 until its vehicle is piloted.
// `engine` has two timbres; setEngine() picks by the profile's idle rate (heavy trucks idle low).
const LOOP_SLOTS = [
  { key: "engine:car", loop: "engine", cat: "engineCar" },
  { key: "engine:diesel", loop: "engine", cat: "engineDiesel" },
  { key: "rotor", loop: "rotor", cat: "rotor" },
  { key: "plane", loop: "plane", cat: "plane" },
  { key: "hover", loop: "hover", cat: "hover" },
  { key: "boat", loop: "boat", cat: "boat" },
];
const DIESEL_IDLE_MAX = 0.6;   // profile.rateIdle at or below this -> diesel timbre

const SURFACES = { concrete: "footstep", sand: "footstepSand", wood: "footstepWood", metal: "footstepMetal" };

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.footPhase = 0;
    this.buffers = {};
    this._voices = {};
    this._totalVoices = 0;
    this._throttles = {};
    this._surface = "concrete";
    this._raw = null;
    // Prefetch raw bytes at page load (bounded concurrency) so decode after the first gesture is
    // instant and the audio never competes with model/texture loads for sockets.
    this._files = {};
    const names = [];
    for (const list of Object.values(FILES)) for (const f of list) if (names.indexOf(f) < 0) names.push(f);
    this._prefetch = this._fetchAll(names);
  }

  async _fetchAll(names) {
    let i = 0;
    const worker = async () => {
      while (i < names.length) {
        const f = names[i++];
        try {
          const r = await fetch(new URL(f, BASE));
          this._files[f] = r.ok ? await r.arrayBuffer() : null;
        } catch (e) { this._files[f] = null; }
      }
    };
    const pool = [];
    for (let k = 0; k < FETCH_CONCURRENCY; k++) pool.push(worker());
    await Promise.all(pool);
  }

  async resume() {
    if (this.ready) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
    if (this._resuming) { if (this.ctx && this.ctx.state === "suspended") this.ctx.resume(); return; }
    this._resuming = true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      // master -> limiter -> destination; every bus feeds master.
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = LIMITER.threshold;
      this.limiter.knee.value = LIMITER.knee;
      this.limiter.ratio.value = LIMITER.ratio;
      this.limiter.attack.value = LIMITER.attack;
      this.limiter.release.value = LIMITER.release;
      this.limiter.connect(this.ctx.destination);
      this.master = this.ctx.createGain();
      this.master.gain.value = A.masterGain;
      this.master.connect(this.limiter);
      this.bus = {};
      for (const [name, g] of Object.entries(BUS_GAIN)) {
        const node = this.ctx.createGain();
        node.gain.value = g;
        node.connect(this.master);
        this.bus[name] = node;
      }
      await this._decodeAll();
      this._startLoops();
      this.ready = true;
    } catch (e) {
      this.ready = false;
    }
  }

  async _decodeAll() {
    await this._prefetch;
    const decoded = {};
    for (const [name, bytes] of Object.entries(this._files)) {
      if (!bytes) continue;
      try { decoded[name] = await this.ctx.decodeAudioData(bytes.slice(0)); } catch (e) {}
    }
    for (const [cat, list] of Object.entries(FILES)) {
      const bufs = [];
      for (const f of list) if (decoded[f]) bufs.push(decoded[f]);
      this.buffers[cat] = bufs;
    }
    this._files = {};
  }

  // ---- helpers ---------------------------------------------------------------------------------

  _jitter() { return 1 + (Math.random() * 2 - 1) * A.pitchJitter; }

  // Inverse-distance falloff with a floor, so distant events stay audible but never dominate.
  _atten(dist, ref, floor) {
    const d = dist == null ? 0 : dist;
    const g = ref / (ref + Math.max(0, d));
    return Math.max(floor == null ? 0.12 : floor, Math.min(1, g));
  }

  // Rate-limit a repeating sound. Returns true when the caller should stay silent.
  _throttled(key, minGap) {
    const now = this.ctx ? this.ctx.currentTime : 0;
    const last = this._throttles[key];
    if (last != null && now - last < minGap) return true;
    this._throttles[key] = now;
    return false;
  }

  _spread() { return (Math.random() * 2 - 1) * PAN_SPREAD; }

  _play(cat, opts) {
    if (!this.ready) return null;
    const bufs = this.buffers[cat];
    if (!bufs || !bufs.length) return null;
    const o = opts || {};
    const gain = o.gain == null ? 1 : o.gain;
    if (gain < CULL_GAIN) return null;
    const cap = VOICES[cat] == null ? DEFAULT_VOICES : VOICES[cat];
    const used = this._voices[cat] || 0;
    if (used >= cap || this._totalVoices >= MAX_TOTAL_VOICES) return null;

    const src = this.ctx.createBufferSource();
    src.buffer = bufs[(Math.random() * bufs.length) | 0];
    const rate = o.rate == null ? 1 : o.rate;
    src.playbackRate.value = rate;
    const t = this.ctx.currentTime;
    if (o.rateEnd != null) src.playbackRate.linearRampToValueAtTime(o.rateEnd, t + (o.rateTime || 1.5));

    const g = this.ctx.createGain();
    g.gain.value = gain;
    let node = g;
    if (o.pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      g.connect(p);
      node = p;
    }
    node.connect(o.dest || this.bus[o.bus || "world"] || this.master);
    src.connect(g);
    if (o.duration != null) src.start(t, o.offset || 0, o.duration);
    else src.start(t, o.offset || 0);

    this._voices[cat] = used + 1;
    this._totalVoices++;
    src.onended = () => {
      this._voices[cat] = Math.max(0, (this._voices[cat] || 1) - 1);
      this._totalVoices = Math.max(0, this._totalVoices - 1);
      try { g.disconnect(); if (node !== g) node.disconnect(); } catch (e) {}
    };
    return { src, g };
  }

  // Generic managed looping source: one per category, gain 0 until driven. Built lazily post-decode.
  _getLoop(cat, busName) {
    if (!this._mloops) this._mloops = {};
    if (cat in this._mloops) return this._mloops[cat];
    const bufs = this.buffers[cat];
    if (!this.ready || !bufs || !bufs.length) { this._mloops[cat] = null; return null; }
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.bus[busName || "tool"] || this.master);
    const src = this.ctx.createBufferSource();
    src.buffer = bufs[0];
    src.loop = true;
    src.connect(gain);
    src.start();
    const l = { gain, src };
    this._mloops[cat] = l;
    return l;
  }
  _setLoop(cat, target, tc, busName) {
    if (!this.ready) return;
    const l = this._getLoop(cat, busName);
    if (!l) return;
    l.gain.gain.setTargetAtTime(target, this.ctx.currentTime, tc == null ? LOOP_FADE : tc);
  }

  // One persistent source per vehicle loop slot, each at gain 0.
  _startLoops() {
    this.loops = {};
    for (const slot of LOOP_SLOTS) {
      const bufs = this.buffers[slot.cat];
      if (!bufs || !bufs.length) continue;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.bus.vehicle || this.master);
      const src = this.ctx.createBufferSource();
      src.buffer = bufs[0];
      src.loop = true;
      src.connect(gain);
      src.start();
      this.loops[slot.key] = { src, gain };
    }
  }

  // ---- public: mix control ----------------------------------------------------------------------

  // 0..1 master trim on top of CONFIG.audio.masterGain (for a future options slider / mute key).
  setMasterVolume(v) {
    if (!this.ready) return;
    const g = Math.max(0, Math.min(1, v)) * A.masterGain;
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.05);
  }

  // ---- public: vehicles ---------------------------------------------------------------------------

  // Drive the piloted vehicle's loop slot from its profile; ramp every other slot to 0.
  // profile: { loop, rateIdle, rateMax, gainIdle, gainMax }. speedNorm 0..1. driving: bool.
  setEngine(profile, speedNorm, driving) {
    if (!this.ready || !this.loops) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1, Math.max(0, speedNorm || 0));
    let active = null;
    if (driving && profile) {
      active = profile.loop === "engine"
        ? (profile.rateIdle <= DIESEL_IDLE_MAX ? "engine:diesel" : "engine:car")
        : profile.loop;
    }
    for (const slot of LOOP_SLOTS) {
      const l = this.loops[slot.key];
      if (!l) continue;
      if (slot.key === active) {
        const rate = profile.rateIdle + (profile.rateMax - profile.rateIdle) * s;
        const gain = profile.gainIdle + (profile.gainMax - profile.gainIdle) * s;
        l.src.playbackRate.setTargetAtTime(rate, t, A.engineRateSmooth);
        l.gain.gain.setTargetAtTime(gain, t, A.engineGainSmooth);
      } else {
        l.gain.gain.setTargetAtTime(0, t, A.engineGainSmooth);
      }
    }
  }

  // ---- public: player -----------------------------------------------------------------------------

  // Optional: "concrete" | "sand" | "wood" | "metal". Unknown names fall back to concrete.
  setFootstepSurface(name) { this._surface = SURFACES[name] ? name : "concrete"; }

  footstepTick(dt, hspeed, sprint, surface) {
    if (!this.ready) return;
    if (hspeed < 0.3) { this.footPhase = 0.5; return; }
    const stepsPerMeter = sprint ? 0.75 : 0.95;
    this.footPhase += hspeed * stepsPerMeter * dt;
    if (this.footPhase >= 1) {
      this.footPhase -= 1;
      const cat = SURFACES[surface || this._surface] || "footstep";
      this._play(cat, {
        gain: (sprint ? 1.25 : 1) * FOOT_GAIN * A.footstepGain,
        rate: this._jitter(), bus: "player", pan: this._spread() * 0.4,
      });
    }
  }

  jump() { this._play("jump", { gain: 0.35, rate: this._jitter(), bus: "player" }); }

  // force: impact speed in m/s (or any positive scalar) - louder the harder you hit the ground.
  land(force) {
    const f = Math.max(0, force == null ? 6 : force);
    this._play("land", { gain: Math.min(0.7, 0.18 + f * 0.035), rate: this._jitter(), bus: "player" });
  }

  // Entering / leaving water.
  splash(dist) {
    this._play("splash", { gain: 0.55 * this._atten(dist, ATT_MID), rate: this._jitter(), bus: "player", pan: this._spread() });
  }
  // Continuous wading loop while the player's feet are under the surface.
  wade(active) { this._setLoop("wade", active ? 0.30 : 0, LOOP_FADE, "player"); }

  // Map ambience bed: "city" | "town" | "wind" | "desert" | null to silence it.
  ambience(name) {
    const city = name === "city" || name === "town" || name === "plaza";
    const wind = name === "wind" || name === "desert" || name === "island" || name === "outdoor";
    this._setLoop("ambCity", city ? 0.5 : 0, 0.8, "amb");
    this._setLoop("ambWind", wind ? 0.5 : 0, 0.8, "amb");
  }

  // ---- public: destruction --------------------------------------------------------------------------

  // Debris / structure impact. force scales loudness; optional material picks the timbre:
  // "concrete" (default) | "wood" | "metal" | "glass".
  impact(force, material) {
    if (!this.ready) return;
    const cat = material === "wood" ? "impactWood"
      : material === "metal" ? "impactMetal"
      : material === "glass" ? "impactGlass" : "impact";
    const gain = Math.min(0.9, A.impactGainBase + A.impactGainScale * Math.log10(Math.max(10, force))) * IMPACT_TRIM;
    this._play(cat, { gain, rate: this._jitter(), pan: this._spread() });
  }

  // Loose rubble scattering / sliding after a collapse.
  debris(dist) {
    this._play("debris", { gain: 0.5 * this._atten(dist, ATT_MID), rate: this._jitter(), pan: this._spread() });
  }

  // Structural crumble (a chunk of concrete letting go). Rate-limited: it is a long, dense sound.
  crumble(dist) {
    if (this._throttled("crumble", 0.12)) return;
    this._play("crumble", { gain: 0.55 * this._atten(dist, ATT_MID), rate: this._jitter(), pan: this._spread() });
  }

  // ---- public: melee / core weapons -------------------------------------------------------------------

  swing() { this._play("swing", { gain: A.swingGain * 0.7, rate: this._jitter(), bus: "weapon" }); }

  // Melee contact: metallic ring if a chunk broke, else a dull thud.
  clang(broke) {
    this._play(broke ? "clang" : "thud", { gain: A.clangGain * 0.8, rate: this._jitter(), bus: "weapon" });
  }

  // 12-gauge blast.
  gunshot() { this._play("gunshot", { gain: A.gunshotGain, rate: A.gunshotRate * this._jitter(), bus: "weapon" }); }

  placeCharge() { this._play("c4place", { gain: A.placeGain, rate: this._jitter(), bus: "ui" }); }
  armBeep() { this._play("beep", { gain: A.beepGain, bus: "ui" }); }

  // Explosion boom, attenuated by distance. size: "small" | "medium" (default) | "huge".
  explosion(dist, size) {
    const atten = this._atten(dist, size === "huge" ? ATT_FAR : ATT_MID, 0.15);
    if (size === "small") { this.clusterCrump(dist); return; }
    if (size === "huge") { this.nukeBlast(dist); return; }
    this._play("explosion", { gain: A.explosionGain * atten, rate: 0.92 + Math.random() * 0.14, bus: "weapon", pan: this._spread() * 0.5 });
    // A short low tail under closer blasts gives the voxel debris something to fall through.
    if (atten > 0.65) this._play("explosionRumble", { gain: A.explosionGain * 0.28 * atten, rate: 1.0, bus: "weapon" });
  }

  rocketLaunch() {
    this._play("rocket", { gain: A.rocketGain, rate: A.rocketRate, offset: 0, duration: A.rocketSlice + 0.6, bus: "weapon" });
  }

  // ---- phase 7 batch A ----------------------------------------------------------------------------------

  crowbarHit(broke) { this._play(broke ? "crowbarClang" : "crowbarPry", { gain: A.clangGain * 0.8, rate: this._jitter(), bus: "weapon" }); }

  // Chainsaw: motor idle always-on while equipped, saw-in-material layer while actively cutting.
  chainsaw(equipped, cutting) {
    if (!this.ready) return;
    this._setLoop("chainsawIdle", equipped ? 0.30 : 0, 0.05);
    this._setLoop("chainsawCut", equipped && cutting ? 0.42 : 0, 0.04);
  }
  // Metallic screech when the bar bites concrete/metal and nothing detaches. Rate-limited.
  chainsawScreech() {
    if (this._throttled("screech", 0.18)) return;
    this._play("chainsawScreech", { gain: 0.32, rate: 0.9 + Math.random() * 0.2, bus: "weapon" });
  }

  // Shared fuse-hiss loop: on while any pipe bomb / sticky is ticking.
  fuse(active) { this._setLoop("fuseHiss", active ? 0.20 : 0, 0.08); }

  bounceClink(dist) {
    this._play("bounceClink", { gain: 0.45 * this._atten(dist, ATT_NEAR), rate: this._jitter(), bus: "weapon", pan: this._spread() });
  }
  wireBeep() { this._play("wireBeep", { gain: A.beepGain, bus: "ui" }); }
  stickyThoomp() { this._play("stickyThoomp", { gain: 0.5, rate: 0.95, bus: "weapon" }); }
  stickSplat(dist) {
    this._play("stickSplat", { gain: 0.5 * this._atten(dist, ATT_NEAR), rate: this._jitter(), bus: "weapon", pan: this._spread() });
  }
  clusterPop() { this._play("clusterPop", { gain: 0.45, rate: this._jitter(), bus: "weapon" }); }
  // Small bomblet blast.
  clusterCrump(dist) {
    const atten = this._atten(dist, ATT_NEAR, 0.15);
    this._play("explosionSmall", { gain: A.explosionGain * 0.65 * atten, rate: 0.95 + Math.random() * 0.15, bus: "weapon", pan: this._spread() * 0.6 });
  }

  // ---- phase 7 batch B: grab & force -----------------------------------------------------------------

  windWhoomp() { this._play("windWhoomp", { gain: 0.5, rate: 0.9 + Math.random() * 0.15, bus: "weapon" }); }
  vacuum(active) { this._setLoop("vacuumLoop", active ? 0.26 : 0); }
  vacuumThup(dist) {
    if (this._throttled("thup", 0.1)) return;
    this._play("vacuumThup", { gain: 0.24 * this._atten(dist, ATT_NEAR), rate: this._jitter(), bus: "weapon" });
  }
  // mode = "attract" | "repel" | null.
  magnet(mode) {
    this._setLoop("magnetAttract", mode === "attract" ? 0.26 : 0);
    this._setLoop("magnetRepel", mode === "repel" ? 0.26 : 0);
  }
  gravityHum(active) { this._setLoop("gravityHum", active ? 0.24 : 0); }
  gravityThrow() { this._play("gravityThrow", { gain: 0.45, rate: 1.1, bus: "weapon" }); }
  grappleLaunch() { this._play("grappleLaunch", { gain: 0.45, rate: this._jitter(), bus: "weapon" }); }
  grappleAnchor(dist) {
    this._play("grappleAnchor", { gain: 0.5 * this._atten(dist, ATT_NEAR), rate: this._jitter(), bus: "weapon", pan: this._spread() });
  }
  grappleReel(active) { this._setLoop("grappleReel", active ? 0.26 : 0); }
  grappleSnap(dist) {
    this._play("grappleSnap", { gain: 0.55 * this._atten(dist, ATT_NEAR), rate: this._jitter(), bus: "weapon" });
  }

  // ---- phase 7 batch C: strikes + heavy / vehicular ordnance --------------------------------------------

  blastSpray(active) { this._setLoop("spraySound", active ? 0.24 : 0); }
  rcMotor(active) { this._setLoop("rcMotor", active ? 0.26 : 0, LOOP_FADE, "vehicle"); }
  airPlaneLoop(active) { this._setLoop("airPlane", active ? 0.16 : 0, 0.25, "vehicle"); }

  propaneClonk(dist) {
    this._play("propaneClonk", { gain: 0.5 * this._atten(dist, ATT_NEAR), rate: this._jitter(), bus: "weapon" });
  }
  nukeArm() { this._play("nukeArm", { gain: A.beepGain, bus: "ui" }); }
  nukeBeep() { this._play("beep", { gain: A.beepGain, rate: 1.1, bus: "ui" }); }
  nukeKlaxon() { this._play("nukeKlaxon", { gain: 0.45, rate: 0.9, bus: "ui" }); }
  // The full-size blast: near-field crack layered with the long distant rumble tail.
  nukeBlast(dist) {
    const atten = this._atten(dist, ATT_FAR, 0.3);
    this._play("explosionHuge", { gain: Math.min(1, A.explosionGain * 1.15) * atten, rate: 0.85, bus: "weapon" });
    this._play("explosionRumble", { gain: 0.7 * atten, rate: 0.8, bus: "weapon" });
  }
  orbitalCharge() { this._play("orbitalCharge", { gain: A.rocketGain, rate: 0.9, bus: "weapon" }); }
  orbitalBeep() { this._play("beep", { gain: A.beepGain * 0.8, rate: 1.3, bus: "ui" }); }
  orbitalZap() { this._play("orbitalZap", { gain: 0.5, rate: 0.85, bus: "weapon" }); }
  carCannonWhoosh() { this._play("carWhoosh", { gain: A.rocketGain, rate: 0.9, bus: "weapon" }); }
  carCannonCrash(dist) {
    this._play("carCrash", { gain: A.explosionGain * 0.85 * this._atten(dist, ATT_MID), rate: 0.9, bus: "weapon", pan: this._spread() * 0.5 });
  }
  // Attack-run flyby: the air rush pitches down as it passes (real recording, rate-automated).
  airFlyby() { this._play("airFlyby", { gain: 0.5, rate: 1.1, rateEnd: 0.85, rateTime: 2.4, bus: "weapon" }); }
  // Falling bomb: real air-rush recording glided downward while it drops.
  bombWhistle() { this._play("bombWhistle", { gain: 0.45, rate: 1.35, rateEnd: 0.7, rateTime: 2.2, bus: "weapon" }); }

  // ---- phase 7 batch D: builders -----------------------------------------------------------------------

  foamSpray(active) { this._setLoop("foamSpray", active ? 0.24 : 0); }
  foamSplat(dist) {
    this._play("foamSplat", { gain: 0.42 * this._atten(dist, ATT_NEAR), rate: 0.9 + Math.random() * 0.2, bus: "weapon" });
  }
  foamHarden(dist) {
    this._play("foamHarden", { gain: 0.38 * this._atten(dist, ATT_NEAR), rate: this._jitter(), bus: "weapon" });
  }
  rebuildSettle(dist) {
    this._play("rebuildSettle", { gain: 0.4 * this._atten(dist, ATT_NEAR), rate: 0.85 + Math.random() * 0.2, bus: "weapon" });
  }
  sizeShrink(dist) {
    this._play("sizeShrink", { gain: 0.5 * this._atten(dist, ATT_NEAR), rate: this._jitter(), bus: "weapon" });
  }
  sizeGrow(dist) {
    this._play("sizeGrow", { gain: 0.5 * this._atten(dist, ATT_NEAR), rate: this._jitter(), bus: "weapon" });
  }
}
