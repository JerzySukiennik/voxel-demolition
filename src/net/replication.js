// replication.js - applies server-authoritative messages to the local (replica) world.
// Owns: destruction detach/debris streams, networked-vehicle spawn/interp/reconcile, seat authority,
// C4/rocket relays, FX relays, reset, and remote-player join/leave/state. main.js wires the handlers
// onto the NetClient and calls preStep(dt) each frame to advance non-driver vehicle interpolation.
import * as THREE from "three";
import { S2C, RATES, RECONCILE } from "./protocol.js";

const INTERP = RATES.interpMs / 1000;

function quatToYaw(q) { return Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] * q[1] + q[2] * q[2])); }

export class Replication {
  constructor({ destruction, manager, remotes, weapons, audio, camera, net, onSeatGrant, onReset }) {
    this.destruction = destruction;
    this.manager = manager;
    this.remotes = remotes;
    this.weapons = weapons;
    this.audio = audio;
    this.camera = camera;
    this.net = net;
    this.onSeatGrant = onSeatGrant || (() => {});
    this.onReset = onReset || (() => {});

    this.drivenVid = null;             // vid this client is currently driving (server-reconciled) or null
    this._vehBuffers = new Map();      // vid -> [{ t, p:[3], q:[4], steer, speed }]
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
  }

  // Register every server->client handler on the NetClient dispatch table.
  register(net) {
    net.on(S2C.JOIN, (m) => this.remotes.add(m.pid, m.nick, m.avatar));
    net.on(S2C.LEAVE, (m) => this._onLeave(m.pid));
    net.on(S2C.PSTATE, (m) => this.remotes.onState(m.players));
    net.on(S2C.VSTATE, (m) => this._onVState(m.vehicles, m.props));
    net.on(S2C.DETACH, (m) => this._onDetach(m.events));
    net.on(S2C.DEBRIS, (m) => this.destruction.applyDebris(m.items));
    net.on(S2C.DEBRIS_RM, (m) => this._onDebrisRemove(m.items));
    net.on(S2C.VEH_SPAWN, (m) => this._onVehSpawn(m));
    net.on(S2C.VEH_RM, (m) => this.manager.removeById(m.vid));
    net.on(S2C.SEAT, (m) => this._onSeat(m));
    net.on(S2C.C4_ADD, (m) => this.weapons.addNetCharge(m.cid4, m.owner, m.p, m.q, m.vid));
    net.on(S2C.C4_BOOM, (m) => this._onC4Boom(m));
    net.on(S2C.ROCKET, (m) => this._onRocket(m));
    net.on(S2C.ROCKET_END, (m) => this._onRocketEnd(m));
    net.on(S2C.FX, (m) => this._onFx(m));
    net.on(S2C.RESET, (m) => this._onReset(m));
    net.on(S2C.WARN, (m) => console.warn("[net] server warning:", m.msg));
    // Phase 7 batch D builders. Every one of these is a server DECISION being applied locally: the volume
    // index, the scale and the restored chunk ids are all chosen by the host.
    net.on(S2C.FOAM_ADD, (m) => this.weapons.applyNetFoam(m.vol, m.o, m.d, m.bits));
    net.on(S2C.FOAM_RM, (m) => this.weapons.removeNetFoam(m.vol));
    net.on(S2C.SCALE, (m) => {
      // Phase 8: the same message now also carries a networked prop's scale (`prop` instead of vol/cid).
      if (m.prop != null) this.weapons.applyNetPropScale(m.prop, m.s);
      else this.weapons.applyNetScale(m.vol, m.cid, m.s);
    });
    net.on(S2C.REATTACH, (m) => this.weapons.applyNetReattach(m.events));
    // Phase 8: the last five tools. Every one of these is the server telling this client what happened;
    // none of them apply damage locally.
    net.on(S2C.AIR_RUN, (m) => this.weapons.applyNetAirRun(m));
    net.on(S2C.PAINT_ADD, (m) => this.weapons.applyNetPaint(m));
    net.on(S2C.PAINT_CLR, (m) => this.weapons.clearNetPaint(m.pid));
    net.on(S2C.PROP_ADD, (m) => this.weapons.applyNetProp(m.id, m.owner, m.p, m.q, m.s || 1));
    net.on(S2C.PROP_RM, (m) => this._onPropRm(m));
    net.on(S2C.PROJ, (m) => this.weapons.applyNetProj(m));
    net.on(S2C.PROJ_END, (m) => this.weapons.endNetProj(m));
    net.on(S2C.RC_GRANT, (m) => this.weapons.applyRcGrant(m.vid));
    return this;
  }

