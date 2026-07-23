// avatar.js - serializable avatar data model, preset tables, sanitize, palette + hair recolor, shared character-group builder
import * as THREE from "three";
import { CONFIG } from "./config.js";
import { decodeModel, meshModelPart } from "./voxel.js";
import characterModel from "../assets/models/character.js";

// Preset color tables (data). Editable slots only: skin/hair/top/bottom/shoes. Eye + sole are fixed
// (kept from the base model palette). top and bottom share one 12-color grid. Indices from these
// arrays are what get serialized over the network in Phase 6 (a handful of small integers).
const SKIN = ["#c9986b", "#8d5524", "#5b3a24", "#e0ac82", "#f1c9a5", "#3a2a20"];
const HAIR = ["#3b2a1c", "#111111", "#6b4a2b", "#a8662f", "#d9c27a", "#8a8a8a", "#c0392b", "#2bb3a3"];
const TOPBOTTOM = ["#d6702a", "#2e3644", "#c0392b", "#27632a", "#2c3e50", "#8e44ad", "#16a085", "#f1c40f", "#e67e22", "#7f8c8d", "#ecf0f1", "#5a3921"];
const SHOES = ["#eeeeea", "#1a1a1a", "#c0392b", "#2c3e50", "#27ae60", "#2980b9", "#f39c12", "#8e44ad"];

export const AVATAR_PRESETS = { skin: SKIN, hair: HAIR, top: TOPBOTTOM, bottom: TOPBOTTOM, shoes: SHOES };
export const HAIR_VARIANTS = ["short", "buzz", "long"];

// Today's look, exactly: skin #c9986b, hair #3b2a1c, hoodie #d6702a, jeans #2e3644 (navy),
// sneakers #eeeeea. Shades (hoodie/jeans) are derived, not stored. Hair shape = short (base grid).
export const DEFAULT_AVATAR = { v: 1, colors: { skin: 0, hair: 0, top: 0, bottom: 1, shoes: 0 }, hair: "short" };

// --- Head grid + hair variants ---------------------------------------------------------------
// Head part is 5x6x5 (sx=5, sy=6). Index layout matches meshModelPart: data[x + sx*(y + sy*z)].
// Grid y increases upward (y5 = crown, y0 = neck; verified against eye anchor at world y 1.62 -> y3).
// Values: 0 empty, 1 hair, 2 skin, 3 eye. Variants only ever touch values 0/1/2, never eyes.
const HEAD_SX = 5, HEAD_SY = 6, HEAD_SZ = 5;
const headIndex = (x, y, z) => x + HEAD_SX * (y + HEAD_SY * z);

export function buildHeadData(baseData, variant) {
  const src = baseData instanceof Uint8Array ? baseData : Uint8Array.from(baseData);
  const out = Uint8Array.from(src);
  if (variant === "buzz") {
    // Keep only the single topmost hair layer; every lower hair voxel becomes skin -> shaved look.
    let maxHairY = -1;
    for (let z = 0; z < HEAD_SZ; z++)
      for (let y = 0; y < HEAD_SY; y++)
        for (let x = 0; x < HEAD_SX; x++)
          if (src[headIndex(x, y, z)] === 1 && y > maxHairY) maxHairY = y;
    for (let z = 0; z < HEAD_SZ; z++)
      for (let y = 0; y < HEAD_SY; y++)
        for (let x = 0; x < HEAD_SX; x++) {
          const i = headIndex(x, y, z);
          if (src[i] === 1 && y < maxHairY) out[i] = 2;
        }
  } else if (variant === "long") {
    // Drape hair down the back slice (z=0) and both outer x columns to the grid bottom: skin -> hair.
    for (let z = 0; z < HEAD_SZ; z++)
      for (let y = 0; y < HEAD_SY; y++)
        for (let x = 0; x < HEAD_SX; x++) {
          const i = headIndex(x, y, z);
          if (src[i] !== 2) continue; // only skin converts; empties, existing hair and eyes untouched
          if (z === 0 || x === 0 || x === HEAD_SX - 1) out[i] = 1;
        }
  }
  // "short" (and any unknown) returns the base grid unchanged.
  return out;
}

