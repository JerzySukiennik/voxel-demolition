// lib.js - map helper/material library: MAT table + addVolume-spec builders + the hilly two-stratum ground (brief section 3.1)
import { CONFIG } from "../config.js";
import { mulberry32, hashString } from "../sim/rng.js";

const SV = CONFIG.world.structureVoxel; // 0.15 m structure/prop voxel
const D = CONFIG.destruction;
const v1 = (m) => Math.max(1, Math.round(m / SV)); // meters -> voxel count (>=1)

// Phase 7 subsystem A.1: map a §4 material key to a coarse damage-multiplier class (default concrete).
const MAT_CLASS = {
  brick: "concrete", concrete: "concrete", rock: "concrete", roofTile: "concrete", glass: "concrete",
  wood: "wood", plank: "wood", roofWood: "wood",
  metal: "metal", sand: "dirt", skin: "dirt", subsoil: "dirt",
  foam: "foam", // Phase 7 batch D: constructive-voxel foam is its own coarse class (default tool mult 1.0).
};
export function matClass(key) { return MAT_CLASS[key] || "concrete"; }

// A MAT entry carries palette colors + its destruction tuning (threshold/density/chunkSize from CONFIG).
// A `color` key (e.g. via {...MAT.wood, color:"#b8574a"}) tints the primary palette entry.
function mkMat(key, color, trim, roughness, metalness) {
  return {
    key, color, trim, roughness, metalness,
    threshold: D.forceThreshold[key], density: D.density[key], chunkSize: D.matChunkSize[key],
  };
}
// A material-shaped object outside the §4 table (foliage), reusing §4 tuning of a base key.
function localMat(color, trim, roughness, metalness, baseKey) {
  return {
    key: baseKey, color, trim, roughness, metalness,
    threshold: D.forceThreshold[baseKey], density: D.density[baseKey], chunkSize: D.matChunkSize[baseKey],
  };
}

export const MAT = {
  brick: mkMat("brick", "#9e4b3b", "#7f3a2d", 0.95, 0.0),
  concrete: mkMat("concrete", "#9a9c9e", "#7f8183", 0.9, 0.0),
  wood: mkMat("wood", "#b8894e", "#8f6a3c", 0.85, 0.0),
  plank: mkMat("plank", "#a9884f", "#856a3c", 0.88, 0.0),
  roofTile: mkMat("roofTile", "#8a5a44", "#6f4634", 0.8, 0.0),
  roofWood: mkMat("roofWood", "#7d6748", "#5f4e37", 0.86, 0.0),
  metal: mkMat("metal", "#9fa6ad", "#7c828a", 0.4, 0.25),   // metalness>cutoff -> shiny material
  glass: mkMat("glass", "#9fc4d6", "#c2e2ef", 0.25, 0.3),
  sand: mkMat("sand", "#c8a86b", "#b09a62", 0.95, 0.0),
  rock: mkMat("rock", "#9c8b73", "#7f705c", 0.95, 0.0),
  // Phase 7 batch D: matte pale foam. Runtime foam blobs (Foam Cannon) build their own addVolume spec from
  // CONFIG.destruction tuning; this entry keeps foam a first-class §4 material for completeness/consistency.
  foam: mkMat("foam", "#e6eaec", "#c6cace", 0.95, 0.0),
};

const LEAF = localMat("#4f7a3f", "#3c6030", 0.92, 0.0, "wood");
const LEAF_DRY = localMat("#8f8149", "#6f6438", 0.94, 0.0, "wood");
const LAMP = localMat("#e9d27a", "#3a3a3a", 0.5, 0.2, "metal");

// palette: [primary, trim]. `override` (container livery, foliage) replaces the primary color.
function matPalette(mat, override) {
  return [
    { color: override || mat.color, roughness: mat.roughness, metalness: mat.metalness },
    { color: mat.trim, roughness: mat.roughness, metalness: mat.metalness },
  ];
}

function rawSpec(name, mat, dims, origin, fill, override) {
  return {
    name, voxelSize: SV, dims, origin, palette: matPalette(mat, override), fill,
    density: mat.density, threshold: mat.threshold, chunkSize: mat.chunkSize, kind: "single",
    materialClass: matClass(mat.key),
  };
}

