// Graywater Freight Yard — industrial freight/warehouse map (Author B). All names/signage invented; axis-aligned; box/building/roof origins = min corner (matches engine addVolume), point props (container/cratePile/rockPile/lampPost/tree) = center.
import { MAT, groundSpec, wall, box, roof, building, tree, fence, container, cratePile, rockPile, lampPost } from "./lib.js";

// ---- container livery (rhythm: rust / blue / green / orange) ----
const RUST = "#8a4a32", BLUE = "#2f5a80", GREEN = "#3f6a4a", ORANGE = "#c07a30";
const STRIPE = "#b6b9bc"; // warehouse floor markings (visual)
const DIRT = "#7a6f5c";   // worn ground patches (visual)

// ---- ground: 80x64, gray hardstand + dirt/worn patches + warehouse floor stripes ----
const ground = groundSpec({ x: 80, z: 64 }, "#8a8d90", [
  // worn drive lanes / dirt
  { rect: { x0: -4, z0: 8, x1: 22, z1: 26 }, color: DIRT },   // gate -> yard approach
  { rect: { x0: 22, z0: -4, x1: 33, z1: 8 }, color: DIRT },   // office frontage
  { rect: { x0: -34, z0: 2, x1: -12, z1: 8 }, color: DIRT },  // west of warehouse
  { rect: { x0: 6, z0: -12, x1: 28, z1: 2 }, color: DIRT },   // central yard
  // warehouse floor stripes (inside footprint x[-32,-10] z[-14,0])
  { rect: { x0: -32, z0: -8, x1: -10, z1: -6 }, color: STRIPE }, // drive-through lane
  { rect: { x0: -30, z0: -4, x1: -11, z1: -3 }, color: STRIPE }, // south bay line
  { rect: { x0: -30, z0: -13, x1: -11, z1: -12 }, color: STRIPE }, // north bay line
]);

// =====================================================================
// WAREHOUSE centerpiece — 22x14 m, h7, corrugated metal, flat roof.
// Long axis along X. TWO full-height drive-through openings (W & E short
// walls), aligned -> straight crane route along X at z=-7 (5 m clear).
// Footprint x[-32,-10] z[-14,0]. Built from explicit wall endpoints.
// =====================================================================
const WH = { x0: -32, z0: -14, x1: -10, z1: 0, h: 7 };
const warehouse = [
  // long walls (N/S, 22 m, solid)
  wall({ from: [WH.x0, WH.z0], to: [WH.x1, WH.z0], height: WH.h, mat: MAT.metal }),
  wall({ from: [WH.x0, WH.z1], to: [WH.x1, WH.z1], height: WH.h, mat: MAT.metal }),
  // short walls (W/E, 14 m) each with a centered full-height drive-through (at=7 on a 14 m wall -> z=-7, width 5)
  wall({ from: [WH.x0, WH.z0], to: [WH.x0, WH.z1], height: WH.h, mat: MAT.metal, openings: [{ at: 7, width: 5, height: WH.h, sill: 0 }] }),
  wall({ from: [WH.x1, WH.z0], to: [WH.x1, WH.z1], height: WH.h, mat: MAT.metal, openings: [{ at: 7, width: 5, height: WH.h, sill: 0 }] }),
  // flat metal roof
  roof({ origin: [WH.x0, WH.z0], size: [22, 14], base: WH.h, kind: "flat", mat: MAT.metal }),
  // ---- interior: 3 shelf rows (metal frame + crates on two levels), lane z[-9.5,-4.5] kept clear ----
  // north pair of rows
  box({ origin: [-29, 0, -13], size: [16, 3, 1], mat: MAT.metal, hollow: true }),
  box({ origin: [-27, 0.1, -12.9], size: [10, 1.3, 0.8], mat: MAT.wood }),
  box({ origin: [-27, 1.7, -12.9], size: [8, 1.2, 0.8], mat: MAT.wood }),
  box({ origin: [-29, 0, -11], size: [16, 3, 1], mat: MAT.metal, hollow: true }),
  box({ origin: [-27, 0.1, -10.9], size: [10, 1.3, 0.8], mat: MAT.wood }),
  box({ origin: [-27, 1.7, -10.9], size: [7, 1.2, 0.8], mat: MAT.wood }),
  // south row (opposite the lane)
  box({ origin: [-29, 0, -2.5], size: [16, 3, 1], mat: MAT.metal, hollow: true }),
  box({ origin: [-27, 0.1, -2.4], size: [10, 1.3, 0.8], mat: MAT.wood }),
  box({ origin: [-27, 1.7, -2.4], size: [6, 1.2, 0.8], mat: MAT.wood }),
];

