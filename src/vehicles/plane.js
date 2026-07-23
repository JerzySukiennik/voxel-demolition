// plane.js - fixed-wing: throttle thrust, airspeed-dependent lift/stall, gear rays, spinning prop
import * as THREE from "three";
import { decodeModel, meshModelPart } from "../voxel.js";
import { resolveTuning } from "./registry.js";

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const G = 9.81;

export class PlaneVehicle {
  constructor(scene, world, RAPIER, spec, materials, spawn) {
    this.scene = scene;
    this.world = world;
    this.RAPIER = RAPIER;
    this.spec = spec;
    this.decoded = decodeModel(spec.model);
    this.materials = materials;
    this.V = resolveTuning(spec.tuning);
    const V = this.V;
    this.throttle = 0;
    this._propAngle = 0;
    this.speed = 0;

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

    this.prop = this._makeProp();

    // Fixed-gear ray hardpoints.
    const a = this.decoded.anchors;
    const hx = V.colliderHalf.x, hz = V.colliderHalf.z;
    const gear = (k, def) => new THREE.Vector3(...(a[k] ? a[k] : def));
    this.gear = [
      gear("gearL", [hx, 0, -hz * 0.4]),
      gear("gearR", [-hx, 0, -hz * 0.4]),
      gear("gearN", [0, 0, hz * 0.8]),
    ];
    this._gearPrev = [0, 0, 0];
    this._kLift = (V.mass * G) / (V.vRef * V.vRef);

    this.syncMeshes();
  }

  _makeProp() {
    const part = this.decoded.parts.prop;
    if (!part) return null;
    const geo = meshModelPart(this.decoded, "prop");
    const piv = part.pivot;
    geo.translate(-piv[0], -piv[1], -piv[2]);
    const mesh = new THREE.Mesh(geo, this.materials);
    mesh.castShadow = false;
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
  seatAnchor() { return this.decoded.anchors.seat || [0.4, 1.0, 0.4]; }
  exitAnchor() { return this.decoded.anchors.exit || [1.8, 0.0, 0.4]; }
  speedNorm() { return this.throttle; }

  update(dt, input, driving) {
    const V = this.V;
    const q = this.quaternion();
    const pos = this.centerWorld();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const right = new THREE.Vector3().crossVectors(fwd, up);

    const lv = this.body.linvel();
    const vel = new THREE.Vector3(lv.x, lv.y, lv.z);
    const av = this.body.angvel();
    const angvel = new THREE.Vector3(av.x, av.y, av.z);
    const vFwd = vel.dot(fwd);
    const spd = vel.length();
    this.speed = vFwd;

    if (driving) {
      if (input.down("Space")) this.throttle = Math.min(1, this.throttle + V.throttleRate * dt);
      if (input.down("ShiftLeft")) this.throttle = Math.max(0, this.throttle - V.throttleRate * dt);
    }

    // Thrust along body forward.
    const thrust = this.throttle * V.thrustMaxK * V.mass;
    this.body.applyImpulse({ x: fwd.x * thrust * dt, y: fwd.y * thrust * dt, z: fwd.z * thrust * dt }, true);

    // Lift along body up (needs airspeed; mushes below stall).
    const vc = THREE.MathUtils.clamp(vFwd, 0, V.vRef);
    let lift = this._kLift * vc * vc;
    if (vFwd < V.vStall) {
      const s = THREE.MathUtils.clamp(vFwd / V.vStall, 0, 1);
      lift *= s * s;
    }
    this.body.applyImpulse({ x: up.x * lift * dt, y: up.y * lift * dt, z: up.z * lift * dt }, true);

    // Drag opposing velocity.
    if (spd > 1e-3) {
      const dragMag = V.dragK * V.mass * spd * spd / V.vRef;
      const d = vel.clone().multiplyScalar(-dragMag / spd);
      this.body.applyImpulse({ x: d.x * dt, y: d.y * dt, z: d.z * dt }, true);
    }

    // Controls (body-frame torques): W/S pitch, A/D roll, Q/E rudder yaw.
    if (driving) {
      const ax = input.axis();
      const yawIn = (input.down("KeyQ") ? 1 : 0) - (input.down("KeyE") ? 1 : 0);
      const tp = right.clone().multiplyScalar(V.pitchTorqueK * V.inertia.x * ax.z * dt);
      const tr = fwd.clone().multiplyScalar(V.rollTorqueK * V.inertia.z * ax.x * dt);
      const ty = up.clone().multiplyScalar(V.yawTorqueK * V.inertia.y * yawIn * dt);
      const tt = tp.add(tr).add(ty);
      this.body.applyTorqueImpulse({ x: tt.x, y: tt.y, z: tt.z }, true);
    }

    // Auto-level spring toward upright.
    const levelAxis = new THREE.Vector3().crossVectors(up, WORLD_UP).multiplyScalar(V.autoLevel * V.inertia.x * dt);
    this.body.applyTorqueImpulse({ x: levelAxis.x, y: levelAxis.y, z: levelAxis.z }, true);

    // Fixed-gear suspension (keeps it on the runway; rolls, then lifts off with airspeed).
    for (let i = 0; i < this.gear.length; i++) {
      const anchor = this.gear[i];
      const hp = new THREE.Vector3(anchor.x, anchor.y + V.gearRest, anchor.z).applyQuaternion(q).add(pos);
      const ray = new this.RAPIER.Ray({ x: hp.x, y: hp.y, z: hp.z }, { x: -up.x, y: -up.y, z: -up.z });
      const maxLen = V.gearRest + V.gearWheelRadius;
      const hit = this.world.castRay(ray, maxLen, true, undefined, undefined, undefined, this.body);
      if (!hit) { this._gearPrev[i] = 0; continue; }
      const comp = THREE.MathUtils.clamp(V.gearRest - (hit.toi - V.gearWheelRadius), 0, V.gearRest + V.gearMaxTravel);
      const compVel = (comp - this._gearPrev[i]) / dt;
      let f = V.gearSpringK * comp + V.gearDamperC * compVel;
      f = THREE.MathUtils.clamp(f, 0, 40 * V.mass);
      this.body.applyImpulseAtPoint(
        { x: up.x * f * dt, y: up.y * f * dt, z: up.z * f * dt },
        { x: hp.x, y: hp.y, z: hp.z },
        true
      );
      this._gearPrev[i] = comp;
    }

    this._propAngle += (V.propSpeedBase + V.propSpeedMax * this.throttle) * dt;
    this.syncMeshes();
  }

  syncMeshes() {
    const q = this.quaternion();
    const pos = this.centerWorld();
    this.chassis.position.copy(pos);
    this.chassis.quaternion.copy(q);
    if (this.prop) this.prop.rotation.z = this._propAngle;
  }

  despawn() {
    if (this.prop) { this.prop.geometry.dispose(); if (this.prop.parent) this.prop.parent.remove(this.prop); }
    this.scene.remove(this.chassis);
    this.chassis.geometry.dispose();
    this.world.removeRigidBody(this.body);
  }
}
