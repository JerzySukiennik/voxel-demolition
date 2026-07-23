// weapons.js - tool selection state machine, camera-space viewmodel, C4/rocket entities, firing logic
import * as THREE from "three";
import { CONFIG } from "./config.js";
import { decodeModel, meshModelPart } from "./voxel.js";
import { mulberry32 } from "./sim/rng.js";
import toolModels from "../assets/models/tools.js";

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
      { num: 3, catLabel: "Firearms", id: "shotgun", name: "Shotgun", kind: "shotgun", model: toolModels.shotgun, base: VM.baseOffset },
      { num: 4, catLabel: "Launchers", id: "rocketLauncher", name: "Rocket Launcher", kind: "rocket", model: toolModels.rocketLauncher, base: VM.baseOffset },
      { num: 4, catLabel: "Launchers", id: "stickyLauncher", name: "Sticky Bomb Launcher", kind: "sticky", model: toolModels.stickylauncher, base: VM.baseOffset },
      { num: 4, catLabel: "Launchers", id: "clusterLauncher", name: "Cluster Bomb Launcher", kind: "cluster", model: toolModels.clusterlauncher, base: VM.baseOffset },
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
      const item = { id: d.id, name: d.name, kind: d.kind, num: d.num, mesh, baseOffset: d.base, muzzleLen, armsOffset, state: { lastUse: -1e9 } };
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
    return this.camera.localToWorld(new THREE.Vector3(b.x, b.y, b.z - item.muzzleLen));
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
    this._tickTracers(dt);
    this._decayAnim(dt);
    this._blinkCharges();
    // Shared fuse hiss loop is on whenever a fused throwable is live (survives tool-switch / driving).
    this.audio.fuse(this.pipeBombs.length + this.stickies.length > 0);

    const driving = mode !== "walk";
    if (driving) {
      this._swingT = -1;
      this.viewmodel.visible = false;
      this._armsMesh.visible = false;
      this.player.setArmsHidden(false);
      this.audio.chainsaw(false, false);
      // Drain edges so nothing fires on exit; RMB is ignored while driving.
      this.input.consumeDigits();
      this.input.consumeLMB();
      this.input.consumeRMB();
      this.input.consumeWheel();
      return;
    }

    this._handleSelection();

    const lmb = this.input.consumeLMB();
    const rmb = this.input.consumeRMB();
    if (this.activeCat >= 0) this._handleFire(lmb, rmb);

    const equipped = this.activeCat >= 0;
    // Chainsaw continuous hold-fire + looping audio (also keeps the loops silenced for every other tool).
    this._tickChainsaw(dt, equipped);
    // Demolition-wire line visuals follow their (possibly vehicle-parented) charges every frame.
    if (this.wireCharges.length) this._rebuildWireLines();

    this.viewmodel.visible = equipped;
    this._armsMesh.visible = equipped;
    this.player.setArmsHidden(equipped);
    if (equipped) this._animateViewmodel(dt);
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

    this.viewmodel.position.set(b.x + rx, b.y + equipY + bobY + ry, b.z + this._recoilZ + rz);
    this.viewmodel.rotation.set(swingPitch + this._recoilPitch + rx, VM.inwardYaw + ry, 0);
  }
}
