// weapons.js - tool selection state machine, camera-space viewmodel, C4/rocket entities, firing logic
import * as THREE from "three";
import { CONFIG } from "./config.js";
import { decodeModel, meshModelPart } from "./voxel.js";
import { mulberry32 } from "./sim/rng.js";
import toolModels from "../assets/models/tools.js";
import { GroundVehicle } from "./vehicles/ground.js";
import { VEHICLE_SPECS } from "./vehicles/registry.js";
import { CAPS, packBits, unpackBits, bitAt } from "./net/protocol.js";
import { foamVolumeSpec } from "./destruction.js";

// Build a centered voxel geometry for an in-world projectile from a tool model's "main" part.
function centeredGeo(model) {
  const dec = decodeModel(model);
  const geo = meshModelPart(dec, "main");
  const s = model.parts[0].size, vs = model.voxelSize;
  geo.translate(-(s[0] * vs) / 2, -(s[1] * vs) / 2, -(s[2] * vs) / 2);
  return geo;
}

const W = CONFIG.weapons;
const VM = W.viewmodel;
const FX = W.fx;
const UP = new THREE.Vector3(0, 1, 0);
const FWD_Z = new THREE.Vector3(0, 0, 1);

// ---- Local tuning block (CONFIG.weapons is owned elsewhere this session; same documented-local-constants
// pattern as the mix block in audio.js). Both values belong to one spawn calculation and nothing else. ----
// Car Cannon spawn: the projectile is a 3.6 m long body, so pushing it only 1.5 m past the muzzle left it
// starting the frame inside anything the player stood close to.
const CAR_SPAWN_LEAD = 2.6;       // m ahead of the muzzle (half the car length + clearance)
const CAR_SPAWN_CLEARANCE = 0.6;  // m kept between the spawn point and geometry the muzzle is looking at
// Car Cannon in MULTIPLAYER. Solo damage comes from the contact/sweep path inside drainContacts, which is
// a no-op on a replica (the client never detaches), so a flung car used to smash nothing online. The
// projectile stays a client-side body for looks; while it is travelling at ram speed the client emits a
// short carve intent along its path and the server does the real damage. Numbers below are the MP-only
// pacing; the force/radius/budget of each pulse are read from CONFIG.destruction's vehicle-sweep values so
// the online hit matches the offline sweep.
// 1.25x the server's own carve interval: emitting exactly at the limit loses most pulses to jitter.
const CAR_MP_PULSE_SEC = CAPS.dmgMinIntervalCarveSec * 1.25;
const CAR_MP_LEN_MIN = 2.0;   // m, shortest carve segment (a slow car still bites what it touches)
const CAR_MP_LEN_MAX = 8.0;   // m, longest — one pulse must not outrun the space it actually crossed
// Foam Cannon in MULTIPLAYER: pacing for the hardened-blob upload queue (see Weapons._foamOut).
const FOAM_OUT_INTERVAL = CAPS.foamMinIntervalSec * 1.25; // 1.25x the server's floor, same jitter margin
const FOAM_OUT_MAX = 8;       // queued blobs; past this the oldest is dropped rather than grow unbounded
// Size Ray aim assist: how far off the aim LINE a valid target may sit and still be picked when the
// hairline ray itself missed. Matters most for already-shrunk rubble — a chunk at the 0.25x floor is a few
// centimetres across, and without this you can shrink something and then never hit it again to grow it back
// (measured: 65% -> 100% acquisition on 0.25x debris at ~1.2 degrees of crosshair slop).
const SIZE_AIM_RADIUS = 0.28;     // m

// Monotonic wall clock (seconds). Used as a hard deadline for the camera shake so it expires even
// across frames where update() is never called at all (pause menu open, pointer unlocked, tab hidden).
const nowSeconds = () =>
  (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) / 1000;

// Self-contained Gravity-Gun hold step (Phase 7 §5a). ***MP-CRITICAL: this function depends ONLY on its
// arguments — no `this`, no scene, no globals — so Phase 6 can relocate it verbatim to the server, which
// owns the spring simulation while the client only sends grab/aim/release/throw intents.***
// It keeps the body DYNAMIC and each call applies a critically-damped spring impulse toward a hold-point
// `cfg.holdDist` ahead of the camera (position + velocity feedback), clamps the acceleration by the body's
// mass (force clamp), damps angular velocity, and returns false when the body can't keep up (auto-release).
export function gravityHoldStep(camPos, aimDir, body, cfg, dt) {
  const t = body.translation();
  const hx = camPos.x + aimDir.x * cfg.holdDist;
  const hy = camPos.y + aimDir.y * cfg.holdDist;
  const hz = camPos.z + aimDir.z * cfg.holdDist;
  const ex = hx - t.x, ey = hy - t.y, ez = hz - t.z;
  const err = Math.sqrt(ex * ex + ey * ey + ez * ez);
  const v = body.linvel();
  const k = cfg.springK;
  const c = 2 * Math.sqrt(k) * cfg.dampRatio; // critically damped at dampRatio = 1
  let ax = k * ex - c * v.x;
  let ay = k * ey - c * v.y + 9.81; // +g compensation so the body holds its height
  let az = k * ez - c * v.z;
  const amag = Math.sqrt(ax * ax + ay * ay + az * az);
  if (amag > cfg.maxAccel) { const s = cfg.maxAccel / amag; ax *= s; ay *= s; az *= s; }
  const mass = body.mass ? body.mass() : 1;
  body.applyImpulse({ x: ax * mass * dt, y: ay * mass * dt, z: az * mass * dt }, true);
  const av = body.angvel();
  const damp = Math.exp(-cfg.angularDamp * dt);
  body.setAngvel({ x: av.x * damp, y: av.y * damp, z: av.z * damp }, true);
  return err <= cfg.releaseDist;
}

