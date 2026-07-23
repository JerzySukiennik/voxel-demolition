// manager.js - vehicle spawn/despawn/lookup/nearest; permanent hatchback + max-1 player-spawned
import * as THREE from "three";
import { CONFIG } from "../config.js";
import { decodeModel, meshModelPart } from "../voxel.js";
import { VEHICLE_SPECS, resolveTuning } from "./registry.js";
import { GroundVehicle } from "./ground.js";
import { BoatVehicle } from "./boat.js";
import { HoverVehicle } from "./hover.js";
import { HeliVehicle } from "./heli.js";
import { PlaneVehicle } from "./plane.js";

const CONTROLLERS = {
  ground: GroundVehicle,
  boat: BoatVehicle,
  hover: HoverVehicle,
  heli: HeliVehicle,
  plane: PlaneVehicle,
};

const DEG = Math.PI / 180;

export class VehicleManager {
  constructor(scene, world, RAPIER, materials, destruction) {
    this.scene = scene;
    this.world = world;
    this.RAPIER = RAPIER;
    this.materials = materials;
    this.destruction = destruction;
    this.weapons = null;

    this.all = [];
    this.byHandle = new Map();
    this.permanent = null;   // pre-placed hatchback (never despawned)
    this.spawned = null;     // the single player-spawned vehicle
    this.driven = null;      // vehicle currently piloted (or null)
    this.decor = [];         // static parked vehicles (indestructible, not enterable, not impactors)
    this.water = null;       // map water body, propagated to drivable vehicles
  }

  setWeapons(weapons) { this.weapons = weapons; }
  setWater(water) { this.water = water; for (const v of this.all) v.water = water; }

  _create(spec, spawn) {
    const cls = CONTROLLERS[spec.controller];
    if (!cls) throw new Error("Unknown controller: " + spec.controller);
    const v = new cls(this.scene, this.world, this.RAPIER, spec, this.materials, spawn);
    v.water = this.water;
    for (const h of v.colliderHandles) {
      this.byHandle.set(h, v);
      this.destruction.registerImpactor(h);
    }
    this.all.push(v);
    return v;
  }

  // Pre-place the permanent hatchback (behavior-identical to Phase 1).
  spawnPermanent(id, spawn) {
    this.permanent = this._create(VEHICLE_SPECS[id], spawn);
    return this.permanent;
  }

  byColliderHandle(handle) { return this.byHandle.get(handle) || null; }

  nearest(pos, range) {
    let best = null, bestD = range;
    for (const v of this.all) {
      const d = pos.distanceTo(v.centerWorld());
      if (d <= bestD) { bestD = d; best = v; }
    }
    return best;
  }

  // Spawn from the menu: place clear of geometry in front of the player, replacing the
  // previous player-spawned vehicle (the permanent hatchback is untouched).
  spawnAt(id, player, yaw) {
    const spec = VEHICLE_SPECS[id];
    const V = resolveTuning(spec.tuning);
    const feet = player.feetPosition();
    const placement = this._findPlacement(V, feet, yaw, player.body);
    this.despawnSpawned();
    this.spawned = this._create(spec, { x: placement.x, y: placement.y, z: placement.z, yaw });
    return this.spawned;
  }

