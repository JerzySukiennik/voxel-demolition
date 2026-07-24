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

// ============================ Phase 7 batch B held-models (Grab & Force) ======================
// Shared visual language: a compact "device with a business-end emitter" running +Z, a grip below.
const lightBlue = { color: "#7fb4d8", roughness: 0.5, metalness: 0.1 };
const purple = { color: "#7a5bd0", roughness: 0.45, metalness: 0.15 };

// --- 5a. Gravity Gun: dark body, glowing purple core, splayed claw prongs at the mouth (HL-ish) ---
const GGX = 6, GGY = 9, GGZ = 18;
const gravitygun = {
  name: "gravitygun", voxelSize: 0.055, palette: [darkSteel, purple, steel],
  parts: [{
    name: "main", size: [GGX, GGY, GGZ], originOffset: [0, 0, 0],
    pivot: [GGX * 0.055 / 2, 2 * 0.055, 6 * 0.055],
    data: vol(GGX, GGY, GGZ, (x, y, z) => {
      const cx = 2.5, cy = 4.5;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      // main body block
      if (z >= 3 && z <= 12 && r2 <= 2.6 * 2.6) return (r2 >= 2.0 * 2.0 ? 3 : 1);
      // glowing core in the mouth
      if (z >= 12 && z <= 14 && r2 <= 1.2 * 1.2) return 2;
      // four splayed claw prongs reaching forward from the corners
      if (z >= 12 && z <= 17) {
        if ((x === 0 || x === GGX - 1) && (y === 2 || y === 6)) return 1;
        if ((y === 1 || y === GGY - 1) && (x === 1 || x === 4)) return 1;
      }
      // grip
      if ((x === 2 || x === 3) && y <= 1 && z >= 4 && z <= 7) return 3;
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 5b. Magnet Gun: steel body + a red horseshoe magnet (two prongs, gap) with steel tips at the front ---
const MGX = 6, MGY = 9, MGZ = 16;
const magnetgun = {
  name: "magnetgun", voxelSize: 0.055, palette: [steel, red, darkSteel],
  parts: [{
    name: "main", size: [MGX, MGY, MGZ], originOffset: [0, 0, 0],
    pivot: [MGX * 0.055 / 2, 2 * 0.055, 6 * 0.055],
    data: vol(MGX, MGY, MGZ, (x, y, z) => {
      const cx = 2.5, cy = 4.5;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      // body
      if (z >= 3 && z <= 9 && r2 <= 2.4 * 2.4) return 1;
      // horseshoe: two red prongs (upper + lower) with a gap, tips capped steel
      if (z >= 9 && z <= 15) {
        const upper = (y >= 6 && y <= 7) && x >= 1 && x <= 4;
        const lower = (y >= 1 && y <= 2) && x >= 1 && x <= 4;
        if (upper || lower) return (z >= 14 ? 1 : 2);
        // yoke joining the prongs at the base
        if (z === 9 && y >= 1 && y <= 7 && (x === 1 || x === 4)) return 2;
      }
      // grip
      if ((x === 2 || x === 3) && y <= 0 && z >= 4 && z <= 7) return 3;
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 5c. Grapple Hook: dark launcher tube +Z with a steel harpoon point out front, reel drum below ---
const GPX = 5, GPY = 9, GPZ = 20;
const grapplegun = {
  name: "grapplegun", voxelSize: 0.055, palette: [darkSteel, steel, gray],
  parts: [{
    name: "main", size: [GPX, GPY, GPZ], originOffset: [0, 0, 0],
    pivot: [GPX * 0.055 / 2, 3 * 0.055, 6 * 0.055],
    data: vol(GPX, GPY, GPZ, (x, y, z) => {
      const cx = 2, cy = 5;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      // launcher tube (upper), hollow muzzle at the front
      if (z >= 5 && z <= 15 && r2 <= 2.1 * 2.1) return (z >= 13 && r2 >= 1.1 * 1.1 ? 1 : (z >= 13 ? 0 : 1));
      // harpoon point sticking out the front, tapering to a tip
      if (z >= 15 && z <= 18 && y === 5) { const w = 18 - z; if (Math.abs(x - cx) <= w) return 2; }
      if (z === 15 && y >= 4 && y <= 6 && x === cx) return 2; // barb base
      // reel drum below/behind the tube
      const dcx = 2, dcy = 2.5;
      const dr2 = (x - dcx) * (x - dcx) + (y - dcy) * (y - dcy);
      if (z >= 4 && z <= 9 && dr2 <= 2.2 * 2.2) return 3;
      // grip
      if ((x === 1 || x === 3) && y <= 1 && z >= 3 && z <= 5) return 1;
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 5d. Wind Cannon: gray body flaring into a wide light-blue funnel mouth at the front ---
const WCX = 8, WCY = 8, WCZ = 17;
const windcannon = {
  name: "windcannon", voxelSize: 0.055, palette: [gray, lightBlue, darkSteel],
  parts: [{
    name: "main", size: [WCX, WCY, WCZ], originOffset: [0, 0, 0],
    pivot: [WCX * 0.055 / 2, 2 * 0.055, 6 * 0.055],
    data: vol(WCX, WCY, WCZ, (x, y, z) => {
      const cx = 3.5, cy = 3.5;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      // narrow body at the back
      if (z >= 2 && z <= 9 && r2 <= 2.0 * 2.0) return 1;
      // flaring funnel: radius grows toward the front, hollow bore
      if (z >= 9) {
        const rad = 2.0 + (z - 9) * 0.35;
        if (r2 <= rad * rad) return (r2 >= (rad - 1.0) * (rad - 1.0) ? 2 : 0);
      }
      // breech ring
      if (z <= 1 && r2 <= 2.0 * 2.0) return 3;
      // grip
      if ((x === 3 || x === 4) && y <= 0 && z >= 4 && z <= 7) return 3;
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 5e. Debris Vacuum: gray canister with an orange nozzle tapering at the front, grip below ---
const VCX = 6, VCY = 9, VCZ = 18;
const vacuum = {
  name: "vacuum", voxelSize: 0.055, palette: [gray, orange, darkSteel],
  parts: [{
    name: "main", size: [VCX, VCY, VCZ], originOffset: [0, 0, 0],
    pivot: [VCX * 0.055 / 2, 2 * 0.055, 6 * 0.055],
    data: vol(VCX, VCY, VCZ, (x, y, z) => {
      const cx = 2.5, cy = 4.5;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      // fat canister body at the back
      if (z >= 2 && z <= 10 && r2 <= 2.7 * 2.7) return (r2 >= 2.1 * 2.1 ? 3 : 1);
      // nozzle: radius shrinks toward the front, hollow intake
      if (z >= 10) {
        const rad = 2.4 - (z - 10) * 0.22;
        if (r2 <= rad * rad) return (r2 >= (rad - 0.9) * (rad - 0.9) ? 2 : 0);
      }
      // grip
      if ((x === 2 || x === 3) && y <= 0 && z >= 4 && z <= 7) return 3;
      return 0;
    }).data,
  }],
  anchors: {},
};

// ============================ Phase 7 batch C held-models (Strikes + heavy ordnance) ==========
// Strikes (orbital + airstrike) share a "handheld designator" language; the others are distinct silhouettes.
const yellow = { color: "#e8c020", roughness: 0.6, metalness: 0.1 };
const white = { color: "#e9e9e2", roughness: 0.7, metalness: 0.0 };
const green = { color: "#3f8a3a", roughness: 0.6, metalness: 0.05 };
const propRed = { color: "#c0332a", roughness: 0.55, metalness: 0.1 };

// --- 2d. Blast Painter: gray spray-gun body +Z, orange paint canister on top, dark nozzle at the front ---
const BPX = 6, BPY = 10, BPZ = 16;
const blastpainter = {
  name: "blastpainter", voxelSize: 0.05, palette: [gray, orange, darkSteel],
  parts: [{
    name: "main", size: [BPX, BPY, BPZ], originOffset: [0, 0, 0],
    pivot: [BPX * 0.05 / 2, 2 * 0.05, 6 * 0.05],
    data: vol(BPX, BPY, BPZ, (x, y, z) => {
      const cx = 2.5, cy = 3.5;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      // spray-gun barrel body
      if (z >= 3 && z <= 12 && r2 <= 2.3 * 2.3) return 1;
      // dark nozzle ring at the muzzle
      if (z >= 12 && r2 <= 2.3 * 2.3) return r2 >= 1.1 * 1.1 ? 3 : 0;
      // orange paint canister sitting on top
      const dcx = 2.5, dcy = 7;
      const dr2 = (x - dcx) * (x - dcx) + (y - dcy) * (y - dcy);
      if (z >= 4 && z <= 9 && dr2 <= 2.1 * 2.1) return 2;
      // grip
      if ((x === 2 || x === 3) && y <= 1 && z >= 3 && z <= 6) return 3;
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 2e. Propane (held deploy device): compact red canister with a dark valve cap on top ---
const PPX = 5, PPY = 9, PPZ = 8;
const propane = {
  name: "propane", voxelSize: 0.05, palette: [propRed, darkSteel, steel],
  parts: [{
    name: "main", size: [PPX, PPY, PPZ], originOffset: [0, 0, 0],
    pivot: [PPX * 0.05 / 2, 2 * 0.05, PPZ * 0.05 / 2],
    data: vol(PPX, PPY, PPZ, (x, y, z) => {
      const cx = 2, cz = 3.5;
      const r2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      if (y >= 1 && y <= 6 && r2 <= 2.1 * 2.1) return 1;   // upright cylinder body
      if (y === 0 && r2 <= 2.1 * 2.1) return 2;            // base
      if (y >= 7 && x >= 1 && x <= 3 && z >= 2 && z <= 5) return 2; // valve block
      if (y === 8 && x === 2 && z >= 3 && z <= 4) return 3;         // valve nub
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- Propane tank (thrown world mesh): larger red cylinder lying along +Z with dark caps + valve ---
const PTX = 6, PTY = 6, PTZ = 11;
const propanetank = {
  name: "propanetank", voxelSize: 0.075, palette: [propRed, darkSteel, steel],
  parts: [{
    name: "main", size: [PTX, PTY, PTZ], originOffset: [0, 0, 0],
    pivot: [PTX * 0.075 / 2, PTY * 0.075 / 2, PTZ * 0.075 / 2],
    data: vol(PTX, PTY, PTZ, (x, y, z) => {
      const cx = 2.5, cy = 2.5;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (r2 > 2.7 * 2.7) {
        // valve collar sticking out the top at the front cap
        if (z >= PTZ - 2 && y >= 4 && x >= 2 && x <= 3) return 3;
        return 0;
      }
      if (z === 0 || z === PTZ - 1) return 2; // dark end caps
      return 1;                                // red body
    }).data,
  }],
  anchors: {},
};

// --- 6c. Nuke: chunky dark briefcase device with yellow hazard stripes and a red arm button on top ---
const NKX = 9, NKY = 7, NKZ = 12;
const nuke = {
  name: "nuke", voxelSize: 0.05, palette: [darkSteel, yellow, red, steel],
  parts: [{
    name: "main", size: [NKX, NKY, NKZ], originOffset: [0, 0, 0],
    pivot: [NKX * 0.05 / 2, 1 * 0.05, NKZ * 0.05 / 2],
    data: vol(NKX, NKY, NKZ, (x, y, z) => {
      // solid case body
      if (y <= 4) {
        const edge = x === 0 || x === NKX - 1 || z === 0 || z === NKZ - 1 || y === 0;
        // yellow hazard stripes along the sides
        if ((x === 0 || x === NKX - 1) && (z % 3 === 0)) return 2;
        return edge ? 4 : 1;
      }
      // raised top plate + red arm button
      if (y === 5 && x >= 1 && x <= NKX - 2 && z >= 1 && z <= NKZ - 2) return 4;
      if (y === 6 && x >= 3 && x <= 5 && z >= 5 && z <= 7) return 3; // arm button
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 6b. Orbital Laser Designator: dark handheld unit +Z with a glowing lens eye and a top antenna ---
const OLX = 5, OLY = 9, OLZ = 18;
const orbital = {
  name: "orbital", voxelSize: 0.05, palette: [darkSteel, lightBlue, steel, red],
  parts: [{
    name: "main", size: [OLX, OLY, OLZ], originOffset: [0, 0, 0],
    pivot: [OLX * 0.05 / 2, 2 * 0.05, 6 * 0.05],
    data: vol(OLX, OLY, OLZ, (x, y, z) => {
      const cx = 2, cy = 4.5;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      // designator barrel
      if (z >= 3 && z <= 14 && r2 <= 2.0 * 2.0) return (r2 >= 1.5 * 1.5 ? 3 : 1);
      // glowing lens eye at the front
      if (z >= 14 && z <= 16 && r2 <= 1.3 * 1.3) return 2;
      // top antenna
      if (y >= 7 && y <= 8 && x === 2 && z >= 5 && z <= 6) return 3;
      // grip
      if ((x === 1 || x === 3) && y <= 1 && z >= 4 && z <= 7) return 1;
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 6a. Airstrike Designator: olive handheld unit +Z with a small dish + amber lens (designator family) ---
const ASX = 5, ASY = 9, ASZ = 18;
const airstrike = {
  name: "airstrike", voxelSize: 0.05, palette: [olive, yellow, darkSteel, oliveDark],
  parts: [{
    name: "main", size: [ASX, ASY, ASZ], originOffset: [0, 0, 0],
    pivot: [ASX * 0.05 / 2, 2 * 0.05, 6 * 0.05],
    data: vol(ASX, ASY, ASZ, (x, y, z) => {
      const cx = 2, cy = 4.5;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      // designator barrel
      if (z >= 3 && z <= 14 && r2 <= 2.0 * 2.0) return (r2 >= 1.5 * 1.5 ? 4 : 1);
      // amber lens at the front
      if (z >= 14 && z <= 16 && r2 <= 1.3 * 1.3) return 2;
      // small dish/screen on top
      if (y >= 7 && y <= 8 && x >= 1 && x <= 3 && z >= 4 && z <= 7) return 3;
      // grip
      if ((x === 1 || x === 3) && y <= 1 && z >= 4 && z <= 7) return 1;
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 4d. Car Cannon: absurd wide-bore cannon +Z, olive body with a huge dark muzzle ring + under-grip ---
const CCX = 9, CCY = 9, CCZ = 20;
const carcannon = {
  name: "carcannon", voxelSize: 0.06, palette: [olive, darkSteel, gray],
  parts: [{
    name: "main", size: [CCX, CCY, CCZ], originOffset: [0, 0, 0],
    pivot: [CCX * 0.06 / 2, 2 * 0.06, 6 * 0.06],
    data: vol(CCX, CCY, CCZ, (x, y, z) => {
      const cx = 4, cy = 4.5;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      const wide = 4.2 * 4.2, bore = 3.0 * 3.0;
      // fat cannon tube
      if (z >= 4 && z <= 15 && r2 <= wide) return 1;
      // huge dark muzzle ring, big hollow bore
      if (z >= 15 && r2 <= wide) return r2 >= bore ? 2 : 0;
      // breech cap
      if (z <= 3 && r2 <= wide) return 2;
      // under-grip
      if ((x === 3 || x === 5) && y <= 1 && z >= 6 && z <= 9) return 3;
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 2f. RC Car Bomb (deployer handset): flat dark handset with a green screen and twin antennas ---
const RCX = 8, RCY = 3, RCZ = 10;
const rccar = {
  name: "rccar", voxelSize: 0.05, palette: [darkSteel, green, gray, steel],
  parts: [{
    name: "main", size: [RCX, RCY, RCZ], originOffset: [0, 0, 0],
    pivot: [RCX * 0.05 / 2, 1 * 0.05, RCZ * 0.05 / 2],
    data: vol(RCX, RCY, RCZ, (x, y, z) => {
      // flat handset slab
      if (y <= 1 && x >= 0 && x <= RCX - 1 && z >= 0 && z <= RCZ - 1) {
        if (y === 1 && x >= 2 && x <= 5 && z >= 3 && z <= 6) return 2; // green screen
        return (x === 0 || x === RCX - 1 || z === 0 || z === RCZ - 1) ? 3 : 1;
      }
      // control sticks
      if (y === 2 && (x === 1 || x === 6) && z >= 2 && z <= 3) return 4;
      // twin antennas rising at the back
      if (y === 2 && (x === 1 || x === 6) && z === RCZ - 1) return 3;
      return 0;
    }).data,
  }],
  anchors: {},
};

// ============================ Phase 7 batch D held-models (Builders) ==========================
// Shared "device with a business-end emitter" language (like Grab & Force), but a constructive read:
// pale/white foam tank, a green constructor emitter, a purple sci-fi ray gun.

// --- 7a. Foam Cannon: white pressure tank at the back, wide light-blue funnel nozzle at the front ---
const FCX = 8, FCY = 9, FCZ = 18;
const foamcannon = {
  name: "foamcannon", voxelSize: 0.055, palette: [white, lightBlue, gray],
  parts: [{
    name: "main", size: [FCX, FCY, FCZ], originOffset: [0, 0, 0],
    pivot: [FCX * 0.055 / 2, 2 * 0.055, 6 * 0.055],
    data: vol(FCX, FCY, FCZ, (x, y, z) => {
      const cx = 3.5, cy = 4;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      // fat white tank body at the back
      if (z >= 2 && z <= 9 && r2 <= 3.0 * 3.0) return 1;
      // flaring funnel nozzle: radius grows toward the front, hollow bore
      if (z >= 9) {
        const rad = 2.2 + (z - 9) * 0.32;
        if (r2 <= rad * rad) return (r2 >= (rad - 1.0) * (rad - 1.0) ? 2 : 0);
      }
      // gray breech cap
      if (z <= 1 && r2 <= 3.0 * 3.0) return 3;
      // grip
      if ((x === 3 || x === 4) && y <= 0 && z >= 4 && z <= 7) return 3;
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 7b. Rebuild Gun: gray body, glowing green core, an open steel constructor frame at the muzzle ---
const RBX = 6, RBY = 9, RBZ = 18;
const rebuildgun = {
  name: "rebuildgun", voxelSize: 0.055, palette: [gray, green, steel],
  parts: [{
    name: "main", size: [RBX, RBY, RBZ], originOffset: [0, 0, 0],
    pivot: [RBX * 0.055 / 2, 2 * 0.055, 6 * 0.055],
    data: vol(RBX, RBY, RBZ, (x, y, z) => {
      const cx = 2.5, cy = 4.5;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      // main body block
      if (z >= 3 && z <= 11 && r2 <= 2.5 * 2.5) return (r2 >= 1.9 * 1.9 ? 1 : 2); // green glowing core inside
      // open constructor frame at the muzzle: a square outline of steel prongs (inverse-of-destruction read)
      if (z >= 12 && z <= 16) {
        const edge = (x === 0 || x === RBX - 1 || y === 1 || y === RBY - 1);
        const corner = (x === 0 || x === RBX - 1) || (y === 1 || y === RBY - 1);
        if (edge && corner && (z === 12 || z === 16 || x === 0 || x === RBX - 1 || y === 1 || y === RBY - 1)) return 3;
      }
      // grip
      if ((x === 2 || x === 3) && y <= 1 && z >= 4 && z <= 7) return 3;
      return 0;
    }).data,
  }],
  anchors: {},
};

// --- 7c. Size Ray: dark sci-fi ray gun +Z, purple emitter lens, a yellow calibration dial on top ---
const SZX = 5, SZY = 9, SZZ = 16;
const sizeray = {
  name: "sizeray", voxelSize: 0.055, palette: [darkSteel, purple, yellow],
  parts: [{
    name: "main", size: [SZX, SZY, SZZ], originOffset: [0, 0, 0],
    pivot: [SZX * 0.055 / 2, 2 * 0.055, 6 * 0.055],
    data: vol(SZX, SZY, SZZ, (x, y, z) => {
      const cx = 2, cy = 4.5;
      const r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      // ray-gun barrel
      if (z >= 3 && z <= 12 && r2 <= 2.0 * 2.0) return (r2 >= 1.4 * 1.4 ? 1 : 2); // glowing purple emitter core
      // purple lens ring at the muzzle
      if (z >= 12 && z <= 14 && r2 <= 1.6 * 1.6) return 2;
      // yellow calibration dial on top
      if (y >= 7 && y <= 8 && x >= 1 && x <= 3 && z >= 5 && z <= 7) return 3;
      // grip
      if ((x === 1 || x === 3) && y <= 1 && z >= 4 && z <= 7) return 1;
      return 0;
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
  // Phase 7 batch B (Grab & Force)
  gravitygun, magnetgun, grapplegun, windcannon, vacuum,
  // Phase 7 batch C (Strikes + heavy/vehicular ordnance)
  blastpainter, propane, propanetank, nuke, orbital, airstrike, carcannon, rccar,
  // Phase 7 batch D (Builders)
  foamcannon, rebuildgun, sizeray,
};
