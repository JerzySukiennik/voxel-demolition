// remotes.js - visual-only remote players (brief section 6). Per remote pid: a shared avatar group,
// a nametag sprite, a held-tool mesh, and a 100 ms interpolation buffer for position/orientation.
// NO physics body (player-vs-player collision is disabled everywhere). Seated remotes are posed on the
// interpolated vehicle. Everything here is presentation; authority lives on the server.
import * as THREE from "three";
import { CONFIG } from "../config.js";
import { buildCharacterGroup, buildAvatarModel, sanitizeAvatar } from "../avatar.js";
import { decodeModel, meshModelPart } from "../voxel.js";
import { RATES } from "./protocol.js";
import toolModels from "../../assets/models/tools.js";

const P = CONFIG.player;
const INTERP = RATES.interpMs / 1000; // seconds of buffered delay
const NAMETAG_Y = 2.05;               // metres above feet
const TOOL_IDS = ["sledgehammer", "c4", "shotgun", "rocketLauncher"];
const FWD_Z = new THREE.Vector3(0, 0, 1);
// Grapple rope for a remote player: ONE stretched box per remote, not a segment strip. A rope drawn from a
// hand to an anchor is a straight line, and at 4 players the segmented version would spend 48 draw calls on
// something nobody is looking at (the render gate is < 300 for the whole frame).
const ROPE_HAND_Y = 1.35;             // metres above feet: roughly where a held tool's muzzle sits

