// ground.js - N-wheel raycast-suspension ground vehicle (generalized Phase 1 hatchback physics)
import * as THREE from "three";
import { CONFIG } from "../config.js";
import { decodeModel, meshModelPart } from "../voxel.js";
import { resolveTuning } from "./registry.js";

export class GroundVehicle {
  constructor(scene, world, RAPIER, spec, materials, spawn) {
    this.scene = scene;
    this.world = world;
    this.RAPIER = RAPIER;
    this.spec = spec;
    this.decoded = decodeModel(spec.model);
    this.materials = materials;
    this.V = resolveTuning(spec.tuning);
    this.steer = 0;
    this.wheelSpin = 0;
    this.speed = 0;
    // Water (set by the manager from map.water; null on dry maps). Enables buoyancy (boats) / drag (cars).
    this.water = null;
    this.isBoat = false;
    this._waterAnchorsInWater = 0;
    this._waterDampOn = false;
    this._tmp = new THREE.Vector3();

    const V = this.V;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spawn.yaw || 0);
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y + V.spawnBodyY, spawn.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(V.linearDamping)
      .setAngularDamping(V.angularDamping)
      .setCanSleep(false);
    this.body = world.createRigidBody(bodyDesc);
    this._baseDamp = V.linearDamping;
    const colDesc = RAPIER.ColliderDesc.cuboid(V.colliderHalf.x, V.colliderHalf.y, V.colliderHalf.z)
      .setTranslation(0, V.colliderCenterY, 0)
      .setDensity(0)
      .setFriction(0.7)
      .setRestitution(0.05);
    this.collider = world.createCollider(colDesc, this.body);
    this.colliderHandles = [this.collider.handle];
    this.body.setAdditionalMassProperties(V.mass, V.com, V.inertia, { x: 0, y: 0, z: 0, w: 1 }, true);

    // Chassis mesh.
    const bodyGeo = meshModelPart(this.decoded, "body");
    this.chassis = new THREE.Mesh(bodyGeo, materials);
    this.chassis.castShadow = true;
    this.chassis.receiveShadow = true;
    scene.add(this.chassis);

