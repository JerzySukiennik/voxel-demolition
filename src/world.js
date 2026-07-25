// world.js - scene/sun/gradient sky + IBL with per-map env, generalized indestructible core, water plane, static cliffs, shadow follow
import * as THREE from "three";
import { CONFIG } from "./config.js";
import { buildGeometry, jitterBucket, jitteredColor } from "./voxel.js";

const W = CONFIG.world;
const R = CONFIG.render;
const SKY = CONFIG.render.sky;
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

// The sky palette every map derives from its own env: the horizon is EXACTLY the fog colour, so
// distant geometry fades into the dome with no seam; the zenith is the map's sky colour pushed
// deeper/more saturated; below the horizon the dome settles onto a haze of the map's ground colour.
function skyPalette(e) {
  const horizon = new THREE.Color(e.fogColor);
  const zenith = new THREE.Color(e.skyColor).offsetHSL(0, SKY.zenithSat, SKY.zenithLight);
  const ground = new THREE.Color(e.groundColor).lerp(horizon, SKY.groundMix).multiplyScalar(SKY.groundDim);
  return { horizon, zenith, ground, sun: new THREE.Color(R.sunColor) };
}

// Shared by the dome shader and the IBL texture below: direction -> linear sky colour.
function skyColorAt(pal, dy, sunDot, out) {
  const up = Math.pow(Math.max(dy, 0), SKY.horizonPow);
  out.copy(pal.horizon).lerp(pal.zenith, up);
  const down = Math.min(Math.max(-dy / SKY.groundBlend, 0), 1);
  out.lerp(pal.ground, down);
  const sd = Math.max(sunDot, 0);
  const haze = SKY.haze * Math.pow(1 - Math.min(Math.abs(dy), 1), SKY.hazePow) * (0.35 + 0.65 * sd);
  const glow = SKY.sunGlow * Math.pow(sd, SKY.sunGlowPow);
  out.r += pal.sun.r * (haze + glow);
  out.g += pal.sun.g * (haze + glow);
  out.b += pal.sun.b * (haze + glow);
  return out;
}