  // prop_rm doubles as the RC car's detonation cue (id 0 is never a real prop), so the audio is played
  // from here even when there is no local twin to dispose.
  _onPropRm(m) {
    if (m.id) this.weapons.removeNetProp(m.id, m.boom, m.p);
    else if (m.boom && m.p) {
      const cam = this.camera.getWorldPosition(this._tmpA);
      this.audio.explosion(cam.distanceTo(this._tmpB.set(m.p[0], m.p[1], m.p[2])));
    }
  }

  setDriving(vid) { this.drivenVid = vid; }

  // --- Late-join snapshot (welcome.snap, brief section 7) ------------------------------------
  applySnapshot(snap) {
    if (!snap) return;
    // Foam volumes FIRST and strictly in index order: volume identity is the array index, so every foam
    // slot the host allocated has to exist here before a single detach from snap.detached is applied.
    // `rm` entries are evicted blobs — they still own their slot, so reserve it with an empty husk.
    for (const f of snap.foam || []) {
      if (f.rm) this.destruction.addHuskVolume(f.v);
      else this.weapons.applyNetFoam(f.v, f.o, f.d, f.bits);
    }
    // Vehicles first so seats/charges can reference them.
    for (const v of snap.vehicles || []) {
      this.manager.spawnNetworked(v.vid, v.id, { x: v.p[0], y: v.p[1], z: v.p[2], yaw: quatToYaw(v.q) });
      this._vehBuffers.set(v.vid, [{ t: performance.now() / 1000, p: v.p, q: v.q, steer: 0, speed: 0 }]);
    }
    // Detached chunks: WITH a debris transform -> applyDetach there; WITHOUT -> detach + instant remove.
    const debrisMap = new Map(); // "vol:cid" -> [px,py,pz, qx,qy,qz,qw]
    for (const d of snap.debris || []) debrisMap.set(d[0] + ":" + d[1], d);
    const IDQ = [0, 0, 0, 1];
    const removeAfter = [];
    for (const entry of snap.detached || []) {
      const vol = entry[0];
      for (const cid of entry[1]) {
        const d = debrisMap.get(vol + ":" + cid);
        if (d) this.destruction.applyDetach(vol, cid, [d[2], d[3], d[4]], [d[5], d[6], d[7], d[8]]);
        else { this.destruction.applyDetach(vol, cid, [0, -1000, 0], IDQ); removeAfter.push([vol, cid]); }
      }
    }
    if (removeAfter.length) this._onDebrisRemove(removeAfter);
    // Seats + charges.
    for (const s of snap.seats || []) this.remotes.setSeat(s[1], s[0]);
    for (const c of snap.charges || []) this.weapons.addNetCharge(c.cid4, c.owner, c.p, c.q, c.vid);
    // Phase 8: tanks already lying around and paint already sprayed. Without these a late joiner walks
    // into a clean-looking wall that is one trigger pull from coming down.
    for (const pr of snap.props || []) this.weapons.applyNetProp(pr.id, pr.owner, pr.p, pr.q, pr.s || 1);
    for (const pt of snap.painted || []) this.weapons.applyNetPaint({ pid: pt[0], vol: pt[1], cid: pt[2] });
  }

