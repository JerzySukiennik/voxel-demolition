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
  // dmg kinds: {kind:"point",vol,cid,src,force} | {kind:"radial",p,force,radius}
  //          | {kind:"carve",p,dir,len,radius,force,budget}   (Orbital Laser / airstrike Penetrator / Car Cannon)
  DMG: "dmg",
  C4_PLACE: "c4_place", // p, q, vid                          (LMB place)
  C4_DET: "c4_det",     // -                                  (RMB detonate own charges)
  ROCKET: "rocket",     // rid, p, dir                        (launch, visual relay)
  ROCKET_END: "rocket_end", // rid, p                         (hit / lifetime end)
  FX: "fx",             // kind:"swing"|"clang"|"gunshot", p  (fx with no other message)
  RESET: "reset",       // -                                  (ESC Reset)
  FOAM: "foam",         // o:[gx,gy,gz], d:[nx,ny,nz], bits   (hardened foam blob -> server authors the volume)
  ZAP: "zap",           // vol, cid, g                        (Size Ray on a debris chunk; g=1 grow, 0 shrink)
  REBUILD: "rebuild",   // p                                  (Rebuild Gun aim point, sent at the tool's rate)
};

// Server -> Client.
export const S2C = {
  WELCOME: "welcome",   // pid, mapId, snap, players:[{pid,nick,avatar}]
  // Sent the instant a hello is accepted, BEFORE the server builds the map. Building a cold session is
  // seconds of blocking work (town is ~2500 chunks of Voronoi + colliders), and the client used to give
  // up on welcome after 3 s and drop silently into solo — so the FIRST player onto a fresh server always
  // ended up offline, the session emptied, tore down, and the next attempt was cold again. This ack lets
  // the client tell "no server" apart from "server is busy building" and wait as long as the build needs.
  HOLD: "hold",         // mapId, building:true
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
  FOAM_ADD: "foam_add", // vol, o:[gx,gy,gz], d:[nx,ny,nz], bits   (server-assigned volume index — see below)
  FOAM_RM: "foam_rm",   // vol                                     (live-foam cap eviction / reset)
  SCALE: "scale",       // vol, cid, s                             (Size Ray result, one float per body)
  REATTACH: "reattach", // events:[[vol,cid],...]                  (Rebuild Gun — the mirror of `detach`)
};

// Flat list of every distinct wire type (rocket/rocket_end/fx/reset are shared C2S<->S2C). Used by the
// self-test assertion script to prove completeness against the brief's section-5 tables.
export const MESSAGE_TYPES = [
  "hello", "map_check", "state", "input", "enter_veh", "exit_veh", "spawn_veh", "dmg",
  "c4_place", "c4_det", "rocket", "rocket_end", "fx", "reset",
  "welcome", "full", "session", "join", "leave", "pstate", "vstate", "detach", "debris",
  "debris_rm", "veh_spawn", "veh_rm", "seat", "c4_add", "c4_boom", "warn",
  // Phase 7 batch D builders, added without restructuring any existing message.
  "foam", "zap", "rebuild", "foam_add", "foam_rm", "scale", "reattach",
];

// Server->client snapshot types: every message of these types fully supersedes the previous one, so a
// queued backlog only needs its NEWEST entry replayed. Every other type is an event and is replayed in
// full, in arrival order. Used by NetClient.flushPending().
export const COALESCING_TYPES = [S2C.PSTATE, S2C.VSTATE, S2C.DEBRIS];

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

