// voxel.js - decode contract models, greedy meshing to BufferGeometry with baked per-voxel AO + jittered vertex colors
import * as THREE from "three";
import { CONFIG } from "./config.js";

const BUCKETS = CONFIG.voxel.jitterBuckets;
const JIT = CONFIG.voxel.jitterLightness;
const AO = CONFIG.voxel.ao;

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

// Classic voxel AO for one face vertex, as occlusion in 0..1 (0 = wide open, 1 = fully tucked in).
function ringOcclusion(side1, side2, corner) {
  if (side1 !== 0 && side2 !== 0) return 1;
  return (side1 + side2 + corner) / 3;
}

// Occlusion -> vertex-colour multiplier. Voxels here are 0.15 m, so a single-ring AO term would be a
// 15 cm hairline; sampling a second (and optionally third) ring out and weighting it down spreads the
// same crease over ~0.3 m, which is what actually reads as contact shading at play distance.
const AO_RINGS = AO.ringWeights || [1];
const AO_WEIGHT_SUM = AO_RINGS.reduce((a, b) => a + b, 0);
const AO_STEPS = 15;                                    // 4 bits of AO per vertex in the merge key
const AO_TABLE = new Float32Array(AO_STEPS + 1);
for (let i = 0; i <= AO_STEPS; i++) {
  AO_TABLE[i] = 1 - AO.strength * Math.pow(i / AO_STEPS, AO.curve ?? 1);
}