// ============================================================================
// GROUND — rolling hills over deep, depth-graded diggable strata
// ============================================================================
// groundVolumes() returns TWO kind:"grid" volumes that together replace the old single 0.3 m skin:
//
//   topsoil  voxel 0.3, chunk CONFIG.destruction.chunkSizeSkin (2.1 m), tiles 10 m
//            spans y = [skinThickness - topsoilDepth, skinThickness + hills.height]
//            carries the height field and the road/patch colours (patch tint = the TOP voxel only, so a
//            blown-open road shows soil underneath instead of asphalt all the way down)
//   subsoil  voxel 0.6, chunk chunkSizeSubsoil (4.2 m), tiles 20 m, flat slab
//            spans y = [bedrockY, skinThickness - topsoilDepth], two colour bands for visible strata
//
// Under flat ground that is CONFIG.world.groundDepth (3.0 m) of destructible material before the
// indestructible core; under a hill you dig the hill first. The coarse subsoil is what makes the depth
// affordable: at a 0.6 m voxel and a 4.2 m chunk it costs a quarter of the cells and a quarter of the
// chunks per layer that a 0.3 m/2.1 m stratum would.
//
// Options:
//   mapId       seeds the height field (deterministic: server + every client build the identical world)
//   size        { x, z } map extent
//   color       surface colour;  subsoilColor / subsoilDeepColor override CONFIG defaults
//   patches     [{rect, color}] visual-only surface recolour (roads, wear, floor stripes)
//   waterRect   carve BOTH strata out of the pond footprint (the createCore basin lines the hole)
//   structures  the map's other volume specs. They are handled two different ways so that NOTHING ends up
//               floating or buried while the hills still get room to roll:
//                 * big footprints (> hills.liftMax in either axis: buildings, the warehouse, containers,
//                   the loading bridge) GRADE the terrain — their footprint forces h = 0 and the field
//                   ramps back up over flatBlend metres, exactly like a levelled building site
//                 * small footprints (trees, lamp posts, crates, posts, boulders) are LIFTED onto the
//                   terrain instead: the chunk-lattice cells under them are levelled to one height and
//                   the spec's origin is raised by it, so the hills run straight through them
//               Specs are mutated in place (origin[1] only), so a map can simply spread them afterwards.
//   flatRects   extra dead-flat rects (roads, spawn pads, parked-vehicle pads, multi-leg structures)
//   hills       per-map overrides of CONFIG.world.hills (e.g. { height: 0.8 } for a paved yard)
export function groundVolumes({ mapId, size, color, patches = [], waterRect = null, structures = [], flatRects = [], hills = {}, subsoilColor, subsoilDeepColor }) {
  const W = CONFIG.world;
  const H = { ...W.hills, ...hills };
  const hole = normRect(waterRect);
  const rects = flatRects.map(normRect).filter(Boolean);
  const lifts = [];
  for (const s of structures) {
    if (!s || !s.dims || !s.origin) continue;
    if (s.padRect) rects.push(normRect(s.padRect)); // enclosed floor of a building() composite
    const w = s.dims[0] * s.voxelSize, d = s.dims[2] * s.voxelSize;
    if (w > H.liftMax || d > H.liftMax) rectOf(s, H.flatMaxY, rects); // grade under it
    else lifts.push(s);                                              // stand it on the terrain
  }
  const heightAt = makeHeightField(mapId, size, H, rects);
  return [
    topsoilVolume(size, color, patches, hole, heightAt, H, lifts),
    subsoilVolume(size, hole, subsoilColor || W.subsoilColor, subsoilDeepColor || W.subsoilDeepColor),
  ];
}

// A dead-flat disc-ish pad (square) around a point: spawn points and parked vehicles need level ground.
export function pad(x, z, r) { return { x0: x - r, x1: x + r, z0: z - r, z1: z + r }; }

// Bedrock = the top of the indestructible core, and the floor of any mine the players dig.
export function bedrockY() { return CONFIG.world.skinThickness - CONFIG.world.groundDepth; }

function normRect(r) {
  if (!r) return null;
  return { x0: Math.min(r.x0, r.x1), x1: Math.max(r.x0, r.x1), z0: Math.min(r.z0, r.z1), z1: Math.max(r.z0, r.z1) };
}

