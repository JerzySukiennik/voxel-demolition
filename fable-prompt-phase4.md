# Voxel Demolition — Phase 4 build prompt (for Claude Fable 5)

This continues **Voxel Demolition**. **Phases 1-3 are already built and approved**: destructible-ground pipeline, a first-person character, a weapon roster (hammer, C4, firearm, rocket launcher), and a full vehicle roster (cars, off-roaders, construction vehicles, a helicopter, a hover car, boats). All of that currently only exists on the single Phase 1 test plaza. Build directly on top of that existing codebase.

Your job now is **only Phase 4: real maps**. Stop and report back once this phase's definition of done is met — do not touch weapons, vehicles, lobby/avatar, or multiplayer.

## Important — reference images are from the actual commercial game Teardown, style-only

The folder `Sketches/Sample Images/Sample Map:Places/` contains screenshots taken directly from Teardown itself (you'll notice in-game signage like "Löckelle Teardown Services" and "Welcome to Cullington" — these are Teardown's own trademarked assets, not generic stock photos). **Use these only for scale, density, composition, and mood reference** — how big a "small town" reads, how much clutter/detail dresses a scene, how structures relate to open space. Do **not** reproduce their exact signage text, logos, building layouts, or named locations verbatim. Design original buildings/props/layouts in the same voxel art style and general theme, not copies.

## Maps to build (2-3, per the established scope)

Build **2-3 small/medium maps**, each thematically distinct, inspired by (not copied from) what you see across the reference folder. Reasonable directions based on the references (pick what you think reads best, or propose your own within the same spirit):
- A **small town** — a short main street, a handful of distinct houses/shops, some parked (non-drivable-by-default, just decorative) prop vehicles, fences, trees. Dense enough to feel like a real place, not a single isolated building.
- An **industrial/yard** setting — warehouses, shipping containers, stacked crates, maybe a work yard with construction equipment sitting around. Good testbed for the crane/excavators from Phase 3.
- A **desert canyon/outpost** setting — rock formations bounding the play area, a small structure or two, open sandy ground. Also a reasonable place to finally test the boats from Phase 3 against a real water feature (a pond or small lake), if you choose to include one.

Whichever 2-3 you build, every one of them must follow the **same ground pattern established in Phase 1**: an indestructible core underneath, with a destructible pre-fracture "skin" layer on top sharing the same texture, so the whole ground surface is diggable/destroyable down to the indestructible base, everywhere on the map.

## Destructible structures

Every building/structure on these maps (not just flat ground) needs the **same pre-fracture chunk system** used since Phase 1 for props — scaled up to actual multi-part structures (walls, roofs, maybe a small bridge or overpass if it fits a map's theme) rather than simple test-obstacle shapes. Players should be able to genuinely tear a building apart wall by wall with the weapons/vehicles from Phases 2-3, not just chip cosmetic damage off it.

## Performance — this is the important risk in this phase

A full map with many multi-chunk buildings has vastly more destructible geometry and potential physics bodies than Phase 1's single test plaza. Carry forward and reinforce the performance discipline from earlier phases:
- Keep per-building chunk counts reasonable — chunkier, fewer pieces over fine dust, same principle as Phase 1.
- Make sure debris sleeping/cleanup (from Phase 1) is actually working at map scale, not just in the small test case it was built against.
- Consider whether static, not-yet-hit chunks need to be full physics bodies at all before impact (they likely don't — keep them as simple static/kinematic geometry until something actually hits them, only promoting to a dynamic rigid body on impact). If Phase 1/2's system doesn't already do this, this is the phase to fix it — it matters much more now at map scale.
- Target remains: smooth on a 2019 Intel MacBook Pro / AMD Radeon Pro 5500M — don't let map complexity blow through that bar.

## Map loading (no lobby yet)

There's no map-select UI yet (that's Phase 5) — a simple, temporary way to choose which map loads (e.g. a URL query parameter or a hardcoded array you cycle with a debug key) is fine for testing purposes in this phase. Note clearly in your report how to load each of the 2-3 maps for review.

## Definition of done for Phase 4

1. 2-3 distinct, themed maps exist, each built on the indestructible-core + destructible-skin ground pattern.
2. Each map has actual multi-part destructible buildings/structures (not just Phase 1-style simple test props), breakable with the existing weapons and by ramming vehicles into them.
3. No verbatim-copied signage, logos, or exact layouts from the Teardown reference screenshots — original content in the same style.
4. Performance holds up at map scale on the target hardware bar, with static-until-hit geometry rather than everything being a live physics body from the start.
5. A documented (even if temporary/debug) way to load each of the 2-3 maps for testing.

## Explicitly out of scope for Phase 4
- No lobby, nickname entry, avatar customization, or a real in-game map-select menu — that's Phase 5.
- No new weapons or vehicles beyond what Phases 2-3 already built.
- No multiplayer.
- No manual "reset map" feature yet (still fine to just reload the page) — the real reset UI comes with Phase 5's menus.

Report back on what was built, how to load/test each map, and flag any deviations from this spec (especially anything about performance at map scale). **Stop here — do not proceed to Phase 5.**
