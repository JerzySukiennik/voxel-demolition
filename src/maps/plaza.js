// plaza.js - Phase 1-3 test plaza wrapped as a map module (byte-equivalent regression, ?map=plaza)
import { CONFIG } from "../config.js";
import { groundSpec } from "./lib.js";

const W = CONFIG.world;
const Dn = CONFIG.destruction;

// The three original plaza props (low brick wall, crate pyramid, hollow shed) reproduced verbatim
// from Phase 1 world.js so ?map=plaza behaves exactly as before.
function propSpecs() {
  const vs = 0.15;
  const y0 = W.skinThickness;
  const specs = [];

  {
    const nx = Math.round(6.0 / vs), ny = Math.round(1.2 / vs), nz = Math.round(0.45 / vs);
    const brick = { color: "#9e4b3b", roughness: 0.95, metalness: 0.0 };
    const mortar = { color: "#7f3a2d", roughness: 0.95, metalness: 0.0 };
    specs.push({
      name: "wall", voxelSize: vs, dims: [nx, ny, nz], origin: [-3.0 + 8, y0, -0.225],
      palette: [brick, mortar], fill: (x, y) => ((y % 4 === 0 || x % 8 === 0) ? 2 : 1),
      density: Dn.density.wall, threshold: Dn.forceThreshold.wall, chunkSize: Dn.chunkSizeProp, kind: "single",
      materialClass: "concrete",
    });
  }

  {
    const wood = { color: "#b8894e", roughness: 0.85, metalness: 0.0 };
    const edge = { color: "#8f6a3c", roughness: 0.85, metalness: 0.0 };
    const c = Math.round(0.8 / vs);
    const rows = [{ count: 3, y: 0 }, { count: 2, y: 1 }, { count: 1, y: 2 }];
    for (const row of rows) {
      for (let i = 0; i < row.count; i++) {
        const offset = (i - (row.count - 1) / 2 + (row.y * 0.5)) * 0.85;
        specs.push({
          name: "crate", voxelSize: vs, dims: [c, c, c], origin: [-9 + offset, y0 + row.y * 0.82, -0.4],
          palette: [wood, edge],
          fill: (x, y, z) => {
            const on = (v, m) => v === 0 || v === m - 1;
            let e = 0;
            if (on(x, c)) e++; if (on(y, c)) e++; if (on(z, c)) e++;
            return e >= 2 ? 2 : 1;
          },
          density: Dn.density.crate, threshold: Dn.forceThreshold.crate, chunkSize: 0.42, kind: "single",
          materialClass: "wood",
        });
      }
    }
  }

  {
    const nx = Math.round(3.0 / vs), ny = Math.round(2.5 / vs), nz = Math.round(2.4 / vs);
    const wallC = { color: "#6f7d68", roughness: 0.92, metalness: 0.0 };
    const trim = { color: "#586353", roughness: 0.92, metalness: 0.0 };
    const doorHalf = Math.round(0.5 / vs);
    const doorH = Math.round(1.9 / vs);
    const cx = Math.floor(nx / 2);
    specs.push({
      name: "shed", voxelSize: vs, dims: [nx, ny, nz], origin: [-1.5, y0, 9],
      palette: [wallC, trim],
      fill: (x, y, z) => {
        const shell = x === 0 || x === nx - 1 || z === 0 || z === nz - 1 || y === ny - 1;
        if (!shell) return 0;
        if (z === 0 && Math.abs(x - cx) <= doorHalf && y < doorH) return 0;
        const trimV = y === ny - 1 || y === 0 || x === 0 || x === nx - 1;
        return trimV ? 2 : 1;
      },
      density: Dn.density.shed, threshold: Dn.forceThreshold.shed, chunkSize: Dn.chunkSizeProp, kind: "single",
      materialClass: "wood",
    });
  }
  return specs;
}

export default {
  id: "plaza",
  name: "Test Plaza",
  size: { x: W.plazaSize, z: W.plazaSize },
  spawn: { x: -3, z: -3, yaw: 0 },
  hatchback: { x: 3, z: 3, yaw: 0 },
  env: {},
  water: null,
  volumes: [groundSpec({ x: W.plazaSize, z: W.plazaSize }, W.groundColor, []), ...propSpecs()],
  staticGeo: [],
  decorVehicles: [],
};
