// destruction.js - mode-aware Voronoi pre-fracture: authoritative (solo/server) detach + replica follow (Phase 6 §3)
import * as THREE from "three";
import { CONFIG } from "./config.js";
import { buildGeometry, jitterBucket, jitteredColor } from "./voxel.js";
import { mulberry32, volumeSeed } from "./sim/rng.js";

const D = CONFIG.destruction;
const BUCKETS = CONFIG.voxel.jitterBuckets;
const INTERP = 0.1; // 100 ms replica interpolation buffer (brief §5)

export class Destruction {
  // Two constructor forms:
  //   NEW  (Phase 6): new Destruction(world, RAPIER, { mode, gfx:{scene,materials}|null, mapId, onDetach, onDamageIntent, onDebrisRemove })
  //   LEGACY (Phase 5 main.js, still supported so solo keeps booting during Phase 6 integration):
  //         new Destruction(scene, world, RAPIER, materials) -> authoritative + gfx, mapId "solo".
  // mode: "authoritative" (server & solo — owns detach) | "replica" (MP client — follows server).
  // gfx null => headless server: skip ALL mesh/tile work; bodies + physics only.
  constructor(a, b, c, d) {
    let world, RAPIER, opts;
    if (a && a.isScene) {
      world = b; RAPIER = c;
      opts = { mode: "authoritative", gfx: { scene: a, materials: d }, mapId: "solo" };
    } else {
      world = a; RAPIER = b; opts = c || {};
    }
    this.world = world;
    this.RAPIER = RAPIER;
    this.mode = opts.mode || "authoritative";
    this.gfx = opts.gfx || null;
    this.scene = this.gfx ? this.gfx.scene : null;
    this.materials = this.gfx ? this.gfx.materials : null;
    this.mapId = opts.mapId != null ? String(opts.mapId) : "solo";
    this.onDetach = opts.onDetach || null;             // authoritative: (events[]) after each detach batch
    this.onDamageIntent = opts.onDamageIntent || null; // replica: (intent) instead of a local detach
    this.onDebrisRemove = opts.onDebrisRemove || null; // authoritative server: (items[[vol,cid]]) on cap/sleep cull

    this.volumes = [];
    this.registry = new Map(); // colliderHandle -> { volume, chunk }
    this.debris = [];          // per-mode debris entries (see _detach / applyDetach)
    this._detachQueue = [];
    this._pendingDetach = [];  // batched onDetach events for the current op
    this._stageJobs = [];      // subsystem A.3: pending staged radial jobs, drained N chunks/frame
    this._time = 0;
    // Only these collider handles (player, vehicle) may trigger contact-based detach.
    this.allowedImpactors = new Set();
    this.stats = {
      chunks: 0, chunksGrid: 0, chunksStructure: 0,
      collidersCuboid: 0, collidersHull: 0,
      ms: { fill: 0, voronoi: 0, colliders: 0, tiles: 0 },
    };
  }

  registerImpactor(handle) { this.allowedImpactors.add(handle); }
  unregisterImpactor(handle) { this.allowedImpactors.delete(handle); }

  addVolume(spec) {
    const volIndex = this.volumes.length; // volume identity = index in build order (brief §2)
    const vol = buildVolume(spec, this, volIndex);
    this.volumes.push(vol);
    return vol;
  }

  // ---- Authoritative reset (solo + server). Replica reset is resetAllReplica(). ----
  // Restore every destructible volume to its pre-damage state. Debris purged first, then every
  // inactive chunk gets a FRESH fixed body via createChunkBody; owning tiles re-meshed (gfx only).
  resetAll() {
    if (this.mode === "replica") return this._resetReplica();
    for (const d of this.debris) this._removeDebrisBody(d);
    this.debris = [];
    for (const vol of this.volumes) {
      const dirtyTiles = new Set();
      for (const chunk of vol.chunks) {
        if (chunk.active) continue;
        for (const tid of chunk.tileIds) dirtyTiles.add(tid);
        chunk.mesh = null;
        createChunkBody(vol, chunk, this); // fresh fixed body + collider + registry entry
        chunk.active = true;
      }
      if (this.scene) for (const tid of dirtyTiles) rebuildTile(vol, tid, this.scene, this.materials);
    }
    this._detachQueue.length = 0;
    this._pendingDetach.length = 0;
    this._stageJobs.length = 0;
  }

  // ============================ AUTHORITATIVE PATH ============================

