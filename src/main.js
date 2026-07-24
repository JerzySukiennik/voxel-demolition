// main.js - lobby-first boot: initLobby (no RAPIER) -> startGame(map/avatar/nick), fixed-timestep loop,
// ESC menu. Phase 6: a NetClient dials the LAN server at lobby load; on success the game runs as a
// replica (server-authoritative destruction + vehicles, interpolated remotes); on ?solo=1 or a 2 s
// connect failure it falls back to the EXACT Phase 5 single-player path with an OFFLINE tag.
import * as THREE from "three";
import { CONFIG } from "./config.js";
import { Input } from "./input.js";
import { CameraRig } from "./camera.js";
import { setupScene, createCore, createWater, buildStaticGeo, makeShadowFollower } from "./world.js";
import { makeMaterials } from "./voxel.js";
import { Destruction } from "./destruction.js";
import { Player } from "./player.js";
import { VehicleManager } from "./vehicles/manager.js";
import { VehicleMenu } from "./menu.js";
import { GameAudio } from "./audio.js";
import { Weapons } from "./weapons.js";
import { getMap } from "./maps/index.js";
import { buildAvatarModel } from "./avatar.js";
import { Lobby, GameMenu, loadNick, loadAvatar, resolveMapId } from "./lobby.js";
import { NetClient } from "./net/client.js";
import { RemotePlayers } from "./net/remotes.js";
import { Replication } from "./net/replication.js";
import { S2C } from "./net/protocol.js";

// Captured lobby choices; stored so networking can wire nick + avatar in without rework.
const session = { nick: "Player", avatar: null, mapId: null };

// The one shared NetClient for the tab (created at boot, connects at lobby load).
let net = null;

// Boot into the lobby: pure DOM, NO RAPIER/physics/scene until PLAY. ?quick=1 skips the lobby and
// starts immediately with stored/default choices; ?map= preselects a card (or the quick map). ?solo=1
// forces single-player (no connection attempt).
function initLobby() {
  const params = new URLSearchParams(window.location.search);
  const preMap = params.get("map");
  const solo = params.get("solo") === "1";

  net = new NetClient({ solo });
  net.connect();

  if (params.get("quick") === "1") {
    const opts = { mapId: resolveMapId(preMap), avatar: loadAvatar(), nick: loadNick() };
    net.whenReady().then(() => beginPlay(opts, null));
    return;
  }
  const lobby = new Lobby({
    preMapId: preMap,
    net,
    onPlay: (opts) => net.whenReady().then(() => beginPlay(opts, lobby)),
  });
  lobby.show();
}

// Decide solo vs MP at PLAY time. MP: hello -> wait for welcome (authoritative map + snapshot). Solo /
// offline: start immediately. `opts.mapId` is the WANTED map (may be overridden by welcome.mapId).
function beginPlay(opts, lobby) {
  if (net && net.online) {
    let done = false;
    const fallback = setTimeout(() => {
      if (done) return; done = true;
      try { net.close(); } catch (e) {}
      startGame(opts, lobby, { net }).catch(reportBootError); // net is offline now -> solo + OFFLINE tag
    }, 3000);
    net.on(S2C.WELCOME, (msg) => {
      if (done) return; done = true; clearTimeout(fallback);
      startGame({ mapId: msg.mapId, avatar: opts.avatar, nick: opts.nick }, lobby,
        { net, welcome: msg, wantMap: opts.mapId }).catch(reportBootError);
    });
    net.on(S2C.FULL, (msg) => {
      if (done) return; done = true; clearTimeout(fallback);
      reportFull(lobby, msg);
    });
    net.sendHello(opts.nick, opts.avatar, opts.mapId);
  } else {
    startGame(opts, lobby, { net }).catch(reportBootError);
  }
}

function reportFull(lobby, msg) {
  const reason = (msg && msg.reason) ? msg.reason : "Session full (max 4 players).";
  if (lobby && lobby.playBtn) {
    lobby.playBtn.disabled = false;
    lobby.playBtn.textContent = "PLAY";
    if (lobby._banner) {
      lobby._banner.textContent = reason;
      lobby._banner.style.display = "block";
    }
    lobby._startPreview();
  } else {
    reportBootError(new Error(reason));
  }
}