export class Weapons {
  // `net` is the Phase 6 NetClient handle, or null in single-player. When null every code path below is
  // byte-identical to Phase 5. When set, the weapon system routes C4/rocket lifecycle + FX through the
  // wire and lets the (replica-mode) destruction forward melee/shotgun damage as intents automatically.
  constructor(scene, camera, world, RAPIER, destruction, player, manager, audio, materials, input, net = null) {
    this.scene = scene;
    this.camera = camera;
    this.world = world;
    this.RAPIER = RAPIER;
    this.destruction = destruction;
    this.player = player;
    this.manager = manager;
    this.audio = audio;
    this.materials = materials;
    this.input = input;
    this.net = net;               // null => single-player; truthy => LAN client
    this._ridCounter = 0;         // client-local rocket ids (for rocket / rocket_end relays)
    this.remoteRockets = [];      // visual-only rockets fired by other players

    this.viewmodel = new THREE.Group();
    this.viewmodel.scale.setScalar(VM.scale); // held tools are modelled full-size; shrink so they don't hide the aim
    camera.add(this.viewmodel);

    this._time = 0;
    this.activeCat = -1;
    this.activeItem = 0;

    this._equipT = VM.equipTime;
    this._recoilZ = 0;
    this._recoilPitch = 0;
    this._swingT = -1;
    this._swingHitDone = false;
    this._currentBaseOffset = VM.baseOffset;

    this._buildItems();

    // First-person arms: shared voxel mesh parented to the viewmodel, shown while a tool is equipped.
    const armsDec = decodeModel(toolModels.arms);
    const armsGeo = meshModelPart(armsDec, "main");
    const asz = toolModels.arms.parts[0].size, avs = toolModels.arms.voxelSize;
    armsGeo.translate(-(asz[0] * avs) / 2, -(asz[1] * avs) / 2, -(asz[2] * avs));
    this._armsMesh = new THREE.Mesh(armsGeo, this.materials);
    this._armsMesh.castShadow = false;
    this._armsMesh.receiveShadow = false;
    this._armsMesh.rotation.y = Math.PI; // match tool orientation (model +Z -> into screen)
    this._armsMesh.visible = false;
    this.viewmodel.add(this._armsMesh);

    // Muzzle flash: one shared bright quad in world space, shown for a few frames per shot.
    this._flashMat = new THREE.MeshBasicMaterial({ color: FX.muzzleFlashColor, transparent: true, depthWrite: false });
    this._flashMesh = new THREE.Mesh(new THREE.BoxGeometry(FX.muzzleFlashSize, FX.muzzleFlashSize, FX.muzzleFlashSize), this._flashMat);
    this._flashMesh.castShadow = false;
    this._flashMesh.receiveShadow = false;
    this._flashMesh.visible = false;
    scene.add(this._flashMesh);
    this._flashLife = 0;

    // Pellet tracer pool: shared unit box + material, scaled per shot, no runtime allocation.
    this._tracerGeo = new THREE.BoxGeometry(1, 1, 1);
    this._tracerMat = new THREE.MeshBasicMaterial({ color: FX.tracerColor, transparent: true, depthWrite: false });
    this._tracers = [];
    for (let i = 0; i < FX.tracerPool; i++) {
      const m = new THREE.Mesh(this._tracerGeo, this._tracerMat);
      m.castShadow = false;
      m.receiveShadow = false;
      m.visible = false;
      scene.add(m);
      this._tracers.push({ mesh: m, life: 0 });
    }
    this._tracerIdx = 0;

    // Shared C4 world-charge geometry (centered on the brick) + blink indicator resources.
    const c4dec = decodeModel(toolModels.c4);
    const c4geo = meshModelPart(c4dec, "main");
    const cs = toolModels.c4.parts[0].size, cvs = toolModels.c4.voxelSize;
    this._c4HalfY = (cs[1] * cvs) / 2;
    c4geo.translate(-(cs[0] * cvs) / 2, -(cs[1] * cvs) / 2, -(cs[2] * cvs) / 2);
    this._c4Geo = c4geo;
    this._indGeo = new THREE.BoxGeometry(0.03, 0.03, 0.03);
    this._indMat = new THREE.MeshBasicMaterial({ color: 0xd0392a });
    this.charges = [];

    // Shared rocket projectile geometry (centered).
    const rkdec = decodeModel(toolModels.rocket);
    const rkgeo = meshModelPart(rkdec, "main");
    const rs = toolModels.rocket.parts[0].size, rvs = toolModels.rocket.voxelSize;
    rkgeo.translate(-(rs[0] * rvs) / 2, -(rs[1] * rvs) / 2, -(rs[2] * rvs) / 2);
    this._rocketGeo = rkgeo;
    this.liveRockets = [];
    this._launcherLen = toolModels.rocketLauncher.parts[0].size[2] * toolModels.rocketLauncher.voxelSize;

    // Rocket trail pool (shared geometry + material, pre-allocated, no runtime allocation).
    this._trailGeo = new THREE.BoxGeometry(0.06, 0.06, 0.06);
    this._trailMat = new THREE.MeshBasicMaterial({ color: 0xd8d8d8 });
    this._trail = [];
    for (let i = 0; i < W.rocket.trailPool; i++) {
      const m = new THREE.Mesh(this._trailGeo, this._trailMat);
      m.castShadow = false;
      m.receiveShadow = false;
      m.visible = false;
      scene.add(m);
      this._trail.push({ mesh: m, life: 0 });
    }
    this._trailIdx = 0;

    // --- Phase 7 batch A: throwables / launchers shared resources ----------------------------
    // Pipe bomb = real dynamic Rapier body (bounces/rolls), grey voxel geo.
    this._pipeGeo = centeredGeo(toolModels.pipebomb);
    this.pipeBombs = [];
    // Demolition wire = C4-style placed charges (own list) + pooled sagging wire line segments.
    this.wireCharges = [];
    this._wireGeo = new THREE.BoxGeometry(1, 1, 1);
    this._wireMat = new THREE.MeshBasicMaterial({ color: 0x1c1d1f });
    this._wireSegs = [];
    for (let i = 0; i < W.demoWire.maxCharges * 2 + 4; i++) {
      const m = new THREE.Mesh(this._wireGeo, this._wireMat);
      m.castShadow = false; m.receiveShadow = false; m.visible = false;
      scene.add(m);
      this._wireSegs.push(m);
    }
    // Sticky bombs = ray-stepped projectiles that stick (reuse the C4 brick geo).
    this.stickies = [];
    // Cluster projectiles: parent shell + pooled bomblet meshes (shared clusterBomb voxel ball).
    this._clusterGeo = centeredGeo(toolModels.clusterBomb);
    this.clusters = [];
    this._bombletPool = [];
    for (let i = 0; i < W.cluster.maxLive * W.cluster.bombletCount; i++) {
      const m = new THREE.Mesh(this._clusterGeo, this.materials);
      m.castShadow = false; m.receiveShadow = false; m.visible = false;
      m.scale.setScalar(0.55);
      scene.add(m);
      this._bombletPool.push({ mesh: m, used: false });
    }
    this._sawTimer = 0;
    this._sawShake = 0;

    // --- Phase 7 batch B: Grab & Force shared resources --------------------------------------
    // Wind Cannon dust-puff pool: soft billboard quads that drift along the cone and fade.
    this._dustGeo = new THREE.PlaneGeometry(1, 1);
    this._dust = [];
    for (let i = 0; i < W.windCannon.dust.count * 2; i++) {
      const m = new THREE.Mesh(this._dustGeo, new THREE.MeshBasicMaterial({ color: 0xdfe8f0, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
      m.castShadow = false; m.receiveShadow = false; m.visible = false;
      scene.add(m);
      this._dust.push({ mesh: m, life: 0, vel: new THREE.Vector3() });
    }
    this._dustIdx = 0;

    // Grapple rope: ONE pooled straight segment strip, shared by the on-foot rope and the vehicle rope
    // (only one is ever live at a time). Thin dark boxes lerped from muzzle/chassis to the anchor.
    this._ropeGeo = new THREE.BoxGeometry(1, 1, 1);
    this._ropeMat = new THREE.MeshBasicMaterial({ color: 0x23262b });
    this._ropeSegs = [];
    for (let i = 0; i < W.grapple.segments; i++) {
      const m = new THREE.Mesh(this._ropeGeo, this._ropeMat);
      m.castShadow = false; m.receiveShadow = false; m.visible = false;
      scene.add(m);
      this._ropeSegs.push(m);
    }

    // Grab & Force runtime state.
    this._gravHeld = null;       // { kind:"debris"|"vehicle", body, entry?, vehicle?, mass }
    this._gravReleaseT = 0;      // auto-release timer (wedged target can't keep up)
    this._strainT = 0;           // heavy-vehicle refusal shake timer
    this._grappleHook = null;    // in-flight hook { pos, dir, traveled } before it anchors (on foot)
    this._grappleFoot = null;    // anchored on-foot rope { anchored, anchor:Vector3, ropeLen, reeling }
    this._grappleWheel = 0;      // scroll-to-reel, routed here by _handleSelection while a rope is out
    this._vgrapple = null;       // vehicle rope { joint?, chunk, vol, colliderHandle, localA, localB, restLen, torn }
    this._vacShrunk = new Set(); // debris entries currently scaled down by the vacuum (restored on release)
    // Feature-detect Rapier's generic spring joint (vehicle rope). Fallback = a manual spring (see report).
    this._hasSpringJoint = !!(this.RAPIER.JointData && typeof this.RAPIER.JointData.spring === "function");

    // --- Phase 7 batch C: Strikes + heavy/vehicular ordnance shared resources ----------------
    // Blast Painter: painted chunk set ("vol:cid") + a pool of flat "splat" quads stuck to hit surfaces.
    this._painted = new Map();   // "vol:cid" -> { splat, born }  (Map preserves insertion order => oldest expires first)
    this._paintTimer = 0;
    this._splatGeo = new THREE.PlaneGeometry(1, 1);
    this._splatMat = new THREE.MeshBasicMaterial({ color: 0xff5a2a, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
    this._splatPool = [];
    for (let i = 0; i < W.blastPainter.maxPainted; i++) {
      const m = new THREE.Mesh(this._splatGeo, this._splatMat);
      m.castShadow = false; m.receiveShadow = false; m.visible = false;
      scene.add(m);
      this._splatPool.push({ mesh: m, used: false });
    }

    // Propane tanks: dynamic bodies registered in destruction.damageableProps (never in allowedImpactors).
    this._propaneGeo = centeredGeo(toolModels.propanetank);
    this.propaneTanks = [];

    // Nuke: thrown device + screen-flash DOM overlay + pooled dust column + camera-shake timer.
    this._nukeGeo = centeredGeo(toolModels.nuke);
    this.nukes = [];             // { body, mesh, fuse, armed }
    this._nukeArmed = false;     // one nuke armed at a time
    this._nukeCooldownT = -1e9;
    // Camera shake state. `_shakeOffset` is the displacement WE added last frame and `_shakePost` is the
    // camera position we left behind, so the shake can be un-applied before the next kick and can never
    // integrate into a permanent offset. `_shakeEnd` is the wall-clock deadline (see nowSeconds).
    this._shakeT = 0; this._shakeAmp = 0; this._shakeDur = 0; this._shakeEnd = 0;
    this._shakeOffset = new THREE.Vector3();
    this._shakePost = new THREE.Vector3();
    this._shakeApplied = false;
    this._flashDiv = document.createElement("div");
    this._flashDiv.style.cssText = "position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:50;transition:none;";
    document.body.appendChild(this._flashDiv);
    this._flashT = 0; this._flashDur = 0;
    // Dust column (pooled, simple stacked box), shown at ground zero after a nuke.
    this._dustColMat = new THREE.MeshBasicMaterial({ color: 0x9a8f80, transparent: true, opacity: 0.5, depthWrite: false });
    this._dustCol = new THREE.Mesh(new THREE.CylinderGeometry(W.nuke.dustRadius, W.nuke.dustRadius * 0.6, W.nuke.dustHeight, 8), this._dustColMat);
    this._dustCol.visible = false;
    scene.add(this._dustCol);
    this._dustColT = 0;

    // Orbital laser: one marker (quad + pillar) + one emissive beam column; timeline state.
    this._orbMarkMat = new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
    this._orbMarker = new THREE.Mesh(this._splatGeo, this._orbMarkMat);
    this._orbMarker.rotation.x = -Math.PI / 2; this._orbMarker.visible = false; scene.add(this._orbMarker);
    this._orbPillarMat = new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending });
    this._orbPillar = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, W.orbital.pillarHeight, 6), this._orbPillarMat);
    this._orbPillar.visible = false; scene.add(this._orbPillar);
    this._orbBeamMat = new THREE.MeshBasicMaterial({ color: 0xdff2ff, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending });
    this._orbBeam = new THREE.Mesh(new THREE.CylinderGeometry(W.orbital.beamRadius, W.orbital.beamRadius, W.orbital.pillarHeight, 10), this._orbBeamMat);
    this._orbBeam.visible = false; scene.add(this._orbBeam);
    this._orbital = null;        // { pos, t, phase:"count"|"beam", beamT, nextBeep, beepGap }
    this._orbCooldownT = -1e9;

    // Car Cannon: one live hatchback-mesh projectile (plain dynamic cuboid, temp-registered impactor).
    const hbDec = decodeModel(VEHICLE_SPECS.hatchback.model);
    this._carCannonGeo = meshModelPart(hbDec, "body");
    this.carShots = [];          // { body, collider, mesh, age }
    this._carCooldownT = -1e9;

    // RC Car Bomb: one live mini GroundVehicle; control transfers to it (chase cam, character frozen).
    this._rc = null;             // { veh, deployT }
    this._rcSpec = { ...VEHICLE_SPECS.hatchback, id: "rccar", name: "RC Car", tuning: "rccar" };

    // Airstrike Designator: scripted circling plane prop + 3-ammo select + one live run + plane-cam view.
    this._planeDec = decodeModel(VEHICLE_SPECS.plane.model);
    this._planeGeo = meshModelPart(this._planeDec, "body");
    this._airPlane = null;       // THREE.Mesh (exists only while the designator is equipped)
    this._airAmmo = 0;           // 0 Bombs, 1 Penetrator, 2 Cluster
    this._airAmmoNames = ["Bombs", "Penetrator", "Cluster"];
    this._airRun = null;         // active strike run { target, t, released, descentDir, releasePos }
    this._airCircleT = Math.random() * Math.PI * 2;
    this._prevR = false;
    this._planeView = false;     // RMB plane-camera toggle
    this._planeAim = new THREE.Vector2(0, 0); // slow aim offset while in plane view
    this._airDropGeo = centeredGeo(toolModels.clusterBomb);
    this._airDrops = [];         // falling ordnance meshes (ray-stepped along the descent ray)
    this._airMarkMat = new THREE.MeshBasicMaterial({ color: 0xffcf5a, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
    this._airMarker = new THREE.Mesh(this._splatGeo, this._airMarkMat);
    this._airMarker.rotation.x = -Math.PI / 2; this._airMarker.visible = false; scene.add(this._airMarker);

    // --- Phase 7 batch D: Builders (constructive-voxel subsystem B) shared resources -----------
    // Foam Cannon: pooled spray-projectile spheres (fly a short arc) + pooled soft-cell markers (visual only
    // pre-harden) + soft blobs (grids accreting on the global 0.3 m lattice) + hardened foam volume refs.
    this._foamSphereGeo = new THREE.SphereGeometry(W.foam.cell * 0.55, 6, 5);
    this._foamProjMat = new THREE.MeshStandardMaterial({ color: W.foam.softColor, roughness: 0.95, metalness: 0.0 });
    this._foamProjPool = [];
    for (let i = 0; i < W.foam.projPool; i++) {
      const m = new THREE.Mesh(this._foamSphereGeo, this._foamProjMat);
      m.castShadow = false; m.receiveShadow = false; m.visible = false;
      scene.add(m);
      this._foamProjPool.push({ mesh: m, used: false });
    }
    this._foamMarkerGeo = new THREE.BoxGeometry(W.foam.cell, W.foam.cell, W.foam.cell);
    this._foamMarkerMat = new THREE.MeshStandardMaterial({ color: W.foam.softColor, roughness: 0.98, metalness: 0.0, transparent: true, opacity: 0.85 });
    this._foamMarkerPool = [];
    for (let i = 0; i < W.foam.markerPool; i++) {
      const m = new THREE.Mesh(this._foamMarkerGeo, this._foamMarkerMat);
      m.castShadow = false; m.receiveShadow = false; m.visible = false;
      scene.add(m);
      this._foamMarkerPool.push({ mesh: m, used: false });
    }
    this._foamProj = [];         // in-flight spray projectiles { pool, pos, vel, life }
    this._foamBlobs = [];        // soft (pre-harden) blobs { cells:Map(key->marker), min[], max[], lastSpray, id }
    this._foamVols = [];         // hardened foam volume refs (oldest despawns first at the cap)
    // MP only: hardened blobs waiting for a send slot. Two blobs can harden in the same frame (the
    // soft-blob cap force-hardens the oldest the moment a seventh starts), and the server drops anything
    // inside CAPS.foamMinIntervalSec — so queue instead of firing them all and losing the loser.
    this._foamOut = [];          // [{ o, d, bits }]
    this._foamOutT = 0;
    this._foamSprayTimer = 0;
    this._foamBlobSeq = 0;
    this._foamSplatT = 0;        // splat-audio rate limiter

    // Rebuild Gun: translucent ghost-preview meshes (chunk mesh at 40% opacity ~0.2 s before solidifying).
    this._ghostMat = new THREE.MeshBasicMaterial({ color: W.rebuild.ghostColor, transparent: true, opacity: W.rebuild.ghostOpacity, depthWrite: false });
    this._rebuildGhosts = [];    // { vol, chunk, mesh, t }
    this._rebuildAcc = 0;
    this._rebuildSettleT = 0;    // settle-audio rate limiter

    // Size Ray: per-object scale-lerp animations + cooldown/track bookkeeping (caps the tracked set at 20).
    this._sizeAnims = [];        // { mesh, from, to, t }
    this._sizeTracked = [];      // objects zapped this session (oldest silently dropped past the cap)

    // Label DOM.
    this._label = document.getElementById("tool-label");
    this._labelNum = document.getElementById("tool-label-num");
    this._labelName = document.getElementById("tool-label-name");
    this._labelTimer = 0;
  }

  _buildItems() {
    // Cycle order per category matches the Phase 7 layout table. Melee/Explosives/Launchers now hold
    // multiple items (first real multi-item cycling); Firearms stays single. Keys 5-9 arrive in later batches.
    const defs = [
      { num: 1, catLabel: "Melee", id: "sledgehammer", name: "Sledgehammer", kind: "melee", model: toolModels.sledgehammer, base: VM.sledgeOffset },
      { num: 1, catLabel: "Melee", id: "crowbar", name: "Crowbar", kind: "crowbar", model: toolModels.crowbar, base: VM.crowbarOffset },
      { num: 1, catLabel: "Melee", id: "chainsaw", name: "Chainsaw", kind: "chainsaw", model: toolModels.chainsaw, base: VM.chainsawOffset },
      { num: 2, catLabel: "Explosives", id: "c4", name: "C4 Charge", kind: "c4", model: toolModels.c4, base: VM.baseOffset },
      { num: 2, catLabel: "Explosives", id: "pipeBomb", name: "Pipe Bomb", kind: "pipebomb", model: toolModels.pipebomb, base: VM.baseOffset },
      { num: 2, catLabel: "Explosives", id: "demoWire", name: "Demolition Wire", kind: "demowire", model: toolModels.demowire, base: VM.baseOffset },
      // Batch C explosives: Blast Painter -> Propane Tank -> RC Car Bomb (cycle order per layout table).
      { num: 2, catLabel: "Explosives", id: "blastpainter", name: "Blast Painter", kind: "blastpainter", model: toolModels.blastpainter, base: VM.blastpainterOffset },
      { num: 2, catLabel: "Explosives", id: "propane", name: "Propane Tank", kind: "propane", model: toolModels.propane, base: VM.propaneOffset },
      { num: 2, catLabel: "Explosives", id: "rcCarBomb", name: "RC Car Bomb", kind: "rccar", model: toolModels.rccar, base: VM.rccarOffset },
      { num: 3, catLabel: "Firearms", id: "shotgun", name: "Shotgun", kind: "shotgun", model: toolModels.shotgun, base: VM.baseOffset },
      { num: 4, catLabel: "Launchers", id: "rocketLauncher", name: "Rocket Launcher", kind: "rocket", model: toolModels.rocketLauncher, base: VM.baseOffset },
      { num: 4, catLabel: "Launchers", id: "stickyLauncher", name: "Sticky Bomb Launcher", kind: "sticky", model: toolModels.stickylauncher, base: VM.baseOffset },
      { num: 4, catLabel: "Launchers", id: "clusterLauncher", name: "Cluster Bomb Launcher", kind: "cluster", model: toolModels.clusterlauncher, base: VM.baseOffset },
      { num: 4, catLabel: "Launchers", id: "carCannon", name: "Car Cannon", kind: "carcannon", model: toolModels.carcannon, base: VM.carcannonOffset },
      // Category 5 "Grab & Force" — cycle order per the Phase 7 layout table.
      { num: 5, catLabel: "Grab & Force", id: "gravitygun", name: "Gravity Gun", kind: "gravitygun", model: toolModels.gravitygun, base: VM.gravityOffset },
      { num: 5, catLabel: "Grab & Force", id: "magnetgun", name: "Magnet Gun", kind: "magnet", model: toolModels.magnetgun, base: VM.magnetOffset },
      { num: 5, catLabel: "Grab & Force", id: "grapplegun", name: "Grapple Hook", kind: "grapple", model: toolModels.grapplegun, base: VM.grappleOffset },
      { num: 5, catLabel: "Grab & Force", id: "windcannon", name: "Wind Cannon", kind: "windcannon", model: toolModels.windcannon, base: VM.windOffset },
      { num: 5, catLabel: "Grab & Force", id: "vacuum", name: "Debris Vacuum", kind: "vacuum", model: toolModels.vacuum, base: VM.vacuumOffset },
      // Category 6 "Strikes" (Batch C) — cycle order: Airstrike Designator -> Orbital Laser -> Nuke.
      { num: 6, catLabel: "Strikes", id: "airstrike", name: "Airstrike Designator", kind: "airstrike", model: toolModels.airstrike, base: VM.airstrikeOffset },
      { num: 6, catLabel: "Strikes", id: "orbital", name: "Orbital Laser Designator", kind: "orbital", model: toolModels.orbital, base: VM.orbitalOffset },
      { num: 6, catLabel: "Strikes", id: "nuke", name: "Nuke", kind: "nuke", model: toolModels.nuke, base: VM.nukeOffset },
      // Category 7 "Builders" (Batch D) — cycle order: Foam Cannon -> Rebuild Gun -> Size Ray. 8-9 stay reserved.
      { num: 7, catLabel: "Builders", id: "foamcannon", name: "Foam Cannon", kind: "foamcannon", model: toolModels.foamcannon, base: VM.foamOffset },
      { num: 7, catLabel: "Builders", id: "rebuildgun", name: "Rebuild Gun", kind: "rebuildgun", model: toolModels.rebuildgun, base: VM.rebuildOffset },
      { num: 7, catLabel: "Builders", id: "sizeray", name: "Size Ray", kind: "sizeray", model: toolModels.sizeray, base: VM.sizerayOffset },
    ];
    const meleeKinds = new Set(["melee", "crowbar", "chainsaw"]);
    this.categories = [];
    this._allItems = [];
    for (const d of defs) {
      const dec = decodeModel(d.model);
      const geo = meshModelPart(dec, "main");
      const piv = d.model.parts[0].pivot;
      geo.translate(-piv[0], -piv[1], -piv[2]);
      const mesh = new THREE.Mesh(geo, this.materials);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.rotation.y = Math.PI; // model +Z (forward) -> camera -Z (into screen)
      mesh.visible = false;
      this.viewmodel.add(mesh);
      const muzzleLen = d.model.parts[0].size[2] * d.model.voxelSize - piv[2];
      const armsOffset = meleeKinds.has(d.kind) ? VM.armsOffsetSledge : VM.armsOffset;
      // The group already carries VM.scale (so the arms shrink with it); a bulky tool gets an extra
      // relative factor on its own mesh so it stops filling the corner of the screen.
      // Match the override case-insensitively: the table is hand-written and several ids are camelCase
      // (carCannon, clusterLauncher, stickyLauncher), so a literal lookup silently missed exactly the
      // bulkiest tools and left them at the global scale.
      const byId = VM.scaleById || {};
      const vmScale = byId[d.id] ?? byId[d.id.toLowerCase()] ?? VM.scale;
      if (vmScale !== VM.scale) mesh.scale.setScalar(vmScale / VM.scale);
      const item = { id: d.id, name: d.name, kind: d.kind, num: d.num, mesh, baseOffset: d.base, muzzleLen, armsOffset, vmScale, state: { lastUse: -1e9 } };
      let cat = this.categories.find((c) => c.num === d.num);
      if (!cat) { cat = { num: d.num, label: d.catLabel, items: [] }; this.categories.push(cat); }
      cat.items.push(item);
      this._allItems.push(item);
    }
  }

  get currentToolName() {
    if (this.activeCat < 0) return null;
    return this.categories[this.activeCat].items[this.activeItem].name;
  }

  // Item id of the equipped tool (matches toolModels keys), or null when nothing is out. Used by the
  // MP state upload so remotes render the right held-tool mesh.
  get currentToolId() {
    if (this.activeCat < 0) return null;
    return this.categories[this.activeCat].items[this.activeItem].id;
  }

  _activeItem() { return this.categories[this.activeCat].items[this.activeItem]; }

  _aimDir() {
    return new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(this._pitch(), this._yaw(), 0, "YXZ"));
  }
  _yaw() { return this._rig ? this._rig.yaw : 0; }
  _pitch() { return this._rig ? this._rig.pitch : 0; }
  _camPos() { return this.camera.getWorldPosition(new THREE.Vector3()); }
  _muzzleWorld(item) {
    const b = this._currentBaseOffset;
    return this.camera.localToWorld(new THREE.Vector3(b.x, b.y, b.z - item.muzzleLen * (item.vmScale || VM.scale)));
  }

  // Muzzle flash (shared world-space quad).
  _flash(pos) {
    this._flashMesh.position.copy(pos);
    this._flashMesh.scale.setScalar(1);
    this._flashMesh.visible = true;
    this._flashLife = FX.muzzleFlashTime;
  }
  _tickFlash(dt) {
    if (this._flashLife <= 0) return;
    this._flashLife -= dt;
    if (this._flashLife <= 0) { this._flashMesh.visible = false; return; }
    this._flashMesh.scale.setScalar(0.5 + 0.5 * (this._flashLife / FX.muzzleFlashTime));
  }

  // Pooled pellet tracer: thin stretched box from origin along dir.
  _spawnTracer(origin, dir, length) {
    const t = this._tracers[this._tracerIdx];
    this._tracerIdx = (this._tracerIdx + 1) % this._tracers.length;
    t.mesh.position.copy(origin).addScaledVector(dir, length / 2);
    t.mesh.quaternion.setFromUnitVectors(FWD_Z, dir);
    t.mesh.scale.set(FX.tracerThickness, FX.tracerThickness, length);
    t.mesh.visible = true;
    t.life = FX.tracerLife;
  }
  _tickTracers(dt) {
    for (const t of this._tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) t.mesh.visible = false;
    }
  }

  update(dt, mode, rig) {
    this._rig = rig;
    this._time += dt;
    this.camera.updateMatrixWorld();

    // Always-on ticks: rockets keep flying, trails decay, recoil settles, swing resolves, FX fade.
    this._tickSwing(dt);
    this._tickRockets(dt);
    this._tickRemoteRockets(dt);
    this._tickPipeBombs(dt);
    this._tickStickies(dt);
    this._tickClusters(dt);
    this._tickTrail(dt);
    this._tickFlash(dt);
    // ALWAYS-ON: the nuke camera shake must decay before any of the early-return paths below (driving /
    // RC car / plane view / unarmed), otherwise a shake applied in one mode never ticks down and sticks
    // to the camera for the rest of the session.
    this._tickShake(dt);
    this._tickTracers(dt);
    this._tickDust(dt);
    this._decayAnim(dt);
    this._blinkCharges();
    // Shared fuse hiss loop is on whenever a fused throwable is live (survives tool-switch / driving).
    this.audio.fuse(this.pipeBombs.length + this.stickies.length > 0);

    // Batch C world entities complete on their own timers (like rockets), even after a tool-switch.
    this._tickPropane(dt);
    this._tickNukes(dt);
    this._tickOrbital(dt);
    this._tickCarShots(dt);
    this._tickAirDrops(dt);
    this._tickScreenFlash(dt);
    this._tickDustColumn(dt);
    // Batch D: foam projectiles fly + accrete + harden on their own timers (like rockets); rebuild ghosts
    // solidify and size-lerps finish even after a tool-switch.
    this._tickFoam(dt);
    this._tickRebuildGhosts(dt);
    this._tickSizeAnims(dt);
    this.audio.rcMotor(!!this._rc); // RC-car electric motor loop (on only while a car is deployed)

    const driving = mode !== "walk";
    if (driving) {
      this._swingT = -1;
      this.viewmodel.visible = false;
      this._armsMesh.visible = false;
      this.player.setArmsHidden(false);
      this.audio.chainsaw(false, false);
      // Leaving foot means any on-foot rope is gone; silence force-field loops.
      if (this._grappleFoot || this._grappleHook) this._detachFootGrapple();
      this._silenceGrabForceAudio();
      this.audio.blastSpray(false);
      this.audio.foamSpray(false); // Batch D: foam spray loop is a foot-only tool
      if (this._airPlane) this._despawnPlane(); // designator's scripted plane exists only on foot/equipped
      // Grapple is the one tool usable while driving (the wall-tearing fantasy). No-op for any other tool.
      this._tickVehicleGrapple(dt);
      // Drain edges so nothing fires on exit.
      this.input.consumeDigits();
      this.input.consumeLMB();
      this.input.consumeRMB();
      this.input.consumeWheel();
      this._applyShake(); // on top of the chase camera main just placed
      return;
    }
    // Back on foot: drop any vehicle rope we were holding.
    if (this._vgrapple) this._detachVehicleGrapple();

    // RC Car Bomb: while a car is deployed, control is transferred to it. Drive + detonate here, place the
    // fixed chase cam, and skip the normal selection/fire path. Character is frozen (main gates player.update).
    if (this._rc) { this._tickRcActive(dt); this.viewmodel.visible = false; this._armsMesh.visible = false; this.player.setArmsHidden(false); this._applyShake(); return; }
    // Airstrike plane-camera view: slow aim + LMB designate + RMB exit here; character frozen; skip fire.
    if (this._planeView) { this._tickPlaneView(dt); this.viewmodel.visible = false; this._armsMesh.visible = false; this.player.setArmsHidden(false); this._applyShake(); return; }

    this._handleSelection();

    const lmb = this.input.consumeLMB();
    const rmb = this.input.consumeRMB();
    if (this.activeCat >= 0) this._handleFire(lmb, rmb);

    const equipped = this.activeCat >= 0;
    // Chainsaw continuous hold-fire + looping audio (also keeps the loops silenced for every other tool).
    this._tickChainsaw(dt, equipped);
    // Grab & Force category (Wind / Vacuum / Magnet / Gravity / Grapple-on-foot); manages its own loops.
    this._tickGrabForce(dt, equipped, lmb, rmb);
    // Blast Painter hold-spray + Airstrike scripted plane / R-cycle (spawn while equipped, despawn otherwise).
    this._tickBlastPainter(dt, equipped);
    this._tickAirstrike(dt, equipped);
    // Builders: Foam Cannon hold-spray spawn + Rebuild Gun hold-heal (Size Ray fires on LMB/RMB edges above).
    this._tickBuilders(dt, equipped);
    // Demolition-wire line visuals follow their (possibly vehicle-parented) charges every frame.
    if (this.wireCharges.length) this._rebuildWireLines();

    this.viewmodel.visible = equipped;
    this._armsMesh.visible = equipped;
    this.player.setArmsHidden(equipped);
    if (equipped) this._animateViewmodel(dt);
    this._applyShake(); // nuke camera shake (added on top of the FPP camera main just placed)
  }

  _handleSelection() {
    for (const d of this.input.consumeDigits()) {
      const idx = this.categories.findIndex((c) => c.num === d);
      if (idx < 0) continue; // 5-9 reserved / absent
      const cat = this.categories[idx];
      if (idx !== this.activeCat) { this.activeCat = idx; this.activeItem = 0; }
      else { this.activeItem = (this.activeItem + 1) % cat.items.length; }
      this._equip();
    }
    const w = this.input.consumeWheel();
    if (w !== 0 && this.activeCat >= 0) {
      // While an on-foot grapple rope is anchored, the wheel reels the rope instead of cycling tools.
      if (this._activeItem().kind === "grapple" && this._grappleFoot) {
        if (w < 0) this._grappleWheel += 1; // scroll up = reel in
        return;
      }
      const len = this.categories[this.activeCat].items.length;
      this.activeItem = ((this.activeItem + w) % len + len) % len;
      this._equip();
    }
  }

  _equip() {
    const item = this._activeItem();
    for (const it of this._allItems) it.mesh.visible = false;
    item.mesh.visible = true;
    this._currentBaseOffset = item.baseOffset;
    this._armsMesh.position.set(item.armsOffset.x, item.armsOffset.y, item.armsOffset.z);
    this._equipT = 0;
    this._swingT = -1;
    this._showLabel(item);
  }

  _showLabel(item) {
    if (!this._label) return;
    this._labelNum.textContent = String(this.categories[this.activeCat].num);
    this._labelName.textContent = item.name;
    this._label.style.opacity = "1";
    clearTimeout(this._labelTimer);
    this._labelTimer = setTimeout(() => { this._label.style.opacity = "0"; }, VM.labelSeconds * 1000);
  }

  _handleFire(lmb, rmb) {
    const item = this._activeItem();
    switch (item.kind) {
      case "melee": if (lmb) this._startSwing(item); break;
      case "crowbar": if (lmb) this._startSwing(item); break;
      case "chainsaw": break; // continuous hold-fire handled in _tickChainsaw
      case "c4": if (lmb) this._placeC4(item); if (rmb) this._detonate(); break;
      case "pipebomb": if (lmb) this._throwPipeBomb(item); break;
      case "demowire": if (lmb) this._placeWire(item); if (rmb) this._detonateWire(); break;
      case "shotgun": if (lmb) this._fireShotgun(item); break;
      case "rocket": if (lmb) this._fireRocket(item); break;
      case "sticky": if (lmb) this._fireSticky(item); break;
      case "cluster": if (lmb) this._fireCluster(item); break;
      case "carcannon": if (lmb) this._fireCarCannon(item); break;
      case "windcannon": if (lmb) this._fireWind(item); break;
      // Batch C:
      case "blastpainter": if (rmb) this._detonatePaint(); break; // LMB spray handled in _tickBlastPainter
      case "propane": if (lmb) this._throwPropane(item); break;
      case "rccar": if (lmb) this._deployRc(item); break;
      case "nuke": if (lmb) this._throwNuke(item); break;
      case "orbital": if (lmb) this._plantOrbital(item); break;
      case "airstrike": if (lmb) this._airDesignateFpp(item); if (rmb) this._enterPlaneView(); break;
      // Batch D Builders:
      case "foamcannon": break;  // hold-LMB spray handled in _tickBuilders
      case "rebuildgun": break;  // hold-LMB heal handled in _tickBuilders
      case "sizeray": if (lmb) this._sizeZap(false); if (rmb) this._sizeZap(true); break; // LMB shrink / RMB enlarge
      // Vacuum / Magnet / Gravity / Grapple are continuous or hold-based — handled in _tickGrabForce.
    }
  }

  // --- Melee (sledgehammer + crowbar; both use the swing state machine, crowbar with its own tuning) ---
  _startSwing(item) {
    if (this._swingT >= 0) return;
    const cfg = item.kind === "crowbar" ? W.crowbar : W.melee;
    if (this._time - item.state.lastUse < cfg.cooldown) return;
    item.state.lastUse = this._time;
    this._swingCfg = cfg;
    this._swingIsCrowbar = item.kind === "crowbar";
    this._swingT = 0;
    this._swingHitDone = false;
    this.audio.swing();
    if (this.net) this.net.sendFx("swing", this._camPos());
  }

  _tickSwing(dt) {
    if (this._swingT < 0) return;
    const cfg = this._swingCfg || W.melee;
    this._swingT += dt;
    if (!this._swingHitDone && this._swingT >= cfg.hitDelay) {
      this._swingHitDone = true;
      this._doMeleeHit();
    }
    if (this._swingT >= cfg.swingDuration) this._swingT = -1;
  }

  _doMeleeHit() {
    const cfg = this._swingCfg || W.melee;
    const isCrowbar = this._swingIsCrowbar;
    const origin = this._camPos();
    const dir = this._aimDir();
    const ray = new this.RAPIER.Ray(origin, dir);
    const hit = this.world.castRay(ray, cfg.range, true, undefined, undefined, undefined, this.player.body);
    if (!hit) return;
    if (this.destruction.hasChunk(hit.collider.handle)) {
      // In MP the replica destruction forwards this as a `dmg point` intent (with the material mult) — no local detach.
      const opts = cfg.mult ? { mult: cfg.mult } : undefined;
      const broke = this.destruction.applyPointDamage(hit.collider.handle, origin, cfg.force, opts);
      if (isCrowbar) this.audio.crowbarHit(broke); else this.audio.clang(broke);
      if (this.net) this.net.sendFx("clang", origin.clone().addScaledVector(dir, hit.toi));
    } else {
      if (isCrowbar) this.audio.crowbarHit(false); else this.audio.clang(false);
    }
  }

  // --- Chainsaw: hold LMB for continuous point-damage ticks; material mult does the flavor work. ---
  _tickChainsaw(dt, equipped) {
    const item = equipped ? this._activeItem() : null;
    if (!item || item.kind !== "chainsaw") { this.audio.chainsaw(false, false); this._sawShake = 0; this._sawTimer = 0; return; }
    const cs = W.chainsaw;
    let cutting = false;
    if (this.input.lmbDown) {
      this._sawTimer += dt;
      const origin = this._camPos();
      const dir = this._aimDir();
      const ray = new this.RAPIER.Ray(origin, dir);
      const hit = this.world.castRay(ray, cs.range, true, undefined, undefined, undefined, this.player.body);
      const onChunk = hit && this.destruction.hasChunk(hit.collider.handle);
      if (onChunk) {
        cutting = true;
        if (this._sawTimer >= cs.tickInterval) {
          this._sawTimer = 0;
          const broke = this.destruction.applyPointDamage(hit.collider.handle, origin, cs.force, { mult: cs.mult });
          // Solo: nothing broke on a hard material (concrete/metal) => metallic screech.
          if (!broke && !this.net) this.audio.chainsawScreech();
        }
      } else {
        // Revving in the air: keep the cut layer up but don't accumulate a huge pending tick.
        if (this._sawTimer > cs.tickInterval) this._sawTimer = cs.tickInterval;
      }
    } else {
      this._sawTimer = 0;
    }
    this.audio.chainsaw(true, cutting);
    this._sawShake = cutting ? 1 : 0.35; // idle rumble even when not biting
  }

  // --- C4 ---
  _placeC4(item) {
    if (this._time - item.state.lastUse < W.c4.placeCooldown) return;
    const origin = this._camPos();
    const dir = this._aimDir();
    const ray = new this.RAPIER.Ray(origin, dir);
    const hit = this.world.castRayAndGetNormal(ray, W.c4.placeRange, true, undefined, undefined, undefined, this.player.body);
    if (!hit) return;
    item.state.lastUse = this._time;

    const point = origin.clone().addScaledVector(dir, hit.toi);
    const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
    if (normal.lengthSq() < 1e-6) normal.set(0, 1, 0); else normal.normalize();
    const worldPos = point.clone().addScaledVector(normal, this._c4HalfY);
    const worldQuat = new THREE.Quaternion().setFromUnitVectors(UP, normal);
    const onVehicleV = this.manager ? this.manager.byColliderHandle(hit.collider.handle) : null;

    if (this.net) {
      // MP: place NO local charge — the visual arrives via c4_add (including our own). Send intent only.
      const vid = onVehicleV ? (onVehicleV.netId ?? -1) : -1;
      this.net.sendC4Place(worldPos, worldQuat, vid);
      this.audio.placeCharge();
      this._recoilZ -= 0.06;
      return;
    }

    this._spawnChargeVisual(worldPos, worldQuat, onVehicleV, null);
    while (this.charges.length > W.c4.maxCharges) {
      const old = this.charges.shift();
      if (old.mesh.parent) old.mesh.parent.remove(old.mesh);
    }
    this.audio.placeCharge();
    this._recoilZ -= 0.06;
  }

  // Build one placed-charge visual (brick mesh + blink indicator) parented to a vehicle chassis or the
  // world. Shared by solo placement and the MP c4_add relay. `tag` = { cid4, owner } for net charges.
  _spawnChargeVisual(worldPos, worldQuat, onVehicleV, tag, list = this.charges) {
    const mesh = new THREE.Mesh(this._c4Geo, this.materials);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const indicator = new THREE.Mesh(this._indGeo, this._indMat);
    indicator.position.set(0, this._c4HalfY + 0.015, 0);
    mesh.add(indicator);

    const onVehicle = !!onVehicleV;
    if (onVehicle) {
      const chassis = onVehicleV.chassis;
      chassis.updateWorldMatrix(true, false);
      const cq = chassis.getWorldQuaternion(new THREE.Quaternion());
      mesh.quaternion.copy(cq.invert().multiply(worldQuat));
      mesh.position.copy(chassis.worldToLocal(worldPos.clone()));
      chassis.add(mesh);
    } else {
      mesh.quaternion.copy(worldQuat);
      mesh.position.copy(worldPos);
      this.scene.add(mesh);
    }
    const rec = { mesh, isOnVehicle: onVehicle, vehicle: onVehicleV, indicator, cid4: tag ? tag.cid4 : undefined, owner: tag ? tag.owner : undefined };
    list.push(rec);
    return rec;
  }

  _detonate() {
    if (this.net) {
      // MP: the server detonates THIS player's charges; removal + booms arrive via c4_boom + detach.
      this.audio.armBeep();
      this.net.sendC4Det();
      return;
    }
    if (this.charges.length === 0) return;
    this.audio.armBeep();
    const cam = this._camPos();
    const blasts = [];
    for (const ch of this.charges) {
      const pos = ch.mesh.getWorldPosition(new THREE.Vector3());
      this.destruction.applyRadialDamage(pos, W.c4.force, W.c4.radius, W.explosionDetachBudget);
      blasts.push({ pos, dist: cam.distanceTo(pos) });
    }
    blasts.sort((a, b) => a.dist - b.dist);
    for (let i = 0; i < blasts.length && i < W.explosionSoundCap; i++) this.audio.explosion(blasts[i].dist);
    for (const ch of this.charges) if (ch.mesh.parent) ch.mesh.parent.remove(ch.mesh);
    this.charges.length = 0;
  }

  // --- MP C4 relay hooks (called by replication.js) ------------------------------------------
  // Render a replicated charge (c4_add / snapshot). p,q are world [x,y,z]/[x,y,z,w] arrays.
  addNetCharge(cid4, owner, p, q, vid) {
    const worldPos = new THREE.Vector3(p[0], p[1], p[2]);
    const worldQuat = new THREE.Quaternion(q[0], q[1], q[2], q[3]);
    const onVehicleV = (vid != null && vid >= 0 && this.manager.byNetId) ? this.manager.byNetId(vid) : null;
    this._spawnChargeVisual(worldPos, worldQuat, onVehicleV, { cid4, owner });
    // Client-side safety cap (server enforces 20/player; guard against unbounded growth on this client).
    const CAP = W.c4.maxCharges * 4;
    while (this.charges.length > CAP) { const old = this.charges.shift(); if (old.mesh.parent) old.mesh.parent.remove(old.mesh); }
  }

  removeNetCharges(ids) {
    if (!ids || !ids.length) return;
    const set = new Set(ids);
    this.charges = this.charges.filter((ch) => {
      if (ch.cid4 !== undefined && set.has(ch.cid4)) { if (ch.mesh.parent) ch.mesh.parent.remove(ch.mesh); return false; }
      return true;
    });
  }

  removeNetChargesByOwner(pid) {
    this.charges = this.charges.filter((ch) => {
      if (ch.owner === pid) { if (ch.mesh.parent) ch.mesh.parent.remove(ch.mesh); return false; }
      return true;
    });
  }

  // Map-reset companion (Phase 5): clear all transient world entities this weapon system owns so a
  // reset leaves no orphaned meshes. Placed C4 (including charges parented to vehicles) and their
  // blink indicators are unparented; live rockets are removed from the scene. Shared geometries are
  // reused, not disposed. Pooled tracers/trail/flash decay on their own timers.
  resetTransient() {
    for (const ch of this.charges) if (ch.mesh.parent) ch.mesh.parent.remove(ch.mesh);
    this.charges.length = 0;
    for (const rk of this.liveRockets) this.scene.remove(rk.mesh);
    this.liveRockets.length = 0;
    for (const rk of this.remoteRockets) this.scene.remove(rk.mesh);
    this.remoteRockets.length = 0;
    // Phase 7 batch A transient entities.
    for (const pb of this.pipeBombs) this._removePipeBomb(pb);
    this.pipeBombs.length = 0;
    for (const ch of this.wireCharges) if (ch.mesh.parent) ch.mesh.parent.remove(ch.mesh);
    this.wireCharges.length = 0;
    this._rebuildWireLines();
    for (const s of this.stickies) if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
    this.stickies.length = 0;
    for (const c of this.clusters) this._clearCluster(c);
    this.clusters.length = 0;
    this.audio.fuse(false);
    // Phase 7 batch B: drop any grab/rope state and hide their pooled visuals.
    this._releaseGrav();
    this._detachFootGrapple();
    this._detachVehicleGrapple();
    this._restoreShrunk();
    for (const e of this._dust) { e.mesh.visible = false; e.life = 0; }
    this._silenceGrabForceAudio();
    // Phase 7 batch C transient entities.
    for (const tank of this.propaneTanks) this._disposeTank(tank);
    this.propaneTanks.length = 0;
    for (const nk of this.nukes) { if (nk.mesh && nk.mesh.parent) nk.mesh.parent.remove(nk.mesh); try { this.world.removeRigidBody(nk.body); } catch (e) {} }
    this.nukes.length = 0;
    this._nukeArmed = false;
    for (const s of [...this.carShots]) this._removeCarShot(s);
    this.carShots.length = 0;
    this._returnRc(false);
    this._despawnPlane();
    for (const d of this._airDrops) if (d.mesh.parent) d.mesh.parent.remove(d.mesh);
    this._airDrops.length = 0;
    this._airRun = null;
    for (const rec of this._painted.values()) this._releaseSplat(rec.splat);
    this._painted.clear();
    this._endOrbital();
    this._flashT = 0; this._dustColT = 0;
    this._clearShake();
    this._flashDiv.style.opacity = "0"; this._dustCol.visible = false;
    this.audio.blastSpray(false); this.audio.rcMotor(false); this.audio.airPlaneLoop(false);
    // Phase 7 batch D: Builders transient state (foam projectiles/blobs/volumes, rebuild ghosts, size lerps).
    this._clearBuilders();
  }

  // --- MP rocket relay hooks (called by replication.js) --------------------------------------
  // Visual-only remote rocket: flies for the viewer, applies NO damage (server authoritative). Removed
  // on the owner's rocket_end (endRemoteRocket) or a lifetime backstop.
  addRemoteRocket(pid, rid, p, dir) {
    const mesh = new THREE.Mesh(this._rocketGeo, this.materials);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const pos = new THREE.Vector3(p[0], p[1], p[2]);
    const d = new THREE.Vector3(dir[0], dir[1], dir[2]);
    if (d.lengthSq() < 1e-6) d.set(0, 0, -1); else d.normalize();
    mesh.position.copy(pos);
    mesh.quaternion.setFromUnitVectors(FWD_Z, d);
    this.scene.add(mesh);
    this.remoteRockets.push({ mesh, pos, vel: d.multiplyScalar(W.rocket.speed), age: 0, trailTimer: 0, pid, rid });
  }

  _tickRemoteRockets(dt) {
    if (this.remoteRockets.length === 0) return;
    const keep = [];
    for (const rk of this.remoteRockets) {
      rk.age += dt;
      if (rk.age > W.rocket.lifetime + 1) { this.scene.remove(rk.mesh); continue; }
      rk.pos.addScaledVector(rk.vel, dt);
      rk.mesh.position.copy(rk.pos);
      rk.trailTimer += dt;
      if (rk.trailTimer >= W.rocket.trailInterval) { rk.trailTimer -= W.rocket.trailInterval; this._spawnTrail(rk.pos); }
      keep.push(rk);
    }
    this.remoteRockets = keep;
  }

  endRemoteRocket(pid, rid, p) {
    const keep = [];
    for (const rk of this.remoteRockets) {
      if (rk.pid === pid && rk.rid === rid) { this.scene.remove(rk.mesh); if (p) this._flash(new THREE.Vector3(p[0], p[1], p[2])); }
      else keep.push(rk);
    }
    this.remoteRockets = keep;
  }

  removeRemoteRocketsByOwner(pid) {
    const keep = [];
    for (const rk of this.remoteRockets) {
      if (rk.pid === pid) this.scene.remove(rk.mesh);
      else keep.push(rk);
    }
    this.remoteRockets = keep;
  }

  _blinkCharges() {
    const on = Math.floor(this._time * 2) % 2 === 0;
    for (const ch of this.charges) ch.indicator.visible = on;
    for (const ch of this.wireCharges) if (ch.indicator) ch.indicator.visible = on;
    // Pipe bombs / stickies blink faster as their fuse runs out (blink rate proportional to urgency).
    const fast = Math.floor(this._time * 6) % 2 === 0;
    for (const pb of this.pipeBombs) if (pb.indicator) pb.indicator.visible = fast;
    for (const s of this.stickies) if (s.indicator) s.indicator.visible = s.stuck ? fast : true;
  }

  // Called by the manager when a vehicle is despawned: detach its stuck charges and re-parent
  // them into the world at their last position so they stay placed (and detonatable).
  dropVehicleCharges(vehicle) {
    for (const ch of this.charges) {
      if (ch.vehicle !== vehicle) continue;
      const wp = ch.mesh.getWorldPosition(new THREE.Vector3());
      const wq = ch.mesh.getWorldQuaternion(new THREE.Quaternion());
      if (ch.mesh.parent) ch.mesh.parent.remove(ch.mesh);
      ch.mesh.position.copy(wp);
      ch.mesh.quaternion.copy(wq);
      this.scene.add(ch.mesh);
      ch.vehicle = null;
      ch.isOnVehicle = false;
    }
  }

  // --- Phase 7 batch A: shared explosion helper ----------------------------------------------
  // Solo/authoritative: detach now, or (staged) bleed the job through the per-frame stage queue.
  // Replica (this.net set): applyRadialDamage forwards a radial dmg intent to the server (server owns
  // the detach + any staging; the client just receives the resulting detach batches). See report MP notes.
  _explode(center, force, radius, budget, staged) {
    if (staged && !this.net) this.destruction.enqueueRadialJobs([{ center, force, radius, budget }]);
    else this.destruction.applyRadialDamage(center, force, radius, budget);
  }

  // --- 2b. Pipe Bomb: real dynamic Rapier body, ~3 s fuse, C4-scale blast at its resting spot ---
  _throwPipeBomb(item) {
    if (this._time - item.state.lastUse < W.pipeBomb.fireInterval) return;
    item.state.lastUse = this._time;
    const pb = W.pipeBomb;
    while (this.pipeBombs.length >= pb.maxLive) this._removePipeBomb(this.pipeBombs.shift());

    const dir = this._aimDir();
    const origin = this._muzzleWorld(item);
    const bodyDesc = this.RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(origin.x, origin.y, origin.z)
      .setLinvel(dir.x * pb.throwSpeed, dir.y * pb.throwSpeed + pb.upBias, dir.z * pb.throwSpeed)
      .setAngvel({ x: Math.random() * 6 - 3, y: Math.random() * 6 - 3, z: Math.random() * 6 - 3 })
      .setLinearDamping(0.1).setCcdEnabled(true).setCanSleep(true);
    const body = this.world.createRigidBody(bodyDesc);
    const cd = this.RAPIER.ColliderDesc.cylinder(pb.colliderHalf, pb.colliderRadius)
      .setRestitution(pb.restitution).setFriction(0.7).setDensity(pb.density);
    this.world.createCollider(cd, body);

    const mesh = new THREE.Mesh(this._pipeGeo, this.materials);
    mesh.castShadow = true; mesh.position.copy(origin);
    this.scene.add(mesh);
    const indicator = new THREE.Mesh(this._indGeo, this._indMat);
    indicator.position.set(0, pb.colliderHalf + 0.03, 0);
    mesh.add(indicator);
    this.pipeBombs.push({ body, mesh, indicator, fuse: pb.fuse, prevVy: 0 });
    this._recoilZ -= 0.05;
  }

  _removePipeBomb(pb) {
    if (!pb) return;
    if (pb.mesh && pb.mesh.parent) pb.mesh.parent.remove(pb.mesh);
    if (pb.body) { try { this.world.removeRigidBody(pb.body); } catch (e) {} }
  }

  _tickPipeBombs(dt) {
    if (this.pipeBombs.length === 0) return;
    const cam = this._camPos();
    const keep = [];
    for (const pb of this.pipeBombs) {
      const t = pb.body.translation();
      const r = pb.body.rotation();
      pb.mesh.position.set(t.x, t.y, t.z);
      pb.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      // Bounce clink: velocity's vertical component flips from falling to rising = a bounce.
      const lv = pb.body.linvel();
      if (pb.prevVy < -1.5 && lv.y > 0.6) this.audio.bounceClink(cam.distanceTo(pb.mesh.position));
      pb.prevVy = lv.y;
      pb.fuse -= dt;
      if (pb.fuse <= 0) {
        const p = new THREE.Vector3(t.x, t.y, t.z);
        this._explode(p, W.pipeBomb.force, W.pipeBomb.radius, W.pipeBomb.budget, false);
        this.audio.explosion(cam.distanceTo(p));
        this._removePipeBomb(pb);
        continue;
      }
      keep.push(pb);
    }
    this.pipeBombs = keep;
  }

  // --- 2c. Demolition Wire: C4-style placement into a separate list, visually wired, RMB detonate-all ---
  _placeWire(item) {
    if (this._time - item.state.lastUse < W.demoWire.placeCooldown) return;
    const origin = this._camPos();
    const dir = this._aimDir();
    const ray = new this.RAPIER.Ray(origin, dir);
    const hit = this.world.castRayAndGetNormal(ray, W.demoWire.placeRange, true, undefined, undefined, undefined, this.player.body);
    if (!hit) return;
    item.state.lastUse = this._time;
    const point = origin.clone().addScaledVector(dir, hit.toi);
    const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
    if (normal.lengthSq() < 1e-6) normal.set(0, 1, 0); else normal.normalize();
    const worldPos = point.clone().addScaledVector(normal, this._c4HalfY);
    const worldQuat = new THREE.Quaternion().setFromUnitVectors(UP, normal);
    const onVehicleV = this.manager ? this.manager.byColliderHandle(hit.collider.handle) : null;
    this._spawnChargeVisual(worldPos, worldQuat, onVehicleV, null, this.wireCharges);
    while (this.wireCharges.length > W.demoWire.maxCharges) {
      const old = this.wireCharges.shift();
      if (old.mesh.parent) old.mesh.parent.remove(old.mesh);
    }
    this._rebuildWireLines();
    this.audio.placeCharge();
    this._recoilZ -= 0.05;
  }

  // Reposition pooled sagging line segments between consecutive wire charges (two segments per link, with
  // the midpoint dropped by CONFIG sag). Called every frame so vehicle-parented charges keep their wires.
  _rebuildWireLines() {
    let seg = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), mid = new THREE.Vector3();
    for (let i = 0; i < this.wireCharges.length - 1; i++) {
      this.wireCharges[i].mesh.getWorldPosition(a);
      this.wireCharges[i + 1].mesh.getWorldPosition(b);
      mid.addVectors(a, b).multiplyScalar(0.5); mid.y -= W.demoWire.sag;
      seg = this._setWireSeg(seg, a, mid);
      seg = this._setWireSeg(seg, mid, b);
    }
    for (; seg < this._wireSegs.length; seg++) this._wireSegs[seg].visible = false;
  }

