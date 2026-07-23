// boat.js - watercraft: GroundVehicle suspension run against a virtual water plane (Phase 4 buoyancy)
import * as THREE from "three";
import { CONFIG } from "../config.js";
import { GroundVehicle } from "./ground.js";

// Each hull ray hardpoint that sits over water.rect and below the surface reports a virtual contact
// at the water plane, feeding the SAME spring math (springK*depth + damperC*compVel) the wheels use;
// tyre forces then run against that plane with the boat's deliberately low tireMu/lateralGrip so it
// wallows and slides. Anchors not over water fall back to the ground raycast (beached on sand).
export class BoatVehicle extends GroundVehicle {
  constructor(...args) {
    super(...args);
    this.isBoat = true;
  }

  _probeWheel(w, hpWorld, up, q, pos) {
    const water = this.water;
    if (water) {
      const V = this.V;
      const aw = this._tmp.set(w.anchor.x, w.anchor.y, w.anchor.z).applyQuaternion(q).add(pos);
      const r = water.rect;
      if (aw.x >= r.x0 && aw.x <= r.x1 && aw.z >= r.z0 && aw.z <= r.z1 && aw.y < water.level + V.suspensionRest) {
        this._waterAnchorsInWater++;
        const depth = THREE.MathUtils.clamp(water.level - aw.y, 0, V.suspensionRest + V.maxTravel);
        // Invert the wheel comp formula (comp = rest - (toi - wheelRadius)) so comp === depth.
        return { toi: V.suspensionRest + V.wheelRadius - depth };
      }
    }
    return super._probeWheel(w, hpWorld, up);
  }

  // Boats: floating (>=2 anchors in water) => moderate linear drag so the hull settles and wallows.
  _applyWaterDamping() {
    if (!this.water) return;
    this._setWaterDamp(this._waterAnchorsInWater >= 2, CONFIG.destruction.boatWaterDamping);
  }
}