  // Called after world.step(eventQueue). Replica = no-op (client never detaches locally).
  drainContacts(eventQueue) {
    if (this.mode === "replica") return [];
    const seen = new Set();
    eventQueue.drainContactForceEvents((ev) => {
      const f = ev.totalForceMagnitude();
      const r1 = this.registry.get(ev.collider1());
      const r2 = this.registry.get(ev.collider2());
      let hit = null, otherHandle = null;
      if (r1 && r1.chunk.active) { hit = r1; otherHandle = ev.collider2(); }
      else if (r2 && r2.chunk.active) { hit = r2; otherHandle = ev.collider1(); }
      if (!hit) return;
      if (!this.allowedImpactors.has(otherHandle)) return;
      const chunk = hit.chunk;
      if (f < chunk.threshold) return;
      const gid = hit.volume.id + ":" + chunk.id;
      if (seen.has(gid)) return;
      seen.add(gid);
      this._detachQueue.push({ volume: hit.volume, chunk, force: f, otherHandle, ring: f >= chunk.threshold * D.neighborDetachMultiplier });
    });

    const impacts = [];
    for (const req of this._detachQueue) {
      const other = this._otherPos(req.otherHandle);
      const dir = dirTo(other, req.chunk.centroid);
      this._detach(req.volume, req.chunk, dir, req.force);
      impacts.push(req.force);
      if (req.ring) this._detachRing(req.volume, req.chunk, req.force, seen);
    }
    this._detachQueue.length = 0;
    this._flushDetach();
    return impacts;
  }

  _detachRing(vol, chunk, force, seen) {
    for (const nid of chunk.neighbors) {
      const nc = vol.chunks[nid];
      if (!nc || !nc.active) continue;
      const gid = vol.id + ":" + nc.id;
      if (seen.has(gid)) continue;
      seen.add(gid);
      this._detach(vol, nc, dirTo(chunk.centroid, nc.centroid), force * 0.6);
    }
  }

  hasChunk(colliderHandle) { return this.registry.has(colliderHandle); }

  // Per-material multiplier lookup (subsystem A.1). opts.mult is an optional {materialClass: factor} table;
  // absent/unknown class => 1.0, so every legacy caller is byte-identical.
  _multFor(vol, opts) {
    if (!opts || !opts.mult) return 1;
    const m = opts.mult[vol.materialClass];
    return (typeof m === "number" && m > 0) ? m : 1;
  }

  // Point damage by collider handle (client raycast / solo). Replica forwards an intent instead.
  // opts.mult (optional) travels in the intent so the server applies the same material table (§ Phase 7).
  applyPointDamage(colliderHandle, sourcePos, force, opts) {
    const r = this.registry.get(colliderHandle);
    if (!r || !r.chunk.active) return false;
    if (this.mode === "replica") {
      if (this.onDamageIntent) this.onDamageIntent({ kind: "point", vol: r.volume.id, cid: r.chunk.id, src: sourcePos, force, mult: opts ? opts.mult : undefined });
      return false;
    }
    const broke = this._pointDamage(r.volume, r.chunk, sourcePos, force, opts);
    this._flushDetach();
    return broke;
  }

  // Point damage by (volume index, chunk id) — server applying a validated dmg intent (§5).
  applyPointDamageRef(volIdx, cid, sourcePos, force, opts) {
    const vol = this.volumes[volIdx];
    if (!vol) return false;
    const chunk = vol.chunks[cid];
    if (!chunk || !chunk.active) return false;
    const broke = this._pointDamage(vol, chunk, sourcePos, force, opts);
    this._flushDetach();
    return broke;
  }

  _pointDamage(vol, chunk, sourcePos, force, opts) {
    const eff = force * this._multFor(vol, opts);
    if (eff < chunk.threshold) return false;
    const seen = new Set();
    seen.add(vol.id + ":" + chunk.id);
    this._detach(vol, chunk, dirTo(sourcePos, chunk.centroid), eff);
    if (eff >= chunk.threshold * D.neighborDetachMultiplier) this._detachRing(vol, chunk, eff, seen);
    return true;
  }

  // Gather active chunks within radius of center, nearest-first (shared by radial + staged jobs).
  _radialCandidates(center, radius) {
    const r2 = radius * radius;
    const candidates = [];
    for (const vol of this.volumes) {
      const [nx, ny, nz] = vol.dims;
      const [ox, oy, oz] = vol.origin;
      const vs = vol.vs;
      if (center.x < ox - radius || center.x > ox + nx * vs + radius) continue;
      if (center.y < oy - radius || center.y > oy + ny * vs + radius) continue;
      if (center.z < oz - radius || center.z > oz + nz * vs + radius) continue;
      for (const chunk of vol.chunks) {
        if (!chunk.active) continue;
        const d2 = chunk.centroid.distanceToSquared(center);
        if (d2 <= r2) candidates.push({ vol, chunk, dist: Math.sqrt(d2) });
      }
    }
    candidates.sort((a, b) => a.dist - b.dist);
    return candidates;
  }

  // Radial damage (C4, rocket, pipe/sticky/cluster): detach active chunks within radius, nearest-first
  // up to budget. opts.mult (optional) applies the per-material table + travels in the replica intent.
  applyRadialDamage(center, force, radius, budget, opts) {
    if (this.mode === "replica") {
      if (this.onDamageIntent) this.onDamageIntent({ kind: "radial", p: center, force, radius, mult: opts ? opts.mult : undefined });
      return 0;
    }
    const candidates = this._radialCandidates(center, radius);
    let count = 0;
    for (const cand of candidates) {
      if (count >= budget) break;
      const f = force * (1 - cand.dist / radius) * this._multFor(cand.vol, opts);
      if (f < cand.chunk.threshold) continue;
      this._detach(cand.vol, cand.chunk, dirTo(center, cand.chunk.centroid), f);
      count++;
    }
    this._flushDetach();
    return count;
  }