// Greedy mesh a voxel volume.
// opts: { dims:[nx,ny,nz], voxelSize, origin:[ox,oy,oz], get(x,y,z)->0|pidx,
//         mergeKey(x,y,z,pidx), colorAt(x,y,z,pidx,out:THREE.Color), groupAt(pidx)->0|1|2 }
// Returns THREE.BufferGeometry with position/normal/color attributes and up to three groups
// (0 rough, 1 shiny, 2 emissive/unlit). Groups 1 and 2 are only added when non-empty.
//
// Ambient occlusion: every emitted vertex samples the neighbours that touch it in the layer on the AIR
// side of the face (side1/side2/corner, over CONFIG.voxel.ao.ringWeights rings) and darkens its vertex
// colour. It is baked at mesh time, so it costs exactly nothing per frame. The mesher stays greedy: the
// four corner AO values are packed into the low 16 bits of the merge key, so a run only merges where
// the AO field is CONSTANT across it — and where it is constant the merged quad interpolates to the
// identical result as per-voxel quads (a run's shared vertices carry the same AO by construction).
// Quads whose diagonal would smear a single dark corner are re-triangulated along the other diagonal.
// NOTE: this leaves 15 bits for the caller's own key, i.e. mergeKey() must stay below ~32000.
// `get` is never called outside [0,dims): out-of-volume neighbours count as air, which is the correct
// answer for the flat-surface case and keeps callers that index raw arrays (destruction tiles) safe.
export function buildGeometry(opts) {
  const [nx, ny, nz] = opts.dims;
  const vs = opts.voxelSize;
  const [ox, oy, oz] = opts.origin;
  const get = opts.get;
  const mergeKey = opts.mergeKey;
  const colorAt = opts.colorAt;
  const groupAt = opts.groupAt;
  const dimsArr = [nx, ny, nz];
  const aoOn = AO.enabled !== false;

  const positions = [];
  const normals = [];
  const colors = [];
  const idxRough = [];
  const idxShiny = [];
  const idxEmissive = [];
  const tmpCol = new THREE.Color();

  const planeMax = Math.max(nx * ny, ny * nz, nz * nx);
  const maskKey = new Int32Array(planeMax);
  const maskVox = new Int32Array(planeMax * 4); // x,y,z,pidx of the face's owning voxel
  // Two cached occupancy slices so `get` is called once per voxel per axis (was twice) and AO
  // neighbour sampling is a plain array read instead of a callback.
  let planeA = new Int32Array(planeMax);
  let planeB = new Int32Array(planeMax);

  const x = [0, 0, 0];

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const q = [0, 0, 0];
    q[d] = 1;
    const du = dimsArr[u];
    const dv = dimsArr[v];
    const dd = dimsArr[d];
    const area = du * dv;

    // Fill `plane` with the occupancy of slice `s` along d (all air when out of range).
    const fillPlane = (plane, s) => {
      if (s < 0 || s >= dd) { plane.fill(0, 0, area); return; }
      x[d] = s;
      let n = 0;
      for (x[v] = 0; x[v] < dv; x[v]++) {
        for (x[u] = 0; x[u] < du; x[u]++, n++) plane[n] = get(x[0], x[1], x[2]);
      }
    };

    // Solid test inside a cached slice, out-of-plane counts as air.
    const solidAt = (plane, i, j) =>
      (i < 0 || j < 0 || i >= du || j >= dv) ? 0 : (plane[i + j * du] !== 0 ? 1 : 0);

    // Occlusion of one face corner, summed over the weighted rings, quantised to 4 bits.
    const cornerAO = (plane, i, j, su, sv) => {
      let occ = 0;
      for (let k = 0; k < AO_RINGS.length; k++) {
        const r = k + 1;
        occ += AO_RINGS[k] * ringOcclusion(
          solidAt(plane, i + su * r, j),
          solidAt(plane, i, j + sv * r),
          solidAt(plane, i + su * r, j + sv * r)
        );
      }
      return Math.round((occ / AO_WEIGHT_SUM) * AO_STEPS);
    };

    // Pack the four corner AO levels (u0v0, u1v0, u1v1, u0v1) of cell (i,j) into 16 bits,
    // sampling the layer on the air side of the face.
    const aoCodeAt = (plane, i, j) =>
      cornerAO(plane, i, j, -1, -1) | (cornerAO(plane, i, j, 1, -1) << 4) |
      (cornerAO(plane, i, j, 1, 1) << 8) | (cornerAO(plane, i, j, -1, 1) << 12);

    planeA.fill(0, 0, area);   // slice -1 is outside the volume
    fillPlane(planeB, 0);

    for (let s = -1; s < dd; s++) {
      // planeA = slice s, planeB = slice s+1. A face lives between them, on the plane s+1.
      let n = 0;
      for (let j = 0; j < dv; j++) {
        for (let i = 0; i < du; i++, n++) {
          const a = planeA[n];
          const b = planeB[n];
          if (a !== 0 && b === 0) {
            x[u] = i; x[v] = j; x[d] = s;
            const k = mergeKey(x[0], x[1], x[2], a);
            const code = aoOn ? aoCodeAt(planeB, i, j) : 0;
            maskKey[n] = (k * 65536 + code) + 1;
            maskVox[n * 4] = x[0]; maskVox[n * 4 + 1] = x[1]; maskVox[n * 4 + 2] = x[2]; maskVox[n * 4 + 3] = a;
          } else if (a === 0 && b !== 0) {
            x[u] = i; x[v] = j; x[d] = s + 1;
            const k = mergeKey(x[0], x[1], x[2], b);
            const code = aoOn ? aoCodeAt(planeA, i, j) : 0;
            maskKey[n] = -((k * 65536 + code) + 1);
            maskVox[n * 4] = x[0]; maskVox[n * 4 + 1] = x[1]; maskVox[n * 4 + 2] = x[2]; maskVox[n * 4 + 3] = b;
          } else {
            maskKey[n] = 0;
          }
        }
      }

      const slice = s + 1; // the grid plane the quads sit on

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

          const pidx = maskVox[n * 4 + 3];
          const group = groupAt(pidx);
          colorAt(maskVox[n * 4], maskVox[n * 4 + 1], maskVox[n * 4 + 2], pidx, tmpCol);

          // Unpack the four corner AO levels this run shares. Emissive faces are unlit, so they
          // keep their full colour (an unlit lamp must not pick up contact shadows).
          const code = (key > 0 ? key - 1 : -key - 1) & 0xffff;
          const l0 = code & 15, l1 = (code >> 4) & 15, l2 = (code >> 8) & 15, l3 = (code >> 12) & 15;
          const m0 = group === 2 ? 1 : AO_TABLE[l0];
          const m1 = group === 2 ? 1 : AO_TABLE[l1];
          const m2 = group === 2 ? 1 : AO_TABLE[l2];
          const m3 = group === 2 ? 1 : AO_TABLE[l3];

          const pos = [0, 0, 0];
          pos[u] = i;
          pos[v] = j;
          pos[d] = slice;
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
          const mul = [m0, m1, m2, m3];
          for (let c = 0; c < 4; c++) {
            const cc = corners[c], m = mul[c];
            positions.push(ox + cc[0] * vs, oy + cc[1] * vs, oz + cc[2] * vs);
            normals.push(nrm[0], nrm[1], nrm[2]);
            colors.push(tmpCol.r * m, tmpCol.g * m, tmpCol.b * m);
          }
          // Split the quad along the diagonal that does NOT smear a lone dark corner across it.
          // l* are OCCLUSION (higher = darker), so the classic "brighter diagonal" test inverts.
          const flip = (l0 + l2) < (l1 + l3);
          const tgt = group === 2 ? idxEmissive : group === 1 ? idxShiny : idxRough;
          if (nSign > 0) {
            if (flip) tgt.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
            else tgt.push(base, base + 1, base + 2, base, base + 2, base + 3);
          } else {
            if (flip) tgt.push(base + 1, base + 3, base + 2, base + 1, base, base + 3);
            else tgt.push(base, base + 2, base + 1, base, base + 3, base + 2);
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

      // Slide the window: next iteration's A is this iteration's B.
      const tmp = planeA; planeA = planeB; planeB = tmp;
      fillPlane(planeB, s + 2);
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
// envMapIntensity feeds off scene.environment (the procedural sky IBL built in world.js), which is
// what makes metal and glass read as metal and glass instead of flat grey.
export function makeMaterials() {
  const R = CONFIG.voxel.roughMat, S = CONFIG.voxel.shinyMat;
  const rough = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: R.roughness, metalness: R.metalness, envMapIntensity: R.envMapIntensity ?? 1,
  });
  const shiny = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: S.roughness, metalness: S.metalness, envMapIntensity: S.envMapIntensity ?? 1,
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
