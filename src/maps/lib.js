// lib.js - map helper/material library: MAT table + addVolume-spec builders (frozen API, brief section 3.1)
import { CONFIG } from "../config.js";

const SV = CONFIG.world.structureVoxel; // 0.15 m structure/prop voxel
const D = CONFIG.destruction;
const v1 = (m) => Math.max(1, Math.round(m / SV)); // meters -> voxel count (>=1)

// Phase 7 subsystem A.1: map a §4 material key to a coarse damage-multiplier class (default concrete).
const MAT_CLASS = {
  brick: "concrete", concrete: "concrete", rock: "concrete", roofTile: "concrete", glass: "concrete",
  wood: "wood", plank: "wood", roofWood: "wood",
  metal: "metal", sand: "dirt", skin: "dirt",
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

// ---- ground (grid) ---------------------------------------------------------
// kind:"grid" skin, 0.3 voxel, 8 m tiles. patches = [{rect, color}] visual-only recolor (unclamped).
export function groundSpec(size, color, patches = []) {
  const vs = CONFIG.world.skinVoxel;
  const halfX = size.x / 2, halfZ = size.z / 2;
  const nx = Math.round(size.x / vs), nz = Math.round(size.z / vs);
  const base = { color, roughness: 0.9, metalness: 0.0 };
  const palette = [base];
  const patchIndex = new Map(); // color -> palette index (1-based)
  const list = [];
  for (const p of patches) {
    let pi = patchIndex.get(p.color);
    if (pi === undefined) {
      palette.push({ color: p.color, roughness: 0.9, metalness: 0.0 });
      pi = palette.length; // 1-based index for fill
      patchIndex.set(p.color, pi);
    }
    const r = p.rect;
    list.push({ x0: Math.min(r.x0, r.x1), x1: Math.max(r.x0, r.x1), z0: Math.min(r.z0, r.z1), z1: Math.max(r.z0, r.z1), pi });
  }
  const fill = (x, y, z) => {
    if (list.length) {
      const wx = -halfX + (x + 0.5) * vs, wz = -halfZ + (z + 0.5) * vs;
      for (let i = list.length - 1; i >= 0; i--) {
        const q = list[i];
        if (wx >= q.x0 && wx <= q.x1 && wz >= q.z0 && wz <= q.z1) return q.pi;
      }
    }
    return 1;
  };
  return {
    name: "ground", voxelSize: vs, dims: [nx, 1, nz], origin: [-halfX, 0, -halfZ], palette, fill,
    density: D.density.skin, threshold: D.forceThreshold.skin, chunkSize: D.chunkSizeSkin,
    tileMeters: D.tileMeters, kind: "grid", materialClass: "dirt",
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
  return { name: "leaf", voxelSize: SV, dims: [nx, ny, nz], origin: [x - w / 2, yb, z - w / 2], palette: matPalette(mat), fill, density: mat.density, threshold: mat.threshold, chunkSize: 1.4, kind: "single", materialClass: matClass(mat.key) };
}
function coneBlob(x, yb, z, w, h, mat) {
  const nx = v1(w), ny = v1(h), nz = v1(w);
  const cx = (nx - 1) / 2, cz = (nz - 1) / 2;
  const fill = (i, j, k) => {
    const rad = (1 - j / ny) * (nx / 2); // taper to top
    const dxr = i - cx, dzr = k - cz;
    return dxr * dxr + dzr * dzr <= rad * rad ? 1 : 0;
  };
  return { name: "leaf", voxelSize: SV, dims: [nx, ny, nz], origin: [x - w / 2, yb, z - w / 2], palette: matPalette(mat), fill, density: mat.density, threshold: mat.threshold, chunkSize: 1.4, kind: "single", materialClass: matClass(mat.key) };
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
  return [rawSpec("fence", mat, [nx, ny, nz], [originX, 0, originZ], fill)];
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
