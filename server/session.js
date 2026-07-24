// session.js - one authoritative headless game: map, player capsules, vehicles, destruction, charges, intents
import * as THREE from "three";
import { CONFIG } from "../src/config.js";
import { getMap } from "../src/maps/index.js";
import { makeMaterials } from "../src/voxel.js";
import { createCore, createWater, buildStaticGeo, resolveEnv } from "../src/world.js";
import { Destruction } from "../src/destruction.js";
import { VehicleManager } from "../src/vehicles/manager.js";
import { VEHICLE_SPECS, resolveTuning } from "../src/vehicles/registry.js";
import { sanitizeAvatar } from "../src/avatar.js";
import { NetInput } from "./net-input.js";
import { C2S, S2C, CAPS, packP, packQ } from "../src/net/protocol.js";

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
    if (!this.built) this.build(msg && msg.wantMap);
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
      lastDmg: -1e9,
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
    }
  }

  _onMapCheck(player, msg) {
    const got = Array.isArray(msg.counts) ? msg.counts : [];
    const want = this.chunkCounts;
    let mismatch = got.length !== want.length;
    if (!mismatch) for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) { mismatch = true; break; }
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
    }
  }

  _dropDmg(player, why) { this.log.warn(`[session] dropped dmg from pid ${player.pid} (${why})`); }

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
    this.destruction.resetAll();
    this.charges.clear();
    this._detachOut.length = 0;
    this._debrisRmOut.length = 0;
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
    this.destruction.drainContacts(this.eventQueue); // fires onDetach -> _detachOut
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
    return { detached: d.detached, debris: d.debris, vehicles, seats, charges };
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

  _posValid(pos, senderP) {
    const m = this.map.size;
    const margin = 20;
    if (Math.abs(pos[0]) > m.x / 2 + margin || Math.abs(pos[2]) > m.z / 2 + margin) return false;
    if (pos[1] < -10 || pos[1] > 300) return false;
    if (senderP) {
      const dx = pos[0] - senderP[0], dy = pos[1] - senderP[1], dz = pos[2] - senderP[2];
      if (dx * dx + dy * dy + dz * dz > CAPS.dmgWithinSenderM * CAPS.dmgWithinSenderM) return false;
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
function num(v) { return Number.isFinite(v) ? v : 0; }
function round3(v) { return Math.round(num(v) * 1000) / 1000; }
function arr3(v) { return Array.isArray(v) && v.length >= 3 && v.every(Number.isFinite) ? [v[0], v[1], v[2]] : null; }
function arr4(v) { return Array.isArray(v) && v.length >= 4 && v.every(Number.isFinite) ? [v[0], v[1], v[2], v[3]] : null; }
