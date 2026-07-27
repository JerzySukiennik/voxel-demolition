// session.js - one authoritative headless game: map, player capsules, vehicles, destruction, charges, intents
import * as THREE from "three";
import { CONFIG } from "../src/config.js";
import { getMap } from "../src/maps/index.js";
import { makeMaterials } from "../src/voxel.js";
import { createCore, createWater, buildStaticGeo, resolveEnv } from "../src/world.js";
import { Destruction, foamVolumeSpec } from "../src/destruction.js";
import { VehicleManager } from "../src/vehicles/manager.js";
import { VEHICLE_SPECS, resolveTuning } from "../src/vehicles/registry.js";
import { sanitizeAvatar } from "../src/avatar.js";
import { NetInput } from "./net-input.js";
import { C2S, S2C, CAPS, NET_TUNING, packP, packQ, unpackBits, bitAt, countBits } from "../src/net/protocol.js";

const P = CONFIG.player;
const WPN = CONFIG.weapons;
const CAP_CENTER = P.halfHeight + P.radius;

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
  }

  _onInput(player, msg) {
    if (player.seatVid == null) return;
    const rec = this.vehicles.get(msg.vid | 0);
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
    if (player.body) { try { this.world.removeRigidBody(player.body); } catch (e) {} }
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
    this.world.step(this.eventQueue);
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
        list.push({ pid: p.pid, p: s.p, yaw: round3(s.yaw), pitch: round3(s.pitch), v: s.v, tool: s.tool, seat: s.seat });
      }
      recip.conn.send({ t: S2C.PSTATE, players: list });
    }
  }

  broadcastVState() {
    if (this.players.size === 0 || this.vehicles.size === 0) return;
    const list = [];
    for (const rec of this.vehicles.values()) {
      const v = rec.v;
      const pos = v.centerWorld();
      const q = v.quaternion();
      const lv = v.body.linvel();
      const av = v.body.angvel();
      list.push({ vid: rec.vid, p: packP(pos), q: packQ(q), v: packP(lv), av: packP(av), steer: round3(v.steer || 0) });
    }
    this._broadcast({ t: S2C.VSTATE, vehicles: list });
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
    return { detached: d.detached, debris: d.debris, vehicles, seats, charges, foam };
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
    for (const pl of this.players.values()) if (pl.spawnedVid === vid) pl.spawnedVid = null;
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
// Finite, strictly positive, clamped to `max`. Returns 0 for anything unusable so callers can reject with
// one falsy test instead of four.
function clampPos(v, max) { return Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0; }
function num(v) { return Number.isFinite(v) ? v : 0; }
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