// Push a spec's XZ footprint onto `out` if it is ground-anchored. Foliage blobs ("leaf") sit on their
// trunk and are 4 m wide, and anything based above flatMaxY (roofs, bridge decks, container tops,
// watchtower cabs, windmill blades) hangs in the air — neither should flatten the terrain under it.
function rectOf(spec, maxY, out) {
  if (!spec || !spec.dims || !spec.origin) return;
  if (spec.name === "leaf" || spec.name === "roof") return;
  if (spec.origin[1] > maxY) return;
  out.push({
    x0: spec.origin[0], x1: spec.origin[0] + spec.dims[0] * spec.voxelSize,
    z0: spec.origin[2], z1: spec.origin[2] + spec.dims[2] * spec.voxelSize,
  });
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (t) => t * t * (3 - 2 * t);

// Seeded value noise on a (nu+1)x(nv+1) lattice, smoothstep-interpolated. Output in [-1, 1].
function valueNoise(rand, nu, nv) {
  const g = new Float32Array((nu + 1) * (nv + 1));
  for (let i = 0; i < g.length; i++) g[i] = rand() * 2 - 1;
  const stride = nu + 1;
  return (u, v) => {
    let u0 = Math.floor(u), v0 = Math.floor(v);
    if (u0 < 0) u0 = 0; else if (u0 > nu - 1) u0 = nu - 1;
    if (v0 < 0) v0 = 0; else if (v0 > nv - 1) v0 = nv - 1;
    const tu = smoothstep(clamp01(u - u0)), tv = smoothstep(clamp01(v - v0));
    const i0 = u0 + stride * v0, i1 = i0 + stride;
    const a = g[i0] + (g[i0 + 1] - g[i0]) * tu;
    const b = g[i1] + (g[i1 + 1] - g[i1]) * tu;
    return a + (b - a) * tv;
  };
}

// Precomputed openness mask: 0 = dead flat (on/near a footprint or the map edge), 1 = full hills.
// Distance to the nearest flat rect is evaluated on a maskRes grid once and bilinear-sampled per column,
// which turns an O(columns x rects) scan into O(gridCells x rects) + a lerp.
// The ramp is LINEAR, not smoothstepped: a smoothstep peaks at 1.5x the average slope in the middle of
// the blend, and that peak is what would put a two-voxel ledge around every building pad.
function makeFlatMask(size, rects, H) {
  const res = H.maskRes, halfX = size.x / 2, halfZ = size.z / 2;
  const nx = Math.ceil(size.x / res) + 1, nz = Math.ceil(size.z / res) + 1;
  const grid = new Float32Array(nx * nz);
  const blend = Math.max(0.001, H.flatBlend);
  for (let j = 0; j < nz; j++) {
    const wz = -halfZ + j * res;
    for (let i = 0; i < nx; i++) {
      const wx = -halfX + i * res;
      let best = Infinity;
      for (let k = 0; k < rects.length; k++) {
        const r = rects[k];
        const dx = wx < r.x0 ? r.x0 - wx : wx > r.x1 ? wx - r.x1 : 0;
        const dz = wz < r.z0 ? r.z0 - wz : wz > r.z1 ? wz - r.z1 : 0;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) { best = d2; if (best === 0) break; }
      }
      const d = best === Infinity ? Infinity : Math.sqrt(best);
      const de = Math.min(halfX - Math.abs(wx), halfZ - Math.abs(wz)); // inward distance from the map edge
      grid[i + nx * j] = Math.min(clamp01((d - H.flatMargin) / blend), clamp01((de - H.edgeFlat) / blend));
    }
  }
  return (wx, wz) => {
    const u = clamp01((wx + halfX) / size.x) * (nx - 1);
    const v = clamp01((wz + halfZ) / size.z) * (nz - 1);
    const i0 = Math.min(nx - 2, Math.floor(u)), j0 = Math.min(nz - 2, Math.floor(v));
    const tu = u - i0, tv = v - j0;
    const a = grid[i0 + nx * j0], b = grid[i0 + 1 + nx * j0];
    const c = grid[i0 + nx * (j0 + 1)], d = grid[i0 + 1 + nx * (j0 + 1)];
    return (a + (b - a) * tu) + ((c + (d - c) * tu) - (a + (b - a) * tu)) * tv;
  };
}

// Height above skinThickness, in metres, at a world XZ. Always >= 0 (see CONFIG.world.hills).
function makeHeightField(mapId, size, H, rects) {
  if (!(H.height > 0)) return () => 0;
  const rand = mulberry32(hashString(mapId + ":terrain"));
  const n1 = valueNoise(rand, Math.max(1, Math.ceil(size.x / H.cell)), Math.max(1, Math.ceil(size.z / H.cell)));
  const n2 = valueNoise(rand, Math.max(1, Math.ceil(size.x / H.octave2Cell)), Math.max(1, Math.ceil(size.z / H.octave2Cell)));
  const mask = makeFlatMask(size, rects, H);
  const halfX = size.x / 2, halfZ = size.z / 2, norm = 1 / (1 + H.octave2);
  return (wx, wz) => {
    const m = mask(wx, wz);
    if (m <= 0) return 0;
    const n = (n1((wx + halfX) / H.cell, (wz + halfZ) / H.cell)
      + H.octave2 * n2((wx + halfX) / H.octave2Cell, (wz + halfZ) / H.octave2Cell)) * norm;
    // Biased and clamped rather than clipped at zero: raising the mid-point puts most of the open ground
    // ABOVE the flat baseline, so the graded pads read as level building sites cut into rolling terrain
    // instead of the terrain reading as a flat plane with a few isolated mounds on it.
    return H.height * clamp01(0.5 + H.gain * n) * m; // up-only: the flat pads are the valley floor
  };
}