// Post-load pointer-lock gesture (mirrors the old click-to-start): one click resumes audio + locks.
function showEnterGesture(mapName, onEnter, joining) {
  const eo = document.getElementById("enter-overlay");
  const msg = eo.querySelector(".eo-msg");
  if (msg) msg.textContent = (joining ? "Joining " : "Click to enter — ") + mapName;
  eo.style.display = "flex";
  const handler = () => {
    eo.removeEventListener("click", handler);
    eo.style.display = "none";
    onEnter();
  };
  eo.addEventListener("click", handler);
}

async function startGame({ mapId, avatar, nick }, lobby, opts = {}) {
  const netc = opts.net || null;
  const mp = !!(netc && netc.online);      // true multiplayer; false = solo/offline (Phase 5 path)
  const welcome = opts.welcome || null;

  // Dynamic import so the physics engine (and its inlined WASM) is only fetched on PLAY.
  const RAPIER = (await import("@dimforge/rapier3d-compat")).default;
  await RAPIER.init();
  const bootStart = performance.now();

  session.mapId = mapId;
  session.avatar = avatar;
  session.nick = nick;
  const map = getMap(mapId);

  const canvas = document.getElementById("app");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.render.pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fov, window.innerWidth / window.innerHeight, CONFIG.camera.near, CONFIG.camera.far
  );

  const { sun, offset, env } = setupScene(scene, map.env);
  const shadowFollow = makeShadowFollower(sun, offset);
  scene.add(camera); // camera-parented weapon viewmodel needs the camera in the scene graph
  const materials = makeMaterials();

  const world = new RAPIER.World(CONFIG.gravity);
  const eventQueue = new RAPIER.EventQueue(true);

  createCore(scene, world, RAPIER, materials, map.size, env.groundColor, map.water ? map.water.rect : null);

  // Destruction mode (brief section 3): solo = authoritative + gfx; MP client = replica + gfx, with
  // point/radial damage forwarded to the server as intents instead of detaching locally.
  const destruction = mp
    ? new Destruction(world, RAPIER, {
        mode: "replica", gfx: { scene, materials }, mapId,
        onDamageIntent: (intent) => netc.sendDmg(intent),
      })
    : new Destruction(world, RAPIER, { mode: "authoritative", gfx: { scene, materials }, mapId });
  for (const spec of map.volumes) destruction.addVolume(spec);

  const staticGeo = buildStaticGeo(scene, world, RAPIER, materials, map.staticGeo);

  const skinTop = CONFIG.world.skinThickness;
  const spawn = map.spawn;
  const player = new Player(scene, world, RAPIER, buildAvatarModel(avatar), materials, { x: spawn.x, y: skinTop, z: spawn.z });

  const manager = new VehicleManager(scene, world, RAPIER, materials, destruction);
  // Solo: place the permanent hatchback locally. MP: the hatchback (vid 0) arrives via welcome.snap as a
  // networked vehicle, so we do NOT spawn it here.
  if (!mp) {
    const hb = map.hatchback;
    manager.spawnPermanent("hatchback", { x: hb.x, y: 0, z: hb.z, yaw: hb.yaw || 0 });
  }

  // Water: visual plane + buoyancy/drag/wading context (deterministic; built on both solo + MP).
  let water = null;
  if (map.water) {
    water = createWater(scene, map.water);
    manager.setWater(water);
    player.water = water;
  }

  // Decorative parked vehicles (deterministic static props; identical on server + client).
  for (const d of map.decorVehicles || []) manager.spawnDecorative(d.id, d);

  const input = new Input(canvas);
  const rig = new CameraRig(camera);
  rig.yaw = spawn.yaw || 0;
  const audio = new GameAudio();
  const weapons = new Weapons(scene, camera, world, RAPIER, destruction, player, manager, audio, materials, input, mp ? netc : null);
  manager.setWeapons(weapons);

  const menu = new VehicleMenu((id) => {
    if (mp) netc.sendSpawnVeh(id, rig.yaw); // server places + broadcasts veh_spawn
    else manager.spawnAt(id, player, rig.yaw);
  });

  // Only the player and (registered by the manager) live vehicles may trigger chunk detach (solo).
  destruction.registerImpactor(player.collider.handle);

  let mode = "walk";
  let pendingEnter = null; // MP: vid we asked to enter, awaiting the server's seat grant

  // --- MP systems: remote players + server-message replication --------------------------------
  let remotes = null;
  let replication = null;
  if (mp) {
    remotes = new RemotePlayers(scene, materials, { fogFar: env.fogFar, getVehicle: (vid) => manager.byNetId(vid) });
    replication = new Replication({
      destruction, manager, remotes, weapons, audio, camera, net: netc,
      onSeatGrant: (vid) => onSeatGranted(vid),
      onReset: () => {},
    });
    replication.register(netc);

    if (welcome) {
      for (const pl of welcome.players || []) if (pl.pid !== netc.pid) remotes.add(pl.pid, pl.nick, pl.avatar);
      replication.applySnapshot(welcome.snap);
    }
    // Verification guard (brief section 2.4): per-volume chunk counts for the server to compare.
    netc.sendMapCheck(destruction.volumes.map((v) => v.chunks.length));

    netc.stateProvider = buildStateMsg;
    netc.inputProvider = buildInputMsg;
    netc.startGameTimers();
    netc.onClose = () => { console.warn("[net] disconnected — continuing offline (frozen replica state)."); };
  }

  // --- Pointer-lock lifecycle + ESC menu ---
  let entered = false;
  let pendingLock = false;
  let hasLockedOnce = false;
  const requestLockGesture = () => { pendingLock = true; try { input.requestLock(); } catch (e) {} };
  const gameMenu = new GameMenu({
    onResume: () => { gameMenu.close(); requestLockGesture(); },
    onReset: () => {
      if (mp) netc.sendReset();                                  // server resets + broadcasts to everyone
      else { destruction.resetAll(); weapons.resetTransient(); } // solo: local reset
    },
    onLobby: () => { if (netc) netc.close(); location.href = location.pathname + "?map=" + session.mapId; },
  });
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement === canvas) { pendingLock = false; hasLockedOnce = true; }
  });
  document.addEventListener("pointerlockerror", () => {
    pendingLock = false;
    if (entered) gameMenu.openWithHint();
  });
  const enter = () => {
    entered = true;
    try { audio.resume(); } catch (e) {}
    requestLockGesture();
  };

  setupHud(map, !!(netc && !netc.online));
  reportLoad(map, destruction, staticGeo, manager, player, bootStart);

  // Vehicle enter/exit. Solo is immediate (Phase 5). MP gates entry on the server's seat grant, and
  // exits locally (client-computed exit pos) while telling the server.
  function tryEnterExit() {
    if (mode === "walk") {
      const feet = player.feetPosition();
      const range = CONFIG.player.enterRange + 1.0;
      const near = mp ? manager.nearestNetworked(feet, range) : manager.nearest(feet, range);
      if (!near) return;
      if (mp) {
        if (pendingEnter != null) return;
        pendingEnter = near.netId;
        netc.sendEnterVeh(near.netId); // seat grant -> onSeatGranted performs the local enter
      } else {
        player.enterDriving();
        mode = "drive";
        manager.driven = near;
      }
    } else {
      const v = manager.driven;
      const placed = computeExitPos(v);
      if (mp) {
        netc.sendExitVeh(v.netId, [placed.x, placed.y, placed.z]);
        manager.setBodyKinematic(v, true); // hand the body back to server authority
        netc.setDriving(null);
        replication.setDriving(null);
      }
      player.exitDriving(placed);
      mode = "walk";
      manager.driven = null;
    }
  }

  // Server granted us a seat: flip the (kinematic) networked vehicle into a locally-driven dynamic body
  // and start predicting + uploading input. Ignored if we already bailed on the request.
  function onSeatGranted(vid) {
    if (pendingEnter !== vid) return;
    pendingEnter = null;
    const v = manager.byNetId(vid);
    if (!v) return;
    manager.setBodyKinematic(v, false); // -> dynamic; controller takes over
    player.enterDriving();
    mode = "drive";
    manager.driven = v;
    netc.setDriving(vid);
    replication.setDriving(vid);
  }

  function computeExitPos(v) {
    const carPos = v.centerWorld();
    const carQuat = v.quaternion();
    const ex = v.exitAnchor();
    const candidates = [ex, [-ex[0], 0, ex[2]], [0, 1.4, 0]];
    for (const cand of candidates) {
      const w = new THREE.Vector3(cand[0], cand[1] + 1.5, cand[2]).applyQuaternion(carQuat).add(carPos);
      const ray = new RAPIER.Ray({ x: w.x, y: w.y, z: w.z }, { x: 0, y: -1, z: 0 });
      const hit = world.castRay(ray, 4, true, undefined, undefined, undefined, v.body);
      if (hit) return new THREE.Vector3(w.x, w.y - hit.toi, w.z);
    }
    return new THREE.Vector3(carPos.x, skinTop, carPos.z);
  }

  // MP state upload payload (20 Hz). Seated => p is the seat-posed group position and seat = vid.
  function buildStateMsg() {
    const walk = mode === "walk";
    const p = walk ? player.feetPosition() : player.group.position;
    const lv = player.body.isEnabled() ? player.body.linvel() : { x: 0, y: 0, z: 0 };
    return {
      p: [p.x, p.y, p.z],
      yaw: rig.yaw, pitch: rig.pitch,
      v: [lv.x, lv.y, lv.z],
      tool: walk ? weapons.currentToolId : null,
      seat: (!walk && manager.driven) ? manager.driven.netId : null,
    };
  }

  // MP driving-input upload payload (30 Hz). Null when not driving.
  function buildInputMsg() {
    if (mode !== "drive" || !manager.driven) return null;
    const ax = input.axis();
    return {
      vid: manager.driven.netId,
      x: ax.x, z: ax.z,
      sp: input.down("Space") ? 1 : 0,
      sh: (input.down("ShiftLeft") || input.down("ShiftRight")) ? 1 : 0,
      kq: input.down("KeyQ") ? 1 : 0,
      ke: input.down("KeyE") ? 1 : 0,
    };
  }

  const DT = CONFIG.fixedDt;
  let acc = 0;
  let last = performance.now() / 1000;
  let elapsed = 0;
  let drawLogged = false;

  function stepPhysics(dt, menuOpen) {
    const forward = rig.getForward();
    const right = rig.getRight();
    if (mode === "walk") {
      // Freeze the character while a weapon owns an external entity (RC car / airstrike plane view) —
      // the same accepted "character stands still" vulnerability as the RC Car Bomb / plane-cam spec.
      if (menuOpen || (weapons.freezePlayer && weapons.freezePlayer())) {
        const lv = player.body.linvel();
        player.body.setLinvel({ x: 0, y: lv.y, z: 0 }, true);
      } else {
        player.update(dt, forward, right, input);
      }
    }
    manager.update(dt, input); // solo: drives `all` (incl. driven). MP: `all` is empty (no-op).
    if (mp && mode === "drive" && manager.driven) manager.driven.update(dt, input, true); // MP: drive the networked vehicle we hold
    world.step(eventQueue);
    const impacts = destruction.drainContacts(eventQueue); // replica mode returns [] (server owns detach)
    for (let i = 0; i < impacts.length && i < 3; i++) audio.impact(impacts[i]);
  }

  function frame() {
    const now = performance.now() / 1000;
    let dt = now - last;
    last = now;
    if (dt > 0.1) dt = 0.1;
    elapsed += dt;

    if (entered && hasLockedOnce && !input.locked && !pendingLock && !gameMenu.isOpen && !menu.isOpen) {
      gameMenu.open();
    }

    const tab = input.consumeTab();
    if (tab && mode === "walk" && !gameMenu.isOpen) menu.toggle();
    if (menu.isOpen && !input.locked) menu.close();
    const menuOpen = menu.isOpen || gameMenu.isOpen;

    if (input.locked && !menuOpen) {
      rig.addMouseLook(input.mouseDX, input.mouseDY);
      // E returns control from a weapon-owned entity (RC car / airstrike plane-cam) before any vehicle enter/exit.
      if (input.consumeE()) { if (weapons.controlsExternalEntity && weapons.controlsExternalEntity()) weapons.returnControl(); else tryEnterExit(); }
    }

    // MP: advance interpolation of non-driver networked vehicles before the physics step.
    if (mp) replication.preStep(dt);

    acc += dt;
    let n = 0;
    while (acc >= DT && n < CONFIG.maxSubsteps) {
      stepPhysics(DT, menuOpen);
      acc -= DT;
      n++;
    }
    if (acc > DT) acc = 0;

    destruction.update(dt);
    if (water) water.update(elapsed);

    const followPoint = (mode === "walk") ? player.feetPosition() : manager.driven.centerWorld();
    shadowFollow(followPoint);

    if (mode === "walk") {
      player.syncModel(dt);
      rig.applyFPP(player.eyePosition());
      audio.setEngine(null, 0, false);
      audio.footstepTick(dt, player.horizontalSpeed(), input.down("ShiftLeft") || input.down("ShiftRight"));
    } else {
      const v = manager.driven;
      player.poseAtSeat(v.centerWorld(), v.quaternion(), v.seatAnchor());
      rig.applyChase(dt, v.centerWorld(), v.quaternion(), world, RAPIER, v.body, v.spec.camera);
      audio.setEngine(v.spec.audio, v.speedNorm(), true);
    }

    if (input.locked && !menuOpen) {
      weapons.update(dt, mode, rig);
    } else if (menuOpen) {
      input.consumeDigits();
      input.consumeLMB();
      input.consumeRMB();
      input.consumeWheel();
    }

    // MP: interpolate + pose remote players (after our camera is placed so nametag culling is accurate).
    if (mp) remotes.update(dt, camera);

    input.endFrame();
    renderer.render(scene, camera);

    if (!drawLogged && elapsed > 5) {
      drawLogged = true;
      console.log(`[QA] draw calls after 5 s: ${renderer.info.render.calls} (gate < 300) · triangles: ${renderer.info.render.triangles}`);
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.render.pixelRatioCap));
  });

  requestAnimationFrame(frame);

  // Hand off to the click-to-enter gesture: hide the lobby (if any), show the dimmed enter overlay.
  if (lobby) lobby.hide();
  const joining = mp && opts.wantMap && opts.wantMap !== mapId;
  showEnterGesture(map.name, enter, joining);
}