  // Staged detach queue (subsystem A.3). Accepts pending radial jobs and drains at most
  // CONFIG.weapons.stageChunksPerFrame chunk detaches per frame in update(). Authoritative-only:
  // in replica mode nothing stages locally — the server stages and the client receives detach batches.
  // Each job: { center:Vector3, force, radius, budget, mult? }.
  enqueueRadialJobs(jobs) {
    if (this.mode === "replica") return;
    for (const j of jobs) {
      if (!j || !j.center) continue;
      this._stageJobs.push({
        center: j.center, force: j.force, radius: j.radius,
        budget: j.budget != null ? j.budget : Infinity, mult: j.mult ? { mult: j.mult } : null,
        cands: null, i: 0, count: 0,
      });
    }
  }

  _drainStage() {
    if (this._stageJobs.length === 0) return;
    let quota = CONFIG.weapons.stageChunksPerFrame;
    while (this._stageJobs.length && quota > 0) {
      const job = this._stageJobs[0];
      if (!job.cands) job.cands = this._radialCandidates(job.center, job.radius);
      while (job.i < job.cands.length && quota > 0 && job.count < job.budget) {
        const cand = job.cands[job.i++];
        if (!cand.chunk.active) continue; // detached since the job was queued
        const f = job.force * (1 - cand.dist / job.radius) * this._multFor(cand.vol, job.mult);
        if (f < cand.chunk.threshold) continue;
        this._detach(cand.vol, cand.chunk, dirTo(job.center, cand.chunk.centroid), f);
        job.count++; quota--;
      }
      if (job.i >= job.cands.length || job.count >= job.budget) this._stageJobs.shift();
    }
    this._flushDetach();
  }

  _otherPos(handle) {
    const col = this.world.getCollider(handle);
    if (col && col.parent()) {
      const t = col.parent().translation();
      return new THREE.Vector3(t.x, t.y, t.z);
    }
    return null;
  }

  // Flip a chunk to a dynamic debris body + kick. gfx: mesh it + rebuild tiles. Headless: physics only.
  // Always records an onDetach event (server broadcasts it). Never called in replica mode.
  _detach(vol, chunk, dir, force) {
    chunk.active = false;
    chunk.body.setBodyType(this.RAPIER.RigidBodyType.Dynamic, true);
    const c = chunk.centroid;
    let mag = D.detachKick * force * CONFIG.fixedDt;
    mag = Math.min(mag, 400);
    chunk.body.applyImpulseAtPoint(
      { x: dir.x * mag, y: dir.y * mag + mag * 0.15, z: dir.z * mag },
      { x: c.x, y: c.y, z: c.z },
      true
    );

    let mesh = null;
    if (this.scene) {
      const geo = meshChunk(vol, chunk);
      mesh = new THREE.Mesh(geo, this.materials);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const t = chunk.body.translation();
      mesh.position.set(t.x, t.y, t.z);
      this.scene.add(mesh);
      chunk.mesh = mesh;
    }

    const entry = { vol, chunk, mesh, body: chunk.body, born: this._time, fading: false, fadeT: 0, sleepAt: -1, sentRest: false };
    this.debris.push(entry);
    this._enforceCap();

    if (this.scene) for (const tid of chunk.tileIds) rebuildTile(vol, tid, this.scene, this.materials);

    if (this.onDetach) {
      const t = chunk.body.translation();
      const r = chunk.body.rotation();
      this._pendingDetach.push({
        vol: vol.id, cid: chunk.id,
        p: [round2(t.x), round2(t.y), round2(t.z)],
        q: [round3(r.x), round3(r.y), round3(r.z), round3(r.w)],
        f: Math.round(force),
      });
    }
  }

  _flushDetach() {
    if (this._pendingDetach.length && this.onDetach) this.onDetach(this._pendingDetach.slice());
    this._pendingDetach.length = 0;
  }

  _enforceCap() {
    const active = this.debris.filter((d) => !d.fading);
    if (active.length <= D.debrisCap) return;
    let victim = null;
    for (const d of active) { if (d.body.isSleeping()) { victim = d; break; } }
    if (!victim) victim = active[0];
    this._cull(victim);
  }

  // Retire a debris entry. gfx: fade it out over fadeSeconds. Headless: remove body + emit debris_rm.
  _cull(d) {
    if (this.scene) { d.fading = true; return; }
    this._removeDebrisBody(d);
    this.debris = this.debris.filter((x) => x !== d);
    if (this.onDebrisRemove) this.onDebrisRemove([[d.vol.id, d.chunk.id]]);
  }