// Stratum 1. Column surface heights are computed once, lazily, on the first fill() call and reused for
// every voxel in the column — the field is never evaluated per voxel.
//
// The surface is QUANTISED to the chunk lattice (chunkSizeSkin / skinVoxel voxels square, the same
// lattice destruction.js seeds its Voronoi cells on). That is not cosmetic: a grid chunk gets a CUBOID
// collider sized to the AABB of its voxels, so a chunk whose columns differ in height would collide as a
// flat plateau at its highest column and the player would stand visibly above the mesh. One height per
// lattice cell makes the AABB exact almost everywhere (a jittered Voronoi cell can still straddle two
// lattice cells, which is why the field is also slope-limited to about one voxel per cell), and the
// resulting soft terracing reads as intentional at a 0.3 m voxel scale. The alternative — convex-hull
// colliders for grid chunks — lives in destruction.js; see the report.
function topsoilVolume(size, color, patches, hole, heightAt, H, lifts) {
  const W = CONFIG.world;
  const vs = W.skinVoxel;
  const halfX = size.x / 2, halfZ = size.z / 2;
  const nx = Math.round(size.x / vs), nz = Math.round(size.z / vs);
  const oy = W.skinThickness - W.topsoilDepth;
  const ny = Math.max(1, Math.round((W.topsoilDepth + H.height) / vs));
  const palette = [{ color, roughness: 0.9, metalness: 0.0 }];
  const patchIndex = new Map();
  const list = [];
  for (const p of patches) {
    let pi = patchIndex.get(p.color);
    if (pi === undefined) {
      palette.push({ color: p.color, roughness: 0.9, metalness: 0.0 });
      pi = palette.length; // 1-based index for fill
      patchIndex.set(p.color, pi);
    }
    const r = normRect(p.rect);
    list.push({ ...r, pi });
  }
  // Chunk lattice: mirrors `spacingV` in destruction.js buildVolume.
  const span = Math.max(1, Math.round(D.chunkSizeSkin / vs));
  const cellsX = Math.max(1, Math.ceil(nx / span)), cellsZ = Math.max(1, Math.ceil(nz / span));
  const baseVox = Math.round(W.topsoilDepth / vs); // filled voxels for a column at the flat baseline

  // One surface height per chunk-lattice cell = the MINIMUM of a 4x4 sample of the field inside it. The
  // minimum (rather than the centre) is what keeps the graded pads honest: a cell that overlaps a
  // footprint, a road or a spawn pad anywhere samples h = 0 there, so a cell can never lift a building
  // onto a terrace or drop it into one.
  const cellTop = new Uint8Array(cellsX * cellsZ);
  {
    const S = 4;
    for (let cz = 0; cz < cellsZ; cz++) {
      for (let cx = 0; cx < cellsX; cx++) {
        let lo = Infinity;
        for (let j = 0; j < S; j++) {
          const wz = -halfZ + (cz * span + ((j + 0.5) / S) * span) * vs;
          for (let i = 0; i < S; i++) {
            const wx = -halfX + (cx * span + ((i + 0.5) / S) * span) * vs;
            const h = heightAt(wx, wz);
            if (h < lo) lo = h;
          }
        }
        cellTop[cx + cellsX * cz] = Math.max(1, Math.min(ny, Math.round((W.skinThickness + lo - oy) / vs)));
      }
    }
  }
  // Slope-limit the lattice, then stand the small props on the result. Both operations only ever LOWER a
  // cell, so alternating them converges (and is bounded below by the flat baseline).
  const cellOf = (w, half, cells) => Math.max(0, Math.min(cells - 1, Math.floor((w + half) / (span * vs))));
  for (let pass = 0; pass < 8; pass++) {
    const a = slopeLimit(cellTop, cellsX, cellsZ);
    const b = levelUnderProps(lifts, cellTop, cellsX, cellsZ, cellOf, halfX, halfZ, H);
    if (!a && !b) break;
  }
  for (const s of lifts) {
    const x0 = s.origin[0], x1 = x0 + s.dims[0] * s.voxelSize;
    const z0 = s.origin[2], z1 = z0 + s.dims[2] * s.voxelSize;
    s.origin[1] += (cellTop[cellOf((x0 + x1) / 2, halfX, cellsX) + cellsX * cellOf((z0 + z1) / 2, halfZ, cellsZ)] - baseVox) * vs;
  }

  let top = null;    // filled-voxel count per column
  let paint = null;  // palette index of the column's top voxel
  const build = () => {
    top = new Uint8Array(nx * nz);
    paint = new Uint8Array(nx * nz);
    for (let z = 0; z < nz; z++) {
      const wz = -halfZ + (z + 0.5) * vs;
      const cz = Math.min(cellsZ - 1, (z / span) | 0);
      for (let x = 0; x < nx; x++) {
        const wx = -halfX + (x + 0.5) * vs;
        const i = x + nx * z;
        if (hole && wx > hole.x0 && wx < hole.x1 && wz > hole.z0 && wz < hole.z1) { top[i] = 0; continue; }
        top[i] = cellTop[Math.min(cellsX - 1, (x / span) | 0) + cellsX * cz];
        let pi = 1;
        for (let k = list.length - 1; k >= 0; k--) {
          const q = list[k];
          if (wx >= q.x0 && wx <= q.x1 && wz >= q.z0 && wz <= q.z1) { pi = q.pi; break; }
        }
        paint[i] = pi;
      }
    }
  };
  const fill = (x, y, z) => {
    if (!top) build();
    const i = x + nx * z;
    const t = top[i];
    if (y >= t) return 0;
    return y === t - 1 ? paint[i] : 1; // patch tint on the surface voxel only
  };
  return {
    name: "ground", voxelSize: vs, dims: [nx, ny, nz], origin: [-halfX, oy, -halfZ], palette, fill,
    density: D.density.skin, threshold: D.forceThreshold.skin, chunkSize: D.chunkSizeSkin,
    tileMeters: D.tileMetersTopsoil, kind: "grid", materialClass: "dirt",
  };
}

