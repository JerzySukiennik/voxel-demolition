// world.js - scene/sun/fog with per-map env, generalized indestructible core, water plane, static cliffs, shadow follow
import * as THREE from "three";
import { CONFIG } from "./config.js";
import { buildGeometry, jitterBucket, jitteredColor } from "./voxel.js";

const W = CONFIG.world;
const R = CONFIG.render;
const ROCK_COLOR = "#9c8b73";

// Merge a map's optional env overrides over the CONFIG defaults.
export function resolveEnv(env = {}) {
  return {
    skyColor: env.skyColor ?? W.skyColor,
    fogColor: env.fogColor ?? W.fogColor,
    fogNear: env.fogNear ?? W.fogNear,
    fogFar: env.fogFar ?? W.fogFar,
    sunElevationDeg: env.sunElevationDeg ?? R.sunElevationDeg,
    sunAzimuthDeg: env.sunAzimuthDeg ?? R.sunAzimuthDeg,
    sunIntensity: env.sunIntensity ?? R.sunIntensity,
    groundColor: env.groundColor ?? W.groundColor,
  };
}

export function setupScene(scene, env) {
  const e = resolveEnv(env);
  scene.background = new THREE.Color(e.skyColor);
  scene.fog = new THREE.Fog(e.fogColor, e.fogNear, e.fogFar);

  const hemi = new THREE.HemisphereLight(R.hemiSky, R.hemiGround, R.hemiIntensity);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(R.sunColor, e.sunIntensity);
  const el = (e.sunElevationDeg * Math.PI) / 180;
  const az = (e.sunAzimuthDeg * Math.PI) / 180;
  const dist = 60;
  const offset = new THREE.Vector3(
    dist * Math.cos(el) * Math.sin(az),
    dist * Math.sin(el),
    dist * Math.cos(el) * Math.cos(az)
  );
  sun.position.copy(offset);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(R.shadowMapSize, R.shadowMapSize);
  const h = R.shadowBoxHalf;
  sun.shadow.camera.left = -h;
  sun.shadow.camera.right = h;
  sun.shadow.camera.top = h;
  sun.shadow.camera.bottom = -h;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 200;
  sun.shadow.bias = R.shadowBias;
  sun.shadow.normalBias = R.shadowNormalBias;
  scene.add(sun);
  scene.add(sun.target);
  return { sun, hemi, offset, env: e };
}

// Camera-following shadow box: keep the 2048 map, snap the sun target to the shadow texel grid
// so the small high-res frustum tracks the player/vehicle without shimmer.
export function makeShadowFollower(sun, offset) {
  const texel = (2 * R.shadowBoxHalf) / R.shadowMapSize;
  return (p) => {
    const sx = Math.round(p.x / texel) * texel;
    const sz = Math.round(p.z / texel) * texel;
    sun.target.position.set(sx, 0, sz);
    sun.position.set(sx + offset.x, offset.y, sz + offset.z);
    sun.target.updateMatrixWorld();
  };
}

// Indestructible core: fixed cuboid collider (top at y=0) + a static jittered visual layer, map-sized.
export function createCore(scene, world, RAPIER, materials, size, color) {
  const halfX = size.x / 2, halfZ = size.z / 2;
  const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, -W.coreThickness / 2, 0);
  const body = world.createRigidBody(bodyDesc);
  const colDesc = RAPIER.ColliderDesc.cuboid(halfX, W.coreThickness / 2, halfZ)
    .setFriction(0.9)
    .setRestitution(0.0);
  const collider = world.createCollider(colDesc, body);

  // Visual: one static voxel layer, top surface at y=0, same look as the destructible skin.
  const vs = W.skinVoxel;
  const nX = Math.round(size.x / vs), nZ = Math.round(size.z / vs);
  const base = new THREE.Color().setStyle(color || W.groundColor);
  const geo = buildGeometry({
    dims: [nX, 1, nZ],
    voxelSize: vs,
    origin: [-halfX, -vs, -halfZ],
    get: () => 1,
    mergeKey: (x, y, z) => jitterBucket(x, y, z),
    colorAt: (x, y, z, pidx, out) => jitteredColor(base, x, y, z, out),
    groupAt: () => 0,
  });
  const mesh = new THREE.Mesh(geo, materials);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  scene.add(mesh);

  return { body, colliderHandle: collider.handle, mesh };
}