  _setWireSeg(idx, p0, p1) {
    if (idx >= this._wireSegs.length) return idx;
    const m = this._wireSegs[idx];
    const len = p0.distanceTo(p1);
    m.position.copy(p0).add(p1).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(FWD_Z, p1.clone().sub(p0).normalize());
    m.scale.set(0.012, 0.012, Math.max(0.001, len));
    m.visible = true;
    return idx + 1;
  }

  _detonateWire() {
    if (this.wireCharges.length === 0) return;
    this.audio.wireBeep();
    const cam = this._camPos();
    const staged = this.wireCharges.length > W.demoWire.stageThreshold;
    const blasts = [];
    for (const ch of this.wireCharges) {
      const pos = ch.mesh.getWorldPosition(new THREE.Vector3());
      this._explode(pos, W.demoWire.force, W.demoWire.radius, W.demoWire.budget, staged);
      blasts.push({ dist: cam.distanceTo(pos) });
    }
    blasts.sort((a, b) => a.dist - b.dist);
    for (let i = 0; i < blasts.length && i < W.explosionSoundCap; i++) this.audio.explosion(blasts[i].dist);
    for (const ch of this.wireCharges) if (ch.mesh.parent) ch.mesh.parent.remove(ch.mesh);
    this.wireCharges.length = 0;
    this._rebuildWireLines();
  }