// Clamp the lattice so no two edge-adjacent cells differ by more than ONE voxel, lowering only.
// This is what makes the terrain traversable and what lets the field be bold: a 0.3 m rise per 2.1 m cell
// is a kerb the player capsule rides over and the car suspension absorbs, while two voxels is a ledge that
// stops a hatchback dead. It also generates the grading ramps for free — a levelled building pad simply
// pulls its neighbours down in 0.3 m steps — so the flatness mask does not need a long blend to be safe.
function slopeLimit(cellTop, cellsX, cellsZ) {
  let dirty = false;
  for (let guard = 0; guard < 64; guard++) {
    let changed = false;
    for (let dir = 0; dir < 2; dir++) {
      for (let n = 0; n < cellsX * cellsZ; n++) {
        const i = dir === 0 ? n : cellsX * cellsZ - 1 - n;
        const cx = i % cellsX, cz = (i / cellsX) | 0;
        let lo = 255;
        if (cx > 0) lo = Math.min(lo, cellTop[i - 1]);
        if (cx < cellsX - 1) lo = Math.min(lo, cellTop[i + 1]);
        if (cz > 0) lo = Math.min(lo, cellTop[i - cellsX]);
        if (cz < cellsZ - 1) lo = Math.min(lo, cellTop[i + cellsX]);
        if (cellTop[i] > lo + 1) { cellTop[i] = lo + 1; changed = true; dirty = true; }
      }
    }
    if (!changed) break;
  }
  return dirty;
}

// Level the lattice under every small prop so it stands on flat ground instead of the ground being
// flattened for it. A ground-contacting spec (base at or just below the surface: trunks, posts, legs,
// boulders, the bottom row of a crate pile) pulls all the cells its footprint touches down to the lowest
// of them; specs based higher up (foliage, cabs, shelf tops, upper crate rows) belong to a composite whose
// ground-contacting pieces are emitted FIRST by every builder in this file, so the cells under them are
// already levelled and they just follow. Returns true if anything moved.
function levelUnderProps(lifts, cellTop, cellsX, cellsZ, cellOf, halfX, halfZ, H) {
  let dirty = false;
  for (const s of lifts) {
    if (s.origin[1] > H.contactY) continue;
    const x0 = s.origin[0], x1 = x0 + s.dims[0] * s.voxelSize;
    const z0 = s.origin[2], z1 = z0 + s.dims[2] * s.voxelSize;
    const cx0 = cellOf(x0, halfX, cellsX), cx1 = cellOf(x1 - 1e-6, halfX, cellsX);
    const cz0 = cellOf(z0, halfZ, cellsZ), cz1 = cellOf(z1 - 1e-6, halfZ, cellsZ);
    let t = 255;
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) t = Math.min(t, cellTop[cx + cellsX * cz]);
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      const i = cx + cellsX * cz;
      if (cellTop[i] !== t) { cellTop[i] = t; dirty = true; }
    }
  }
  return dirty;
}

// Stratum 2: a flat coarse slab from the topsoil's underside down to bedrock. Two colour bands so a mine
// shaft reads as real strata rather than one flat brown wall.
function subsoilVolume(size, hole, upper, deep) {
  const W = CONFIG.world;
  const vs = W.subsoilVoxel;
  const halfX = size.x / 2, halfZ = size.z / 2;
  const nx = Math.round(size.x / vs), nz = Math.round(size.z / vs);
  const oy = bedrockY();
  const ny = Math.max(1, Math.round((W.skinThickness - W.topsoilDepth - oy) / vs));
  const deepRows = Math.max(1, Math.floor(ny / 2));
  const fill = (x, y, z) => {
    if (hole) {
      const wx = -halfX + (x + 0.5) * vs, wz = -halfZ + (z + 0.5) * vs;
      if (wx > hole.x0 && wx < hole.x1 && wz > hole.z0 && wz < hole.z1) return 0;
    }
    return y < deepRows ? 2 : 1;
  };
  return {
    name: "subsoil", voxelSize: vs, dims: [nx, ny, nz], origin: [-halfX, oy, -halfZ],
    palette: [{ color: upper, roughness: 0.95, metalness: 0.0 }, { color: deep, roughness: 0.95, metalness: 0.0 }],
    fill, density: D.density.subsoil, threshold: D.forceThreshold.subsoil, chunkSize: D.chunkSizeSubsoil,
    tileMeters: D.tileMetersSubsoil, kind: "grid", materialClass: "dirt",
  };
}

// ---- indestructible map border (static geo entry, built by world.js buildStaticGeo) ----------------
// A stepped embankment around all four map edges. Fixed core geometry: zero chunks, never destructible,
// never an impactor. `height` is the visible berm; CONFIG.world.border.wallHeight adds invisible
// clearance above it so nothing drives, flies or is launched off the world.
export function borderRing({ size, color, height, width, steps } = {}) {
  const B = CONFIG.world.border;
  return {
    type: "border", size,
    color: color || B.color,
    height: height != null ? height : B.height,
    width: width != null ? width : B.width,
    steps: steps != null ? steps : B.steps,
  };
}

