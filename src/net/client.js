// client.js - WebSocket lifecycle + offline fallback + dispatch + send helpers + upload timers.
// Boots at lobby load: ?solo=1 goes offline immediately; otherwise it dials ws://<location.host> and
// falls back to OFFLINE (exact Phase 5 single-player) after a 2 s timeout or any error. On success it
// surfaces the server's `session` push (drives lobby card state), sends `hello` on PLAY, and — once in
// game — uploads player state at 20 Hz and driving input at 30 Hz. Everything the server sends between
// `hello` and flushPending() is QUEUED, not dropped: startGame() spends seconds building the map
// before Replication.register() exists, and joins/detaches lost in that window never come back.
import {
  PROTOCOL_VERSION, C2S, S2C, INTERVALS, COALESCING_TYPES, NET_TUNING,
  packP, packV, packQ, packInput, q2, q3,
} from "./protocol.js";

const CONNECT_TIMEOUT_MS = 2000;
// Lifecycle messages the boot path already listens for before the game exists — never queued.
// HOLD belongs here for the same reason FULL does: it is answered by beginPlay() before startGame() has
// run, so queueing it would hide it behind the very map build it exists to announce.
const LIFECYCLE_TYPES = new Set([S2C.WELCOME, S2C.SESSION, S2C.FULL, S2C.HOLD]);
const COALESCE = new Set(COALESCING_TYPES);

export class NetClient {
  constructor({ solo = false } = {}) {
    this.solo = solo;
    this.state = "idle";       // idle | connecting | online | offline
    this.ws = null;
    this.pid = null;
    this.mapId = null;
    this.session = null;       // last { active, mapId, count } from a session push

    this.handlers = new Map(); // type -> fn(msg)
    this.stateProvider = null; // () -> { p, yaw, pitch, v, tool, seat } | null
    this.inputProvider = null; // () -> { vid, x, z, sp, sh, kq, ke } | null
    // Phase 8: the Grab & Force intent rides on the 20 Hz `state` upload rather than getting a channel of
    // its own (state already carries the aim ray as yaw/pitch). Weapons installs this provider on itself
    // when it is constructed with a net handle, so main.js's stateProvider needs no knowledge of it.
    this.actProvider = null;   // () -> { k, m, a?, r? } | null
    this.rcInputProvider = null; // () -> { vid, x, z, sp, sh, kq, ke } | null  (RC Car Bomb, see below)

    // Lifecycle callbacks the lobby / main.js hook into.
    this.onSession = null;     // (session) - server pushed session state (pre-hello)
    this.onOffline = null;     // (reason)  - fell back to single-player
    this.onOnline = null;      // ()        - ws opened
    this.onClose = null;       // ()        - ws closed after being online

    this._openTimer = null;
    this._stateTimer = null;
    this._inputTimer = null;
    this._drivingVid = null;

    // Backlog of game messages received while the game world is still being built (see flushPending).
    this._pending = [];
    this._buffering = false;
    this._pendingOverflow = 0;
  }

  get online() { return this.state === "online"; }
  get offline() { return this.state === "offline"; }

  // Resolves once the connection has settled (online OR offline) — lets the ?quick=1 path and PLAY wait
  // for the 2 s dial to finish instead of racing it.
  whenReady() {
    if (this.state === "online" || this.state === "offline") return Promise.resolve();
    if (!this._readyP) this._readyP = new Promise((res) => { this._readyResolve = res; });
    return this._readyP;
  }
  _resolveReady() { if (this._readyResolve) { this._readyResolve(); this._readyResolve = null; } }

  on(type, fn) { this.handlers.set(type, fn); return this; }