  // --- Per-frame: interpolate non-driver networked vehicles --------------------------------------
  preStep(dt) {
    const renderT = performance.now() / 1000 - INTERP;
    for (const [vid, buf] of this._vehBuffers) {
      if (vid === this.drivenVid) continue; // driver predicts locally; reconciled in _onVState
      const veh = this.manager.byNetId ? this.manager.byNetId(vid) : null;
      if (!veh) continue;
      const s = this._sampleVeh(buf, renderT);
      if (!s) continue;
      veh.body.setNextKinematicTranslation({ x: s.p[0], y: s.p[1], z: s.p[2] });
      veh.body.setNextKinematicRotation({ x: s.q[0], y: s.q[1], z: s.q[2], w: s.q[3] });
      veh.steer = s.steer;
      veh.speed = s.speed;
      if (typeof veh.wheelSpin === "number" && veh.V) veh.wheelSpin += (s.speed / veh.V.wheelRadius) * dt;
      if (veh.syncMeshes) veh.syncMeshes();
    }
  }

  _sampleVeh(buf, renderT) {
    if (buf.length === 0) return null;
    if (buf.length === 1 || renderT <= buf[0].t) return buf[0];
    const last = buf[buf.length - 1];
    if (renderT >= last.t) return last;
    for (let i = 0; i < buf.length - 1; i++) {
      const a = buf[i], b = buf[i + 1];
      if (renderT >= a.t && renderT <= b.t) {
        const span = b.t - a.t;
        const u = span > 1e-6 ? (renderT - a.t) / span : 0;
        this._qa.set(a.q[0], a.q[1], a.q[2], a.q[3]);
        this._qb.set(b.q[0], b.q[1], b.q[2], b.q[3]);
        this._qa.slerp(this._qb, u);
        return {
          p: [a.p[0] + (b.p[0] - a.p[0]) * u, a.p[1] + (b.p[1] - a.p[1]) * u, a.p[2] + (b.p[2] - a.p[2]) * u],
          q: [this._qa.x, this._qa.y, this._qa.z, this._qa.w],
          steer: a.steer + (b.steer - a.steer) * u,
          speed: a.speed,
        };
      }
    }
    return last;
  }

  // --- Handlers ------------------------------------------------------------------------------
  _onVState(vehicles, props) {
    // Phase 8: networked props (propane tanks) ride this message rather than getting a channel of their own.
    if (props && props.length) this.weapons.applyNetPropStream(props);
    const now = performance.now() / 1000;
    for (const v of vehicles || []) {
      const speed = v.v ? Math.hypot(v.v[0], v.v[2]) : 0;
      if (v.vid === this.drivenVid) { this._reconcile(v); continue; }
      let buf = this._vehBuffers.get(v.vid);
      if (!buf) { buf = []; this._vehBuffers.set(v.vid, buf); }
      buf.push({ t: now, p: v.p, q: v.q, steer: v.steer || 0, speed });
      while (buf.length > 2 && buf[1].t < now - INTERP - 0.5) buf.shift();
    }
  }

  // Driver reconciliation for THIS client's vehicle (brief section 1 thresholds).
  _reconcile(v) {
    const veh = this.manager.byNetId ? this.manager.byNetId(v.vid) : null;
    if (!veh || !veh.body) return;
    const cur = veh.body.translation();
    this._tmpA.set(cur.x, cur.y, cur.z);
    this._tmpB.set(v.p[0], v.p[1], v.p[2]);
    const err = this._tmpA.distanceTo(this._tmpB);
    if (err < RECONCILE.ignoreM) return;
    if (err > RECONCILE.hardSnapM) {
      veh.body.setTranslation({ x: v.p[0], y: v.p[1], z: v.p[2] }, true);
      veh.body.setRotation({ x: v.q[0], y: v.q[1], z: v.q[2], w: v.q[3] }, true);
    } else {
      const b = RECONCILE.blend;
      this._tmpA.lerp(this._tmpB, b);
      const cq = veh.body.rotation();
      this._qa.set(cq.x, cq.y, cq.z, cq.w);
      this._qb.set(v.q[0], v.q[1], v.q[2], v.q[3]);
      this._qa.slerp(this._qb, b);
      veh.body.setTranslation({ x: this._tmpA.x, y: this._tmpA.y, z: this._tmpA.z }, true);
      veh.body.setRotation({ x: this._qa.x, y: this._qa.y, z: this._qa.z, w: this._qa.w }, true);
    }
    // Adopt server velocities so prediction resumes from the reconciled reality.
    if (v.v) veh.body.setLinvel({ x: v.v[0], y: v.v[1], z: v.v[2] }, true);
    if (v.av) veh.body.setAngvel({ x: v.av[0], y: v.av[1], z: v.av[2] }, true);
  }