// =====================================================================
// LOADING BRIDGE (money shot) — concrete deck 12x3 @ h4 on two 1x3 piers,
// plank stair-ramps both ends. Sits in the big south-central open apron;
// 12 m of clear ground kept around it for Tab-spawned heavy vehicles.
// Deck x[4,16] z[4.5,7.5]. Ramps extend x[-1,4] and x[16,21].
// =====================================================================
const bridge = [
  // deck
  box({ origin: [4, 3.7, 4.5], size: [12, 0.5, 3], mat: MAT.concrete }),
  // piers under each deck end
  box({ origin: [4, 0, 4.5], size: [1, 3.7, 3], mat: MAT.concrete }),
  box({ origin: [15, 0, 4.5], size: [1, 3.7, 3], mat: MAT.concrete }),
  // west plank stair-ramp (rising -1 -> 4)
  box({ origin: [-1, 0, 4.5], size: [1.25, 0.9, 3], mat: MAT.plank }),
  box({ origin: [0.25, 0, 4.5], size: [1.25, 1.8, 3], mat: MAT.plank }),
  box({ origin: [1.5, 0, 4.5], size: [1.25, 2.7, 3], mat: MAT.plank }),
  box({ origin: [2.75, 0, 4.5], size: [1.25, 3.6, 3], mat: MAT.plank }),
  // east plank stair-ramp (descending 16 -> 21)
  box({ origin: [16, 0, 4.5], size: [1.25, 3.6, 3], mat: MAT.plank }),
  box({ origin: [17.25, 0, 4.5], size: [1.25, 2.7, 3], mat: MAT.plank }),
  box({ origin: [18.5, 0, 4.5], size: [1.25, 1.8, 3], mat: MAT.plank }),
  box({ origin: [19.75, 0, 4.5], size: [1.25, 0.9, 3], mat: MAT.plank }),
];

// =====================================================================
// OFFICE — brick 8x6 h4 flat roof, door + windows. East edge.
// Footprint x[24,32] z[-6,0].
// =====================================================================
const office = building({
  origin: [24, -6], size: [8, 6], height: 4,
  wallMat: MAT.brick, roofKind: "flat", roofMat: MAT.concrete,
  faces: {
    s: [{ at: 4, width: 1.2, height: 2.2, sill: 0 }],            // door facing the yard
    w: [{ at: 1.5, width: 1.4, height: 1.3, sill: 1.2 }, { at: 4.2, width: 1.4, height: 1.3, sill: 1.2 }],
    n: [{ at: 3, width: 1.6, height: 1.3, sill: 1.2 }],
  },
});

// =====================================================================
// OPEN CANOPY — 10x6 flat metal roof on 6 thin posts. SW open area.
// Footprint x[-32,-22] z[6,12], roof top ~3.5.
// =====================================================================
const CAN = { x0: -32, z0: 6, x1: -22, z1: 12, top: 3.4 };
const canopyPosts = [
  [CAN.x0, CAN.z0], [CAN.x1 - 0.3, CAN.z0], [CAN.x0, CAN.z1 - 0.3], [CAN.x1 - 0.3, CAN.z1 - 0.3],
  [(CAN.x0 + CAN.x1) / 2 - 0.15, CAN.z0], [(CAN.x0 + CAN.x1) / 2 - 0.15, CAN.z1 - 0.3],
];
const canopy = [
  ...canopyPosts.map((p) => box({ origin: [p[0], 0, p[1]], size: [0.3, CAN.top, 0.3], mat: MAT.metal })),
  box({ origin: [CAN.x0, CAN.top, CAN.z0], size: [10, 0.4, 6], mat: MAT.metal }),
];

// =====================================================================
// GUARD HUT — 3x3 wood, near the gate. Footprint x[6,9] z[22,25].
// =====================================================================
const guardHut = building({
  origin: [6, 22], size: [3, 3], height: 3,
  wallMat: MAT.wood, roofKind: "flat", roofMat: MAT.roofWood,
  faces: {
    s: [{ at: 1.5, width: 1, height: 2, sill: 0 }],              // door toward gate
    n: [{ at: 1.5, width: 1.2, height: 1, sill: 1.2 }],          // window
  },
});