  // Dial the LAN server. Called once when the lobby loads (or before ?quick=1 start).
  connect() {
    if (this.solo) { this._goOffline("solo"); return; }
    if (this.state !== "idle") return;
    this.state = "connecting";
    let ws;
    try {
      ws = new WebSocket(`ws://${location.host}`);
    } catch (e) {
      this._goOffline("error");
      return;
    }
    this.ws = ws;
    this._openTimer = setTimeout(() => {
      if (this.state !== "online") { try { ws.close(); } catch (e) {} this._goOffline("timeout"); }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.state === "offline") { try { ws.close(); } catch (e) {} return; }
      clearTimeout(this._openTimer);
      this.state = "online";
      this._resolveReady();
      if (this.onOnline) this.onOnline();
    };
    ws.onmessage = (ev) => this._recv(ev.data);
    ws.onerror = () => { if (this.state !== "online") this._goOffline("error"); };
    ws.onclose = () => {
      clearTimeout(this._openTimer);
      if (this.state === "connecting") { this._goOffline("closed"); return; }
      if (this.state === "online") {
        this.state = "offline";
        this._stopTimers();
        if (this.onClose) this.onClose();
      }
    };
  }

  _goOffline(reason) {
    if (this.state === "offline") return;
    this.state = "offline";
    this._stopTimers();
    this.ws = null;
    this._resolveReady();
    if (this.onOffline) this.onOffline(reason);
  }

  _recv(data) {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (!msg || typeof msg.t !== "string") return;
    // Track identity from the two lifecycle messages before dispatching.
    if (msg.t === S2C.WELCOME) { this.pid = msg.pid; this.mapId = msg.mapId; }
    else if (msg.t === S2C.SESSION) { this.session = { active: !!msg.active, mapId: msg.mapId, count: msg.count | 0 }; if (this.onSession) this.onSession(this.session); }
    // Queue anything the game itself owns until its handlers are wired (flushPending). Without this,
    // every join / detach / seat / reset that lands during the multi-second map build is discarded.
    if (this._buffering && !LIFECYCLE_TYPES.has(msg.t)) {
      if (this._pending.length < NET_TUNING.maxPendingMessages) this._pending.push(msg);
      else this._pendingOverflow++;
      return;
    }
    this._dispatch(msg);
  }

  _dispatch(msg) {
    const h = this.handlers.get(msg.t);
    if (h) h(msg);
  }

  // Replay everything queued since `hello` and go live. Called once by main.js after Replication has
  // registered its handlers AND the welcome snapshot has been applied, so the backlog lands on top of
  // the correct base state. Pure snapshot types keep only their newest entry (a 5 s backlog of 20 Hz
  // pstates would otherwise stuff the interpolation buffers with 100 samples sharing one timestamp);
  // event types replay in full, in arrival order.
  flushPending() {
    this._buffering = false;
    const q = this._pending;
    this._pending = [];
    if (!q.length) return 0;
    const lastOf = new Map();
    for (let i = 0; i < q.length; i++) if (COALESCE.has(q[i].t)) lastOf.set(q[i].t, i);
    let replayed = 0;
    for (let i = 0; i < q.length; i++) {
      const m = q[i];
      if (COALESCE.has(m.t) && lastOf.get(m.t) !== i) continue;
      this._dispatch(m);
      replayed++;
    }
    if (this._pendingOverflow) {
      console.warn(`[net] dropped ${this._pendingOverflow} queued messages (backlog cap) — expect a desync`);
      this._pendingOverflow = 0;
    }
    console.log(`[net] replayed ${replayed}/${q.length} messages queued during the map build`);
    return replayed;
  }