  _onDetach(events) {
    if (!events || !events.length) return;
    // Apply every detach; play impact audio for the loudest few (force f drives volume).
    const forces = [];
    for (const e of events) {
      this.destruction.applyDetach(e.vol, e.cid, e.p, e.q);
      if (e.f) forces.push(e.f);
    }
    forces.sort((a, b) => b - a);
    for (let i = 0; i < forces.length && i < 3; i++) this.audio.impact(forces[i]);
  }

  _onDebrisRemove(items) {
    if (!items || !items.length) return;
    if (this.destruction.applyDebrisRemove) this.destruction.applyDebrisRemove(items);
  }

  _onVehSpawn(m) {
    // veh_spawn may replace an owner's previous vehicle; the server precedes it with veh_rm.
    this.manager.spawnNetworked(m.vid, m.id, { x: m.p[0], y: m.p[1], z: m.p[2], yaw: m.yaw || 0 });
    this._vehBuffers.set(m.vid, [{ t: performance.now() / 1000, p: m.p, q: [0, Math.sin((m.yaw || 0) / 2), 0, Math.cos((m.yaw || 0) / 2)], steer: 0, speed: 0 }]);
  }

  _onSeat(m) {
    // Authoritative seat assignment. pid 0 = vacated.
    if (m.pid && this.net && m.pid === this.net.pid) {
      this.onSeatGrant(m.vid, m.pid); // main flips the vehicle into local driver mode
    } else if (m.pid) {
      // A remote took (or still holds) the seat: push it for instant posing (pstate also carries it).
      this.remotes.setSeat(m.pid, m.vid);
    }
  }

  _onC4Boom(m) {
    if (this.weapons.removeNetCharges) this.weapons.removeNetCharges(m.ids || []);
    const cam = this.camera.getWorldPosition(this._tmpA);
    const blasts = (m.blasts || []).map((b) => ({ b, d: cam.distanceTo(this._tmpB.set(b[0], b[1], b[2])) }));
    blasts.sort((a, b) => a.d - b.d);
    for (let i = 0; i < blasts.length && i < 3; i++) this.audio.explosion(blasts[i].d);
  }

  _onRocket(m) {
    if (this.net && m.pid === this.net.pid) return; // my own rocket already renders locally
    if (this.weapons.addRemoteRocket) this.weapons.addRemoteRocket(m.pid, m.rid, m.p, m.dir);
  }

  _onRocketEnd(m) {
    if (this.net && m.pid === this.net.pid) return;
    if (this.weapons.endRemoteRocket) this.weapons.endRemoteRocket(m.pid, m.rid, m.p);
    const cam = this.camera.getWorldPosition(this._tmpA);
    if (m.p) this.audio.explosion(cam.distanceTo(this._tmpB.set(m.p[0], m.p[1], m.p[2])));
  }

  _onFx(m) {
    if (this.net && m.pid === this.net.pid) return; // don't echo my own instant-local fx
    switch (m.kind) {
      case "swing": this.audio.swing(); break;
      case "clang": this.audio.clang(true); break;
      case "gunshot": this.audio.gunshot(); break;
    }
  }

  _onReset(m) {
    this.destruction.resetAll();
    if (this.weapons.resetTransient) this.weapons.resetTransient();
    this.onReset(m.by);
  }

  _onLeave(pid) {
    this.remotes.remove(pid);
    if (this.weapons.removeNetChargesByOwner) this.weapons.removeNetChargesByOwner(pid);
    if (this.weapons.removeRemoteRocketsByOwner) this.weapons.removeRemoteRocketsByOwner(pid);
    // Phase 8: their relayed projectiles will never get a proj_end, and their paint is gone server-side.
    if (this.weapons.removeNetProjByOwner) this.weapons.removeNetProjByOwner(pid);
    if (this.weapons.clearNetPaint) this.weapons.clearNetPaint(pid);
  }
}