// =====================================================================
// PERIMETER METAL FENCE (rect x[-35,35] z[-28,28]) with a south gate gap
// x[-3,3], plus two metal gate posts.
// =====================================================================
const perimeter = [
  ...fence({ from: [-35, -28], to: [35, -28], mat: MAT.metal }),  // north
  ...fence({ from: [35, -28], to: [35, 28], mat: MAT.metal }),    // east
  ...fence({ from: [-35, -28], to: [-35, 28], mat: MAT.metal }),  // west
  ...fence({ from: [-35, 28], to: [-3, 28], mat: MAT.metal }),    // south-left (to gate)
  ...fence({ from: [3, 28], to: [35, 28], mat: MAT.metal }),      // south-right (from gate)
  box({ origin: [-3.2, 0, 27.7], size: [0.4, 2.2, 0.6], mat: MAT.metal }), // gate post W
  box({ origin: [2.8, 0, 27.7], size: [0.4, 2.2, 0.6], mat: MAT.metal }),  // gate post E
];

// =====================================================================
// CONTAINERS — 8 ground + 2 stacked tops (2 stacked pairs). Color rhythm.
// Kept clear of the bridge apron; grouped in north bays + east row.
// =====================================================================
const containers = [
  // north bay row (along X, z=-22)
  container({ x: -30, z: -22, along: "x", color: RUST }),
  container({ x: -22, z: -22, along: "x", color: BLUE }),   // stacked pair #1
  container({ x: -14, z: -22, along: "x", color: GREEN }),
  container({ x: -6, z: -22, along: "x", color: ORANGE }),
  // north back row (along X, z=-24)
  container({ x: 16, z: -24, along: "x", color: BLUE }),
  container({ x: 24, z: -24, along: "x", color: GREEN }),   // stacked pair #2
  // east row (along Z)
  container({ x: 30, z: -22, along: "z", color: ORANGE }),
  container({ x: 30, z: -15, along: "z", color: RUST }),
  // stacked tops (metal, on pairs #1 and #2) — y=2.62
  box({ origin: [-25, 2.62, -23.3], size: [6, 2.6, 2.6], mat: MAT.metal }),
  box({ origin: [21, 2.62, -25.3], size: [6, 2.6, 2.6], mat: MAT.metal }),
];

// =====================================================================
// LOOSE PROPS — 5 crate piles, gravel rock pile, 4 lamp posts, 6 trees.
// =====================================================================
const crates = [
  ...cratePile({ x: -34, z: -4, rows: 3 }),   // behind warehouse (west)
  ...cratePile({ x: -20, z: 4, rows: 3 }),    // south of warehouse
  ...cratePile({ x: 8, z: -14, rows: 2 }),    // north-central
  ...cratePile({ x: 31, z: 5, rows: 3 }),     // by office
  ...cratePile({ x: -30, z: 14, rows: 2 }),   // SW corner
];
const gravel = rockPile({ x: 14, z: -18, r: 1.8, h: 1.2 }); // gravel heap

const lamps = [
  lampPost({ x: -6, z: -12 }),
  lampPost({ x: -6, z: 14 }),
  lampPost({ x: 22, z: 12 }),
  lampPost({ x: 22, z: -12 }),
];

// trees OUTSIDE the E/W fence (x=35), canopy within +/-37 x and +/-29 z
const trees = [
  ...tree({ x: -35.8, z: -18, height: 5, kind: "pine" }),
  ...tree({ x: -35.8, z: 8, height: 4, kind: "leafy" }),
  ...tree({ x: -35.8, z: 20, height: 5, kind: "pine" }),
  ...tree({ x: 35.8, z: -14, height: 5, kind: "pine" }),
  ...tree({ x: 35.8, z: 6, height: 4, kind: "leafy" }),
  ...tree({ x: 35.8, z: 20, height: 4, kind: "leafy" }),
];

// =====================================================================
export default {
  id: "yard",
  name: "Graywater Freight Yard",
  size: { x: 80, z: 64 },
  spawn: { x: 0, z: 26, yaw: 0 },                 // at the south gate, facing into the yard
  hatchback: { x: 0, z: 19, yaw: 0 },             // just inside the gate
  env: {
    skyColor: 0x9ab4d0,
    fogColor: 0xa8bccd,
    fogNear: 45,
    fogFar: 130,
    sunIntensity: 2.0,
    groundColor: "#8a8d90",
  },
  water: null,
  volumes: [
    ground,
    ...warehouse,
    ...bridge,
    ...office,
    ...canopy,
    ...guardHut,
    ...perimeter,
    ...containers,
    ...crates,
    gravel,
    ...lamps,
    ...trees,
  ],
  staticGeo: [],
  decorVehicles: [
    { id: "suv", x: 28, z: 6, yaw: 1.6 },          // by the office
    { id: "pickup", x: -6, z: 24, yaw: 0 },        // by the gate
  ],
};
