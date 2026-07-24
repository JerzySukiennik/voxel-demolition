// Redgate Basin — desert canyon outpost + pond map (Phase 4, Author C). All names/props invented; origins are MIN-CORNER (engine addVolume convention), wall/fence/cliff from→to are centerlines.
import { MAT, groundSpec, wall, box, roof, building, tree, fence, cratePile, rockPile, cliffRun } from "./lib.js";
import { CONFIG } from "../config.js";

// ---- pond jetty ------------------------------------------------------------
// A plank pier standing IN the excavated basin: a raised deck (surface just above water.level 0.28) carried
// on plank pilings that drop from the deck underside to the basin floor (CONFIG.world.basinFloorY = -2.6),
// so the walkway visibly rests on posts in the water instead of floating over it.
const JETTY = {
  x: -14,                 // deck centerline X (runs along Z)
  z0: -18, z1: -9,        // deck span in Z (landward -> out over the pond)
  width: 2,               // deck width (X), matches the retaining thickness
  deckBase: 0.45,         // deck plank underside Y (top ~0.6, clears the 0.28 waterline)
  deckH: 0.15,            // deck plank thickness
  pileT: 0.3,             // square plank piling side
  pileZ: [-9.6, -11.8, -13.8], // 3 piling rows, all inside the basin rect (z > z0=-14)
};
function jettyPilings() {
  // Two rows of pilings down the deck's long edges, from the basin floor up to the deck underside.
  const bottom = CONFIG.world.basinFloorY;
  const height = JETTY.deckBase - bottom;
  const inset = JETTY.width / 2 - JETTY.pileT / 2; // sit posts under the deck edges
  const specs = [];
  for (const z of JETTY.pileZ) {
    for (const ex of [-inset, inset]) {
      specs.push(box({
        origin: [JETTY.x + ex - JETTY.pileT / 2, bottom, z - JETTY.pileT / 2],
        size: [JETTY.pileT, height, JETTY.pileT], mat: MAT.plank,
      }));
    }
  }
  return specs;
}

// ---- local composites (spec[] via box/wall/roof only) ----
function watchtower(x, z) {
  // 3x3 footprint at [x..x+3, z..z+3]; 4 plank legs h6 + 3x3 cab + flat roof.
  const legs = [
    box({ origin: [x, 0, z], size: [0.3, 6, 0.3], mat: MAT.plank }),
    box({ origin: [x + 2.7, 0, z], size: [0.3, 6, 0.3], mat: MAT.plank }),
    box({ origin: [x, 0, z + 2.7], size: [0.3, 6, 0.3], mat: MAT.plank }),
    box({ origin: [x + 2.7, 0, z + 2.7], size: [0.3, 6, 0.3], mat: MAT.plank }),
  ];
  const cab = box({ origin: [x, 6, z], size: [3, 3, 3], mat: MAT.plank, hollow: true });
  const cap = roof({ origin: [x, z], size: [3, 3], base: 9, kind: "flat", mat: MAT.roofWood });
  return [...legs, cab, cap];
}
function windpump(x, z) {
  // ~1.4x1.4 metal frame h8 + hub + blade-disc cross in the XY plane.
  const legs = [
    box({ origin: [x, 0, z], size: [0.25, 8, 0.25], mat: MAT.metal }),
    box({ origin: [x + 1.15, 0, z], size: [0.25, 8, 0.25], mat: MAT.metal }),
    box({ origin: [x, 0, z + 1.15], size: [0.25, 8, 0.25], mat: MAT.metal }),
    box({ origin: [x + 1.15, 0, z + 1.15], size: [0.25, 8, 0.25], mat: MAT.metal }),
  ];
  const hub = box({ origin: [x + 0.2, 8, z + 0.2], size: [1, 1, 1], mat: MAT.metal });
  const bladeH = box({ origin: [x - 1.8, 8.1, z + 0.5], size: [5, 0.8, 0.25], mat: MAT.metal });
  const bladeV = box({ origin: [x + 0.3, 6.2, z + 0.5], size: [0.8, 5, 0.25], mat: MAT.metal });
  return [...legs, hub, bladeH, bladeV];
}
function hoodoo(cx, cz) {
  // Destructible tapered rock pillar (~h8.5) centered on cx,cz.
  return [
    box({ origin: [cx - 1.2, 0, cz - 1.2], size: [2.4, 3, 2.4], mat: MAT.rock }),
    box({ origin: [cx - 0.8, 3, cz - 0.8], size: [1.6, 3, 1.6], mat: MAT.rock }),
    box({ origin: [cx - 0.5, 6, cz - 0.5], size: [1, 2.5, 1], mat: MAT.rock }),
  ];
}

