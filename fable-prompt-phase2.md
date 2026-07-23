# Voxel Demolition — Phase 2 build prompt (for Claude Fable 5)

This continues **Voxel Demolition**, a Teardown-inspired voxel destruction sandbox. **Phase 1 is already built and approved**: a test plaza with an indestructible ground core + destructible pre-fracture "skin" layer, a first-person character with a visible body, and one drivable vehicle. Build directly on top of that existing codebase — do not rewrite it from scratch.

Your job now is **only Phase 2: hand-held weapons/tools**. Stop and report back once this phase's definition of done is met — do not touch vehicles, maps, lobby/avatar, or multiplayer.

## Context: the destruction system you're plugging into

Phase 1 already has a pre-fracture chunk destruction system (objects pre-divided into chunks; on sufficient impact, chunks detach into real Rapier rigid bodies with mass/gravity/restitution, and settled bodies sleep for performance). So far the only thing triggering it is vehicle collision impulse. In this phase, you're adding new ways to trigger the same underlying system — from hand-held tools instead of a vehicle. Reuse and generalize that system (e.g. a shared "apply damage at point X with force/radius Y" function) rather than building a parallel one.

## Weapon roster for this phase

Long-term the game will have a roster of **30 tools total**, added incrementally over future sessions. This phase builds the **first 4**, each as its own numbered category (so future tools slot into the same categories without restructuring):

1. **Category 1 — Melee: Sledgehammer/crowbar.** Held in both hands, swings on left-click when aiming at something in melee range. Applies a strong, localized impulse at the hit point — detaches a small cluster of chunks right where you hit, satisfying "one good whack breaks a chunk off" feel. No ammo, unlimited use, has a short swing cooldown so it can't be spammed instantly.
2. **Category 2 — Explosives: C4 / dynamite charge.** Left-click to place a charge on a surface (sticks to whatever it's placed against, including vehicles' exterior surfaces if aimed there, though the vehicle itself still never takes damage). Press a detonate key (or right-click) to blow up all placed charges at once. Explosion applies a large-radius outward impulse, detaching and launching a wide cluster of chunks with real physics — the signature big, dramatic Teardown-style blast. No limit on number of placed charges for now (sandbox fun over resource management) — flag this assumption back if you think a placement limit is needed for performance.
3. **Category 3 — Firearm: pistol or shotgun (your call on which reads better for the voxel art style).** Left-click fires a hitscan or fast projectile shot. Smaller, precise impulse at the exact hit point — good for picking off individual chunks at range rather than area destruction. Unlimited ammo for now.
4. **Category 4 — Rocket launcher.** Left-click fires a slow visible projectile that explodes on impact with a large-radius impulse, similar magnitude to the C4 charge but delivered at range instead of placed by hand. Unlimited ammo for now.

Each tool needs a simple first-person held-model (visible in the player's hands, consistent with Phase 1's visible-body FPP setup) — doesn't need to be highly detailed, just clearly readable and voxel-styled.

## Selection UI

Reference: `Sketches/Sample Images/download.jpeg` — a real Teardown-mod menu screenshot showing the target interaction pattern. Implement it as follows:
- Pressing a number key (`1`-`4` for now, reserve `5`-`9` for future categories/vehicles-adjacent tools) selects that category and equips its first item.
- Pressing the **same number again** cycles to the next item within that category (right now each category only has one item, so pressing it again just re-confirms the same tool — but build the cycling logic generically so adding a second item to a category later doesn't require rework).
- Scrolling the mouse wheel while a category is active also cycles within it, same behavior as re-pressing the number.
- When switching tools, briefly show the tool's name on screen (small text near where the reference screenshot shows category/item names) so the player gets feedback on what they're holding — this is the one deliberate, minimal UI element allowed in this phase (Phase 1 had zero UI; this small always-brief label is the exception, scoped tightly to tool-switch feedback only).

## Definition of done for Phase 2

1. Player can press `1`, `2`, `3`, `4` to equip hammer, explosives, firearm, and rocket launcher respectively, each with a visible held-model.
2. Each tool visibly and physically breaks destructible chunks (ground skin and/or props from Phase 1) using the existing pre-fracture/physics system, with force/radius appropriate to that tool (melee = small & local, explosives/rocket = large & radius-based, firearm = small & precise).
3. C4/dynamite can be placed and remotely detonated, separate from the fire-and-forget rocket launcher.
4. Tool-switch shows a brief on-screen name label, otherwise the screen stays clean per Phase 1's minimal-UI philosophy.
5. Performance holds up under repeated explosive use — chunk/debris cleanup and body-sleeping discipline from Phase 1 still applies; don't let debris counts grow unbounded across a long play session.

## Explicitly out of scope for Phase 2
- No additional vehicles, maps, avatar customization, or multiplayer.
- No ammo/inventory management system — unlimited use for all 4 tools, as stated above.
- No fire/burning system (intentionally cut from the whole project).
- No weapons beyond these first 4 — the remaining ~26 toward the eventual 30-tool roster come in later sessions, reusing this same category/cycling system.

Report back on what was built, how to test it, and flag any deviations from this spec. **Stop here — do not proceed to Phase 3.**
