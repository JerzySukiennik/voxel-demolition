// session.js - one authoritative headless game: map, player capsules, vehicles, destruction, charges, intents
import * as THREE from "three";
import { CONFIG } from "../src/config.js";
import { getMap } from "../src/maps/index.js";
import { makeMaterials, scaleModel } from "../src/voxel.js";
import { createCore, createWater, buildStaticGeo, resolveEnv } from "../src/world.js";
import { Destruction, foamVolumeSpec } from "../src/destruction.js";
import { VehicleManager } from "../src/vehicles/manager.js";
import { VEHICLE_SPECS, resolveTuning } from "../src/vehicles/registry.js";
import { sanitizeAvatar } from "../src/avatar.js";
import { mulberry32 } from "../src/sim/rng.js";
// gravityHoldStep was written in weapons.js explicitly so the server could take it over verbatim: it reads
// nothing but its arguments (no `this`, no scene, no DOM), so the spring that holds a grabbed body is the
// SAME code on the host and in the solo game. weapons.js itself is import-safe under Node — every DOM touch
// it has lives inside the Weapons constructor, which the server never runs.
import { gravityHoldStep, RCCAR_MODEL_SCALE } from "../src/weapons.js";
import { NetInput } from "./net-input.js";
import { C2S, S2C, CAPS, ACT_KINDS, NET_TUNING, packP, packQ, unpackBits, bitAt, countBits } from "../src/net/protocol.js";

const P = CONFIG.player;
const WPN = CONFIG.weapons;
const CAP_CENTER = P.halfHeight + P.radius;
const ACT_SET = new Set(ACT_KINDS);
// Local tuning, server-side only (the vehicle rope's server half; CONFIG.weapons owns everything else it
// uses). Ceiling on the per-step velocity change the rope may give the chunk it is dragging. See
// _actVehicleRope for the measurement that produced it.
const VROPE_MAX_DV = 1.2; // m/s per physics step
// The RC Car Bomb drives a real GroundVehicle with its own tuning but is not part of the pickable roster,
// so it has no entry in VEHICLE_SPECS. Register the derived spec once, here and (identically) in weapons.js,
// instead of editing the registry: both peers need `rccar` to resolve for spawnNetworked to build the car.
// The model is scaled to the rccar chassis for a physics reason, not a cosmetic one — see the comment on
// RCCAR_MODEL_SCALE in weapons.js. Both sides must use the SAME scale or they derive their suspension
// hardpoints from different geometry and the car drives differently on each peer.
if (!VEHICLE_SPECS.rccar) {
  VEHICLE_SPECS.rccar = {
    ...VEHICLE_SPECS.hatchback, id: "rccar", name: "RC Car", tuning: "rccar",
    model: scaleModel(VEHICLE_SPECS.hatchback.model, RCCAR_MODEL_SCALE),
  };
}

// Collision groups (Rapier u32 = (membership<<16)|filter). Player capsules collide with static/chunks/
// debris but NEVER with other capsules or vehicles (brief §3 decision 3/4). Vehicles collide with all.
const G_PLAYER = 0x0001, G_VEHICLE = 0x0002, G_ALL = 0xffff;
const CAPSULE_GROUPS = (G_PLAYER << 16) | (G_ALL & ~(G_PLAYER | G_VEHICLE));
const VEHICLE_GROUPS = (G_VEHICLE << 16) | G_ALL;

export class Session {
  constructor(RAPIER, log = console) {
    this.RAPIER = RAPIER;
    this.log = log;
    this.built = false;
    this._building = false;    // a cold build is running on a deferred tick; further hellos queue behind it
    this._buildWaiters = [];
    this.mapId = null;
    this.map = null;
    this.players = new Map(); // pid -> player record
    this.vehicles = new Map(); // vid -> { v, vid, id, ownerPid, driverPid, netInput }
    this._usedPids = new Set();
    this._nextVid = 1;
    this._nextCid4 = 1;
    this.charges = new Map(); // cid4 -> { cid4, owner, p, q, vid }
    this._neutral = new NetInput();
    this._detachOut = [];
    this._debrisRmOut = [];
    this._settleT = 0;         // seconds of post-reset contact-detach suppression still owed
    this._buried = new Map();  // colliderHandle -> heavy flag, for impactors currently inside a chunk
    this._auditT = 0;          // countdown to the next buried-impactor audit
    // Foam Cannon: every blob this session has ever authored, in VOLUME-INDEX ORDER. Evicted blobs stay in
    // the list as `rm` markers because volume identity is the array index — a late joiner has to reserve the
    // same slots or every subsequent detach would land on the wrong volume.
    this.foamRecs = [];        // [{ volIdx, o, d, bits, rm, vol }]
    this.baseVolumeCount = 0;  // volumes that come from the map itself (everything after them is foam)
    // Phase 8 server-owned entities.
    this.props = new Map();    // propId -> { id, owner, body, collider, rec, scale, prevVel, age, dead }
    this._nextPropId = 1;
    this.airRuns = [];         // scripted airstrike passes in flight (server-owned; clients only animate)
    this.airDrops = [];        // ordnance falling out of those passes (ray-stepped in the server world)
    this._clusters = [];       // seeded bomblet swarms from air-dropped cluster ammo
    this._propRmOut = [];      // prop removals to flush at the end of the step
    this._capsuleHandles = new Set(); // player capsule colliders — falling ordnance rays skip these
    // Bound so it can be handed to Rapier's castRay as a plain predicate without losing `this`.
    this._notCapsule = (collider) => !this._capsuleHandles.has(collider.handle);
  }

  // ---- Lifecycle ----------------------------------------------------------------------------

  // Build the whole authoritative sim for `wantMap` (first player into an empty session).
  build(wantMap) {
    const RAPIER = this.RAPIER;
    this.mapId = getMap(wantMap).id; // resolve/validate; falls back to default
    this.map = getMap(this.mapId);
    const map = this.map;

    this.scene = new THREE.Scene(); // never rendered; headless meshing constructs fine
    this.materials = makeMaterials();
    this.world = new RAPIER.World(CONFIG.gravity);
    this.eventQueue = new RAPIER.EventQueue(true);

    const env = resolveEnv(map.env);
    createCore(this.scene, this.world, RAPIER, this.materials, map.size, env.groundColor, map.water ? map.water.rect : null);

    this.destruction = new Destruction(this.world, RAPIER, {
      mode: "authoritative",
      gfx: null,
      mapId: this.mapId,
      onDetach: (events) => { for (const e of events) this._detachOut.push(e); },
      onDebrisRemove: (items) => { for (const it of items) this._debrisRmOut.push(it); },
    });
    for (const spec of map.volumes) this.destruction.addVolume(spec);
    this.baseVolumeCount = this.destruction.volumes.length;
    this.foamRecs.length = 0;
    this.chunkCounts = this.destruction.volumes.map((v) => v.chunks.length);

    buildStaticGeo(this.scene, this.world, RAPIER, this.materials, map.staticGeo);

    this.manager = new VehicleManager(this.scene, this.world, RAPIER, this.materials, this.destruction);

    this.water = null;
    if (map.water) {
      this.water = createWater(this.scene, map.water);
      this.manager.setWater(this.water);
    }

    // Permanent shared hatchback = vid 0.
    const hb = map.hatchback;
    const hbV = this.manager.spawnPermanent("hatchback", { x: hb.x, y: 0, z: hb.z, yaw: hb.yaw || 0 });
    this._applyVehicleGroups(hbV);
    this.vehicles.set(0, { v: hbV, vid: 0, id: "hatchback", ownerPid: 0, driverPid: null, netInput: new NetInput() });

    this.built = true;
    this._reportLoad();
  }

  teardown() {
    if (!this.built) return;
    try { this.world.free(); } catch (e) {}
    this.world = null;
    this.eventQueue = null;
    this.scene = null;
    this.destruction = null;
    this.manager = null;
    this.vehicles.clear();
    this.charges.clear();
    this.built = false;
    this.mapId = null;
    this.map = null;
    this._nextVid = 1;
    this._nextCid4 = 1;
    this._detachOut.length = 0;
    this._debrisRmOut.length = 0;
    this._settleT = 0;
    this._buried.clear();
    this._auditT = 0;
    this.foamRecs.length = 0;
    this.baseVolumeCount = 0;
    this.props.clear();
    this._nextPropId = 1;
    this.airRuns.length = 0;
    this.airDrops.length = 0;
    this._propRmOut.length = 0;
    this.log.log("[session] empty — full teardown; next player rebuilds a fresh sim");
  }

  isActive() { return this.built && this.players.size > 0; }
  playerCount() { return this.players.size; }
  describe() { return { t: S2C.SESSION, active: this.isActive() ? 1 : 0, mapId: this.mapId, count: this.players.size }; }

  _allocPid() {
    for (let i = 1; i <= CAPS.maxPlayers; i++) if (!this._usedPids.has(i)) return i;
    return null;
  }

  // ---- Message dispatch ---------------------------------------------------------------------

  handle(conn, msg) {
    if (!msg || typeof msg.t !== "string") return;
    switch (msg.t) {
      case C2S.HELLO: return this._onHello(conn, msg);
      default:
        if (conn.pid == null) return; // ignore game messages before hello
        return this._onGame(conn, msg);
    }
  }

  _onHello(conn, msg) {
    if (conn.pid != null) return; // already joined
    if (this.players.size >= CAPS.maxPlayers) {
      conn.send({ t: S2C.FULL, reason: "Session full (4 players)" });
      return;
    }
    // Ack BEFORE the build, and yield the event loop so the ack actually reaches the wire. build() is
    // seconds of synchronous work on a cold session; conn.send() only queues the frame, so sending it and
    // building in the same tick leaves the ack sitting in a buffer until the build is over — which is
    // exactly the situation it exists to report. See S2C.HOLD in protocol.js.
    if (!this.built) {
      conn.send({ t: S2C.HOLD, mapId: (msg && msg.wantMap) || this.mapId, building: true });
      if (this._building) { this._buildWaiters.push(() => this._completeJoin(conn, msg)); return; }
      this._building = true;
      this._buildWaiters = [];
      setImmediate(() => {
        try { this.build(msg && msg.wantMap); } finally { this._building = false; }
        this._completeJoin(conn, msg);
        const waiters = this._buildWaiters; this._buildWaiters = [];
        for (const w of waiters) w();
      });
      return;
    }
    this._completeJoin(conn, msg);
  }