  _send(obj) {
    if (this.state !== "online" || !this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  // --- Send helpers (client -> server) -------------------------------------------------------
  // From here on the server may send game traffic at any moment, but the game (and its handlers) does
  // not exist yet — start queueing until flushPending().
  sendHello(nick, avatar, wantMap) {
    const ok = this._send({ t: C2S.HELLO, ver: PROTOCOL_VERSION, nick, avatar, wantMap });
    if (ok) { this._pending.length = 0; this._pendingOverflow = 0; this._buffering = true; }
    return ok;
  }
  sendMapCheck(counts) { return this._send({ t: C2S.MAP_CHECK, counts }); }
  sendState(s) {
    const m = {
      t: C2S.STATE, p: packP(s.p), yaw: s.yaw, pitch: s.pitch, v: packV(s.v),
      tool: s.tool ?? null, seat: s.seat ?? null,
    };
    if (this.actProvider) {
      const a = this.actProvider();
      if (a) m.act = a;
    }
    return this._send(m);
  }
  sendInput(vid, ax, az, sp, sh, kq, ke) {
    return this._send({ t: C2S.INPUT, ...packInput(vid, ax, az, sp, sh, kq, ke) });
  }
  sendEnterVeh(vid) { return this._send({ t: C2S.ENTER_VEH, vid }); }
  sendExitVeh(vid, p) { return this._send({ t: C2S.EXIT_VEH, vid, p: packP(p) }); }
  sendSpawnVeh(id, yaw) { return this._send({ t: C2S.SPAWN_VEH, id, yaw }); }
  // Generic dmg pass-through from replica-mode destruction. Normalizes the intent's Vector3 position
  // (src / p) into a quantized [x,y,z] array to match the wire convention.
  sendDmg(intent) {
    if (intent.kind === "point") {
      const m = { t: C2S.DMG, kind: "point", vol: intent.vol, cid: intent.cid, src: packP(intent.src), force: intent.force };
      if (intent.mult) m.mult = intent.mult; // Phase 7: per-material multiplier table (server clamps each ≤ dmgMultMax)
      return this._send(m);
    }
    if (intent.kind === "carve") {
      // Orbital Laser / airstrike Penetrator / Car Cannon: one authoritative carveCylinder on the server.
      // dir is a unit vector, so 3 dp (packQ's precision) is plenty and keeps the beam straight.
      return this._send({
        t: C2S.DMG, kind: "carve", p: packP(intent.p),
        dir: [q3(intent.dir.x), q3(intent.dir.y), q3(intent.dir.z)],
        len: q2(intent.len), radius: q2(intent.radius), force: intent.force, budget: intent.budget | 0,
      });
    }
    const m = { t: C2S.DMG, kind: "radial", p: packP(intent.p), force: intent.force, radius: intent.radius };
    if (intent.mult) m.mult = intent.mult;
    return this._send(m);
  }
  sendDmgPoint(vol, cid, src, force) { return this._send({ t: C2S.DMG, kind: "point", vol, cid, src: packP(src), force }); }
  sendDmgRadial(p, force, radius) { return this._send({ t: C2S.DMG, kind: "radial", p: packP(p), force, radius }); }
  sendC4Place(p, q, vid) { return this._send({ t: C2S.C4_PLACE, p: packP(p), q: packQ(q), vid: vid ?? -1 }); }
  sendC4Det() { return this._send({ t: C2S.C4_DET }); }
  sendRocket(rid, p, dir) { return this._send({ t: C2S.ROCKET, rid, p: packP(p), dir: packP(dir) }); }
  sendRocketEnd(rid, p) { return this._send({ t: C2S.ROCKET_END, rid, p: packP(p) }); }
  sendFx(kind, p) { return this._send({ t: C2S.FX, kind, p: packP(p) }); }
  sendReset() { return this._send({ t: C2S.RESET }); }
  // --- Phase 7 batch D builders (server-authoritative; see protocol.js CAPS) -------------------
  // Foam: `o` is the blob's min lattice cell, `d` its cell dims, `bits` the packed occupancy bitmap.
  // The server creates the volume and echoes it back as foam_add with the index it landed on.
  sendFoam(o, d, bits) { return this._send({ t: C2S.FOAM, o, d, bits }); }
  sendZap(vol, cid, grow) { return this._send({ t: C2S.ZAP, vol, cid, g: grow ? 1 : 0 }); }
  sendZapProp(id, grow) { return this._send({ t: C2S.ZAP, prop: id | 0, g: grow ? 1 : 0 }); }
  sendRebuild(p) { return this._send({ t: C2S.REBUILD, p: packP(p) }); }

  // --- Phase 8 send helpers -------------------------------------------------------------------
  // One-shot Grab & Force impulses. `k` names the effect; the server owns every number behind it.
  sendForce(k, dir) { return this._send({ t: C2S.FORCE, k, d: [q3(dir.x), q3(dir.y), q3(dir.z)] }); }
  // Airstrike designation. `d` is the horizontal run heading this client's plane will fly, echoed to
  // every peer so the scripted pass looks the same everywhere.
  sendAir(p, ammo, dir) {
    return this._send({ t: C2S.AIR, p: packP(p), a: ammo | 0, d: [q3(dir.x), q3(dir.y), q3(dir.z)] });
  }
  sendPaint(vol, cid) { return this._send({ t: C2S.PAINT, vol: vol | 0, cid: cid | 0 }); }
  sendPaintDet() { return this._send({ t: C2S.PAINT_DET }); }
  sendProp(p, dir) { return this._send({ t: C2S.PROP, p: packP(p), d: packP(dir) }); }
  sendRc(a) { return this._send({ t: C2S.RC, a }); }
  // Projectile visual relay: pipe / sticky / cluster. Damage still travels as an ordinary dmg intent.
  sendProj(id, k, p, v, seed) {
    return this._send({ t: C2S.PROJ, id: id | 0, k, p: packP(p), v: packP(v), seed: seed >>> 0 });
  }
  sendProjEnd(id, p) { return this._send({ t: C2S.PROJ_END, id: id | 0, p: packP(p) }); }

  // --- Upload timers -------------------------------------------------------------------------
  // Start the 20 Hz state upload once the game world exists. stateProvider must be set first.
  startGameTimers() {
    if (this._stateTimer) return;
    this._stateTimer = setInterval(() => {
      if (this.state !== "online" || !this.stateProvider) return;
      const s = this.stateProvider();
      if (s) this.sendState(s);
    }, INTERVALS.clientState);
  }

  // Toggle the 30 Hz driving-input upload. vid !== null starts it; null stops it.
  setDriving(vid) {
    this._drivingVid = vid;
    if (vid != null && !this._inputTimer) {
      this._inputTimer = setInterval(() => {
        if (this.state !== "online" || this._drivingVid == null) return;
        // The RC Car Bomb reuses this channel: it is a server-owned vehicle steered by a player who is
        // still on foot, so main.js's driving provider (which only speaks while mode === "drive") returns
        // null for it. Weapons installs its own provider instead of overwriting that one.
        const i = (this.rcInputProvider && this.rcInputProvider()) || (this.inputProvider && this.inputProvider());
        if (i) this.sendInput(i.vid, i.x, i.z, i.sp, i.sh, i.kq, i.ke);
      }, INTERVALS.clientInput);
    } else if (vid == null && this._inputTimer) {
      clearInterval(this._inputTimer);
      this._inputTimer = null;
    }
  }

  _stopTimers() {
    if (this._stateTimer) { clearInterval(this._stateTimer); this._stateTimer = null; }
    if (this._inputTimer) { clearInterval(this._inputTimer); this._inputTimer = null; }
    this._drivingVid = null;
  }

  // An explicitly closed client must never still report `online`: beginPlay()'s welcome-timeout path
  // calls close() and then starts the game synchronously, and a lingering "online" would boot the whole
  // session in replica mode against a dead socket (nothing destructible, no remotes, reset does nothing).
  // State is set directly rather than via _goOffline so the lobby's onOffline banner does not fire on
  // a deliberate teardown.
  close() {
    this._stopTimers();
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
    this.ws = null;
    this.state = "offline";
    this._buffering = false;
    this._pending.length = 0;
    this._pendingOverflow = 0;
    this._resolveReady();
  }
}
