// tools.js — voxel held-models for Phase 2 weapons (Y-up, +Z forward/length, +X left); palette index 0 = empty, n -> palette[n-1]
function vol(sx, sy, sz, fn) {
  const data = new Array(sx * sy * sz).fill(0);
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++) {
        const v = fn(x, y, z) | 0;
        if (v) data[x + sx * (y + sy * z)] = v;
      }
  return { size: [sx, sy, sz], data };
}

const brown = { color: "#6a4a2c", roughness: 0.9, metalness: 0.0 };
const wood = { color: "#7a5a34", roughness: 0.85, metalness: 0.0 };
const steel = { color: "#8a8f96", roughness: 0.4, metalness: 0.25 };
const darkSteel = { color: "#3a3d42", roughness: 0.5, metalness: 0.25 };
const olive = { color: "#4b5320", roughness: 0.85, metalness: 0.0 };
const oliveDark = { color: "#363a17", roughness: 0.85, metalness: 0.0 };
const red = { color: "#d02a22", roughness: 0.6, metalness: 0.0 };
const grayBody = { color: "#9aa0a6", roughness: 0.55, metalness: 0.1 };

// --- Sledgehammer: brown handle running +Z, steel head block at the far end ---
const HAM_SX = 6, HAM_SY = 4, HAM_SZ = 17;
const sledgehammer = {
  name: "sledgehammer",
  voxelSize: 0.05,
  palette: [brown, steel],
  parts: [
    {
      name: "main",
      size: [HAM_SX, HAM_SY, HAM_SZ],
      originOffset: [0, 0, 0],
      pivot: [3 * 0.05, 1.5 * 0.05, 2 * 0.05],
      data: vol(HAM_SX, HAM_SY, HAM_SZ, (x, y, z) => {
        const head = z >= 13 && z <= 16;
        if (head) return 2;
        const handle = (x === 2 || x === 3) && (y === 1 || y === 2) && z <= 13;
        return handle ? 1 : 0;
      }).data,
    },
  ],
  anchors: {},
};

// --- C4: olive brick spanning X, thin in Y, with a red detonator strip on top ---
const C4_SX = 8, C4_SY = 4, C4_SZ = 5;
const c4 = {
  name: "c4",
  voxelSize: 0.04,
  palette: [olive, oliveDark, red],
  parts: [
    {
      name: "main",
      size: [C4_SX, C4_SY, C4_SZ],
      originOffset: [0, 0, 0],
      pivot: [C4_SX * 0.04 / 2, 0, C4_SZ * 0.04 / 2],
      data: vol(C4_SX, C4_SY, C4_SZ, (x, y, z) => {
        const edge = x === 0 || x === C4_SX - 1 || z === 0 || z === C4_SZ - 1;
        if (y === C4_SY - 1 && x >= 3 && x <= 4 && z >= 2 && z <= 2) return 3; // detonator light
        return edge ? 2 : 1;
      }).data,
    },
  ],
  anchors: {},
};

// --- Shotgun: wood stock at the back, twin dark-steel barrels (x-gap) running +Z ---
const SG_SX = 5, SG_SY = 4, SG_SZ = 18;
const shotgun = {
  name: "shotgun",
  voxelSize: 0.05,
  palette: [wood, darkSteel],
  parts: [
    {
      name: "main",
      size: [SG_SX, SG_SY, SG_SZ],
      originOffset: [0, 0, 0],
      pivot: [SG_SX * 0.05 / 2, 1 * 0.05, 5 * 0.05],
      data: vol(SG_SX, SG_SY, SG_SZ, (x, y, z) => {
        const barrels = z >= 6 && (y === 2 || y === 3) && (x === 0 || x === 1 || x === 3 || x === 4);
        if (barrels) return 2;
        const receiver = z >= 4 && z <= 8 && y >= 1 && y <= 3;
        if (receiver) return 1;
        const stock = z <= 6 && (y === 0 || y === 1) && (x === 2 || x === 1 || x === 3);
        return stock ? 1 : 0;
      }).data,
    },
  ],
  anchors: {},
};

// --- Rocket launcher: fat olive tube running +Z with a dark muzzle ring and under-grip ---
const RL_SX = 6, RL_SY = 7, RL_SZ = 20;
const rocketLauncher = {
  name: "rocketLauncher",
  voxelSize: 0.06,
  palette: [olive, darkSteel],
  parts: [
    {
      name: "main",
      size: [RL_SX, RL_SY, RL_SZ],
      originOffset: [0, 0, 0],
      pivot: [RL_SX * 0.06 / 2, 1 * 0.06, 6 * 0.06],
      data: vol(RL_SX, RL_SY, RL_SZ, (x, y, z) => {
        const cx = 2.5, cy = 3.5;
        const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        const tube = r2 <= 2.9 * 2.9;
        if (z >= 17) return tube && r2 >= 1.5 * 1.5 ? 2 : 0; // dark muzzle ring, hollow center
        if (tube) return 1;
        const grip = (x === 2 || x === 3) && y <= 1 && z >= 5 && z <= 8;
        return grip ? 2 : 0;
      }).data,
    },
  ],
  anchors: {},
};

// --- Rocket projectile: gray body, red nose, dark fins; length along +Z (tip at +Z) ---
const RK_SX = 3, RK_SY = 3, RK_SZ = 8;
const rocket = {
  name: "rocket",
  voxelSize: 0.05,
  palette: [grayBody, red, darkSteel],
  parts: [
    {
      name: "main",
      size: [RK_SX, RK_SY, RK_SZ],
      originOffset: [0, 0, 0],
      pivot: [RK_SX * 0.05 / 2, RK_SY * 0.05 / 2, RK_SZ * 0.05 / 2],
      data: vol(RK_SX, RK_SY, RK_SZ, (x, y, z) => {
        const body = (x === 1 || y === 1);
        if (z >= 6) return z === 6 && body ? 2 : (z === 7 && x === 1 && y === 1 ? 2 : 0);
        const fin = z <= 1 && (x === 0 || x === 2) && y === 1;
        if (fin) return 3;
        return body ? 1 : 0;
      }).data,
    },
  ],
  anchors: {},
};

// --- First-person arms: two forearm+hand columns straddling the grip; skin hands (+Z front), orange sleeves behind. Palette matches character.js. ---
const skinTone = { color: "#c9986b", roughness: 0.9, metalness: 0.0 };
const sleeve = { color: "#d6702a", roughness: 0.9, metalness: 0.0 };
const AR_SX = 9, AR_SY = 3, AR_SZ = 9;
const arms = {
  name: "arms",
  voxelSize: 0.05,
  palette: [skinTone, sleeve],
  parts: [
    {
      name: "main",
      size: [AR_SX, AR_SY, AR_SZ],
      originOffset: [0, 0, 0],
      pivot: [0, 0, 0],
      data: vol(AR_SX, AR_SY, AR_SZ, (x, y, z) => {
        const leftArm = x >= 1 && x <= 2;
        const rightArm = x >= 6 && x <= 7;
        if (!(leftArm || rightArm)) return 0;
        return z >= 6 ? 1 : 2; // skin hand at the front, orange sleeve trailing back
      }).data,
    },
  ],
  anchors: {},
};

export default { sledgehammer, c4, shotgun, rocketLauncher, rocket, arms };