  // The part of a join that needs a built map. Split out of _onHello so a cold build can happen on a
  // later tick without holding up the HOLD ack.
  _completeJoin(conn, msg) {
    if (conn.pid != null) return;                       // joined via another path meanwhile
    if (conn.open === false) return;                     // gave up and closed while we were building
    if (this.players.size >= CAPS.maxPlayers) {
      conn.send({ t: S2C.FULL, reason: "Session full (4 players)" });
      return;
    }
    const pid = this._allocPid();
    if (pid == null) { conn.send({ t: S2C.FULL, reason: "Session full (4 players)" }); return; }
    this._usedPids.add(pid);
    conn.pid = pid;

    const nick = sanitizeNick(msg.nick);
    const avatar = sanitizeAvatar(msg.avatar);
    const player = {
      pid, conn, nick, avatar,
      body: this._makeCapsule(this.map.spawn),
      targetP: null, seatVid: null, spawnedVid: null,
      lastState: { p: [this.map.spawn.x, CAP_CENTER, this.map.spawn.z], yaw: this.map.spawn.yaw || 0, pitch: 0, v: [0, 0, 0], tool: null, seat: null },
      // Rate-limit clocks. Carve/foam/zap/rebuild each get their own: they belong to different tools that
      // legitimately overlap in time (an Orbital counts down while you keep shooting), so sharing one
      // timestamp would let any stream of point damage swallow a strike.
      lastDmg: -1e9, lastCarve: -1e9, lastFoam: -1e9, lastZap: -1e9, lastRebuild: -1e9,
      // Phase 8. `act` is the live Grab & Force intent off the 20 Hz state upload and `actT` its arrival
      // time — an act older than CAPS.actStaleSec is dropped, so a client that stops talking cannot leave
      // a magnet running. `grav` is the body this player's Gravity Gun currently holds (server-acquired,
      // server-released). `painted` is the Blast Painter's set: it lives HERE, not on the client, which is
      // the whole point — the delayed blast then hits the same chunks on every peer.
      act: null, actT: -1e9, grav: null, gravReleaseT: 0, vrope: null,
      painted: new Set(), propCount: 0, rcVid: null, airRunning: false,
      lastForce: -1e9, lastAir: -1e9, lastPaint: -1e9, lastPaintDet: -1e9,
      lastProp: -1e9, lastRc: -1e9, lastProj: -1e9,
    };
    this.players.set(pid, player);

    conn.send({
      t: S2C.WELCOME, pid, mapId: this.mapId,
      snap: this._snapshot(),
      players: [...this.players.values()].filter((p) => p.pid !== pid).map((p) => ({ pid: p.pid, nick: p.nick, avatar: p.avatar })),
    });
    this._broadcast({ t: S2C.JOIN, pid, nick, avatar }, pid);
    this.log.log(`[session] player ${pid} "${nick}" joined (${this.players.size}/${CAPS.maxPlayers}) on ${this.mapId}`);
  }

  _onGame(conn, msg) {
    const player = this.players.get(conn.pid);
    if (!player) return;
    switch (msg.t) {
      case C2S.MAP_CHECK: return this._onMapCheck(player, msg);
      case C2S.STATE: return this._onState(player, msg);
      case C2S.INPUT: return this._onInput(player, msg);
      case C2S.ENTER_VEH: return this._onEnterVeh(player, msg);
      case C2S.EXIT_VEH: return this._onExitVeh(player, msg);
      case C2S.SPAWN_VEH: return this._onSpawnVeh(player, msg);
      case C2S.DMG: return this._onDmg(player, msg);
      case C2S.C4_PLACE: return this._onC4Place(player, msg);
      case C2S.C4_DET: return this._onC4Det(player, msg);
      case C2S.ROCKET: return this._onRocket(player, msg);
      case C2S.ROCKET_END: return this._onRocketEnd(player, msg);
      case C2S.FX: return this._onFx(player, msg);
      case C2S.RESET: return this._onReset(player, msg);
      case C2S.FOAM: return this._onFoam(player, msg);
      case C2S.ZAP: return this._onZap(player, msg);
      case C2S.REBUILD: return this._onRebuild(player, msg);
      case C2S.FORCE: return this._onForce(player, msg);
      case C2S.AIR: return this._onAir(player, msg);
      case C2S.PAINT: return this._onPaint(player, msg);
      case C2S.PAINT_DET: return this._onPaintDet(player, msg);
      case C2S.PROP: return this._onProp(player, msg);
      case C2S.RC: return this._onRc(player, msg);
      case C2S.PROJ: return this._onProj(player, msg);
      case C2S.PROJ_END: return this._onProjEnd(player, msg);
    }
  }

  // Determinism guard for the MAP build. Foam volumes sit past baseVolumeCount and are exempt from the
  // per-volume count test: their geometry is transmitted, not independently generated, and a late joiner
  // reserves the slots of already-evicted blobs with empty husks (their chunk count is legitimately 0).
  // The array LENGTH still has to match on the nose — that is the check that protects volume identity.
  _onMapCheck(player, msg) {
    const got = Array.isArray(msg.counts) ? msg.counts : [];
    const want = this.chunkCounts;
    const base = this.baseVolumeCount || want.length;
    let mismatch = got.length !== want.length;
    if (!mismatch) for (let i = 0; i < base; i++) if (got[i] !== want[i]) { mismatch = true; break; }
    if (mismatch) {
      const m = `map_check MISMATCH from pid ${player.pid}: client volumes=${got.length} server volumes=${want.length}`;
      this.log.warn("!!!!!!!!!! " + m + " (destruction WILL desync — determinism broken) !!!!!!!!!!");
      player.conn.send({ t: S2C.WARN, msg: "Map chunk-count mismatch: your destruction may desync from the host." });
    }
  }

  _onState(player, msg) {
    const p = arr3(msg.p);
    if (!p) return;
    player.lastState = {
      p, yaw: num(msg.yaw), pitch: num(msg.pitch), v: arr3(msg.v) || [0, 0, 0],
      tool: msg.tool != null ? msg.tool : null,
      seat: msg.seat != null ? (msg.seat | 0) : null,
    };
    player.targetP = new THREE.Vector3(p[0], p[1] + CAP_CENTER, p[2]);
    // Phase 8: the Grab & Force intent rides along on this message. It carries no magnitudes — a tool code,
    // a mode and (for the ropes) an anchor — so validation is a whitelist, not a clamp table.
    const act = sanitizeAct(msg.act);
    player.act = act;
    if (act) player.actT = this._time();
    if (!act || act.k !== "grav") this._releaseGrav(player);
  }

  // Driving input. The RC Car Bomb reuses this channel unchanged: the only difference is that its vid is
  // held in player.rcVid instead of player.seatVid (the character stays on its feet, frozen locally).
  _onInput(player, msg) {
    const vid = msg.vid | 0;
    if (player.seatVid !== vid && player.rcVid !== vid) return;
    const rec = this.vehicles.get(vid);
    if (!rec || rec.driverPid !== player.pid) return;
    rec.netInput.set(msg);
  }

  _onEnterVeh(player, msg) {
    if (player.seatVid != null) return;
    const rec = this.vehicles.get(msg.vid | 0);
    if (!rec || rec.driverPid != null) return; // occupied or unknown
    rec.driverPid = player.pid;
    player.seatVid = rec.vid;
    if (player.body) player.body.setEnabled(false); // seated: capsule out of the sim
    this._broadcast({ t: S2C.SEAT, vid: rec.vid, pid: player.pid });
  }

  _onExitVeh(player, msg) {
    if (player.seatVid == null) return;
    const rec = this.vehicles.get(player.seatVid);
    const p = arr3(msg.p);
    if (rec && rec.driverPid === player.pid) {
      rec.driverPid = null;
      rec.netInput.clear();
    }
    if (player.body) {
      player.body.setEnabled(true);
      if (p) { player.body.setTranslation({ x: p[0], y: p[1] + CAP_CENTER, z: p[2] }, true); player.body.setLinvel({ x: 0, y: 0, z: 0 }, true); }
    }
    const vid = player.seatVid;
    player.seatVid = null;
    this._broadcast({ t: S2C.SEAT, vid, pid: 0 });
  }

  _onSpawnVeh(player, msg) {
    const spec = VEHICLE_SPECS[msg.id];
    if (!spec) return;
    // Per-player max 1 spawned vehicle: retire the previous one first (permanent hatchback untouched).
    if (player.spawnedVid != null) this._removeVehicle(player.spawnedVid);

    const V = resolveTuning(spec.tuning);
    const ls = player.lastState.p;
    const feet = new THREE.Vector3(ls[0], ls[1], ls[2]);
    const yaw = num(msg.yaw);
    const placement = this.manager._findPlacement(V, feet, yaw, player.body);
    const v = this.manager._create(spec, { x: placement.x, y: placement.y, z: placement.z, yaw });
    this._applyVehicleGroups(v);
    const vid = this._nextVid++;
    v._vid = vid;
    this.vehicles.set(vid, { v, vid, id: spec.id, ownerPid: player.pid, driverPid: null, netInput: new NetInput() });
    player.spawnedVid = vid;
    this._broadcast({ t: S2C.VEH_SPAWN, vid, id: spec.id, owner: player.pid, p: packP({ x: placement.x, y: placement.y, z: placement.z }), yaw: round3(yaw) });
  }

  _onDmg(player, msg) {
    const now = this._time();
    const senderP = player.lastState.p;
    if (msg.kind === "point") {
      // Point ticks may arrive at the chainsaw's 0.12 s hold-fire rate (Phase 7).
      if (now - player.lastDmg < CAPS.dmgMinIntervalPointSec) return this._dropDmg(player, "rate");
      const src = arr3(msg.src);
      const force = num(msg.force);
      if (!src || force <= 0 || force > CAPS.pointForceMax) return this._dropDmg(player, "point-force");
      if (!this._posValid(src, senderP)) return this._dropDmg(player, "point-pos");
      player.lastDmg = now;
      const opts = sanitizeMult(msg.mult);
      this.destruction.applyPointDamageRef(msg.vol | 0, msg.cid | 0, new THREE.Vector3(src[0], src[1], src[2]), force, opts);
    } else if (msg.kind === "radial") {
      if (now - player.lastDmg < CAPS.dmgMinIntervalRadialSec) return this._dropDmg(player, "rate");
      const p = arr3(msg.p);
      const force = num(msg.force);
      const radius = num(msg.radius);
      if (!p || force <= 0 || force > CAPS.radialForceMax || radius <= 0 || radius > CAPS.radialRadiusMax) return this._dropDmg(player, "radial-cap");
      if (!this._posValid(p, senderP)) return this._dropDmg(player, "radial-pos");
      player.lastDmg = now;
      const opts = sanitizeMult(msg.mult);
      this.destruction.applyRadialDamage(new THREE.Vector3(p[0], p[1], p[2]), force, radius, WPN.explosionDetachBudget, opts);
    } else if (msg.kind === "carve") {
      // Orbital Laser (40 m column through the floors), airstrike Penetrator, Car Cannon (short forward
      // segment per pulse). Kept as ONE carveCylinder rather than a clamped radial sphere so a beam can
      // still punch through several storeys. Every field is clamped, not just rejected, except the ones
      // that make the message meaningless (no direction, no length, off-map, too far from the sender).
      if (now - player.lastCarve < CAPS.dmgMinIntervalCarveSec) return this._dropDmg(player, "carve-rate");
      const p = arr3(msg.p);
      const dir = arr3(msg.dir);
      if (!p || !dir) return this._dropDmg(player, "carve-args");
      const dl = Math.hypot(dir[0], dir[1], dir[2]);
      if (!(dl > 1e-6)) return this._dropDmg(player, "carve-dir");
      const len = clampPos(msg.len, CAPS.carveLenMax);
      const radius = clampPos(msg.radius, CAPS.carveRadiusMax);
      const force = clampPos(msg.force, CAPS.carveForceMax);
      const budget = clampPos(msg.budget, CAPS.carveBudgetMax);
      if (!len || !radius || !force || !budget) return this._dropDmg(player, "carve-cap");
      if (!this._posValid(p, senderP, CAPS.carveWithinSenderM)) return this._dropDmg(player, "carve-pos");
      player.lastCarve = now;
      this.destruction.carveCylinder(
        new THREE.Vector3(p[0], p[1], p[2]),
        new THREE.Vector3(dir[0] / dl, dir[1] / dl, dir[2] / dl),
        len, radius, force, budget
      );
    }
  }