// Angle-aware lerp (shortest arc), radians.
function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class RemotePlayers {
  constructor(scene, materials, { fogFar = 120, getVehicle = () => null } = {}) {
    this.scene = scene;
    this.materials = materials;
    this.fogFar = fogFar;
    this.getVehicle = getVehicle;         // (vid) -> vehicle-like { centerWorld(), quaternion(), seatAnchor() } | null
    this.remotes = new Map();             // pid -> remote record

    // Pre-decode held-tool geometries ONCE (shared across all remotes; meshes are cheap wrappers).
    this._toolGeo = {};
    for (const id of TOOL_IDS) {
      const model = toolModels[id];
      if (!model) continue;
      const dec = decodeModel(model);
      const geo = meshModelPart(dec, "main");
      const piv = model.parts[0].pivot;
      geo.translate(-piv[0], -piv[1], -piv[2]);
      this._toolGeo[id] = geo;
    }
  }

  has(pid) { return this.remotes.has(pid); }

  add(pid, nick, avatar) {
    if (this.remotes.has(pid)) return;
    const model = buildAvatarModel(sanitizeAvatar(avatar));
    const group = buildCharacterGroup(model, this.materials);
    const parts = group.userData.parts;
    const decoded = group.userData.decoded;
    // Remote heads + arms stay visible (unlike the local first-person player).
    if (parts.head) parts.head.visible = true;
    // Hidden until the first interpolation sample lands: a freshly added remote sits at the world
    // origin, which on every map is inside the playfield — a body standing in the middle of the map is
    // worse than no body at all. pstate runs at 20 Hz for every connected player, so this is ~1 frame.
    group.visible = false;
    this.scene.add(group);

    // Held-tool holder parented at the right arm (coarse placement in the hand region).
    const toolHolder = new THREE.Group();
    toolHolder.position.set(0, -0.42, 0.12);
    toolHolder.rotation.y = Math.PI; // model +Z forward -> point away from the body front
    if (parts.armR) parts.armR.add(toolHolder);
    else group.add(toolHolder);
    const toolMeshes = {};
    for (const id of TOOL_IDS) {
      if (!this._toolGeo[id]) continue;
      const m = new THREE.Mesh(this._toolGeo[id], this.materials);
      m.castShadow = false; m.receiveShadow = false;
      m.visible = false;
      toolHolder.add(m);
      toolMeshes[id] = m;
    }

    const nametag = this._makeNametag(nick);
    nametag.visible = false;
    this.scene.add(nametag);

    // Grapple rope (shared geometry + material across every remote; one mesh each).
    if (!this._ropeGeo) {
      this._ropeGeo = new THREE.BoxGeometry(1, 1, 1);
      this._ropeMat = new THREE.MeshBasicMaterial({ color: 0x23262b });
    }
    const rope = new THREE.Mesh(this._ropeGeo, this._ropeMat);
    rope.castShadow = false; rope.receiveShadow = false; rope.visible = false;
    this.scene.add(rope);

    this.remotes.set(pid, {
      pid, nick, group, parts, decoded, toolHolder, toolMeshes, nametag, rope,
      buf: [],            // interpolation samples { t, p:[x,y,z], yaw, pitch }
      seat: null, tool: null, act: null,
      phase: 0, lastFeet: null,
    });
  }

  remove(pid) {
    const r = this.remotes.get(pid);
    if (!r) return;
    this.scene.remove(r.group);
    this.scene.remove(r.nametag);
    if (r.rope) this.scene.remove(r.rope); // geometry + material are shared: never disposed here
    // Per-part avatar geometries are unique to this remote (meshModelPart allocates fresh); dispose them.
    // Held-tool meshes share this._toolGeo, so skip those.
    for (const name of Object.keys(r.parts)) {
      const g = r.parts[name].geometry;
      if (g && g.dispose) g.dispose();
    }
    if (r.nametag.material.map) r.nametag.material.map.dispose();
    r.nametag.material.dispose();
    this.remotes.delete(pid);
  }

  clear() {
    for (const pid of [...this.remotes.keys()]) this.remove(pid);
  }

  // From a pstate broadcast (already excludes the recipient). Each entry: {pid,p,yaw,pitch,v,tool,seat}.
  onState(players) {
    const now = performance.now() / 1000;
    for (const s of players || []) {
      const r = this.remotes.get(s.pid);
      if (!r) continue;
      r.buf.push({ t: now, p: s.p, yaw: s.yaw || 0, pitch: s.pitch || 0 });
      // Keep a little history past the interp window; drop the rest.
      while (r.buf.length > 2 && r.buf[1].t < now - INTERP - 0.5) r.buf.shift();
      r.seat = (s.seat === null || s.seat === undefined) ? null : s.seat;
      r.tool = s.tool || null;
      // Phase 8: the sender's live Grab & Force intent. Only the grapple kinds carry an anchor, and that
      // anchor is the only thing this class does anything with — everything else those tools do is
      // physics, and physics belongs to the server.
      r.act = s.act || null;
    }
  }

  // Just this remote's seat (from a seat message; pstate also carries it, this is the authoritative push).
  setSeat(pid, vid) {
    const r = this.remotes.get(pid);
    if (r) r.seat = (vid === 0 || vid === null || vid === undefined) ? null : vid;
  }

  update(dt, camera) {
    const renderT = performance.now() / 1000 - INTERP;
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    for (const r of this.remotes.values()) {
      this._updateOne(r, dt, renderT, camPos);
    }
  }

  _updateOne(r, dt, renderT, camPos) {
    const sample = this._sampleBuffer(r.buf, renderT);
    let feet = null;
    if (r.seat != null) {
      // Seated: pose on the interpolated vehicle transform.
      const veh = this.getVehicle(r.seat);
      if (veh) {
        this._poseAtSeat(r, veh.centerWorld(), veh.quaternion(), veh.seatAnchor());
        feet = r.group.position.clone();
        this._setSeatedLimbs(r);
      } else if (sample) {
        // Vehicle not present yet: fall back to standing at last known position.
        feet = new THREE.Vector3(sample.p[0], sample.p[1], sample.p[2]);
        r.group.position.copy(feet);
        r.group.rotation.set(0, sample.yaw, 0);
      }
    } else if (sample) {
      feet = new THREE.Vector3(sample.p[0], sample.p[1], sample.p[2]);
      r.group.position.copy(feet);
      r.group.rotation.set(0, sample.yaw, 0);
      this._walkLimbs(r, feet, dt);
    }
    if (!feet) { r.group.visible = false; r.nametag.visible = false; if (r.rope) r.rope.visible = false; return; }
    r.group.visible = true;
    this._updateRope(r, feet);

    // Tool visibility: show the current held tool, hide the rest.
    for (const id of TOOL_IDS) {
      const m = r.toolMeshes[id];
      if (m) m.visible = (id === r.tool) && r.seat == null;
    }

    // Nametag: hover above the feet, always face the camera (Sprite does), hide past fog far.
    r.nametag.position.set(feet.x, feet.y + NAMETAG_Y, feet.z);
    const dist = camPos.distanceTo(r.nametag.position);
    r.nametag.visible = dist < this.fogFar;
  }

  // Grapple rope: one stretched box from this remote's hand (or the vehicle they are driving) to the
  // anchor the server relayed. Purely presentational — the swing itself is the remote's own predicted
  // movement and already arrives as ordinary position samples.
  _updateRope(r, feet) {
    const rope = r.rope;
    if (!rope) return;
    const act = r.act;
    if (!act || !act.a || (act.k !== "grap" && act.k !== "vrope")) { rope.visible = false; return; }
    const to = new THREE.Vector3(act.a[0], act.a[1], act.a[2]);
    const from = act.k === "vrope"
      ? (this.getVehicle(r.seat) ? this.getVehicle(r.seat).centerWorld() : new THREE.Vector3(feet.x, feet.y + ROPE_HAND_Y, feet.z))
      : new THREE.Vector3(feet.x, feet.y + ROPE_HAND_Y, feet.z);
    const ab = to.clone().sub(from);
    const len = ab.length();
    if (len < 1e-3) { rope.visible = false; return; }
    rope.position.copy(from).add(to).multiplyScalar(0.5);
    rope.quaternion.setFromUnitVectors(FWD_Z, ab.multiplyScalar(1 / len));
    rope.scale.set(CONFIG.weapons.grapple.thickness, CONFIG.weapons.grapple.thickness, len);
    rope.visible = true;
  }

  // Interpolate p/yaw/pitch at renderT from the sample buffer. Clamp to endpoints outside the window.
  _sampleBuffer(buf, renderT) {
    if (buf.length === 0) return null;
    if (buf.length === 1 || renderT <= buf[0].t) {
      const s = buf[0];
      return { p: s.p, yaw: s.yaw, pitch: s.pitch };
    }
    const last = buf[buf.length - 1];
    if (renderT >= last.t) return { p: last.p, yaw: last.yaw, pitch: last.pitch };
    for (let i = 0; i < buf.length - 1; i++) {
      const a = buf[i], b = buf[i + 1];
      if (renderT >= a.t && renderT <= b.t) {
        const span = b.t - a.t;
        const u = span > 1e-6 ? (renderT - a.t) / span : 0;
        return {
          p: [a.p[0] + (b.p[0] - a.p[0]) * u, a.p[1] + (b.p[1] - a.p[1]) * u, a.p[2] + (b.p[2] - a.p[2]) * u],
          yaw: lerpAngle(a.yaw, b.yaw, u),
          pitch: a.pitch + (b.pitch - a.pitch) * u,
        };
      }
    }
    return { p: last.p, yaw: last.yaw, pitch: last.pitch };
  }

  // Walking limb swing driven by interpolated horizontal speed (position delta / dt).
  _walkLimbs(r, feet, dt) {
    let hspeed = 0;
    if (r.lastFeet) {
      const dx = feet.x - r.lastFeet.x, dz = feet.z - r.lastFeet.z;
      hspeed = dt > 1e-4 ? Math.hypot(dx, dz) / dt : 0;
    }
    r.lastFeet = feet.clone();
    if (hspeed > 0.2) r.phase += dt * P.limbSwingSpeed * (1 + hspeed);
    const amp = Math.min(1, hspeed / P.walkSpeed) * P.limbSwingGain;
    const s = Math.sin(r.phase) * amp;
    const p = r.parts;
    if (p.armL) p.armL.rotation.x = s;
    if (p.armR) p.armR.rotation.x = -s;
    if (p.legL) p.legL.rotation.x = -s;
    if (p.legR) p.legR.rotation.x = s;
  }

  _setSeatedLimbs(r) {
    const p = r.parts;
    for (const k of ["legL", "legR"]) if (p[k]) p[k].rotation.x = -Math.PI / 2;
    for (const k of ["armL", "armR"]) if (p[k]) p[k].rotation.x = -0.6;
  }

  // Mirror of Player.poseAtSeat: land the hips (torso pivot) on the seat anchor of the given vehicle.
  _poseAtSeat(r, carPos, carQuat, seatAnchor) {
    const hipY = r.decoded.parts.torso ? r.decoded.parts.torso.pivot[1] : 0.84;
    const off = new THREE.Vector3(seatAnchor[0], seatAnchor[1] - hipY, seatAnchor[2]);
    const world = off.applyQuaternion(carQuat).add(carPos);
    r.group.position.copy(world);
    r.group.quaternion.copy(carQuat);
  }

  // 256x64 canvas -> CanvasTexture -> Sprite. Redrawn only on creation (nicks are immutable per pid).
  _makeNametag(nick) {
    const cv = document.createElement("canvas");
    cv.width = 256; cv.height = 64;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = "600 30px -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const text = String(nick || "Player").slice(0, 16);
    // Soft dark plate behind the text for legibility against any background.
    const w = Math.min(240, ctx.measureText(text).width + 24);
    ctx.fillStyle = "rgba(12,16,22,0.55)";
    this._roundRect(ctx, (256 - w) / 2, 14, w, 36, 8);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, 128, 33);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.4, 0.35, 1); // ~1.4 m wide nametag
    return sprite;
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
