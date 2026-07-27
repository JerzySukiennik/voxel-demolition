// Fallbrook — small crossroads town map (72x72). All names/signage invented; zero copied wordmarks.
import { MAT, groundVolumes, borderRing, pad, wall, box, roof, building, tree, fence, cratePile, lampPost } from "./lib.js";

// Best-effort facade paint: preserves the MAT entry (threshold/density/chunkSize/palette) and adds a
// tint hint. The frozen lib API (§3.1) exposes no paint parameter, so if lib ignores unknown keys the
// building renders in the base material's palette. See report note.
const paint = (mat, hex) => ({ ...mat, color: hex });

// Road color for all asphalt patches.
const ROAD = "#5a5c5e";

// Visual paved areas (grid patches, purely cosmetic). Main St / Cross St are ~6 m drivable with a
// shoulder that hosts the lamps and bus shelter, so the patches read 8 m wide.
const patches = [
  { rect: { x0: -33, z0: -4, x1: 33, z1: 4 }, color: ROAD }, // Main St (E-W)
  { rect: { x0: -4, z0: -33, x1: 4, z1: 33 }, color: ROAD }, // Cross St (N-S)
  { rect: { x0: -31, z0: 4, x1: -21, z1: 8 }, color: ROAD }, // garage forecourt
  { rect: { x0: 18, z0: 13, x1: 28, z1: 20 }, color: ROAD }, // parking lot
];

// Buildings. origin = SW min-corner [x0,z0]; footprint = [x0, x0+w] x [z0, z0+d]. Axis-aligned only.
// Face convention assumed: s=+z, n=-z, e=+x, w=-x (road-facing walls carry the openings).
const buildings = [
  // General store 10x8 h5.5 brick, flat roof, 2 big S-face shop windows + door.
  ...building({
    origin: [-30, -16], size: [10, 8], height: 5.5,
    wallMat: MAT.brick, roofKind: "flat", roofMat: MAT.roofWood,
    faces: {
      s: [
        { at: 2, width: 2.4, height: 2.0, sill: 1.0 },
        { at: 5, width: 1.4, height: 2.6, sill: 0 },
        { at: 8, width: 2.4, height: 2.0, sill: 1.0 },
      ],
    },
  }),
  // Cafe 8x7 h4.5 wood (painted #b8574a), gable roofTile.
  ...building({
    origin: [17, -15], size: [8, 7], height: 4.5,
    wallMat: paint(MAT.wood, "#b8574a"), roofKind: "gable", roofMat: MAT.roofTile,
    faces: {
      s: [
        { at: 2.5, width: 1.2, height: 2.4, sill: 0 },
        { at: 5.5, width: 2.0, height: 1.5, sill: 1.0 },
      ],
      e: [{ at: 3.5, width: 1.5, height: 1.5, sill: 1.0 }],
    },
  }),
  // Kiosk 4x3 h3 wood, flat, small serving window on road side (N).
  ...building({
    origin: [20, 7], size: [4, 3], height: 3,
    wallMat: MAT.wood, roofKind: "flat", roofMat: MAT.roofWood,
    faces: { n: [{ at: 2, width: 1.6, height: 1.0, sill: 0.9 }] },
  }),
  // House 1: 9x7 h6 gable brick.
  ...building({
    origin: [-15, -19], size: [9, 7], height: 6,
    wallMat: MAT.brick, roofKind: "gable", roofMat: MAT.roofTile,
    faces: {
      s: [
        { at: 1.5, width: 1.5, height: 1.5, sill: 1.0 },
        { at: 4.5, width: 1.2, height: 2.4, sill: 0 },
        { at: 7.5, width: 1.5, height: 1.5, sill: 1.0 },
      ],
      n: [{ at: 4.5, width: 1.5, height: 1.5, sill: 1.5 }],
      e: [{ at: 3.5, width: 1.2, height: 1.2, sill: 1.5 }],
    },
  }),
  // House 2: 8x7 h5.5 wood (painted #3f6a94), gable. Road is to the N.
  ...building({
    origin: [8, 8], size: [8, 7], height: 5.5,
    wallMat: paint(MAT.wood, "#3f6a94"), roofKind: "gable", roofMat: MAT.roofWood,
    faces: {
      n: [
        { at: 1.5, width: 1.4, height: 1.5, sill: 1.0 },
        { at: 4.0, width: 1.2, height: 2.4, sill: 0 },
        { at: 6.5, width: 1.4, height: 1.5, sill: 1.0 },
      ],
      s: [{ at: 4.0, width: 1.4, height: 1.5, sill: 1.5 }],
      w: [{ at: 3.5, width: 1.2, height: 1.2, sill: 1.5 }],
    },
  }),
  // Tower landmark 5x5 h9 concrete, gable. Generic — no signage.
  ...building({
    origin: [7, -15], size: [5, 5], height: 9,
    wallMat: MAT.concrete, roofKind: "gable", roofMat: MAT.roofWood,
    faces: {
      s: [{ at: 2.5, width: 1.0, height: 1.2, sill: 6.0 }],
      n: [{ at: 2.5, width: 1.0, height: 1.2, sill: 6.0 }],
      e: [{ at: 2.5, width: 0.8, height: 1.0, sill: 3.0 }],
    },
  }),
  // Garage 7x6 h4 concrete, flat, full-width door on road side (N).
  ...building({
    origin: [-30, 8], size: [7, 6], height: 4,
    wallMat: MAT.concrete, roofKind: "flat", roofMat: MAT.roofWood,
    faces: { n: [{ at: 3.5, width: 4.4, height: 3.2, sill: 0 }] },
  }),
];