// --- Net-layer tuning (has no home in src/config.js; both the browser client and the Node server
// import this file, and config.js is shared game tuning rather than wire behaviour) ---------------
export const NET_TUNING = {
  // Client: cap on the message backlog queued between `hello` and the game's handler registration.
  // The map build that sits between `welcome` and Replication.register() takes seconds on a cold
  // machine; at ~50 msg/s a 4000-entry cap covers >60 s of traffic and can never grow unbounded.
  maxPendingMessages: 4000,
  // Server: seconds after a map reset during which contact-driven detach is ignored. Restored chunk
  // bodies spawn overlapping anyone standing in the crater they just made, and the solver's
  // penetration-recovery force reads as a huge impact — without this, the map re-shatters around that
  // player the instant it is rebuilt. Explicit weapon damage is unaffected.
  resetSettleSec: 1.0,
  // Server: an impactor embedded deeper than this (metres) inside a live chunk is "buried" and is
  // temporarily removed from the detach-impactor set — its contact force is penetration recovery, not
  // a hit. It is put back the moment it is free again. Measured on the plaza: a capsule resting on a
  // destructible floor reads ~0.000, one wedged inside a rebuilt house reads -0.03 and deeper.
  buriedDepthM: 0.02,
  // Server: how often (seconds) the buried-impactor audit runs. Only ticks while a reset is settling
  // or somebody is still buried, so normal play pays nothing.
  buriedAuditSec: 0.1,
  // Server: release threshold (metres) for a quarantined impactor — shallower than buriedDepthM so the
  // two form a hysteresis band. A body merely resting on a destructible floor measures ~0.000 and clears
  // immediately; one wedged inside a rebuilt wall keeps reading past this and stays quarantined.
  buriedClearDepthM: 0.005,
  // Server: consecutive clean audits needed before a buried impactor is trusted again. A wedged capsule
  // jitters — its measured depth flickers through 0.000 between frames — so one clean sample must not
  // release it back into the detach path.
  buriedClearAudits: 5,
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

  // --- kind:"carve" (Orbital Laser, airstrike Penetrator, Car Cannon) --------------------------
  // A carve is ONE authoritative carveCylinder, not a clamped sphere: a 40 m column has to punch through
  // several floors, which a single radial never could. Every ceiling here is >= the largest legitimate
  // gameplay value so real play always passes: force 60000 = orbital/penetrator force, radius 2.0 =
  // destruction.vehicleSweepRadius (the widest carve any tool asks for), len 60 > orbital throughGround 40.
  carveForceMax: 60000,
  carveRadiusMax: 2.0,
  carveLenMax: 60,
  carveBudgetMax: 240,       // = weapons.orbital.carveBudget, the largest carve budget in the game
  // The Orbital's designation raycast reaches 200 m, but every shipped map fits inside a ~125 m diagonal
  // and _posValid already clamps the point to the map AABB + margin, so this is the second fence, not the
  // first. Sized to admit any legitimate designation on the biggest map.
  carveWithinSenderM: 120,
  // Own timer (player.lastCarve), NOT the shared point/radial one: the Orbital's 3 s countdown overlaps
  // with whatever else the player is shooting, and a chainsaw stream must not eat the strike.
  dmgMinIntervalCarveSec: 0.15,

  // --- Foam Cannon (kind-free message `foam`) --------------------------------------------------
  // The client sends a hardened blob as a packed occupancy bitmap; the SERVER creates the volume and
  // echoes it with the index it landed on, so volume ids stay identical on every peer.
  foamMinIntervalSec: 0.4,   // hardenDelay is 1.5 s, so this only bites on a flood
  foamDimMax: 128,           // per-axis cell count
  foamVoxelMax: 65536,       // nx*ny*nz ceiling (8 KB of bitmap) before any decode work happens
  foamWithinSenderM: 40,     // blob origin must be near the sprayer (foam projRange is 16 m)

  // --- Size Ray (`zap`) ------------------------------------------------------------------------
  // The client never sends a scale: it sends grow/shrink and the server steps its own authoritative value,
  // then clamps to weapons.sizeRay.min/max. Per-TARGET cooldown is the gameplay value; this is the
  // per-PLAYER floodgate.
  zapMinIntervalSec: 0.12,
  zapWithinSenderM: 45,      // weapons.sizeRay.range is 40

  // --- Rebuild Gun (`rebuild`) -----------------------------------------------------------------
  // Client streams its aim point while LMB is held; the server picks the chunk (oldest damage first).
  rebuildMinIntervalSec: 0.2, // weapons.rebuild.rate is 4/s
  rebuildWithinSenderM: 45,   // weapons.rebuild.aimRange is 40
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

// --- Occupancy-bitmap codec (Foam Cannon) ----------------------------------------------------
// A hardened foam blob is a dense voxel grid; sending it as JSON booleans would be ~10x the bytes and
// would blow the message size on a big bridge. One bit per voxel, x fastest then y then z (the same
// linear order buildVolume's fill() is sampled in), base64 over the packed bytes. Hand-rolled base64 so
// this file keeps its no-dependency promise: the browser has btoa, Node has Buffer, and neither is
// guaranteed to be the one running this module.
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INV = (() => { const m = new Int8Array(128).fill(-1); for (let i = 0; i < 64; i++) m[B64_CHARS.charCodeAt(i)] = i; return m; })();

export function bitsByteLength(voxelCount) { return (voxelCount + 7) >> 3; }

// occupied(i) -> truthy for a filled voxel at linear index i. Returns a base64 string.
export function packBits(voxelCount, occupied) {
  const bytes = new Uint8Array(bitsByteLength(voxelCount));
  for (let i = 0; i < voxelCount; i++) if (occupied(i)) bytes[i >> 3] |= 1 << (i & 7);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    const has1 = i + 1 < bytes.length, has2 = i + 2 < bytes.length;
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 3) << 4) | (has1 ? b1 >> 4 : 0)];
    out += has1 ? B64_CHARS[((b1 & 15) << 2) | (has2 ? b2 >> 6 : 0)] : "=";
    out += has2 ? B64_CHARS[b2 & 63] : "=";
  }
  return out;
}

// Inverse of packBits. Returns a Uint8Array of exactly bitsByteLength(voxelCount) bytes, or null if the
// string is malformed or the wrong length for the declared voxel count (server-side validation).
export function unpackBits(str, voxelCount) {
  if (typeof str !== "string") return null;
  const want = bitsByteLength(voxelCount);
  const clean = str.endsWith("==") ? str.slice(0, -2) : str.endsWith("=") ? str.slice(0, -1) : str;
  if (((clean.length * 6) >> 3) !== want) return null;
  const out = new Uint8Array(want);
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? B64_INV[c] : -1;
    if (v < 0) return null;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return o === want ? out : null;
}

export function bitAt(bytes, i) { return (bytes[i >> 3] >> (i & 7)) & 1; }
export function countBits(bytes) {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) { let b = bytes[i]; while (b) { n += b & 1; b >>= 1; } }
  return n;
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
