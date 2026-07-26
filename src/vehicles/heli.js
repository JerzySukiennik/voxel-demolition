// heli.js - helicopter: collective lift, cyclic pitch/roll, pedal yaw, auto-level, spinning rotors
import * as THREE from "three";
import { decodeModel, meshModelPart } from "../voxel.js";
import { resolveTuning } from "./registry.js";

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const G = 9.81;

export class HeliVehicle {
  constructor(scene, world, RAPIER, spec, materials, spawn) {
    this.scene = scene;
    this.world = world;
    this.RAPIER = RAPIER;
    this.spec = spec;
    this.decoded = decodeModel(spec.model);
    this.materials = materials;
    this.V = resolveTuning(spec.tuning);
    const V = this.V;
    this.collective = V.collectiveNeutral;
    this._rotorMainAngle = 0;
    this._rotorTailAngle = 0;

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
      .setFriction(0.6)
      .setRestitution(0.05);
    this.collider = world.createCollider(colDesc, this.body);
    this.colliderHandles = [this.collider.handle];
    this.body.setAdditionalMassProperties(V.mass, V.com, V.inertia, { x: 0, y: 0, z: 0, w: 1 }, true);

    this.chassis = new THREE.Mesh(meshModelPart(this.decoded, "body"), materials);
    this.chassis.castShadow = true;
    this.chassis.receiveShadow = true;
    scene.add(this.chassis);

    // Spinning rotor parts (children of the chassis so they inherit the body transform).
    this.rotorMain = this._makeSpinPart("rotorMain");
    this.rotorTail = this._makeSpinPart("rotorTail");

    this.syncMeshes();
  }

  _makeSpinPart(name) {
    const part = this.decoded.parts[name];
    if (!part) return null;
    const geo = meshModelPart(this.decoded, name);
    const piv = part.pivot;
    geo.translate(-piv[0], -piv[1], -piv[2]);
    const mesh = new THREE.Mesh(geo, this.materials);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.position.set(piv[0], piv[1], piv[2]);
    this.chassis.add(mesh);
    return mesh;
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
  seatAnchor() { return this.decoded.anchors.seat || [0.5, 1.1, 2.8]; }
  exitAnchor() { return this.decoded.anchors.exit || [2.0, 0.0, 2.8]; }
  speedNorm() { return THREE.MathUtils.clamp((this.collective - 0.3) / 0.7, 0, 1); }

  update(dt, input, driving) {
    const V = this.V;
    const q = this.quaternion();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const right = new THREE.Vector3().crossVectors(fwd, up);

    if (driving) {
      if (input.down("Space")) this.collective = Math.min(1, this.collective + V.collectiveRate * dt);
      if (input.down("ShiftLeft")) this.collective = Math.max(0, this.collective - V.collectiveRate * dt);
    }

    // Collective lift, capped. The thrust axis is blended toward world-up by liftAssist: with pure body-up
    // thrust every bank costs altitude, which made the helicopter sink whenever the player turned. The
    // blend keeps the machine flying while still leaning into the direction of travel.
    let thrust = (this.collective / V.collectiveNeutral) * V.mass * G;
    thrust = Math.min(thrust, V.thrustMaxG * V.mass * G);
    const assist = V.liftAssist || 0;
    const lift = up.clone().multiplyScalar(1 - assist).addScaledVector(WORLD_UP, assist).normalize();
    this.body.applyImpulse({ x: lift.x * thrust * dt, y: lift.y * thrust * dt, z: lift.z * thrust * dt }, true);

    // Cyclic + pedals (body-frame torques).
    if (driving) {
      const ax = input.axis();
      const pitchIn = ax.z;               // W nose-down / S nose-up
      const rollIn = ax.x;                // A / D
      const yawIn = (input.down("KeyQ") ? 1 : 0) - (input.down("KeyE") ? 1 : 0);
      const tp = right.clone().multiplyScalar(V.pitchTorqueK * V.inertia.x * pitchIn * dt);
      const tr = fwd.clone().multiplyScalar(V.rollTorqueK * V.inertia.z * rollIn * dt);
      const ty = up.clone().multiplyScalar(V.yawTorqueK * V.inertia.y * yawIn * dt);
      const tt = tp.add(tr).add(ty);
      this.body.applyTorqueImpulse({ x: tt.x, y: tt.y, z: tt.z }, true);

      // Direct translation assist. With a strong self-levelling spring the machine barely banks, and a
      // helicopter that only moves by banking would then go nowhere. Push it along the flattened body
      // axes instead, so the stick actually flies it; the small residual bank is just for looks.
      const flatF = new THREE.Vector3(fwd.x, 0, fwd.z);
      const flatR = new THREE.Vector3(right.x, 0, right.z);
      if (flatF.lengthSq() > 1e-6) flatF.normalize();
      if (flatR.lengthSq() > 1e-6) flatR.normalize();
      const move = flatF.multiplyScalar(-pitchIn).addScaledVector(flatR, -rollIn);
      if (move.lengthSq() > 1e-6) {
        move.normalize().multiplyScalar(V.moveAccel * V.mass * dt);
        this.body.applyImpulse({ x: move.x, y: 0, z: move.z }, true);
      }
    }

    // Auto-level spring toward upright. cross(up, WORLD_UP) has magnitude sin(tilt), which vanishes BOTH
    // at upright and at exactly inverted — so a craft flipped onto its back sat at a torque-free unstable
    // equilibrium and never recovered. Use the tilt ANGLE for magnitude and fall back to the body forward
    // axis at that pole, so it always rights itself. Small angles are unchanged (sin θ ≈ θ).
    const tilt = Math.acos(THREE.MathUtils.clamp(up.dot(WORLD_UP), -1, 1));
    const levelAxis = new THREE.Vector3().crossVectors(up, WORLD_UP);
    if (levelAxis.lengthSq() < 1e-8) levelAxis.copy(fwd); else levelAxis.normalize();
    const lt = levelAxis.multiplyScalar(V.autoLevel * tilt * V.inertia.x * dt);
    this.body.applyTorqueImpulse({ x: lt.x, y: lt.y, z: lt.z }, true);

    // Rotor spin.
    this._rotorMainAngle += V.rotorMainSpeed * (0.4 + this.collective) * dt;
    this._rotorTailAngle += V.rotorTailSpeed * dt;
    this.syncMeshes();
  }

  syncMeshes() {
    const q = this.quaternion();
    const pos = this.centerWorld();
    this.chassis.position.copy(pos);
    this.chassis.quaternion.copy(q);
    if (this.rotorMain) this.rotorMain.rotation.y = this._rotorMainAngle;
    if (this.rotorTail) this.rotorTail.rotation.x = this._rotorTailAngle;
  }

  despawn() {
    for (const m of [this.rotorMain, this.rotorTail]) {
      if (m) { m.geometry.dispose(); if (m.parent) m.parent.remove(m); }
    }
    this.scene.remove(this.chassis);
    this.chassis.geometry.dispose();
    this.world.removeRigidBody(this.body);
  }
}
