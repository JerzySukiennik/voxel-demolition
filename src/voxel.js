// voxel.js - decode contract models, greedy meshing to BufferGeometry with jittered vertex colors
import * as THREE from "three";
import { CONFIG } from "./config.js";

const BUCKETS = CONFIG.voxel.jitterBuckets;
const JIT = CONFIG.voxel.jitterLightness;

export function hashCoord(x, y, z) {
  let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) >>> 0;
  return h;
}

export function jitterBucket(x, y, z) {
  return hashCoord(x, y, z) % BUCKETS;
}

// Base THREE.Color (sRGB style string) jittered in lightness by voxel-coord bucket.
export function jitteredColor(base, x, y, z, out) {
  const b = jitterBucket(x, y, z);
  const off = (BUCKETS > 1 ? (b / (BUCKETS - 1) - 0.5) : 0) * 2 * JIT;
  out.copy(base).offsetHSL(0, 0, off);
  return out;
}

export function decodeModel(model) {
  const palette = model.palette.map((p) => ({
    color: new THREE.Color().setStyle(p.color),
    roughness: p.roughness ?? 0.8,
    metalness: p.metalness ?? 0.0,
    emissive: p.emissive === true,
    shiny: (p.metalness ?? 0.0) > CONFIG.voxel.shinyMetalnessCutoff,
  }));
  const parts = {};
  for (const part of model.parts) {
    parts[part.name] = {
      name: part.name,
      size: part.size.slice(),
      originOffset: part.originOffset.slice(),
      pivot: (part.pivot || [0, 0, 0]).slice(),
      data: part.data instanceof Uint8Array ? part.data : Uint8Array.from(part.data),
    };
  }
  return { name: model.name, voxelSize: model.voxelSize, palette, parts, anchors: model.anchors || {} };
}