  // Per-frame debris bookkeeping. gfx: sync meshes + fade. Headless: sleep-cull only. Replica: interp.
  update(dt) {
    this._time += dt;
    if (this.mode === "replica") return this._updateReplica(dt);
    this._drainStage(); // subsystem A.3: bleed queued big-blast detaches at the per-frame budget
    const now = this._time;
    const activeCount = this.debris.filter((d) => !d.fading).length;
    const removals = [];
    for (const d of this.debris) {
      if (d.fading) continue;
      if (this.scene && d.mesh) {
        const t = d.body.translation();
        const r = d.body.rotation();
        d.mesh.position.set(t.x, t.y, t.z);
        d.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      }
      const sleeping = d.body.isSleeping();
      if (sleeping && d.sleepAt < 0) d.sleepAt = now;
      if (!sleeping) { d.sleepAt = -1; d.sentRest = false; }
      if (sleeping && d.sleepAt >= 0 && now - d.sleepAt > D.debrisSleepCullSeconds && activeCount > D.debrisSleepCullMin) {
        if (this.scene) { d.fading = true; }
        else { removals.push(d); }
      }
    }
    for (const d of removals) {
      this._removeDebrisBody(d);
      if (this.onDebrisRemove) this.onDebrisRemove([[d.vol.id, d.chunk.id]]);
    }
    if (removals.length) this.debris = this.debris.filter((d) => !removals.includes(d));
    if (this.debris.length === 0) return;
    if (!this.scene) return; // headless: no fade animation
    const keep = [];
    for (const d of this.debris) {
      if (d.fading) {
        if (d.mesh) {
          const t = d.body.translation();
          const r = d.body.rotation();
          d.mesh.position.set(t.x, t.y, t.z);
          d.mesh.quaternion.set(r.x, r.y, r.z, r.w);
          d.fadeT += dt;
          const s = Math.max(0, 1 - d.fadeT / D.fadeSeconds);
          d.mesh.scale.setScalar(s);
          if (s <= 0.001) { this._removeDebrisBody(d); continue; }
        } else { this._removeDebrisBody(d); continue; }
      }
      keep.push(d);
    }
    this.debris = keep;
  }

  _removeDebrisBody(d) {
    if (d.chunk) this.registry.delete(d.chunk.colliderHandle);
    if (d.mesh) { this.scene.remove(d.mesh); d.mesh.geometry.dispose(); }
    if (d.body) this.world.removeRigidBody(d.body);
  }

  // ---- Server broadcast + snapshot helpers (authoritative headless) ----

  // Awake debris transforms for the 10 Hz stream; each body's resting transform is emitted once
  // after it falls asleep, then suppressed until it wakes again.
  collectDebris() {
    const out = [];
    for (const d of this.debris) {
      if (d.fading) continue;
      const sleeping = d.body.isSleeping();
      if (sleeping) {
        if (d.sentRest) continue;
        d.sentRest = true;
      }
      const t = d.body.translation();
      const r = d.body.rotation();
      out.push([d.vol.id, d.chunk.id, round2(t.x), round2(t.y), round2(t.z), round3(r.x), round3(r.y), round3(r.z), round3(r.w)]);
    }
    return out;
  }

  // Late-join snapshot (§7): every inactive chunk grouped per volume + live debris transforms.
  snapshot() {
    const detached = [];
    const debrisT = [];
    const live = new Set();
    for (const d of this.debris) {
      if (d.fading) continue;
      const t = d.body.translation();
      const r = d.body.rotation();
      debrisT.push([d.vol.id, d.chunk.id, round2(t.x), round2(t.y), round2(t.z), round3(r.x), round3(r.y), round3(r.z), round3(r.w)]);
      live.add(d.vol.id + ":" + d.chunk.id);
    }
    for (const vol of this.volumes) {
      const cids = [];
      for (const chunk of vol.chunks) if (!chunk.active) cids.push(chunk.id);
      if (cids.length) detached.push([vol.id, cids]);
    }
    return { detached, debris: debrisT };
  }

  // ============================== REPLICA PATH ==============================

  // Mark a chunk detached at a server transform: swap its fixed body for a kinematic one,
  // mesh it, rebuild owning tiles. Colliders stay live so the local player/vehicle hit debris.
  applyDetach(volIdx, cid, p, q, rebuildTiles = true) {
    const vol = this.volumes[volIdx];
    if (!vol) return null;
    const chunk = vol.chunks[cid];
    if (!chunk || !chunk.active) return null;
    chunk.active = false;
    // Replace the fixed body with a kinematicPositionBased one at the server transform.
    if (chunk.body) { this.registry.delete(chunk.colliderHandle); this.world.removeRigidBody(chunk.body); }
    createChunkBody(vol, chunk, this, { kinematic: true, translation: p, rotation: q });

    let mesh = null;
    if (this.scene) {
      const geo = meshChunk(vol, chunk);
      mesh = new THREE.Mesh(geo, this.materials);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(p[0], p[1], p[2]);
      if (q) mesh.quaternion.set(q[0], q[1], q[2], q[3]);
      this.scene.add(mesh);
      chunk.mesh = mesh;
    }
    const entry = {
      vol, chunk, mesh, body: chunk.body, fading: false, fadeT: 0,
      prevP: p.slice(), prevQ: q ? q.slice() : [0, 0, 0, 1],
      targetP: p.slice(), targetQ: q ? q.slice() : [0, 0, 0, 1],
      interpT: INTERP, interpDur: INTERP,
    };
    this.debris.push(entry);
    this._replicaIndex = null; // invalidate lookup cache
    if (rebuildTiles && this.scene) for (const tid of chunk.tileIds) rebuildTile(vol, tid, this.scene, this.materials);
    return chunk;
  }