export default {
  id: "canyon",
  name: "Redgate Basin",
  size: { x: 96, z: 80 },
  spawn: { x: 0, z: 30, yaw: 0 },            // just inside the south vista gap, facing the bowl
  hatchback: { x: 20, z: -2.5, yaw: 0 },     // at the barn's big west door
  env: {
    skyColor: 0xa8c0d8,
    fogColor: 0xcbb491,
    fogNear: 50,
    fogFar: 140,
    sunAzimuthDeg: 55,
    sunElevationDeg: 55,
    sunIntensity: 2.0,
    groundColor: "#c8a86b",
  },
  // Water sits a hair below the sand surface (skinThickness 0.3) so the shoreline reads as a waterline;
  // createCore excavates a real basin under this rect (floor ~basinFloorY) so boats float at true depth.
  water: { rect: { x0: -24, z0: -14, x1: -2, z1: 2 }, level: 0.28 },
  decorVehicles: [],

  // Indestructible terraced boundary cliffs (h 8-12) ringing the bowl, one south gap (x -15..15).
  staticGeo: [
    cliffRun({ from: [-43, -35], to: [3, -35], height: 11, depth: 4, seed: 311 }),   // N-west
    cliffRun({ from: [3, -35], to: [43, -35], height: 12, depth: 4, seed: 312 }),    // N-east
    cliffRun({ from: [43, -35], to: [43, 35], height: 10, depth: 4, seed: 313 }),    // E
    cliffRun({ from: [-43, -35], to: [-43, 5], height: 12, depth: 4, seed: 314 }),   // W-north
    cliffRun({ from: [-43, 5], to: [-43, 35], height: 9, depth: 4, seed: 315 }),     // W-south
    cliffRun({ from: [-43, 35], to: [-15, 35], height: 9, depth: 4, seed: 316 }),    // S-west (to gap)
    cliffRun({ from: [15, 35], to: [43, 35], height: 10, depth: 4, seed: 317 }),     // S-east (from gap)
  ],

  volumes: [
    // ---- ground: warm sand + darker pond-area patch (visual only); sand skin carved out of the pond rect ----
    groundSpec({ x: 96, z: 80 }, "#c8a86b", [
      { rect: { x0: -28, z0: -18, x1: 2, z1: 6 }, color: "#b09a62" },
    ], { x0: -24, z0: -14, x1: -2, z1: 2 }),

    // ---- outpost structures (all destructible) ----
    // Barn 10x7 h5.5 wood, big west door.
    ...building({
      origin: [22, -6], size: [10, 7], height: 5.5,
      wallMat: MAT.wood, roofKind: "gable", roofMat: MAT.roofWood,
      faces: { w: [{ at: 3.5, width: 3, height: 4, sill: 0 }] },
    }),
    // Shack 7x5 gable, plank walls, door + window.
    ...building({
      origin: [24, -24], size: [7, 5], height: 3.2,
      wallMat: MAT.plank, roofKind: "gable", roofMat: MAT.roofWood,
      faces: {
        s: [{ at: 3.5, width: 1.2, height: 2.2, sill: 0 }],
        e: [{ at: 2.5, width: 1.2, height: 1, sill: 1.2 }],
      },
    }),
    ...watchtower(-36, -6),   // west side, footprint x[-36..-33] z[-6..-3]
    ...windpump(13.3, -25.4), // north-center-east, legs reach ground

    // Plank jetty: raised deck out over the pond's north edge, standing on plank pilings down to the basin floor.
    wall({ from: [JETTY.x, JETTY.z0], to: [JETTY.x, JETTY.z1], base: JETTY.deckBase, height: JETTY.deckH, thickness: JETTY.width, mat: MAT.plank }),
    ...jettyPilings(),

    // ---- interior rock formations (destructible MAT.rock) ----
    ...hoodoo(36, 18),
    ...hoodoo(-34, 18),
    // boulder piles (scattered inside the bowl)
    rockPile({ x: 34, z: -15, r: 1.6, h: 1.3 }),
    rockPile({ x: 14, z: 20, r: 1.4, h: 1.1 }),
    rockPile({ x: -6, z: 22, r: 1.7, h: 1.4 }),
    rockPile({ x: -30, z: -24, r: 1.5, h: 1.2 }),
    rockPile({ x: 30, z: 10, r: 1.5, h: 1.3 }),
    rockPile({ x: -34, z: -14, r: 1.6, h: 1.2 }),
    rockPile({ x: 8, z: 12, r: 1.3, h: 1.0 }),
    rockPile({ x: -16, z: 22, r: 1.5, h: 1.2 }),

    // ---- talus at cliff bases (destructible) ----
    rockPile({ x: -30, z: -31, r: 1.8, h: 1.5 }), // N base
    rockPile({ x: -10, z: -31, r: 1.6, h: 1.3 }),
    rockPile({ x: 10, z: -31, r: 1.7, h: 1.4 }),
    rockPile({ x: 30, z: -31, r: 1.8, h: 1.5 }),
    rockPile({ x: -39, z: -20, r: 1.7, h: 1.4 }), // W base
    rockPile({ x: -39, z: 0, r: 1.6, h: 1.3 }),
    rockPile({ x: -39, z: 20, r: 1.7, h: 1.4 }),
    rockPile({ x: 39, z: -20, r: 1.7, h: 1.4 }),  // E base
    rockPile({ x: 39, z: 10, r: 1.6, h: 1.3 }),
    rockPile({ x: 39, z: 26, r: 1.8, h: 1.5 }),

    // ---- pond berm ring (just outside N + W edges; S/E left open for the boat apron) ----
    rockPile({ x: -26, z: -6, r: 1.5, h: 1.2 }),
    rockPile({ x: -26, z: 0, r: 1.4, h: 1.1 }),
    rockPile({ x: -26, z: -12, r: 1.5, h: 1.2 }),
    rockPile({ x: -22, z: -16, r: 1.4, h: 1.1 }),
    rockPile({ x: -8, z: -16, r: 1.5, h: 1.2 }),
    rockPile({ x: -26, z: 4, r: 1.4, h: 1.1 }),

    // ---- dry vegetation (dry trees + cacti share kind:"dry") ----
    ...tree({ x: -26, z: -2, height: 4, kind: "dry" }),
    ...tree({ x: -18, z: -16, height: 3.5, kind: "dry" }),
    ...tree({ x: -29, z: 3, height: 4, kind: "dry" }),
    ...tree({ x: 20, z: -16, height: 3, kind: "dry" }),
    ...tree({ x: 6, z: 18, height: 3.5, kind: "dry" }),
    ...tree({ x: -20, z: 12, height: 4, kind: "dry" }),
    ...tree({ x: 37, z: -14, height: 3, kind: "dry" }),
    ...tree({ x: 16, z: -22, height: 3.5, kind: "dry" }),

    // ---- misc props ----
    ...fence({ from: [20, -8], to: [33, -8], height: 1.1, mat: MAT.plank }), // corral rail N of barn
    ...cratePile({ x: 30, z: -10, rows: 3 }),
    box({ origin: [18.85, 0, -9.15], size: [0.3, 2.6, 0.3], mat: MAT.wood }), // plain post
    box({ origin: [18.85, 0, 2.85], size: [0.3, 2.6, 0.3], mat: MAT.wood }),  // plain post
  ],
};
