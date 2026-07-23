// protocol.js - FROZEN wire protocol v1 (brief section 5). SHARED by browser client AND Node server.
// DEPENDENCY-FREE: no THREE, no rapier, no DOM. Pure constants + quantizer helpers so the server can
// import it in plain Node. Every message is a JSON object { t: "<type>", ...fields }.

export const PROTOCOL_VERSION = 1;

// --- Message type constants ------------------------------------------------------------------
// Client -> Server.
export const C2S = {
  HELLO: "hello",       // ver, nick, avatar, wantMap        (once, on PLAY)
  MAP_CHECK: "map_check", // counts:[n0,n1,...]               (once after local map build)
  STATE: "state",       // p, yaw, pitch, v, tool, seat       (20 Hz walking/seated)
  INPUT: "input",       // vid, x, z, sp, sh, kq, ke          (30 Hz while driving)
  ENTER_VEH: "enter_veh", // vid                              (E near vehicle)
  EXIT_VEH: "exit_veh",  // vid, p                            (E while driving)
  SPAWN_VEH: "spawn_veh", // id, yaw                          (Tab pick)
  DMG: "dmg",           // {kind:"point",vol,cid,src,force} | {kind:"radial",p,force,radius}
  C4_PLACE: "c4_place", // p, q, vid                          (LMB place)
  C4_DET: "c4_det",     // -                                  (RMB detonate own charges)
  ROCKET: "rocket",     // rid, p, dir                        (launch, visual relay)
  ROCKET_END: "rocket_end", // rid, p                         (hit / lifetime end)
  FX: "fx",             // kind:"swing"|"clang"|"gunshot", p  (fx with no other message)
  RESET: "reset",       // -                                  (ESC Reset)
};

// Server -> Client.
export const S2C = {
  WELCOME: "welcome",   // pid, mapId, snap, players:[{pid,nick,avatar}]
  FULL: "full",         // reason
  SESSION: "session",   // active, mapId, count               (pushed on WS open, pre-hello)
  JOIN: "join",         // pid, nick, avatar
  LEAVE: "leave",       // pid
  PSTATE: "pstate",     // players:[{pid,p,yaw,pitch,v,tool,seat}]  (20 Hz, excludes recipient)
  VSTATE: "vstate",     // vehicles:[{vid,p,q,v,av,steer}]          (20 Hz)
  DETACH: "detach",     // events:[{vol,cid,p,q,f}]
  DEBRIS: "debris",     // items:[[vol,cid,px,py,pz,qx,qy,qz,qw],...]  (10 Hz, awake bodies)
  DEBRIS_RM: "debris_rm", // items:[[vol,cid],...]                    (cap/sleep-cull removal)
  VEH_SPAWN: "veh_spawn", // vid, id, owner, p, yaw
  VEH_RM: "veh_rm",     // vid
  SEAT: "seat",         // vid, pid (0 = vacated)
  C4_ADD: "c4_add",     // cid4, owner, p, q, vid
  C4_BOOM: "c4_boom",   // ids:[cid4...], blasts:[[x,y,z]...]
  ROCKET: "rocket",     // rid, pid, p, dir                   (relay)
  ROCKET_END: "rocket_end", // rid, pid, p                    (relay)
  FX: "fx",             // kind, pid, p                       (relay)
  RESET: "reset",       // by (pid)
  WARN: "warn",         // msg
};

// Flat list of every distinct wire type (rocket/rocket_end/fx/reset are shared C2S<->S2C). Used by the
// self-test assertion script to prove completeness against the brief's section-5 tables.
export const MESSAGE_TYPES = [
  "hello", "map_check", "state", "input", "enter_veh", "exit_veh", "spawn_veh", "dmg",
  "c4_place", "c4_det", "rocket", "rocket_end", "fx", "reset",
  "welcome", "full", "session", "join", "leave", "pstate", "vstate", "detach", "debris",
  "debris_rm", "veh_spawn", "veh_rm", "seat", "c4_add", "c4_boom", "warn",
];

