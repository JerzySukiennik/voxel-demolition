# Voxel Demolition — Phase 7 build prompt (for Claude Fable 5)

This continues **Voxel Demolition**, a Teardown-inspired voxel destruction sandbox. **Phases 1-3 are already built and approved** (plaza + destruction system, the first 4 weapons, the vehicle roster), and depending on when this prompt is run, Phases 4-6 (maps, lobby, multiplayer) may or may not exist yet. Build directly on top of the existing codebase — do not rewrite it.

Your job now is **Phase 7: expanding the tool roster by 21 developer-requested weapons/tools** (bringing the roster from 4 to 25, out of the ~30 long-term target). This is a big phase, so it is explicitly split into **4 sub-batches with a stop-and-review checkpoint after each** — build batch A, stop and report, wait for approval, then batch B, and so on. Do not build all 21 in one uninterrupted run.

## Context: the systems you're plugging into (ground truth, read the code first)

- **`src/destruction.js`** — pre-fracture Voronoi chunk system. Every destructible volume is pre-cut into chunks at load; chunks start as **fixed** Rapier bodies and flip to **dynamic** on detach (`_detach`), with impulse kick, per-chunk debris mesh, and tile-mesh rebuild (`rebuildTile`). Public API you extend, never bypass:
  - `applyPointDamage(colliderHandle, sourcePos, force)` — single chunk + neighbor ring past the threshold multiplier (melee, shotgun).
  - `applyRadialDamage(center, force, radius, budget)` — nearest-first detach within radius, linear falloff, capped by `budget` (C4, rocket; current budget `CONFIG.weapons.explosionDetachBudget = 60`).
  - `allowedImpactors` — **only registered handles (player, vehicles) may trigger contact-based detach. Falling debris must NEVER cascade** — this is a hard project rule learned from a Phase 2 playtest where a debris cascade ate the whole map. Nothing you add may violate it.
  - Debris hygiene: hard cap (`debrisCap = 200`), sleep-cull, fade-out removal. All new tools must live inside this budget, not around it.
