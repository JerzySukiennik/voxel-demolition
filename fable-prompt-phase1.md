# Voxel Demolition — Phase 1 build prompt (for Claude Fable 5)

You are building the first phase of **Voxel Demolition**, a Teardown-inspired (https://teardowngame.com/) voxel destruction sandbox. This document gives you full context on the whole game so your Phase 1 architecture stays extensible, but **your job right now is to build ONLY Phase 1** as scoped below, then stop and hand back for review. Do not build weapons, extra vehicles, maps, lobby/avatar customization, or multiplayer networking in this pass — those are separate future prompts, listed in the roadmap at the end for context only.

## Full game vision (context only — do not build beyond Phase 1)

A co-op sandbox (1-4 players) where players walk and drive around, smashing buildings, props, and structures apart with physics-driven voxel destruction, in the visual style of Teardown: chunky, sharp-edged voxel models with strong directional lighting and shadows. Vehicles are numerous and varied (cars, planes, helicopters) and are indestructible — they're tools for causing destruction, not something that breaks. Eventually the game is hosted by a dedicated Node.js server on a Windows laptop, and other players join over LAN by typing the host's local IP address into their browser (no installs).

## Tech stack (applies to Phase 1 too)

- **Client:** vanilla JS, ES modules loaded straight from CDN — **no build step, no bundler**. `three.js` for rendering, `@dimforge/rapier3d-compat` (WASM) for physics. This is the established, proven pattern from this developer's other browser games — stick to it exactly.
- **Server:** none needed yet for Phase 1. This phase is a purely local, single-player experience — just serve the static files (a trivial static file server is enough, e.g. a one-file Node `http` server or `npx serve`). Do NOT build WebSocket networking yet; that's Phase 6.
- **No TypeScript, no framework, no npm install step for the client** — everything the browser needs loads from CDN via `<script type="importmap">` / ES module imports. A `package.json` is fine only if it's needed to run a tiny local static-file server for local testing.
- **Performance target for client rendering:** must run smoothly (aim for 60fps at 1080p) on a 2019 Intel MacBook Pro with an AMD Radeon Pro 5500M (4GB) — a mid-range, non-Apple-Silicon, somewhat dated GPU. Don't assume a beefy modern GPU. Keep draw calls and physics body counts sane; use instancing for repeated voxel geometry where possible.

## Phase 1 scope — build exactly this, nothing more

### 1. World / baseplate
- A compact, flat outdoor test plaza (roughly 40-60m across) — enough room to comfortably walk and drive around.
- The ground has two layers, both sharing the same visible texture/material so they look seamless:
  - An **indestructible core** underneath (the true floor — never breaks, prevents falling through the world).
  - A **thin destructible "skin" layer** on top, using the pre-fracture chunk system described below, so players can blast/drive through the surface and see the indestructible layer underneath once it's gone.
- Add 2-3 simple destructible obstacle props scattered on the plaza (e.g. a low wall, a stack of crates, a small shed-like block) — just enough to test driving into something and seeing it break apart. Keep their shapes simple (boxy voxel forms), not hand-detailed buildings.
- Lighting: sunny daytime, strong single directional light (sun) with real-time shadow mapping, sharp shadow edges. This is a stated visual priority — invest real effort in shadow quality and material response (some roughness/specular variation per voxel material, not flat-shaded).

### 2. Destruction system (pre-fracture chunks)
- **Do not attempt full per-voxel physics simulation** (i.e. don't make every single small cube its own physics body from the start) — that's the actual Teardown engine's approach and is far too heavy for a WASM/JS browser physics engine with 4 players. Instead:
- Destructible objects (the ground skin layer and the 2-3 obstacle props) are pre-divided into chunks at load time (think: safety glass — pre-cracked into irregular pieces before anything hits it).
- On impact (from the vehicle or from the player pushing into something with enough force), the affected chunk(s) detach and become real physics rigid bodies — mass, gravity, restitution, they tumble and settle realistically using Rapier.
- Performance hygiene: let settled/sleeping debris bodies go to sleep in Rapier (don't keep simulating bodies at rest), and cap the total number of simultaneously active debris bodies with a reasonable pool/cleanup strategy (e.g. despawn or merge very old settled debris after some time) so destruction doesn't degrade framerate over a play session.
- Chunk granularity: coarse enough to be performant, fine enough that destruction reads as satisfying and "Teardown-like" rather than a single object just vanishing or splitting into 2 halves. Use your judgment — err toward fewer, chunkier pieces over true fine voxel dust for this phase.

### 3. Player character
- First-person camera. Unlike a typical FPS, the player's own body should be visible looking down (torso/arms/legs partially in view) and hands/held-tool model visible when looking around — matching Teardown's embodied FPP feel, not a disembodied floating camera.
- Physics-based character controller (capsule collider is fine) — walking, running, jumping, colliding with the world and destructible debris correctly (can be pushed by falling debris, etc.).
- Visual quality: build this character at the same final voxel-art quality bar as everything else in the game — but with **no customization system yet** (single fixed default look). The customization/avatar-editor UI comes in a later phase (Phase 5).
- No weapons/tools yet — the player can walk, run, jump, look around, and enter/exit the vehicle. That's it for interaction in this phase.

### 4. Vehicle
- Build one vehicle: a compact blue hatchback, modeled after the reference photo at `Sketches/Sample Images/Sample Vehicles/785.jpg` (open/view that image file directly — it's a real screenshot of the target art style, use it as your ground-truth reference for proportions, color blocking, and voxel chunkiness, not just a vague description).
- Construct it as an actual voxel-grid model (an explicit 3D array/voxel layout of colored cubes, greedy-meshed or instanced for performance) that visually matches the reference image — this is the first real test of your voxel-modeling pipeline for the whole project, so get the silhouette, proportions, and color blocking right.
- Driving physics: **simulation-style, not arcade** — real mass, suspension, and grip/slip behavior (Rapier has vehicle controller primitives; build a proper raycast-wheel vehicle rather than a kinematic "car-shaped box that turns"). It should feel weighty and require some skill to control, not instantly forgiving.
- Controls: standard WASD for accel/steer/brake while driving.
- Camera: switches to third-person chase camera (behind and slightly above the car) while driving; switches back to first-person on exit.
- Enter/exit: press `E` near the vehicle to get in (player spawns in the driver seat), press `E` again while driving to get out (player spawns standing beside the car).
- The vehicle is **indestructible** — it can ram into the destructible obstacles/ground-skin and cause them to break apart (transferring realistic physics impulse to the chunks it hits), but the vehicle itself never takes damage or deforms.
- No other vehicles yet — this is the only one in Phase 1.

### 5. Audio (basic)
- Engine sound while driving (should react at least roughly to speed/RPM, doesn't need to be sophisticated).
- Footstep sounds while walking/running on foot.
- Basic impact sound(s) when destructible chunks break off or debris lands.
- Simple is fine — placeholder-quality synthesized or CC0 sounds are acceptable here; audio polish is not the focus of this phase.

### 6. Explicitly OUT of scope for Phase 1
- No HUD/UI of any kind (no crosshair, no speedometer, nothing on screen).
- No weapons or hand tools beyond just walking/driving.
- No additional vehicles.
- No multiple maps.
- No lobby, nickname entry, avatar customization, or map-select screen.
- No multiplayer/networking layer of any kind (no WebSocket server, no `ws` dependency) — this phase runs entirely local/single-player in one browser tab.
- No fire/burning simulation.
- No manual "reset map" feature yet (fine to just reload the page to reset during testing).

## Controls reference (Phase 1)
- `WASD` — move (on foot) / accelerate-steer-brake (in vehicle)
- Mouse — look around
- `Space` — jump (on foot)
- `Shift` — sprint (on foot)
- `E` — enter/exit vehicle when near it

## Definition of done for Phase 1
When you're done, the developer should be able to:
1. Run one simple local command to start a static server and open the game in a browser.
2. Spawn on the plaza as the visible-body first-person character.
3. Walk/run/jump around and see their own body/limbs, with footstep audio.
4. Walk up to the blue hatchback, press `E`, and drive it around with weighty, simulation-style handling, camera switching to third-person chase view, with engine audio reacting to driving.
5. Drive into (or otherwise push into) the destructible obstacles and the ground's thin skin layer, and see chunks realistically break off, tumble, and settle with physics — with impact audio — while the indestructible ground core underneath is never destructible.
6. See strong, sharp directional shadows and decent per-material shading across everything, running smoothly on a mid-range 2019-era laptop GPU.
7. Press `E` again to exit the vehicle and resume walking.

Report back on what was built, how to run it, and flag any part of this spec you had to deviate from and why. **Stop here — do not proceed to Phase 2 or beyond.**

---

## Full roadmap (context only — future prompts, not this session)

1. **Phase 1 (this prompt):** plaza + destructible skin/props + first-person character + one drivable vehicle + basic audio. Local, single-player only.
2. **Phase 2 — Weapons/tools:** hand-held destruction tools. Start with 4: sledgehammer/crowbar, explosives (C4/dynamite), a firearm, a rocket launcher. Target roster over time: 30 total. Selection UI: press a number key (e.g. `1`) to pull up that category's first tool; pressing the same number again (or scrolling) cycles to the next item in that category — modeled on the referenced Teardown mod menu screenshot at `Sketches/Sample Images/download.jpeg`. No fire/burning spread system — intentionally out of scope for the whole project.
3. **Phase 3 — More vehicles:** expand the vehicle roster toward ~30, using `Sketches/Sample Images/Sample Vehicles/` as visual references (cars, monster trucks, excavators, planes, helicopters). All indestructible. Vehicles get their own dedicated spawn/selection menu, separate from the weapon number-key system.
4. **Phase 4 — Maps:** build out 2-3 small/medium maps with actual destructible buildings/structures (not just test props), each still built on the indestructible-core + destructible-skin ground pattern from Phase 1.
5. **Phase 5 — Lobby & avatar:** join flow with nickname entry, a full character customization editor (separate color/shape choices per body part — head, torso, legs, etc.), and map selection. Also add an in-game manual "reset map" option, available to any player at any time.
6. **Phase 6 — Multiplayer:** dedicated headless Node.js server (`ws`) running on the host's Windows laptop (no rendering on the host), other players join over LAN by entering the host's local IP:port in their browser. Server is the authoritative source of truth for destruction physics — all clients see identical debris state, not locally-approximated physics. Prepare a double-clickable Windows `.bat` launcher that starts the server and prints the LAN IP:port to share with friends. Deploy flow: public GitHub repo (`JerzySukiennik/voxel-demolition`), `git clone`/`git pull` on the host machine.

Keep Phase 1's code structured so these later systems (destruction, vehicles, weapons, character) are reasonably modular/separable — you don't need to build stubs or placeholders for them now, just don't paint yourself into an architecture that makes them hard to bolt on later.
