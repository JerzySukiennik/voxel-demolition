// avatar.js - serializable avatar data model, preset tables, sanitize, palette + hair recolor, shared character-group builder
import * as THREE from "three";
import { CONFIG } from "./config.js";
import { decodeModel, meshModelPart } from "./voxel.js";
import characterModel from "../assets/models/character.js";

// Preset color tables (data). Editable slots only: skin/hair/top/bottom/shoes. Pupil, eye white, sole,
// trim and metal are fixed (kept from the base model palette); the skin/hoodie/jeans shades are derived.
// top and bottom share one 16-color grid. Indices from these arrays are what get serialized over the
// network in Phase 6 (a handful of small integers) - appending colors stays backwards compatible.
const SKIN = ["#c9986b", "#8d5524", "#5b3a24", "#e0ac82", "#f1c9a5", "#3a2a20", "#a9714b", "#6f4630", "#edd0b0", "#7d5a3c"];
const HAIR = ["#3b2a1c", "#111111", "#6b4a2b", "#a8662f", "#d9c27a", "#8a8a8a", "#c0392b", "#2bb3a3", "#e8e2d0", "#4b2f6b", "#1f3f7a", "#5a1f1f"];
const TOPBOTTOM = ["#d6702a", "#2e3644", "#c0392b", "#27632a", "#2c3e50", "#8e44ad", "#16a085", "#f1c40f", "#e67e22", "#7f8c8d", "#ecf0f1", "#5a3921", "#1a1a1e", "#b8336a", "#3b6ea5", "#6d7f2f"];
const SHOES = ["#eeeeea", "#1a1a1a", "#c0392b", "#2c3e50", "#27ae60", "#2980b9", "#f39c12", "#8e44ad", "#d94f2b", "#c8b48a", "#5c4033", "#e8e2d0"];

export const AVATAR_PRESETS = { skin: SKIN, hair: HAIR, top: TOPBOTTOM, bottom: TOPBOTTOM, shoes: SHOES };
export const HAIR_VARIANTS = ["short", "buzz", "long"];

// Today's look, exactly: skin #c9986b, hair #3b2a1c, hoodie #d6702a, jeans #2e3644 (navy),
// sneakers #eeeeea. Shades (hoodie/jeans) are derived, not stored. Hair shape = short (base grid).
export const DEFAULT_AVATAR = { v: 1, colors: { skin: 0, hair: 0, top: 0, bottom: 1, shoes: 0 }, hair: "short" };

// --- Head grid + hair variants ---------------------------------------------------------------
// Head part is 10x16x12 (sx=10, sy=16, sz=12), voxel 0.03 m, origin y 1.32 (eye anchor 1.62 -> y10).
// Palette values: 1 skin, 2 hair (buzz-proof scalp cap), 3 pupil, 12 eye white, 13 skin shade, and the
// two shape markers the variants resolve: 10 = long-only drape, 11 = hair volume shaved by the buzz.
// Every variant only ever rewrites 10 and 11, so the face, eyes and scalp cap are always preserved.
const V_SKIN = 1, V_HAIR = 2, V_HAIR_LONG = 10, V_HAIR_VOL = 11;

export function buildHeadData(baseData, variant) {
  const src = baseData instanceof Uint8Array ? baseData : Uint8Array.from(baseData);
  const out = Uint8Array.from(src);
  // long: the drape becomes hair. buzz: the volume layer is shaved back to scalp skin. short: neither.
  const longV = variant === "long" ? V_HAIR : 0;
  const volV = variant === "buzz" ? V_SKIN : V_HAIR;
  for (let i = 0; i < out.length; i++) {
    const v = src[i];
    if (v === V_HAIR_LONG) out[i] = longV;
    else if (v === V_HAIR_VOL) out[i] = volV;
  }
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
  const skinHex = SKIN[c.skin];
  const hairHex = HAIR[c.hair];
  const palette = [
    { ...P[0], color: skinHex },          // 1 skin
    { ...P[1], color: hairHex },          // 2 hair (scalp cap)
    { ...P[2] },                          // 3 pupil (fixed)
    { ...P[3], color: topHex },           // 4 hoodie main
    { ...P[4], color: shadeHex(topHex) }, // 5 hoodie shade
    { ...P[5], color: botHex },           // 6 jeans main
    { ...P[6], color: shadeHex(botHex) }, // 7 jeans shade
    { ...P[7], color: SHOES[c.shoes] },   // 8 sneaker
    { ...P[8] },                          // 9 sole (fixed)
    { ...P[9], color: hairHex },          // 10 hair, long-variant drape
    { ...P[10], color: hairHex },         // 11 hair, buzz-shaved volume
    { ...P[11] },                         // 12 eye white (fixed)
    { ...P[12], color: shadeHex(skinHex) }, // 13 skin shade
    { ...P[13] },                         // 14 trim: drawstrings, laces, midsole (fixed)
    { ...P[14] },                         // 15 metal: eyelets, zip pull (fixed)
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