// Visual-only animated water plane over water.rect at water.level (brief section 2.4). Silent.
export function createWater(scene, water) {
  const { x0, z0, x1, z1 } = water.rect;
  const w = Math.abs(x1 - x0), d = Math.abs(z1 - z0);
  const geo = new THREE.PlaneGeometry(w, d);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2e4a44, transparent: true, opacity: 0.82, roughness: 0.15, metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((x0 + x1) / 2, water.level, (z0 + z1) / 2);
  mesh.receiveShadow = true;
  scene.add(mesh);
  const rect = {
    x0: Math.min(x0, x1), x1: Math.max(x0, x1),
    z0: Math.min(z0, z1), z1: Math.max(z0, z1),
  };
  return {
    mesh, level: water.level, rect,
    update(t) {
      mesh.position.y = water.level + 0.03 * Math.sin(t * 0.8);
      mat.opacity = 0.82 + 0.04 * Math.sin(t * 0.53);
    },
  };
}

// Indestructible static cliff terraces (canyon boundary). Returns { colliderCount, meshes }.
export function buildStaticGeo(scene, world, RAPIER, materials, entries) {
  let colliderCount = 0;
  const meshes = [];
  for (const e of entries || []) {
    if (e.type === "cliff") colliderCount += buildCliff(scene, world, RAPIER, materials, e, meshes);
  }
  return { colliderCount, meshes };
}

// One terraced cliff run from->to: stepped strata rising outward, meshed as coarse voxels,
// backed by T (<=8) merged fixed cuboid colliders in the run's local frame.
function buildCliff(scene, world, RAPIER, materials, e, meshes) {
  const [fx, fz] = e.from;
  const [tx, tz] = e.to;
  const dx = tx - fx, dz = tz - fz;
  const L = Math.hypot(dx, dz) || 0.001;
  let ux = dx / L, uz = dz / L;
  let nX = -uz, nZ = ux;             // outward normal candidate (u x up)
  let originX = fx, originZ = fz;
  const mx = (fx + tx) / 2, mz = (fz + tz) / 2;
  if (nX * mx + nZ * mz < 0) {       // flip run so the terraces face away from map center
    ux = -ux; uz = -uz; nX = uz; nZ = -ux; originX = tx; originZ = tz;
  }
  const height = e.height, depth = e.depth, T = 6, seed = (e.seed | 0) % 97;
  const cv = 0.5;
  const nlx = Math.max(1, Math.round(L / cv));
  const nly = Math.max(1, Math.round(height / cv));
  const nlz = Math.max(1, Math.round(depth / cv));
  const terraceTop = (lz) => {
    const zpos = (lz + 0.5) * cv;
    const t = Math.min(T - 1, Math.floor((zpos / depth) * T));
    return (height * (t + 1)) / T;
  };
  const base = new THREE.Color().setStyle(ROCK_COLOR);
  const geo = buildGeometry({
    dims: [nlx, nly, nlz],
    voxelSize: cv,
    origin: [0, 0, 0],
    get: (x, y, z) => ((y + 0.5) * cv < terraceTop(z) ? 1 : 0),
    mergeKey: (x, y, z) => jitterBucket(x + seed, y, z),
    colorAt: (x, y, z, pidx, out) => jitteredColor(base, x + seed, y, z, out),
    groupAt: () => 0,
  });
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(ux, 0, uz),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(nX, 0, nZ)
  );
  const quat = new THREE.Quaternion().setFromRotationMatrix(basis);
  const mesh = new THREE.Mesh(geo, materials);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set(originX, 0, originZ);
  mesh.quaternion.copy(quat);
  scene.add(mesh);
  meshes.push(mesh);

  const bodyDesc = RAPIER.RigidBodyDesc.fixed()
    .setTranslation(originX, 0, originZ)
    .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });
  const body = world.createRigidBody(bodyDesc);
  const halfX = (nlx * cv) / 2;
  let count = 0;
  for (let t = 0; t < T; t++) {
    const zt0 = (t / T) * depth, zt1 = ((t + 1) / T) * depth;
    const hTop = (height * (t + 1)) / T;
    const col = RAPIER.ColliderDesc.cuboid(halfX, hTop / 2, (zt1 - zt0) / 2)
      .setTranslation(halfX, hTop / 2, (zt0 + zt1) / 2)
      .setFriction(0.9)
      .setRestitution(0.0);
    world.createCollider(col, body);
    count++;
  }
  return count;
}