  _dropDmg(player, why) { this.log.warn(`[session] dropped dmg from pid ${player.pid} (${why})`); }

  // ---- Phase 7 batch D builders (server-authoritative) ----------------------------------------

  // Foam Cannon. The spray stream and the soft blob are cosmetic and client-local; only the moment a blob
  // HARDENS crosses the wire, as one packed occupancy bitmap. The server is the sole allocator of volume
  // indices — it creates the volume, then echoes the grid back with the index it landed on so every peer
  // (including the sprayer, which deliberately does NOT create it locally) builds the identical volume in
  // the identical slot. Volume identity is that index and the whole detach/debris protocol keys on it.
  _onFoam(player, msg) {
    const now = this._time();
    if (now - player.lastFoam < CAPS.foamMinIntervalSec) return this._dropBuild(player, "foam-rate");
    const o = arr3int(msg.o), d = arr3int(msg.d);
    if (!o || !d) return this._dropBuild(player, "foam-args");
    if (d[0] <= 0 || d[1] <= 0 || d[2] <= 0) return this._dropBuild(player, "foam-dims");
    if (d[0] > CAPS.foamDimMax || d[1] > CAPS.foamDimMax || d[2] > CAPS.foamDimMax) return this._dropBuild(player, "foam-dims");
    const voxels = d[0] * d[1] * d[2];
    if (voxels > CAPS.foamVoxelMax) return this._dropBuild(player, "foam-size");
    // Decode only after the cheap bounds tests: a bad `bits` must never cost an allocation of its choosing.
    const bytes = unpackBits(msg.bits, voxels);
    if (!bytes) return this._dropBuild(player, "foam-bits");
    const filled = countBits(bytes);
    if (filled === 0 || filled > WPN.foam.maxCells) return this._dropBuild(player, "foam-cells");
    const cell = WPN.foam.cell;
    const originM = [o[0] * cell, o[1] * cell, o[2] * cell];
    if (!this._posValid(originM, player.lastState.p, CAPS.foamWithinSenderM)) return this._dropBuild(player, "foam-pos");

    player.lastFoam = now;
    const nx = d[0], ny = d[1];
    const spec = foamVolumeSpec(o, d, (x, y, z) => bitAt(bytes, x + nx * (y + ny * z)));
    const vol = this.destruction.addVolume(spec);
    this.foamRecs.push({ volIdx: vol.id, o, d, bits: msg.bits, rm: false, vol });
    this.chunkCounts = this.destruction.volumes.map((v) => v.chunks.length);
    this._broadcast({ t: S2C.FOAM_ADD, vol: vol.id, o, d, bits: msg.bits });
    // Live-foam cap is the server's, not the client's: the sprayer must not evict on its own or two peers
    // would disagree about which blob is gone.
    const live = this.foamRecs.filter((r) => !r.rm);
    for (let i = 0; i < live.length - WPN.foam.maxVolumes; i++) this._removeFoam(live[i]);
  }

  _removeFoam(rec) {
    if (!rec || rec.rm) return;
    rec.rm = true;
    this.destruction.despawnVolume(rec.vol);
    this._broadcast({ t: S2C.FOAM_RM, vol: rec.volIdx });
  }

  // Size Ray. The client never sends a scale — it sends grow/shrink and the server steps its OWN value, so
  // a forged float cannot land. Valid targets are live debris chunks only: an attached chunk, the ground,
  // a vehicle or a player has no debris entry and falls straight through to the drop.
  _onZap(player, msg) {
    const now = this._time();
    if (now - player.lastZap < CAPS.zapMinIntervalSec) return this._dropBuild(player, "zap-rate");
    // Phase 8: a networked propane tank is now a legal target. It was deliberately left out while tanks
    // were client-local bodies — scaling one would have been invisible to everyone else.
    if (msg.prop != null) return this._zapProp(player, msg, now);
    const entry = this.destruction.findDebrisByRef(msg.vol | 0, msg.cid | 0);
    if (!entry || !entry.body) return this._dropBuild(player, "zap-target");
    const t = entry.body.translation();
    if (!this._posValid([t.x, t.y, t.z], player.lastState.p, CAPS.zapWithinSenderM)) return this._dropBuild(player, "zap-pos");
    const sr = WPN.sizeRay;
    if (now - (entry.sizeCd != null ? entry.sizeCd : -1e9) < sr.cooldown) return this._dropBuild(player, "zap-cooldown");
    const cur = entry.sizeScale || 1;
    const ns = Math.min(sr.max, Math.max(sr.min, cur * (msg.g ? sr.grow : sr.shrink)));
    if (Math.abs(ns - cur) < 1e-3) return; // already parked at a clamp limit: not an error, just a no-op
    entry.sizeCd = now;
    player.lastZap = now;
    // Same rules the solo fix established: collider REPLACED at the new size (Rapier cannot rescale one in
    // place), mass retargeted to baseMass * scale^3, the body — and therefore its velocity — untouched.
    const hc = this.destruction.chunkHalfCenter(entry.chunk, ns);
    if (!this.destruction.rescaleDebris(entry, hc.half, hc.center, ns)) return;
    entry.sizeScale = ns;
    this._broadcast({ t: S2C.SCALE, vol: entry.vol.id, cid: entry.chunk.id, s: round3(ns) });
  }

  // Size Ray on a networked prop. Same rules as the debris path: the client sends grow/shrink only, the
  // server steps and clamps its own scale, replaces the collider (Rapier cannot rescale one in place) and
  // lets the body's mass follow from the density it was built with.
  _zapProp(player, msg, now) {
    const pr = this.props.get(msg.prop | 0);
    if (!pr || pr.dead) return this._dropBuild(player, "zap-prop-target");
    const t = pr.body.translation();
    if (!this._posValid([t.x, t.y, t.z], player.lastState.p, CAPS.zapWithinSenderM)) return this._dropBuild(player, "zap-prop-pos");
    const sr = WPN.sizeRay;
    if (now - pr.sizeCd < sr.cooldown) return this._dropBuild(player, "zap-prop-cooldown");
    const cur = pr.scale || 1;
    const ns = Math.min(sr.max, Math.max(sr.min, cur * (msg.g ? sr.grow : sr.shrink)));
    if (Math.abs(ns - cur) < 1e-3) return; // parked at a clamp limit: a no-op, not an error
    pr.sizeCd = now;
    player.lastZap = now;
    const P_ = WPN.propane;
    this.destruction.unregisterDamageableProp(pr.collider.handle);
    try { this.world.removeCollider(pr.collider, true); } catch (e) {}
    const cd = this.RAPIER.ColliderDesc.cylinder(P_.colliderHalf * ns, P_.colliderRadius * ns)
      .setRestitution(0.2).setFriction(0.85).setDensity(P_.density);
    pr.collider = this.world.createCollider(cd, pr.body);
    this.destruction.registerDamageableProp(pr.collider.handle, pr);
    if (typeof pr.body.recomputeMassPropertiesFromColliders === "function") {
      try { pr.body.recomputeMassPropertiesFromColliders(); } catch (e) {}
    }
    pr.scale = ns;
    // The scale rides the props stream too (last field), but a one-shot message makes the change legible
    // the moment it happens instead of on the next 20 Hz tick.
    this._broadcast({ t: S2C.SCALE, prop: pr.id, s: round3(ns) });
  }

  // Rebuild Gun. Exactly the mirror of detach, on its own channel: the client streams the aim point while
  // LMB is held and the SERVER decides which chunk restores (nearest damaged volume, oldest damage first).
  _onRebuild(player, msg) {
    const now = this._time();
    if (now - player.lastRebuild < CAPS.rebuildMinIntervalSec) return this._dropBuild(player, "rebuild-rate");
    const p = arr3(msg.p);
    if (!p) return this._dropBuild(player, "rebuild-args");
    if (!this._posValid(p, player.lastState.p, CAPS.rebuildWithinSenderM)) return this._dropBuild(player, "rebuild-pos");
    player.lastRebuild = now;
    const aim = new THREE.Vector3(p[0], p[1], p[2]);
    const cand = this.destruction.rebuildCandidate(aim, WPN.rebuild.range, null);
    if (!cand) return;
    if (!this.destruction.reattachChunk(cand.vol, cand.chunk)) return;
    this._broadcast({ t: S2C.REATTACH, events: [[cand.vol.id, cand.chunk.id]] });
  }

  _dropBuild(player, why) { this.log.warn(`[session] dropped build intent from pid ${player.pid} (${why})`); }

  // ---- Phase 8: Grab & Force (server-authoritative continuous forces) --------------------------
  // The server owns every debris body and every vehicle, so a client that applies these forces locally
  // moves nothing anyone else can see (its debris is kinematic). The client therefore sends INTENT ONLY —
  // which tool, which mode, where it is aiming — and this runs the physics. The result travels back on the
  // channels that already exist: `debris` at 10 Hz for chunks, `vstate` at 20 Hz for vehicles and props.
  //
  // Nothing here reads a magnitude off the wire. Range, cone angle, speed, force, mass ceiling and the
  // release rules all come from CONFIG.weapons; the ray comes from the sender's own reported position and
  // yaw/pitch, which _onState already teleport-clamps. A forged act can aim, and that is all it can do.
  _applyActs(dt) {
    const now = this._time();
    for (const player of this.players.values()) {
      const act = player.act;
      if (!act) { player.vrope = null; this._releaseGrav(player); continue; }
      if (now - player.actT > CAPS.actStaleSec) { player.act = null; player.vrope = null; this._releaseGrav(player); continue; }
      if (act.k !== "vrope") player.vrope = null;
      switch (act.k) {
        case "grav": this._actGravity(player, dt); break;
        case "mag": this._actMagnet(player, act.m, dt); break;
        case "vac": this._actVacuum(player, dt); break;
        case "vrope": this._actVehicleRope(player, act, dt); break;
        // "grap" is the on-foot rope: the swing is client-predicted movement in the same bucket as walking,
        // so the server carries the anchor for everyone else's rope and applies no force of its own.
        default: break;
      }
    }
  }

