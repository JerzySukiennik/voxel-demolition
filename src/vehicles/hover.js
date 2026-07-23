// hover.js - low-altitude hover craft: 4 thruster-ray springs, yaw/glide controls, additive glow
import * as THREE from "three";
import { decodeModel, meshModelPart } from "../voxel.js";
import { resolveTuning } from "./registry.js";

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const G = 9.81;

export class HoverVehicle {
  constructor(scene, world, RAPIER, spec, materials, spawn) {
    this.scene = scene;
    this.world = world;
    this.RAPIER = RAPIER;
    this.spec = spec;
    this.decoded = decodeModel(spec.model);
    this.materials = materials;
    this.V = resolveTuning(spec.tuning);
    const V = this.V;
    this.hoverHeight = V.hoverHeight;
    this._hspeed = 0;
    this._glowPhase = 0;

    const q = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, spawn.yaw || 0);
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y + V.spawnBodyY, spawn.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(V.linearDamping)
      .setAngularDamping(V.angularDamping)
      .setCanSleep(false);
    this.body = world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.cuboid(V.colliderHalf.x, V.colliderHalf.y, V.colliderHalf.z)
      .setTranslation(0, V.colliderCenterY, 0)
      .setDensity(0)
      .setFriction(0.4)
      .setRestitution(0.05);
    this.collider = world.createCollider(colDesc, this.body);
    this.colliderHandles = [this.collider.handle];
    this.body.setAdditionalMassProperties(V.mass, V.com, V.inertia, { x: 0, y: 0, z: 0, w: 1 }, true);

    this.chassis = new THREE.Mesh(meshModelPart(this.decoded, "body"), materials);
    this.chassis.castShadow = true;
    this.chassis.receiveShadow = true;
    scene.add(this.chassis);

    // Thruster ray anchors (fall back to collider corners if the model lacks them).
    const a = this.decoded.anchors;
    const t = (k, def) => (a[k] ? a[k].slice() : def);
    const hx = V.colliderHalf.x, hz = V.colliderHalf.z;
    this.thrusters = [
      t("thrusterFL", [hx, 0.25, hz]),
      t("thrusterFR", [-hx, 0.25, hz]),
      t("thrusterRL", [hx, 0.25, -hz]),
      t("thrusterRR", [-hx, 0.25, -hz]),
    ].map((p) => new THREE.Vector3(p[0], p[1], p[2]));

    // Shared additive glow quad under the hull (no PointLight).
    const gs = V.glowSize;
    const glowGeo = new THREE.PlaneGeometry(gs.x, gs.z);
    this._glowMat = new THREE.MeshBasicMaterial({
      color: 0x33ddff, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.glow = new THREE.Mesh(glowGeo, this._glowMat);
    this.glow.rotation.x = -Math.PI / 2;
    scene.add(this.glow);

    this.syncMeshes();
  }

  centerWorld() {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }
  position() { return this.centerWorld(); }
  quaternion() {
    const r = this.body.rotation();
    return new THREE.Quaternion(r.x, r.y, r.z, r.w);
  }
  seatAnchor() { return this.decoded.anchors.seat || [0.38, 0.55, 0.20]; }
  exitAnchor() { return this.decoded.anchors.exit || [1.60, 0.0, 0.20]; }
  speedNorm() { return THREE.MathUtils.clamp(this._hspeed / 18, 0, 1); }

  update(dt, input, driving) {
    const V = this.V;
    const q = this.quaternion();
    const pos = this.centerWorld();
    const lv = this.body.linvel();
    const vel = new THREE.Vector3(lv.x, lv.y, lv.z);
    const vVert = vel.y;

    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const flatFwd = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (flatFwd.lengthSq() > 1e-6) flatFwd.normalize();
    const flatRight = new THREE.Vector3().crossVectors(flatFwd, WORLD_UP);
    this._hspeed = Math.hypot(vel.x, vel.z);

    // Altitude control.
    if (driving) {
      let dh = 0;
      if (input.down("Space")) dh += V.altRate * dt;
      if (input.down("ShiftLeft")) dh -= V.altRate * dt;
      this.hoverHeight = THREE.MathUtils.clamp(this.hoverHeight + dh, V.hoverMin, V.hoverMax);
    }

    // Per-thruster hover spring (self-levelling from the anchor offsets).
    const kHtotal = V.hoverSpringK * V.mass;
    const cHtotal = V.hoverDamperC * V.mass;
    const rayLen = this.hoverHeight + 2;
    for (const anchor of this.thrusters) {
      const wp = anchor.clone().applyQuaternion(q).add(pos);
      const ray = new this.RAPIER.Ray({ x: wp.x, y: wp.y, z: wp.z }, { x: 0, y: -1, z: 0 });
      const hit = this.world.castRay(ray, rayLen, true, undefined, undefined, undefined, this.body);
      if (!hit) continue;
      const dist = hit.toi;
      let f = V.mass * G / 4 + (kHtotal / 4) * (this.hoverHeight - dist) - (cHtotal / 4) * vVert;
      if (f < 0) f = 0;
      this.body.applyImpulseAtPoint(
        { x: 0, y: f * dt, z: 0 },
        { x: wp.x, y: wp.y, z: wp.z },
        true
      );
    }

    // Horizontal glide + yaw.
    if (driving) {
      const ax = input.axis();
      if (ax.z !== 0) {
        const th = ax.z * V.thrustAccel * V.mass;
        this.body.applyImpulse({ x: flatFwd.x * th * dt, y: 0, z: flatFwd.z * th * dt }, true);
      }
      const av = this.body.angvel();
      const desiredYaw = ax.x * V.yawRate;
      const yawT = (desiredYaw - av.y) * V.inertia.y * 6 * dt;
      this.body.applyTorqueImpulse({ x: 0, y: yawT, z: 0 }, true);
    }
    // Lateral damping so it glides forward, not skates sideways.
    const vLat = vel.dot(flatRight);
    const latF = -vLat * V.latDamp * V.mass;
    this.body.applyImpulse({ x: flatRight.x * latF * dt, y: 0, z: flatRight.z * latF * dt }, true);

    this._glowPhase += dt;
    this.syncMeshes();
  }

  syncMeshes() {
    const q = this.quaternion();
    const pos = this.centerWorld();
    this.chassis.position.copy(pos);
    this.chassis.quaternion.copy(q);

    // Glow: flat under the hull, gentle opacity pulse.
    const bottom = new THREE.Vector3(0, this.V.colliderCenterY - this.V.colliderHalf.y - 0.05, 0)
      .applyQuaternion(q).add(pos);
    this.glow.position.set(pos.x, bottom.y, pos.z);
    this.glow.rotation.y = Math.atan2(
      new THREE.Vector3(0, 0, 1).applyQuaternion(q).x,
      new THREE.Vector3(0, 0, 1).applyQuaternion(q).z
    );
    this._glowMat.opacity = 0.25 + 0.2 * (0.5 + 0.5 * Math.sin(this._glowPhase * 4));
  }

  despawn() {
    this.scene.remove(this.chassis);
    this.chassis.geometry.dispose();
    this.scene.remove(this.glow);
    this.glow.geometry.dispose();
    this._glowMat.dispose();
    this.world.removeRigidBody(this.body);
  }
}