  _findPlacement(V, feet, yaw, excludeBody) {
    const hx = V.colliderHalf.x, hy = V.colliderHalf.y, hz = V.colliderHalf.z;
    const margin = CONFIG.vehicles.defaults.spawnClearanceMargin;
    const spawnQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const rq = { x: spawnQuat.x, y: spawnQuat.y, z: spawnQuat.z, w: spawnQuat.w };
    const shape = new this.RAPIER.Cuboid(hx * margin, hy * margin, hz * margin);

    let firstGroundY = null, firstXZ = null;
    for (const dist of [6, 8, 10]) {
      for (const ang of [0, 25 * DEG, -25 * DEG]) {
        const a = yaw + ang;
        const dir = new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a));
        const bx = feet.x + dir.x * dist, bz = feet.z + dir.z * dist;
        const ray = new this.RAPIER.Ray({ x: bx, y: feet.y + 6, z: bz }, { x: 0, y: -1, z: 0 });
        const hit = this.world.castRay(ray, 12, true, undefined, undefined, undefined, excludeBody);
        if (!hit) continue;
        const groundY = feet.y + 6 - hit.toi;
        if (firstGroundY == null) { firstGroundY = groundY; firstXZ = { x: bx, z: bz }; }
        const center = { x: bx, y: groundY + V.colliderCenterY, z: bz };
        const blocked = this.world.intersectionWithShape(
          center, rq, shape, undefined, undefined, undefined, excludeBody
        );
        if (!blocked) return { x: bx, y: groundY, z: bz };
      }
    }
    // All blocked: drop it in at 6 m ahead.
    if (firstXZ == null) {
      const dir = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      firstXZ = { x: feet.x + dir.x * 6, z: feet.z + dir.z * 6 };
      firstGroundY = feet.y;
    }
    return { x: firstXZ.x, y: firstGroundY + 1.5, z: firstXZ.z };
  }

  despawnSpawned() {
    const v = this.spawned;
    if (!v) return;
    if (this.driven === v) this.driven = null;
    if (this.weapons && this.weapons.dropVehicleCharges) this.weapons.dropVehicleCharges(v);
    for (const h of v.colliderHandles) {
      this.byHandle.delete(h);
      this.destruction.unregisterImpactor(h);
    }
    this.all = this.all.filter((x) => x !== v);
    v.despawn();
    this.spawned = null;
  }

  // Decorative parked vehicle (brief section 2.6): reuse the model as a static mesh group + ONE fixed
  // cuboid collider. NOT in `all` (nearest() ignores it), NOT an impactor, indestructible, blocks.
  spawnDecorative(id, place) {
    const spec = VEHICLE_SPECS[id];
    if (!spec) return null;
    const V = resolveTuning(spec.tuning);
    const decoded = decodeModel(spec.model);
    const groundY = CONFIG.world.skinThickness;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), place.yaw || 0);

    const bodyDesc = this.RAPIER.RigidBodyDesc.fixed()
      .setTranslation(place.x, groundY, place.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    const body = this.world.createRigidBody(bodyDesc);
    const colDesc = this.RAPIER.ColliderDesc.cuboid(V.colliderHalf.x, V.colliderHalf.y, V.colliderHalf.z)
      .setTranslation(0, V.colliderCenterY, 0)
      .setFriction(0.8)
      .setRestitution(0.05);
    this.world.createCollider(colDesc, body);

    const group = new THREE.Group();
    group.position.set(place.x, groundY, place.z);
    group.quaternion.copy(q);
    const chassis = new THREE.Mesh(meshModelPart(decoded, "body"), this.materials);
    chassis.castShadow = true;
    chassis.receiveShadow = true;
    group.add(chassis);
    const wheelPart = decoded.parts.wheel;
    if (wheelPart && !V.noWheelMesh) {
      const wp = wheelPart.pivot;
      for (const key of Object.keys(decoded.anchors)) {
        if (!key.startsWith("wheel")) continue;
        const a = decoded.anchors[key];
        const geo = meshModelPart(decoded, "wheel");
        geo.translate(-wp[0], -wp[1], -wp[2]);
        const m = new THREE.Mesh(geo, this.materials);
        m.castShadow = true;
        m.receiveShadow = true;
        m.position.set(a[0], a[1], a[2]);
        m.scale.set(a[0] < 0 ? -1 : 1, 1, 1);
        group.add(m);
      }
    }
    this.scene.add(group);
    this.decor.push({ body, group });
    return body;
  }

  update(dt, input) {
    for (const v of this.all) v.update(dt, input, v === this.driven);
  }

  // --- Phase 6 networked helpers (additive) --------------------------------------------------
  // Server-authoritative vehicles replicated on this client. They live in a SEPARATE map (never in
  // `all`), so the local controller loop never touches them; replication.js drives their kinematic
  // bodies from vstate/interp. When this client becomes a vehicle's driver, main.js flips it to a
  // dynamic body (setBodyKinematic false) and runs the controller directly for that one vehicle.
  _netMap() { if (!this._net) this._net = new Map(); return this._net; }

  byNetId(vid) { return this._netMap().get(vid) || null; }

  // Create a replicated vehicle (kinematic by default). Reuses the same controller class + model as a
  // local spawn so wheels/chassis/water context are identical, but stays out of `all`/impactors.
  spawnNetworked(vid, id, spawn) {
    const spec = VEHICLE_SPECS[id];
    if (!spec) return null;
    if (this._netMap().has(vid)) this.removeById(vid);
    const cls = CONTROLLERS[spec.controller];
    if (!cls) throw new Error("Unknown controller: " + spec.controller);
    const v = new cls(this.scene, this.world, this.RAPIER, spec, this.materials, spawn);
    v.water = this.water;
    v.netId = vid;
    for (const h of v.colliderHandles) this.byHandle.set(h, v);
    this._net.set(vid, v);
    this.setBodyKinematic(v, true);
    return v;
  }

  removeById(vid) {
    const v = this._netMap().get(vid);
    if (!v) return;
    if (this.driven === v) this.driven = null;
    if (this.weapons && this.weapons.dropVehicleCharges) this.weapons.dropVehicleCharges(v);
    for (const h of v.colliderHandles) this.byHandle.delete(h);
    this._net.delete(vid);
    v.despawn();
  }

  // Flip a replicated vehicle body between kinematic (server-driven) and dynamic (local driver).
  setBodyKinematic(v, isKinematic) {
    const RB = this.RAPIER.RigidBodyType;
    v.body.setBodyType(isKinematic ? RB.KinematicPositionBased : RB.Dynamic, true);
  }

  // Nearest replicated vehicle within range (MP enter/exit; `all` is empty on MP clients).
  nearestNetworked(pos, range) {
    let best = null, bestD = range;
    for (const v of this._netMap().values()) {
      const d = pos.distanceTo(v.centerWorld());
      if (d <= bestD) { bestD = d; best = v; }
    }
    return best;
  }
}