  // --- 4b. Sticky Bomb Launcher: ray-stepped projectile that sticks to world/chunks/vehicles, 2.5 s fuse ---
  _fireSticky(item) {
    if (this._time - item.state.lastUse < W.sticky.fireInterval) return;
    item.state.lastUse = this._time;
    const st = W.sticky;
    while (this.stickies.length >= st.maxLive) {
      const old = this.stickies.shift();
      if (old.mesh.parent) old.mesh.parent.remove(old.mesh);
    }
    const dir = this._aimDir();
    const origin = this._muzzleWorld(item);
    const mesh = new THREE.Mesh(this._c4Geo, this.materials);
    mesh.castShadow = true; mesh.position.copy(origin);
    this.scene.add(mesh);
    const indicator = new THREE.Mesh(this._indGeo, this._indMat);
    indicator.position.set(0, this._c4HalfY + 0.02, 0);
    mesh.add(indicator);
    this.stickies.push({ mesh, indicator, pos: origin.clone(), vel: dir.clone().multiplyScalar(st.speed), stuck: false, fuse: st.fuse, age: 0, vehicle: null });
    this.audio.stickyThoomp();
    this._flash(origin);
    this._recoilZ += 0.08;
  }

  _tickStickies(dt) {
    if (this.stickies.length === 0) return;
    const cam = this._camPos();
    const keep = [];
    for (const s of this.stickies) {
      s.age += dt;
      if (!s.stuck) {
        s.vel.y -= 9.81 * dt * 0.5; // slight droop; slower + heavier-feeling than the rocket
        const step = s.vel.clone().multiplyScalar(dt);
        const dist = step.length();
        const dir = dist > 1e-6 ? step.clone().multiplyScalar(1 / dist) : this._aimDir();
        const ray = new this.RAPIER.Ray(s.pos, dir);
        const hit = this.world.castRay(ray, Math.max(dist, 0.02), true, undefined, undefined, undefined, this.player.body);
        if (hit) {
          const point = s.pos.clone().addScaledVector(dir, hit.toi);
          const onVehicleV = this.manager ? this.manager.byColliderHandle(hit.collider.handle) : null;
          s.pos.copy(point);
          if (onVehicleV) {
            // Stick to the chassis (same parenting as C4-on-vehicle) so it rides along.
            const chassis = onVehicleV.chassis;
            chassis.updateWorldMatrix(true, false);
            s.mesh.position.copy(chassis.worldToLocal(point.clone()));
            chassis.add(s.mesh);
            s.vehicle = onVehicleV;
          } else {
            s.mesh.position.copy(point);
          }
          s.stuck = true; s.fuse = W.sticky.fuse;
          this.audio.stickSplat(cam.distanceTo(point));
          keep.push(s);
          continue;
        }
        s.pos.add(step);
        s.mesh.position.copy(s.pos);
        if (s.age > W.sticky.lifetime) { if (s.mesh.parent) s.mesh.parent.remove(s.mesh); continue; }
        keep.push(s);
        continue;
      }
      s.fuse -= dt;
      if (s.fuse <= 0) {
        const p = s.mesh.getWorldPosition(new THREE.Vector3());
        this._explode(p, W.sticky.force, W.sticky.radius, W.sticky.budget, false);
        this.audio.explosion(cam.distanceTo(p));
        if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
        continue;
      }
      keep.push(s);
    }
    this.stickies = keep;
  }

  // --- 4c. Cluster Bomb Launcher: arced shell splits at 0.8 s into 6 seeded bomblets; small staged blasts ---
  _fireCluster(item) {
    if (this._time - item.state.lastUse < W.cluster.fireInterval) return;
    item.state.lastUse = this._time;
    const cl = W.cluster;
    while (this.clusters.length >= cl.maxLive) this._clearCluster(this.clusters.shift());
    const dir = this._aimDir();
    const origin = this._muzzleWorld(item);
    const vel = dir.clone().multiplyScalar(cl.speed); vel.y += cl.upBias;
    const mesh = new THREE.Mesh(this._clusterGeo, this.materials);
    mesh.castShadow = true; mesh.position.copy(origin);
    this.scene.add(mesh);
    // Deterministic per-shot seed so the split pattern is reproducible (server-sync friendly + self-test).
    const seed = ((this._ridCounter++ * 2654435761) ^ 0x9e3779b9) >>> 0;
    this.clusters.push({ phase: "shell", pos: origin.clone(), vel, mesh, timer: 0, seed, bomblets: [] });
    this.audio.stickyThoomp();
    this._flash(origin);
    this._recoilZ += 0.1;
  }

  _acquireBomblet() {
    for (const e of this._bombletPool) if (!e.used) { e.used = true; e.mesh.visible = true; return e; }
    return null; // pool exhausted (capped) — bomblet simulated without a mesh
  }
  _releaseBomblet(e) { if (e) { e.used = false; e.mesh.visible = false; } }

  _clearCluster(c) {
    if (!c) return;
    if (c.mesh && c.mesh.parent) c.mesh.parent.remove(c.mesh);
    for (const b of c.bomblets) this._releaseBomblet(b.pool);
    c.bomblets.length = 0;
  }

  _splitCluster(c) {
    c.phase = "bomblets";
    if (c.mesh.parent) c.mesh.parent.remove(c.mesh);
    c.mesh = null;
    this.audio.clusterPop();
    const cl = W.cluster;
    const rng = mulberry32(c.seed);
    for (let i = 0; i < cl.bombletCount; i++) {
      const ang = (i / cl.bombletCount) * Math.PI * 2 + rng() * 0.6;
      const spd = cl.spread * (0.6 + 0.6 * rng());
      const vx = Math.cos(ang) * spd, vz = Math.sin(ang) * spd, vy = cl.bombletUp * (0.6 + 0.8 * rng());
      const pool = this._acquireBomblet();
      const pos = c.pos.clone();
      if (pool) pool.mesh.position.copy(pos);
      c.bomblets.push({
        pos, vel: new THREE.Vector3(c.vel.x * 0.3 + vx, c.vel.y * 0.3 + vy, c.vel.z * 0.3 + vz),
        pool, age: 0, dead: false,
      });
    }
  }

  _tickClusters(dt) {
    if (this.clusters.length === 0) return;
    const cl = W.cluster;
    const cam = this._camPos();
    const keep = [];
    for (const c of this.clusters) {
      if (c.phase === "shell") {
        c.timer += dt;
        c.vel.y -= cl.gravity * dt;
        const step = c.vel.clone().multiplyScalar(dt);
        const dist = step.length();
        const dir = dist > 1e-6 ? step.clone().multiplyScalar(1 / dist) : new THREE.Vector3(0, -1, 0);
        const ray = new this.RAPIER.Ray(c.pos, dir);
        const hit = this.world.castRay(ray, Math.max(dist, 0.02), true, undefined, undefined, undefined, this.player.body);
        if (hit) c.pos.addScaledVector(dir, hit.toi); else c.pos.add(step);
        if (c.mesh) c.mesh.position.copy(c.pos);
        if (c.timer >= cl.splitDelay || hit) this._splitCluster(c);
        keep.push(c);
        continue;
      }
      // bomblet phase
      for (const b of c.bomblets) {
        if (b.dead) continue;
        b.age += dt;
        b.vel.y -= cl.bombletGravity * dt;
        const step = b.vel.clone().multiplyScalar(dt);
        const dist = step.length();
        const dir = dist > 1e-6 ? step.clone().multiplyScalar(1 / dist) : new THREE.Vector3(0, -1, 0);
        const ray = new this.RAPIER.Ray(b.pos, dir);
        const hit = this.world.castRay(ray, Math.max(dist, 0.05), true, undefined, undefined, undefined, this.player.body);
        if (hit || b.age > cl.bombletLifetime) {
          const point = hit ? b.pos.clone().addScaledVector(dir, hit.toi) : b.pos.clone();
          // Each bomblet blast is staggered through the stage queue (solo) so 6 never land in one frame.
          this._explode(point, cl.bombletForce, cl.bombletRadius, cl.bombletBudget, true);
          this.audio.clusterCrump(cam.distanceTo(point));
          this._releaseBomblet(b.pool);
          b.dead = true;
          continue;
        }
        b.pos.add(step);
        if (b.pool) b.pool.mesh.position.copy(b.pos);
      }
      c.bomblets = c.bomblets.filter((b) => !b.dead);
      if (c.bomblets.length > 0) keep.push(c);
    }
    this.clusters = keep;
  }

  // --- Shotgun ---
  _fireShotgun(item) {
    if (this._time - item.state.lastUse < W.shotgun.fireInterval) return;
    item.state.lastUse = this._time;
    this.audio.gunshot();
    this._recoilZ += 0.09;
    this._recoilPitch += 0.12;

    const origin = this._camPos();
    const muzzle = this._muzzleWorld(item);
    this._flash(muzzle);
    if (this.net) this.net.sendFx("gunshot", muzzle);
    const fwd = this._aimDir();
    const ref = Math.abs(fwd.y) < 0.99 ? UP : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(fwd, ref).normalize();
    const v = new THREE.Vector3().crossVectors(fwd, u).normalize();
    const maxR = Math.tan((W.shotgun.spreadDeg * Math.PI) / 180);

    const hits = new Map();
    for (let i = 0; i < W.shotgun.pelletCount; i++) {
      const r = maxR * Math.sqrt(Math.random());
      const th = Math.random() * Math.PI * 2;
      const dir = fwd.clone().addScaledVector(u, r * Math.cos(th)).addScaledVector(v, r * Math.sin(th)).normalize();
      const ray = new this.RAPIER.Ray(origin, dir);
      const hit = this.world.castRay(ray, W.shotgun.range, true, undefined, undefined, undefined, this.player.body);
      const tracerLen = hit
        ? Math.max(0.5, origin.clone().addScaledVector(dir, hit.toi).distanceTo(muzzle))
        : FX.tracerMaxLen;
      this._spawnTracer(muzzle, dir, tracerLen);
      if (hit && this.destruction.hasChunk(hit.collider.handle)) {
        const h = hits.get(hit.collider.handle);
        if (h) h.count++; else hits.set(hit.collider.handle, { count: 1 });
      }
    }
    for (const [handle, h] of hits) {
      this.destruction.applyPointDamage(handle, origin, W.shotgun.pelletForce * h.count);
    }
  }

  // --- Rocket launcher ---
  _fireRocket(item) {
    if (this._time - item.state.lastUse < W.rocket.fireInterval) return;
    if (this.liveRockets.length >= W.rocket.maxLive) return;
    item.state.lastUse = this._time;

    const dir = this._aimDir();
    const muzzleLocal = new THREE.Vector3(this._currentBaseOffset.x, this._currentBaseOffset.y, this._currentBaseOffset.z - this._launcherLen);
    const origin = this.camera.localToWorld(muzzleLocal);
    const mesh = new THREE.Mesh(this._rocketGeo, this.materials);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.position.copy(origin);
    mesh.quaternion.setFromUnitVectors(FWD_Z, dir);
    this.scene.add(mesh);
    const rid = this._ridCounter++;
    this.liveRockets.push({ mesh, pos: origin.clone(), vel: dir.clone().multiplyScalar(W.rocket.speed), age: 0, trailTimer: 0, rid });
    // MP: fire locally for responsiveness AND relay the launch so remotes see the projectile.
    if (this.net) this.net.sendRocket(rid, origin, dir);
    this._flash(origin);
    this.audio.rocketLaunch();
    this._recoilZ += 0.14;
    this._recoilPitch += 0.12;
  }

  _tickRockets(dt) {
    if (this.liveRockets.length === 0) return;
    const cam = this._camPos();
    const keep = [];
    for (const rk of this.liveRockets) {
      rk.age += dt;
      if (rk.age > W.rocket.lifetime) { this.scene.remove(rk.mesh); continue; }
      const step = rk.vel.clone().multiplyScalar(dt);
      const dist = step.length();
      const dir = step.clone().normalize();
      const ray = new this.RAPIER.Ray(rk.pos, dir);
      const hit = this.world.castRay(ray, dist, true, undefined, undefined, undefined, this.player.body);
      if (hit) {
        const point = rk.pos.clone().addScaledVector(dir, hit.toi);
        if (this.net) {
          // MP: explode visually but let the SERVER apply the damage (radial dmg intent + end relay).
          this.net.sendDmgRadial(point, W.rocket.force, W.rocket.radius);
          this.net.sendRocketEnd(rk.rid, point);
        } else {
          this.destruction.applyRadialDamage(point, W.rocket.force, W.rocket.radius, W.explosionDetachBudget);
        }
        this.audio.explosion(cam.distanceTo(point));
        this.scene.remove(rk.mesh);
        continue;
      }
      rk.pos.add(step);
      rk.mesh.position.copy(rk.pos);
      rk.mesh.quaternion.setFromUnitVectors(FWD_Z, dir);
      rk.trailTimer += dt;
      if (rk.trailTimer >= W.rocket.trailInterval) { rk.trailTimer -= W.rocket.trailInterval; this._spawnTrail(rk.pos); }
      keep.push(rk);
    }
    this.liveRockets = keep;
  }

  _spawnTrail(pos) {
    const t = this._trail[this._trailIdx];
    this._trailIdx = (this._trailIdx + 1) % this._trail.length;
    t.mesh.position.copy(pos);
    t.mesh.scale.setScalar(1);
    t.mesh.visible = true;
    t.life = W.rocket.trailLife;
  }

  _tickTrail(dt) {
    for (const t of this._trail) {
      if (t.life <= 0) continue;
      t.life -= dt;
      const s = Math.max(0, t.life / W.rocket.trailLife);
      t.mesh.scale.setScalar(s);
      if (s <= 0.001) t.mesh.visible = false;
    }
  }

  // ============================ Phase 7 batch B: Grab & Force ================================
  // Shared cone query over DYNAMIC bodies (debris chunk bodies + local drivable vehicles). Foundation for
  // Wind / Vacuum / Magnet. NEVER touches fixed chunks and never adds anyone to allowedImpactors.
  // Returns [{ body, pos:Vector3, dist, kind:"debris"|"vehicle", entry?, vehicle? }].
  _coneBodies(apex, dir, range, cosHalf, opts = {}) {
    const out = [];
    const tmp = new THREE.Vector3();
    if (opts.debris !== false) {
      this.destruction.forEachDebris((d) => {
        if (opts.metalOnly && d.vol.materialClass !== "metal") return;
        const t = d.body.translation();
        tmp.set(t.x - apex.x, t.y - apex.y, t.z - apex.z);
        const dist = tmp.length();
        if (dist < 1e-3 || dist > range) return;
        if (tmp.dot(dir) / dist < cosHalf) return;
        out.push({ body: d.body, pos: new THREE.Vector3(t.x, t.y, t.z), dist, kind: "debris", entry: d });
      });
    }
    if (opts.vehicles && this.manager && this.manager.all) {
      for (const v of this.manager.all) {
        if (!v.body || !v.V || typeof v.centerWorld !== "function") continue; // defensive: skip odd controllers
        if (v === this.manager.driven) continue; // don't shove/grab the car you're driving
        if (opts.massMax && v.V.mass > opts.massMax) continue;
        const c = v.centerWorld();
        tmp.set(c.x - apex.x, c.y - apex.y, c.z - apex.z);
        const dist = tmp.length();
        if (dist < 1e-3 || dist > range) continue;
        if (tmp.dot(dir) / dist < cosHalf) continue;
        out.push({ body: v.body, pos: c, dist, kind: "vehicle", vehicle: v });
      }
    }
    return out;
  }

  // --- 5d. Wind Cannon: one-shot cone impulse to all dynamic bodies, ZERO destruction, 1/dist falloff ---
  _fireWind(item) {
    const wc = W.windCannon;
    if (this._time - item.state.lastUse < wc.cooldown) return;
    item.state.lastUse = this._time;
    const dir = this._aimDir();
    const apex = this._muzzleWorld(item);
    const cosHalf = Math.cos((wc.halfAngleDeg * Math.PI) / 180);
    const bodies = this._coneBodies(apex, dir, wc.range, cosHalf, { debris: true, vehicles: true });
    for (const b of bodies) {
      const falloff = 1 - b.dist / wc.range;
      const mass = b.body.mass ? b.body.mass() : 1;
      // Mass-capped impulse: light debris is shoved (<= maxDV m/s), heavy chunks only nudge — reads as wind.
      let impMag = Math.min(wc.impulse * falloff, mass * wc.maxDV);
      if (b.kind === "vehicle") impMag *= wc.vehicleFactor;
      const away = b.pos.clone().sub(apex);
      if (away.lengthSq() < 1e-6) away.copy(dir); else away.normalize();
      b.body.applyImpulse({ x: away.x * impMag, y: away.y * impMag + impMag * 0.15, z: away.z * impMag }, true);
    }
    this._spawnDust(apex, dir);
    this.audio.windWhoomp();
    this._recoilZ += 0.12;
    // MP note (stub): remote-player knockback + server-owned debris would travel as a "wind" impulse intent.
  }

  _spawnDust(apex, dir) {
    const d = W.windCannon.dust;
    for (let i = 0; i < d.count; i++) {
      const e = this._dust[this._dustIdx];
      this._dustIdx = (this._dustIdx + 1) % this._dust.length;
      const along = (i / d.count) * W.windCannon.range * 0.6;
      const off = new THREE.Vector3((Math.random() * 2 - 1) * d.spread, (Math.random() * 2 - 1) * d.spread, (Math.random() * 2 - 1) * d.spread);
      e.mesh.position.copy(apex).addScaledVector(dir, along).add(off);
      e.mesh.scale.setScalar(d.size * (0.6 + Math.random() * 0.8));
      e.mesh.material.opacity = 0.5;
      e.mesh.visible = true;
      e.life = d.life;
      e.vel.copy(dir).multiplyScalar(d.speed).addScaledVector(off, 0.5);
    }
  }

  _tickDust(dt) {
    for (const e of this._dust) {
      if (e.life <= 0) continue;
      e.life -= dt;
      if (e.life <= 0) { e.mesh.visible = false; continue; }
      e.mesh.position.addScaledVector(e.vel, dt);
      e.vel.multiplyScalar(1 - Math.min(1, 3 * dt));
      e.mesh.material.opacity = 0.5 * (e.life / W.windCannon.dust.life);
      e.mesh.quaternion.copy(this.camera.quaternion); // billboard toward the viewer
    }
  }