// Persistent HUD tag + document title. `offline` appends a small OFFLINE marker (single-player).
function setupHud(map, offline) {
  const tag = document.getElementById("map-label");
  if (tag) {
    tag.textContent = map.name;
    if (offline) {
      const off = document.createElement("span");
      off.textContent = "  · OFFLINE";
      off.style.opacity = "0.8";
      off.style.color = "#ffcf8f";
      tag.appendChild(off);
    }
  }
  try { document.title = `Voxel Demolition — ${map.name}`; } catch (e) {}
}

// Load-time QA report (brief section 5): chunk totals per kind, collider counts, per-stage ms,
// total ms, dynamic-body count (must equal vehicle + player count -> proves static-until-hit).
function reportLoad(map, destruction, staticGeo, manager, player, bootStart) {
  const s = destruction.stats;
  const totalMs = performance.now() - bootStart;
  const dynamicBodies = 1 + manager.all.length; // player + drivable vehicles (decor + chunks are fixed)
  const ms = s.ms;
  const line = (l) => console.log(l);
  line(`===== [QA] Map load report: ${map.id} (${map.name}) =====`);
  line(`  size ${map.size.x}x${map.size.z} m · volumes ${map.volumes.length}`);
  line(`  chunks total ${s.chunks} (grid ${s.chunksGrid}, structure ${s.chunksStructure}) — gate <= 2500`);
  line(`  chunk colliders: cuboid ${s.collidersCuboid}, hull ${s.collidersHull}`);
  line(`  static cliff colliders: ${staticGeo.colliderCount}`);
  line(`  stage ms — fill ${ms.fill.toFixed(1)} · voronoi ${ms.voronoi.toFixed(1)} · colliders ${ms.colliders.toFixed(1)} · tiles ${ms.tiles.toFixed(1)}`);
  line(`  total load ms (RAPIER.init -> first frame setup): ${totalMs.toFixed(1)} — gate < 6000`);
  line(`  dynamic bodies at load: ${dynamicBodies} (player + ${manager.all.length} vehicle) · decor ${manager.decor.length} (fixed)`);
  if (s.chunks > 2500) line(`  WARNING: chunk total ${s.chunks} exceeds the 2500 gate`);
  line(`==================================================`);
}

function reportBootError(e) {
  console.error(e);
  const eo = document.getElementById("enter-overlay");
  if (eo) {
    const msg = eo.querySelector(".eo-msg");
    if (msg) msg.textContent = "Failed to start: " + (e && e.message ? e.message : e);
    eo.style.display = "flex";
  }
}

initLobby();