  // Eye position of a player from its last reported feet position. The client's cone apex is the tool
  // muzzle, a few centimetres off this; at cone half-angles of 26-34 degrees that difference cannot change
  // which bodies are inside the cone at any distance worth caring about.
  _eyeOf(player) {
    const p = player.lastState.p;
    return new THREE.Vector3(p[0], p[1] + P.eyeHeightFallback, p[2]);
  }

  // Bodies inside an aim cone. Mirrors weapons._coneBodies, over the server's OWN entities: destruction
  // debris, drivable vehicles and networked props. Never touches fixed chunks and never registers an
  // impactor, so the no-cascade rule holds by construction.
  _coneBodies(apex, dir, range, cosHalf, opts = {}) {
    const out = [];
    const tmp = new THREE.Vector3();
    const push = (body, pos, dist, kind, extra) => out.push({ body, pos, dist, kind, ...extra });
    const test = (t) => {
      tmp.set(t.x - apex.x, t.y - apex.y, t.z - apex.z);
      const dist = tmp.length();
      if (dist < 1e-3 || dist > range) return -1;
      if (tmp.dot(dir) / dist < cosHalf) return -1;
      return dist;
    };
    if (opts.debris !== false) {
      this.destruction.forEachDebris((d) => {
        if (opts.metalOnly && d.vol.materialClass !== "metal") return;
        const t = d.body.translation();
        const dist = test(t);
        if (dist < 0) return;
        push(d.body, new THREE.Vector3(t.x, t.y, t.z), dist, "debris", { entry: d });
      });
    }
    if (opts.vehicles) {
      for (const rec of this.vehicles.values()) {
        const v = rec.v;
        if (!v || !v.body || !v.V) continue;
        if (opts.skipVehicle && rec.vid === opts.skipVehicle) continue;
        if (opts.massMax && v.V.mass > opts.massMax) continue;
        const c = v.centerWorld();
        const dist = test(c);
        if (dist < 0) continue;
        push(v.body, c, dist, "vehicle", { rec });
      }
    }
    if (opts.props) {
      for (const pr of this.props.values()) {
        if (pr.dead) continue;
        const t = pr.body.translation();
        const dist = test(t);
        if (dist < 0) continue;
        push(pr.body, new THREE.Vector3(t.x, t.y, t.z), dist, "prop", { prop: pr });
      }
    }
    return out;
  }

  // 5d. Wind Cannon — one-shot cone impulse, ZERO destruction, 1/dist falloff. Same maths as solo.
  _fireWind(player, dir) {
    const wc = WPN.windCannon;
    const apex = this._eyeOf(player);
    const cosHalf = Math.cos((wc.halfAngleDeg * Math.PI) / 180);
    const bodies = this._coneBodies(apex, dir, wc.range, cosHalf, {
      debris: true, vehicles: true, props: true, skipVehicle: player.seatVid,
    });
    for (const b of bodies) {
      const falloff = 1 - b.dist / wc.range;
      const mass = b.body.mass ? b.body.mass() : 1;
      let impMag = Math.min(wc.impulse * falloff, mass * wc.maxDV);
      if (b.kind === "vehicle") impMag *= wc.vehicleFactor;
      const away = b.pos.clone().sub(apex);
      if (away.lengthSq() < 1e-6) away.copy(dir); else away.normalize();
      b.body.applyImpulse({ x: away.x * impMag, y: away.y * impMag + impMag * 0.15, z: away.z * impMag }, true);
    }
    return bodies.length;
  }

  // 5e. Debris Vacuum — velocity-steer debris toward the muzzle; consume inside consumeDist. The consume
  // goes through destruction.consumeDebris, which frees the 200 cap AND emits the debris_rm every peer
  // needs, so the chunk disappears everywhere at once rather than only for the sprayer.
  _actVacuum(player, dt) {
    const vc = WPN.vacuum;
    const apex = this._eyeOf(player);
    const dir = this._aimOf(player);
    const cosHalf = Math.cos((vc.halfAngleDeg * Math.PI) / 180);
    const bodies = this._coneBodies(apex, dir, vc.range, cosHalf, { debris: true });
    const to = new THREE.Vector3();
    const consumed = [];
    for (const b of bodies) {
      to.set(apex.x - b.pos.x, apex.y - b.pos.y, apex.z - b.pos.z);
      const dist = to.length();
      if (dist < 1e-4) continue;
      to.multiplyScalar(1 / dist);
      const falloff = 1 - b.dist / vc.range;
      const mass = b.body.mass ? b.body.mass() : 1;
      const vel = b.body.linvel();
      const vAlong = vel.x * to.x + vel.y * to.y + vel.z * to.z;
      const desired = vc.suckSpeed * (0.4 + 0.6 * falloff);
      const dv = (desired - vAlong) * Math.min(1, vc.steer * dt);
      b.body.applyImpulse({ x: to.x * dv * mass, y: to.y * dv * mass, z: to.z * dv * mass }, true);
      if (dist <= vc.consumeDist) consumed.push(b.entry);
    }
    for (const e of consumed) this.destruction.consumeDebris(e);
  }

  // 5b. Magnet Gun — metal-only stateless field, 10 nearest, attract (m=1) or repel (m=2).
  _actMagnet(player, mode, dt) {
    if (mode !== 1 && mode !== 2) return;
    const mg = WPN.magnet;
    const apex = this._eyeOf(player);
    const dir = this._aimOf(player);
    const cosHalf = Math.cos((mg.halfAngleDeg * Math.PI) / 180);
    let bodies = this._coneBodies(apex, dir, mg.range, cosHalf, {
      debris: true, metalOnly: true, vehicles: true, massMax: mg.massMax, skipVehicle: player.seatVid,
    });
    bodies.sort((a, b) => a.dist - b.dist);
    if (bodies.length > mg.maxTargets) bodies = bodies.slice(0, mg.maxTargets);
    const sign = mode === 1 ? 1 : -1;
    const to = new THREE.Vector3();
    for (const b of bodies) {
      to.set(apex.x - b.pos.x, apex.y - b.pos.y, apex.z - b.pos.z);
      const dist = to.length();
      if (dist < 1e-4) continue;
      to.multiplyScalar(sign / dist);
      const mass = b.body.mass ? b.body.mass() : 1;
      const vel = b.body.linvel();
      const vAlong = vel.x * to.x + vel.y * to.y + vel.z * to.z;
      const falloff = 1 - b.dist / mg.range;
      let desired = mg.pullSpeed * (0.4 + 0.6 * falloff);
      if (mode === 1 && dist < mg.clampDist) desired = 0;
      const dv = (desired - vAlong) * Math.min(1, mg.steer * dt);
      b.body.applyImpulse({ x: to.x * dv * mass, y: to.y * dv * mass, z: to.z * dv * mass }, true);
    }
  }

  // 5a. Gravity Gun — the server acquires the target (its own raycast), runs gravityHoldStep every step and
  // owns the release. The client never names the body it grabbed, so it cannot grab something it is not
  // looking at, cannot hold a body through a wall, and cannot hold a vehicle over the mass ceiling.
  _actGravity(player, dt) {
    const cfg = WPN.gravityGun;
    const camPos = this._eyeOf(player);
    const aim = this._aimOf(player);
    if (!player.grav) this._acquireGrav(player, camPos, aim, cfg);
    const h = player.grav;
    if (!h) return;
    if (!this._gravValid(player, h)) { this._releaseGrav(player); return; }
    const keep = gravityHoldStep(camPos, aim, h.body, cfg, dt);
    if (!keep) {
      player.gravReleaseT += dt;
      if (player.gravReleaseT > cfg.releaseTime) this._releaseGrav(player);
    } else player.gravReleaseT = 0;
  }

  _acquireGrav(player, camPos, aim, cfg) {
    const hit = this.world.castRay(
      new this.RAPIER.Ray(camPos, aim), cfg.grabRange, true, undefined, undefined, undefined, player.body
    );
    if (!hit) return;
    const handle = hit.collider.handle;
    const entry = this.destruction.findDebrisByCollider(handle); // detached chunks only, never fixed
    if (entry) { player.grav = { kind: "debris", body: entry.body, entry }; player.gravReleaseT = 0; return; }
    const prop = this._propByCollider(handle);
    if (prop) { player.grav = { kind: "prop", body: prop.body, prop }; player.gravReleaseT = 0; return; }
    const veh = this.manager ? this.manager.byColliderHandle(handle) : null;
    if (veh && veh.body && veh.V) {
      const rec = this._recForVehicle(veh);
      if (!rec || (player.seatVid != null && rec.vid === player.seatVid)) return; // never grab your own ride
      if (veh.V.mass > cfg.massMax) return;                                        // heavy => strain refusal
      player.grav = { kind: "vehicle", body: veh.body, vid: rec.vid };
      player.gravReleaseT = 0;
    }
  }

  _gravValid(player, h) {
    if (h.kind === "debris") return !h.entry.fading && this.destruction.debris.indexOf(h.entry) >= 0;
    if (h.kind === "prop") return !h.prop.dead && this.props.has(h.prop.id);
    if (h.kind === "vehicle") return this.vehicles.has(h.vid);
    return false;
  }

  _releaseGrav(player) { if (player.grav) { player.grav = null; player.gravReleaseT = 0; } }

  // Gravity throw (RMB). One-shot, so it is a `force` message rather than an act mode: at 20 Hz a mode flip
  // that lasts one frame would be lost outright about half the time.
  _throwGrav(player, aim) {
    const h = player.grav;
    if (!h || !this._gravValid(player, h)) { this._releaseGrav(player); return false; }
    const mass = h.body.mass ? h.body.mass() : 1;
    const speed = WPN.gravityGun.throwSpeed;
    h.body.applyImpulse({ x: aim.x * speed * mass, y: (aim.y * speed + 2) * mass, z: aim.z * speed * mass }, true);
    // No-cascade rule: a thrown chunk is still debris — it is never registered as an impactor, so it can
    // shove things around but can never detach a fixed chunk.
    this._releaseGrav(player);
    return true;
  }