// Trees (12): leafy + pine mix in yards and along the edges.
const treeList = [
  { x: -31, z: -6, kind: "pine" }, // pulled 1 m in so the crown clears the map-edge border berm
  { x: -17, z: -6, kind: "leafy" },
  { x: -9, z: -8, kind: "leafy" },
  { x: 14, z: -9, kind: "pine" },
  { x: 31, z: -14, kind: "leafy" },
  { x: 31, z: 12, kind: "pine" },
  { x: 6, z: 19, kind: "leafy" },
  { x: -7, z: 15, kind: "pine" },
  { x: -31, z: 19, kind: "leafy" },
  { x: -15, z: 12, kind: "pine" },
  { x: 13, z: 27, kind: "leafy" },
  { x: 28, z: -5, kind: "pine" },
];

// Plank fences around 3 yards (House 1, House 2, store back lot).
const fenceRuns = [
  // House 1 front yard
  { from: [-15, -12], to: [-15, -5] },
  { from: [-15, -5], to: [-6, -5] },
  { from: [-6, -5], to: [-6, -12] },
  // House 2 front yard
  { from: [8, 15], to: [8, 22] },
  { from: [8, 22], to: [16, 22] },
  { from: [16, 22], to: [16, 15] },
  // Store back storage lot (encloses the crate pile)
  { from: [-30, -22], to: [-30, -16] },
  { from: [-30, -22], to: [-20, -22] },
  { from: [-20, -22], to: [-20, -16] },
];

// 4 lamp posts flanking Main St, on the paved shoulders.
const lampSpots = [
  { x: -14, z: -3.5 },
  { x: 14, z: -3.5 },
  { x: -14, z: 3.5 },
  { x: 14, z: 3.5 },
];

// Welcome sign at the southern Cross St approach: 2 posts + a blank painted board.
const welcomeSign = [
  box({ origin: [4.7, 0, 29.7], size: [0.3, 1.6, 0.3], mat: MAT.wood }),
  box({ origin: [7.7, 0, 29.7], size: [0.3, 1.6, 0.3], mat: MAT.wood }),
  box({ origin: [4.5, 1.6, 29.65], size: [3.5, 1.1, 0.25], mat: paint(MAT.wood, "#2f6d4f") }),
];

// Bus shelter (3-sided wall + flat roof) on the south shoulder of Main St, open side facing the road.
const busShelter = [
  wall({ from: [-10.5, 6], to: [-7.5, 6], base: 0.3, height: 2.2, thickness: 0.2, mat: MAT.metal }),
  wall({ from: [-10.5, 6], to: [-10.5, 4], base: 0.3, height: 2.2, thickness: 0.2, mat: MAT.metal }),
  wall({ from: [-7.5, 6], to: [-7.5, 4], base: 0.3, height: 2.2, thickness: 0.2, mat: MAT.metal }),
  box({ origin: [-10.7, 2.4, 3.8], size: [3.4, 0.2, 2.4], mat: MAT.metal }),
];

const SIZE = { x: 72, z: 72 };
const SPAWN = { x: -20, z: 26, yaw: 0 };
const HATCH = { x: -16, z: 22, yaw: 1.6 };
const DECOR = [
  { id: "pickup", x: -26, z: 6, yaw: 0 },
  { id: "classic", x: 21, z: 16, yaw: 0 },
  { id: "wagon", x: 25, z: 16, yaw: 0 },
];

// Everything that stands on the ground. groundVolumes flattens the terrain under each footprint, so the
// hills only roll through the open yards, verges and field edges — nothing is left floating or buried.
const structures = [
  ...buildings,
  ...treeList.flatMap((t) => tree({ x: t.x, z: t.z, height: t.kind === "pine" ? 5 : 4, kind: t.kind })),
  ...fenceRuns.flatMap((f) => fence({ from: f.from, to: f.to, height: 1.1, mat: MAT.plank })),
  ...lampSpots.map((l) => lampPost({ x: l.x, z: l.z })),
  ...cratePile({ x: -25, z: -19, rows: 3 }),
  ...welcomeSign,
  ...busShelter,
];

export default {
  id: "town",
  name: "Fallbrook",
  size: SIZE,
  spawn: SPAWN,
  hatchback: HATCH,
  env: { groundColor: "#7d8471" },
  water: null,
  volumes: [
    ...groundVolumes({
      mapId: "town", size: SIZE, color: "#7d8471", patches, structures,
      // Streets and forecourts are graded flat; so are the spawn point and every parked vehicle's pad.
      flatRects: [
        ...patches.map((p) => p.rect),
        pad(SPAWN.x, SPAWN.z, 4), pad(HATCH.x, HATCH.z, 4),
        ...DECOR.map((d) => pad(d.x, d.z, 4)),
      ],
    }),
    ...structures,
  ],
  staticGeo: [borderRing({ size: SIZE, color: "#7f7a63" })],
  decorVehicles: DECOR,
};
