// weapons.js - tool selection state machine, camera-space viewmodel, C4/rocket entities, firing logic
import * as THREE from "three";
import { CONFIG } from "./config.js";
import { decodeModel, meshModelPart } from "./voxel.js";
import toolModels from "../assets/models/tools.js";

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

    // Label DOM.
    this._label = document.getElementById("tool-label");
    this._labelNum = document.getElementById("tool-label-num");
    this._labelName = document.getElementById("tool-label-name");
    this._labelTimer = 0;
  }

  _buildItems() {
    const defs = [
      { num: 1, catLabel: "Melee", id: "sledgehammer", name: "Sledgehammer", kind: "melee", model: toolModels.sledgehammer, base: VM.sledgeOffset },
      { num: 2, catLabel: "Explosives", id: "c4", name: "C4 Charge", kind: "c4", model: toolModels.c4, base: VM.baseOffset },
      { num: 3, catLabel: "Firearms", id: "shotgun", name: "Shotgun", kind: "shotgun", model: toolModels.shotgun, base: VM.baseOffset },
      { num: 4, catLabel: "Launchers", id: "rocketLauncher", name: "Rocket Launcher", kind: "rocket", model: toolModels.rocketLauncher, base: VM.baseOffset },
    ];
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
      const armsOffset = d.id === "sledgehammer" ? VM.armsOffsetSledge : VM.armsOffset;
      const item = { id: d.id, name: d.name, kind: d.kind, num: d.num, mesh, baseOffset: d.base, muzzleLen, armsOffset, state: { lastUse: -1e9 } };
      this.categories.push({ num: d.num, label: d.catLabel, items: [item] });
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
    this._tickTrail(dt);
    this._tickFlash(dt);
    this._tickTracers(dt);
    this._decayAnim(dt);
    this._blinkCharges();

    const driving = mode !== "walk";
    if (driving) {
      this._swingT = -1;
      this.viewmodel.visible = false;
      this._armsMesh.visible = false;
      this.player.setArmsHidden(false);
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
      case "c4": if (lmb) this._placeC4(item); if (rmb) this._detonate(); break;
      case "shotgun": if (lmb) this._fireShotgun(item); break;
      case "rocket": if (lmb) this._fireRocket(item); break;
    }
  }

  // --- Melee ---
  _startSwing(item) {
    if (this._swingT >= 0) return;
    if (this._time - item.state.lastUse < W.melee.cooldown) return;
    item.state.lastUse = this._time;
    this._swingT = 0;
    this._swingHitDone = false;
    this.audio.swing();
    if (this.net) this.net.sendFx("swing", this._camPos());
  }

  _tickSwing(dt) {
    if (this._swingT < 0) return;
    this._swingT += dt;
    if (!this._swingHitDone && this._swingT >= W.melee.hitDelay) {
      this._swingHitDone = true;
      this._doMeleeHit();
    }
    if (this._swingT >= W.melee.swingDuration) this._swingT = -1;
  }

  _doMeleeHit() {
    const origin = this._camPos();
    const dir = this._aimDir();
    const ray = new this.RAPIER.Ray(origin, dir);
    const hit = this.world.castRay(ray, W.melee.range, true, undefined, undefined, undefined, this.player.body);
    if (!hit) return;
    if (this.destruction.hasChunk(hit.collider.handle)) {
      // In MP the replica destruction forwards this as a `dmg point` intent (no local detach).
      const broke = this.destruction.applyPointDamage(hit.collider.handle, origin, W.melee.force);
      this.audio.clang(broke);
      if (this.net) this.net.sendFx("clang", origin.clone().addScaledVector(dir, hit.toi));
    } else {
      this.audio.clang(false);
    }
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
  _spawnChargeVisual(worldPos, worldQuat, onVehicleV, tag) {
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
    this.charges.push(rec);
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
    if (this.charges.length === 0) return;
    const on = Math.floor(this._time * 2) % 2 === 0;
    for (const ch of this.charges) ch.indicator.visible = on;
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
      const p = this._swingT / W.melee.swingDuration;
      if (p < 0.4) { const e = p / 0.4; swingPitch = -0.4 + (1.1 - -0.4) * (1 - (1 - e) * (1 - e)); }
      else { const e = (p - 0.4) / 0.6; swingPitch = 1.1 * (1 - e); }
    }

    this.viewmodel.position.set(b.x, b.y + equipY + bobY, b.z + this._recoilZ);
    this.viewmodel.rotation.set(swingPitch + this._recoilPitch, VM.inwardYaw, 0);
  }
}