- **`src/weapons.js`** — the tool selection state machine and viewmodel rig. Categories are number keys `1`-`4` (currently Melee / Explosives / Firearms / Launchers, one item each); pressing the same number again or scrolling the wheel cycles within the category; `5`-`9` are reserved — this phase claims `5`-`7`. Each item is `{ id, name, kind, mesh, baseOffset, muzzleLen, armsOffset, state }` built in `_buildItems()`; firing dispatches on `item.kind` in `_handleFire(lmb, rmb)`. Shared voxel first-person arms, equip animation, recoil, pooled tracers/flash/trails. **Follow this exact pattern for every new tool**: new `kind`, new entry in the defs table, new voxel held-model in `assets/models/tools.js`, tuning constants in `CONFIG.weapons`.
- **`src/config.js`** — every tuning number lives in `CONFIG`. No magic numbers in logic files.
- **Audio (hard project rule):** ALL sounds are **real CC0 audio files fetched from the internet at build time and committed into `assets/audio/`** — zero procedural/WebAudio synthesis, zero runtime hotlinks (the game must work offline/LAN). Every new tool sound in this phase follows that rule.
- **UI (hard project rule):** minimal HUD — the **crosshair dot** and the **fading tool-name label** are the only always-available HUD elements. Menus/overlays are allowed only where this prompt explicitly grants them. Any new selection UI must reuse the existing same-key/scroll cycling pattern, not invent new widgets.
- **Phase-robustness:** vehicles from Phase 3 exist. Maps (Phase 4), lobby (Phase 5) and multiplayer (Phase 6) **may not exist yet** — every tool below must work fully on whatever maps exist at build time, and any player-affecting behavior (e.g. sticky bombs sticking to *players*, wind pushing *other* players) applies only to entities that actually exist: implement it against the local player + any remote-player representation present, and degrade gracefully (skip, don't crash) when there's only one player. If Phase 6 IS already built, every tool must run through the server-authoritative destruction path like the existing four; per-tool multiplayer notes are flagged below.

## Two new shared subsystems (build once, in batch order, reuse everywhere)

### A. Damage-shape helpers + material multipliers (needed from batch A)

1. **Per-material damage multipliers.** Volumes already have palette/material identity (wood crates vs. concrete wall vs. metal). Add an optional per-tool multiplier table: when a tool applies damage to a chunk, the effective force is `force * toolMultiplier[materialClass]`. Tag each destructible volume spec with a coarse `materialClass` (`wood | concrete | metal | dirt` is enough — default `concrete`). This powers the chainsaw (strong vs. wood, weak vs. concrete/metal) and crowbar without forking the damage API. Keep it a thin lookup inside `applyPointDamage`/`applyRadialDamage` (extra optional param or per-call options object), defaulting to 1.0 so all existing callers behave byte-identically.
2. **`carveCylinder(start, dir, length, radius, forcePerStep, budgetPerStep)` helper** in destruction.js: repeated `applyRadialDamage` calls stepped along a ray, sharing one overall budget. Powers the orbital laser (vertical carve through floors) and airstrike penetrating ordnance (carve along the descent ray). Spread the steps across frames if the total step count is large (see the staged-detach rule under Nuke).
3. **Staged detach queue.** For huge blasts (Nuke, big airstrike ordnance), never detach hundreds of chunks in one frame. Add a small scheduler in destruction.js that accepts a list of pending radial-damage jobs and drains N chunks' worth per frame (configurable, e.g. 40/frame) until done. Visually this reads as a collapse rippling outward — which looks *better* than an instant pop, and keeps frame time sane on the 2019 Intel MBP target.

### B. Constructive voxels (needed from batch D; design for it earlier, build it in batch D)

Foam Cannon and Rebuild Gun *add* matter, which the current system can't do. Build ONE shared subsystem for both:
- **Rebuild Gun is re-attachment, not new geometry:** a volume's original voxel layout is already known (`vol.idx`, `chunkOf`, chunk list). Restoring means: pick detached (inactive) chunks of the aimed volume near the aim point, remove their debris entry (or, if the debris body already faded/despawned, just resurrect the chunk), snap the body back to a **fixed** body at the original centroid/orientation, set `chunk.active = true`, re-register the collider, and `rebuildTile` the affected tiles. No new voxel data needed — it's the inverse of `_detach`. Add a `reattachChunk(vol, chunk)` method next to `_detach` in destruction.js.
- **Foam is new small volumes:** a foam blob = a freshly spawned mini destructible volume (`addVolume`) with its own coarse chunking, a distinct foam material (light, low threshold, matte), built at the sprayed location after a short hardening delay. Foam blobs are first-class destructible volumes — every existing weapon can break them again with zero special-casing. Cap the number of live foam volumes (e.g. 12; oldest hardened blob despawns first) so a foam-spam session can't grow world memory unbounded.

## Final category / key layout (complete, after this phase)

Design decision — document this table in code comments too. Existing categories keep their numbers; three new categories claim `5`-`7`; `8`-`9` stay reserved for the last ~5 roster tools in a future session.

| Key | Category | Items (cycle order) |
|-----|----------|---------------------|
| `1` | Melee | Sledgehammer → Crowbar → Chainsaw |
| `2` | Explosives | C4 Charge → Pipe Bomb → Demolition Wire → Blast Painter → Propane Tank → RC Car Bomb |
| `3` | Firearms | Shotgun *(unchanged — no new firearms this phase)* |
| `4` | Launchers | Rocket Launcher → Sticky Bomb Launcher → Cluster Bomb Launcher → Car Cannon |
| `5` | Grab & Force | Gravity Gun → Magnet Gun → Grapple Hook → Wind Cannon → Debris Vacuum |
| `6` | Strikes | Airstrike Designator → Orbital Laser Designator → Nuke |
| `7` | Builders | Foam Cannon → Rebuild Gun → Size Ray |
| `8`-`9` | *(reserved)* | — |

Every tool gets a voxel held-model (readable silhouette, consistent with the existing four; new categories should have a visual family feel — e.g. Grab & Force tools share a "device with emitter" language, Strikes share a "handheld designator" language). Tool-switch shows the existing fading name label; nothing else appears on screen.

---

## Per-tool specifications

Each spec lists: interaction (LMB/RMB/hold), destruction/physics mapping, audio (CC0 files to fetch), UI, **risk tier**, and the **mandated simplification** where the full fantasy is too heavy for a browser + 4-player target. Where a tier is MED or HIGH, the simplification is not optional — it IS the spec.

### Category 1 — Melee (additions)

**1b. Crowbar** — *risk: LOW*
- LMB swing, same swing/cooldown state machine as the sledgehammer, shorter range, lower force (breaks crates/wood readily, barely chips concrete — use the material multiplier table: wood ×1.5, concrete ×0.4, metal ×0.3).
- Its identity is "pries things open": against low-threshold volumes (crates, doors/panels once maps have them) a single hit should reliably pop exactly one chunk with a strong directed kick — tune so it feels like levering a board off, not smashing. On maps without doors/panels this simply means "the precise weak melee tool"; no dedicated door mechanic is required this phase.
- Audio: metal-on-wood pry/creak + metal clang (2 files). Multiplayer note: trivial, same path as sledgehammer.

**1c. Chainsaw** — *risk: MED*
- **Hold LMB** for continuous cutting (not discrete swings): while held and aiming at a chunk within short range (~2 m), apply `applyPointDamage` on a fast tick (e.g. every 0.12 s) with a modest per-tick force. Material multipliers do the flavor work: wood ×3 (chews through crates/shed instantly), dirt/skin ×1.5, concrete ×0.35, metal ×0.15 (sparks, nearly useless).
- Viewmodel: idle rumble animation while equipped, stronger shake while cutting. Simplification: no cut-plane geometry, no slicing meshes — it's rapid-fire point damage, full stop.
- Audio: chainsaw idle loop + revving cut loop + metal-screech for hitting concrete/metal (3 files, loops must loop cleanly). Multiplayer note: continuous-fire tools send a "held" state, server ticks the damage — same pattern the server will already need for hold-fire; flag in report if Phase 6 exists.

### Category 2 — Explosives (additions)

**2b. Pipe Bomb** — *risk: LOW*
- LMB throws an arced projectile (real dynamic Rapier body, small cylinder collider, restitution so it bounces/rolls). Fixed fuse (~3 s from throw, `CONFIG`), blinking indicator like C4, then `applyRadialDamage` at its resting position (slightly smaller than C4: reuse C4-scale force, radius ~3). Max ~6 live at once.
- Audio: fuse hiss loop + bounce clink + explosion (reuse the existing explosion file). Multiplayer note: trivial projectile sync.

**2c. Demolition Wire** — *risk: LOW*
- The controlled-demolition tool. LMB places a charge on the aimed surface exactly like C4 placement, but charges are visually **wired together**: render a simple sagging line (three.js `Line` or thin stretched boxes, pooled) linking each charge to the next in placement order. RMB detonates **all wired charges simultaneously** (one frame, or staged if >8 charges — reuse the staged detach queue).
- Distinction from C4 (which also mass-detonates): wire charges are *weaker individually but you can place more* (cap ~12 vs. C4 behavior), and the wire visual + simultaneous multi-point collapse is the fantasy. Keep both tools; tune them apart via `CONFIG`.
- Audio: charge placement click + long beep + multi-explosion (reuse/mix existing explosion with the `explosionSoundCap` pattern). Multiplayer note: trivial (server-side list of charge positions).

**2d. Blast Painter** — *risk: MED*
- **Hold LMB** to spray: raycast from camera on a fast tick; every chunk hit within ~6 m gets marked "painted" (store a Set of `vol.id + ":" + chunk.id`; tint painted chunks by swapping/overlaying an emissive-ish paint decal — simplest robust approach: a small pooled flat quad "splat" mesh stuck to the hit surface per painted chunk, max ~80 splats). RMB detonates: every painted chunk gets a direct detach (bypass radius search — you already know the exact chunks; go through a thin `detonatePainted(setOfChunks, forcePerChunk)` wrapper in destruction.js so the detach kick, debris bookkeeping, and tile rebuilds all run the normal path), staged via the detach queue if >40 chunks.
- Cap painted set at ~80 chunks (oldest mark expires, its splat fades) — that's already a building-façade-sized simultaneous blast.
- Audio: spray-can loop + detonation (reuse explosion). Multiplayer note: the painted set must live server-side in Phase 6; it's just a set of chunk ids, cheap to sync.

**2e. Propane Tank** — *risk: MED*
- LMB **spawns/throws** a propane tank: a dynamic Rapier body (capsule/cylinder) with a voxel tank mesh — a real environmental object that tumbles, rolls, and can be pushed by vehicles, the Gravity Gun, the Wind Cannon, etc. It explodes (`applyRadialDamage`, bigger than C4: radius ~5) when: (a) shot — give its collider a handle registered in a new `damageableProps` map checked by the shotgun/rocket hit paths; (b) subjected to a hard impact (contact force over threshold — but a propane tank is NOT a chunk and NOT in the debris registry, so this does not touch the `allowedImpactors` cascade rule); or (c) caught in another explosion (check live tanks within radius on every radial damage — chain reactions allowed, staged one frame apart so chains ripple).
- Cap: 8 live tanks (oldest despawns). Simplification: no fire/gas leak (fire is banned project-wide) — it goes straight to boom; a brief white "hiss" jet + sound when damaged-but-not-exploded is optional flavor, skip if it drags.
- Audio: metal clonk (tumbling) + hiss + big explosion (3 files). Multiplayer note: it's a plain dynamic body + HP flag; easy server-side.

**2f. RC Car Bomb** — *risk: MED*
- LMB deploys a small RC car (one alive at a time) at your feet, and **control transfers to the car**: your character stays put (frozen input, camera detaches), you drive the RC car with WASD using a **fixed chase camera** — implement it as a micro vehicle reusing the existing raycast-wheel `GroundVehicle` controller from Phase 3 with tiny tuning values (`CONFIG.vehicles.rccar`; ~15 kg-scale masses don't behave well in Rapier, so use a small-but-sane mass like 60 and tune forces to feel nippy). RMB (or LMB again) detonates it wherever it is (`applyRadialDamage`, C4-scale); `E` or detonation returns control/camera to your character instantly. If the car flips or falls off the world, auto-return control after 2 s with no blast.
- Simplification: no signal range limit, no camera-feed overlay — the chase cam IS the feed. The character being briefly uncontrolled is accepted (single-player this is free; in Phase 6 the server just sees your character idle).
- Audio: tiny electric motor loop + detonation. Multiplayer note: flag in report — the "one entity controlled by a player who isn't their character" case needs an input-routing note for the Phase 6 server, same shape as vehicle driving.

### Category 4 — Launchers (additions)

**4b. Sticky Bomb Launcher** — *risk: LOW-MED*
- LMB fires a fast projectile (kinematic ray-stepped like the rocket, slower); on hit it **sticks**: to world/chunk surfaces (parent a charge mesh at the hit point, exactly the C4 surface-placement pattern), to vehicles (parent to chassis, like C4-on-vehicle already works), and to players *if remote players exist* (parent to their rig; skip silently otherwise). Fixed delay fuse (~2.5 s), blink, then `applyRadialDamage` (smaller than C4, radius ~2.5). Max 8 live.
- Audio: launcher thoomp + stick splat + beep + explosion. Multiplayer note: sticking-to-player is a Phase 6-only behavior — code the attach interface now, it just has nothing to attach to yet.

**4c. Cluster Bomb Launcher** — *risk: MED*
- LMB lobs one arced projectile (dynamic body); at apex or after ~0.8 s it **splits into 6 bomblets** (small dynamic bodies with spread impulses); each bomblet explodes on first impact with a small `applyRadialDamage` (radius ~1.8, small budget each, e.g. 12 chunks), staggered 1-2 frames apart via the staged queue so 6 blasts never land in a single frame.
- Simplification: bomblets are pooled (6 meshes, reused), no sub-splitting, fixed count. Total budget per shot ≤ ~72 chunks — comparable to one C4 barrage, just spread over an area.
- Audio: thoomp + split pop + rapid small explosions (can reuse explosion at lower gain/varied playback rate is NOT allowed to be synthesized — but playing the same file at different volumes is fine; fetch one smaller "crump" explosion file for bomblets). Multiplayer note: deterministic split pattern (seeded) makes server sync trivial.

**4d. Car Cannon** — *risk: MED*
- The joke-fantasy tool: LMB fires **a full-speed car as a projectile**. Implementation: spawn a dedicated projectile instance of the hatchback voxel mesh with a plain dynamic cuboid body (do NOT spawn a full drivable vehicle with suspension — no wheels raycasting, no controller), launched along the aim direction at high velocity (~30 m/s) with a slight upward bias and a spin. Its collider handle is registered in `allowedImpactors` for its short lifetime, so it smashes through structures using the exact contact-force detach path a driven vehicle already uses — this is the whole trick, and it's cheap. After 6 s or after coming to rest, it fades out and despawns (it is a projectile, not a persistent vehicle — you cannot enter it). One live at a time; firing again while one is live despawns the old one.
- Cooldown ~2 s. Audio: launch whoosh + heavy crash (2 files; the chunk impacts themselves already sound via existing impact audio). Multiplayer note: server-spawned dynamic body, ordinary sync.

### Category 5 — Grab & Force (new category)

**5a. Gravity Gun** — *risk: MED-HIGH*
- **Hold LMB** on a valid target to grab it: valid targets are **dynamic bodies** — debris chunks, props registered as damageable/dynamic (propane tanks, RC car), and *small* vehicles (mass ≤ ~1600, i.e. hatchback-class; heavier vehicles refuse with a small viewmodel "strain" shake — do NOT let the player wave a 14-tonne crane around, both physics and network reasons). NOT the ground, not attached (fixed) chunks, not players.
- Holding: the proven pattern — keep the body **dynamic** but each physics tick apply a critically-damped spring force pulling it toward a hold-point ~2.5 m in front of the camera (position + velocity feedback), clamping max force by the body's mass; this stays stable in Rapier where kinematic-switching drops collision response. Dampen its angular velocity while held. If the spring can't keep up (target wedged), auto-release.
- Release LMB = drop gently. **RMB while holding = throw** (strong impulse along aim). A thrown debris chunk is still debris — it does NOT get added to `allowedImpactors` (the no-cascade rule stands: thrown debris knocks things around via ordinary physics but cannot detach fixed chunks). A thrown *propane tank* explodes on hard impact per its own spec — that's the sanctioned way to make gravity-throws destructive.
- Audio: grab hum loop (pitch/gain can't be synthesized — use a steady hum file) + throw whump. UI: none beyond crosshair. Multiplayer note (**flag prominently in report**): held-object state is the classic tricky sync case — in Phase 6 the server owns the spring simulation and the client only sends "grab/aim/release/throw" intents. Code the tool so the grab logic is a self-contained update function operating on (world, camera ray, held-handle) — trivially relocatable server-side.

**5b. Magnet Gun** — *risk: MED*
- The narrow, simpler Gravity Gun variant, restricted to **metal**: valid targets are dynamic bodies whose volume/prop `materialClass` is `metal` (plus vehicles — they're metal by definition, same mass cap as above). Two modes, no holding: **hold LMB = attract** (continuous force on all valid metal dynamic bodies within a 12 m cone toward the muzzle, capped count ~10 nearest), **hold RMB = repel** (same cone, outward force). Objects reaching the muzzle under attract just cluster there (soft clamp distance ~1.5 m); there is no carry state — that's what keeps it simpler than the Gravity Gun and trivially sync-friendly.
- Audio: electric magnet hum loop (attract) + reversed-feel deeper hum (repel) — 2 files. Multiplayer note: stateless force field, easy server-side.

**5c. Grapple Hook** — *risk: HIGH*
- LMB fires a hook (fast ray-stepped projectile with a visible rope — pooled segmented line, ~16 segments, purely visual catenary/straight lerp; the *physics* rope is just a distance constraint). On hitting a fixed chunk / world / vehicle: anchor there.
  - **On foot:** the rope becomes a distance constraint between player body and anchor — implemented manually (each tick, if distance > ropeLength, apply spring force along the rope on the player), NOT a Rapier joint on the player capsule (the character controller fights joints). Hold LMB keeps it attached; **scroll or hold W = reel in** (shorten ropeLength → you zip/swing toward the anchor), release LMB = detach. This gives zip-down and pendulum swings with ~30 lines of force code.
  - **While driving (the wall-tearing fantasy):** if fired while in a vehicle, anchor one end to a **chunk** and the other to the vehicle chassis via an actual Rapier rope/spring joint (bodies on both ends are real rigid bodies, so a joint is fine here). When the vehicle pulls and the joint force exceeds the chunk's threshold-scale value, call `applyPointDamage` on the anchored chunk with the rope tension as force — the wall chunk (plus its neighbor ring) rips out and comes dragging behind the car. Break the joint automatically once the chunk detaches or if tension exceeds a snap limit.
- One rope at a time. Simplification (mandatory): no rope-wrapping around geometry, no rope-vs-world collision — the rope may clip through corners; accepted.
- Audio: hook launch + metallic anchor hit + reel loop + rope snap (4 files). Multiplayer note (**flag in report**): on-foot swinging is client-predicted movement — same reconciliation bucket as normal movement in Phase 6, but note it; vehicle-rope is server-side joint, ordinary.

**5d. Wind Cannon** — *risk: LOW*
- LMB fires a blast of force with **zero destruction**: in a ~10 m cone, apply a strong outward impulse to all *dynamic* bodies (debris, props, tanks, light vehicles at reduced effect) scaled by 1/distance, and to remote players if they exist (Phase 6 note: knockback intent to server). Explicitly never calls any damage function and never touches fixed chunks — its whole identity is "clear the debris field / shove things off ledges without breaking anything".
- A subtle visual: brief pooled dust-puff quads along the cone. Short cooldown (~0.7 s).
- Audio: deep air-cannon whoomp (1 file). Multiplayer note: stateless impulse event, trivial.

**5e. Debris Vacuum** — *risk: LOW-MED*
- **Hold LMB**: all debris entries (the `destruction.debris` list — this tool works on exactly that list, nothing else) within a ~9 m cone get a continuous force toward the muzzle; any debris body that gets within ~1 m of the muzzle is consumed — reuse the existing fade/removal path (`fading = true` with a fast fade, or direct `_remove`-style disposal via a small public method you add, e.g. `consumeDebris(entry)`; don't reach into private state from weapons.js).
- This is the map-cleanup tool: it directly relieves the 200-debris cap, so it's also a *performance* tool. A tiny suck-scale animation (debris shrinking as it approaches) sells it.
- No storage/inventory — consumed debris is simply gone (simplification, mandatory). Audio: vacuum motor loop + per-consume "thup" (2 files, the thup at low gain and rate-limited to ~10/s). Multiplayer note: server-side it's force + removal events on server-owned debris; easy.

### Category 6 — Strikes (new category)

**6a. Airstrike Designator** — *risk: HIGH (the most involved tool in this phase — build it last within batch C)*
- Equipping it spawns a **scripted flyover plane entity** circling the map perimeter at altitude (~60 m): a voxel plane mesh on a fixed circular path, purely kinematic/decorative — reuse the Phase 3 plane *model* if one exists, but do NOT use the flyable plane physics; it's an animated prop. It exists only while the designator is equipped (despawn on switch-away, done for the session's remaining lifetime = no).
- **Ammo types** — exactly three, selected with **R** (cycle; shows the ammo name via the existing tool-label element — this satisfies "selectable ammunition" with zero new HUD): 
  1. *Bombs* — stick of 5 dumb bombs along the approach line, each a medium `applyRadialDamage` (radius ~3), staggered by the stage queue;
  2. *Penetrator* — a single heavy munition using `carveCylinder` along its descent ray (steep angle from the plane's position toward the target), radius ~1.5, punching through floors/obstacles on the way down — this is the "ordnance penetrates obstacles" requirement, delivered by the shared helper;
  3. *Cluster* — one canister that reuses the Cluster Bomb split/bomblet machinery from 4c at larger spread.
- **LMB** = designate the aimed world point: the plane breaks from its circle, runs in over the point (scripted spline, ~4 s from call to impact), releases visible falling ordnance meshes (pooled, ray-stepped fall along the precomputed descent ray so impact matches exactly), strikes land, plane resumes circling. One run at a time; LMB during a live run is ignored.
- **RMB (toggle)** = **plane camera view**: detach the render camera and attach it to the plane (nose-mounted, slightly downward). While in plane view, mouse moves a slow aim marker — implement the marker as the crosshair dot itself plus a small pooled ground-projected quad where the camera ray hits (allowed: it's the crosshair, relocated); LMB in this view designates that point (same pipeline); RMB returns to first person. The player character stands still during plane view (same accepted vulnerability as RC Car Bomb).
- Simplifications (mandatory): the plane is invulnerable and non-colliding (a ghost prop at altitude); no AA, no fuel, no multiple planes; ordnance fall is kinematic (no dynamic tumbling bombs).
- Audio: circling prop-plane loop (3D-positioned, quiet), attack-run flyby whoosh, bomb whistle, impacts (reuse explosions) — 3 new files. Multiplayer note (**flag in report**): the plane is a server-owned scripted entity in Phase 6; the plane-camera is purely local (camera attach), only designation events sync — cheap, but say so.

**6b. Orbital Laser Designator** — *risk: MED*
- LMB plants a glowing marker at the aimed point (pooled quad + small pillar-of-light mesh). After a fixed **3 s** delay (blinking faster as it counts down), a **vertical laser column** fires from the sky: a bright emissive cylinder mesh (scaled tall, additive material) that lives ~1.5 s, during which `carveCylinder(top, straightDown, throughGround, radius ~1.2)` drains through the staged queue — burning a clean hole through every floor/obstacle above and below the marker down to the indestructible core. The visual column + the progressive floor-by-floor punch-through from the stage queue IS the effect; no light scattering, no decals.
- One marker at a time; cooldown ~6 s after fire. Simplification: instant-travel beam (no orbital anything actually modeled).
- Audio: marker beep accelerating + charging rise + sustained beam zap + rumble (3 files; the accelerating beep = one file per beep replayed on the countdown schedule, NOT a synthesized sweep). Multiplayer note: pure fire-and-forget event with a fixed timeline — trivial sync.

**6c. Nuke** — *risk: MED (bounded strictly by the staged-detach rule)*
- The area-wipe tool. LMB throws/places a device (short arc, lands, arms); fixed 5 s countdown with accelerating beep, then: **screen flash** (a fullscreen white quad fading over ~0.8 s — allowed as an effect, it is not HUD), a brief camera shake, and a **staged collapse**: one huge radial damage job (radius ~18, force high enough to clear every threshold in radius) fed entirely through the staged detach queue at the per-frame chunk budget — the destruction visibly ripples outward from ground zero over ~1-2 seconds. The debris cap (200) stays untouched: the cap's existing oldest-fades-first behavior means a nuke naturally churns through debris; that is the accepted look.
- Hard rule restated: **never detach more than the per-frame stage budget in a single frame, and never raise `debrisCap` for this tool.** The fantasy is delivered by flash + shake + rippling collapse + a towering (pooled, simple) dust column mesh — not by 1000 simultaneous bodies.
- One nuke armed at a time; long cooldown (~20 s). Audio: arm beep, klaxon, one massive layered explosion file + long rumble tail (2-3 files; fetch a genuinely big-sounding CC0 blast, this one deserves the download effort). Multiplayer note: single event + deterministic staged job — syncs like any radial damage, just longer.

### Category 7 — Builders (new category)

**7a. Foam Cannon** — *risk: HIGH (first consumer of the constructive-voxel subsystem — build subsystem B here)*
- **Hold LMB** sprays foam: a stream of visible blobby projectiles (pooled spheres with slight scale wobble) that fly in a short arc; where they land they accrete into a **foam blob volume**: accumulate hit points into a small voxel grid anchored at the first landing spot (grid cell ~0.3 m), and after ~1.5 s without new spray in that blob, "harden" — run the blob's grid through `addVolume` (subsystem B) with `materialClass: "foam"` (light density, low threshold, matte pale material). While still soft (pre-harden) it's visual-only, no collision — walking through wet foam is fine, that ambiguity is accepted.
- Result: walkable/drivable improvised bridges, ramps, and wall patches that every existing weapon can destroy again through the completely normal chunk pipeline. Blob size cap (~600 voxels ≈ a 2×1×9 m bridge segment) per blob, ≤12 live blobs.
- Audio: wet spray loop + squelchy splat + a subtle hardening "crack-set" (3 files). Multiplayer note (**flag in report**): blob grids must be server-authored in Phase 6 (they're new world geometry); the spray stream is cosmetic, only the hardened grid syncs — one blob = one compact voxel-grid message.

**7b. Rebuild Gun** — *risk: MED-HIGH*
- The anti-destruction tool. **Hold LMB** while aiming at a damaged destructible volume: detached chunks of that volume whose original centroid lies within ~5 m of the aim point get restored oldest-damage-first at a steady rate (~4 chunks/s) via `reattachChunk` (subsystem B): the flying/settled debris body for that chunk (if still alive) fades out where it lies, and the chunk snaps back into the structure as a fixed body at its original pose, with tiles rebuilding — the building visibly heals block by block. Chunks whose debris already despawned restore identically (the original layout is all that matters).
- A brief per-chunk "ghost preview" (the chunk's mesh at 40% opacity for 0.2 s before solidifying) makes it read as construction, cheap to do with the debris-mesh generator.
- Restriction: original structure only — it cannot create anything that wasn't there at map load (foam blobs count as "original" from their hardening moment, so foam is also repairable). No resource cost.
- Audio: reverse-crumble / stone-settling per restore (1-2 files, rate-limited). Multiplayer note: `reattachChunk` events are the exact mirror of detach events — Phase 6 sync piggybacks on the same channel.

**7c. Size Ray** — *risk: MED (mandatory heavy simplification)*
- LMB shrink / RMB enlarge, in fixed steps (×0.6 / ×1.6 per zap, clamped to a total range of **0.25×-3×** original). Valid targets: **debris chunks and dynamic props (propane tank, RC car) ONLY** — explicitly NOT the ground, NOT attached structure, NOT vehicles, NOT players. On zap: scale the target's mesh, replace its collider with a scaled copy (rebuild the convex hull/cuboid at the new scale — Rapier colliders don't rescale in place), and rescale mass accordingly (density constant → mass ~ scale³), preserving velocity.
- Enlarged debris is where the fun is (a car-sized concrete shard to gravity-gun-throw around); shrunk debris is a soft assist to the vacuum. A zapped object shows a brief scale-lerp (~0.15 s) rather than popping.
- Simplification restated (mandatory): no scaling of anything attached or alive; per-object cooldown 0.5 s; at most ~20 scaled objects tracked (oldest reverts silently on the pool's fade-out path anyway, since debris despawns normally).
- Audio: sci-fi shrink zap + grow zap (2 files; two distinct files, not one pitch-shifted — no synthesis rule). Multiplayer note: scale is one extra synced float on a debris body; easy.

---

## Build order — 4 sub-batches, stop-and-review after each

- **Batch A — melee + throwable/wired explosives (6 tools):** Crowbar, Chainsaw, Pipe Bomb, Demolition Wire, Sticky Bomb Launcher, Cluster Bomb Launcher. Also build here: material multiplier table + staged detach queue (needed by Cluster already). Lowest risk, exercises the category/cycling UI with real multi-item categories for the first time.
- **Batch B — Grab & Force (5 tools, new category `5`):** Wind Cannon, Debris Vacuum, Magnet Gun, Gravity Gun, Grapple Hook — in that order (each builds on the force/grab machinery of the previous).
- **Batch C — Strikes + big/vehicular ordnance (7 tools):** Blast Painter, Propane Tank, Nuke, Orbital Laser Designator (build `carveCylinder` here), Car Cannon, RC Car Bomb, Airstrike Designator last (it reuses the cluster machinery, the carve helper, and the camera-detach pattern proven by the RC car).
- **Batch D — Builders (3 tools, constructive-voxel subsystem):** Foam Cannon (build subsystem B), Rebuild Gun, Size Ray.

After each batch: report what was built, how to test each tool, performance observations on the 2019 Intel MBP target (especially after Nuke and Foam), and any spec deviations — then **stop and wait for approval before the next batch**.

## Definition of done for Phase 7 (per-tool acceptance checks)

Selection layer:
1. Keys `1`-`7` select their categories; same-key press and scroll-wheel cycle through every item listed in the layout table, in the stated order; each tool has a readable voxel held-model and shows its name via the existing label; `8`-`9` still do nothing.

Batch A:
2. Crowbar pops single chunks off crates in one hit but needs many hits on concrete (multipliers visibly working).
3. Chainsaw held-fire chews continuously through the wooden crates/shed far faster than through the concrete wall, with looping audio.
4. Pipe Bomb arcs, bounces, blinks, and explodes ~3 s after throw at its resting spot.
5. Demolition Wire places up to ~12 visually wired charges and RMB collapses all points simultaneously.
6. Sticky bombs stick to world surfaces AND to a moving vehicle, then detonate on their fuse.
7. Cluster Bomb splits into 6 bomblets that blanket an area with staggered small blasts, no single-frame hitch.

Batch B:
8. Wind Cannon shoves piles of debris (and a propane tank, once built) off a ledge without detaching a single fixed chunk.
9. Debris Vacuum visibly pulls in and consumes settled debris, and the debris count actually drops (verify via the debris pool).
10. Magnet Gun attracts/repels metal debris and light vehicles only; wooden debris ignores it.
11. Gravity Gun grabs debris/props/a hatchback-class car, holds it stably in front of the camera while walking, and RMB-throws it hard; thrown debris knocks things around but never detaches fixed chunks; heavy vehicles refuse with the strain feedback.
12. Grapple on foot: zip/reel toward a high anchor and pendulum-swing; in a vehicle: rope a wall chunk, drive away, and tear it (plus its neighbor ring) out dragging behind the car.

Batch C:
13. Blast Painter's painted chunks (visible splats) all detonate together on RMB, and the mark cap expires oldest first.
14. Propane Tank explodes when shot, when hurled hard (e.g. by Gravity Gun), and chain-reacts with a neighboring tank one beat apart.
15. Nuke: flash + shake + collapse rippling outward over ~1-2 s, frame rate stays playable on the target hardware, debris cap untouched.
16. Orbital laser: marker, 3 s countdown, vertical beam that punches a clean hole through an elevated slab AND the ground skin beneath it, down to the indestructible core.
17. Car Cannon's flung car smashes through a wall using vehicle-grade contact destruction, then fades out; it can't be entered.
18. RC Car Bomb: control transfers to a drivable mini car with chase cam, detonates on command, control returns instantly; flip/void auto-returns without a blast.
19. Airstrike: plane visibly circles while equipped; `R` cycles Bombs/Penetrator/Cluster with label feedback; LMB runs a strike on the aimed point (penetrator hole reaches through an obstacle above the target); RMB enters/exits plane view where slow aiming + LMB designates; only one run at a time.

Batch D:
20. Foam Cannon builds a hardened foam bridge you can walk AND drive across, and any weapon (e.g. shotgun) breaks the foam back apart through the normal chunk pipeline.
21. Rebuild Gun visibly re-grows a half-demolished prop chunk by chunk back to its exact original shape, including chunks whose debris had already despawned.
22. Size Ray enlarges a debris chunk to ~3× (grabbable and throwable at its new mass) and shrinks props toward 0.25×, never affecting attached structure or the ground.

Cross-cutting:
23. Every new sound is a real CC0 file present in `assets/audio/` (list each file + its source in the report); the game runs with zero network requests at play time and zero WebAudio synthesis.
24. Falling/thrown debris still never cascades detachment anywhere (spot-check with Gravity Gun throws and the Nuke aftermath).
25. All new tuning constants live in `CONFIG.weapons` (and `CONFIG.vehicles.rccar`), no magic numbers in logic files.
26. A long abuse session (nuke + foam spam + cluster spam) stays smooth on the 2019 Intel MBP performance target and memory doesn't grow unbounded (caps and pools all enforced).

## Explicitly out of scope for Phase 7

- **No fire/burning/gas simulation** — standing project-wide rule; the Propane Tank goes straight to explosion.
- No new HUD beyond what's granted above (crosshair dot, existing tool label reused for names and airstrike ammo, screen-flash/ghost-preview effects). No ammo counters, no minimap, no strike-cooldown widgets.
- No ammo/inventory/resource economy — every tool has unlimited use, limited only by cooldowns and live-object caps.
- No new firearms (category 3 stays at one item) and no tools beyond these 21 — the remaining ~5 toward the 30 target are a future session on keys `8`-`9`.
- No new vehicles (the RC car is a weapon-owned entity, the Car Cannon projectile is not enterable), no new maps, no lobby changes.
- No multiplayer networking work in this phase: if Phase 6 is not built yet, everything here is single-player and the flagged sync notes are design discipline only; if Phase 6 IS built, route destruction through the existing server-authoritative path but do not redesign the netcode — just flag in your report any tool whose sync you had to stub or simplify.
- No destruction of the indestructible: ground core, vehicles (as damage targets), and the airstrike plane remain unbreakable.

Report back after **each batch** (not just at the end) on what was built, how to test it, performance on the target hardware, and any deviations — the multiplayer-tricky tools (Gravity Gun, Grapple Hook, Airstrike, Foam) and any place you had to tighten a cap deserve explicit callouts. **Stop after batch A and wait for review — do not run multiple batches unprompted, and do not proceed beyond Phase 7's scope.**

---

## Roadmap note (paste into the project roadmap)

**Phase 7 — Tool roster expansion (21 tools):** grows the arsenal from the Phase 2 starting four to **25 of the ~30-tool target**, adding three new categories (5 Grab & Force, 6 Strikes, 7 Builders) alongside deeper Melee/Explosives/Launchers cycling, all on the existing number-key + same-key/scroll selection system with keys 8-9 still reserved. Ships two reusable subsystems along the way — staged multi-frame detach (nuke-scale collapses within the debris budget) and constructive voxels (foam bridges, chunk-perfect rebuilds) — plus per-material damage multipliers and a carve-cylinder helper, with every tool spec'd to remain server-authoritative-compatible for the Phase 6 multiplayer model. Built in 4 stop-and-review sub-batches (melee/explosives → grab/force → strikes/heavy ordnance → builders).
