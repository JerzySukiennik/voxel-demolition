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

// ============================ Phase 7 batch A held-models ====================================
const orange = { color: "#e0731f", roughness: 0.7, metalness: 0.0 };
const orangeDark = { color: "#a8531a", roughness: 0.75, metalness: 0.0 };
const gray = { color: "#7d848b", roughness: 0.5, metalness: 0.2 };

// --- 1b. Crowbar: red curved pry bar running +Z, hooked claw at the front, chisel flare at the back ---
const CBX = 4, CBY = 10, CBZ = 18;
const crowbar = {
  name: "crowbar", voxelSize: 0.05, palette: [red, darkSteel],
  parts: [{
    name: "main", size: [CBX, CBY, CBZ], originOffset: [0, 0, 0],
    pivot: [2 * 0.05, 4 * 0.05, 3 * 0.05],
    data: vol(CBX, CBY, CBZ, (x, y, z) => {
      const bar = (x === 1 || x === 2);
      if (!bar) return 0;
      // straight shaft at mid height
      if (z >= 1 && z <= 12 && (y === 3 || y === 4)) return 1;
      // curved neck rising toward the claw
      if (z === 12 && y >= 3 && y <= 5) return 1;
      if (z === 13 && y >= 4 && y <= 6) return 1;
      if (z === 14 && y >= 6 && y <= 8) return 1;
      // hooked claw tip (dark steel)
      if (z >= 14 && z <= 16 && y === 8) return 2;
      if (z === 16 && y >= 6 && y <= 8) return 2;
      // chisel flare at the back end
      if (z === 0 && y >= 2 && y <= 5) return 1;
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 1c. Chainsaw: orange engine body at the back, long dark bar-blade with teeth running +Z ---
const CSX = 5, CSY = 8, CSZ = 22;
const chainsaw = {
  name: "chainsaw", voxelSize: 0.05, palette: [orange, darkSteel, orangeDark],
  parts: [{
    name: "main", size: [CSX, CSY, CSZ], originOffset: [0, 0, 0],
    pivot: [CSX * 0.05 / 2, 2 * 0.05, 5 * 0.05],
    data: vol(CSX, CSY, CSZ, (x, y, z) => {
      // engine body (orange block) at the back
      if (z <= 7 && y >= 1 && y <= 6 && x >= 0 && x <= 4) return (y === 1 || y === 6 || x === 0 || x === 4) ? 3 : 1;
      // top handle bar
      if (z >= 2 && z <= 6 && y === 7 && (x === 1 || x === 2 || x === 3)) return 3;
      // guide bar (dark, thin, mid height) extending forward
      if (z >= 7 && z <= 20 && y === 3 && (x === 1 || x === 2 || x === 3)) return 2;
      if (z >= 7 && z <= 20 && y === 4 && (x === 1 || x === 2 || x === 3)) return 2;
      // chain teeth: alternating nubs top/bottom of the bar
      if (z >= 8 && z <= 20 && z % 2 === 0 && (y === 2 || y === 5) && x === 2) return 2;
      // rounded nose
      if (z === 21 && (y === 3 || y === 4) && x === 2) return 2;
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 2b. Pipe Bomb (held + thrown): grey pipe body, dark end caps, short red fuse at the top ---
const PBX = 4, PBY = 4, PBZ = 10;
const pipebomb = {
  name: "pipebomb", voxelSize: 0.045, palette: [gray, darkSteel, red],
  parts: [{
    name: "main", size: [PBX, PBY, PBZ], originOffset: [0, 0, 0],
    pivot: [PBX * 0.045 / 2, PBY * 0.045 / 2, PBZ * 0.045 / 2],
    data: vol(PBX, PBY, PBZ, (x, y, z) => {
      const cx = 1.5, cy = 1.5;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      const inPipe = r2 <= 1.7 * 1.7;
      if (z === 0 || z === PBZ - 1) return inPipe ? 2 : 0; // dark end caps
      if (z >= 1 && z <= PBZ - 2 && inPipe) return 1;       // grey body
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 2c. Demolition Wire detonator: red box body with a dark plunger handle rising from the top ---
const DWX = 6, DWY = 8, DWZ = 6;
const demowire = {
  name: "demowire", voxelSize: 0.05, palette: [red, darkSteel, gray],
  parts: [{
    name: "main", size: [DWX, DWY, DWZ], originOffset: [0, 0, 0],
    pivot: [DWX * 0.05 / 2, 0, DWZ * 0.05 / 2],
    data: vol(DWX, DWY, DWZ, (x, y, z) => {
      // detonator box
      if (y <= 3) {
        const edge = x === 0 || x === DWX - 1 || z === 0 || z === DWZ - 1 || y === 0;
        return edge ? 3 : 1;
      }
      // plunger shaft
      if (y >= 4 && y <= 6 && x >= 2 && x <= 3 && z >= 2 && z <= 3) return 2;
      // plunger knob
      if (y === 7 && x >= 1 && x <= 4 && z >= 1 && z <= 4) return 2;
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 4b. Sticky Bomb Launcher: dark tube running +Z with a round drum magazine under the body ---
const SLX = 6, SLY = 9, SLZ = 18;
const stickylauncher = {
  name: "stickylauncher", voxelSize: 0.055, palette: [darkSteel, olive, gray],
  parts: [{
    name: "main", size: [SLX, SLY, SLZ], originOffset: [0, 0, 0],
    pivot: [SLX * 0.055 / 2, 2 * 0.055, 6 * 0.055],
    data: vol(SLX, SLY, SLZ, (x, y, z) => {
      const cx = 2.5, cy = 5.5;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      // barrel tube (upper), hollow muzzle at front
      if (z >= 8) {
        if (r2 <= 2.4 * 2.4) return (z >= 16 && r2 >= 1.3 * 1.3) ? 1 : (z >= 16 ? 0 : 1);
        return 0;
      }
      if (z >= 3 && z <= 8 && r2 <= 2.4 * 2.4) return 1;
      // drum magazine (olive) below/behind
      const dcx = 2.5, dcy = 2.5;
      const dr2 = (x - dcx) * (x - dcx) + (y - dcy) * (y - dcy);
      if (z >= 4 && z <= 9 && dr2 <= 2.3 * 2.3) return 2;
      // grip
      if ((x === 2 || x === 3) && y <= 1 && z >= 2 && z <= 4) return 3;
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 4c. Cluster Bomb Launcher: fat mortar tube running +Z with a wide muzzle and stubby grip ---
const CLX = 8, CLY = 9, CLZ = 18;
const clusterlauncher = {
  name: "clusterlauncher", voxelSize: 0.06, palette: [olive, darkSteel, gray],
  parts: [{
    name: "main", size: [CLX, CLY, CLZ], originOffset: [0, 0, 0],
    pivot: [CLX * 0.06 / 2, 2 * 0.06, 6 * 0.06],
    data: vol(CLX, CLY, CLZ, (x, y, z) => {
      const cx = 3.5, cy = 4.5;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      const wide = 3.6 * 3.6, bore = 2.2 * 2.2;
      // fat tube
      if (z >= 4 && z <= 15 && r2 <= wide) return 1;
      // wide dark muzzle ring, hollow bore
      if (z >= 15 && r2 <= wide) return r2 >= bore ? 2 : 0;
      // breech cap
      if (z <= 3 && r2 <= wide) return 2;
      // grip
      if ((x === 3 || x === 4) && y <= 1 && z >= 5 && z <= 8) return 3;
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- Cluster bomblet / cluster shell projectile: tiny dark voxel ball (shared, scaled per use) ---
const CBB = 3;
const clusterBomb = {
  name: "clusterBomb", voxelSize: 0.06, palette: [darkSteel, red],
  parts: [{
    name: "main", size: [CBB, CBB, CBB], originOffset: [0, 0, 0],
    pivot: [CBB * 0.06 / 2, CBB * 0.06 / 2, CBB * 0.06 / 2],
    data: vol(CBB, CBB, CBB, (x, y, z) => {
      const c = 1;
      const r2 = (x - c) * (x - c) + (y - c) * (y - c) + (z - c) * (z - c);
      if (r2 > 1.6 * 1.6) return 0;
      return (x === c && y === c && z === c) ? 2 : 1; // red core, dark shell
    }).data,
  }],
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

export default {
  sledgehammer, c4, shotgun, rocketLauncher, rocket, arms,
  // Phase 7 batch A
  crowbar, chainsaw, pipebomb, demowire, stickylauncher, clusterlauncher, clusterBomb,
};