  // --- Grab & Force per-frame dispatcher (walk mode). Manages the category's looping audio too. ---
  _tickGrabForce(dt, equipped, lmb, rmb) {
    const item = equipped ? this._activeItem() : null;
    const kind = item ? item.kind : null;
    // Release anything owned by a tool we're no longer holding.
    if (kind !== "gravitygun" && this._gravHeld) this._releaseGrav();
    if (kind !== "grapple" && (this._grappleFoot || this._grappleHook)) this._detachFootGrapple();
    if (kind !== "vacuum" && this._vacShrunk.size) this._restoreShrunk();

    let magnetMode = null;
    if (kind === "vacuum") this._tickVacuum(dt, item);
    else if (kind === "magnet") {
      magnetMode = this.input.lmbDown ? "attract" : (this.input.rmbDown ? "repel" : null);
      this._tickMagnet(dt, item, magnetMode);
    } else if (kind === "gravitygun") this._tickGravity(dt, item, rmb);
    else if (kind === "grapple") this._tickGrappleFoot(dt, item, lmb);

    // Looping audio (set explicitly every frame so switching tools silences the others).
    this.audio.vacuum(kind === "vacuum" && this.input.lmbDown);
    this.audio.magnet(magnetMode);
    this.audio.gravityHum(kind === "gravitygun" && !!this._gravHeld);
    this.audio.grappleReel(kind === "grapple" && !!(this._grappleFoot && this._grappleFoot.reeling));

    if (this._strainT > 0) this._strainT = Math.max(0, this._strainT - dt);
  }

  _silenceGrabForceAudio() {
    this.audio.vacuum(false); this.audio.magnet(null); this.audio.gravityHum(false); this.audio.grappleReel(false);
  }

  // --- 5e. Debris Vacuum: hold LMB, velocity-steer debris toward the muzzle, consume within ~1 m ---
  _tickVacuum(dt, item) {
    const vc = W.vacuum;
    if (!this.input.lmbDown) { this._restoreShrunk(); return; }
    const dir = this._aimDir();
    const muzzle = this._muzzleWorld(item);
    const cosHalf = Math.cos((vc.halfAngleDeg * Math.PI) / 180);
    const bodies = this._coneBodies(muzzle, dir, vc.range, cosHalf, { debris: true });
    const stillShrunk = new Set();
    const consumed = [];
    const to = new THREE.Vector3();
    for (const b of bodies) {
      to.set(muzzle.x - b.pos.x, muzzle.y - b.pos.y, muzzle.z - b.pos.z);
      const dist = to.length();
      if (dist < 1e-4) continue;
      to.multiplyScalar(1 / dist);
      const falloff = 1 - b.dist / vc.range;
      const mass = b.body.mass ? b.body.mass() : 1;
      const vel = b.body.linvel();
      const vAlong = vel.x * to.x + vel.y * to.y + vel.z * to.z;
      const desired = vc.suckSpeed * (0.4 + 0.6 * falloff);
      const dv = (desired - vAlong) * Math.min(1, vc.steer * dt); // velocity-steer toward the muzzle
      b.body.applyImpulse({ x: to.x * dv * mass, y: to.y * dv * mass, z: to.z * dv * mass }, true);
      if (b.entry && b.entry.mesh && dist < vc.shrinkFrom) {
        const s = THREE.MathUtils.clamp((dist - vc.consumeDist) / (vc.shrinkFrom - vc.consumeDist), 0.15, 1);
        b.entry.mesh.scale.setScalar(s);
        this._vacShrunk.add(b.entry); stillShrunk.add(b.entry);
      }
      if (dist <= vc.consumeDist) consumed.push({ entry: b.entry, dist: b.dist });
    }
    // Restore debris that left the shrink zone this frame.
    for (const e of this._vacShrunk) if (!stillShrunk.has(e) && e.mesh) e.mesh.scale.setScalar(1);
    this._vacShrunk = stillShrunk;
    // Consume (permanent disposal via the public API — frees the 200 cap).
    for (const c of consumed) {
      this._vacShrunk.delete(c.entry);
      if (this.destruction.consumeDebris(c.entry)) this.audio.vacuumThup(c.dist);
    }
  }

  _restoreShrunk() {
    for (const e of this._vacShrunk) if (e.mesh) e.mesh.scale.setScalar(1);
    this._vacShrunk.clear();
  }

  // --- 5b. Magnet Gun: metal-only stateless force field. Hold LMB attract / hold RMB repel, 10 nearest ---
  _tickMagnet(dt, item, mode) {
    if (!mode) return;
    const mg = W.magnet;
    const dir = this._aimDir();
    const muzzle = this._muzzleWorld(item);
    const cosHalf = Math.cos((mg.halfAngleDeg * Math.PI) / 180);
    let bodies = this._coneBodies(muzzle, dir, mg.range, cosHalf, { debris: true, metalOnly: true, vehicles: true, massMax: mg.massMax });
    bodies.sort((a, b) => a.dist - b.dist);
    if (bodies.length > mg.maxTargets) bodies = bodies.slice(0, mg.maxTargets);
    const sign = mode === "attract" ? 1 : -1;
    const to = new THREE.Vector3();
    for (const b of bodies) {
      to.set(muzzle.x - b.pos.x, muzzle.y - b.pos.y, muzzle.z - b.pos.z);
      const dist = to.length();
      if (dist < 1e-4) continue;
      to.multiplyScalar(sign / dist); // + = toward muzzle (attract), - = away (repel)
      const mass = b.body.mass ? b.body.mass() : 1;
      const vel = b.body.linvel();
      const vAlong = vel.x * to.x + vel.y * to.y + vel.z * to.z;
      const falloff = 1 - b.dist / mg.range;
      let desired = mg.pullSpeed * (0.4 + 0.6 * falloff);
      if (mode === "attract" && dist < mg.clampDist) desired = 0; // soft clamp: park at the muzzle, no carry
      const dv = (desired - vAlong) * Math.min(1, mg.steer * dt);
      b.body.applyImpulse({ x: to.x * dv * mass, y: to.y * dv * mass, z: to.z * dv * mass }, true);
    }
  }

  // --- 5a. Gravity Gun: hold LMB to grab one dynamic body, spring-hold ahead of camera, RMB throws ---
  _tickGravity(dt, item, rmb) {
    const cfg = W.gravityGun;
    const camPos = this._camPos();
    const aim = this._aimDir();
    if (this.input.lmbDown && !this._gravHeld) this._acquireGrav(camPos, aim, cfg);
    if (!this.input.lmbDown && this._gravHeld) { this._releaseGrav(); return; }
    if (!this._gravHeld) return;
    if (rmb) { this._throwGrav(aim); return; }
    // Validity: dropped if a held debris entry faded/was culled, or a held vehicle despawned.
    const h = this._gravHeld;
    if (h.entry && (h.entry.fading || this.destruction.debris.indexOf(h.entry) < 0)) { this._releaseGrav(); return; }
    if (h.vehicle && this.manager.all.indexOf(h.vehicle) < 0) { this._releaseGrav(); return; }
    if (h.kind === "prop" && !this.propaneTanks.some((t) => t.body === h.body && !t.disposed)) { this._releaseGrav(); return; } // tank exploded while held
    const keep = gravityHoldStep(camPos, aim, h.body, cfg, dt);
    if (!keep) { this._gravReleaseT += dt; if (this._gravReleaseT > cfg.releaseTime) this._releaseGrav(); }
    else this._gravReleaseT = 0;
  }

  _acquireGrav(camPos, aim, cfg) {
    const ray = new this.RAPIER.Ray(camPos, aim);
    const hit = this.world.castRay(ray, cfg.grabRange, true, undefined, undefined, undefined, this.player.body);
    if (!hit) return;
    const handle = hit.collider.handle;
    const entry = this.destruction.findDebrisByCollider(handle); // detached (debris) chunk only, never fixed
    if (entry) { this._gravHeld = { kind: "debris", body: entry.body, entry, mass: entry.body.mass ? entry.body.mass() : 1 }; this._gravReleaseT = 0; return; }
    // Propane tanks are grabbable props (a thrown tank explodes on hard impact — the sanctioned destructive gravity-throw).
    const tank = this.findPropByCollider(handle);
    if (tank) { this._gravHeld = { kind: "prop", body: tank.body, mass: tank.body.mass ? tank.body.mass() : 1 }; this._gravReleaseT = 0; return; }
    const veh = this.manager ? this.manager.byColliderHandle(handle) : null;
    if (veh && veh.body && veh.V) {
      if (veh === this.manager.driven) return;
      if (veh.V.mass > cfg.massMax) { this._strainT = cfg.strainTime; this._recoilPitch += 0.05; return; } // heavy -> strain refusal
      this._gravHeld = { kind: "vehicle", body: veh.body, vehicle: veh, mass: veh.V.mass }; this._gravReleaseT = 0;
    }
    // Ground / static / fixed chunk / player => not grabbable (no-op).
  }

  _releaseGrav() { this._gravHeld = null; this._gravReleaseT = 0; }

  _throwGrav(aim) {
    const h = this._gravHeld;
    const mass = h.body.mass ? h.body.mass() : h.mass;
    const speed = W.gravityGun.throwSpeed;
    // impulse = mass * speed => a consistent launch velocity along aim regardless of the body's mass.
    h.body.applyImpulse({ x: aim.x * speed * mass, y: (aim.y * speed + 2) * mass, z: aim.z * speed * mass }, true);
    // No-cascade rule: thrown debris is STILL debris — never registered as an impactor, so it knocks
    // things around by ordinary physics but can never detach a fixed chunk.
    this.audio.gravityThrow();
    this._recoilZ += 0.14; this._recoilPitch += 0.1;
    this._releaseGrav();
  }

  // --- 5c. Grapple Hook (on foot): ray-stepped hook -> manual distance-constraint on the capsule + reel ---
  _tickGrappleFoot(dt, item, lmb) {
    const g = W.grapple;
    if (lmb && !this._grappleHook && !this._grappleFoot) this._fireFootGrapple(item);
    if (this._grappleHook) { this._stepHook(dt, item); return; }
    if (this._grappleFoot) {
      if (!this.input.lmbDown) { this._detachFootGrapple(); return; }
      const reelIn = this.input.down("KeyW") || this._grappleWheel > 0; // scroll or hold-W = reel/zip
      this._grappleFoot.reeling = reelIn;
      if (reelIn) this._grappleFoot.ropeLen = Math.max(g.minLen, this._grappleFoot.ropeLen - g.reelRate * dt);
      this._grappleWheel = 0;
      this._drawRope(this._muzzleWorld(item), this._grappleFoot.anchor);
    } else {
      this._hideRope();
    }
  }

  _fireFootGrapple(item) {
    this._grappleHook = { pos: this._muzzleWorld(item), dir: this._aimDir(), traveled: 0 };
    this.audio.grappleLaunch();
    this._recoilZ += 0.06;
  }

  _stepHook(dt, item) {
    const g = W.grapple;
    const h = this._grappleHook;
    const step = g.hookSpeed * dt;
    const ray = new this.RAPIER.Ray(h.pos, h.dir);
    const hit = this.world.castRay(ray, step, true, undefined, undefined, undefined, this.player.body);
    if (hit) {
      const point = h.pos.clone().addScaledVector(h.dir, hit.toi);
      const pt = this.player.body.translation();
      const dist = Math.hypot(point.x - pt.x, point.y - pt.y, point.z - pt.z);
      this._anchorFoot(point, dist);
      this._grappleHook = null;
      return;
    }
    h.pos.addScaledVector(h.dir, step);
    h.traveled += step;
    this._drawRope(this._muzzleWorld(item), h.pos);
    if (h.traveled > g.range) { this._grappleHook = null; this._hideRope(); } // missed
  }

  _anchorFoot(point, dist) {
    const g = W.grapple;
    const st = { anchored: true, anchor: point.clone(), ropeLen: Math.max(g.minLen, dist), reeling: false };
    this._grappleFoot = st;
    this.audio.grappleAnchor(dist);
    // Install the player distance-constraint hook. Runs at the fixed physics rate (see player.js).
    this.player.grappleConstraint = (t, v, dtp) => {
      if (!st.anchored) return null;
      const ax = st.anchor.x - t.x, ay = st.anchor.y - t.y, az = st.anchor.z - t.z;
      const d = Math.sqrt(ax * ax + ay * ay + az * az);
      if (d < 1e-3 || d <= st.ropeLen) return null; // slack: rope exerts no force
      const nx = ax / d, ny = ay / d, nz = az / d;
      const vAlong = v.x * nx + v.y * ny + v.z * nz;
      let accel = g.pullK * (d - st.ropeLen) - g.pullDamp * vAlong;
      if (accel < 0) accel = 0; // a rope pulls, never pushes
      const dv = accel * dtp;
      return { x: nx * dv, y: ny * dv, z: nz * dv };
    };
  }

  _detachFootGrapple() {
    this._grappleFoot = null;
    this._grappleHook = null;
    this.player.grappleConstraint = null;
    this._hideRope();
  }