// Greedy mesh a voxel volume.
// opts: { dims:[nx,ny,nz], voxelSize, origin:[ox,oy,oz], get(x,y,z)->0|pidx,
//         mergeKey(x,y,z,pidx), colorAt(x,y,z,pidx,out:THREE.Color), groupAt(pidx)->0|1|2 }
// Returns THREE.BufferGeometry with position/normal/color attributes and up to three groups
// (0 rough, 1 shiny, 2 emissive/unlit). Groups 1 and 2 are only added when non-empty.
export function buildGeometry(opts) {
  const [nx, ny, nz] = opts.dims;
  const vs = opts.voxelSize;
  const [ox, oy, oz] = opts.origin;
  const get = opts.get;
  const mergeKey = opts.mergeKey;
  const colorAt = opts.colorAt;
  const groupAt = opts.groupAt;
  const dimsArr = [nx, ny, nz];

  const positions = [];
  const normals = [];
  const colors = [];
  const idxRough = [];
  const idxShiny = [];
  const idxEmissive = [];
  const tmpCol = new THREE.Color();

  const maskKey = new Int32Array(Math.max(nx * ny, ny * nz, nz * nx));
  const maskVox = new Array(maskKey.length);

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const x = [0, 0, 0];
    const q = [0, 0, 0];
    q[d] = 1;
    const du = dimsArr[u];
    const dv = dimsArr[v];
    const dd = dimsArr[d];

    for (x[d] = -1; x[d] < dd; ) {
      let n = 0;
      for (x[v] = 0; x[v] < dv; x[v]++) {
        for (x[u] = 0; x[u] < du; x[u]++, n++) {
          const a = x[d] >= 0 ? get(x[0], x[1], x[2]) : 0;
          const b = x[d] < dd - 1 ? get(x[0] + q[0], x[1] + q[1], x[2] + q[2]) : 0;
          if (a !== 0 && b === 0) {
            const k = mergeKey(x[0], x[1], x[2], a);
            maskKey[n] = k + 1;
            maskVox[n] = [x[0], x[1], x[2], a];
          } else if (a === 0 && b !== 0) {
            const bx = x[0] + q[0], by = x[1] + q[1], bz = x[2] + q[2];
            const k = mergeKey(bx, by, bz, b);
            maskKey[n] = -(k + 1);
            maskVox[n] = [bx, by, bz, b];
          } else {
            maskKey[n] = 0;
            maskVox[n] = null;
          }
        }
      }

      x[d]++;

      n = 0;
      for (let j = 0; j < dv; j++) {
        for (let i = 0; i < du; ) {
          const key = maskKey[n];
          if (key === 0) { i++; n++; continue; }
          // width
          let w = 1;
          while (i + w < du && maskKey[n + w] === key) w++;
          // height
          let h = 1;
          let done = false;
          while (j + h < dv) {
            for (let kx = 0; kx < w; kx++) {
              if (maskKey[n + kx + h * du] !== key) { done = true; break; }
            }
            if (done) break;
            h++;
          }

          const owner = maskVox[n];
          const pidx = owner[3];
          const group = groupAt(pidx);
          colorAt(owner[0], owner[1], owner[2], pidx, tmpCol);

          const pos = [0, 0, 0];
          pos[u] = i;
          pos[v] = j;
          pos[d] = x[d];
          const dux = [0, 0, 0]; dux[u] = w;
          const dvx = [0, 0, 0]; dvx[v] = h;

          const nSign = key > 0 ? 1 : -1;
          const nrm = [0, 0, 0];
          nrm[d] = nSign;

          const base = positions.length / 3;
          // four corners in grid units -> meters
          const corners = [
            [pos[0], pos[1], pos[2]],
            [pos[0] + dux[0], pos[1] + dux[1], pos[2] + dux[2]],
            [pos[0] + dux[0] + dvx[0], pos[1] + dux[1] + dvx[1], pos[2] + dux[2] + dvx[2]],
            [pos[0] + dvx[0], pos[1] + dvx[1], pos[2] + dvx[2]],
          ];
          for (const c of corners) {
            positions.push(ox + c[0] * vs, oy + c[1] * vs, oz + c[2] * vs);
            normals.push(nrm[0], nrm[1], nrm[2]);
            colors.push(tmpCol.r, tmpCol.g, tmpCol.b);
          }
          const tgt = group === 2 ? idxEmissive : group === 1 ? idxShiny : idxRough;
          if (nSign > 0) {
            tgt.push(base, base + 1, base + 2, base, base + 2, base + 3);
          } else {
            tgt.push(base, base + 2, base + 1, base, base + 3, base + 2);
          }

          for (let hh = 0; hh < h; hh++) {
            for (let ww = 0; ww < w; ww++) {
              maskKey[n + ww + hh * du] = 0;
            }
          }
          i += w;
          n += w;
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const index = idxRough.concat(idxShiny, idxEmissive);
  geo.setIndex(index);
  geo.addGroup(0, idxRough.length, 0);
  let off = idxRough.length;
  if (idxShiny.length > 0) { geo.addGroup(off, idxShiny.length, 1); off += idxShiny.length; }
  if (idxEmissive.length > 0) geo.addGroup(off, idxEmissive.length, 2);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

// Three shared materials: index 0 rough, index 1 shiny, index 2 emissive (unlit/bright).
export function makeMaterials() {
  const rough = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: CONFIG.voxel.roughMat.roughness, metalness: CONFIG.voxel.roughMat.metalness,
  });
  const shiny = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: CONFIG.voxel.shinyMat.roughness, metalness: CONFIG.voxel.shinyMat.metalness,
  });
  const emissive = new THREE.MeshBasicMaterial({ vertexColors: true });
  return [rough, shiny, emissive];
}

// Mesh one decoded model part into a geometry positioned in model space.
export function meshModelPart(decoded, partName) {
  const part = decoded.parts[partName];
  const [sx, sy, sz] = part.size;
  const data = part.data;
  const palette = decoded.palette;
  const get = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return 0;
    return data[x + sx * (y + sy * z)];
  };
  return buildGeometry({
    dims: part.size,
    voxelSize: decoded.voxelSize,
    origin: part.originOffset,
    get,
    mergeKey: (x, y, z, pidx) => pidx * BUCKETS + jitterBucket(x, y, z),
    colorAt: (x, y, z, pidx, out) => jitteredColor(palette[pidx - 1].color, x, y, z, out),
    groupAt: (pidx) => (palette[pidx - 1].emissive ? 2 : palette[pidx - 1].shiny ? 1 : 0),
  });
}