// ---- box (min-corner origin) ----------------------------------------------
export function box({ origin, size, mat = MAT.wood, hollow = false }) {
  const [w, h, d] = size;
  const nx = v1(w), ny = v1(h), nz = v1(d);
  const fill = (x, y, z) => {
    const fx = x === 0 || x === nx - 1, fy = y === 0 || y === ny - 1, fz = z === 0 || z === nz - 1;
    const onFace = fx || fy || fz;
    if (hollow && !onFace) return 0;
    return ((fx ? 1 : 0) + (fy ? 1 : 0) + (fz ? 1 : 0)) >= 2 ? 2 : 1;
  };
  return rawSpec("box", mat, [nx, ny, nz], origin, fill);
}

// ---- wall (from/to centerline, thickness = full width) --------------------
export function wall({ from, to, base = 0.3, height, thickness = 0.3, mat = MAT.brick, openings = [] }) {
  const [fx, fz] = from, [tx, tz] = to;
  const dx = tx - fx, dz = tz - fz;
  const alongX = Math.abs(dx) >= Math.abs(dz);
  const L = Math.hypot(dx, dz);
  const nAlong = v1(L), nThk = v1(thickness), ny = v1(height);
  const nx = alongX ? nAlong : nThk;
  const nz = alongX ? nThk : nAlong;
  const originX = alongX ? Math.min(fx, tx) : fx - thickness / 2;
  const originZ = alongX ? fz - thickness / 2 : Math.min(fz, tz);
  const forward = alongX ? tx >= fx : tz >= fz;
  const fill = (x, y, z) => {
    const ai = alongX ? x : z;
    const aM = (ai + 0.5) * SV;
    const alongFrom = forward ? aM : L - aM;
    const ym = (y + 0.5) * SV;
    for (let i = 0; i < openings.length; i++) {
      const op = openings[i];
      const hw = op.width / 2;
      if (alongFrom >= op.at - hw && alongFrom <= op.at + hw && ym >= (op.sill || 0) && ym <= (op.sill || 0) + op.height) return 0;
    }
    const edge = y === ny - 1 || ai === 0 || ai === nAlong - 1;
    return edge ? 2 : 1;
  };
  return rawSpec("wall", mat, [nx, ny, nz], [originX, base, originZ], fill);
}

// ---- roof (min-corner origin over footprint) ------------------------------
export function roof({ origin, size, base, kind = "gable", mat = MAT.roofWood, pitch = 0.5, overhang = 0.3 }) {
  const [w, d] = size;
  const ox = origin[0] - overhang, oz = origin[1] - overhang;
  const W = w + 2 * overhang, Dd = d + 2 * overhang;
  const nx = v1(W), nz = v1(Dd);
  if (kind === "flat") {
    const ny = v1(0.35);
    const fill = (x, y, z) => {
      const edge = x === 0 || x === nx - 1 || z === 0 || z === nz - 1;
      return edge ? 2 : 1;
    };
    return rawSpec("roof", mat, [nx, ny, nz], [ox, base, oz], fill);
  }
  // gable: stepped shell rising to a ridge along the longer axis.
  const ridgeAlongX = W >= Dd;
  const minor = ridgeAlongX ? Dd : W;
  const rise = pitch * minor * 0.5;
  const shellT = 0.35;
  const ny = v1(rise + shellT) + 1;
  const half = minor / 2;
  const fill = (x, y, z) => {
    const tm = ((ridgeAlongX ? z : x) + 0.5) * SV; // position on minor axis
    const t = Math.abs(tm - half);
    const surfaceH = rise * (1 - Math.min(1, t / half));
    const ym = (y + 0.5) * SV;
    const alongEnd = ridgeAlongX ? (x === 0 || x === nx - 1) : (z === 0 || z === nz - 1);
    if (alongEnd) return ym <= surfaceH + shellT ? 2 : 0; // gable end caps
    if (ym <= surfaceH + shellT && ym >= surfaceH - shellT) return ym >= surfaceH ? 2 : 1;
    return 0;
  };
  return rawSpec("roof", mat, [nx, ny, nz], [ox, base, oz], fill);
}