    this._buildWheels();
    this.maxLen = V.suspensionRest + V.wheelRadius;
    this.syncMeshes();
  }

  // Build ray hardpoints (and optional wheel meshes) from the model's wheel* anchors, or from
  // the tuning rayAnchors when the model has no wheel anchors (tracked excavator, boats).
  _buildWheels() {
    const V = this.V;
    const a = this.decoded.anchors;
    const steeredSet = V.steeredAnchors ? new Set(V.steeredAnchors) : null;
    const isSteered = (key, z) => (steeredSet ? steeredSet.has(key) : z > 0);

    // Collect wheel anchors from the model (any key starting with "wheel").
    const anchorList = [];
    for (const key of Object.keys(a)) {
      if (!key.startsWith("wheel")) continue;
      const v = a[key];
      anchorList.push({ key, pos: [v[0], v[1], v[2]] });
    }
    let useMesh = false;
    if (anchorList.length === 0) {
      // No wheel anchors: use virtual ray hardpoints from tuning (or a collider-corner fallback).
      const rays = V.rayAnchors || [
        [V.colliderHalf.x, V.wheelRadius, V.colliderHalf.z],
        [-V.colliderHalf.x, V.wheelRadius, V.colliderHalf.z],
        [V.colliderHalf.x, V.wheelRadius, -V.colliderHalf.z],
        [-V.colliderHalf.x, V.wheelRadius, -V.colliderHalf.z],
      ];
      for (let i = 0; i < rays.length; i++) anchorList.push({ key: "ray" + i, pos: rays[i].slice() });
    } else {
      useMesh = this.decoded.parts.wheel != null && !V.noWheelMesh;
    }

    const wheelPart = this.decoded.parts.wheel;
    const wp = wheelPart ? wheelPart.pivot : [0, V.wheelRadius, 0];
    this.wheels = [];
    for (const item of anchorList) {
      const [ax, ay, az] = item.pos;
      let mesh = null;
      if (useMesh) {
        const geo = meshModelPart(this.decoded, "wheel");
        geo.translate(-wp[0], -wp[1], -wp[2]);
        mesh = new THREE.Mesh(geo, this.materials);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
      }
      this.wheels.push({
        anchor: new THREE.Vector3(ax, ay, az),
        hardpoint: new THREE.Vector3(ax, ay + V.suspensionRest, az),
        steered: isSteered(item.key, az),
        mirror: ax < 0,
        mesh, prevComp: 0, contactY: ay, driven: true,
      });
    }
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
  wheelAngularSpeed() { return this.speed / this.V.wheelRadius; }
  speedNorm() { return THREE.MathUtils.clamp(Math.abs(this.speed) / this.V.audioSpeedRef, 0, 1); }

  update(dt, input, driving) {
    const V = this.V;
    const q = this.quaternion();
    const pos = this.centerWorld();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const right = new THREE.Vector3().crossVectors(fwd, up); // car's right = -X

    const lv = this.body.linvel();
    const vel = new THREE.Vector3(lv.x, lv.y, lv.z);
    const av = this.body.angvel();
    const angvel = new THREE.Vector3(av.x, av.y, av.z);
    this.speed = vel.dot(fwd);
    const absSpeed = Math.abs(this.speed);

    // Steering target.
    let steerTarget = 0;
    if (driving) {
      const ax = input.axis();
      const t = (absSpeed - V.steerLowSpeed) / (V.steerHighSpeed - V.steerLowSpeed);
      const maxSteer = THREE.MathUtils.lerp(V.steerLow, V.steerHigh, THREE.MathUtils.clamp(t, 0, 1));
      steerTarget = ax.x * maxSteer;
    }
    const dsteer = THREE.MathUtils.clamp(steerTarget - this.steer, -V.steerRate * dt, V.steerRate * dt);
    this.steer += dsteer;

    // Throttle / brake.
    let throttle = 0;
    if (driving) throttle = input.axis().z;

    const wheelCount = this.wheels.length;
    const enginePer = V.engineForce / wheelCount;
    const brakePer = V.brakeForce / wheelCount;
    const reversePer = V.reverseForce / wheelCount;

    this._waterAnchorsInWater = 0;
    for (const w of this.wheels) {
      const hpWorld = w.hardpoint.clone().applyQuaternion(q).add(pos);
      const hit = this._probeWheel(w, hpWorld, up, q, pos);

      let comp = 0, grounded = false, contactPoint = null;
      if (hit) {
        const hitDist = hit.toi;
        grounded = true;
        comp = THREE.MathUtils.clamp(V.suspensionRest - (hitDist - V.wheelRadius), 0, V.suspensionRest + V.maxTravel);
        contactPoint = hpWorld.clone().addScaledVector(up, -hitDist);
        w.contactY = w.hardpoint.y - hitDist + V.wheelRadius; // wheel center = contact + radius (car space)
      } else {
        w.contactY = w.hardpoint.y - V.suspensionRest;
      }

      if (grounded) {
        const compVel = (comp - w.prevComp) / dt;
        let springF = V.springK * comp + V.damperC * compVel;
        springF = THREE.MathUtils.clamp(springF, 0, V.springForceClamp);
        this.body.applyImpulseAtPoint(
          { x: up.x * springF * dt, y: up.y * springF * dt, z: up.z * springF * dt },
          { x: hpWorld.x, y: hpWorld.y, z: hpWorld.z },
          true
        );

        // Steered basis for this wheel.
        let wf = fwd, wr = right;
        if (w.steered && this.steer !== 0) {
          const sq = new THREE.Quaternion().setFromAxisAngle(up, this.steer);
          wf = fwd.clone().applyQuaternion(sq);
          wr = right.clone().applyQuaternion(sq);
        }

        // Velocity at contact point.
        const r = contactPoint.clone().sub(pos);
        const pv = vel.clone().add(new THREE.Vector3().crossVectors(angvel, r));
        const vForward = pv.dot(wf);
        const vLat = pv.dot(wr);
        const load = springF;

        // Longitudinal force (engine / brake / reverse), split per wheel.
        let longF = 0;
        if (driving && w.driven) {
          if (throttle > 0) longF = enginePer * throttle;
          else if (throttle < 0) {
            if (this.speed > 0.5) longF = -brakePer;
            else longF = -reversePer;
          }
        }
        // Rolling resistance / engine braking when coasting.
        if (!driving || throttle === 0) longF += -vForward * 0.5 * load * 0.02;

        // Lateral grip (force, clamped by friction circle below).
        const latForce = -vLat * V.lateralGrip * load;

        // Friction circle clamp on combined force.
        const maxF = V.tireMu * load;
        let fx = longF, fy = latForce;
        const mag = Math.hypot(fx, fy);
        if (mag > maxF && mag > 1e-3) {
          const s = maxF / mag;
          fx *= s; fy *= s;
        }
        const tire = wf.clone().multiplyScalar(fx).add(wr.clone().multiplyScalar(fy));
        this.body.applyImpulseAtPoint(
          { x: tire.x * dt, y: tire.y * dt, z: tire.z * dt },
          { x: contactPoint.x, y: contactPoint.y, z: contactPoint.z },
          true
        );
        w.prevComp = comp;
      } else {
        w.prevComp = 0;
      }
    }

    this._applyWaterDamping();

    // Wheel spin from forward speed.
    this.wheelSpin += (this.speed / V.wheelRadius) * dt;
    this.syncMeshes();
  }

  // Wheel-contact probe: default is the ground raycast. BoatVehicle overrides to add a virtual
  // water plane. Returns a hit-like object with `.toi` (metres along -up), or null (airborne).
  _probeWheel(w, hpWorld, up) {
    const ray = new this.RAPIER.Ray(
      { x: hpWorld.x, y: hpWorld.y, z: hpWorld.z },
      { x: -up.x, y: -up.y, z: -up.z }
    );
    return this.world.castRay(ray, this.maxLen, true, undefined, undefined, undefined, this.body);
  }

  _insideWaterXZ() {
    const t = this.body.translation();
    const r = this.water.rect;
    return t.x >= r.x0 && t.x <= r.x1 && t.z >= r.z0 && t.z <= r.z1;
  }

  _setWaterDamp(on, val) {
    if (on && !this._waterDampOn) { this.body.setLinearDamping(val); this._waterDampOn = true; }
    else if (!on && this._waterDampOn) { this.body.setLinearDamping(this._baseDamp); this._waterDampOn = false; }
  }

  // Cars: body center below the water level (inside the pond) => heavy linear drag (brief section 2.4).
  _applyWaterDamping() {
    if (!this.water) return;
    const below = this._insideWaterXZ() && this.body.translation().y < this.water.level;
    this._setWaterDamp(below, CONFIG.destruction.carWaterDamping);
  }

  syncMeshes() {
    const q = this.quaternion();
    const pos = this.centerWorld();
    this.chassis.position.copy(pos);
    this.chassis.quaternion.copy(q);

    for (const w of this.wheels) {
      if (!w.mesh) continue;
      const local = new THREE.Vector3(w.anchor.x, w.contactY, w.anchor.z);
      const world = local.clone().applyQuaternion(q).add(pos);
      w.mesh.position.copy(world);
      const wq = q.clone();
      if (w.steered) wq.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.steer));
      wq.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.wheelSpin));
      w.mesh.quaternion.copy(wq);
      w.mesh.scale.set(w.mirror ? -1 : 1, 1, 1);
    }
  }

  despawn() {
    this.scene.remove(this.chassis);
    this.chassis.geometry.dispose();
    for (const w of this.wheels) {
      if (!w.mesh) continue;
      this.scene.remove(w.mesh);
      w.mesh.geometry.dispose();
    }
    this.world.removeRigidBody(this.body);
  }
}
