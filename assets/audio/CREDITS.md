# Audio credits

All sound files in this folder are **CC0 (public domain)**. They are committed to the
project and loaded locally at runtime (no hotlinking), so the game works offline / on LAN.

| File in project | Original file | Source pack / page | Author | License |
|---|---|---|---|---|
| footstep_0.ogg | footstep_concrete_000.ogg | Kenney — Impact Sounds — https://kenney.nl/assets/impact-sounds | Kenney (kenney.nl) | CC0 1.0 |
| footstep_1.ogg | footstep_concrete_001.ogg | Kenney — Impact Sounds | Kenney (kenney.nl) | CC0 1.0 |
| footstep_2.ogg | footstep_concrete_002.ogg | Kenney — Impact Sounds | Kenney (kenney.nl) | CC0 1.0 |
| footstep_3.ogg | footstep_concrete_003.ogg | Kenney — Impact Sounds | Kenney (kenney.nl) | CC0 1.0 |
| impact_0.ogg | impactPlank_medium_000.ogg | Kenney — Impact Sounds | Kenney (kenney.nl) | CC0 1.0 |
| impact_1.ogg | impactWood_heavy_000.ogg | Kenney — Impact Sounds | Kenney (kenney.nl) | CC0 1.0 |
| impact_2.ogg | impactSoft_heavy_000.ogg | Kenney — Impact Sounds | Kenney (kenney.nl) | CC0 1.0 |
| clang.ogg | impactMetal_heavy_000.ogg | Kenney — Impact Sounds | Kenney (kenney.nl) | CC0 1.0 |
| thud.ogg | impactWood_medium_000.ogg | Kenney — Impact Sounds | Kenney (kenney.nl) | CC0 1.0 |
| engine_loop.ogg | engineCircular_000.ogg | Kenney — Sci-Fi Sounds — https://kenney.nl/assets/sci-fi-sounds | Kenney (kenney.nl) | CC0 1.0 |
| explosion_0.ogg | explosionCrunch_000.ogg | Kenney — Sci-Fi Sounds | Kenney (kenney.nl) | CC0 1.0 |
| explosion_1.ogg | lowFrequency_explosion_000.ogg | Kenney — Sci-Fi Sounds | Kenney (kenney.nl) | CC0 1.0 |
| rocket_launch.ogg | thrusterFire_000.ogg | Kenney — Sci-Fi Sounds | Kenney (kenney.nl) | CC0 1.0 |
| swing.ogg | knifeSlice.ogg | Kenney — RPG Audio — https://kenney.nl/assets/rpg-audio | Kenney (kenney.nl) | CC0 1.0 |
| c4_place.ogg | click_002.ogg | Kenney — Interface Sounds — https://kenney.nl/assets/interface-sounds | Kenney (kenney.nl) | CC0 1.0 |
| detonate_beep.ogg | confirmation_001.ogg | Kenney — Interface Sounds | Kenney (kenney.nl) | CC0 1.0 |
| gunshot.wav | toy-double-barrel-shotgun-left-trigger.wav | OpenGameArt — Toy Double-Barrel Shotgun Sounds — https://opengameart.org/content/toy-double-barrel-shotgun-sounds | jumbosizedfish | CC0 1.0 |
| rotor_loop.ogg | engineCircular_001.ogg | Kenney — Sci-Fi Sounds — https://kenney.nl/assets/sci-fi-sounds | Kenney (kenney.nl) | CC0 1.0 |
| plane_loop.ogg | thrusterFire_001.ogg | Kenney — Sci-Fi Sounds | Kenney (kenney.nl) | CC0 1.0 |
| hover_loop.ogg | forceField_000.ogg | Kenney — Sci-Fi Sounds | Kenney (kenney.nl) | CC0 1.0 |
| boat_loop.ogg | engineCircular_003.ogg | Kenney — Sci-Fi Sounds | Kenney (kenney.nl) | CC0 1.0 |

## Runtime usage notes
- Phase 3 vehicle loops: `rotor_loop.ogg` (helicopter), `plane_loop.ogg` (airplane),
  `hover_loop.ogg` (hover craft), `boat_loop.ogg` (watercraft). Each is a persistent
  looped source whose `playbackRate`/gain is driven by the piloted vehicle's state; ground
  vehicles keep using `engine_loop.ogg`. Freesound was the primary candidate for the rotor,
  plane and boat loops but requires an authenticated download, so the proven CC0 Kenney
  Sci-Fi Sounds pack (same source as `engine_loop.ogg`) was used per the brief's fallback.
- `rocket_launch.ogg` (a 5 s thruster loop) is played as a ~0.6 s slice for the launch whoosh.
- `gunshot.wav` is a single double-barrel trigger blast, pitched down slightly for body.
- `engine_loop.ogg` is looped with `playbackRate` driven by wheel speed.
- All Kenney packs are CC0 per https://kenney.nl (see each pack page). The shotgun entry
  is marked CC0 on its OpenGameArt page (license verified before use).