// ---- building = 4 walls (shared corners carved) + roof + auto glass panes --
export function building({ origin, size, height, wallMat = MAT.brick, roofKind = "gable", roofMat = MAT.roofWood, faces = {} }) {
  const [w, d] = size;
  const x0 = origin[0], z0 = origin[1], x1 = x0 + w, z1 = z0 + d;
  const base = CONFIG.world.skinThickness;
  const thk = 0.3, half = thk / 2;
  const specs = [];
  // n = -z (z0), s = +z (z1), e = +x (x1), w = -x (x0)
  specs.push(wall({ from: [x0, z0], to: [x1, z0], base, height, thickness: thk, mat: wallMat, openings: faces.n || [] }));
  specs.push(wall({ from: [x0, z1], to: [x1, z1], base, height, thickness: thk, mat: wallMat, openings: faces.s || [] }));
  // e/w walls inset by half a thickness at both ends so corner voxels belong to one wall only.
  const wOpen = shiftOpenings(faces.w, half);
  const eOpen = shiftOpenings(faces.e, half);
  specs.push(wall({ from: [x0, z0 + half], to: [x0, z1 - half], base, height, thickness: thk, mat: wallMat, openings: wOpen }));
  specs.push(wall({ from: [x1, z0 + half], to: [x1, z1 - half], base, height, thickness: thk, mat: wallMat, openings: eOpen }));
  specs.push(roof({ origin: [x0, z0], size: [w, d], base: base + height, kind: roofKind, mat: roofMat }));
  // glass panes for windows (sill > 0). n/s panes span X; e/w panes span Z.
  for (const [face, list] of Object.entries(faces)) {
    for (const op of list) {
      if ((op.sill || 0) <= 0) continue; // doors: no glass
      specs.push(glassPane(face, op, x0, z0, x1, z1, base, thk));
    }
  }
  // The four walls are thin strips, so their own footprints would leave the ENCLOSED floor free to roll
  // into a mound inside the house. padRect hands groundVolumes the whole footprint to grade flat.
  specs[0].padRect = { x0, x1, z0, z1 };
  return specs;
}

function shiftOpenings(list, delta) {
  if (!list) return [];
  return list.map((o) => ({ ...o, at: o.at - delta }));
}

function glassPane(face, op, x0, z0, x1, z1, base, thk) {
  const paneT = 0.08, sy = base + op.sill;
  if (face === "n" || face === "s") {
    const cx = x0 + op.at;
    return box({ origin: [cx - op.width / 2, sy, (face === "n" ? z0 : z1) - paneT / 2], size: [op.width, op.height, paneT], mat: MAT.glass });
  }
  const cz = z0 + op.at;
  return box({ origin: [(face === "w" ? x0 : x1) - paneT / 2, sy, cz - op.width / 2], size: [paneT, op.height, op.width], mat: MAT.glass });
}

// ---- trees (center point) --------------------------------------------------
export function tree({ x, z, height = 4, kind = "leafy" }) {
  const specs = [];
  const trunkH = kind === "pine" ? height * 0.45 : height * 0.5;
  const tw = 0.4;
  specs.push(box({ origin: [x - tw / 2, 0, z - tw / 2], size: [tw, trunkH, tw], mat: MAT.wood }));
  const leaf = kind === "dry" ? LEAF_DRY : LEAF;
  if (kind === "pine") {
    let cw = height * 0.7;
    let cy = trunkH;
    for (let i = 0; i < 3; i++) {
      const ch = height * 0.28;
      specs.push(coneBlob(x, cy, z, cw, ch, leaf));
      cy += ch * 0.8;
      cw *= 0.66;
    }
  } else if (kind === "dry") {
    const bw = height * 0.55;
    specs.push(coneBlob(x, trunkH, z, bw, height * 0.45, leaf));
  } else {
    const bw = height * 0.85;
    specs.push(blob(x, trunkH, z, bw, height * 0.5, leaf));
  }
  return specs;
}
function blob(x, yb, z, w, h, mat) {
  const nx = v1(w), ny = v1(h), nz = v1(w);
  const cx = (nx - 1) / 2, cy = (ny - 1) / 2, cz = (nz - 1) / 2;
  const fill = (i, j, k) => {
    const dxr = (i - cx) / (cx + 0.5), dyr = (j - cy) / (cy + 0.5), dzr = (k - cz) / (cz + 0.5);
    const r2 = dxr * dxr + dyr * dyr + dzr * dzr;
    if (r2 > 1) return 0;
    return r2 > 0.45 ? 2 : 1; // hollow-ish: interior sparser (still solid) — keep chunk-light shell
  };
  return { name: "leaf", voxelSize: SV, dims: [nx, ny, nz], origin: [x - w / 2, yb, z - w / 2], palette: matPalette(mat), fill, density: mat.density, threshold: mat.threshold, chunkSize: D.chunkSizeFoliage, kind: "single", materialClass: matClass(mat.key) };
}
function coneBlob(x, yb, z, w, h, mat) {
  const nx = v1(w), ny = v1(h), nz = v1(w);
  const cx = (nx - 1) / 2, cz = (nz - 1) / 2;
  const fill = (i, j, k) => {
    const rad = (1 - j / ny) * (nx / 2); // taper to top
    const dxr = i - cx, dzr = k - cz;
    return dxr * dxr + dzr * dzr <= rad * rad ? 1 : 0;
  };
  return { name: "leaf", voxelSize: SV, dims: [nx, ny, nz], origin: [x - w / 2, yb, z - w / 2], palette: matPalette(mat), fill, density: mat.density, threshold: mat.threshold, chunkSize: D.chunkSizeFoliage, kind: "single", materialClass: matClass(mat.key) };
}