const SKY_VERT = `
varying vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = `
uniform vec3 uZenith, uHorizon, uGround, uSun, uSunDir;
uniform float uHorizonPow, uGroundBlend, uHaze, uHazePow, uSunGlow, uSunGlowPow;
varying vec3 vWorld;
void main() {
  vec3 d = normalize(vWorld - cameraPosition);
  vec3 col = mix(uHorizon, uZenith, pow(clamp(d.y, 0.0, 1.0), uHorizonPow));
  col = mix(col, uGround, clamp(-d.y / uGroundBlend, 0.0, 1.0));
  float sd = max(dot(d, uSunDir), 0.0);
  float haze = uHaze * pow(1.0 - min(abs(d.y), 1.0), uHazePow) * (0.35 + 0.65 * sd);
  col += uSun * (haze + uSunGlow * pow(sd, uSunGlowPow));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Inverted sphere painted by the gradient above. Unfogged (it IS the fog's destination colour),
// depth-write off and drawn last so early-Z throws away every pixel the world already covers —
// the whole sky costs one cheap shader over the few thousand background pixels that survive.
function createSkyDome(scene, pal, sunDir) {
  const geo = new THREE.SphereGeometry(SKY.radius, 32, 16);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: pal.zenith },
      uHorizon: { value: pal.horizon },
      uGround: { value: pal.ground },
      uSun: { value: pal.sun },
      uSunDir: { value: sunDir.clone().normalize() },
      uHorizonPow: { value: SKY.horizonPow },
      uGroundBlend: { value: SKY.groundBlend },
      uHaze: { value: SKY.haze },
      uHazePow: { value: SKY.hazePow },
      uSunGlow: { value: SKY.sunGlow },
      uSunGlowPow: { value: SKY.sunGlowPow },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000;
  scene.add(mesh);
  return mesh;
}

// Tiny equirect image of the same sky, handed to scene.environment. three PMREM-filters it once at
// first render and every MeshStandardMaterial then gets real image-based ambient + a sky reflection,
// which is the difference between "metal" and "dark grey". A 64x32 source is plenty: the sky is a
// smooth gradient, so there is nothing finer to resolve, and the whole thing is a few KB.
function createSkyEnv(pal, sunDir) {
  const w = SKY.envWidth, h = SKY.envHeight;
  const data = new Uint8Array(w * h * 4);
  const col = new THREE.Color();
  const toSRGB = (v) => {
    const c = Math.min(Math.max(v, 0), 1);
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(s * 255);
  };
  for (let y = 0; y < h; y++) {
    const theta = ((y + 0.5) / h) * Math.PI;          // 0 = up
    const dy = Math.cos(theta), sinT = Math.sin(theta);
    for (let x = 0; x < w; x++) {
      const phi = ((x + 0.5) / w) * Math.PI * 2;
      const dx = sinT * Math.sin(phi), dz = sinT * Math.cos(phi);
      const sunDot = dx * sunDir.x + dy * sunDir.y + dz * sunDir.z;
      skyColorAt(pal, dy, sunDot, col);
      const i = (y * w + x) * 4;
      data[i] = toSRGB(col.r); data[i + 1] = toSRGB(col.g); data[i + 2] = toSRGB(col.b); data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function setupScene(scene, env) {
  const e = resolveEnv(env);
  const pal = skyPalette(e);
  scene.background = pal.horizon.clone();  // only ever seen for a frame before the dome draws
  scene.fog = new THREE.Fog(e.fogColor, e.fogNear, e.fogFar);

  const el = (e.sunElevationDeg * Math.PI) / 180;
  const az = (e.sunAzimuthDeg * Math.PI) / 180;
  const dist = R.sunDistance;
  const offset = new THREE.Vector3(
    dist * Math.cos(el) * Math.sin(az),
    dist * Math.sin(el),
    dist * Math.cos(el) * Math.cos(az)
  );

  let sky = null;
  if (SKY.enabled !== false) {
    sky = createSkyDome(scene, pal, offset);
    scene.environment = createSkyEnv(pal, offset.clone().normalize());
  } else {
    scene.background = new THREE.Color(e.skyColor);
  }

  // The sky IBL now carries most of the fill light, so the hemisphere light only tints what the
  // low-res env cannot: it is deliberately weak next to the old flat 0.5.
  const hemi = new THREE.HemisphereLight(R.hemiSky, R.hemiGround, R.hemiIntensity);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(R.sunColor, e.sunIntensity);
  sun.position.copy(offset);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(R.shadowMapSize, R.shadowMapSize);
  const h = R.shadowBoxHalf;
  sun.shadow.camera.left = -h;
  sun.shadow.camera.right = h;
  sun.shadow.camera.top = h;
  sun.shadow.camera.bottom = -h;
  // A tight near/far around the actual slab of world the box can contain buys depth precision,
  // which is what lets the bias stay small enough to keep contact shadows attached.
  sun.shadow.camera.near = R.shadowNear;
  sun.shadow.camera.far = R.shadowFar;
  sun.shadow.bias = R.shadowBias;
  sun.shadow.normalBias = R.shadowNormalBias;
  scene.add(sun);
  scene.add(sun.target);
  return { sun, hemi, sky, offset, env: e };
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

// Normalize a water rect (min/max ordered) or return null.
function normRect(r) {
  if (!r) return null;
  return {
    x0: Math.min(r.x0, r.x1), x1: Math.max(r.x0, r.x1),
    z0: Math.min(r.z0, r.z1), z1: Math.max(r.z0, r.z1),
  };
}

// Indestructible core: fixed collider(s) with their top surface at y=0 + a static jittered visual layer.
// Dry maps (no waterRect) build ONE flat cuboid, byte-identical to before. With a waterRect the core is a
// "picture frame" of up to 4 cuboids around the rect (a single Rapier cuboid can't have a hole), and the
// rect opening becomes an excavated basin: a deep floor cuboid (top at basinFloorY) + 4 retaining walls
// (basinFloorY -> skinThickness) so the pond reads as a real recessed bowl and boats float at true depth.
export function createCore(scene, world, RAPIER, materials, size, color, waterRect) {
  const halfX = size.x / 2, halfZ = size.z / 2;
  const rect = normRect(waterRect);

  // All core geometry hangs off one fixed body; colliders carry their own offsets (top surface at y=0).
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
  const halfT = W.coreThickness / 2;
  const slab = (cx, cz, hx, hz, cy, hy) => {
    if (hx <= 1e-4 || hz <= 1e-4 || hy <= 1e-4) return;
    const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(cx, cy, cz)
      .setFriction(0.9)
      .setRestitution(0.0);
    world.createCollider(cd, body);
  };

  if (!rect) {
    // Flat map-sized core cuboid, top at y=0 (unchanged behavior).
    slab(0, 0, halfX, halfZ, -halfT, halfT);
  } else {
    // Picture frame: west/east strips span full depth; north/south strips fill the rect's x-span only.
    slab((-halfX + rect.x0) / 2, 0, (rect.x0 + halfX) / 2, halfZ, -halfT, halfT);                                  // west
    slab((rect.x1 + halfX) / 2, 0, (halfX - rect.x1) / 2, halfZ, -halfT, halfT);                                   // east
    slab((rect.x0 + rect.x1) / 2, (-halfZ + rect.z0) / 2, (rect.x1 - rect.x0) / 2, (rect.z0 + halfZ) / 2, -halfT, halfT); // north
    slab((rect.x0 + rect.x1) / 2, (rect.z1 + halfZ) / 2, (rect.x1 - rect.x0) / 2, (halfZ - rect.z1) / 2, -halfT, halfT);  // south

    // Excavated basin under the rect: indestructible floor + 4 retaining walls (all fixed core geometry).
    const floorY = W.basinFloorY, ft = W.basinFloorThickness, wt = W.basinWallThickness, wallTop = W.skinThickness;
    const cx = (rect.x0 + rect.x1) / 2, cz = (rect.z0 + rect.z1) / 2;
    const hx = (rect.x1 - rect.x0) / 2, hz = (rect.z1 - rect.z0) / 2;
    slab(cx, cz, hx, hz, floorY - ft / 2, ft / 2);                                    // basin floor (top at floorY)
    const wallHy = (wallTop - floorY) / 2, wallCy = (wallTop + floorY) / 2, wh = wt / 2;
    slab(cx, rect.z0, hx + wh, wh, wallCy, wallHy);                                    // north wall (z0)
    slab(cx, rect.z1, hx + wh, wh, wallCy, wallHy);                                    // south wall (z1)
    slab(rect.x0, cz, wh, hz, wallCy, wallHy);                                         // west wall (x0)
    slab(rect.x1, cz, wh, hz, wallCy, wallHy);                                         // east wall (x1)
  }

  // Visual: one static voxel layer, top surface at y=0, same look as the destructible skin. Carved out of
  // the pond rect (the basin supplies its own submerged floor/wall mesh below).
  const vs = W.skinVoxel;
  const nX = Math.round(size.x / vs), nZ = Math.round(size.z / vs);
  const base = new THREE.Color().setStyle(color || W.groundColor);
  const inRect = (wx, wz) => rect && wx > rect.x0 && wx < rect.x1 && wz > rect.z0 && wz < rect.z1;
  const geo = buildGeometry({
    dims: [nX, 1, nZ],
    voxelSize: vs,
    origin: [-halfX, -vs, -halfZ],
    get: (x, y, z) => (inRect(-halfX + (x + 0.5) * vs, -halfZ + (z + 0.5) * vs) ? 0 : 1),
    mergeKey: (x, y, z) => jitterBucket(x, y, z),
    colorAt: (x, y, z, pidx, out) => jitteredColor(base, x, y, z, out),
    groupAt: () => 0,
  });
  const mesh = new THREE.Mesh(geo, materials);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // Basin visual: a single voxel volume over the rect = floor layer (top at basinFloorY) + perimeter walls.
  let basinMesh = null, rampMesh = null;
  if (rect) {
    basinMesh = buildBasinMesh(scene, materials, rect, vs);
    rampMesh = buildBasinRamp(scene, world, RAPIER, body, materials, rect, vs);
  }

  return { body, mesh, basinMesh, rampMesh };
}

// SE-corner entry ramp: one sloped indestructible plate (collider on the shared core body + a matching voxel
// mesh) anchored at the rect's (x1,z1) corner. Its top surface runs from (x1, skinThickness) at the sand rim
// down to (x1 - run, basinFloorY) inside the basin, spanning `width` of the edge in Z. Only this corner is
// filled, so the basin center still raycasts to the deep floor — a beached boat can drive in and a waded-in
// player can climb back out. Fixed body, not destructible, never in allowedImpactors.
function buildBasinRamp(scene, world, RAPIER, body, materials, rect, vs) {
  const skinTop = W.skinThickness, floorY = W.basinFloorY;
  const run = W.basinRampRun, width = W.basinRampWidth, thick = W.basinRampThickness;
  const drop = skinTop - floorY;
  const theta = Math.atan2(drop, run);          // slope angle (about +Z)
  const s = Math.sin(theta), c = Math.cos(theta);
  const slopeLen = Math.hypot(run, drop);
  const hx = slopeLen / 2, hy = thick / 2, hz = width / 2;

  // Plate center: midpoint of the top-surface line, pushed DOWN along the top normal by hy so the top face
  // lands exactly on that line. Local +x -> up-slope toward the rim (world (c,s,0)); top normal = (-s,c,0).
  const midX = rect.x1 - run / 2, midY = (skinTop + floorY) / 2, cz = rect.z1 - width / 2;
  const cx = midX + s * hy, cy = midY - c * hy;
  const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), theta);

  const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
    .setTranslation(cx, cy, cz)
    .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
    .setFriction(0.9)
    .setRestitution(0.0);
  world.createCollider(cd, body);

  // Matching coarse voxel mesh (basin material), centered at the local origin then transformed like the collider.
  const nX = Math.max(1, Math.round((2 * hx) / vs));
  const nY = Math.max(1, Math.round((2 * hy) / vs));
  const nZ = Math.max(1, Math.round((2 * hz) / vs));
  const base = new THREE.Color().setStyle(W.basinColor);
  const geo = buildGeometry({
    dims: [nX, nY, nZ],
    voxelSize: vs,
    origin: [-(nX * vs) / 2, -(nY * vs) / 2, -(nZ * vs) / 2],
    get: () => 1,
    mergeKey: (x, y, z) => jitterBucket(x, y, z),
    colorAt: (x, y, z, pidx, out) => jitteredColor(base, x, y, z, out),
    groupAt: () => 0,
  });
  const mesh = new THREE.Mesh(geo, materials);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.position.set(cx, cy, cz);
  mesh.quaternion.copy(quat);
  scene.add(mesh);
  return mesh;
}

// Submerged basin visual: one voxel volume spanning the rect from (basinFloorY - vs) up to skinThickness.
// The bottom layer is the full floor; perimeter columns are the retaining-wall faces; the interior is hollow.
function buildBasinMesh(scene, materials, rect, vs) {
  const floorY = W.basinFloorY, wallTop = W.skinThickness;
  const oy = floorY - vs; // bottom of the floor layer -> floor top lands at floorY
  const bnX = Math.max(1, Math.round((rect.x1 - rect.x0) / vs));
  const bnZ = Math.max(1, Math.round((rect.z1 - rect.z0) / vs));
  const bnY = Math.max(2, Math.round((wallTop - oy) / vs));
  const wallCols = Math.max(1, Math.round(W.basinWallThickness / vs));
  const base = new THREE.Color().setStyle(W.basinColor);
  const geo = buildGeometry({
    dims: [bnX, bnY, bnZ],
    voxelSize: vs,
    origin: [rect.x0, oy, rect.z0],
    get: (x, y, z) => {
      if (y === 0) return 1; // floor layer
      return (x < wallCols || x >= bnX - wallCols || z < wallCols || z >= bnZ - wallCols) ? 1 : 0; // walls
    },
    mergeKey: (x, y, z) => jitterBucket(x, y, z),
    colorAt: (x, y, z, pidx, out) => jitteredColor(base, x, y, z, out),
    groupAt: () => 0,
  });
  const mesh = new THREE.Mesh(geo, materials);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

// Visual-only animated water plane over water.rect at water.level (brief section 2.4). Silent.
// Low roughness + the sky IBL means it actually mirrors the dome instead of reading as green paint.
export function createWater(scene, water) {
  const { x0, z0, x1, z1 } = water.rect;
  const w = Math.abs(x1 - x0), d = Math.abs(z1 - z0);
  const geo = new THREE.PlaneGeometry(w, d);
  const mat = new THREE.MeshStandardMaterial({
    color: W.waterColor, transparent: true, opacity: 0.82,
    roughness: W.waterRoughness, metalness: W.waterMetalness, envMapIntensity: W.waterEnvIntensity,
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
