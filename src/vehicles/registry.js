// registry.js - VEHICLE_SPECS table (id -> spec), model imports, and tuning derivation
import { CONFIG } from "../config.js";
import hatchbackModel from "../../assets/models/hatchback.js";
import racecarModel from "../../assets/models/racecar.js";
import wagonModel from "../../assets/models/wagon.js";
import classicModel from "../../assets/models/classic.js";
import pickupModel from "../../assets/models/pickup.js";
import suvModel from "../../assets/models/suv.js";
import buggyModel from "../../assets/models/buggy.js";
import monsterModel from "../../assets/models/monster.js";
import wexcavModel from "../../assets/models/wexcav.js";
import texcavModel from "../../assets/models/texcav.js";
import craneModel from "../../assets/models/crane.js";
import hoverModel from "../../assets/models/hover.js";
import heliModel from "../../assets/models/heli.js";
import planeModel from "../../assets/models/plane.js";
import yachtModel from "../../assets/models/yacht.js";
import speedboatModel from "../../assets/models/speedboat.js";

// Phase 3 model roster (all 15 artist files landed and validated against the contract).
const MODELS = {
  hatchback: hatchbackModel,
  racecar: racecarModel,
  wagon: wagonModel,
  classic: classicModel,
  pickup: pickupModel,
  suv: suvModel,
  buggy: buggyModel,
  monster: monsterModel,
  wexcav: wexcavModel,
  texcav: texcavModel,
  crane: craneModel,
  hover: hoverModel,
  heli: heliModel,
  plane: planeModel,
  yacht: yachtModel,
  speedboat: speedboatModel,
};

// Audio loop profiles (§5). loop = GameAudio category; rate/gain ranges follow speedNorm (0..1).
const AUDIO = {
  car: { loop: "engine", rateIdle: 0.75, rateMax: 2.1, gainIdle: 0.18, gainMax: 0.5 },
  racecar: { loop: "engine", rateIdle: 0.75, rateMax: 2.4, gainIdle: 0.18, gainMax: 0.5 },
  heavy: { loop: "engine", rateIdle: 0.45, rateMax: 1.3, gainIdle: 0.22, gainMax: 0.55 },
  boat: { loop: "boat", rateIdle: 0.7, rateMax: 1.6, gainIdle: 0.2, gainMax: 0.5 },
  hover: { loop: "hover", rateIdle: 0.9, rateMax: 1.4, gainIdle: 0.25, gainMax: 0.45 },
  heli: { loop: "rotor", rateIdle: 0.8, rateMax: 1.15, gainIdle: 0.3, gainMax: 0.6 },
  plane: { loop: "plane", rateIdle: 0.7, rateMax: 1.9, gainIdle: 0.25, gainMax: 0.6 },
};

// Roster. `controller` selects the physics class; `tuning` keys into CONFIG.vehicles;
// `camera` keys into CONFIG.camera.chase; `tile` = menu swatch (primary body colour).
// Menu order = declaration order (grid fills 4 columns left-to-right, top-to-bottom).
export const VEHICLE_SPECS = {
  hatchback: { id: "hatchback", name: "Hatchback", controller: "ground", tuning: "hatchback", audio: AUDIO.car, camera: "car", tile: "#3a7bd5" },
  racecar: { id: "racecar", name: "Race Car", controller: "ground", tuning: "racecar", audio: AUDIO.racecar, camera: "car", tile: "#d8261f" },
  wagon: { id: "wagon", name: "Wagon", controller: "ground", tuning: "wagon", audio: AUDIO.car, camera: "car", tile: "#2f8f8a" },
  classic: { id: "classic", name: "Classic", controller: "ground", tuning: "classic", audio: AUDIO.car, camera: "car", tile: "#d7d9dc" },
  pickup: { id: "pickup", name: "Pickup", controller: "ground", tuning: "pickup", audio: AUDIO.car, camera: "car", tile: "#8f2320" },
  suv: { id: "suv", name: "SUV", controller: "ground", tuning: "suv", audio: AUDIO.car, camera: "car", tile: "#e8e8e2" },
  buggy: { id: "buggy", name: "Buggy", controller: "ground", tuning: "buggy", audio: AUDIO.car, camera: "car", tile: "#e8721c" },
  monster: { id: "monster", name: "Monster Truck", controller: "ground", tuning: "monster", audio: AUDIO.heavy, camera: "big", tile: "#e6902a" },
  wexcav: { id: "wexcav", name: "Excavator", controller: "ground", tuning: "wexcav", audio: AUDIO.heavy, camera: "big", tile: "#e8a81c" },
  texcav: { id: "texcav", name: "Tracked Excavator", controller: "ground", tuning: "texcav", audio: AUDIO.heavy, camera: "big", tile: "#d9a326" },
  crane: { id: "crane", name: "Mobile Crane", controller: "ground", tuning: "crane", audio: AUDIO.heavy, camera: "big", tile: "#e0b545" },
  hover: { id: "hover", name: "Hover Car", controller: "hover", tuning: "hover", audio: AUDIO.hover, camera: "hover", tile: "#c8a86a" },
  heli: { id: "heli", name: "Helicopter", controller: "heli", tuning: "heli", audio: AUDIO.heli, camera: "air", tile: "#14161f" },
  plane: { id: "plane", name: "Airplane", controller: "plane", tuning: "plane", audio: AUDIO.plane, camera: "air", tile: "#ece7d8" },
  yacht: { id: "yacht", name: "Yacht", controller: "boat", tuning: "yacht", audio: AUDIO.boat, camera: "big", tile: "#eef0ee" },
  speedboat: { id: "speedboat", name: "Speedboat", controller: "boat", tuning: "speedboat", audio: AUDIO.boat, camera: "boat", tile: "#2b2f36" },
};

// Attach the (possibly stand-in) model to each spec at module load.
for (const id of Object.keys(VEHICLE_SPECS)) VEHICLE_SPECS[id].model = MODELS[id];

// Ordered list for menu layout.
export const VEHICLE_ORDER = Object.keys(VEHICLE_SPECS);

// Merge CONFIG.vehicles.defaults with the entry, then compute derived mass properties:
// inertia = solid box from the collider full dimensions; com = hatchback {0,0.4,0} scaled by
// colliderCenterY/0.65; springForceClamp = 36*mass unless the entry pins it.
export function resolveTuning(key) {
  const d = CONFIG.vehicles.defaults;
  const e = CONFIG.vehicles[key];
  if (!e) throw new Error("Unknown vehicle tuning: " + key);
  const V = { ...d, ...e };
  const h = V.colliderHalf;
  const m = V.mass;
  const fx = 2 * h.x, fy = 2 * h.y, fz = 2 * h.z;
  V.inertia = {
    x: (m * (fy * fy + fz * fz)) / 12,
    y: (m * (fx * fx + fz * fz)) / 12,
    z: (m * (fx * fx + fy * fy)) / 12,
  };
  V.com = { x: 0, y: 0.4 * (V.colliderCenterY / 0.65), z: 0 };
  if (V.springForceClamp == null) V.springForceClamp = 36 * m;
  return V;
}