// ---- fence (from/to centerline) -------------------------------------------
export function fence({ from, to, height = 1.1, mat = MAT.plank }) {
  const [fx, fz] = from, [tx, tz] = to;
  const alongX = Math.abs(tx - fx) >= Math.abs(tz - fz);
  const L = Math.hypot(tx - fx, tz - fz);
  const thickness = 0.12;
  const nAlong = v1(L), nThk = v1(thickness), ny = v1(height);
  const nx = alongX ? nAlong : nThk, nz = alongX ? nThk : nAlong;
  const postEvery = Math.max(1, Math.round(2.0 / SV)); // post column every ~2 m
  const railLo = v1(height * 0.35), railHi = v1(height * 0.8);
  const fill = (a, y, b) => {
    const ai = alongX ? a : b;
    const isPost = ai % postEvery === 0 || ai === nAlong - 1;
    const isRail = y === railLo || y === railHi || y === ny - 1;
    return isPost || isRail ? (isPost ? 2 : 1) : 0;
  };
  const originX = alongX ? Math.min(fx, tx) : fx - thickness / 2;
  const originZ = alongX ? fz - thickness / 2 : Math.min(fz, tz);
  const spec = rawSpec("fence", mat, [nx, ny, nz], [originX, 0, originZ], fill);
  spec.chunkSize = D.chunkSizeFence;
  return [spec];
}

// ---- container (center point) 6 x 2.6 x 2.6 m -----------------------------
export function container({ x, z, along = "x", color }) {
  const L = 6, H = 2.6, Wd = 2.6;
  const size = along === "z" ? [Wd, H, L] : [L, H, Wd];
  const [w, h, d] = size;
  const nx = v1(w), ny = v1(h), nz = v1(d);
  const fill = (i, j, k) => {
    const fx = i === 0 || i === nx - 1, fy = j === 0 || j === ny - 1, fz = k === 0 || k === nz - 1;
    if (!(fx || fy || fz)) return 0; // hollow shell
    // corrugation ribs across the long axis as trim
    const rib = along === "z" ? k % 3 === 0 : i % 3 === 0;
    return rib ? 2 : 1;
  };
  return rawSpec("container", MAT.metal, [nx, ny, nz], [x - w / 2, 0, z - d / 2], fill, color);
}

// ---- crate pile (center point) --------------------------------------------
export function cratePile({ x, z, rows = 3 }) {
  const wood = localMat("#b8894e", "#8f6a3c", 0.85, 0.0, "wood");
  const specs = [];
  const c = 0.8, gap = 0.85;
  const levels = [{ count: rows, y: 0 }];
  if (rows >= 2) levels.push({ count: rows - 1, y: 1 });
  if (rows >= 3) levels.push({ count: rows - 2, y: 2 });
  for (const lv of levels) {
    for (let i = 0; i < lv.count; i++) {
      const ox = x + (i - (lv.count - 1) / 2 + lv.y * 0.5) * gap - c / 2;
      const oz = z - c / 2;
      const oy = lv.y * (c + 0.02);
      const n = v1(c);
      const fill = (a, b, cc) => {
        const on = (val, m) => val === 0 || val === m - 1;
        return (on(a, n) ? 1 : 0) + (on(b, n) ? 1 : 0) + (on(cc, n) ? 1 : 0) >= 2 ? 2 : 1;
      };
      specs.push(rawSpec("crate", wood, [n, n, n], [ox, oy, oz], fill));
    }
  }
  return specs;
}

// ---- rock pile (center point) dome ----------------------------------------
export function rockPile({ x, z, r = 1.5, h = 1.2 }) {
  const nx = v1(2 * r), ny = v1(h), nz = v1(2 * r);
  const cx = (nx - 1) / 2, cz = (nz - 1) / 2;
  const fill = (i, j, k) => {
    const frac = j / ny;
    const rad = (nx / 2) * (1 - 0.55 * frac);
    const dxr = i - cx, dzr = k - cz;
    return dxr * dxr + dzr * dzr <= rad * rad ? (frac > 0.6 ? 2 : 1) : 0;
  };
  return rawSpec("rock", MAT.rock, [nx, ny, nz], [x - r, 0, z - r], fill);
}

// ---- lamp post (center point) ---------------------------------------------
export function lampPost({ x, z }) {
  const H = 4.0, W = 0.6;
  const nx = v1(W), ny = v1(H + 0.4), nz = v1(W);
  const cx = (nx - 1) / 2, cz = (nz - 1) / 2, headY = v1(H);
  const fill = (i, j, k) => {
    if (j < headY) return Math.abs(i - cx) <= 0.6 && Math.abs(k - cz) <= 0.6 ? 1 : 0; // pole
    return 2; // lamp head block
  };
  return rawSpec("lamp", LAMP, [nx, ny, nz], [x - W / 2, 0, z - W / 2], fill);
}

// ---- cliff run (from/to centerline) -> static geo entry --------------------
export function cliffRun({ from, to, height = 10, depth = 4, seed = 0 }) {
  return { type: "cliff", from, to, height, depth, seed };
}