  // Buffer new server debris transforms; update() interpolates over the 100 ms window.
  applyDebris(items) {
    const idx = this._debrisIndex();
    for (const it of items) {
      const key = it[0] + ":" + it[1];
      const d = idx.get(key);
      if (!d) continue;
      d.prevP = [d.targetP[0], d.targetP[1], d.targetP[2]];
      d.prevQ = [d.targetQ[0], d.targetQ[1], d.targetQ[2], d.targetQ[3]];
      d.targetP = [it[2], it[3], it[4]];
      d.targetQ = [it[5], it[6], it[7], it[8]];
      d.interpT = 0;
      d.interpDur = INTERP;
    }
  }

  // Server-driven cap/sleep-cull removals -> fade out locally.
  applyDebrisRemove(items) {
    const idx = this._debrisIndex();
    for (const it of items) {
      const d = idx.get(it[0] + ":" + it[1]);
      if (d) d.fading = true;
    }
  }

  _debrisIndex() {
    if (this._replicaIndex) return this._replicaIndex;
    const m = new Map();
    for (const d of this.debris) m.set(d.vol.id + ":" + d.chunk.id, d);
    this._replicaIndex = m;
    return m;
  }

  _updateReplica(dt) {
    if (this.debris.length === 0) return;
    const q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion();
    const keep = [];
    let removed = false;
    for (const d of this.debris) {
      if (d.fading) {
        d.fadeT += dt;
        const s = Math.max(0, 1 - d.fadeT / D.fadeSeconds);
        if (d.mesh) d.mesh.scale.setScalar(s);
        if (s <= 0.001) { this._removeDebrisBody(d); removed = true; continue; }
        keep.push(d);
        continue;
      }
      d.interpT = Math.min(d.interpDur, d.interpT + dt);
      const a = d.interpDur > 0 ? d.interpT / d.interpDur : 1;
      const px = lerp(d.prevP[0], d.targetP[0], a);
      const py = lerp(d.prevP[1], d.targetP[1], a);
      const pz = lerp(d.prevP[2], d.targetP[2], a);
      q0.set(d.prevQ[0], d.prevQ[1], d.prevQ[2], d.prevQ[3]);
      q1.set(d.targetQ[0], d.targetQ[1], d.targetQ[2], d.targetQ[3]);
      q0.slerp(q1, a);
      if (d.body) {
        d.body.setNextKinematicTranslation({ x: px, y: py, z: pz });
        d.body.setNextKinematicRotation({ x: q0.x, y: q0.y, z: q0.z, w: q0.w });
      }
      if (d.mesh) { d.mesh.position.set(px, py, pz); d.mesh.quaternion.copy(q0); }
      keep.push(d);
    }
    if (removed) { this.debris = keep; this._replicaIndex = null; }
  }

  _resetReplica() {
    for (const vol of this.volumes) {
      const dirtyTiles = new Set();
      for (const chunk of vol.chunks) {
        if (chunk.active) continue;
        for (const tid of chunk.tileIds) dirtyTiles.add(tid);
      }
      // Purge this volume's kinematic debris.
      for (const d of this.debris) {
        if (d.vol !== vol) continue;
        this._removeDebrisBody(d);
      }
      for (const chunk of vol.chunks) {
        if (chunk.active) continue;
        chunk.mesh = null;
        createChunkBody(vol, chunk, this); // fresh FIXED body
        chunk.active = true;
      }
      if (this.scene) for (const tid of dirtyTiles) rebuildTile(vol, tid, this.scene, this.materials);
    }
    this.debris = [];
    this._replicaIndex = null;
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }
function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }

function dirTo(from, to) {
  if (!from) return new THREE.Vector3(0, 1, 0);
  const v = new THREE.Vector3(to.x - from.x, to.y - from.y, to.z - from.z);
  if (v.lengthSq() < 1e-6) return new THREE.Vector3(0, 1, 0);
  return v.normalize();
}