  // 5c. Grapple, vehicle rope. The joint and the tear stay on the driver's client (the tear already travels
  // as an ordinary point-dmg intent); what the server adds is the pull on the TORN chunk, which is a server
  // body — without this the chunk drags behind the car only on the grappler's screen.
  _actVehicleRope(player, act, dt) {
    if (player.seatVid == null || !Array.isArray(act.r)) return;
    const rec = this.vehicles.get(player.seatVid);
    if (!rec || rec.driverPid !== player.pid) return;
    const entry = this.destruction.findDebrisByRef(act.r[0] | 0, act.r[1] | 0);
    if (!entry || !entry.body) return;
    const g = WPN.grapple.veh;
    const cpos = rec.v.centerWorld();
    const t = entry.body.translation();
    const delta = new THREE.Vector3(cpos.x - t.x, cpos.y - t.y, cpos.z - t.z);
    const dist = delta.length();
    if (dist < 1e-3 || dist > g.maxLen * 1.5) { player.vrope = null; return; } // out of rope: already let go
    // Rest length is latched the first frame this rope is seen, from the distance the chunk was ACTUALLY
    // at — the same restSlack rule the client uses when it fires. Taking it off the wire would be one more
    // client-supplied number to police, and taking a fixed value makes every rope either slack or a catapult.
    const key = (act.r[0] | 0) + ":" + (act.r[1] | 0);
    if (!player.vrope || player.vrope.key !== key) player.vrope = { key, rest: Math.max(1.0, dist * g.restSlack) };
    const n = delta.multiplyScalar(1 / dist);
    const va = rec.v.body.linvel();
    const vb = entry.body.linvel();
    const relV = (va.x - vb.x) * n.x + (va.y - vb.y) * n.y + (va.z - vb.z) * n.z;
    const f = g.spring * Math.max(0, dist - player.vrope.rest) - g.damp * relV;
    if (f <= 0) return;
    // Mass-capped impulse, the same idiom the Wind Cannon uses. `spring` is sized for a 1100 kg chassis;
    // handing that force straight to a 20 kg wood chunk fires it past the car at 30 m/s in ONE step
    // (measured: a chunk 7.7 m behind the car ended up 15.9 m in front of it). Cap the per-step velocity
    // change instead, so the chunk accelerates over a few frames and then drags.
    const mass = entry.body.mass ? entry.body.mass() : 1;
    const imp = Math.min(Math.min(f, g.snapTension) * dt, mass * VROPE_MAX_DV);
    entry.body.applyImpulse({ x: n.x * imp, y: n.y * imp, z: n.z * imp }, true);
  }

  // One-shot Grab & Force impulses (Wind Cannon, Gravity throw).
  _onForce(player, msg) {
    const now = this._time();
    if (now - player.lastForce < CAPS.forceMinIntervalSec) return this._dropAct(player, "force-rate");
    const d = arr3(msg.d);
    if (!d) return this._dropAct(player, "force-args");
    const dl = Math.hypot(d[0], d[1], d[2]);
    if (!(dl > 1e-6)) return this._dropAct(player, "force-dir");
    const dir = new THREE.Vector3(d[0] / dl, d[1] / dl, d[2] / dl);
    if (msg.k === "wind") { player.lastForce = now; this._fireWind(player, dir); return; }
    if (msg.k === "gthrow") { if (this._throwGrav(player, dir)) player.lastForce = now; return; }
    return this._dropAct(player, "force-kind");
  }

  _dropAct(player, why) { this.log.warn(`[session] dropped act intent from pid ${player.pid} (${why})`); }

  // Aim direction from the sender's reported yaw/pitch — the exact expansion of weapons._aimDir(),
  // which is (0,0,-1) put through Euler(pitch, yaw, 0, "YXZ").
  _aimOf(player) {
    const yaw = player.lastState.yaw || 0, pitch = player.lastState.pitch || 0;
    const cp = Math.cos(pitch);
    return new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  }

  _recForVehicle(v) { for (const rec of this.vehicles.values()) if (rec.v === v) return rec; return null; }
  _propByCollider(handle) {
    for (const pr of this.props.values()) if (!pr.dead && pr.collider.handle === handle) return pr;
    return null;
  }
  // ---- Phase 8: Airstrike (server-owned scripted run) -----------------------------------------
  // One client asks for a strike; the SERVER flies the pass and drops the ordnance, so the damage happens
  // once, on one timeline, and every peer — including the requester — only animates it. The plane, the
  // falling bombs and the whistle are pure presentation on all four clients.
  _onAir(player, msg) {
    const now = this._time();
    if (player.airRunning) return this._dropAct(player, "air-busy");
    if (now - player.lastAir < CAPS.airMinIntervalSec) return this._dropAct(player, "air-rate");
    const p = arr3(msg.p), d = arr3(msg.d);
    if (!p || !d) return this._dropAct(player, "air-args");
    const dl = Math.hypot(d[0], d[2]);
    if (!(dl > 1e-6)) return this._dropAct(player, "air-dir");
    if (!this._posValid(p, player.lastState.p, CAPS.airWithinSenderM)) return this._dropAct(player, "air-pos");
    const ammo = msg.a === 1 ? 1 : msg.a === 2 ? 2 : 0;
    player.lastAir = now;
    player.airRunning = true;
    const dir = [d[0] / dl, 0, d[2] / dl];
    // Seed for the cluster split, chosen HERE and echoed: the bomblets a client watches are then the same
    // bomblets whose impacts this server is about to damage with.
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.airRuns.push({ pid: player.pid, target: p, ammo, dir, seed, t: 0, released: false });
    this._broadcast({
      t: S2C.AIR_RUN, pid: player.pid, p: packP(p), a: ammo,
      d: [round3(dir[0]), 0, round3(dir[2])], seed,
    });
  }

  _stepAirRuns(dt) {
    const A = WPN.airstrike;
    if (this.airRuns.length) {
      const keep = [];
      for (const run of this.airRuns) {
        run.t += dt;
        const u = Math.min(1, run.t / A.runTime);
        if (!run.released && u >= 0.5) { run.released = true; this._releaseOrdnance(run); }
        if (u >= 1) { const pl = this.players.get(run.pid); if (pl) pl.airRunning = false; continue; }
        keep.push(run);
      }
      this.airRuns = keep;
    }
    if (this.airDrops.length) this._stepAirDrops(dt);
    if (this._clusters && this._clusters.length) this._stepClusters(dt);
  }

  _releaseOrdnance(run) {
    const A = WPN.airstrike;
    const [tx, ty, tz] = run.target;
    const dir = run.dir;
    if (run.ammo === 0) {
      for (let i = 0; i < A.dropCount; i++) {
        const off = (i - (A.dropCount - 1) / 2) * A.dropSpacing;
        const gx = tx + dir[0] * off, gz = tz + dir[2] * off;
        this._spawnDrop([gx, A.altitude, gz], [gx, ty, gz], "bomb", run.seed + i);
      }
    } else if (run.ammo === 1) {
      this._spawnDrop([tx, A.altitude, tz], [tx, ty, tz], "pen", run.seed);
    } else {
      this._spawnDrop([tx, A.altitude, tz], [tx, ty, tz], "cluster", run.seed);
    }
  }

  _spawnDrop(top, impact, type, seed) {
    const pos = new THREE.Vector3(top[0], top[1], top[2]);
    const imp = new THREE.Vector3(impact[0], impact[1], impact[2]);
    const dir = imp.clone().sub(pos);
    if (dir.lengthSq() < 1e-6) dir.set(0, -1, 0); else dir.normalize();
    this.airDrops.push({ pos, dir, impact: imp, type, seed });
  }

  _stepAirDrops(dt) {
    const A = WPN.airstrike;
    const keep = [];
    for (const d of this.airDrops) {
      const step = A.dropSpeed * dt;
      const hit = this.world.castRay(
        new this.RAPIER.Ray(d.pos, d.dir), step, true, undefined, undefined, undefined, undefined, this._notCapsule
      );
      let point = null;
      if (hit) point = d.pos.clone().addScaledVector(d.dir, hit.toi);
      else {
        d.pos.addScaledVector(d.dir, step);
        if (d.pos.distanceToSquared(d.impact) < 0.6) point = d.impact.clone();
      }
      if (point) { this._strikeOrdnance(d, point); continue; }
      keep.push(d);
    }
    this.airDrops = keep;
  }

  _strikeOrdnance(d, point) {
    const A = WPN.airstrike;
    if (d.type === "pen") {
      this.destruction.carveCylinder(
        point.clone().add(new THREE.Vector3(0, 6, 0)), new THREE.Vector3(0, -1, 0),
        A.penThrough, A.penRadius, A.penForce, A.penBudget
      );
    } else if (d.type === "cluster") {
      this._spawnClusterAt(point, A.clusterSpread, d.seed);
    } else {
      // Staged, exactly like solo: a bomb string must ripple through the frame budget, not land in one tick.
      this.destruction.enqueueRadialJobs([{ center: point, force: A.bombForce, radius: A.bombRadius, budget: A.bombBudget }]);
    }
  }

  // Airstrike cluster ammo: seeded bomblets, ray-stepped like the client's so the craters land where the
  // players watched the bomblets go. The launcher's OWN cluster round is a client projectile whose damage
  // already arrives as radial dmg intents — this is only the air-dropped variant, which the server owns.
  _spawnClusterAt(point, spread, seed) {
    const cl = WPN.cluster;
    const rng = mulberry32(seed >>> 0);
    if (!this._clusters) this._clusters = [];
    const bomblets = [];
    for (let i = 0; i < cl.bombletCount; i++) {
      const ang = (i / cl.bombletCount) * Math.PI * 2 + rng() * 0.6;
      const spd = spread * (0.6 + 0.6 * rng());
      bomblets.push({
        pos: point.clone(),
        vel: new THREE.Vector3(Math.cos(ang) * spd, cl.bombletUp * (0.6 + 0.8 * rng()), Math.sin(ang) * spd),
        age: 0, dead: false,
      });
    }
    this._clusters.push({ bomblets });
  }

  _stepClusters(dt) {
    const cl = WPN.cluster;
    const keep = [];
    for (const c of this._clusters) {
      for (const b of c.bomblets) {
        if (b.dead) continue;
        b.age += dt;
        b.vel.y -= cl.bombletGravity * dt;
        const step = b.vel.clone().multiplyScalar(dt);
        const dist = step.length();
        const dir = dist > 1e-6 ? step.clone().multiplyScalar(1 / dist) : new THREE.Vector3(0, -1, 0);
        const hit = this.world.castRay(
          new this.RAPIER.Ray(b.pos, dir), Math.max(dist, 0.05), true, undefined, undefined, undefined, undefined, this._notCapsule
        );
        if (hit || b.age > cl.bombletLifetime) {
          const point = hit ? b.pos.clone().addScaledVector(dir, hit.toi) : b.pos.clone();
          this.destruction.enqueueRadialJobs([{ center: point, force: cl.bombletForce, radius: cl.bombletRadius, budget: cl.bombletBudget }]);
          b.dead = true;
          continue;
        }
        b.pos.add(step);
      }
      c.bomblets = c.bomblets.filter((b) => !b.dead);
      if (c.bomblets.length) keep.push(c);
    }
    this._clusters = keep;
  }

  // ---- Phase 8: Blast Painter (server-side painted set) ---------------------------------------
  // The set lives here, per player, because the blast is DELAYED: whichever chunks were marked when the
  // trigger is pulled are the chunks that come down, and that answer has to be the same on every peer.
  _onPaint(player, msg) {
    const now = this._time();
    if (now - player.lastPaint < CAPS.paintMinIntervalSec) return this._dropAct(player, "paint-rate");
    const volIdx = msg.vol | 0, cid = msg.cid | 0;
    const vol = this.destruction.volumes[volIdx];
    const chunk = vol && !vol.removed ? vol.chunks[cid] : null;
    if (!chunk || !chunk.active) return this._dropAct(player, "paint-target");
    const c = chunk.centroid;
    if (!this._posValid([c.x, c.y, c.z], player.lastState.p, CAPS.paintWithinSenderM)) return this._dropAct(player, "paint-pos");
    player.lastPaint = now;
    const key = volIdx + ":" + cid;
    if (player.painted.has(key)) return;
    player.painted.add(key);
    this._broadcast({ t: S2C.PAINT_ADD, pid: player.pid, vol: volIdx, cid });
    // Same cap as solo, enforced here so nobody can hold a bigger set than anyone can see.
    while (player.painted.size > WPN.blastPainter.maxPainted) {
      const oldest = player.painted.values().next().value;
      player.painted.delete(oldest);
      const i = oldest.indexOf(":");
      this._broadcast({ t: S2C.PAINT_ADD, pid: player.pid, vol: +oldest.slice(0, i), cid: +oldest.slice(i + 1), rm: 1 });
    }
  }

