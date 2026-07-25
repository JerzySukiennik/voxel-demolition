// client.js - WebSocket lifecycle + offline fallback + dispatch + send helpers + upload timers.
// Boots at lobby load: ?solo=1 goes offline immediately; otherwise it dials ws://<location.host> and
// falls back to OFFLINE (exact Phase 5 single-player) after a 2 s timeout or any error. On success it
// surfaces the server's `session` push (drives lobby card state), sends `hello` on PLAY, and — once in
// game — uploads player state at 20 Hz and driving input at 30 Hz. Everything the server sends between
// `hello` and flushPending() is QUEUED, not dropped: startGame() spends seconds building the map
// before Replication.register() exists, and joins/detaches lost in that window never come back.
import {
  PROTOCOL_VERSION, C2S, S2C, INTERVALS, COALESCING_TYPES, NET_TUNING,
  packP, packV, packQ, packInput,
} from "./protocol.js";

const CONNECT_TIMEOUT_MS = 2000;
// Lifecycle messages the boot path already listens for before the game exists — never queued.
const LIFECYCLE_TYPES = new Set([S2C.WELCOME, S2C.SESSION, S2C.FULL]);
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
    return this._send({
      t: C2S.STATE, p: packP(s.p), yaw: s.yaw, pitch: s.pitch, v: packV(s.v),
      tool: s.tool ?? null, seat: s.seat ?? null,
    });
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
        if (this.state !== "online" || this._drivingVid == null || !this.inputProvider) return;
        const i = this.inputProvider();
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