function buildVolume(spec, mgr, volIndex) {
  const stats = mgr.stats;
  const [nx, ny, nz] = spec.dims;
  const vs = spec.voxelSize;
  const [ox, oy, oz] = spec.origin;
  const gridKind = spec.kind === "grid";
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  let t0 = now();
  const idx = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const v = spec.fill(x, y, z) | 0;
        idx[x + nx * (y + ny * z)] = v;
      }
  stats.ms.fill += now() - t0;

  const palette = spec.palette.map((p) => ({
    color: new THREE.Color().setStyle(p.color),
    shiny: (p.metalness ?? 0) > CONFIG.voxel.shinyMetalnessCutoff,
  }));

  const at = (x, y, z) => idx[x + nx * (y + ny * z)];

  t0 = now();
  // Voronoi partition via spatial-hashed seeds. Seed jitter is now DETERMINISTIC: mulberry32 keyed by
  // (mapId, volume index) so every build — client, server, reload — yields the identical partition (§2).
  const rand = mulberry32(volumeSeed(mgr.mapId, volIndex));
  const chunkOf = new Int32Array(nx * ny * nz).fill(-1);
  const spacingV = Math.max(1, Math.round(spec.chunkSize / vs));
  const cellsX = Math.max(1, Math.ceil(nx / spacingV));
  const cellsY = Math.max(1, Math.ceil(ny / spacingV));
  const cellsZ = Math.max(1, Math.ceil(nz / spacingV));
  const seeds = [];
  const seedCell = new Map();
  const skey = (cx, cy, cz) => cx + cellsX * (cy + cellsY * cz);
  for (let cz = 0; cz < cellsZ; cz++)
    for (let cy = 0; cy < cellsY; cy++)
      for (let cx = 0; cx < cellsX; cx++) {
        const sx = (cx + 0.2 + 0.6 * rand()) * spacingV;
        const sy = (cy + 0.2 + 0.6 * rand()) * spacingV;
        const sz = (cz + 0.2 + 0.6 * rand()) * spacingV;
        const i = seeds.length;
        seeds.push([sx, sy, sz]);
        seedCell.set(skey(cx, cy, cz), i);
      }

  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        if (at(x, y, z) === 0) continue;
        const cx = Math.min(cellsX - 1, Math.floor(x / spacingV));
        const cy = Math.min(cellsY - 1, Math.floor(y / spacingV));
        const cz = Math.min(cellsZ - 1, Math.floor(z / spacingV));
        let best = -1, bestD = Infinity;
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx2 = cx + dx, ny2 = cy + dy, nz2 = cz + dz;
              if (nx2 < 0 || ny2 < 0 || nz2 < 0 || nx2 >= cellsX || ny2 >= cellsY || nz2 >= cellsZ) continue;
              const si = seedCell.get(skey(nx2, ny2, nz2));
              if (si === undefined) continue;
              const s = seeds[si];
              const ddx = x + 0.5 - s[0], ddy = y + 0.5 - s[1], ddz = z + 0.5 - s[2];
              const dd = ddx * ddx + ddy * ddy + ddz * ddz;
              if (dd < bestD) { bestD = dd; best = si; }
            }
        if (best < 0) best = 0;
        chunkOf[x + nx * (y + ny * z)] = best;
      }

  // Compact chunk ids (linear voxel-scan order -> deterministic given the seeded partition).
  const remap = new Map();
  const chunkVoxels = [];
  for (let i = 0; i < chunkOf.length; i++) {
    const s = chunkOf[i];
    if (s < 0) continue;
    let cid = remap.get(s);
    if (cid === undefined) { cid = chunkVoxels.length; remap.set(s, cid); chunkVoxels.push([]); }
    chunkOf[i] = cid;
    chunkVoxels[cid].push(i);
  }

  stats.ms.voronoi += now() - t0;

  const tileM = spec.tileMeters || CONFIG.destruction.tileMeters;
  const voxelsPerTile = spec.kind === "grid" ? Math.ceil(nx / Math.max(1, Math.ceil((nx * vs) / tileM))) : nx;
  const voxelsPerTileZ = spec.kind === "grid" ? Math.ceil(nz / Math.max(1, Math.ceil((nz * vs) / tileM))) : nz;
  const tileCountX = spec.kind === "grid" ? Math.ceil(nx / voxelsPerTile) : 1;
  const tileCountZ = spec.kind === "grid" ? Math.ceil(nz / voxelsPerTileZ) : 1;
  const tileOf = (x, z) => {
    const tx = Math.min(tileCountX - 1, Math.floor(x / voxelsPerTile));
    const tz = Math.min(tileCountZ - 1, Math.floor(z / voxelsPerTileZ));
    return tz * tileCountX + tx;
  };

  const vol = {
    id: volIndex, spec, dims: spec.dims, vs, origin: spec.origin, idx, chunkOf, palette,
    // Phase 7 subsystem A.1: coarse material class for per-tool damage multipliers (default concrete).
    materialClass: spec.materialClass || "concrete",
    chunks: [], threshold: spec.threshold,
    tiles: [], tileCountX, tileCountZ, voxelsPerTile, voxelsPerTileZ,
    scene: mgr.scene, materials: mgr.materials,
  };

  // Build chunks: geometry-free bodies + colliders (fixed). Stats tallied ONLY here (build time).
  t0 = now();
  const nxy = nx * ny;
  for (let cid = 0; cid < chunkVoxels.length; cid++) {
    const vox = chunkVoxels[cid];
    let sx = 0, sy = 0, sz = 0;
    const tileIds = new Set();
    for (let i = 0; i < vox.length; i++) {
      const li = vox[i];
      const x = li % nx, y = (li / nx | 0) % ny, z = (li / nxy) | 0;
      sx += ox + (x + 0.5) * vs; sy += oy + (y + 0.5) * vs; sz += oz + (z + 0.5) * vs;
      tileIds.add(tileOf(x, z));
    }
    const inv = 1 / vox.length;
    const centroid = new THREE.Vector3(sx * inv, sy * inv, sz * inv);

    const chunk = {
      id: cid, voxels: vox, centroid, body: null, colliderHandle: -1,
      active: true, tileIds, neighbors: new Set(), threshold: spec.threshold, mesh: null,
    };
    vol.chunks.push(chunk);

    const usedHull = createChunkBody(vol, chunk, mgr);
    stats.chunks++;
    if (gridKind) { stats.chunksGrid++; } else { stats.chunksStructure++; }
    if (usedHull) { stats.collidersHull++; } else { stats.collidersCuboid++; }
  }
  stats.ms.colliders += now() - t0;

  // Neighbor adjacency (6-connected across chunk boundaries).
  const neigh = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const li = x + nx * (y + ny * z);
        const c = chunkOf[li];
        if (c < 0) continue;
        for (const [dx, dy, dz] of neigh) {
          const nx2 = x + dx, ny2 = y + dy, nz2 = z + dz;
          if (nx2 < 0 || ny2 < 0 || nz2 < 0 || nx2 >= nx || ny2 >= ny || nz2 >= nz) continue;
          const c2 = chunkOf[nx2 + nx * (ny2 + ny * nz2)];
          if (c2 >= 0 && c2 !== c) { vol.chunks[c].neighbors.add(c2); }
        }
      }

  // Tile meshes (gfx only; headless server skips all mesh work).
  t0 = now();
  const nTiles = tileCountX * tileCountZ;
  for (let t = 0; t < nTiles; t++) {
    const tx = t % tileCountX;
    const tz = Math.floor(t / tileCountX);
    const x0 = tx * voxelsPerTile, x1 = Math.min(nx, x0 + voxelsPerTile);
    const z0 = tz * voxelsPerTileZ, z1 = Math.min(nz, z0 + voxelsPerTileZ);
    const tile = { x0, x1, z0, z1, mesh: null };
    vol.tiles.push(tile);
    if (mgr.scene) rebuildTile(vol, t, mgr.scene, mgr.materials);
  }
  stats.ms.tiles += now() - t0;

  return vol;
}

