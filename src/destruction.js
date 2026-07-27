// destruction.js - mode-aware Voronoi pre-fracture: authoritative (solo/server) detach + replica follow (Phase 6 §3)
import * as THREE from "three";
import { CONFIG } from "./config.js";
import { buildGeometry, jitterBucket, jitteredColor } from "./voxel.js";
import { mulberry32, volumeSeed } from "./sim/rng.js";
import { CAPS } from "./net/protocol.js"; // server-side validation caps (Phase 7 batch C replica-intent clamps)

const D = CONFIG.destruction;
const BUCKETS = CONFIG.voxel.jitterBuckets;
const INTERP = 0.1; // 100 ms replica interpolation buffer (brief §5)

// ---- Local tuning block ---------------------------------------------------------------------------
// These belong to two subsystems that live entirely inside this file (the carve capture test and the
// structural-support propagation added for the "detached structures must fall" pass). They are kept here
// rather than in CONFIG for the same reason audio.js keeps its mix constants local: nothing outside this
// file reads them, and they are tuning for one algorithm, not world balance.
const SUP = {
  // carveCylinder capture: a carve step breaks any chunk whose BOUNDING BOX comes within this slack of the
  // beam surface. The old test compared the beam radius against the chunk CENTROID, so a 1.2 m beam could
  // only ever reach a chunk whose centre was <1.2 m from the axis — ground chunks are 3.0 m apart and
  // structure chunks 1.1-1.4 m, so the column routinely fell between centroids and broke nothing.
  carveSurfaceSlack: 0.15,   // m
  // Structural support graph.
  contactEps: 0.20,          // m, AABB gap (any axis) still counted as a structural join between volumes
  rootY: 0.05,               // m, a chunk whose bottom sits at/below this rests on the indestructible core
  cellSize: 2.0,             // m, XZ spatial-hash cell used once at load to find cross-volume contacts
  // A collapse is gravity, not an explosion: this "force" produces an impulse of well under 1 cm/s on a
  // real chunk, just enough to unstick perfectly stacked pieces. It is NOT a blast.
  collapseForce: 900,
  collapseInlineMax: 24,     // more unsupported chunks than this in one pass -> ripple via the stage queue
  passChunkCap: 6000,        // hard bound on the chunks visited by one flood-fill pass
};

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
    this._stageJobs = [];      // subsystem A.3: pending staged jobs (radial | list), drained N chunks/frame
    // Phase 7 batch C: non-chunk dynamic props (propane tanks) that explode on shot/impact/chain. Each rec:
    // { pos():Vector3, explode(), chainR, exploded, queued }. NOT in allowedImpactors (never cascades).
    this.damageableProps = new Map(); // colliderHandle -> rec
    this._propChain = [];      // scheduled chain-reaction explosions: [{ rec, at }] (staged 1 beat apart)
    this._deferTiles = null;   // non-null during a batched vehicle punch: collects "volId:tileId" to re-mesh once
    this._detachSeq = 0;       // Phase 7 batch D: monotonic detach counter -> chunk.detachSeq = "damage age" (Rebuild Gun restores oldest-first)
    this._time = 0;
    // Only these collider handles (player, vehicle) may trigger contact-based detach.
    this.allowedImpactors = new Set();
    // Subset of allowedImpactors that ram "cardboard": vehicles + Car Cannon. They get a big force
    // multiplier + a radial punch so a car plows through buildings. The player stays OUT of this set.
    this.heavyImpactors = new Set();
    this._motionPrev = new Map(); // heavy handle -> {s, dx, dy, dz} at the previous step (approach motion)
    // Structural support propagation (authoritative only). A chunk stays fixed while it is connected —
    // through other still-attached chunks — to something that counts as ground; anything that loses that
    // connection detaches through the normal _detach path and falls.
    this._supportReady = false;   // graph built lazily on the first update() (all volumes are in by then)
    this._supportHash = null;     // XZ spatial hash used only while building/extending the contact graph
    this._supportDirty = new Set(); // groups (Set<volume>) whose support must be re-flooded next update
    this._supportStamp = 0;       // monotonic visit stamp, avoids allocating a Set per flood
    this.stats = {
      chunks: 0, chunksGrid: 0, chunksStructure: 0,
      collidersCuboid: 0, collidersHull: 0,
      ms: { fill: 0, voronoi: 0, colliders: 0, tiles: 0, support: 0 },
      supportLinks: 0, supportRoots: 0,
    };
  }

  // Registering a heavy impactor SEEDS its approach motion immediately. The Car Cannon creates its
  // projectile and can hit a wall on the very next step; without this seed _motionPrev is still empty on
  // that step, the post-step velocity is already ~0 (the wall stopped it), and the ram gate throws the
  // whole impact away — which is why a flung car stopped destroying anything at short range.
  registerImpactor(handle, heavy = false) {
    this.allowedImpactors.add(handle);
    if (!heavy) return;
    this.heavyImpactors.add(handle);
    this._sampleOne(handle);
  }
  unregisterImpactor(handle) { this.allowedImpactors.delete(handle); this.heavyImpactors.delete(handle); this._motionPrev.delete(handle); }

  addVolume(spec) {
    const volIndex = this.volumes.length; // volume identity = index in build order (brief §2)
    const vol = buildVolume(spec, this, volIndex);
    this.volumes.push(vol);
    // Volumes created after the initial map build (Foam Cannon blobs) join the support graph immediately.
    if (this._supportReady) { this._linkVolume(vol); this._seedRoots([vol]); }
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
      if (vol.removed) continue; // Phase 7 batch D: despawned foam husk stays gone across a reset
      const dirtyTiles = new Set();
      for (const chunk of vol.chunks) {
        chunk.falling = false; // cancel any queued gravity collapse for this chunk
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
    this._propChain.length = 0; // Phase 7 batch C: cancel any pending propane chain reactions
    this._supportDirty.clear(); // the map is whole again: nothing is unsupported
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
      // Vehicles (heavy) ram like cardboard: boosted force clears any material; the player stays at full
      // material threshold so walking into a wall never breaks it.
      // A heavy impactor only counts as a RAM above a minimum speed; parked or crawling vehicles must not
      // chew up the road they sit on (doing so dropped them into their own craters and flung them skyward).
      if (this.heavyImpactors.has(otherHandle)) {
        // Vehicles smash STRUCTURES, never the road: ploughing the ground skin dug trenches the car then
        // fell into (which is what threw it into the air). Grid-kind volumes are the ground.
        if (hit.volume.spec.kind === "grid") return;
        if (this._ramSpeed(otherHandle) < D.vehicleMinRamSpeed) return; // parked / crawling: no damage
      }
      const heavy = this.heavyImpactors.has(otherHandle);
      const eff = heavy ? f * D.vehicleImpactForceMult : f;
      if (eff < chunk.threshold) return;
      const gid = hit.volume.id + ":" + chunk.id;
      if (seen.has(gid)) return;
      seen.add(gid);
      this._detachQueue.push({ volume: hit.volume, chunk, force: eff, otherHandle, heavy, ring: eff >= chunk.threshold * D.neighborDetachMultiplier });
    });

    const impacts = [];
    for (const req of this._detachQueue) {
      const other = this._otherPos(req.otherHandle);
      const dir = dirTo(other, req.chunk.centroid);
      this._detach(req.volume, req.chunk, dir, req.force, req.heavy ? D.vehiclePunchKick : 1, req.heavy);
      impacts.push(req.force);
      if (req.heavy) this._vehiclePunch(req.chunk.centroid, D.vehiclePunchRadius, req.force, seen, this._impactorTravel(req.otherHandle));
      else if (req.ring) this._detachRing(req.volume, req.chunk, req.force, seen);
    }
    this._vehicleSweep(seen);     // clear structure just ahead of anything travelling fast enough to ram
    this._detachQueue.length = 0;
    this._flushDetach();
    this._sampleImpactorMotion(); // record this step's motion for the next step's ram gate
    return impacts;
  }

  // Every heavy impactor above the ram speed carves a small volume ahead of its nose, so a fast vehicle
  // drives into an opening rather than into a solid wall that would eat all of its momentum in one step.
  _vehicleSweep(seen) {
    if (this.heavyImpactors.size === 0) return;
    for (const h of this.heavyImpactors) {
      const col = this.world.getCollider(h);
      const body = col && col.parent();
      if (!body || !body.linvel) continue;
      // Gate on the RAM speed, not on the raw post-step velocity: drainContacts runs after world.step, so
      // the frame a car actually hits a wall its live speed already reads ~0 and the sweep that is supposed
      // to open the hole never ran. _ramSpeed keeps the approach speed for exactly that frame, and the
      // travel direction falls back to the approach direction for the same reason.
      const s = this._ramSpeed(h);
      if (s < D.vehicleMinRamSpeed) continue;
      const dir = this._impactorTravel(h);
      if (!dir) continue;
      const t = body.translation();
      const nose = new THREE.Vector3(t.x, t.y, t.z).addScaledVector(dir, D.vehicleSweepLead);
      this._sweepAt(nose, dir, seen);
    }
  }

  _sweepAt(center, dir, seen) {
    const radius = D.vehicleSweepRadius, r2 = radius * radius;
    let budget = D.vehicleSweepBudget;
    for (const vol of this.volumes) {
      if (budget <= 0) break;
      if (vol.spec.kind === "grid") continue; // structures only, never the road
      const [nx, ny, nz] = vol.dims;
      const [ox, oy, oz] = vol.origin;
      const vs = vol.vs;
      if (center.x < ox - radius || center.x > ox + nx * vs + radius) continue;
      if (center.y < oy - radius || center.y > oy + ny * vs + radius) continue;
      if (center.z < oz - radius || center.z > oz + nz * vs + radius) continue;
      for (const chunk of vol.chunks) {
        if (budget <= 0) break;
        if (!chunk.active) continue;
        if (chunk.centroid.distanceToSquared(center) > r2) continue;
        const gid = vol.id + ":" + chunk.id;
        if (seen.has(gid)) continue;
        seen.add(gid);
        const kick = dirTo(center, chunk.centroid).addScaledVector(dir, 0.6).normalize();
        this._detach(vol, chunk, kick, D.vehicleSweepForce * 0.5, D.vehiclePunchKick, true);
        budget--;
      }
    }
  }

  // Vehicle ram: detach every active chunk within `radius` of the contact (across volumes), bypassing
  // per-material thresholds so a car punches a car-sized tunnel and keeps its momentum. Deduped via `seen`,
  // capped by vehiclePunchBudget. Only ever reached from a heavy (vehicle) contact -> never a debris cascade.
  _vehiclePunch(contact, radius, force, seen, travel) {
    // Open the hole AHEAD of the impact along the vehicle's travel direction: the car meets already-empty
    // space instead of a fresh wall face, which is what lets it keep speed through house after house.
    const center = contact.clone();
    if (travel) center.addScaledVector(travel, D.vehiclePunchLead);
    const r2 = radius * radius;
    let budget = D.vehiclePunchBudget;
    const deferOwner = !this._deferTiles;
    if (deferOwner) this._deferTiles = new Set();
    for (const vol of this.volumes) {
      if (budget <= 0) break;
      if (vol.spec.kind === "grid") continue; // never carve the road out from under the car
      const [nx, ny, nz] = vol.dims;
      const [ox, oy, oz] = vol.origin;
      const vs = vol.vs;
      if (center.x < ox - radius || center.x > ox + nx * vs + radius) continue;
      if (center.y < oy - radius || center.y > oy + ny * vs + radius) continue;
      if (center.z < oz - radius || center.z > oz + nz * vs + radius) continue;
      for (const chunk of vol.chunks) {
        if (budget <= 0) break;
        if (!chunk.active) continue;
        if (chunk.centroid.distanceToSquared(center) > r2) continue;
        const gid = vol.id + ":" + chunk.id;
        if (seen.has(gid)) continue;
        seen.add(gid);
        // Hurl the rubble outward (and along travel) so it clears the car's path rather than blocking it.
        const dir = dirTo(center, chunk.centroid);
        if (travel) dir.addScaledVector(travel, 0.6).normalize();
        this._detach(vol, chunk, dir, force * 0.5, D.vehiclePunchKick, true);
        budget--;
      }
    }
    if (deferOwner) {
      const tiles = this._deferTiles;
      this._deferTiles = null;
      if (this.scene) {
        for (const key of tiles) {
          const sep = key.indexOf(":");
          const vol = this.volumes[+key.slice(0, sep)];
          if (vol) rebuildTile(vol, +key.slice(sep + 1), this.scene, this.materials);
        }
      }
    }
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

  // ---- Public debris accessors (Phase 7 batch B Grab & Force tools) ----------------------------
  // These let weapons.js query and consume debris WITHOUT reaching into private fade/interp state, and
  // they never touch allowedImpactors, so the no-cascade rule is preserved by construction.

  // Iterate live (non-fading) debris entries. Each entry exposes { vol, chunk, mesh, body }.
  forEachDebris(cb) { for (const d of this.debris) { if (!d.fading) cb(d); } }

  // Live-debris count (Debris Vacuum verification: the count actually drops as debris is consumed).
  liveDebrisCount() { let n = 0; for (const d of this.debris) if (!d.fading) n++; return n; }

  // Resolve a raycast collider handle to its live debris entry, or null if the handle is an attached
  // (fixed) chunk / not debris. Used by the Gravity Gun to grab a specific detached chunk.
  findDebrisByCollider(handle) {
    const r = this.registry.get(handle);
    if (!r || r.chunk.active) return null; // active === still attached to the structure, not debris
    for (const d of this.debris) if (!d.fading && d.chunk === r.chunk) return d;
    return null;
  }

  // Debris Vacuum consume: permanently dispose one debris entry (body + mesh + registry), freeing it
  // against the 200 cap. Mirrors the headless cull path, incl. the server debris_rm broadcast hook.
  consumeDebris(entry) {
    const i = this.debris.indexOf(entry);
    if (i < 0) return false;
    this._removeDebrisBody(entry);
    this.debris.splice(i, 1);
    this._replicaIndex = null; // invalidate the replica lookup cache
    if (this.onDebrisRemove && entry.vol && entry.chunk) this.onDebrisRemove([[entry.vol.id, entry.chunk.id]]);
    return true;
  }

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
    this._chainProps(center, radius); // Phase 7 batch C: any propane tank caught in the blast chain-reacts
    return count;
  }

  // ---- Phase 7 batch C: carve helper + painted detonation + damageable props ------------------

  // carveCylinder (subsystem A.2): stepped radial damage marched along a ray, SHARING one overall budget
  // (total detaches <= budget). Powers the Orbital Laser (vertical carve through floors) and the airstrike
  // Penetrator (carve along the descent ray). Synchronous but budget-bounded, so a thin column stays within
  // the per-frame cost even at full length; the wide nuke uses the staged radial queue instead. Authoritative
  // only — replica forwards a single (clamped) radial intent and the server owns the carve. (MP stub: flagged.)
  carveCylinder(start, dir, length, radius, forcePerStep, budget) {
    if (this.mode === "replica") {
      // MP: forward the WHOLE beam as one `dmg kind:"carve"` intent and let the server run this exact
      // function authoritatively. It used to be squashed into a single radial sphere clamped to
      // CAPS.radialForceMax (44000 < the 60000 carve force) and placed at `start` — 5 m of empty air above
      // the Orbital marker — so the server either carved nothing at all or bit one shallow crater instead
      // of a 40 m column through the floors. Everything below the cap ceilings travels intact.
      if (this.onDamageIntent) {
        const d = new THREE.Vector3(dir.x, dir.y, dir.z);
        if (d.lengthSq() < 1e-9) return 0;
        d.normalize();
        this.onDamageIntent({
          kind: "carve",
          p: { x: start.x, y: start.y, z: start.z },
          dir: { x: d.x, y: d.y, z: d.z },
          len: Math.min(length, CAPS.carveLenMax),
          radius: Math.min(radius, CAPS.carveRadiusMax),
          force: Math.min(forcePerStep, CAPS.carveForceMax),
          budget: Math.min(budget, CAPS.carveBudgetMax),
        });
      }
      return 0;
    }
    const d = new THREE.Vector3(dir.x, dir.y, dir.z);
    if (d.lengthSq() < 1e-9) return 0;
    d.normalize();
    const stepLen = Math.max(radius * 0.9, 0.4);
    const steps = Math.max(1, Math.ceil(length / stepLen));
    let remaining = budget;
    const center = new THREE.Vector3();
    const picked = [];
    const seen = new Set();
    for (let s = 0; s <= steps && remaining > 0; s++) {
      center.set(start.x + d.x * stepLen * s, start.y + d.y * stepLen * s, start.z + d.z * stepLen * s);
      this._chainProps(center, radius);
      // Capture by BOUNDING BOX, not by centroid: a 1.2 m beam has to break the chunk it passes THROUGH,
      // and a Voronoi chunk is 1.1-3.0 m across, so its centre is usually further from the axis than the
      // beam radius. `surf` is the gap between the beam axis and the chunk's box; a chunk the beam is
      // inside gets the full per-step force, one it only grazes gets a linear falloff over the radius.
      for (const cand of this._boxCandidates(center, radius + SUP.carveSurfaceSlack)) {
        if (remaining <= 0) break;
        const key = cand.vol.id + ":" + cand.chunk.id;
        if (seen.has(key)) continue;
        const f = forcePerStep * (1 - Math.min(1, cand.surf / radius));
        if (f < cand.chunk.threshold) continue;
        seen.add(key);
        picked.push({ vol: cand.vol, cid: cand.chunk.id, dir: dirTo(center, cand.chunk.centroid), force: f });
        remaining--;
      }
    }
    // A full-length column can free a couple of hundred chunks; feed anything past one frame's quota
    // through the existing staged list queue so a 40 m hole ripples instead of spiking a single frame.
    if (picked.length <= CONFIG.weapons.stageChunksPerFrame) {
      for (const it of picked) {
        const chunk = it.vol.chunks[it.cid];
        if (chunk && chunk.active) this._detach(it.vol, chunk, it.dir, it.force);
      }
      this._flushDetach();
    } else {
      this._stageJobs.push({ kind: "list", pairs: picked, i: 0 });
    }
    return picked.length;
  }

  // Is there any active STRUCTURE (non-grid) chunk within `reach` of `center`? Works in replica mode too —
  // a replica holds the same volume set as the server, it just may not detach locally. The Car Cannon uses
  // it to decide whether a carve pulse is worth one of its rate-limited slots: solo's contact/sweep path
  // deliberately never chews the road (grid volumes), and gating the MP pulse the same way keeps a flung
  // car from ploughing trenches online that it would never plough offline.
  hasStructureNear(center, reach) {
    for (const vol of this.volumes) {
      if (vol.removed || vol.spec.kind === "grid") continue;
      const [nx, ny, nz] = vol.dims;
      const [ox, oy, oz] = vol.origin;
      const vs = vol.vs;
      if (center.x < ox - reach || center.x > ox + nx * vs + reach) continue;
      if (center.y < oy - reach || center.y > oy + ny * vs + reach) continue;
      if (center.z < oz - reach || center.z > oz + nz * vs + reach) continue;
      for (const chunk of vol.chunks) {
        if (!chunk.active) continue;
        if (aabbDistance(chunk.aabb, center) <= reach) return true;
      }
    }
    return false;
  }

  // Active chunks whose world AABB is within `reach` of `center`, nearest-surface first. Shares the
  // per-volume AABB reject with _radialCandidates but measures the BOX, not the centroid.
  _boxCandidates(center, reach) {
    const out = [];
    for (const vol of this.volumes) {
      if (vol.removed) continue;
      const [nx, ny, nz] = vol.dims;
      const [ox, oy, oz] = vol.origin;
      const vs = vol.vs;
      if (center.x < ox - reach || center.x > ox + nx * vs + reach) continue;
      if (center.y < oy - reach || center.y > oy + ny * vs + reach) continue;
      if (center.z < oz - reach || center.z > oz + nz * vs + reach) continue;
      for (const chunk of vol.chunks) {
        if (!chunk.active) continue;
        const surf = aabbDistance(chunk.aabb, center);
        if (surf > reach) continue;
        out.push({ vol, chunk, surf });
      }
    }
    out.sort((a, b) => a.surf - b.surf);
    return out;
  }

  // detonatePainted (Blast Painter): direct-detach EXACTLY the given chunk ids through the normal _detach
  // path (kick + debris + tile rebuild). `keys` is an iterable of "volId:cid" strings. Staged via the
  // per-frame list queue when the set is large (>40) so a facade-sized blast ripples instead of popping.
  detonatePainted(keys, forcePerChunk) {
    if (this.mode === "replica") {
      // MP stub (flagged): forward each painted chunk as a point-dmg intent so the server detaches it.
      if (this.onDamageIntent) {
        for (const key of keys) {
          const i = key.indexOf(":"); if (i < 0) continue;
          const vid = +key.slice(0, i), cid = +key.slice(i + 1);
          const vol = this.volumes[vid]; const chunk = vol && vol.chunks[cid];
          if (chunk) this.onDamageIntent({ kind: "point", vol: vid, cid, src: chunk.centroid, force: Math.min(forcePerChunk, CAPS.pointForceMax) });
        }
      }
      return 0;
    }
    const pairs = [];
    for (const key of keys) {
      const i = key.indexOf(":"); if (i < 0) continue;
      const vid = +key.slice(0, i), cid = +key.slice(i + 1);
      const vol = this.volumes[vid]; if (!vol) continue;
      const chunk = vol.chunks[cid];
      if (!chunk || !chunk.active) continue;
      pairs.push({ vol, cid, dir: this._outwardDir(vol, chunk), force: forcePerChunk });
    }
    if (pairs.length <= CONFIG.weapons.stageChunksPerFrame) {
      for (const it of pairs) {
        const ch = it.vol.chunks[it.cid];
        if (ch && ch.active) this._detach(it.vol, ch, it.dir, it.force);
      }
      this._flushDetach();
    } else {
      this._stageJobs.push({ kind: "list", pairs, i: 0 });
    }
    return pairs.length;
  }

  // Outward kick direction for a painted chunk (away from its volume centre; falls back to up).
  _outwardDir(vol, chunk) {
    const [nx, ny, nz] = vol.dims; const [ox, oy, oz] = vol.origin; const vs = vol.vs;
    const cx = ox + nx * vs * 0.5, cy = oy + ny * vs * 0.5, cz = oz + nz * vs * 0.5;
    const v = new THREE.Vector3(chunk.centroid.x - cx, chunk.centroid.y - cy, chunk.centroid.z - cz);
    if (v.lengthSq() < 1e-6) return new THREE.Vector3(0, 1, 0);
    return v.normalize();
  }

  // Register/unregister a damageable prop (propane tank). rec must expose pos()/explode()/chainR.
  registerDamageableProp(handle, rec) { this.damageableProps.set(handle, rec); }
  unregisterDamageableProp(handle) { this.damageableProps.delete(handle); }

  // Schedule chain-reaction explosions for any live prop within a blast radius, one beat apart so chains
  // ripple (never a single-frame cascade). Called on every radial/carve damage. Authoritative only.
  _chainProps(center, radius) {
    if (this.damageableProps.size === 0) return;
    for (const rec of this.damageableProps.values()) {
      if (rec.exploded || rec.queued) continue;
      const p = rec.pos();
      if (!p) continue;
      const dx = p.x - center.x, dy = p.y - center.y, dz = p.z - center.z;
      const rr = radius + (rec.chainR || 0);
      if (dx * dx + dy * dy + dz * dz <= rr * rr) {
        rec.queued = true;
        this._propChain.push({ rec, at: this._time + CONFIG.weapons.propChainDelay });
      }
    }
  }

  _drainPropChain() {
    if (this._propChain.length === 0) return;
    const keep = [];
    const due = [];
    for (const item of this._propChain) { if (this._time >= item.at) due.push(item); else keep.push(item); }
    this._propChain = keep;
    for (const item of due) if (!item.rec.exploded) item.rec.explode();
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
      if (job.kind === "list") {
        // Blast-painter staged detonation: detach exactly the queued chunk ids, budget-paced per frame.
        while (job.i < job.pairs.length && quota > 0) {
          const it = job.pairs[job.i++];
          const chunk = it.vol.chunks[it.cid];
          if (!chunk || !chunk.active) continue;
          this._detach(it.vol, chunk, it.dir, it.force); // clears chunk.falling
          quota--;
        }
        if (job.i >= job.pairs.length) for (const it of job.pairs) { const c = it.vol.chunks[it.cid]; if (c) c.falling = false; }
        if (job.i >= job.pairs.length) this._stageJobs.shift();
        continue;
      }
      if (!job.cands) { job.cands = this._radialCandidates(job.center, job.radius); this._chainProps(job.center, job.radius); }
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

  // Ram speed for the gate. drainContacts runs AFTER world.step, by which point the wall has already
  // stopped the car — so the current velocity reads ~0 on the very frame of impact. Use the greater of
  // the current speed and the speed sampled on the previous step (the approach speed).
  _ramSpeed(handle) {
    const prev = this._motionPrev.get(handle);
    return Math.max(this._impactorSpeed(handle), prev ? prev.s : 0);
  }

  // Snapshot the motion of every heavy impactor, so the next step can read the pre-collision approach.
  _sampleImpactorMotion() {
    for (const h of this.heavyImpactors) this._sampleOne(h);
    for (const h of this._motionPrev.keys()) if (!this.heavyImpactors.has(h)) this._motionPrev.delete(h);
  }

  _sampleOne(h) {
    const col = this.world.getCollider(h);
    const body = col && col.parent();
    if (!body || !body.linvel) { this._motionPrev.delete(h); return; }
    const v = body.linvel();
    const s = Math.hypot(v.x, v.y, v.z);
    this._motionPrev.set(h, s > 1e-3 ? { s, dx: v.x / s, dy: v.y / s, dz: v.z / s } : { s: 0, dx: 0, dy: 0, dz: 0 });
  }

  // Speed (m/s) of an impactor body; 0 when it has no parent body.
  _impactorSpeed(handle) {
    const col = this.world.getCollider(handle);
    const body = col && col.parent();
    if (!body || !body.linvel) return 0;
    const v = body.linvel();
    return Math.hypot(v.x, v.y, v.z);
  }

  // Normalised travel direction of an impactor body (null when parked/too slow to imply a direction).
  // Mirrors _ramSpeed: whichever of the live and the remembered motion is FASTER wins. Taking the live
  // direction unconditionally was wrong for the frame of a hard impact — a body that spawned touching a
  // wall is ejected backwards by penetration recovery, so the live direction points away from the wall
  // and the sweep opened its hole behind the car instead of in front of it.
  _impactorTravel(handle) {
    const col = this.world.getCollider(handle);
    const body = col && col.parent();
    const p = this._motionPrev.get(handle);
    let live = null, liveS = 0;
    if (body && body.linvel) {
      const v = body.linvel();
      liveS = Math.hypot(v.x, v.y, v.z);
      if (liveS >= 1) live = new THREE.Vector3(v.x / liveS, v.y / liveS, v.z / liveS);
    }
    if (p && p.s >= 1 && p.s > liveS) return new THREE.Vector3(p.dx, p.dy, p.dz);
    return live;
  }

  // Flip a chunk to a dynamic debris body + kick. gfx: mesh it + rebuild tiles. Headless: physics only.
  // Always records an onDetach event (server broadcasts it). Never called in replica mode.
  _detach(vol, chunk, dir, force, kickScale = 1, lighten = false) {
    chunk.active = false;
    chunk.falling = false; // it is leaving now: clear any queued gravity collapse for this chunk
    this._markSupportDirty(vol, chunk); // whatever was leaning on it is re-checked next update()
    chunk.detachSeq = ++this._detachSeq; // damage age for the Rebuild Gun (oldest-damage-first restore)
    chunk.body.setBodyType(this.RAPIER.RigidBodyType.Dynamic, true);
    // Rammed-out rubble is re-densitied so a ploughing vehicle bats it aside instead of being stopped by
    // tonnes of full-density chunks. Purely a mass change — visuals/colliders are unchanged.
    if (lighten) {
      const col = this.world.getCollider(chunk.colliderHandle);
      if (col && col.setDensity) col.setDensity(D.vehicleDebrisDensity);
    }
    const c = chunk.centroid;
    let mag = D.detachKick * force * CONFIG.fixedDt;
    mag = Math.min(mag, 400) * kickScale;
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

    // Tile re-meshing: during a big vehicle punch this is deferred and flushed once (one rebuild per
    // touched tile instead of one per chunk), which keeps a 120-chunk punch off the frame budget.
    if (this.scene) {
      if (this._deferTiles) for (const tid of chunk.tileIds) this._deferTiles.add(vol.id + ":" + tid);
      else for (const tid of chunk.tileIds) rebuildTile(vol, tid, this.scene, this.materials);
    }

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

  // ================= Structural support propagation (authoritative only) =========================
  //
  // A chunk stays a FIXED body only while it is connected — through other still-attached chunks — to
  // something that counts as ground. Knock the trunk out of a tree, the bottom row out of a wall or the
  // base off a lamp post and everything above it loses that connection and falls under gravity.
  //
  // The graph has three kinds of edge / seed:
  //   1. intra-volume: the 6-connected `neighbors` set buildVolume already computes.
  //   2. cross-volume: two chunks of DIFFERENT volumes whose world AABBs are within SUP.contactEps of
  //      each other on every axis (so: resting on, abutting, or interpenetrating). This is what carries
  //      support from a tree canopy volume down through its separate trunk volume, or from a roof volume
  //      down through the wall volumes it sits on. Built ONCE at load via an XZ spatial hash.
  //   3. roots: every chunk of a kind:"grid" volume (the terrain is held up by the indestructible core,
  //      never by other chunks), any chunk whose box bottom sits at/below SUP.rootY (i.e. on the core),
  //      and — see _seedRoots — anything that is already unsupported when the map loads.
  //
  // Grid volumes are roots and link targets but never conduits: two buildings standing on the same street
  // are NOT one structure, which is what keeps the incremental re-flood small. Non-grid volumes joined by
  // cross-volume contacts form a "support group" (one building + its roof + its porch), and a detach only
  // re-floods the groups it touched.
  //
  // Honest limitations:
  //   * The graph is CONNECTIVITY, not statics. A chunk hanging off the side of a supported chunk counts
  //     as supported, and an overhang never snaps under its own weight. Same approximation the existing
  //     intra-volume neighbour graph already made.
  //   * Contacts are tested between chunk BOUNDING BOXES with a 0.2 m tolerance, so two chunks whose
  //     boxes nearly touch are treated as joined even if their voxels do not. The error is always toward
  //     stability (something stands that maybe should not), never toward a spurious collapse.
  //   * Anything that is already unsupported at load stays a permanent root, so a map's deliberately
  //     floating decor never rains down on load — but it also never falls later.

  // Build the whole graph once. Called lazily from the first update(), by which point every map volume
  // has been added. gfx-free: pure numbers, so the headless server runs it identically.
  _buildSupport() {
    this._supportReady = true;
    if (this.mode === "replica") return; // replicas follow the server's detach messages, they never decide
    const t0 = nowMs();
    this._supportHash = new Map();
    for (const vol of this.volumes) this._linkVolume(vol);
    this._seedRoots(this.volumes);
    this.stats.ms.support = nowMs() - t0;
  }

  // Hash one volume's chunks into the XZ grid and link them to every already-hashed chunk they touch.
  _linkVolume(vol) {
    if (vol.removed) return;
    const hash = this._supportHash || (this._supportHash = new Map());
    const cs = SUP.cellSize, eps = SUP.contactEps;
    for (const chunk of vol.chunks) {
      const a = chunk.aabb;
      if (a.miny <= SUP.rootY) chunk.supportRoot = true; // standing on the indestructible core
      const cx0 = Math.floor((a.minx - eps) / cs), cx1 = Math.floor((a.maxx + eps) / cs);
      const cz0 = Math.floor((a.minz - eps) / cs), cz1 = Math.floor((a.maxz + eps) / cs);
      const hit = new Set();
      for (let cz = cz0; cz <= cz1; cz++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const bucket = hash.get(cx + "," + cz);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other.vol === vol || hit.has(other.chunk)) continue;
            hit.add(other.chunk);
            if (!aabbTouch(a, other.chunk.aabb, eps)) continue;
            (chunk.links || (chunk.links = [])).push({ vol: other.vol, cid: other.chunk.id });
            (other.chunk.links || (other.chunk.links = [])).push({ vol, cid: chunk.id });
            this.stats.supportLinks++;
            if (vol.spec.kind !== "grid" && other.vol.spec.kind !== "grid") mergeSupportGroups(vol, other.vol);
          }
        }
      // Insert after querying so a volume never links to itself.
      for (let cz = cz0; cz <= cz1; cz++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = cx + "," + cz;
          let bucket = hash.get(key);
          if (!bucket) { bucket = []; hash.set(key, bucket); }
          bucket.push({ vol, chunk });
        }
    }
  }

  // Flood every group these volumes belong to with the CURRENT active set and promote whatever is not
  // reached to a permanent root. Run once after the initial build (so a pristine map detaches nothing)
  // and once per volume added later (foam blobs).
  _seedRoots(vols) {
    const groups = new Set();
    for (const vol of vols) if (vol.supportGroup) groups.add(vol.supportGroup);
    for (const g of groups) {
      const orphans = [];
      this._floodGroup(g, orphans);
      for (const o of orphans) { o.chunk.supportRoot = true; this.stats.supportRoots++; }
    }
  }

  // Mark every support group affected by a chunk leaving the structure.
  _markSupportDirty(vol, chunk) {
    if (!this._supportReady) return;
    if (vol.supportGroup) this._supportDirty.add(vol.supportGroup);
    if (chunk.links) for (const l of chunk.links) if (l.vol.supportGroup) this._supportDirty.add(l.vol.supportGroup);
  }

  // Re-flood the dirty groups and let go of everything that is no longer connected to ground.
  // Small collapses drop immediately; a toppling tower is fed through the staged list queue so it ripples
  // over a few frames. Every fall goes through _detach, so debris bookkeeping, the 200 cap, the sleep-cull
  // and the MP detach broadcast all keep working, and no falling debris ever triggers a contact detach.
  _settleSupport() {
    if (this.mode === "replica" || this._supportDirty.size === 0) return;
    const groups = Array.from(this._supportDirty);
    this._supportDirty.clear();
    const fallen = [];
    for (const g of groups) this._floodGroup(g, fallen);
    if (fallen.length === 0) return;
    if (fallen.length <= SUP.collapseInlineMax) {
      for (const f of fallen) {
        if (!f.chunk.active) continue;
        this._detach(f.vol, f.chunk, DOWN, SUP.collapseForce);
      }
      this._flushDetach();
      return;
    }
    const pairs = [];
    for (const f of fallen) { f.chunk.falling = true; pairs.push({ vol: f.vol, cid: f.chunk.id, dir: DOWN, force: SUP.collapseForce }); }
    this._stageJobs.push({ kind: "list", pairs, i: 0 });
  }

  // Flood one support group from its roots; push every active, unreached chunk into `out`.
  _floodGroup(group, out) {
    const stamp = ++this._supportStamp;
    const stack = [];
    let visited = 0;
    const push = (vol, chunk) => {
      if (chunk.sv === stamp) return;
      chunk.sv = stamp;
      stack.push(vol, chunk);
    };
    for (const vol of group) {
      if (vol.removed) continue;
      for (const chunk of vol.chunks) {
        if (!chunk.active || chunk.falling) continue;
        if (chunk.supportRoot) { push(vol, chunk); continue; }
        if (!chunk.links) continue;
        for (const l of chunk.links) {
          // Sitting on live terrain is ground. (Grid chunks are roots but never conduits.)
          if (l.vol.spec.kind === "grid" && l.vol.chunks[l.cid].active) { push(vol, chunk); break; }
        }
      }
    }
    while (stack.length && visited < SUP.passChunkCap) {
      const chunk = stack.pop();
      const vol = stack.pop();
      visited++;
      for (const nid of chunk.neighbors) {
        const nc = vol.chunks[nid];
        if (nc && nc.active && !nc.falling) push(vol, nc);
      }
      if (chunk.links) for (const l of chunk.links) {
        if (l.vol.spec.kind === "grid" || l.vol.removed) continue;
        const nc = l.vol.chunks[l.cid];
        if (nc && nc.active && !nc.falling) push(l.vol, nc);
      }
    }
    if (visited >= SUP.passChunkCap) return; // bailed out: keep everything standing rather than guess
    for (const vol of group) {
      if (vol.removed) continue;
      for (const chunk of vol.chunks) {
        if (!chunk.active || chunk.falling) continue;
        if (chunk.sv !== stamp) out.push({ vol, chunk });
      }
    }
  }

  // ---- Phase 7 batch D: constructive-voxel subsystem B (Rebuild Gun + Foam Cannon) ------------

  // reattachChunk (Rebuild Gun): the exact INVERSE of _detach. Snap an inactive chunk back into the
  // structure as a FIXED body at its original centroid/orientation, re-register its collider, rebuild the
  // owning tiles. Works whether the flying/settled debris body still exists OR already despawned — only the
  // original vol.idx / chunkOf / centroid is needed. Authoritative-only: on a replica the server owns
  // reattach (it mirrors detach events on the same channel — flagged MP stub, see the batch D report).
  reattachChunk(vol, chunk) {
    if (this.mode === "replica") return false;
    if (!chunk || chunk.active) return false;
    // If the debris body for this chunk is still alive, dispose it (body + mesh + registry entry).
    const di = this.debris.findIndex((d) => d.chunk === chunk);
    if (di >= 0) {
      this._removeDebrisBody(this.debris[di]); // deletes registry[colliderHandle] + removes body/mesh
      this.debris.splice(di, 1);
      this._replicaIndex = null;
    } else {
      // Debris already despawned: its body/registry are gone. Nothing to remove — just resurrect the chunk.
      this.registry.delete(chunk.colliderHandle); // idempotent safety
    }
    chunk.mesh = null;
    createChunkBody(vol, chunk, this); // fresh FIXED body + collider + registry entry at the original centroid
    chunk.active = true;
    chunk.falling = false;
    chunk.detachSeq = undefined;
    this._markSupportDirty(vol, chunk); // a restored chunk can hold its neighbours up again
    if (this.scene) for (const tid of chunk.tileIds) rebuildTile(vol, tid, this.scene, this.materials);
    return true;
  }

  // Foam Cannon adds new volumes via addVolume(); despawnVolume retires the oldest hardened foam blob when
  // the live-foam cap is hit. Removes this volume's debris + chunk bodies + colliders + tile meshes and marks
  // the volume a husk (id preserved so no reindex). resetAll/snapshot skip husks (vol.removed).
  despawnVolume(vol) {
    if (!vol || vol.removed) return;
    this.debris = this.debris.filter((d) => {
      if (d.vol === vol) { this._removeDebrisBody(d); return false; }
      return true;
    });
    this._replicaIndex = null;
    for (const chunk of vol.chunks) {
      this.registry.delete(chunk.colliderHandle); // idempotent (debris path may have removed it already)
      if (chunk.active && chunk.body) { try { this.world.removeRigidBody(chunk.body); } catch (e) {} }
      if (chunk.active) this._markSupportDirty(vol, chunk); // anything leaning on the husk re-checks
      chunk.active = false;
      chunk.falling = false;
      chunk.body = null;
    }
    if (this.scene) for (const tile of vol.tiles) {
      if (tile.mesh) { this.scene.remove(tile.mesh); tile.mesh.geometry.dispose(); tile.mesh = null; }
    }
    vol.removed = true;
  }

  // Public wrapper: build a centered geometry for one chunk (used by the Rebuild Gun's ghost preview).
  chunkGeometry(vol, chunk) { return meshChunk(vol, chunk); }

  // Rebuild Gun target scan: pick the inactive chunk to restore next. The nearest inactive chunk to the aim
  // point selects the target VOLUME (so a hole heals as one structure); within that volume, restore
  // oldest-damage-first (smallest chunk.detachSeq) among inactive chunks whose centroid is within `radius`
  // of the aim point. `isBusy(vol,chunk)` skips chunks already queued as ghosts. Returns { vol, chunk } | null.
  rebuildCandidate(aim, radius, isBusy) {
    if (this.mode === "replica") return null;
    let target = null, bestD = Infinity;
    for (const vol of this.volumes) {
      if (vol.removed) continue;
      for (const chunk of vol.chunks) {
        if (chunk.active) continue;
        if (isBusy && isBusy(vol, chunk)) continue;
        const d = chunk.centroid.distanceTo(aim);
        if (d < bestD) { bestD = d; target = vol; }
      }
    }
    if (!target || bestD > radius) return null;
    let pick = null, pickSeq = Infinity;
    for (const chunk of target.chunks) {
      if (chunk.active) continue;
      if (isBusy && isBusy(target, chunk)) continue;
      if (chunk.centroid.distanceTo(aim) > radius) continue;
      const seq = chunk.detachSeq != null ? chunk.detachSeq : 0;
      if (seq < pickSeq) { pickSeq = seq; pick = chunk; }
    }
    return pick ? { vol: target, chunk: pick } : null;
  }

  // Size Ray: replace a DEBRIS chunk's collider with a scaled cuboid (Rapier colliders don't rescale in
  // place). Keeps the same dynamic body (velocity preserved); density is constant so mass ~ scale^3. Updates
  // the registry so debris lookups (vacuum/gravity/size) keep resolving. `half` = target half-extents (m).
  rescaleDebris(entry, half, center, scale) {
    if (!entry || !entry.chunk || !entry.body) return false;
    const chunk = entry.chunk;
    // Remember the untouched mass once: the chunk starts life on a convex HULL of its voxels but is
    // rescaled into a bounding CUBOID, so keeping the density constant would jump the mass by ~30% on the
    // first zap alone. Targeting baseMass * scale^3 makes the mass follow the visible size exactly.
    if (entry.baseMass == null) entry.baseMass = entry.body.mass();
    const oldH = chunk.colliderHandle;
    const oldCol = this.world.getCollider(oldH);
    this.registry.delete(oldH);
    if (oldCol) { try { this.world.removeCollider(oldCol, true); } catch (e) {} }
    const density = (entry.vol && entry.vol.spec) ? entry.vol.spec.density : 1000;
    const cd = this.RAPIER.ColliderDesc.cuboid(Math.max(half.x, 0.02), Math.max(half.y, 0.02), Math.max(half.z, 0.02))
      .setDensity(density).setFriction(D.friction).setRestitution(D.restitution);
    if (center) cd.setTranslation(center.x, center.y, center.z);
    const col = this.world.createCollider(cd, entry.body);
    chunk.colliderHandle = col.handle;
    this.registry.set(col.handle, { volume: entry.vol, chunk });
    const recompute = typeof entry.body.recomputeMassPropertiesFromColliders === "function";
    if (recompute) { try { entry.body.recomputeMassPropertiesFromColliders(); } catch (e) {} }
    if (recompute && scale > 0 && entry.baseMass > 0) {
      const want = entry.baseMass * scale * scale * scale;
      const got = entry.body.mass();
      if (got > 1e-6 && col.setDensity) {
        try { col.setDensity(density * (want / got)); entry.body.recomputeMassPropertiesFromColliders(); } catch (e) {}
      }
    }
    return true;
  }

  // ---- Phase 7 batch D, MP: shared helpers for the server-authoritative builder tools ----------

  // Local half-extents + centre offset of a chunk at `scale`, computed from the voxel AABB instead of from
  // a THREE bounding box. meshChunk() builds its geometry over exactly [aabb.min .. aabb.max] translated by
  // -centroid, so this is numerically the same box the solo Size Ray reads off the mesh — the headless
  // server has no meshes and needs it anyway.
  chunkHalfCenter(chunk, scale) {
    const a = chunk.aabb, c = chunk.centroid;
    return {
      half: {
        x: Math.max((a.maxx - a.minx) / 2, 0.02) * scale,
        y: Math.max((a.maxy - a.miny) / 2, 0.02) * scale,
        z: Math.max((a.maxz - a.minz) / 2, 0.02) * scale,
      },
      center: {
        x: ((a.maxx + a.minx) / 2 - c.x) * scale,
        y: ((a.maxy + a.miny) / 2 - c.y) * scale,
        z: ((a.maxz + a.minz) / 2 - c.z) * scale,
      },
    };
  }

  // Live (non-fading) debris entry by the wire identity every MP message uses. Works in both modes.
  findDebrisByRef(volIdx, cid) {
    for (const d of this.debris) {
      if (d.fading) continue;
      if (d.vol.id === volIdx && d.chunk.id === cid) return d;
    }
    return null;
  }

  // Replica mirror of reattachChunk: the server has decided this chunk is whole again, so drop the
  // kinematic debris body and put a fresh FIXED chunk body back at the original centroid. Returns true if
  // anything changed, so replication can play the settle sound only for real restores.
  applyReattach(volIdx, cid) {
    const vol = this.volumes[volIdx];
    if (!vol || vol.removed) return false;
    const chunk = vol.chunks[cid];
    if (!chunk || chunk.active) return false;
    const di = this.debris.findIndex((d) => d.chunk === chunk);
    if (di >= 0) {
      this._removeDebrisBody(this.debris[di]);
      this.debris.splice(di, 1);
    } else {
      this.registry.delete(chunk.colliderHandle);
    }
    this._replicaIndex = null;
    chunk.mesh = null;
    createChunkBody(vol, chunk, this);
    chunk.active = true;
    chunk.falling = false;
    chunk.detachSeq = undefined;
    if (this.scene) for (const tid of chunk.tileIds) rebuildTile(vol, tid, this.scene, this.materials);
    return true;
  }

  // Build a foam volume at the index the SERVER assigned. Volume identity is the array index and the whole
  // detach/debris protocol is keyed on it, so a foam blob landing in a different slot on two peers would
  // corrupt every later detach. The server is the only allocator; clients call this with its number and
  // pad any gap with husks (see addHuskVolume) so the slot arithmetic can never drift. Returns the volume
  // or null when the index is already occupied (which would be a protocol bug worth shouting about).
  addVolumeAt(index, spec) {
    if (!Number.isInteger(index) || index < 0) return null;
    while (this.volumes.length < index) this.addHuskVolume();
    if (this.volumes.length !== index) return null;
    return this.addVolume(spec);
  }

  // Reserve one volume index without building anything. A late joiner needs the indices of foam blobs that
  // were already evicted by the live-foam cap, but not their geometry — a husk keeps the numbering aligned
  // for a fraction of the cost. Shaped so every `vol.removed` guard and every bare `vol.chunks` loop in
  // this file walks straight past it.
  // `index`, when given, is the slot this husk must land in: any earlier gap is padded first, and a slot
  // that is somehow already taken is left alone (returns null) rather than silently shifting everything.
  addHuskVolume(index) {
    if (Number.isInteger(index)) {
      while (this.volumes.length < index) this.addHuskVolume();
      if (this.volumes.length !== index) return null;
    }
    const vol = {
      id: this.volumes.length, spec: { kind: "single" }, dims: [0, 0, 0], vs: 1, origin: [0, 0, 0],
      idx: null, chunkOf: null, palette: [], materialClass: "foam", chunks: [], threshold: 0,
      tiles: [], tileCountX: 0, tileCountZ: 0, voxelsPerTile: 0, voxelsPerTileZ: 0,
      scene: null, materials: null, supportGroup: null, removed: true,
    };
    this.volumes.push(vol);
    return vol;
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
    if (!this._supportReady) this._buildSupport(); // one-shot: every map volume is in by the first frame
    if (this.mode === "replica") return this._updateReplica(dt);
    this._drainPropChain(); // Phase 7 batch C: fire scheduled propane chain reactions (one beat apart)
    this._settleSupport();  // let go of anything that lost its connection to the ground last frame
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
      if (vol.removed) continue; // Phase 7 batch D: removed foam husk isn't part of the world snapshot
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
      if (vol.removed) continue; // Phase 7 batch D: despawned foam husk stays gone across a reset
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

// Volume spec for one hardened Foam Cannon blob. Single source of truth on purpose: solo, the headless
// server and every replica all build the volume from this, so a foam blob is byte-identical everywhere and
// its Voronoi partition (seeded by mapId + volume index) yields the same chunk ids on every peer.
// `originCells` / `dims` are in foam-lattice cells; `fill(x,y,z)` returns 1 for an occupied local voxel.
export function foamVolumeSpec(originCells, dims, fill) {
  const cell = CONFIG.weapons.foam.cell;
  const D_ = CONFIG.destruction;
  return {
    name: "foam", voxelSize: cell, dims: [dims[0], dims[1], dims[2]],
    origin: [originCells[0] * cell, originCells[1] * cell, originCells[2] * cell],
    palette: [
      { color: "#e6eaec", roughness: 0.95, metalness: 0.0 },
      { color: "#c6cace", roughness: 0.95, metalness: 0.0 },
    ],
    fill,
    density: D_.density.foam, threshold: D_.forceThreshold.foam, chunkSize: D_.matChunkSize.foam,
    kind: "single", materialClass: "foam",
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }
function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function nowMs() { return typeof performance !== "undefined" ? performance.now() : Date.now(); }

// Shared "just let go" direction for a gravity collapse (the impulse magnitude is ~0, see SUP.collapseForce).
const DOWN = new THREE.Vector3(0, -1, 0);

// Distance from a point to an axis-aligned box (0 when the point is inside).
function aabbDistance(a, p) {
  const dx = Math.max(a.minx - p.x, 0, p.x - a.maxx);
  const dy = Math.max(a.miny - p.y, 0, p.y - a.maxy);
  const dz = Math.max(a.minz - p.z, 0, p.z - a.maxz);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Two boxes are structurally joined when they overlap, abut or sit within `eps` on EVERY axis.
function aabbTouch(a, b, eps) {
  return Math.max(a.minx - b.maxx, b.minx - a.maxx) <= eps
    && Math.max(a.miny - b.maxy, b.miny - a.maxy) <= eps
    && Math.max(a.minz - b.maxz, b.minz - a.maxz) <= eps;
}

// Union the support groups of two volumes joined by a cross-volume contact (groups stay tiny — one
// building — so rewriting the smaller set on merge is cheaper than a full union-find).
function mergeSupportGroups(a, b) {
  if (a.supportGroup === b.supportGroup) return;
  let keep = a.supportGroup, drop = b.supportGroup;
  if (drop.size > keep.size) { const t = keep; keep = drop; drop = t; }
  for (const v of drop) { keep.add(v); v.supportGroup = keep; }
}

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
    // Support group: the set of non-grid volumes this one is structurally joined to (one building + its
    // roof + its porch). Grid volumes are roots, never conduits, so they never join a group.
    supportGroup: null,
  };
  if (!gridKind) { vol.supportGroup = new Set(); vol.supportGroup.add(vol); }

  // Build chunks: geometry-free bodies + colliders (fixed). Stats tallied ONLY here (build time).
  t0 = now();
  const nxy = nx * ny;
  for (let cid = 0; cid < chunkVoxels.length; cid++) {
    const vox = chunkVoxels[cid];
    let sx = 0, sy = 0, sz = 0;
    let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
    const tileIds = new Set();
    for (let i = 0; i < vox.length; i++) {
      const li = vox[i];
      const x = li % nx, y = (li / nx | 0) % ny, z = (li / nxy) | 0;
      sx += ox + (x + 0.5) * vs; sy += oy + (y + 0.5) * vs; sz += oz + (z + 0.5) * vs;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
      if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
      tileIds.add(tileOf(x, z));
    }
    const inv = 1 / vox.length;
    const centroid = new THREE.Vector3(sx * inv, sy * inv, sz * inv);
    // World AABB of the chunk's voxels. Used by the carve capture test and by the support contact graph;
    // both need the chunk's EXTENT, which the centroid alone cannot give.
    const aabb = {
      minx: ox + bx0 * vs, maxx: ox + (bx1 + 1) * vs,
      miny: oy + by0 * vs, maxy: oy + (by1 + 1) * vs,
      minz: oz + bz0 * vs, maxz: oz + (bz1 + 1) * vs,
    };

    const chunk = {
      id: cid, voxels: vox, centroid, aabb, body: null, colliderHandle: -1,
      active: true, tileIds, neighbors: new Set(), threshold: spec.threshold, mesh: null,
      // Support graph: cross-volume contacts, "held up by the core / as-built floater" flag, queued-fall
      // flag and the flood-fill visit stamp.
      links: null, supportRoot: false, falling: false, sv: 0,
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
    // Fire events down to a low floor so slower vehicle rams still register; the actual detach is gated
    // per-impactor in drainContacts (vehicles = fragile, player = full material threshold).
    .setContactForceEventThreshold(Math.min(spec.threshold, D.vehicleEventFloor));

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