// --- Sanitize --------------------------------------------------------------------------------
// Coerce ANY input (null, string, garbage indices, missing fields) into a valid avatar. Phase 6
// calls this on remote payloads, so it must never throw and must fall back per-field.
export function sanitizeAvatar(obj) {
  const src = obj && typeof obj === "object" ? obj : {};
  const c = src.colors && typeof src.colors === "object" ? src.colors : {};
  const D = DEFAULT_AVATAR;
  const clampIdx = (v, len, def) => (Number.isInteger(v) && v >= 0 && v < len ? v : def);
  return {
    v: 1,
    colors: {
      skin: clampIdx(c.skin, SKIN.length, D.colors.skin),
      hair: clampIdx(c.hair, HAIR.length, D.colors.hair),
      top: clampIdx(c.top, TOPBOTTOM.length, D.colors.top),
      bottom: clampIdx(c.bottom, TOPBOTTOM.length, D.colors.bottom),
      shoes: clampIdx(c.shoes, SHOES.length, D.colors.shoes),
    },
    hair: HAIR_VARIANTS.includes(src.hair) ? src.hair : D.hair,
  };
}

// --- Model assembly --------------------------------------------------------------------------
// Derive a shade color from a main color: main * shadeFactor in linear space, back out to sRGB hex.
function shadeHex(mainHex) {
  return "#" + new THREE.Color().setStyle(mainHex).multiplyScalar(CONFIG.avatar.shadeFactor).getHexString();
}

// Produce a model object with the SAME shape as character.js: base model with its palette swapped
// for the avatar's colors (eye + sole preserved, hoodie/jeans shades derived) and the head part's
// voxel data swapped for the chosen hair variant. Never mutates the imported base model.
export function buildAvatarModel(avatar) {
  const a = sanitizeAvatar(avatar);
  const base = characterModel;
  const P = base.palette;
  const c = a.colors;
  const topHex = TOPBOTTOM[c.top];
  const botHex = TOPBOTTOM[c.bottom];
  const palette = [
    { ...P[0], color: SKIN[c.skin] },   // 1 skin
    { ...P[1], color: HAIR[c.hair] },   // 2 hair
    { ...P[2] },                        // 3 eye (fixed)
    { ...P[3], color: topHex },         // 4 hoodie main
    { ...P[4], color: shadeHex(topHex) }, // 5 hoodie shade
    { ...P[5], color: botHex },         // 6 jeans main
    { ...P[6], color: shadeHex(botHex) }, // 7 jeans shade
    { ...P[7], color: SHOES[c.shoes] }, // 8 sneaker
    { ...P[8] },                        // 9 sole (fixed)
  ];
  const parts = base.parts.map((p) =>
    p.name === "head" ? { ...p, data: buildHeadData(p.data, a.hair) } : p
  );
  return { ...base, palette, parts };
}

// Assemble a decoded character model into a THREE.Group of per-part meshes sharing `materials`.
// Limb parts (arms/legs) get their pivot baked out so rotation.x swings them from the joint.
// Shared by the in-game Player, the lobby preview, and (Phase 6) remote players. The group exposes
// `userData.parts` (name -> mesh) and `userData.decoded` (for anchors/pivots). Head starts visible;
// callers that hide it (first-person Player) toggle it after construction.
export function buildCharacterGroup(model, materials) {
  const decoded = decodeModel(model);
  const group = new THREE.Group();
  const parts = {};
  for (const name of Object.keys(decoded.parts)) {
    const part = decoded.parts[name];
    const geo = meshModelPart(decoded, name);
    const animated = name === "armL" || name === "armR" || name === "legL" || name === "legR";
    let mesh;
    if (animated) {
      const piv = part.pivot;
      geo.translate(-piv[0], -piv[1], -piv[2]);
      mesh = new THREE.Mesh(geo, materials);
      mesh.position.set(piv[0], piv[1], piv[2]);
    } else {
      mesh = new THREE.Mesh(geo, materials);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    parts[name] = mesh;
  }
  group.userData.parts = parts;
  group.userData.decoded = decoded;
  return group;
}