// Create a chunk's rigid body + collider and register it. Default: FIXED body at the centroid.
// opts.kinematic => kinematicPositionBased body placed at opts.translation / opts.rotation (replica debris).
function createChunkBody(vol, chunk, mgr, opts = {}) {
  const RAPIER = mgr.RAPIER;
  const world = mgr.world;
  const spec = vol.spec;
  const [nx, ny, nz] = vol.dims;
  const vs = vol.vs;
  const [ox, oy, oz] = vol.origin;
  const gridKind = spec.kind === "grid";
  const idx = vol.idx;
  const chunkOf = vol.chunkOf;
  const nxy = nx * ny;
  const canPack = nx + 1 < 1024 && ny + 1 < 1024 && nz + 1 < 1024;
  const cid = chunk.id;
  const vox = chunk.voxels;
  const centroid = chunk.centroid;

  const isSurface = (li) => {
    const x = li % nx, y = (li / nx | 0) % ny, z = (li / nxy) | 0;
    if (x === 0 || x === nx - 1 || y === 0 || y === ny - 1 || z === 0 || z === nz - 1) return true;
    if (idx[li - 1] === 0 || chunkOf[li - 1] !== cid) return true;
    if (idx[li + 1] === 0 || chunkOf[li + 1] !== cid) return true;
    if (idx[li - nx] === 0 || chunkOf[li - nx] !== cid) return true;
    if (idx[li + nx] === 0 || chunkOf[li + nx] !== cid) return true;
    if (idx[li - nxy] === 0 || chunkOf[li - nxy] !== cid) return true;
    if (idx[li + nxy] === 0 || chunkOf[li + nxy] !== cid) return true;
    return false;
  };

  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < vox.length; i++) {
    const li = vox[i];
    const x = li % nx, y = (li / nx | 0) % ny, z = (li / nxy) | 0;
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }

  let bodyDesc;
  if (opts.kinematic) {
    const p = opts.translation || [centroid.x, centroid.y, centroid.z];
    bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p[0], p[1], p[2]);
    if (opts.rotation) bodyDesc.setRotation({ x: opts.rotation[0], y: opts.rotation[1], z: opts.rotation[2], w: opts.rotation[3] });
  } else {
    bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(centroid.x, centroid.y, centroid.z).setCanSleep(true);
  }
  const body = world.createRigidBody(bodyDesc);

  const applyProps = (cd) => cd
    .setDensity(spec.density).setFriction(D.friction).setRestitution(D.restitution)
    .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
    .setContactForceEventThreshold(spec.threshold);

  let collider = null;
  let usedHull = false;
  if (!gridKind) {
    const cornerSeen = new Set();
    const pts = [];
    for (let i = 0; i < vox.length; i++) {
      const li = vox[i];
      if (!isSurface(li)) continue;
      const x = li % nx, y = (li / nx | 0) % ny, z = (li / nxy) | 0;
      for (let dz = 0; dz <= 1; dz++)
        for (let dy = 0; dy <= 1; dy++)
          for (let dx = 0; dx <= 1; dx++) {
            const cxk = x + dx, cyk = y + dy, czk = z + dz;
            const key = canPack ? (cxk | (cyk << 10) | (czk << 20)) : (cxk + 1024 * (cyk + 1024 * czk));
            if (cornerSeen.has(key)) continue;
            cornerSeen.add(key);
            pts.push(ox + cxk * vs - centroid.x, oy + cyk * vs - centroid.y, oz + czk * vs - centroid.z);
          }
    }
    const hullDesc = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
    if (hullDesc) {
      try {
        collider = world.createCollider(applyProps(hullDesc), body);
        usedHull = true;
      } catch (e) {
        collider = null;
      }
    }
  }
  if (!collider) {
    const cx = (ox + (minx + (maxx + 1)) * 0.5 * vs) - centroid.x;
    const cy = (oy + (miny + (maxy + 1)) * 0.5 * vs) - centroid.y;
    const cz = (oz + (minz + (maxz + 1)) * 0.5 * vs) - centroid.z;
    const hx = Math.max((maxx - minx + 1) * vs / 2, vs / 2);
    const hy = Math.max((maxy - miny + 1) * vs / 2, vs / 2);
    const hz = Math.max((maxz - minz + 1) * vs / 2, vs / 2);
    const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz);
    collider = world.createCollider(applyProps(cd), body);
  }

  chunk.body = body;
  chunk.colliderHandle = collider.handle;
  mgr.registry.set(collider.handle, { volume: vol, chunk });
  return usedHull;
}