  _drawRope(from, to) {
    const segs = this._ropeSegs;
    const n = segs.length;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), ab = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      a.lerpVectors(from, to, i / n);
      b.lerpVectors(from, to, (i + 1) / n);
      const m = segs[i];
      ab.subVectors(b, a);
      const len = ab.length();
      m.position.copy(a).add(b).multiplyScalar(0.5);
      if (len > 1e-6) m.quaternion.setFromUnitVectors(FWD_Z, ab.multiplyScalar(1 / len));
      m.scale.set(W.grapple.thickness, W.grapple.thickness, Math.max(0.001, len));
      m.visible = true;
    }
  }

  _hideRope() { for (const m of this._ropeSegs) m.visible = false; }

  // --- 5c. Grapple Hook (while driving): real Rapier spring joint chunk<->chassis; tension tears the chunk ---
  // MP note: on-foot swing is client-predicted movement (same reconciliation bucket as normal movement);
  // the vehicle rope is a server-side joint — the tear routes through the normal server-authoritative
  // applyPointDamage path (replica forwards it as a point-dmg intent).
  _tickVehicleGrapple(dt) {
    if (this.activeCat < 0) { if (this._vgrapple) this._detachVehicleGrapple(); return; }
    if (this._activeItem().kind !== "grapple") { if (this._vgrapple) this._detachVehicleGrapple(); return; }
    const v = this.manager.driven;
    if (!v || !v.body) { if (this._vgrapple) this._detachVehicleGrapple(); return; }
    const fire = this.input.consumeLMB();
    if (!this.input.lmbDown && this._vgrapple) { this._detachVehicleGrapple(); return; }
    if (fire && !this._vgrapple) this._fireVehicleGrapple(v);
    if (this._vgrapple) this._stepVehicleRope(dt, v);
  }

  _fireVehicleGrapple(v) {
    const g = W.grapple.veh;
    const chassis = v.body;
    const cpos = v.centerWorld();
    const aim = this._aimDir();
    const ray = new this.RAPIER.Ray(cpos, aim);
    const hit = this.world.castRay(ray, g.maxLen, true, undefined, undefined, undefined, chassis);
    if (!hit) return;
    const handle = hit.collider.handle;
    const r = this.destruction.registry.get(handle);
    if (!r) return; // only destructible chunks can be roped/torn (world/static/vehicle => no rope)
    const point = cpos.clone().addScaledVector(aim, hit.toi);
    const chunkBody = r.chunk.body;
    const cq = v.quaternion();
    const localA = point.clone().sub(cpos).applyQuaternion(cq.clone().invert()); // chassis-local
    const ct = chunkBody.translation();
    const localB = new THREE.Vector3(point.x - ct.x, point.y - ct.y, point.z - ct.z); // chunk-local
    const restLen = Math.max(1.0, cpos.distanceTo(point) * g.restSlack);
    let joint = null;
    if (this._hasSpringJoint) {
      try {
        const jd = this.RAPIER.JointData.spring(restLen, g.spring, g.damp, localA, localB);
        joint = this.world.createImpulseJoint(jd, chassis, chunkBody, true);
      } catch (e) { joint = null; }
    }
    this._vgrapple = { joint, chunk: r.chunk, vol: r.volume, colliderHandle: handle, localA, localB, restLen, torn: !r.chunk.active };
    this.audio.grappleLaunch();
    this.audio.grappleAnchor(hit.toi);
  }

  _stepVehicleRope(dt, v) {
    const g = W.grapple.veh;
    const vg = this._vgrapple;
    // If the torn chunk's body was disposed (cap/sleep cull), the anchor is gone — drop the rope.
    if (vg.torn && !this.destruction.registry.has(vg.colliderHandle)) { this._detachVehicleGrapple(); return; }
    const chunkBody = vg.chunk.body;
    if (!chunkBody) { this._detachVehicleGrapple(); return; }
    const cpos = v.centerWorld();
    const cq = v.quaternion();
    const worldA = vg.localA.clone().applyQuaternion(cq).add(cpos);
    const ct = chunkBody.translation(), cr = chunkBody.rotation();
    const qB = new THREE.Quaternion(cr.x, cr.y, cr.z, cr.w);
    const worldB = vg.localB.clone().applyQuaternion(qB).add(new THREE.Vector3(ct.x, ct.y, ct.z));
    const delta = worldB.clone().sub(worldA);
    const dist = delta.length();
    const tension = g.spring * Math.max(0, dist - vg.restLen); // geometric tension estimate
    this._drawRope(worldA, worldB);

    // Manual spring path (when Rapier's spring joint isn't available): pull the chassis toward the chunk;
    // a torn (dynamic) chunk also gets pulled so it drags behind the car. A live joint does this itself.
    if (!vg.joint && dist > 1e-3) {
      const n = delta.multiplyScalar(1 / dist);
      const va = v.body.linvel();
      const vb = chunkBody.linvel ? chunkBody.linvel() : { x: 0, y: 0, z: 0 };
      const relV = (vb.x - va.x) * n.x + (vb.y - va.y) * n.y + (vb.z - va.z) * n.z;
      const f = g.spring * (dist - vg.restLen) - g.damp * relV;
      if (f > 0) {
        const imp = f * dt;
        v.body.applyImpulse({ x: n.x * imp, y: n.y * imp, z: n.z * imp }, true);
        if (vg.torn) chunkBody.applyImpulse({ x: -n.x * imp, y: -n.y * imp, z: -n.z * imp }, true);
      }
    }

    // TEAR: chunk still attached + tension over threshold-scale -> rip it out (+ neighbor ring, normal path).
    if (vg.chunk.active && tension > g.tearTension) {
      this.destruction.applyPointDamage(vg.colliderHandle, cpos, g.tearForce);
      vg.torn = true; // still debris — NEVER added to allowedImpactors (no-cascade rule stands)
    }
    // SNAP: excessive tension -> break the rope.
    if (tension > g.snapTension) { this.audio.grappleSnap(cpos.distanceTo(worldB)); this._detachVehicleGrapple(); }
  }

  _detachVehicleGrapple() {
    const vg = this._vgrapple;
    if (!vg) return;
    if (vg.joint) { try { this.world.removeImpulseJoint(vg.joint, true); } catch (e) {} }
    this._vgrapple = null;
    this._hideRope();
  }

  // ============================ Phase 7 batch C: Strikes + heavy/vehicular ordnance ============
  // MP note (flag): the ORBITAL carve and the airstrike Penetrator are fully networked now — they go out as
  // `dmg kind:"carve"` and the server runs the real carveCylinder (see destruction.carveCylinder). What is
  // still simplified is this shared big-blast helper: the nuke's radius-18 staged collapse and the painted
  // set forward a cap-fitting radial intent instead, so a replica nuke is smaller than a solo one. Server
  // owns the detach either way; nothing exceeds the caps. Deliberate, NOT a redesign.
  _bigBlast(center, force, radius, budget, staged) {
    if (this.net) {
      const f = Math.min(force, CAPS.radialForceMax), r = Math.min(radius, CAPS.radialRadiusMax);
      this.destruction.applyRadialDamage(center, f, r, budget); // forwards a valid radial intent
      return;
    }
    if (staged) this.destruction.enqueueRadialJobs([{ center, force, radius, budget }]);
    else this.destruction.applyRadialDamage(center, force, radius, budget);
  }

  // Camera shake (nuke). Purely transient: it is layered on top of whatever camera transform the rest of
  // the engine computed this frame (FPP rig / chase rig / RC or plane view cam) and always unwinds itself.
  _startShake(time, amp) {
    this._shakeT = time;
    this._shakeDur = time;
    this._shakeAmp = amp;
    this._shakeEnd = nowSeconds() + time;
  }
  // Drops the shake AND any offset still sitting on the camera. Safe to call at any time.
  _clearShake() {
    this._shakeT = 0; this._shakeAmp = 0; this._shakeDur = 0; this._shakeEnd = 0;
    this._unapplyShake();
  }
  // Removes last frame's kick, but only if nothing else has moved the camera since — when the engine
  // re-places the camera every frame (the normal case) the offset is already gone with the old transform.
  _unapplyShake() {
    if (!this._shakeApplied) return;
    this._shakeApplied = false;
    if (this.camera.position.distanceToSquared(this._shakePost) < 1e-12) {
      this.camera.position.sub(this._shakeOffset);
    }
    this._shakeOffset.set(0, 0, 0);
  }
  _applyShake() {
    this._unapplyShake();
    if (this._shakeT <= 0) return;
    const dur = this._shakeDur || W.nuke.shakeTime;
    const k = THREE.MathUtils.clamp(this._shakeT / dur, 0, 1);
    const a = this._shakeAmp * k * k;
    this._shakeOffset.set(
      (Math.random() * 2 - 1) * a,
      (Math.random() * 2 - 1) * a,
      (Math.random() * 2 - 1) * a
    );
    this.camera.position.add(this._shakeOffset);
    this._shakePost.copy(this.camera.position);
    this._shakeApplied = true;
  }
  // Decays on dt AND on a wall-clock deadline, so a shake started before a pause (menu, unfocused tab,
  // a mode that skips rendering) is already spent when the frame loop resumes instead of freezing.
  _tickShake(dt) {
    if (this._shakeT <= 0) return;
    this._shakeT = Math.min(this._shakeT - dt, this._shakeEnd - nowSeconds());
    if (this._shakeT <= 0) this._clearShake();
  }

  // --- 2d. Blast Painter: hold LMB spray-paints chunks (pooled splats), RMB detonatePainted them all ---
  _tickBlastPainter(dt, equipped) {
    const item = equipped ? this._activeItem() : null;
    const spraying = !!(item && item.kind === "blastpainter" && this.input.lmbDown);
    this.audio.blastSpray(spraying);
    if (!spraying) { this._paintTimer = 0; return; }
    this._paintTimer += dt;
    if (this._paintTimer < W.blastPainter.tickInterval) return;
    this._paintTimer = 0;
    const origin = this._camPos();
    const dir = this._aimDir();
    const ray = new this.RAPIER.Ray(origin, dir);
    const hit = this.world.castRayAndGetNormal(ray, W.blastPainter.range, true, undefined, undefined, undefined, this.player.body);
    if (!hit) return;
    const r = this.destruction.registry.get(hit.collider.handle);
    if (!r || !r.chunk.active) return;
    const key = r.volume.id + ":" + r.chunk.id;
    if (this._painted.has(key)) return;
    const point = origin.clone().addScaledVector(dir, hit.toi);
    const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
    if (normal.lengthSq() < 1e-6) normal.set(0, 1, 0); else normal.normalize();
    const pooled = this._acquireSplat();
    if (pooled) {
      pooled.mesh.position.copy(point).addScaledVector(normal, 0.03);
      pooled.mesh.quaternion.setFromUnitVectors(FWD_Z, normal);
      pooled.mesh.scale.setScalar(W.blastPainter.splatSize + Math.random() * 0.06);
      pooled.mesh.visible = true;
    }
    this._painted.set(key, { splat: pooled });
    while (this._painted.size > W.blastPainter.maxPainted) {
      const oldestKey = this._painted.keys().next().value;
      this._releaseSplat(this._painted.get(oldestKey).splat);
      this._painted.delete(oldestKey);
    }
  }
  _acquireSplat() { for (const e of this._splatPool) if (!e.used) { e.used = true; return e; } return null; }
  _releaseSplat(e) { if (e) { e.used = false; e.mesh.visible = false; } }

  _detonatePaint() {
    if (this._painted.size === 0) return;
    this.audio.armBeep();
    this.destruction.detonatePainted(new Set(this._painted.keys()), W.blastPainter.force);
    const cam = this._camPos();
    this.audio.explosion(0);
    this.audio.explosion(4);
    for (const rec of this._painted.values()) this._releaseSplat(rec.splat);
    this._painted.clear();
    this._recoilZ += 0.1;
    void cam;
  }

  // --- 2e. Propane Tank: thrown dynamic body; explodes on shot / hard impact / blast chain -----------
  _throwPropane(item) {
    if (this._time - item.state.lastUse < W.propane.fireInterval) return;
    item.state.lastUse = this._time;
    const pr = W.propane;
    while (this.propaneTanks.length >= pr.maxLive) { const old = this.propaneTanks.shift(); this._disposeTank(old); }
    const dir = this._aimDir();
    const origin = this._muzzleWorld(item);
    const lv = { x: dir.x * pr.throwSpeed, y: dir.y * pr.throwSpeed + pr.upBias, z: dir.z * pr.throwSpeed };
    const bodyDesc = this.RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(origin.x, origin.y, origin.z)
      .setLinvel(lv.x, lv.y, lv.z)
      .setAngvel({ x: Math.random() * 4 - 2, y: Math.random() * 4 - 2, z: Math.random() * 4 - 2 })
      .setCcdEnabled(true).setCanSleep(true);
    const body = this.world.createRigidBody(bodyDesc);
    const cd = this.RAPIER.ColliderDesc.cylinder(pr.colliderHalf, pr.colliderRadius)
      .setRestitution(0.2).setFriction(0.85).setDensity(pr.density);
    const collider = this.world.createCollider(cd, body);
    const mesh = new THREE.Mesh(this._propaneGeo, this.materials);
    mesh.castShadow = true; mesh.position.copy(origin);
    this.scene.add(mesh);
    const tank = {
      body, collider, mesh, exploded: false, queued: false, disposed: false, age: 0,
      prevVel: new THREE.Vector3(lv.x, lv.y, lv.z), chainR: pr.chainR,
    };
    tank.pos = () => { const t = body.translation(); return new THREE.Vector3(t.x, t.y, t.z); };
    tank.explode = () => this._explodePropane(tank);
    this.destruction.registerDamageableProp(collider.handle, tank);
    this.propaneTanks.push(tank);
    this.audio.propaneClonk(0);
    this._recoilZ -= 0.05;
  }

  _tickPropane(dt) {
    if (this.propaneTanks.length === 0) return;
    const keep = [];
    const cur = new THREE.Vector3();
    for (const tank of this.propaneTanks) {
      if (tank.exploded || tank.disposed) continue;
      tank.age += dt;
      const t = tank.body.translation();
      const rr = tank.body.rotation();
      tank.mesh.position.set(t.x, t.y, t.z);
      tank.mesh.quaternion.set(rr.x, rr.y, rr.z, rr.w);
      const lv = tank.body.linvel();
      cur.set(lv.x, lv.y, lv.z);
      const dv = cur.distanceTo(tank.prevVel);
      tank.prevVel.copy(cur);
      // Hard impact = a big single-frame velocity change (NOT via allowedImpactors, no cascade). Grace
      // period so the launch impulse itself doesn't count.
      if (tank.age > 0.3 && dv > W.propane.impactDV) { this._explodePropane(tank); continue; }
      keep.push(tank);
    }
    this.propaneTanks = keep;
  }

  _explodePropane(tank) {
    if (tank.exploded) return;
    tank.exploded = true;
    const p = tank.pos();
    this._disposeTank(tank);
    this._bigBlast(p, W.propane.force, W.propane.radius, W.propane.budget, false);
    this.audio.explosion(this._camPos().distanceTo(p));
  }
  _disposeTank(tank) {
    if (!tank || tank.disposed) return;
    tank.disposed = true; tank.exploded = true;
    this.destruction.unregisterDamageableProp(tank.collider.handle);
    if (tank.mesh && tank.mesh.parent) tank.mesh.parent.remove(tank.mesh);
    try { this.world.removeRigidBody(tank.body); } catch (e) {}
  }

  // Propane tanks are grabbable by the Gravity Gun (a thrown tank explodes on hard impact — the sanctioned
  // gravity-throw destruction path). Resolve a collider handle to a live tank body, or null.
  findPropByCollider(handle) {
    const tank = this.propaneTanks.find((t) => !t.disposed && t.collider.handle === handle);
    return tank || null;
  }

  // --- 6c. Nuke: thrown device, 5 s accelerating beep, flash + shake + staged radius-18 collapse -----
  _throwNuke(item) {
    if (this._nukeArmed) return;
    if (this._time - this._nukeCooldownT < W.nuke.cooldown) return;
    this._nukeArmed = true;
    const nk = W.nuke;
    const dir = this._aimDir();
    const origin = this._muzzleWorld(item);
    const bodyDesc = this.RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(origin.x, origin.y, origin.z)
      .setLinvel(dir.x * nk.throwSpeed, dir.y * nk.throwSpeed + nk.upBias, dir.z * nk.throwSpeed)
      .setCcdEnabled(true).setCanSleep(true);
    const body = this.world.createRigidBody(bodyDesc);
    const cd = this.RAPIER.ColliderDesc.cuboid(0.22, 0.16, 0.28).setDensity(400).setFriction(0.9).setRestitution(0.1);
    this.world.createCollider(cd, body);
    const mesh = new THREE.Mesh(this._nukeGeo, this.materials);
    mesh.castShadow = true; mesh.position.copy(origin);
    this.scene.add(mesh);
    this.nukes.push({ body, mesh, fuse: nk.countdown, nextBeep: 0 });
    this.audio.nukeArm();
    this._recoilZ -= 0.05;
  }

  _tickNukes(dt) {
    if (this.nukes.length === 0) return;
    const keep = [];
    for (const nk of this.nukes) {
      const t = nk.body.translation();
      const r = nk.body.rotation();
      nk.mesh.position.set(t.x, t.y, t.z);
      nk.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      nk.fuse -= dt;
      nk.nextBeep -= dt;
      if (nk.nextBeep <= 0) { this.audio.nukeBeep(); nk.nextBeep = Math.max(0.09, nk.fuse * 0.25); } // accelerating
      if (nk.fuse <= 0) { this._detonateNuke(nk); continue; }
      keep.push(nk);
    }
    this.nukes = keep;
  }

  _detonateNuke(nk) {
    const nkc = W.nuke;
    const t = nk.body.translation();
    const p = new THREE.Vector3(t.x, t.y, t.z);
    if (nk.mesh.parent) nk.mesh.parent.remove(nk.mesh);
    try { this.world.removeRigidBody(nk.body); } catch (e) {}
    // Effect (not HUD): fullscreen white flash + camera shake.
    this._flashT = nkc.flashTime; this._flashDur = nkc.flashTime; this._flashDiv.style.opacity = "1";
    this._startShake(nkc.shakeTime, nkc.shakeAmp);
    // ONE huge radial job fed ENTIRELY through the staged queue (debrisCap 200 never raised).
    this._bigBlast(p, nkc.force, nkc.radius, nkc.budget, true);
    // Pooled dust column at ground zero.
    this._dustCol.position.set(p.x, p.y + nkc.dustHeight / 2, p.z);
    this._dustCol.visible = true; this._dustColMat.opacity = 0.55; this._dustColT = nkc.dustLife;
    this.audio.nukeBlast(this._camPos().distanceTo(p));
    this.audio.nukeKlaxon();
    this._nukeArmed = false;
    this._nukeCooldownT = this._time;
  }

  _tickScreenFlash(dt) {
    if (this._flashT <= 0) return;
    this._flashT -= dt;
    const a = Math.max(0, this._flashT / this._flashDur);
    this._flashDiv.style.opacity = a <= 0 ? "0" : String(a);
  }
  _tickDustColumn(dt) {
    if (this._dustColT <= 0) return;
    this._dustColT -= dt;
    this._dustCol.position.y += dt * 2;
    this._dustColMat.opacity = 0.55 * Math.max(0, this._dustColT / W.nuke.dustLife);
    if (this._dustColT <= 0) this._dustCol.visible = false;
  }

  // --- 6b. Orbital Laser Designator: marker + 3 s countdown, vertical carveCylinder hole -------------
  _plantOrbital(item) {
    if (this._orbital) return;
    if (this._time - this._orbCooldownT < W.orbital.cooldown) return;
    const origin = this._camPos();
    const dir = this._aimDir();
    const ray = new this.RAPIER.Ray(origin, dir);
    const hit = this.world.castRay(ray, 200, true, undefined, undefined, undefined, this.player.body);
    if (!hit) return;
    const point = origin.clone().addScaledVector(dir, hit.toi);
    this._orbital = { pos: point, t: W.orbital.countdown, phase: "count", nextBeep: 0, beamT: 0 };
    this._orbMarker.position.set(point.x, point.y + 0.04, point.z); this._orbMarker.scale.setScalar(W.orbital.markerSize); this._orbMarker.visible = true;
    this._orbPillar.position.set(point.x, point.y + W.orbital.pillarHeight / 2, point.z); this._orbPillar.visible = true;
    this.audio.orbitalCharge();
    item.state.lastUse = this._time;
  }

  _tickOrbital(dt) {
    if (!this._orbital) return;
    const o = this._orbital;
    if (o.phase === "count") {
      o.t -= dt;
      o.nextBeep -= dt;
      if (o.nextBeep <= 0) { this.audio.orbitalBeep(); o.nextBeep = Math.max(0.08, o.t * 0.3); }
      const blink = Math.floor(this._time * (3 + (W.orbital.countdown - o.t) * 3)) % 2 === 0;
      this._orbMarker.visible = blink; this._orbPillar.visible = blink;
      if (o.t <= 0) {
        o.phase = "beam"; o.beamT = W.orbital.beamLife;
        this._fireOrbitalCarve(o);
        this.audio.orbitalZap();
        this.audio.explosion(this._camPos().distanceTo(o.pos));
      }
    } else {
      o.beamT -= dt;
      const on = o.beamT > 0;
      this._orbMarker.visible = false; this._orbPillar.visible = false;
      this._orbBeam.visible = on;
      if (on) {
        this._orbBeam.position.set(o.pos.x, o.pos.y + W.orbital.pillarHeight / 2, o.pos.z);
        const s = 0.7 + Math.random() * 0.5;
        this._orbBeamMat.opacity = 0.7 * (o.beamT / W.orbital.beamLife);
        this._orbBeam.scale.set(s, 1, s);
      } else { this._endOrbital(); }
    }
  }
  _fireOrbitalCarve(o) {
    const top = new THREE.Vector3(o.pos.x, o.pos.y + 5, o.pos.z);
    this.destruction.carveCylinder(top, new THREE.Vector3(0, -1, 0), W.orbital.throughGround, W.orbital.radius, W.orbital.force, W.orbital.carveBudget);
  }
  _endOrbital() {
    this._orbital = null;
    this._orbMarker.visible = false; this._orbPillar.visible = false; this._orbBeam.visible = false;
    this._orbCooldownT = this._time;
  }

  // --- 4d. Car Cannon: fires the hatchback mesh as a plain dynamic cuboid, temp-registered impactor ---
  _fireCarCannon(item) {
    if (this._time - this._carCooldownT < W.carCannon.cooldown) return;
    this._carCooldownT = this._time;
    while (this.carShots.length) this._removeCarShot(this.carShots[0]); // one live -> despawn old
    const cc = W.carCannon;
    const dir = this._aimDir();
    // Spawn far enough out that the 3.6 m long car body cannot start the frame already buried in whatever
    // the player is standing next to: a body spawned interpenetrating a wall is ejected by Rapier's
    // penetration recovery on step 1, which throws away the 30 m/s launch and leaves the car dribbling.
    // CAR_SPAWN_LEAD is half the body length plus clearance; if the muzzle already looks into geometry the
    // lead is shortened to the free distance so the car never spawns on the far side of a wall.
    const muzzle = this._muzzleWorld(item);
    const nose = CAR_SPAWN_LEAD + cc.half.z; // how far the front of the car reaches past the muzzle
    let lead = CAR_SPAWN_LEAD;
    const blocked = this.world.castRay(new this.RAPIER.Ray(muzzle, dir), nose + CAR_SPAWN_CLEARANCE, true, undefined, undefined, undefined, this.player.body);
    if (blocked) lead = Math.max(0.2, blocked.toi - CAR_SPAWN_CLEARANCE - cc.half.z);
    const origin = muzzle.addScaledVector(dir, lead);
    // The collider follows the flight direction like the mesh does. It used to be a world-axis box while
    // only the mesh was rotated, so a car fired along X collided as a 3.6 m wide slab.
    const q = new THREE.Quaternion().setFromUnitVectors(FWD_Z, dir);
    const bodyDesc = this.RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(origin.x, origin.y, origin.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinvel(dir.x * cc.speed, dir.y * cc.speed + cc.upBias, dir.z * cc.speed)
      .setAngvel({ x: Math.random() * cc.spin - cc.spin / 2, y: Math.random() * cc.spin - cc.spin / 2, z: Math.random() * cc.spin - cc.spin / 2 })
      .setCcdEnabled(true).setCanSleep(false);
    const body = this.world.createRigidBody(bodyDesc);
    const cd = this.RAPIER.ColliderDesc.cuboid(cc.half.x, cc.half.y, cc.half.z)
      .setDensity(cc.density).setFriction(0.6).setRestitution(0.05);
    const collider = this.world.createCollider(cd, body);
    // Temp-register in allowedImpactors for its lifetime => smashes structures via the vehicle-grade
    // contact-force detach path (the whole trick). Unregistered on despawn (proof of no leak in the report).
    this.destruction.registerImpactor(collider.handle, true); // heavy: the flung car smashes like a rammed vehicle
    const mesh = new THREE.Mesh(this._carCannonGeo, this.materials);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.position.copy(origin); mesh.quaternion.copy(q);
    this.scene.add(mesh);
    this.carShots.push({ body, collider, mesh, age: 0, fading: null, prevSpeed: cc.speed, netPulseT: 0 });
    this.audio.carCannonWhoosh();
    this._recoilZ += 0.2; this._recoilPitch += 0.14;
  }

  _tickCarShots(dt) {
    if (this.carShots.length === 0) return;
    const cc = W.carCannon;
    const keep = [];
    for (const s of this.carShots) {
      const t = s.body.translation();
      const r = s.body.rotation();
      s.mesh.position.set(t.x, t.y, t.z);
      s.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      s.age += dt;
      const lv = s.body.linvel();
      const speed = Math.hypot(lv.x, lv.y, lv.z);
      if (s.fading == null && s.prevSpeed - speed > 8) this.audio.carCannonCrash(this._camPos().distanceTo(s.mesh.position));
      s.prevSpeed = speed;
      if (this.net && s.fading == null) this._carShotNetDamage(s, t, lv, speed, dt);
      const atRest = s.age > 0.6 && speed < cc.restSpeed;
      if (s.fading == null && (s.age > cc.lifetime || atRest)) {
        s.fading = cc.fadeTime;
        this.destruction.unregisterImpactor(s.collider.handle); // stop smashing while it fades out
      }
      if (s.fading != null) {
        s.fading -= dt;
        s.mesh.scale.setScalar(Math.max(0, s.fading / cc.fadeTime));
        if (s.fading <= 0) { this._removeCarShot(s); continue; }
      }
      keep.push(s);
    }
    this.carShots = keep;
  }
  // MP ONLY (guarded by `this.net` at the single call site — solo never reaches this function, so the
  // offline Car Cannon is exactly what it was and can never be damaged twice). Once per CAR_MP_PULSE_SEC,
  // while the projectile is above the ram speed and there is real structure in front of it, carve a short
  // segment along its travel direction. The client's Destruction is a replica, so carveCylinder turns this
  // into the sanctioned `dmg kind:"carve"` intent and the SERVER does the detaching.
  //
  // Why carve and not a radial sphere: CAPS.dmgWithinSenderM caps a radial at 20 m from the sender and this
  // projectile crosses the whole map, so most pulses would be rejected outright; and a sphere at 60 Hz-ish
  // sampling leaves gaps between pulses that a 30 m/s car flies straight through. A segment covers the
  // ground actually travelled and rides the carve cap (120 m) instead.
  _carShotNetDamage(s, t, lv, speed, dt) {
    const D_ = CONFIG.destruction;
    s.netPulseT -= dt;
    if (s.netPulseT > 0) return;
    if (speed < D_.vehicleMinRamSpeed) return;
    const dir = new THREE.Vector3(lv.x / speed, lv.y / speed, lv.z / speed);
    const nose = new THREE.Vector3(t.x, t.y, t.z).addScaledVector(dir, D_.vehicleSweepLead);
    // Solo's sweep skips grid volumes so a car never ploughs the road; the server's carve does not know
    // the difference, so gate the pulse on structure being there at all. Also stops a car sailing over an
    // empty plaza from burning its rate-limit slots on nothing.
    if (!this.destruction.hasStructureNear(nose, D_.vehicleSweepRadius)) return;
    s.netPulseT = CAR_MP_PULSE_SEC;
    const len = THREE.MathUtils.clamp(speed * CAR_MP_PULSE_SEC, CAR_MP_LEN_MIN, CAR_MP_LEN_MAX);
    this.destruction.carveCylinder(nose, dir, len, D_.vehicleSweepRadius, D_.vehicleSweepForce * 0.5, D_.vehicleSweepBudget);
  }

  _removeCarShot(s) {
    this.destruction.unregisterImpactor(s.collider.handle); // idempotent
    if (s.mesh && s.mesh.parent) s.mesh.parent.remove(s.mesh);
    try { this.world.removeRigidBody(s.body); } catch (e) {}
    this.carShots = this.carShots.filter((x) => x !== s);
  }

  // --- 2f. RC Car Bomb: deploy a mini GroundVehicle; control transfers (chase cam, character frozen) --
  // MP note (flag): "a player controls an entity that is not their character" — same input-routing case as
  // vehicle driving. Solo drives it via the manager loop; in MP the RC car would be a server-owned vehicle
  // and the driving input routed like a normal seat (stubbed here: RC car is solo/authoritative only).
  _deployRc(item) {
    if (this._rc) return; // one alive
    const feet = this.player.feetPosition();
    const yaw = this._yaw();
    const veh = new GroundVehicle(this.scene, this.world, this.RAPIER, this._rcSpec, this.materials, { x: feet.x, y: feet.y + 0.1, z: feet.z, yaw });
    veh.water = this.manager.water || null;
    this.manager.all.push(veh);   // stepped by manager.update; driven flag => reads WASD
    this.manager.driven = veh;    // walk mode stays; main only uses `driven` in drive mode / cone-skip
    this._rc = { veh, badT: 0 };
    void item;
  }

  _tickRcActive(dt) {
    const rc = this._rc;
    if (!rc || !rc.veh || !rc.veh.body) { this._returnRc(false); return; }
    // Auto-return (no blast) if the car flips or falls off the world for autoReturnTime.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rc.veh.quaternion());
    const pos = rc.veh.centerWorld();
    if (up.y < W.rcCar.flipDot || pos.y < -5) {
      rc.badT += dt;
      if (rc.badT > W.rcCar.autoReturnTime) { this._returnRc(false); return; }
    } else rc.badT = 0;
    // RMB or LMB detonates wherever the car is.
    if (this.input.consumeLMB() || this.input.consumeRMB()) { this._detonateRc(); return; }
    this.input.consumeDigits(); this.input.consumeWheel(); // don't switch tools while driving the car
    this._rcChaseCam(rc.veh);
  }
  _rcChaseCam(veh) {
    const pos = veh.centerWorld();
    const q = veh.quaternion();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const camPos = pos.clone().addScaledVector(fwd, -W.rcCar.chaseBack);
    camPos.y += W.rcCar.chaseUp;
    this.camera.position.copy(camPos);
    this.camera.lookAt(pos.x, pos.y + W.rcCar.chaseLook, pos.z);
  }
  _detonateRc() {
    const veh = this._rc ? this._rc.veh : null;
    const p = veh ? veh.centerWorld() : this.player.feetPosition();
    this._bigBlast(p, W.rcCar.force, W.rcCar.radius, W.rcCar.budget, false);
    this.audio.explosion(this._camPos().distanceTo(p));
    this._returnRc(true);
  }
  _returnRc() {
    const rc = this._rc;
    this._rc = null;
    if (rc && rc.veh) {
      const veh = rc.veh;
      this.manager.all = this.manager.all.filter((x) => x !== veh);
      if (this.manager.driven === veh) this.manager.driven = null;
      veh.despawn();
    }
    this.audio.rcMotor(false);
    // Camera is restored automatically next frame (main re-applies FPP in walk mode).
  }

  // --- 6a. Airstrike Designator: scripted circling plane, R cycles 3 ammo, LMB designate, RMB plane-cam --
  // MP note (flag): the plane is a server-owned scripted entity in Phase 6; the plane-camera is purely
  // local (camera attach), only the designation events would sync. Here it is solo/authoritative.
  _tickAirstrike(dt, equipped) {
    const item = equipped ? this._activeItem() : null;
    const isAir = !!(item && item.kind === "airstrike");
    if (!isAir) { if (this._airPlane) this._despawnPlane(); this.audio.airPlaneLoop(false); this._prevR = false; return; }
    if (!this._airPlane) this._spawnPlane();
    const rDown = this.input.down("KeyR");
    if (rDown && !this._prevR) { this._airAmmo = (this._airAmmo + 1) % 3; this._showAmmoLabel(); }
    this._prevR = rDown;
    this._airCircleT += dt * W.airstrike.circleSpeed;
    if (this._airRun) this._stepAirRun(dt); else this._flyCircle();
    this.audio.airPlaneLoop(true);
  }
  _spawnPlane() {
    const mesh = new THREE.Mesh(this._planeGeo, this.materials);
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.scale.setScalar(W.airstrike.planeScale);
    this.scene.add(mesh);
    this._airPlane = mesh;
    this._flyCircle();
  }
  _despawnPlane() {
    if (this._planeView) this._exitPlaneView();
    if (this._airPlane) { this.scene.remove(this._airPlane); this._airPlane = null; }
    this._airRun = null;
    this._airMarker.visible = false;
    this.audio.airPlaneLoop(false);
  }
  _flyCircle() {
    if (!this._airPlane) return;
    const a = this._airCircleT;
    const R = W.airstrike.circleRadius;
    const x = Math.cos(a) * R, z = Math.sin(a) * R;
    this._airPlane.position.set(x, W.airstrike.altitude, z);
    this._facePlane(new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)));
  }
  _facePlane(dir) {
    const d = dir.clone(); if (d.lengthSq() < 1e-6) d.set(0, 0, 1); else d.normalize();
    this._airPlane.quaternion.setFromUnitVectors(FWD_Z, d);
  }
  _showAmmoLabel() {
    if (!this._label) return;
    this._labelNum.textContent = "6";
    this._labelName.textContent = "Airstrike: " + this._airAmmoNames[this._airAmmo];
    this._label.style.opacity = "1";
    clearTimeout(this._labelTimer);
    this._labelTimer = setTimeout(() => { this._label.style.opacity = "0"; }, VM.labelSeconds * 1000);
  }
  _airDesignateFpp(item) {
    if (this._airRun || !this._airPlane) return;
    const origin = this._camPos();
    const dir = this._aimDir();
    const ray = new this.RAPIER.Ray(origin, dir);
    const hit = this.world.castRay(ray, 300, true, undefined, undefined, undefined, this.player.body);
    if (!hit) return;
    this._airDesignate(origin.clone().addScaledVector(dir, hit.toi));
    void item;
  }
  _airDesignate(target) {
    if (this._airRun || !this._airPlane) return;
    this._airRun = { target: target.clone(), t: 0, released: false, start: this._airPlane.position.clone() };
    this.audio.airFlyby();
  }
  _stepAirRun(dt) {
    const run = this._airRun;
    const A = W.airstrike;
    run.t += dt;
    const u = Math.min(1, run.t / A.runTime);
    const over = new THREE.Vector3(run.target.x, A.altitude, run.target.z);
    const dir = over.clone().sub(run.start); dir.y = 0;
    if (dir.lengthSq() < 1e-3) dir.set(0, 0, 1); else dir.normalize();
    const start = over.clone().addScaledVector(dir, -60);
    const end = over.clone().addScaledVector(dir, 60);
    this._airPlane.position.copy(start).lerp(end, u);
    this._facePlane(dir);
    if (!run.released && u >= 0.5) { run.released = true; this._releaseOrdnance(run.target, dir); }
    if (u >= 1) this._airRun = null; // resume circling
  }
  _releaseOrdnance(target, dir) {
    const A = W.airstrike;
    if (this._airAmmo === 0) {
      for (let i = 0; i < A.dropCount; i++) {
        const off = (i - (A.dropCount - 1) / 2) * A.dropSpacing;
        const gx = target.x + dir.x * off, gz = target.z + dir.z * off;
        this._spawnDrop(new THREE.Vector3(gx, A.altitude, gz), new THREE.Vector3(gx, target.y, gz), "bomb");
      }
    } else if (this._airAmmo === 1) {
      this._spawnDrop(new THREE.Vector3(target.x, A.altitude, target.z), target.clone(), "pen");
    } else {
      this._spawnDrop(new THREE.Vector3(target.x, A.altitude, target.z), target.clone(), "cluster");
    }
    this.audio.bombWhistle();
  }
  _spawnDrop(top, impact, type) {
    const mesh = new THREE.Mesh(this._airDropGeo, this.materials);
    mesh.castShadow = false; mesh.position.copy(top);
    this.scene.add(mesh);
    const dir = impact.clone().sub(top);
    if (dir.lengthSq() < 1e-6) dir.set(0, -1, 0); else dir.normalize();
    this._airDrops.push({ mesh, pos: top.clone(), dir, impact: impact.clone(), type });
  }
  _tickAirDrops(dt) {
    if (this._airDrops.length === 0) return;
    const keep = [];
    for (const d of this._airDrops) {
      const step = W.airstrike.dropSpeed * dt;
      const ray = new this.RAPIER.Ray(d.pos, d.dir);
      const hit = this.world.castRay(ray, step, true, undefined, undefined, undefined, this.player.body);
      let point = null;
      if (hit) point = d.pos.clone().addScaledVector(d.dir, hit.toi);
      else {
        d.pos.addScaledVector(d.dir, step);
        d.mesh.position.copy(d.pos);
        if (d.pos.distanceToSquared(d.impact) < 0.6) point = d.impact.clone();
      }
      if (point) { this._strikeOrdnance(d, point); if (d.mesh.parent) d.mesh.parent.remove(d.mesh); continue; }
      keep.push(d);
    }
    this._airDrops = keep;
  }
  _strikeOrdnance(d, point) {
    const A = W.airstrike;
    const cam = this._camPos();
    if (d.type === "pen") {
      // Penetrator: carve down through obstacles above/at the target (the "ordnance penetrates" requirement).
      this.destruction.carveCylinder(point.clone().add(new THREE.Vector3(0, 6, 0)), new THREE.Vector3(0, -1, 0), A.penThrough, A.penRadius, A.penForce, A.penBudget);
      this.audio.explosion(cam.distanceTo(point));
    } else if (d.type === "cluster") {
      this._spawnClusterAt(point, A.clusterSpread);
      this.audio.clusterPop();
    } else {
      this._bigBlast(point, A.bombForce, A.bombRadius, A.bombBudget, true);
      this.audio.explosion(cam.distanceTo(point));
    }
  }
  // Reuse the 4c bomblet machinery: seed a cluster already in its "bomblets" phase at `point`.
  _spawnClusterAt(point, spread) {
    const cl = W.cluster;
    const rng = mulberry32(((this._ridCounter++ * 2654435761) ^ 0x9e3779b9) >>> 0);
    const c = { phase: "bomblets", pos: point.clone(), vel: new THREE.Vector3(), mesh: null, bomblets: [], seed: 0 };
    for (let i = 0; i < cl.bombletCount; i++) {
      const ang = (i / cl.bombletCount) * Math.PI * 2 + rng() * 0.6;
      const spd = spread * (0.6 + 0.6 * rng());
      const pool = this._acquireBomblet();
      const pos = c.pos.clone();
      if (pool) pool.mesh.position.copy(pos);
      c.bomblets.push({ pos, vel: new THREE.Vector3(Math.cos(ang) * spd, cl.bombletUp * (0.6 + 0.8 * rng()), Math.sin(ang) * spd), pool, age: 0, dead: false });
    }
    while (this.clusters.length > cl.maxLive) this._clearCluster(this.clusters.shift());
    this.clusters.push(c);
  }
  _enterPlaneView() {
    if (!this._airPlane) return;
    this._planeView = true;
    this._planeAim.set(0, 0);
  }
  _exitPlaneView() { this._planeView = false; this._airMarker.visible = false; }
  _tickPlaneView(dt) {
    if (!this._airPlane) { this._exitPlaneView(); return; }
    const A = W.airstrike;
    // Slow aim marker from mouse motion (the crosshair, relocated to a ground-projected quad).
    this._planeAim.x += this.input.mouseDX * A.aimSpeed * 0.0006;
    this._planeAim.y += this.input.mouseDY * A.aimSpeed * 0.0006;
    this._planeAim.x = THREE.MathUtils.clamp(this._planeAim.x, -0.7, 0.7);
    this._planeAim.y = THREE.MathUtils.clamp(this._planeAim.y, -0.25, 0.8);
    // R cycles ammo in plane view too.
    const rDown = this.input.down("KeyR");
    if (rDown && !this._prevR) { this._airAmmo = (this._airAmmo + 1) % 3; this._showAmmoLabel(); }
    this._prevR = rDown;
    // Keep the plane flying its circle / run.
    this._airCircleT += dt * A.circleSpeed;
    if (this._airRun) this._stepAirRun(dt); else this._flyCircle();
    // Nose-mounted camera looking down-forward, with the aim offset applied.
    const pPos = this._airPlane.position.clone();
    const pFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this._airPlane.quaternion);
    const camPos = pPos.clone().addScaledVector(pFwd, 2); camPos.y -= 0.5;
    const aimDir = pFwd.clone(); aimDir.y -= 0.7; aimDir.normalize();
    aimDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), this._planeAim.x);
    const rightAxis = new THREE.Vector3().crossVectors(aimDir, new THREE.Vector3(0, 1, 0)).normalize();
    aimDir.applyAxisAngle(rightAxis, this._planeAim.y);
    this.camera.position.copy(camPos);
    this.camera.lookAt(camPos.clone().add(aimDir));
    // Ground-projected aim marker.
    const ray = new this.RAPIER.Ray(camPos, aimDir);
    const hit = this.world.castRay(ray, 400, true, undefined, undefined, undefined, this.player.body);
    let point = null;
    if (hit) { point = camPos.clone().addScaledVector(aimDir, hit.toi); this._airMarker.position.set(point.x, point.y + 0.06, point.z); this._airMarker.scale.setScalar(1.2); this._airMarker.visible = true; }
    else this._airMarker.visible = false;
    // LMB designates; RMB returns to first person.
    if (this.input.consumeLMB() && point && !this._airRun) this._airDesignate(point);
    if (this.input.consumeRMB()) this._exitPlaneView();
    this.input.consumeDigits(); this.input.consumeWheel();
  }

  // ============================ Phase 7 batch D: Builders (constructive-voxel subsystem B) =====
  // MP: all three are server-authoritative now. Foam sprays and accretes locally (cosmetic markers), but a
  // hardened blob crosses the wire as one packed voxel grid and the SERVER creates the volume, echoing back
  // the index every peer must use. Rebuild streams its aim point and the server picks the chunk, answering
  // on the `reattach` channel — the mirror of `detach`. Size Ray sends grow/shrink for a `vol:cid` debris
  // chunk and the server steps and broadcasts the scale. Nothing here restructures an existing message.

  // Walk-mode dispatcher: Foam Cannon hold-spray spawn + Rebuild Gun hold-heal. (Size Ray fires on the
  // LMB/RMB edges routed through _handleFire.) Manages the foam spray loop audio every frame.
  _tickBuilders(dt, equipped) {
    const item = equipped ? this._activeItem() : null;
    const kind = item ? item.kind : null;
    const foamHold = kind === "foamcannon" && this.input.lmbDown;
    this.audio.foamSpray(foamHold);
    if (foamHold) {
      this._foamSprayTimer += dt;
      while (this._foamSprayTimer >= W.foam.sprayInterval) {
        this._foamSprayTimer -= W.foam.sprayInterval;
        this._spawnFoamProjectile(item);
      }
    } else this._foamSprayTimer = 0;
    if (kind === "rebuildgun" && this.input.lmbDown) { if (this.net) this._tickRebuildNet(dt); else this._tickRebuild(dt); }
    else this._rebuildAcc = 0;
  }

  // --- 7a. Foam Cannon: pooled spray projectiles that accrete into foam blobs, hardening into volumes -----
  _acquireFoamProj() { for (const e of this._foamProjPool) if (!e.used) { e.used = true; e.mesh.visible = true; return e; } return null; }
  _releaseFoamProj(e) { if (e) { e.used = false; e.mesh.visible = false; } }
  _acquireFoamMarker() { for (const e of this._foamMarkerPool) if (!e.used) { e.used = true; return e; } return null; }
  _releaseFoamMarker(e) { if (e) { e.used = false; e.mesh.visible = false; } }

  _spawnFoamProjectile(item) {
    const dir = this._aimDir();
    const origin = this._muzzleWorld(item);
    const vel = dir.clone().multiplyScalar(W.foam.projSpeed);
    vel.y += W.foam.projUp;
    const pool = this._acquireFoamProj();
    if (pool) { pool.mesh.position.copy(origin); pool.mesh.scale.setScalar(0.7 + Math.random() * 0.6); } // slight wobble
    this._foamProj.push({ pool, pos: origin.clone(), vel, life: W.foam.projLife });
    this._recoilZ -= 0.008;
  }

  // Always-on: fly the spray arc (short-range, ray-stepped), land on world hits OR when close to an existing
  // foam cell (mid-air accretion => bridges), then harden idle blobs. Runs regardless of the equipped tool.
  _tickFoam(dt) {
    const fm = W.foam;
    if (this._foamProj.length) {
      const down = new THREE.Vector3(0, -1, 0);
      const keep = [];
      for (const p of this._foamProj) {
        p.life -= dt;
        if (p.life <= 0) { this._releaseFoamProj(p.pool); continue; }
        p.vel.y -= fm.projGravity * dt;
        const step = p.vel.clone().multiplyScalar(dt);
        const dist = step.length();
        const dir = dist > 1e-6 ? step.clone().multiplyScalar(1 / dist) : down;
        const ray = new this.RAPIER.Ray(p.pos, dir);
        const hit = this.world.castRay(ray, Math.max(dist, 0.02), true, undefined, undefined, undefined, this.player.body);
        let land = null;
        if (hit) land = p.pos.clone().addScaledVector(dir, hit.toi);
        else { p.pos.add(step); if (this._foamNear(p.pos)) land = p.pos.clone(); }
        if (land) { this._landFoam(land); this._releaseFoamProj(p.pool); continue; }
        if (p.pool) p.pool.mesh.position.copy(p.pos);
        keep.push(p);
      }
      this._foamProj = keep;
    }
    // Harden blobs idle for hardenDelay. Runs in MP too: the soft blob is local, but hardening it now sends
    // the grid to the server instead of creating a volume here (see _hardenFoamBlob).
    if (this._foamBlobs.length) {
      const due = [];
      for (const b of this._foamBlobs) if (this._time - b.lastSpray > fm.hardenDelay) due.push(b);
      for (const b of due) this._hardenFoamBlob(b);
    }
    // MP: drain the harden queue no faster than the server accepts it.
    if (this._foamOut.length) {
      this._foamOutT -= dt;
      if (this._foamOutT <= 0) {
        const job = this._foamOut.shift();
        this._foamOutT = FOAM_OUT_INTERVAL;
        this.net.sendFoam(job.o, job.d, job.bits);
      }
    } else this._foamOutT = 0;
  }

  // Is `pos` adjacent (within one lattice cell) to any existing soft-foam cell? Enables mid-air bridge growth.
  _foamNear(pos) {
    if (!this._foamBlobs.length) return false;
    const cell = W.foam.cell;
    const gx = Math.floor(pos.x / cell), gy = Math.floor(pos.y / cell), gz = Math.floor(pos.z / cell);
    for (const b of this._foamBlobs) {
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if (b.cells.has((gx + dx) + "," + (gy + dy) + "," + (gz + dz))) return true;
    }
    return false;
  }

  // Accretion is client-local in BOTH modes: the soft blob is a pile of pooled marker cubes with no bodies
  // and no damage, so it costs the wire nothing and gives the sprayer immediate feedback. Only the hardened
  // result is authored by the server (see _hardenFoamBlob). Other players do not see the soft spray.
  _landFoam(point) {
    this._foamSplat(point);
    const cell = W.foam.cell;
    const gx = Math.floor(point.x / cell), gy = Math.floor(point.y / cell), gz = Math.floor(point.z / cell);
    const blob = this._foamTargetBlob(gx, gy, gz);
    this._addFoamCells(blob, gx, gy, gz);
    blob.lastSpray = this._time;
  }

  _foamTargetBlob(gx, gy, gz) {
    const M = W.foam.mergeCells;
    for (const b of this._foamBlobs) {
      if (gx >= b.min[0] - M && gx <= b.max[0] + M && gy >= b.min[1] - M && gy <= b.max[1] + M && gz >= b.min[2] - M && gz <= b.max[2] + M) return b;
    }
    const b = { id: this._foamBlobSeq++, cells: new Map(), min: [gx, gy, gz], max: [gx, gy, gz], lastSpray: this._time };
    this._foamBlobs.push(b);
    // Bound concurrent soft blobs: force-harden the oldest if we exceed the cap (never harden the fresh one).
    while (this._foamBlobs.length > W.foam.maxSoftBlobs && this._foamBlobs[0] !== b) this._hardenFoamBlob(this._foamBlobs[0]);
    return b;
  }

  // Accrete a small plus-brush at the landing cell + one cell below (thickness). Capped at fm.maxCells/blob.
  _addFoamCells(blob, gx, gy, gz) {
    const cell = W.foam.cell;
    const add = (x, y, z) => {
      if (blob.cells.size >= W.foam.maxCells) return;
      const key = x + "," + y + "," + z;
      if (blob.cells.has(key)) return;
      const mk = this._acquireFoamMarker();
      if (mk) { mk.mesh.position.set((x + 0.5) * cell, (y + 0.5) * cell, (z + 0.5) * cell); mk.mesh.visible = true; }
      blob.cells.set(key, mk || null);
      if (x < blob.min[0]) blob.min[0] = x; if (x > blob.max[0]) blob.max[0] = x;
      if (y < blob.min[1]) blob.min[1] = y; if (y > blob.max[1]) blob.max[1] = y;
      if (z < blob.min[2]) blob.min[2] = z; if (z > blob.max[2]) blob.max[2] = z;
    };
    add(gx, gy, gz);
    const r = W.foam.brush;
    for (let d = 1; d <= r; d++) { add(gx + d, gy, gz); add(gx - d, gy, gz); add(gx, gy, gz + d); add(gx, gy, gz - d); }
    add(gx, gy - 1, gz); // thicken downward so it reads as a slab, not a film
  }

  _hardenFoamBlob(blob) {
    const i = this._foamBlobs.indexOf(blob);
    if (i >= 0) this._foamBlobs.splice(i, 1);
    for (const mk of blob.cells.values()) this._releaseFoamMarker(mk);
    if (blob.cells.size === 0) return;
    const cell = W.foam.cell;
    const [minx, miny, minz] = blob.min;
    const nx = blob.max[0] - minx + 1, ny = blob.max[1] - miny + 1, nz = blob.max[2] - minz + 1;
    const cells = blob.cells;
    const occupied = (x, y, z) => (cells.has((minx + x) + "," + (miny + y) + "," + (minz + z)) ? 1 : 0);
    if (this.net) {
      // MP: brand-new world geometry must be server-authored or the clients diverge on the spot. Send the
      // grid as one packed bitmap and wait for foam_add — even the sprayer builds nothing locally, so the
      // volume can only ever appear at the index the server assigned. Harden audio plays on receipt.
      const bits = packBits(nx * ny * nz, (li) => occupied(li % nx, ((li / nx) | 0) % ny, (li / (nx * ny)) | 0));
      this._foamOut.push({ o: [minx, miny, minz], d: [nx, ny, nz], bits });
      while (this._foamOut.length > FOAM_OUT_MAX) this._foamOut.shift(); // bounded: drop the oldest, never grow
      return;
    }
    const vol = this.destruction.addVolume(foamVolumeSpec([minx, miny, minz], [nx, ny, nz], occupied));
    this._foamVols.push(vol);
    while (this._foamVols.length > W.foam.maxVolumes) this.destruction.despawnVolume(this._foamVols.shift());
    this._foamHardenAudio([minx, miny, minz], [nx, ny, nz]);
  }

  _foamHardenAudio(o, d) {
    const cell = W.foam.cell;
    this.audio.foamHarden(this._camPos().distanceTo(
      new THREE.Vector3((o[0] + d[0] / 2) * cell, (o[1] + d[1] / 2) * cell, (o[2] + d[2] / 2) * cell)
    ));
  }

  // --- MP builder hooks (called by replication.js; never reached in solo) ----------------------
  // Server authored a hardened blob. Build it at the server's index — addVolumeAt pads any gap with husks
  // so the slot arithmetic cannot drift even if this client somehow missed an earlier blob.
  applyNetFoam(volIdx, o, d, bits) {
    if (!Array.isArray(o) || !Array.isArray(d)) return;
    const nx = d[0], ny = d[1], nz = d[2];
    const bytes = unpackBits(bits, nx * ny * nz);
    if (!bytes) { console.warn("[net] foam_add with an undecodable bitmap — skipped, expect a foam desync"); return; }
    const spec = foamVolumeSpec(o, d, (x, y, z) => bitAt(bytes, x + nx * (y + ny * z)));
    const vol = this.destruction.addVolumeAt(volIdx, spec);
    if (!vol) { console.warn(`[net] foam_add for volume ${volIdx} but slot ${volIdx} is taken — foam desync`); return; }
    this._foamVols.push(vol);
    this._foamHardenAudio(o, d);
  }
  // Server evicted a blob at the live-foam cap. Slot stays reserved (despawnVolume leaves a husk).
  removeNetFoam(volIdx) {
    const vol = this.destruction.volumes[volIdx];
    if (!vol) return;
    this.destruction.despawnVolume(vol);
    this._foamVols = this._foamVols.filter((v) => v !== vol);
  }
  // Server rescaled a debris chunk (Size Ray). One float; the mass/collider rules already ran server-side,
  // this just makes the local body and mesh agree with it.
  applyNetScale(volIdx, cid, s) {
    const entry = this.destruction.findDebrisByRef(volIdx, cid);
    if (!entry) return;
    const prev = entry.sizeScale || 1;
    const hc = this.destruction.chunkHalfCenter(entry.chunk, s);
    if (!this.destruction.rescaleDebris(entry, hc.half, hc.center, s)) return;
    entry.sizeScale = s;
    if (entry.mesh) this._startSizeLerp(entry.mesh, s);
    this._trackSized(entry);
    const at = entry.mesh ? entry.mesh.position : entry.chunk.centroid;
    this.audio[s > prev ? "sizeGrow" : "sizeShrink"](this._camPos().distanceTo(at));
  }
  // Server restored chunks (Rebuild Gun). The inverse of the detach stream, on its own channel.
  applyNetReattach(events) {
    for (const e of events || []) {
      const vol = this.destruction.volumes[e[0]];
      const chunk = vol && vol.chunks[e[1]];
      if (this.destruction.applyReattach(e[0], e[1]) && chunk) this._rebuildSettle(chunk.centroid);
    }
  }

  _foamSplat(point) {
    if (this._time - this._foamSplatT < 0.06) return; // rate-limit the squelch
    this._foamSplatT = this._time;
    this.audio.foamSplat(this._camPos().distanceTo(point));
  }

  // --- 7b. Rebuild Gun: hold LMB aimed at a damaged volume; reattach detached chunks oldest-first ---------
  _tickRebuild(dt) {
    const rb = W.rebuild;
    const origin = this._camPos();
    const dir = this._aimDir();
    const ray = new this.RAPIER.Ray(origin, dir);
    const hit = this.world.castRay(ray, rb.aimRange, true, undefined, undefined, undefined, this.player.body);
    const aim = hit ? origin.clone().addScaledVector(dir, hit.toi) : origin.clone().addScaledVector(dir, rb.aimRange);
    this._rebuildAcc += dt;
    const per = 1 / rb.rate;
    while (this._rebuildAcc >= per && this._rebuildGhosts.length < rb.maxGhosts) {
      const cand = this.destruction.rebuildCandidate(aim, rb.range, (vol, chunk) => this._ghostBusy(chunk));
      if (!cand) { this._rebuildAcc = 0; break; }
      this._rebuildAcc -= per;
      this._startGhost(cand.vol, cand.chunk);
    }
  }
  // MP Rebuild: the server owns "which chunk restores", so the client only streams where it is pointing, at
  // the same rate the solo tool restores chunks. The 0.2 s ghost preview is solo-only — previewing a chunk
  // this client did not pick would show the wrong one, and the reattach round-trip is already the delay.
  _tickRebuildNet(dt) {
    const rb = W.rebuild;
    this._rebuildAcc += dt;
    const per = 1 / rb.rate;
    if (this._rebuildAcc < per) return;
    this._rebuildAcc = 0;
    const origin = this._camPos();
    const dir = this._aimDir();
    const hit = this.world.castRay(new this.RAPIER.Ray(origin, dir), rb.aimRange, true, undefined, undefined, undefined, this.player.body);
    this.net.sendRebuild(origin.clone().addScaledVector(dir, hit ? hit.toi : rb.aimRange));
  }
  _ghostBusy(chunk) { for (const g of this._rebuildGhosts) if (g.chunk === chunk) return true; return false; }
  _startGhost(vol, chunk) {
    const geo = this.destruction.chunkGeometry(vol, chunk);
    geo.clearGroups(); // one flat translucent material, ignore the rough/shiny/emissive groups
    const mesh = new THREE.Mesh(geo, this._ghostMat);
    mesh.position.copy(chunk.centroid);
    this.scene.add(mesh);
    this._rebuildGhosts.push({ vol, chunk, mesh, t: W.rebuild.ghostTime });
  }
  // Always-on: age each ghost; when it expires, reattach the chunk (subsystem B) and play a settling sound.
  _tickRebuildGhosts(dt) {
    if (!this._rebuildGhosts.length) return;
    const keep = [];
    for (const g of this._rebuildGhosts) {
      g.t -= dt;
      if (g.t <= 0) {
        this.scene.remove(g.mesh); g.mesh.geometry.dispose();
        if (this.destruction.reattachChunk(g.vol, g.chunk)) this._rebuildSettle(g.chunk.centroid);
        continue;
      }
      keep.push(g);
    }
    this._rebuildGhosts = keep;
  }
  _rebuildSettle(pos) {
    if (this._time - this._rebuildSettleT < 0.12) return; // rate-limit
    this._rebuildSettleT = this._time;
    this.audio.rebuildSettle(this._camPos().distanceTo(pos));
  }

  // --- 7c. Size Ray: LMB shrink x0.6 / RMB enlarge x1.6 on debris chunks + dynamic props only -------------
  _sizeZap(grow) {
    const sr = W.sizeRay;
    const origin = this._camPos();
    const dir = this._aimDir();
    const ray = new this.RAPIER.Ray(origin, dir);
    const hit = this.world.castRay(ray, sr.range, true, undefined, undefined, undefined, this.player.body);
    if (!hit) { this._sizeRefused("no target"); return; }
    const handle = hit.collider.handle;
    let entry = this.destruction.findDebrisByCollider(handle); // detached (debris) chunk only, never fixed
    let tank = entry ? null : this.findPropByCollider(handle); // dynamic prop (propane tank)
    if (!entry && !tank) {
      // The hairline ray landed on the ground/wall behind the rubble. Before refusing, take the valid
      // target closest to the aim LINE (never further along it than the surface the ray actually hit).
      const near = this._nearestSizeTarget(origin, dir, hit.toi + SIZE_AIM_RADIUS);
      entry = near.entry; tank = near.tank;
    }
    if (entry) {
      // MP: a debris chunk is `vol:cid`, the one identity that is stable across peers. Send the intent and
      // let the server step and broadcast the scale — applying it here first would fight the broadcast.
      // The propane tank below is NOT networked at all yet (it is a client-local body in MP), so scaling it
      // locally is the consistent behaviour until props get replicated.
      if (this.net) { this.net.sendZap(entry.vol.id, entry.chunk.id, grow); return; }
      this._sizeApplyDebris(entry, grow); return;
    }
    if (tank) { this._sizeApplyProp(tank, grow); return; }
    // Refused: ground / attached structure / vehicle / player.
    this._sizeRefused("debris and loose props only");
  }

  // Valid Size Ray target whose centre lies closest to the aim LINE (not to the ray's impact point:
  // a hairline ray that slips past a chunk lands on the floor behind it, which is metres away from the
  // chunk the player was clearly pointing at). Only targets in front of the camera and no further than
  // the surface the ray actually hit are considered, so this never reaches through a wall.
  _nearestSizeTarget(origin, dir, maxAlong) {
    let entry = null, tank = null, best = SIZE_AIM_RADIUS * SIZE_AIM_RADIUS;
    const rel = new THREE.Vector3();
    const test = (pos) => {
      rel.copy(pos).sub(origin);
      const along = rel.dot(dir);
      if (along <= 0 || along > maxAlong) return -1;
      return rel.addScaledVector(dir, -along).lengthSq(); // squared perpendicular distance to the aim line
    };
    this.destruction.forEachDebris((d) => {
      if (!d.mesh) return;
      const q = test(d.mesh.position);
      if (q >= 0 && q < best) { best = q; entry = d; tank = null; }
    });
    for (const t of this.propaneTanks) {
      if (t.disposed || !t.mesh) continue;
      const q = test(t.mesh.position);
      if (q >= 0 && q < best) { best = q; tank = t; entry = null; }
    }
    return { entry, tank };
  }

  // A refused zap must be legible: strain wobble + a dud clang + the reason on the tool label.
  _sizeRefused(why) {
    this._strainT = W.gravityGun.strainTime;
    this._recoilPitch += 0.03;
    this.audio.clang(false);
    if (!this._label || this.activeCat < 0) return;
    this._labelNum.textContent = String(this.categories[this.activeCat].num);
    this._labelName.textContent = "Size Ray — " + why;
    this._label.style.opacity = "1";
    clearTimeout(this._labelTimer);
    this._labelTimer = setTimeout(() => { this._label.style.opacity = "0"; }, VM.labelSeconds * 1000);
  }
  // Local half-extents (unscaled mesh bbox * scale) + its center offset, for the replacement cuboid collider.
  _meshHalfCenter(mesh, scale) {
    const geo = mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    return {
      half: { x: Math.max((bb.max.x - bb.min.x) / 2, 0.02) * scale, y: Math.max((bb.max.y - bb.min.y) / 2, 0.02) * scale, z: Math.max((bb.max.z - bb.min.z) / 2, 0.02) * scale },
      center: { x: (bb.max.x + bb.min.x) / 2 * scale, y: (bb.max.y + bb.min.y) / 2 * scale, z: (bb.max.z + bb.min.z) / 2 * scale },
    };
  }
  _sizeApplyDebris(entry, grow) {
    const sr = W.sizeRay;
    if (this._time - (entry.sizeCd != null ? entry.sizeCd : -1e9) < sr.cooldown) return;
    const cur = entry.sizeScale || 1;
    const ns = THREE.MathUtils.clamp(cur * (grow ? sr.grow : sr.shrink), sr.min, sr.max);
    if (Math.abs(ns - cur) < 1e-3) return; // already at a clamp limit
    entry.sizeCd = this._time;
    const hc = this._meshHalfCenter(entry.mesh, ns);
    this.destruction.rescaleDebris(entry, hc.half, hc.center, ns); // ns => mass tracks scale^3 exactly
    entry.sizeScale = ns;
    this._startSizeLerp(entry.mesh, ns);
    this._trackSized(entry);
    this.audio[grow ? "sizeGrow" : "sizeShrink"](this._camPos().distanceTo(entry.mesh.position));
  }
  _sizeApplyProp(tank, grow) {
    const sr = W.sizeRay;
    if (this._time - (tank.sizeCd != null ? tank.sizeCd : -1e9) < sr.cooldown) return;
    const cur = tank.sizeScale || 1;
    const ns = THREE.MathUtils.clamp(cur * (grow ? sr.grow : sr.shrink), sr.min, sr.max);
    if (Math.abs(ns - cur) < 1e-3) return;
    tank.sizeCd = this._time;
    const hc = this._meshHalfCenter(tank.mesh, ns);
    this.destruction.unregisterDamageableProp(tank.collider.handle);
    try { this.world.removeCollider(tank.collider, true); } catch (e) {}
    const cd = this.RAPIER.ColliderDesc.cuboid(hc.half.x, hc.half.y, hc.half.z)
      .setTranslation(hc.center.x, hc.center.y, hc.center.z)
      .setDensity(W.propane.density).setFriction(0.85).setRestitution(0.2);
    const col = this.world.createCollider(cd, tank.body);
    tank.collider = col;
    this.destruction.registerDamageableProp(col.handle, tank);
    if (typeof tank.body.recomputeMassPropertiesFromColliders === "function") { try { tank.body.recomputeMassPropertiesFromColliders(); } catch (e) {} }
    tank.sizeScale = ns;
    this._startSizeLerp(tank.mesh, ns);
    this._trackSized(tank);
    this.audio[grow ? "sizeGrow" : "sizeShrink"](this._camPos().distanceTo(tank.mesh.position));
  }
  _startSizeLerp(mesh, to) {
    const from = mesh.scale.x || 1;
    this._sizeAnims = this._sizeAnims.filter((a) => a.mesh !== mesh);
    this._sizeAnims.push({ mesh, from, to, t: 0 });
  }
  _tickSizeAnims(dt) {
    if (!this._sizeAnims.length) return;
    const keep = [];
    for (const a of this._sizeAnims) {
      a.t += dt;
      const u = Math.min(1, a.t / W.sizeRay.lerpTime);
      if (a.mesh) a.mesh.scale.setScalar(a.from + (a.to - a.from) * u);
      if (u < 1) keep.push(a);
    }
    this._sizeAnims = keep;
  }
  _trackSized(obj) {
    const i = this._sizeTracked.indexOf(obj);
    if (i >= 0) this._sizeTracked.splice(i, 1);
    this._sizeTracked.push(obj);
    while (this._sizeTracked.length > W.sizeRay.maxTracked) this._sizeTracked.shift(); // oldest untracked (debris despawns normally)
  }

  // Map-reset companion for the Builders category: drop spray projectiles, soft blobs, hardened foam volumes,
  // rebuild ghosts and size-lerps; silence the spray loop.
  _clearBuilders() {
    for (const p of this._foamProj) this._releaseFoamProj(p.pool);
    this._foamProj.length = 0;
    for (const b of this._foamBlobs) for (const mk of b.cells.values()) this._releaseFoamMarker(mk);
    this._foamBlobs.length = 0;
    for (const vol of this._foamVols) this.destruction.despawnVolume(vol);
    this._foamVols.length = 0;
    this._foamOut.length = 0; // MP: a reset cancels blobs that had not been uploaded yet
    this._foamOutT = 0;
    this._foamSprayTimer = 0;
    for (const g of this._rebuildGhosts) { this.scene.remove(g.mesh); g.mesh.geometry.dispose(); }
    this._rebuildGhosts.length = 0;
    this._rebuildAcc = 0;
    this._sizeAnims.length = 0;
    this._sizeTracked.length = 0;
    this.audio.foamSpray(false);
  }

  // --- Public hooks for main.js (camera-detached external-entity control) --------------------------
  controlsExternalEntity() { return !!this._rc || this._planeView; }
  freezePlayer() { return !!this._rc || this._planeView; }
  returnControl() { if (this._rc) this._returnRc(false); else if (this._planeView) this._exitPlaneView(); }

  // --- Viewmodel animation ---
  _decayAnim(dt) {
    const k = 1 - Math.exp(-14 * dt);
    this._recoilZ += (0 - this._recoilZ) * k;
    this._recoilPitch += (0 - this._recoilPitch) * k;
  }

  _animateViewmodel(dt) {
    const b = this._currentBaseOffset;
    let equipY = 0;
    if (this._equipT < VM.equipTime) {
      this._equipT += dt;
      equipY = -VM.equipDrop * Math.max(0, 1 - this._equipT / VM.equipTime);
    }
    const walk = Math.min(1, this.player.horizontalSpeed() / CONFIG.player.walkSpeed);
    const bobY = Math.sin(this._time * VM.idleBobSpeed) * VM.idleBobAmp + Math.sin(this._time * 8) * VM.walkBobAmp * walk;

    let swingPitch = 0;
    if (this._swingT >= 0) {
      const dur = (this._swingCfg || W.melee).swingDuration;
      const p = this._swingT / dur;
      if (p < 0.4) { const e = p / 0.4; swingPitch = -0.4 + (1.1 - -0.4) * (1 - (1 - e) * (1 - e)); }
      else { const e = (p - 0.4) / 0.6; swingPitch = 1.1 * (1 - e); }
    }

    // Chainsaw rumble: high-frequency shake, stronger while biting a chunk.
    let rx = 0, ry = 0, rz = 0;
    if (this._activeItem().kind === "chainsaw" && this._sawShake > 0) {
      const amp = 0.006 * this._sawShake;
      rx = Math.sin(this._time * 90) * amp;
      ry = Math.sin(this._time * 77) * amp;
      rz = Math.sin(this._time * 63) * amp * 0.6;
    }
    // Gravity Gun heavy-vehicle refusal: a brief "strain" shake when a grab is rejected for being too heavy.
    if (this._strainT > 0) {
      const amp = 0.02 * (this._strainT / W.gravityGun.strainTime);
      rx += Math.sin(this._time * 120) * amp;
      ry += Math.sin(this._time * 101) * amp;
    }

    this.viewmodel.position.set(b.x + rx, b.y + equipY + bobY + ry, b.z + this._recoilZ + rz);
    this.viewmodel.rotation.set(swingPitch + this._recoilPitch + rx, VM.inwardYaw + ry, 0);
  }
}