  _onPaintDet(player, msg) {
    const now = this._time();
    if (now - player.lastPaintDet < CAPS.paintDetMinIntervalSec) return this._dropAct(player, "paintdet-rate");
    if (player.painted.size === 0) return;
    player.lastPaintDet = now;
    this.destruction.detonatePainted(new Set(player.painted), WPN.blastPainter.force);
    player.painted.clear();
    this._broadcast({ t: S2C.PAINT_CLR, pid: player.pid });
  }

  // ---- Phase 8: Propane tanks (server-owned dynamic props) ------------------------------------
  // A tank used to be a client-local body, which is why the Size Ray deliberately skipped it. Now the
  // server owns the body, streams it in the `props` array of the existing vstate message, and runs the
  // explode-on-hard-impact test — so the tank exists, moves, scales and detonates identically for everyone.
  _onProp(player, msg) {
    const now = this._time();
    if (now - player.lastProp < CAPS.propMinIntervalSec) return this._dropAct(player, "prop-rate");
    const p = arr3(msg.p), d = arr3(msg.d);
    if (!p || !d) return this._dropAct(player, "prop-args");
    const dl = Math.hypot(d[0], d[1], d[2]);
    if (!(dl > 1e-6)) return this._dropAct(player, "prop-dir");
    if (!this._posValid(p, player.lastState.p, CAPS.propWithinSenderM)) return this._dropAct(player, "prop-pos");
    player.lastProp = now;
    // Per-player live cap: retire the oldest instead of refusing, exactly like solo's maxLive.
    let owned = [...this.props.values()].filter((x) => x.owner === player.pid && !x.dead);
    while (owned.length >= CAPS.propMaxPerPlayer) { const old = owned.shift(); this._removeProp(old, false); }
    const pr = WPN.propane;
    const dir = { x: d[0] / dl, y: d[1] / dl, z: d[2] / dl };
    const bodyDesc = this.RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p[0], p[1], p[2])
      // Speed comes from CONFIG, never from the wire: the client picks a direction, the game picks a throw.
      .setLinvel(dir.x * pr.throwSpeed, dir.y * pr.throwSpeed + pr.upBias, dir.z * pr.throwSpeed)
      .setCcdEnabled(true).setCanSleep(true);
    const body = this.world.createRigidBody(bodyDesc);
    const cd = this.RAPIER.ColliderDesc.cylinder(pr.colliderHalf, pr.colliderRadius)
      .setRestitution(0.2).setFriction(0.85).setDensity(pr.density);
    const collider = this.world.createCollider(cd, body);
    const id = this._nextPropId++;
    const lv = body.linvel();
    const rec = {
      id, owner: player.pid, body, collider, scale: 1, age: 0, dead: false,
      prevVel: new THREE.Vector3(lv.x, lv.y, lv.z), chainR: pr.chainR, exploded: false, queued: false,
      sizeCd: -1e9,
    };
    rec.pos = () => { const t = body.translation(); return new THREE.Vector3(t.x, t.y, t.z); };
    rec.explode = () => this._explodeProp(rec);
    // Registered as a damageable prop (shot / blast chain), NEVER as an impactor: a flying tank must not
    // detach chunks by contact.
    this.destruction.registerDamageableProp(collider.handle, rec);
    this.props.set(id, rec);
    this._broadcast({ t: S2C.PROP_ADD, id, owner: player.pid, p: packP(p), q: packQ(body.rotation()) });
  }

  _stepProps(dt) {
    if (this.props.size === 0) return;
    const cur = new THREE.Vector3();
    for (const pr of this.props.values()) {
      if (pr.dead) continue;
      pr.age += dt;
      const lv = pr.body.linvel();
      cur.set(lv.x, lv.y, lv.z);
      const dv = cur.distanceTo(pr.prevVel);
      pr.prevVel.copy(cur);
      // Hard impact (a big single-frame velocity change), with the same launch grace period as solo. This
      // is NOT the allowedImpactors path, so a bouncing tank still cannot cascade the map.
      if (pr.age > 0.3 && dv > WPN.propane.impactDV) this._explodeProp(pr);
      else if (pr.body.translation().y < -20) this._removeProp(pr, false); // fell off the world
    }
  }

  _explodeProp(pr) {
    if (pr.dead) return;
    const t = pr.body.translation();
    const p = new THREE.Vector3(t.x, t.y, t.z);
    this._removeProp(pr, true, p);
    this.destruction.applyRadialDamage(p, WPN.propane.force, WPN.propane.radius, WPN.propane.budget);
  }

  _removeProp(pr, boom, at) {
    if (!pr || pr.dead) return;
    pr.dead = true; pr.exploded = true;
    this.destruction.unregisterDamageableProp(pr.collider.handle);
    // Anyone holding this tank with a Gravity Gun lets go of it now.
    for (const pl of this.players.values()) if (pl.grav && pl.grav.prop === pr) this._releaseGrav(pl);
    try { this.world.removeRigidBody(pr.body); } catch (e) {}
    this.props.delete(pr.id);
    const t = at || pr.pos();
    this._propRmOut.push({ t: S2C.PROP_RM, id: pr.id, boom: boom ? 1 : 0, p: packP(t) });
  }

  // ---- Phase 8: RC Car Bomb -------------------------------------------------------------------
  // "A player controls an entity that is not their character" — the same input-routing case as driving, so
  // it reuses the driving channel: the server spawns a real networked vehicle, the deployer's `input`
  // messages steer it, and vstate carries it to everyone. The character stays where it is (frozen locally).
  _onRc(player, msg) {
    const now = this._time();
    if (now - player.lastRc < CAPS.rcMinIntervalSec) return this._dropAct(player, "rc-rate");
    player.lastRc = now;
    if (msg.a === "deploy") {
      if (player.rcVid != null) return this._dropAct(player, "rc-live");
      if (player.seatVid != null) return this._dropAct(player, "rc-seated");
      const spec = VEHICLE_SPECS.rccar;
      const ls = player.lastState.p;
      const yaw = num(player.lastState.yaw);
      const v = this.manager._create(spec, { x: ls[0], y: ls[1] + 0.1, z: ls[2], yaw });
      this._applyVehicleGroups(v);
      const vid = this._nextVid++;
      v._vid = vid;
      this.vehicles.set(vid, { v, vid, id: "rccar", ownerPid: player.pid, driverPid: player.pid, netInput: new NetInput(), rc: true });
      player.rcVid = vid;
      this._broadcast({ t: S2C.VEH_SPAWN, vid, id: "rccar", owner: player.pid, p: packP(v.centerWorld()), yaw: round3(yaw) });
      player.conn.send({ t: S2C.RC_GRANT, vid, pid: player.pid });
      return;
    }
    if (player.rcVid == null) return;
    const rec = this.vehicles.get(player.rcVid);
    if (msg.a === "det" && rec) {
      const p = rec.v.centerWorld();
      this._endRc(player);
      this.destruction.applyRadialDamage(p, WPN.rcCar.force, WPN.rcCar.radius, WPN.rcCar.budget);
      this._broadcast({ t: S2C.PROP_RM, id: 0, boom: 1, p: packP(p) }); // blast audio cue for every peer
      return;
    }
    if (msg.a === "ret") this._endRc(player);
  }

  _endRc(player) {
    const vid = player.rcVid;
    if (vid == null) return;
    player.rcVid = null;
    this._removeVehicle(vid);
    player.conn.send({ t: S2C.RC_GRANT, vid: 0, pid: player.pid });
  }

  // ---- Phase 8: projectile visual relays ------------------------------------------------------
  // Pipe / sticky / cluster rounds already synchronise their DAMAGE (radial dmg intents), but the flying
  // object itself was invisible to everyone but the thrower. These two messages are presentation only —
  // they never touch the sim — so they are validated as a flood gate plus a sanity box, nothing more.
  _onProj(player, msg) {
    const now = this._time();
    if (now - player.lastProj < CAPS.projMinIntervalSec) return this._dropAct(player, "proj-rate");
    const p = arr3(msg.p), v = arr3(msg.v);
    if (!p || !v) return this._dropAct(player, "proj-args");
    if (msg.k !== "pipe" && msg.k !== "sticky" && msg.k !== "cluster") return this._dropAct(player, "proj-kind");
    if (!this._posValid(p, player.lastState.p, CAPS.dmgWithinSenderM)) return this._dropAct(player, "proj-pos");
    if (Math.hypot(v[0], v[1], v[2]) > CAPS.projSpeedMax) return this._dropAct(player, "proj-speed");
    player.lastProj = now;
    this._broadcast({
      t: S2C.PROJ, pid: player.pid, id: msg.id | 0, k: msg.k,
      p: packP(p), v: packP(v), seed: (msg.seed >>> 0) || 0,
    }, player.pid);
  }

  // No rate clock here, deliberately, and for the same reason rocket_end has none: several projectiles
  // legitimately end in the same frame (six stickies reaching their fuse together), and a floor would
  // strand their copies mid-air on every peer. The message is still position-checked, and it can only ever
  // delete a mesh the sender itself created.
  _onProjEnd(player, msg) {
    const p = arr3(msg.p);
    if (!p) return;
    if (!this._posValid(p, null)) return this._dropAct(player, "projend-pos");
    this._broadcast({ t: S2C.PROJ_END, pid: player.pid, id: msg.id | 0, p: packP(p) }, player.pid);
  }

  _onC4Place(player, msg) {
    const p = arr3(msg.p);
    const q = arr4(msg.q);
    if (!p || !q) return;
    // Enforce the per-player cap by evicting this player's oldest charge (mirrors solo maxCharges).
    const owned = [...this.charges.values()].filter((c) => c.owner === player.pid);
    while (owned.length >= CAPS.c4MaxPerPlayer) {
      const old = owned.shift();
      this.charges.delete(old.cid4);
    }
    const cid4 = this._nextCid4++;
    const vid = msg.vid != null ? (msg.vid | 0) : -1;
    this.charges.set(cid4, { cid4, owner: player.pid, p: packP(p), q: packQ(q), vid });
    this._broadcast({ t: S2C.C4_ADD, cid4, owner: player.pid, p: packP(p), q: packQ(q), vid });
  }

  _onC4Det(player, msg) {
    const own = [...this.charges.values()].filter((c) => c.owner === player.pid);
    if (own.length === 0) return;
    const ids = [];
    const blasts = [];
    for (const c of own) {
      const center = new THREE.Vector3(c.p[0], c.p[1], c.p[2]);
      this.destruction.applyRadialDamage(center, WPN.c4.force, WPN.c4.radius, WPN.explosionDetachBudget);
      ids.push(c.cid4);
      blasts.push([c.p[0], c.p[1], c.p[2]]);
      this.charges.delete(c.cid4);
    }
    this._broadcast({ t: S2C.C4_BOOM, ids, blasts });
  }

  _onRocket(player, msg) {
    const p = arr3(msg.p), dir = arr3(msg.dir);
    if (!p || !dir) return;
    this._broadcast({ t: S2C.ROCKET, rid: msg.rid | 0, pid: player.pid, p: packP(p), dir: packP(dir) }, player.pid);
  }

  _onRocketEnd(player, msg) {
    const p = arr3(msg.p);
    if (!p) return;
    this._broadcast({ t: S2C.ROCKET_END, rid: msg.rid | 0, pid: player.pid, p: packP(p) }, player.pid);
  }

  _onFx(player, msg) {
    const p = arr3(msg.p);
    if (!p || typeof msg.kind !== "string") return;
    this._broadcast({ t: S2C.FX, kind: msg.kind, pid: player.pid, p: packP(p) }, player.pid);
  }

  _onReset(player, msg) {
    // Foam blobs are transient world geometry, exactly like placed C4: solo's reset drops them through
    // weapons._clearBuilders(), and every replica runs that same path off the broadcast `reset` below. The
    // server has to drop its own or it would keep volumes the clients no longer have. No foam_rm is sent —
    // `reset` already means "clear the builders" on both sides, and the index slots stay reserved.
    for (const rec of this.foamRecs) { if (!rec.rm) { rec.rm = true; this.destruction.despawnVolume(rec.vol); } }
    this.destruction.resetAll();
    this.charges.clear();
    // Phase 8: a reset is "clear the transient world", so the same things solo's weapons.resetTransient()
    // drops go here — live tanks, deployed RC cars, painted sets and any strike still in the air.
    for (const pr of [...this.props.values()]) this._removeProp(pr, false);
    for (const pl of this.players.values()) {
      this._releaseGrav(pl);
      if (pl.rcVid != null) this._endRc(pl);
      if (pl.painted.size) { pl.painted.clear(); this._broadcast({ t: S2C.PAINT_CLR, pid: pl.pid }); }
      pl.airRunning = false;
    }
    this.airRuns.length = 0;
    this.airDrops.length = 0;
    this._clusters.length = 0;
    this._detachOut.length = 0;
    this._debrisRmOut.length = 0;
    // The rebuilt chunk bodies materialise on top of whoever is standing in the crater they just made.
    // Rapier resolves that overlap with a penetration-recovery force in the tens of thousands, which
    // drainContacts cannot tell apart from a real hit — so the building explodes again the instant it
    // comes back, and that player reports "the reset did nothing for me" while everyone standing clear
    // sees a clean map. Suppress contact-driven detach until the solver has pushed everyone out; the
    // clients' own replicas do the same eject locally, so it resolves in a handful of frames.
    this._settleT = NET_TUNING.resetSettleSec;
    this._auditT = 0; // audit on the very next step, once the narrow phase has seen the new bodies
    this._broadcast({ t: S2C.RESET, by: player.pid });
    this.log.log(`[session] reset by pid ${player.pid}`);
  }

  // ---- Disconnect ---------------------------------------------------------------------------

  handleClose(conn) {
    const pid = conn.pid;
    if (pid == null) return;
    const player = this.players.get(pid);
    if (!player) return;
    if (player.seatVid != null) {
      const rec = this.vehicles.get(player.seatVid);
      if (rec) { rec.driverPid = null; rec.netInput.clear(); }
      this._broadcast({ t: S2C.SEAT, vid: player.seatVid, pid: 0 });
    }
    if (player.spawnedVid != null) this._removeVehicle(player.spawnedVid);
    for (const [cid4, c] of this.charges) if (c.owner === pid) this.charges.delete(cid4);
    // Phase 8: everything this player owned goes with them — the RC car, their tanks, their painted set,
    // their grab and any strike still in the air (its bombs keep falling; only the plane state is theirs).
    this._releaseGrav(player);
    if (player.rcVid != null) this._endRc(player);
    for (const pr of [...this.props.values()]) if (pr.owner === pid) this._removeProp(pr, false);
    if (player.painted.size) { player.painted.clear(); this._broadcast({ t: S2C.PAINT_CLR, pid }); }
    this.airRuns = this.airRuns.filter((r) => r.pid !== pid);
    if (player.body) {
      for (let i = 0; i < player.body.numColliders(); i++) this._capsuleHandles.delete(player.body.collider(i).handle);
      try { this.world.removeRigidBody(player.body); } catch (e) {}
    }
    this.players.delete(pid);
    this._usedPids.delete(pid);
    this._broadcast({ t: S2C.LEAVE, pid });
    this.log.log(`[session] player ${pid} left (${this.players.size}/${CAPS.maxPlayers})`);
    if (this.players.size === 0) this.teardown();
  }

  // ---- Fixed-step simulation ---------------------------------------------------------------

  step(dt) {
    if (!this.built) return;
    // Velocity-track each walking player's capsule toward its reported transform (>30 m = snap+log).
    for (const player of this.players.values()) {
      if (!player.body || !player.body.isEnabled() || !player.targetP) continue;
      const cur = player.body.translation();
      const dx = player.targetP.x - cur.x, dy = player.targetP.y - cur.y, dz = player.targetP.z - cur.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > CAPS.stateTeleportMax) {
        player.body.setTranslation({ x: player.targetP.x, y: player.targetP.y, z: player.targetP.z }, true);
        player.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        this.log.log(`[session] pid ${player.pid} teleport clamp (${dist.toFixed(1)} m)`);
      } else {
        player.body.setLinvel({ x: dx / dt, y: dy / dt, z: dz / dt }, true);
      }
    }
    // Run every vehicle controller with its driver's input (or neutral) — same class as the client.
    for (const rec of this.vehicles.values()) {
      const driving = rec.driverPid != null;
      rec.v.update(dt, driving ? rec.netInput : this._neutral, driving);
    }
    // Phase 8: continuous Grab & Force intents, scripted airstrike passes and prop bookkeeping all run
    // BEFORE the solver, so their impulses land in this step rather than a frame late.
    this._applyActs(dt);
    this._stepAirRuns(dt);
    this.world.step(this.eventQueue);
    this._stepProps(dt);
    // Post-reset settle window: swallow this step's contacts instead of detaching on them (see _onReset).
    // The EventQueue was built with autoDrain, so skipping the drain leaks nothing.
    if (this._settleT > 0) this._settleT -= dt;
    // Keep the buried-impactor quarantine current while a reset settles or anyone is still embedded.
    if (this._settleT > 0 || this._buried.size) {
      this._auditT -= dt;
      if (this._auditT <= 0) { this._auditT = NET_TUNING.buriedAuditSec; this._auditBuried(); }
    }
    if (this._settleT <= 0) this.destruction.drainContacts(this.eventQueue); // fires onDetach -> _detachOut
    this.destruction.update(dt);                     // sleep bookkeeping + cull -> onDebrisRemove

    if (this._detachOut.length) { this._broadcast({ t: S2C.DETACH, events: this._detachOut.slice() }); this._detachOut.length = 0; }
    if (this._debrisRmOut.length) { this._broadcast({ t: S2C.DEBRIS_RM, items: this._debrisRmOut.slice() }); this._debrisRmOut.length = 0; }
    for (const m of this._propRmOut) this._broadcast(m);
    this._propRmOut.length = 0;
  }

  // ---- Broadcast builders (called by server.js timers) --------------------------------------

  broadcastPState() {
    if (this.players.size === 0) return;
    const entries = [...this.players.values()];
    for (const recip of entries) {
      const list = [];
      for (const p of entries) {
        if (p.pid === recip.pid) continue;
        const s = p.lastState;
        const e = { pid: p.pid, p: s.p, yaw: round3(s.yaw), pitch: round3(s.pitch), v: s.v, tool: s.tool, seat: s.seat };
        // Phase 8: relay the live Grab & Force intent so peers can draw the grapple rope and show the
        // magnet/vacuum/gravity state. Additive field on an existing message; absent when idle.
        if (p.act) e.act = p.act;
        list.push(e);
      }
      recip.conn.send({ t: S2C.PSTATE, players: list });
    }
  }

  broadcastVState() {
    if (this.players.size === 0) return;
    if (this.vehicles.size === 0 && this.props.size === 0) return;
    const list = [];
    for (const rec of this.vehicles.values()) {
      const v = rec.v;
      const pos = v.centerWorld();
      const q = v.quaternion();
      const lv = v.body.linvel();
      const av = v.body.angvel();
      list.push({ vid: rec.vid, p: packP(pos), q: packQ(q), v: packP(lv), av: packP(av), steer: round3(v.steer || 0) });
    }
    const msg = { t: S2C.VSTATE, vehicles: list };
    // Phase 8: networked props (propane tanks) ride the vehicle channel rather than getting a new one —
    // same 20 Hz, same coalescing rules, and vstate is already the "server-owned rigid bodies" stream.
    if (this.props.size) msg.props = this._packProps();
    this._broadcast(msg);
  }

  _packProps() {
    const out = [];
    for (const pr of this.props.values()) {
      if (pr.dead) continue;
      const t = pr.body.translation(), r = pr.body.rotation();
      out.push([pr.id, round2(t.x), round2(t.y), round2(t.z), round3(r.x), round3(r.y), round3(r.z), round3(r.w), round3(pr.scale)]);
    }
    return out;
  }

  broadcastDebris() {
    if (this.players.size === 0) return;
    const items = this.destruction.collectDebris();
    if (items.length) this._broadcast({ t: S2C.DEBRIS, items });
  }

  // ---- Snapshot (§7) ------------------------------------------------------------------------

  _snapshot() {
    const d = this.destruction.snapshot();
    const vehicles = [];
    for (const rec of this.vehicles.values()) {
      const v = rec.v;
      vehicles.push({
        vid: rec.vid, id: rec.id, owner: rec.ownerPid,
        p: packP(v.centerWorld()), q: packQ(v.quaternion()),
        v: packP(v.body.linvel()), av: packP(v.body.angvel()),
      });
    }
    const seats = [];
    for (const rec of this.vehicles.values()) if (rec.driverPid != null) seats.push([rec.vid, rec.driverPid]);
    const charges = [...this.charges.values()].map((c) => ({ cid4: c.cid4, owner: c.owner, p: c.p, q: c.q, vid: c.vid }));
    // Foam volumes, in index order. Evicted ones travel as bare `{ v, rm:1 }` markers: the joiner does not
    // need their geometry, only their SLOT, so that every live foam volume ends up at the same index it has
    // on the server and on everyone already in the game.
    const foam = this.foamRecs.map((r) => (r.rm ? { v: r.volIdx, rm: 1 } : { v: r.volIdx, o: r.o, d: r.d, bits: r.bits }));
    // Phase 8: live props and everyone's painted sets, so a late joiner sees the tanks lying around and the
    // splats already sprayed instead of being surprised when a blast comes out of a wall that looks clean.
    const props = [];
    for (const pr of this.props.values()) {
      if (pr.dead) continue;
      props.push({ id: pr.id, owner: pr.owner, p: packP(pr.body.translation()), q: packQ(pr.body.rotation()), s: round3(pr.scale) });
    }
    const painted = [];
    for (const pl of this.players.values()) for (const key of pl.painted) {
      const i = key.indexOf(":");
      painted.push([pl.pid, +key.slice(0, i), +key.slice(i + 1)]);
    }
    return { detached: d.detached, debris: d.debris, vehicles, seats, charges, foam, props, painted };
  }

  // ---- Helpers ------------------------------------------------------------------------------

  _makeCapsule(spawn) {
    const RAPIER = this.RAPIER;
    const feetY = CONFIG.world.skinThickness;
    const cy = feetY + CAP_CENTER;
    const gravScale = (9.81 + P.extraGravityAccel) / 9.81;
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, cy, spawn.z)
      .lockRotations()
      .setLinearDamping(0.05)
      .setGravityScale(gravScale)
      .setCanSleep(false);
    const body = this.world.createRigidBody(bodyDesc);
    const density = P.mass / (Math.PI * P.radius * P.radius * (P.halfHeight * 2 + P.radius * 4 / 3));
    const colDesc = RAPIER.ColliderDesc.capsule(P.halfHeight, P.radius)
      .setFriction(0.0).setRestitution(0.0).setDensity(density)
      .setCollisionGroups(CAPSULE_GROUPS);
    const collider = this.world.createCollider(colDesc, body);
    this.destruction.registerImpactor(collider.handle);
    this._capsuleHandles.add(collider.handle); // see _notCapsule: falling ordnance must ignore capsules
    return body;
  }

  _applyVehicleGroups(v) {
    for (const h of v.colliderHandles) {
      const col = this.world.getCollider(h);
      if (col) col.setCollisionGroups(VEHICLE_GROUPS);
    }
  }

  _removeVehicle(vid) {
    const rec = this.vehicles.get(vid);
    if (!rec) return;
    // Vacate any driver.
    if (rec.driverPid != null) {
      const drv = this.players.get(rec.driverPid);
      if (drv) { drv.seatVid = null; if (drv.body) drv.body.setEnabled(true); }
    }
    // Detach any charges stuck to it back into the world (keep them detonatable).
    for (const c of this.charges.values()) if (c.vid === vid) c.vid = -1;
    for (const h of rec.v.colliderHandles) { this.manager.byHandle.delete(h); this.destruction.unregisterImpactor(h); }
    this.manager.all = this.manager.all.filter((x) => x !== rec.v);
    if (this.manager.spawned === rec.v) this.manager.spawned = null;
    rec.v.despawn();
    this.vehicles.delete(vid);
    // Clear the owning player's pointer.
    for (const pl of this.players.values()) {
      if (pl.spawnedVid === vid) pl.spawnedVid = null;
      if (pl.rcVid === vid) pl.rcVid = null;
      if (pl.grav && pl.grav.vid === vid) this._releaseGrav(pl);
    }
    this._broadcast({ t: S2C.VEH_RM, vid });
  }

  // ---- Buried-impactor quarantine (post-reset) ----------------------------------------------
  // A player capsule that a rebuilt chunk materialised around is NOT hitting that chunk — the
  // solver is pushing it out, and the recovery force (tens of thousands of newtons) is indistinguishable
  // from a real impact inside drainContacts. While an impactor is embedded it is dropped from the
  // detach-impactor set, so the map it is standing in stays intact; it is restored, with its original
  // heavy flag, as soon as it is free. Weapon damage intents never route through impactors and so are
  // untouched. The candidate list is rebuilt every audit, which also makes it immune to Rapier
  // recycling a collider handle after a despawn.
  _auditBuried() {
    const d = this.destruction;
    if (!d) { this._buried.clear(); return; }
    const seen = new Set();
    const visit = (col) => {
      if (!col) return;
      const h = col.handle;
      seen.add(h);
      const rec = this._buried.get(h);
      if (!rec && !d.allowedImpactors.has(h)) return; // not an impactor at all (decor, static)
      const depth = this._chunkPenetration(col);
      if (!rec) {
        if (depth < -NET_TUNING.buriedDepthM) {
          this._buried.set(h, { heavy: d.heavyImpactors.has(h), clean: 0 });
          d.unregisterImpactor(h);
        }
        return;
      }
      // Quarantined: release only after a sustained run of contact-free audits (hysteresis — a wedged
      // capsule jitters and reads 0.000 on individual frames while still very much stuck in the wall).
      rec.clean = depth < -NET_TUNING.buriedClearDepthM ? 0 : rec.clean + 1;
      if (rec.clean >= NET_TUNING.buriedClearAudits) {
        this._buried.delete(h);
        d.registerImpactor(h, rec.heavy);
      }
    };
    // Player capsules only. Vehicles are deliberately left alone: ramming through a building is the
    // whole point of a vehicle, and a heavy impactor legitimately reads as deeply penetrating mid-ram —
    // quarantining one would break the core mechanic to fix a much rarer problem.
    // Disabled capsules (seated drivers) are visited too, not skipped: their collider still exists, it
    // touches nothing, so it clears the quarantine instead of being forgotten while unregistered.
    for (const player of this.players.values()) {
      const body = player.body;
      if (!body) continue;
      const n = body.numColliders();
      for (let i = 0; i < n; i++) visit(body.collider(i));
    }
    // Anything quarantined that is no longer a live candidate (left / despawned) is simply forgotten —
    // never re-registered, so a recycled handle can't be promoted into an impactor by accident.
    for (const h of [...this._buried.keys()]) if (!seen.has(h)) this._buried.delete(h);
  }

  // Deepest penetration (metres, negative = inside) of `col` into any live (still-attached) chunk.
  // 0 when it is touching nothing destructible.
  _chunkPenetration(col) {
    let deepest = 0;
    try {
      this.world.contactPairsWith(col, (other) => {
        if (!other) return;
        if (!this.destruction.registry.has(other.handle)) return; // only live chunk colliders count
        const c = col.contactCollider(other, 0);
        if (c && c.distance < deepest) deepest = c.distance;
      });
    } catch (e) { return 0; }
    return deepest;
  }

  // Map-AABB test plus a "near the sender" test. `withinM` defaults to the point/radial cap so every
  // pre-existing caller keeps its exact behaviour; the batch-D tools pass their own (looser) ceiling
  // because a designated strike or a rebuild aim point legitimately sits further out than 20 m.
  _posValid(pos, senderP, withinM = CAPS.dmgWithinSenderM) {
    const m = this.map.size;
    const margin = 20;
    if (Math.abs(pos[0]) > m.x / 2 + margin || Math.abs(pos[2]) > m.z / 2 + margin) return false;
    if (pos[1] < -10 || pos[1] > 300) return false;
    if (senderP) {
      const dx = pos[0] - senderP[0], dy = pos[1] - senderP[1], dz = pos[2] - senderP[2];
      if (dx * dx + dy * dy + dz * dz > withinM * withinM) return false;
    }
    return true;
  }

  _broadcast(obj, exceptPid = null) {
    for (const p of this.players.values()) {
      if (exceptPid != null && p.pid === exceptPid) continue;
      p.conn.send(obj);
    }
  }

  _time() { return (this.destruction ? this.destruction._time : 0); }

  _reportLoad() {
    const s = this.destruction.stats;
    const l = this.log;
    l.log(`===== [QA] Server sim built: ${this.mapId} (${this.map.name}) =====`);
    l.log(`  size ${this.map.size.x}x${this.map.size.z} m · volumes ${this.map.volumes.length}`);
    l.log(`  chunks total ${s.chunks} (grid ${s.chunksGrid}, structure ${s.chunksStructure}) — gate <= 2500`);
    l.log(`  chunk colliders: cuboid ${s.collidersCuboid}, hull ${s.collidersHull}`);
    l.log(`  dynamic bodies at load: 1 (permanent hatchback); capsules/vehicles added per player`);
    if (s.chunks > 2500) l.warn(`  WARNING: chunk total ${s.chunks} exceeds the 2500 gate`);
    l.log(`===================================================`);
  }
}

