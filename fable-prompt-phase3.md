# Voxel Demolition — Phase 3 build prompt (for Claude Fable 5)

This continues **Voxel Demolition**. **Phases 1 and 2 are already built and approved**: a test plaza with destructible ground/props, a first-person character, one drivable car (`785.jpg`-based hatchback), and a first weapon roster (hammer, C4, firearm, rocket launcher) with a numbered category/cycling selection system. Build directly on top of that existing codebase.

Your job now is **only Phase 3: expanding the vehicle roster**. Stop and report back once this phase's definition of done is met — do not touch weapons beyond what already exists, maps, lobby/avatar, or multiplayer.

## Vehicle roster for this phase

Long-term target is roughly **30 vehicles total**. This phase adds every vehicle in the reference folder `Sketches/Sample Images/Sample Vehicles/` that isn't already built (i.e. everything except `785.jpg`, which is the Phase 1 hatchback). Open and look at each image directly before modeling it — these are your ground-truth references for silhouette, proportions, and color blocking, the same way `785.jpg` was used in Phase 1. Build each as an explicit voxel-grid model (instanced/greedy-meshed for performance), matching the established art pipeline.

Reference list and the physics behavior each needs:

**Ground vehicles — reuse Phase 1's raycast-wheel vehicle physics (simulation-style, weighty, real suspension/grip), same as the hatchback:**
- `076.jpg` — orange off-road buggy with huge tires, roll-cage.
- `701.jpg` — orange "ARENA" monster truck, oversized tires.
- `787.jpg` — red sports/race car with rear wing.
- `788.jpg` — teal vintage wagon (build the wagon in the foreground; the white truck visible in the background of the same shot is optional bonus content, not required).
- `967.jpg` — red pickup truck.
- `996.jpg` — white classic car (Back to the Future-styled).
- `960.jpg` — white/green SUV.
- `235-942.jpg` — small wheeled excavator. Drivable like the others; an animated digging arm is a nice-to-have, not required.
- `936.jpg` — larger tracked excavator. Same note on the arm.
- `873.jpg` — large mobile crane truck.

**Hover vehicle — special case, low-altitude hover flight rather than wheels:**
- `455(Mój ulubiony).jpg` — this is Jurek's favorite reference: a car that hovers just above the ground with a glowing blue thruster effect underneath (DeLorean-from-Back-to-the-Future vibe). Give it simple hover-flight controls (throttle up/down for altitude, WASD for horizontal movement/steering) rather than wheels — it should float and glide low over the terrain, not touch the ground while active.

**Aircraft:**
- `624.jpg` — helicopter, dark silhouette with a spotlight. Give it real helicopter flight controls: throttle/collective for lift, pitch/roll/yaw for movement and turning, capable of hovering in place and flying at altitude.
- No fixed-wing airplane exists in the reference photos, but Jurek's original request explicitly included planes. Design one simple fixed-wing plane yourself, matching the same chunky voxel art style as the rest of the roster (use the other vehicles' proportions/color-blocking conventions as your style guide). Give it conventional flight-sim-lite controls: throttle, pitch/roll/yaw, needs forward speed to generate lift (not a hover craft).

**Watercraft — build the models now, but flag the limitation below:**
- `288-585.jpg` — white/gray yacht.
- `288-590.jpg` — black/white speedboat.
- Note: Phase 1's world is a flat test plaza with no water. There's nowhere to actually test on-water buoyancy physics yet — water bodies arrive with maps in Phase 4. For this phase, model both boats and give them a reasonable placeholder physics setup (e.g. constrained to a fixed height as if floating, drivable like a ground vehicle without real buoyancy simulation) so they're spawnable and drivable-in-principle on the Phase 1 plaza for testing. Real buoyancy against an actual water surface can be revisited once Phase 4 maps exist — flag this back explicitly as a known gap rather than over-building buoyancy physics against a body of water that doesn't exist yet.

All vehicles remain **indestructible** per the established rule — they can smash into destructible chunks and props (transferring physics impulse, same as the Phase 1 hatchback) but never take damage themselves.

## Vehicle selection / spawning menu

Per the earlier decision, vehicles use a **separate system from the weapon number-keys** (don't overload `1`-`4` etc., those are reserved for tools). Add a dedicated key (e.g. hold `Tab`) that opens a grid menu showing all available vehicles by name/icon. Selecting one spawns it near the player, positioned clear of existing geometry so it doesn't spawn embedded in the ground or a wall. To avoid unbounded prop clutter over a play session, despawn/replace the vehicle this same player last spawned when they spawn a new one (flag this assumption back if a different behavior — e.g. unlimited simultaneous spawns — is preferred).

## Definition of done for Phase 3

1. Every vehicle listed above (14 new + the existing hatchback = the full current roster) is spawnable from the vehicle menu, visually matches its reference image's silhouette/color-blocking, and is enterable/exitable with `E` exactly like the Phase 1 hatchback.
2. Ground vehicles handle with the same weighty, simulation-style physics as Phase 1's car, scaled appropriately to their size/weight (monster truck and crane truck should feel heavier than the sports car, for instance).
3. The helicopter and hover-DeLorean fly convincingly (can lift off, hover, and translate) with dedicated flight controls active while piloting them; camera behavior while flying is your judgment call (third-person chase is a reasonable default, matching the Phase 1 driving camera).
4. Both boats are spawnable and drivable on the plaza with placeholder (non-buoyant) physics, clearly documented as a known limitation pending Phase 4's water.
5. All vehicles remain indestructible and correctly apply impulse to destructible chunks/props on collision.
6. Vehicle menu doesn't conflict with the weapon number-key system.

## Explicitly out of scope for Phase 3
- No new weapons beyond Phase 2's four.
- No maps beyond the existing Phase 1 plaza.
- No lobby/avatar customization or multiplayer.
- No real buoyancy simulation (see note above) — that's deferred, not required here.
- Don't chase the full ~30-vehicle target beyond what the reference folder provides right now; the remaining count comes from future sourcing/sessions.

Report back on what was built, how to test each vehicle, and flag any deviations from this spec (especially anything about the hover vehicle, aircraft, or placeholder boat physics). **Stop here — do not proceed to Phase 4.**