// --- Frozen rates (Hz / ms) ------------------------------------------------------------------
export const RATES = {
  serverHz: 60,        // server physics accumulator
  pstateHz: 20,        // player-state broadcast
  vstateHz: 20,        // vehicle-state broadcast
  debrisHz: 10,        // awake-debris stream
  clientStateHz: 20,   // client player-state upload
  clientInputHz: 30,   // client driving-input upload
  interpMs: 100,       // interpolation buffer depth (remote players, non-driver vehicles, debris)
  pingMs: 10000,       // ws keepalive ping interval
  missedPingsBeforeTerminate: 2,
};

// Derived timer intervals (ms), so client + server agree without recomputing.
export const INTERVALS = {
  clientState: 1000 / RATES.clientStateHz, // 50 ms
  clientInput: 1000 / RATES.clientInputHz, // ~33.3 ms
  pstate: 1000 / RATES.pstateHz,
  vstate: 1000 / RATES.vstateHz,
  debris: 1000 / RATES.debrisHz,
};

// --- Validation caps (server-side, loose; brief section 5 + 10) ------------------------------
export const CAPS = {
  maxPlayers: 4,
  nickMaxLen: 16,
  pointForceMax: 15400,
  radialForceMax: 44000,
  radialRadiusMax: 4.4,
  // Per-player minimum interval between dmg intents, split by kind (Phase 7): point ticks fast enough for
  // the chainsaw hold-fire (0.12 s), radial stays at the Phase 6 rate. Legacy alias kept = radial value.
  dmgMinIntervalSec: 0.15,
  dmgMinIntervalPointSec: 0.1,
  dmgMinIntervalRadialSec: 0.15,
  dmgMultMax: 3.5,           // Phase 7: per-material multiplier is clamped to this ceiling server-side
  dmgWithinSenderM: 20,      // dmg pos must be within this of the sender (+ map AABB)
  c4MaxPerPlayer: 20,
  stateTeleportMax: 30,      // > this per tick => clamp server capsule + log
};

// Reconciliation thresholds for the driver's own vehicle (brief section 1).
export const RECONCILE = {
  ignoreM: 0.15,   // pos error below this: leave prediction alone
  hardSnapM: 3.0,  // pos error above this: snap
  blend: 0.15,     // in the 0.15..3 m band: blend this fraction toward the server pose per snapshot
};

// --- Quantizers (positions 2 dp, quaternions 3 dp; brief section 5) --------------------------
// Kept branch-free and NaN-safe (a NaN survives Math.round; guard so the wire never carries NaN).
export function q2(n) { return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }
export function q3(n) { return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0; }

// Pack a position/velocity {x,y,z} or [x,y,z] into a 2-dp [x,y,z] array.
export function packP(v) {
  if (Array.isArray(v)) return [q2(v[0]), q2(v[1]), q2(v[2])];
  return [q2(v.x), q2(v.y), q2(v.z)];
}
export const packV = packP;

// Pack a quaternion {x,y,z,w} or [x,y,z,w] into a 3-dp [x,y,z,w] array.
export function packQ(q) {
  if (Array.isArray(q)) return [q3(q[0]), q3(q[1]), q3(q[2]), q3(q[3])];
  return [q3(q.x), q3(q.y), q3(q.z), q3(q.w)];
}

// Driving input bitfield helpers (NetInput on the server reads the same 7 fields). Kept as an
// explicit object on the wire (JSON) rather than a packed int for debuggability — the "bitfield"
// framing in the brief is conceptual; each flag is 0/1 and x/z are -1/0/1.
export function packInput(vid, ax, az, sp, sh, kq, ke) {
  return {
    vid: vid | 0,
    x: ax < 0 ? -1 : ax > 0 ? 1 : 0,
    z: az < 0 ? -1 : az > 0 ? 1 : 0,
    sp: sp ? 1 : 0,
    sh: sh ? 1 : 0,
    kq: kq ? 1 : 0,
    ke: ke ? 1 : 0,
  };
}