// ---- Pure helpers -----------------------------------------------------------------------------
function sanitizeNick(n) {
  let s = typeof n === "string" ? n.trim().slice(0, CAPS.nickMaxLen) : "";
  if (!s) s = "Player";
  return s;
}
// Phase 7: validate + clamp a per-material multiplier table from a client dmg intent. Each factor is
// clamped to (0, CAPS.dmgMultMax]; anything malformed is dropped. Returns { mult } opts or undefined.
function sanitizeMult(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  let any = false;
  for (const k of ["wood", "concrete", "metal", "dirt", "foam"]) {
    const v = raw[k];
    if (Number.isFinite(v) && v > 0) { out[k] = Math.min(v, CAPS.dmgMultMax); any = true; }
  }
  return any ? { mult: out } : undefined;
}
// Phase 8: validate the optional `act` rider on a state upload. A whitelist, not a clamp table — the act
// carries no magnitudes, only a tool code, a mode and (for the ropes) an anchor / chunk reference.
function sanitizeAct(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!ACT_SET.has(raw.k)) return null;
  const out = { k: raw.k, m: raw.m === 2 ? 2 : 1 };
  const a = arr3(raw.a);
  if (a) out.a = [round2(a[0]), round2(a[1]), round2(a[2])];
  if (Array.isArray(raw.r) && Number.isFinite(raw.r[0]) && Number.isFinite(raw.r[1])) out.r = [raw.r[0] | 0, raw.r[1] | 0];
  return out;
}
// Finite, strictly positive, clamped to `max`. Returns 0 for anything unusable so callers can reject with
// one falsy test instead of four.
function clampPos(v, max) { return Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0; }
function num(v) { return Number.isFinite(v) ? v : 0; }
function round2(v) { return Math.round(num(v) * 100) / 100; }
function round3(v) { return Math.round(num(v) * 1000) / 1000; }
function arr3(v) { return Array.isArray(v) && v.length >= 3 && v.every(Number.isFinite) ? [v[0], v[1], v[2]] : null; }
// Integer triple (foam lattice cells / grid dims). Rejects floats outright rather than truncating, so a
// malformed grid can never quietly become a different — but valid-looking — one on the server.
function arr3int(v) {
  if (!Array.isArray(v) || v.length < 3) return null;
  for (let i = 0; i < 3; i++) if (!Number.isInteger(v[i])) return null;
  return [v[0], v[1], v[2]];
}
function arr4(v) { return Array.isArray(v) && v.length >= 4 && v.every(Number.isFinite) ? [v[0], v[1], v[2], v[3]] : null; }