function activeAt(vol, x, y, z) {
  const [nx, ny] = vol.dims;
  const li = x + nx * (y + ny * z);
  const p = vol.idx[li];
  if (p === 0) return 0;
  const c = vol.chunkOf[li];
  if (c < 0 || !vol.chunks[c].active) return 0;
  return p;
}

function rebuildTile(vol, t, scene, materials) {
  const tile = vol.tiles[t];
  if (!tile) return;
  const [nx, ny, nz] = vol.dims;
  const vs = vol.vs;
  const [ox, oy, oz] = vol.origin;
  const { x0, x1, z0, z1 } = tile;
  const geo = buildGeometry({
    dims: [x1 - x0, ny, z1 - z0],
    voxelSize: vs,
    origin: [ox + x0 * vs, oy, oz + z0 * vs],
    get: (lx, ly, lz) => activeAt(vol, x0 + lx, ly, z0 + lz),
    mergeKey: (lx, ly, lz, pidx) => pidx * BUCKETS + jitterBucket(x0 + lx, ly, z0 + lz),
    colorAt: (lx, ly, lz, pidx, out) => jitteredColor(vol.palette[pidx - 1].color, x0 + lx, ly, z0 + lz, out),
    groupAt: (pidx) => (vol.palette[pidx - 1].shiny ? 1 : 0),
  });
  if (tile.mesh) {
    scene.remove(tile.mesh);
    tile.mesh.geometry.dispose();
  }
  const hasVerts = geo.getAttribute("position") && geo.getAttribute("position").count > 0;
  if (!hasVerts) { tile.mesh = null; geo.dispose(); return; }
  const mesh = new THREE.Mesh(geo, materials);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  tile.mesh = mesh;
}

function meshChunk(vol, chunk) {
  const [nx, ny, nz] = vol.dims;
  const vs = vol.vs;
  const [ox, oy, oz] = vol.origin;
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (const li of chunk.voxels) {
    const x = li % nx, y = Math.floor(li / nx) % ny, z = Math.floor(li / (nx * ny));
    minx = Math.min(minx, x); maxx = Math.max(maxx, x);
    miny = Math.min(miny, y); maxy = Math.max(maxy, y);
    minz = Math.min(minz, z); maxz = Math.max(maxz, z);
  }
  const c = chunk.centroid;
  const member = new Set(chunk.voxels);
  const get = (lx, ly, lz) => {
    const x = minx + lx, y = miny + ly, z = minz + lz;
    const li = x + nx * (y + ny * z);
    return member.has(li) ? vol.idx[li] : 0;
  };
  return buildGeometry({
    dims: [maxx - minx + 1, maxy - miny + 1, maxz - minz + 1],
    voxelSize: vs,
    origin: [ox + minx * vs - c.x, oy + miny * vs - c.y, oz + minz * vs - c.z],
    get,
    mergeKey: (lx, ly, lz, pidx) => pidx * BUCKETS + jitterBucket(minx + lx, miny + ly, minz + lz),
    colorAt: (lx, ly, lz, pidx, out) => jitteredColor(vol.palette[pidx - 1].color, minx + lx, miny + ly, minz + lz, out),
    groupAt: (pidx) => (vol.palette[pidx - 1].shiny ? 1 : 0),
  });
}
