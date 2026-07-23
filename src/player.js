// player.js - dynamic capsule controller, visible FPP body, limb swing, vehicle enter/exit posing
import * as THREE from "three";
import { CONFIG } from "./config.js";
import { buildCharacterGroup } from "./avatar.js";

const P = CONFIG.player;
const CAP_CENTER = P.halfHeight + P.radius; // center-to-tip along Y

export class Player {
  constructor(scene, world, RAPIER, model, materials, spawn) {
    this.scene = scene;
    this.world = world;
    this.RAPIER = RAPIER;
    this.materials = materials;
    this.driving = false;
    this.phase = 0;
    this.faceYaw = 0;
    this._armsHidden = false;
    this.water = null; // map water body (set by loader); wading slows movement and disables jump

    const feetY = spawn.y;
    const cy = feetY + CAP_CENTER;
    const gravScale = (9.81 + P.extraGravityAccel) / 9.81;
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, cy, spawn.z)
      .lockRotations()
      .setLinearDamping(0.05)
      .setGravityScale(gravScale)
      .setCanSleep(false);
    this.body = world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.capsule(P.halfHeight, P.radius)
      .setFriction(0.0)
      .setRestitution(0.0)
      .setDensity(P.mass / (Math.PI * P.radius * P.radius * (P.halfHeight * 2 + P.radius * 4 / 3)));
    this.collider = world.createCollider(colDesc, this.body);

    // Character model group (model space -> feet origin). Built from the shared avatar assembler
    // so the in-game player, the lobby preview, and Phase 6 remote players use one code path.
    this.group = buildCharacterGroup(model, materials);
    this.decoded = this.group.userData.decoded;
    this.parts = this.group.userData.parts;
    scene.add(this.group);
    this._setHeadVisible(false);
  }

  _setHeadVisible(v) { if (this.parts.head) this.parts.head.visible = v; }

  // Hide the character's own arms while a first-person viewmodel supplies its own.
  setArmsHidden(hidden) {
    this._armsHidden = hidden;
    if (this.parts.armL) this.parts.armL.visible = !hidden;
    if (this.parts.armR) this.parts.armR.visible = !hidden;
  }

  horizontalSpeed() {
    if (this.driving || !this.body.isEnabled()) return 0;
    const v = this.body.linvel();
    return Math.hypot(v.x, v.z);
  }

  feetPosition() {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y - CAP_CENTER, t.z);
  }

  eyePosition() {
    const a = this.decoded.anchors.eye || [0, P.eyeHeightFallback, 0.05];
    const feet = this.feetPosition();
    const e = new THREE.Vector3(a[0], a[1], a[2]).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.faceYaw);
    return feet.add(e);
  }

  grounded() {
    const t = this.body.translation();
    const ray = new this.RAPIER.Ray({ x: t.x, y: t.y, z: t.z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, CAP_CENTER + P.groundRayExtra, true, undefined, undefined, undefined, this.body);
    return hit !== null;
  }

  update(dt, forward, right, input) {
    this.faceYaw = Math.atan2(forward.x, forward.z);
    if (this.driving) return;

    const F = forward.clone().setY(0).normalize();
    const R = right.clone().setY(0).normalize();
    const ax = input.axis();
    const wish = new THREE.Vector3()
      .addScaledVector(F, ax.z)
      .addScaledVector(R, -ax.x);
    const moving = wish.lengthSq() > 1e-4;
    if (moving) wish.normalize();

    const onGround = this.grounded();
    const sprint = input.down("ShiftLeft") || input.down("ShiftRight");
    let speed = sprint ? P.sprintSpeed : P.walkSpeed;

    // Wading: feet below the pond surface -> slowed, no jump (brief section 2.4).
    let wading = false;
    if (this.water) {
      const feet = this.feetPosition();
      const r = this.water.rect;
      if (feet.x >= r.x0 && feet.x <= r.x1 && feet.z >= r.z0 && feet.z <= r.z1 && feet.y < this.water.level) {
        wading = true;
        speed *= 0.45;
      }
    }

    const lv = this.body.linvel();
    const cur = new THREE.Vector3(lv.x, 0, lv.z);
    const target = wish.clone().multiplyScalar(moving ? speed : 0);
    const control = onGround ? 1 : P.airControl;
    const maxDelta = P.walkAccel * control * dt;
    const delta = target.clone().sub(cur);
    if (delta.length() > maxDelta) delta.setLength(maxDelta);
    cur.add(delta);

    let vy = lv.y;
    if (onGround && !wading && (input.down("Space")) && vy <= 0.1) vy = P.jumpVelocity;
    this.body.setLinvel({ x: cur.x, y: vy, z: cur.z }, true);
  }

  // Sync the visible model to the post-physics body state (position + limb swing).
  // Called after the fixed physics substeps so body and camera read the same state.
  syncModel(dt) {
    if (this.driving) return;
    const feet = this.feetPosition();
    this.group.position.copy(feet);
    this.group.rotation.set(0, this.faceYaw, 0);

    const lv = this.body.linvel();
    const hspeed = Math.hypot(lv.x, lv.z);
    if (this.grounded() && hspeed > 0.2) {
      this.phase += dt * P.limbSwingSpeed * (1 + hspeed);
    }
    const amp = Math.min(1, hspeed / P.walkSpeed) * P.limbSwingGain;
    const s = Math.sin(this.phase) * amp;
    if (this.parts.armL) this.parts.armL.rotation.x = s;
    if (this.parts.armR) this.parts.armR.rotation.x = -s;
    if (this.parts.legL) this.parts.legL.rotation.x = -s;
    if (this.parts.legR) this.parts.legR.rotation.x = s;
    this._setHeadVisible(false);
  }

  enterDriving() {
    this.driving = true;
    this.body.setEnabled(false);
    this.setArmsHidden(false);
    for (const k of ["legL", "legR"]) if (this.parts[k]) this.parts[k].rotation.x = -Math.PI / 2;
    for (const k of ["armL", "armR"]) if (this.parts[k]) this.parts[k].rotation.x = -0.6;
    this._setHeadVisible(true);
  }

  // Pose the seated model so the hips (torso pivot) land on the seat anchor.
  poseAtSeat(carPos, carQuat, seatAnchor) {
    const hipY = this.decoded.parts.torso ? this.decoded.parts.torso.pivot[1] : 0.84;
    const off = new THREE.Vector3(seatAnchor[0], seatAnchor[1] - hipY, seatAnchor[2]);
    const world = off.applyQuaternion(carQuat).add(carPos);
    this.group.position.copy(world);
    this.group.quaternion.copy(carQuat);
  }

  exitDriving(worldPos) {
    this.driving = false;
    const cy = worldPos.y + CAP_CENTER;
    this.body.setEnabled(true);
    this.body.setTranslation({ x: worldPos.x, y: cy, z: worldPos.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this._setHeadVisible(false);
  }
}
