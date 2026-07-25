# Audio credits

Every sound file in this folder is **CC0 1.0 (public domain)**, downloaded from the source page
listed below, processed offline and committed to the repository. Nothing is fetched from the
network at runtime and nothing is synthesised in WebAudio, so the game works fully offline / on LAN.

**Processing applied to every file** (offline, with ffmpeg + numpy — see the "Processing" section):
decode to mono 44.1 kHz, window/trim, group-normalise, click-free edge fades, and for loops a
0.18 s wrap-around crossfade. Files are re-encoded as Ogg Vorbis (q3). The `Processing` column
records the window taken out of the original recording.

Total: 155 .ogg files, ~2.7 MB.

## Source packs (all CC0 1.0, licence verified on each page)

| Pack / entry | Author | Page |
|---|---|---|
| 75 CC0 breaking / falling / hit sfx | rubberduck | https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx |
| 100 CC0 SFX | rubberduck | https://opengameart.org/content/100-cc0-sfx |
| 100 CC0 SFX #2 | rubberduck | https://opengameart.org/content/100-cc0-sfx-2 |
| 100 CC0 metal and wood SFX | rubberduck | https://opengameart.org/content/100-cc0-metal-and-wood-sfx |
| 40 CC0 water / splash / slime SFX | rubberduck | https://opengameart.org/content/40-cc0-water-splash-slime-sfx |
| 30 CC0 SFX loops | rubberduck | https://opengameart.org/content/30-cc0-sfx-loops |
| 25 CC0 bang / firework SFX | rubberduck | https://opengameart.org/content/25-cc0-bang-firework-sfx |
| 50 CC0 Sci-Fi SFX | rubberduck | https://opengameart.org/content/50-cc0-sci-fi-sfx |
| 5 break, crunch impacts | Independent.nu (submitted by qubodup) | https://opengameart.org/content/5-break-crunch-impacts |
| Fantozzi's Footsteps (Grass/Sand & Stone) | Fantozzi (submitted by qubodup) | https://opengameart.org/content/fantozzis-footsteps-grasssand-stone |
| Metal footsteps on concrete | Thimras | https://opengameart.org/content/metal-footsteps-on-concrete |
| 202 More Sound Effects | OwlishMedia | https://opengameart.org/content/202-more-sound-effects |
| 68 Workshop Sounds | bart | https://opengameart.org/content/68-workshop-sounds |
| Swishes Sound Pack | artisticdude | https://opengameart.org/content/swishes-sound-pack |
| The Free Firearm Sound Library | Ben Jaszczak et al. (submitted by bart) | https://opengameart.org/content/the-free-firearm-sound-library |
| Car Sound Effects Pack (Low Quality) | GGBotNet | https://opengameart.org/content/car-sound-effects-pack-low-quality |
| Engine sounds(2) | pauliuw | https://opengameart.org/content/engine-sounds2 |
| Helicopter Sounds | aquinn | https://opengameart.org/content/helicopter-sounds |
| Propeller (Cartoon) Loop | Mish7913 | https://opengameart.org/content/propeller-cartoon-loop |
| Steamboat Engine Sound | Spring Spring | https://opengameart.org/content/steamboat-engine-sound |
| Motor Sound Effect | EZduzziteh | https://opengameart.org/content/motor-sound-effect |
| Explosions | EZduzziteh | https://opengameart.org/content/explosions-4 |
| Explosion | TinyWorlds | https://opengameart.org/content/explosion-0 |
| Chunky Explosion | Joth | https://opengameart.org/content/chunky-explosion |
| Muffled Distant Explosion | NenadSimic | https://opengameart.org/content/muffled-distant-explosion |
| Rocket launch | qubodup | https://opengameart.org/content/rocket-launch |
| Air whoosh | pyranostudios | https://opengameart.org/content/air-whoosh |
| wind1 | Luke.RUSTLTD | https://opengameart.org/content/wind1 |
| Kenney — Interface Sounds | Kenney (kenney.nl) | https://kenney.nl/assets/interface-sounds |
| Kenney — Sci-Fi Sounds | Kenney (kenney.nl) | https://kenney.nl/assets/sci-fi-sounds |

## Per-file table

| File in project | Original file | Source pack | Author | License | Processing |
|---|---|---|---|---|---|
| airstrike_flyby.ogg | whoosh2_0.wav | [Air whoosh](https://opengameart.org/content/air-whoosh) | pyranostudios | CC0 1.0 | from 0.30s, 3.00s window |
| amb_city.ogg | sfx100v2_loop_highway.ogg | [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2) | rubberduck | CC0 1.0 | from 1.00s, 12.00s window, crossfade-looped |
| amb_wind.ogg | wind1.wav | [wind1](https://opengameart.org/content/wind1) | Luke.RUSTLTD | CC0 1.0 | from 3.00s, 12.00s window, crossfade-looped |
| boat_loop.ogg | steamboat_engine.wav | [Steamboat Engine Sound](https://opengameart.org/content/steamboat-engine-sound) | Spring Spring | CC0 1.0 | from 1.50s, 4.00s window, crossfade-looped |
| bomb_whistle.ogg | sfx100v2_air_01.ogg | [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2) | rubberduck | CC0 1.0 |  |
| bounce_clink_0.ogg | bfh1_metal_hit_06.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| bounce_clink_1.ogg | metal_hit_01.ogg | [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 1.0 |  |
| bounce_clink_2.ogg | workshop - clink1.wav | [68 Workshop Sounds](https://opengameart.org/content/68-workshop-sounds) | bart | CC0 1.0 |  |
| car_crash_0.ogg | workshop - loud clatter.wav | [68 Workshop Sounds](https://opengameart.org/content/68-workshop-sounds) | bart | CC0 1.0 |  |
| car_crash_1.ogg | bfh1_metal_falling_03.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| car_whoosh.ogg | whoosh2_0.wav | [Air whoosh](https://opengameart.org/content/air-whoosh) | pyranostudios | CC0 1.0 | from 0.50s, 1.30s window |
| chainsaw_cut.ogg | saw.ogg | [30 CC0 SFX loops](https://opengameart.org/content/30-cc0-sfx-loops) | rubberduck | CC0 1.0 | from 0.35s, 1.50s window, crossfade-looped |
| chainsaw_idle.ogg | workshop - drill long.wav | [68 Workshop Sounds](https://opengameart.org/content/68-workshop-sounds) | bart | CC0 1.0 | from 1.20s, 2.60s window, crossfade-looped |
| chainsaw_screech_0.ogg | workshop - scrape1.wav | [68 Workshop Sounds](https://opengameart.org/content/68-workshop-sounds) | bart | CC0 1.0 | from 0.20s, 0.60s window |
| chainsaw_screech_1.ogg | workshop - scrape3.wav | [68 Workshop Sounds](https://opengameart.org/content/68-workshop-sounds) | bart | CC0 1.0 | from 0.20s, 0.60s window |
| chainsaw_screech_2.ogg | workshop - scrape5.wav | [68 Workshop Sounds](https://opengameart.org/content/68-workshop-sounds) | bart | CC0 1.0 | from 0.20s, 0.60s window |
| clang_0.ogg | hammer_02.ogg | [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 1.0 |  |
| clang_1.ogg | hammer_04.ogg | [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 1.0 |  |
| clang_2.ogg | bfh1_metal_hit_04.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| cluster_pop_0.ogg | shot_01.ogg | [25 CC0 bang / firework SFX](https://opengameart.org/content/25-cc0-bang-firework-sfx) | rubberduck | CC0 1.0 |  |
| cluster_pop_1.ogg | shot_02.ogg | [25 CC0 bang / firework SFX](https://opengameart.org/content/25-cc0-bang-firework-sfx) | rubberduck | CC0 1.0 |  |
| cluster_pop_2.ogg | shot_03.ogg | [25 CC0 bang / firework SFX](https://opengameart.org/content/25-cc0-bang-firework-sfx) | rubberduck | CC0 1.0 |  |
| crowbar_clang_0.ogg | hammer_01.ogg | [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 1.0 |  |
| crowbar_clang_1.ogg | hammer_03.ogg | [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 1.0 |  |
| crowbar_clang_2.ogg | workshop - dull ping.wav | [68 Workshop Sounds](https://opengameart.org/content/68-workshop-sounds) | bart | CC0 1.0 |  |
| crowbar_pry_0.ogg | wood_cracking_01.ogg | [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 1.0 |  |
| crowbar_pry_1.ogg | wood_cracking_02.ogg | [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 1.0 |  |
| crowbar_pry_2.ogg | wood_cracking_03.ogg | [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 1.0 |  |
| crumble_0.ogg | impactcrunch01.mp3.flac | [5 break, crunch impacts](https://opengameart.org/content/5-break-crunch-impacts) | Independent.nu (submitted by qubodup) | CC0 1.0 |  |
| crumble_1.ogg | impactcrunch03.mp3.flac | [5 break, crunch impacts](https://opengameart.org/content/5-break-crunch-impacts) | Independent.nu (submitted by qubodup) | CC0 1.0 |  |
| crumble_2.ogg | impactcrunch05.mp3.flac | [5 break, crunch impacts](https://opengameart.org/content/5-break-crunch-impacts) | Independent.nu (submitted by qubodup) | CC0 1.0 |  |
| debris_0.ogg | bfh1_rock_falling_02.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| debris_1.ogg | bfh1_rock_falling_05.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| debris_2.ogg | bfh1_rock_falling_08.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| debris_3.ogg | bfh1_falling_03.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| debris_4.ogg | bfh1_metal_falling_02.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| engine_car_loop.ogg | Car_Engine_Loop.ogg | [Car Sound Effects Pack (Low Quality)](https://opengameart.org/content/car-sound-effects-pack-low-quality) | GGBotNet | CC0 1.0 | from 0.10s, 2.60s window, crossfade-looped |
| engine_diesel_loop.ogg | engine_sound.mp3 | [Engine sounds(2)](https://opengameart.org/content/engine-sounds2) | pauliuw | CC0 1.0 | from 6.00s, 5.00s window, crossfade-looped |
| explosion_0.ogg | explosion1_0.ogg | [Explosions](https://opengameart.org/content/explosions-4) | EZduzziteh | CC0 1.0 |  |
| explosion_1.ogg | explosion3.ogg | [Explosions](https://opengameart.org/content/explosions-4) | EZduzziteh | CC0 1.0 |  |
| explosion_2.ogg | explosion.wav | [Explosion](https://opengameart.org/content/explosion-0) | TinyWorlds | CC0 1.0 |  |
| explosion_3.ogg | cannon_02.ogg | [25 CC0 bang / firework SFX](https://opengameart.org/content/25-cc0-bang-firework-sfx) | rubberduck | CC0 1.0 |  |
| explosion_huge.ogg | Chunky%20Explosion.mp3 | [Chunky Explosion](https://opengameart.org/content/chunky-explosion) | Joth | CC0 1.0 | 5.60s window |
| explosion_rumble.ogg | NenadSimic%20-%20Muffled%20Distant%20Explosion.wav | [Muffled Distant Explosion](https://opengameart.org/content/muffled-distant-explosion) | NenadSimic | CC0 1.0 | 5.10s window |
| explosion_small_0.ogg | explosions4.ogg | [Explosions](https://opengameart.org/content/explosions-4) | EZduzziteh | CC0 1.0 |  |
| explosion_small_1.ogg | explosion2.ogg | [Explosions](https://opengameart.org/content/explosions-4) | EZduzziteh | CC0 1.0 |  |
| explosion_small_2.ogg | bang_08.ogg | [25 CC0 bang / firework SFX](https://opengameart.org/content/25-cc0-bang-firework-sfx) | rubberduck | CC0 1.0 |  |
| foam_harden_0.ogg | sfx100v2_stones_02.ogg | [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2) | rubberduck | CC0 1.0 |  |
| foam_harden_1.ogg | sfx100v2_stones_03.ogg | [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2) | rubberduck | CC0 1.0 |  |
| foam_splat_0.ogg | slime_02.ogg | [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | rubberduck | CC0 1.0 |  |
| foam_splat_1.ogg | slime_05.ogg | [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | rubberduck | CC0 1.0 |  |
| foam_splat_2.ogg | slime_09.ogg | [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | rubberduck | CC0 1.0 |  |
| foam_splat_3.ogg | slime_14.ogg | [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | rubberduck | CC0 1.0 |  |
| foam_spray.ogg | water_flowing.ogg | [30 CC0 SFX loops](https://opengameart.org/content/30-cc0-sfx-loops) | rubberduck | CC0 1.0 | from 0.10s, 1.60s window, crossfade-looped |
| footstep_concrete_0.ogg | Fantozzi-StoneL1.ogg | [Fantozzi's Footsteps (Grass/Sand & Stone)](https://opengameart.org/content/fantozzis-footsteps-grasssand-stone) | Fantozzi (submitted by qubodup) | CC0 1.0 |  |
| footstep_concrete_1.ogg | Fantozzi-StoneR1.ogg | [Fantozzi's Footsteps (Grass/Sand & Stone)](https://opengameart.org/content/fantozzis-footsteps-grasssand-stone) | Fantozzi (submitted by qubodup) | CC0 1.0 |  |
| footstep_concrete_2.ogg | Fantozzi-StoneL2.ogg | [Fantozzi's Footsteps (Grass/Sand & Stone)](https://opengameart.org/content/fantozzis-footsteps-grasssand-stone) | Fantozzi (submitted by qubodup) | CC0 1.0 |  |
| footstep_concrete_3.ogg | Fantozzi-StoneR2.ogg | [Fantozzi's Footsteps (Grass/Sand & Stone)](https://opengameart.org/content/fantozzis-footsteps-grasssand-stone) | Fantozzi (submitted by qubodup) | CC0 1.0 |  |
| footstep_concrete_4.ogg | Fantozzi-StoneL3.ogg | [Fantozzi's Footsteps (Grass/Sand & Stone)](https://opengameart.org/content/fantozzis-footsteps-grasssand-stone) | Fantozzi (submitted by qubodup) | CC0 1.0 |  |
| footstep_concrete_5.ogg | Fantozzi-StoneR3.ogg | [Fantozzi's Footsteps (Grass/Sand & Stone)](https://opengameart.org/content/fantozzis-footsteps-grasssand-stone) | Fantozzi (submitted by qubodup) | CC0 1.0 |  |
| footstep_metal_0.ogg | metal_steps_01.wav | [Metal footsteps on concrete](https://opengameart.org/content/metal-footsteps-on-concrete) | Thimras | CC0 1.0 |  |
| footstep_metal_1.ogg | metal_steps_07.wav | [Metal footsteps on concrete](https://opengameart.org/content/metal-footsteps-on-concrete) | Thimras | CC0 1.0 |  |
| footstep_metal_2.ogg | metal_steps_14.wav | [Metal footsteps on concrete](https://opengameart.org/content/metal-footsteps-on-concrete) | Thimras | CC0 1.0 |  |
| footstep_metal_3.ogg | metal_steps_21.wav | [Metal footsteps on concrete](https://opengameart.org/content/metal-footsteps-on-concrete) | Thimras | CC0 1.0 |  |
| footstep_sand_0.ogg | Fantozzi-SandL1.ogg | [Fantozzi's Footsteps (Grass/Sand & Stone)](https://opengameart.org/content/fantozzis-footsteps-grasssand-stone) | Fantozzi (submitted by qubodup) | CC0 1.0 |  |
| footstep_sand_1.ogg | Fantozzi-SandR1.ogg | [Fantozzi's Footsteps (Grass/Sand & Stone)](https://opengameart.org/content/fantozzis-footsteps-grasssand-stone) | Fantozzi (submitted by qubodup) | CC0 1.0 |  |
| footstep_sand_2.ogg | Fantozzi-SandL2.ogg | [Fantozzi's Footsteps (Grass/Sand & Stone)](https://opengameart.org/content/fantozzis-footsteps-grasssand-stone) | Fantozzi (submitted by qubodup) | CC0 1.0 |  |
| footstep_sand_3.ogg | Fantozzi-SandR2.ogg | [Fantozzi's Footsteps (Grass/Sand & Stone)](https://opengameart.org/content/fantozzis-footsteps-grasssand-stone) | Fantozzi (submitted by qubodup) | CC0 1.0 |  |
| footstep_wood_0.ogg | sfx100v2_footstep_wood_01.ogg | [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2) | rubberduck | CC0 1.0 |  |
| footstep_wood_1.ogg | sfx100v2_footstep_wood_02.ogg | [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2) | rubberduck | CC0 1.0 |  |
| footstep_wood_2.ogg | sfx100v2_footstep_wood_03.ogg | [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2) | rubberduck | CC0 1.0 |  |
| footstep_wood_3.ogg | sfx100v2_footstep_wood_04.ogg | [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2) | rubberduck | CC0 1.0 |  |
| fuse_hiss.ogg | noise_01.ogg | [30 CC0 SFX loops](https://opengameart.org/content/30-cc0-sfx-loops) | rubberduck | CC0 1.0 | from 1.00s, 3.00s window, crossfade-looped |
| grapple_anchor_0.ogg | metal_hit_02.ogg | [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 1.0 |  |
| grapple_anchor_1.ogg | metal_hit_04.ogg | [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 1.0 |  |
| grapple_anchor_2.ogg | bfh1_metal_hit_02.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| grapple_launch.ogg | shoot_01.ogg | [50 CC0 Sci-Fi SFX](https://opengameart.org/content/50-cc0-sci-fi-sfx) | rubberduck | CC0 1.0 |  |
| grapple_reel.ogg | machine_02.ogg | [30 CC0 SFX loops](https://opengameart.org/content/30-cc0-sfx-loops) | rubberduck | CC0 1.0 | 0.55s window, crossfade-looped |
| grapple_snap_0.ogg | metal_spring_01.ogg | [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 1.0 |  |
| grapple_snap_1.ogg | metal_spring_02.ogg | [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 1.0 |  |
| gravity_hum.ogg | loop_ambient_01.ogg | [50 CC0 Sci-Fi SFX](https://opengameart.org/content/50-cc0-sci-fi-sfx) | rubberduck | CC0 1.0 | from 1.00s, 4.00s window, crossfade-looped |
| gravity_throw.ogg | whoosh2_0.wav | [Air whoosh](https://opengameart.org/content/air-whoosh) | pyranostudios | CC0 1.0 | from 2.40s, 0.90s window |
| impact_concrete_0.ogg | bfh1_rock_hit_01.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_concrete_1.ogg | bfh1_rock_breaking_01.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_concrete_2.ogg | bfh1_rock_breaking_02.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_concrete_3.ogg | bfh1_rock_breaking_03.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_concrete_4.ogg | impactcrunch02.mp3.flac | [5 break, crunch impacts](https://opengameart.org/content/5-break-crunch-impacts) | Independent.nu (submitted by qubodup) | CC0 1.0 |  |
| impact_glass_0.ogg | bfh1_glass_breaking_01.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_glass_1.ogg | bfh1_glass_breaking_03.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_glass_2.ogg | bfh1_glass_breaking_05.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_glass_3.ogg | bfh1_glass_hit_01.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_metal_0.ogg | bfh1_metal_hit_01.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_metal_1.ogg | bfh1_metal_hit_02.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_metal_2.ogg | bfh1_metal_hit_03.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_metal_3.ogg | bfh1_metal_hit_05.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_metal_4.ogg | metal_hit_05.ogg | [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 1.0 |  |
| impact_wood_0.ogg | bfh1_wood_hit_01.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_wood_1.ogg | bfh1_wood_hit_02.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_wood_2.ogg | bfh1_wood_hit_03.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_wood_3.ogg | bfh1_wood_breaking_01.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| impact_wood_4.ogg | bfh1_wood_breaking_02.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| jump_0.ogg | Cloth_02.wav | [202 More Sound Effects](https://opengameart.org/content/202-more-sound-effects) | OwlishMedia | CC0 1.0 | 0.60s window |
| jump_1.ogg | Cloth_05.wav | [202 More Sound Effects](https://opengameart.org/content/202-more-sound-effects) | OwlishMedia | CC0 1.0 | 0.60s window |
| land_0.ogg | bfh1_hit_02.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| land_1.ogg | bfh1_hit_07.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| land_2.ogg | bfh1_hit_12.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| magnet_attract.ogg | loop_machine_01.ogg | [50 CC0 Sci-Fi SFX](https://opengameart.org/content/50-cc0-sci-fi-sfx) | rubberduck | CC0 1.0 | from 0.20s, 2.60s window, crossfade-looped |
| magnet_repel.ogg | loop_machine_02.ogg | [50 CC0 Sci-Fi SFX](https://opengameart.org/content/50-cc0-sci-fi-sfx) | rubberduck | CC0 1.0 | from 0.20s, 2.60s window, crossfade-looped |
| nuke_arm.ogg | beep_03.ogg | [50 CC0 Sci-Fi SFX](https://opengameart.org/content/50-cc0-sci-fi-sfx) | rubberduck | CC0 1.0 |  |
| nuke_klaxon.ogg | alarm_01.ogg | [30 CC0 SFX loops](https://opengameart.org/content/30-cc0-sfx-loops) | rubberduck | CC0 1.0 |  |
| orbital_charge.ogg | teleport_02.ogg | [50 CC0 Sci-Fi SFX](https://opengameart.org/content/50-cc0-sci-fi-sfx) | rubberduck | CC0 1.0 |  |
| orbital_zap.ogg | loop_machine_03.ogg | [50 CC0 Sci-Fi SFX](https://opengameart.org/content/50-cc0-sci-fi-sfx) | rubberduck | CC0 1.0 | from 0.40s, 1.50s window |
| plane_loop.ogg | propeller_cartoon_loop_0.ogg | [Propeller (Cartoon) Loop](https://opengameart.org/content/propeller-cartoon-loop) | Mish7913 | CC0 1.0 | 1.55s window, crossfade-looped |
| propane_clonk_0.ogg | workshop - metal drop.wav | [68 Workshop Sounds](https://opengameart.org/content/68-workshop-sounds) | bart | CC0 1.0 |  |
| propane_clonk_1.ogg | metal_sheet_02.ogg | [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 1.0 |  |
| rc_motor.ogg | motor_looping_0.mp3 | [Motor Sound Effect](https://opengameart.org/content/motor-sound-effect) | EZduzziteh | CC0 1.0 | 0.90s window, crossfade-looped |
| rebuild_settle_0.ogg | bfh1_rock_falling_04.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| rebuild_settle_1.ogg | bfh1_rock_falling_06.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| rebuild_settle_2.ogg | sfx100v2_stones_01.ogg | [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2) | rubberduck | CC0 1.0 |  |
| rocket_launch.ogg | launch.wav | [Rocket launch](https://opengameart.org/content/rocket-launch) | qubodup | CC0 1.0 | 2.50s window |
| rotor_loop.ogg | helicopter_0.mp3 | [Helicopter Sounds](https://opengameart.org/content/helicopter-sounds) | aquinn | CC0 1.0 | from 12.00s, 5.00s window, crossfade-looped |
| shotgun_0.ogg | O_21P.wav | [The Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library) | Ben Jaszczak et al. (submitted by bart) | CC0 1.0 | from 0.35s, 1.80s window |
| shotgun_1.ogg | K_22P.wav | [The Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library) | Ben Jaszczak et al. (submitted by bart) | CC0 1.0 | from 7.37s, 1.80s window |
| shotgun_2.ogg | N_30P.wav | [The Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library) | Ben Jaszczak et al. (submitted by bart) | CC0 1.0 | from 4.88s, 1.80s window |
| size_grow.ogg | misc_04.ogg | [50 CC0 Sci-Fi SFX](https://opengameart.org/content/50-cc0-sci-fi-sfx) | rubberduck | CC0 1.0 |  |
| size_shrink.ogg | misc_03.ogg | [50 CC0 Sci-Fi SFX](https://opengameart.org/content/50-cc0-sci-fi-sfx) | rubberduck | CC0 1.0 |  |
| splash_0.ogg | splash_05.ogg | [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | rubberduck | CC0 1.0 |  |
| splash_1.ogg | splash_09.ogg | [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | rubberduck | CC0 1.0 |  |
| splash_2.ogg | splash_13.ogg | [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | rubberduck | CC0 1.0 |  |
| spray_loop.ogg | noise_02.ogg | [30 CC0 SFX loops](https://opengameart.org/content/30-cc0-sfx-loops) | rubberduck | CC0 1.0 | from 0.50s, 2.50s window, crossfade-looped |
| stick_splat_0.ogg | slime_03.ogg | [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | rubberduck | CC0 1.0 |  |
| stick_splat_1.ogg | slime_07.ogg | [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | rubberduck | CC0 1.0 |  |
| stick_splat_2.ogg | slime_11.ogg | [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | rubberduck | CC0 1.0 |  |
| sticky_thoomp_0.ogg | bfh1_hit_10.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| sticky_thoomp_1.ogg | plop_02.ogg | [100 CC0 SFX](https://opengameart.org/content/100-cc0-sfx) | rubberduck | CC0 1.0 |  |
| swing_0.ogg | swish-1.wav | [Swishes Sound Pack](https://opengameart.org/content/swishes-sound-pack) | artisticdude | CC0 1.0 |  |
| swing_1.ogg | swish-3.wav | [Swishes Sound Pack](https://opengameart.org/content/swishes-sound-pack) | artisticdude | CC0 1.0 |  |
| swing_2.ogg | swish-5.wav | [Swishes Sound Pack](https://opengameart.org/content/swishes-sound-pack) | artisticdude | CC0 1.0 |  |
| swing_3.ogg | swish-7.wav | [Swishes Sound Pack](https://opengameart.org/content/swishes-sound-pack) | artisticdude | CC0 1.0 |  |
| swing_4.ogg | swish-9.wav | [Swishes Sound Pack](https://opengameart.org/content/swishes-sound-pack) | artisticdude | CC0 1.0 |  |
| thud_0.ogg | bfh1_hit_03.ogg | [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0 1.0 |  |
| thud_1.ogg | wood_hit_04.ogg | [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 1.0 |  |
| thud_2.ogg | workshop - wood on concrete.wav | [68 Workshop Sounds](https://opengameart.org/content/68-workshop-sounds) | bart | CC0 1.0 | 0.70s window |
| vacuum_loop.ogg | workshop - machine.wav | [68 Workshop Sounds](https://opengameart.org/content/68-workshop-sounds) | bart | CC0 1.0 | from 3.00s, 3.50s window, crossfade-looped |
| vacuum_thup_0.ogg | plop_01.ogg | [100 CC0 SFX](https://opengameart.org/content/100-cc0-sfx) | rubberduck | CC0 1.0 |  |
| vacuum_thup_1.ogg | plop_02.ogg | [100 CC0 SFX](https://opengameart.org/content/100-cc0-sfx) | rubberduck | CC0 1.0 |  |
| vacuum_thup_2.ogg | splash_02.ogg | [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | rubberduck | CC0 1.0 |  |
| wade_loop.ogg | loop_water_02.ogg | [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | rubberduck | CC0 1.0 | from 1.00s, 4.00s window, crossfade-looped |
| wind_whoomp_0.ogg | sfx100v2_air_02.ogg | [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2) | rubberduck | CC0 1.0 |  |
| wind_whoomp_1.ogg | sfx100v2_air_03.ogg | [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2) | rubberduck | CC0 1.0 |  |
| wind_whoomp_2.ogg | whoosh2_0.wav | [Air whoosh](https://opengameart.org/content/air-whoosh) | pyranostudios | CC0 1.0 | from 1.60s, 1.00s window |
| c4_place.ogg | click_002.ogg | [Kenney — Interface Sounds](https://kenney.nl/assets/interface-sounds) | Kenney (kenney.nl) | CC0 1.0 | unchanged (kept from the previous set) |
| detonate_beep.ogg | confirmation_001.ogg | [Kenney — Interface Sounds](https://kenney.nl/assets/interface-sounds) | Kenney (kenney.nl) | CC0 1.0 | unchanged (kept from the previous set) |
| wire_beep.ogg | bong_001.ogg | [Kenney — Interface Sounds](https://kenney.nl/assets/interface-sounds) | Kenney (kenney.nl) | CC0 1.0 | unchanged (kept from the previous set) |
| hover_loop.ogg | forceField_000.ogg | [Kenney — Sci-Fi Sounds](https://kenney.nl/assets/sci-fi-sounds) | Kenney (kenney.nl) | CC0 1.0 | unchanged (kept from the previous set) |

## Processing

Offline pipeline (not part of the game, run once when the assets were built):

1. `ffmpeg` decode -> mono 44.1 kHz float.
2. Window: `from Xs` / `Ys window` in the table above (used to pick the right shot out of a
   multi-take recording, or a steady section out of a long engine take).
3. One-shots: leading silence trimmed at -38 dBFS, 3 ms fade-in / 12 ms fade-out (60 ms for
   sounds whose decay tail matters — explosions, gunshots, glass, debris).
4. Loops: the following 0.18 s is crossfaded over the head, then DC-removed, so the wrap point
   is inaudible with `AudioBufferSourceNode.loop = true` and no scripted fade is needed.
5. Normalisation is **per group**, not per file: a whole variation set (e.g. all five concrete
   impacts) shares one gain, so the natural loudness differences between a light and a heavy hit
   survive. One-shots peak at -1.5 dBFS, loops at -6 dBFS (they play continuously underneath).
6. Encode: Ogg Vorbis q3. This machine's ffmpeg has no `libvorbis` and its native Vorbis encoder
   is stereo-only, so the mono signal is duplicated to two channels; joint-stereo coupling keeps
   the size within a few percent of true mono.

## Runtime usage notes

- **Buses.** `master -> limiter -> destination`, with `world` (impacts/debris/crumble), `weapon`,
  `tool` (held-tool loops), `vehicle`, `player`, `ui` and `amb` gain buses feeding master. The
  limiter is a soft-knee `DynamicsCompressorNode` that catches stacked explosions instead of
  letting the sum clip.
- **Variation.** Every repeating sound picks a random file from its set and gets a random
  playback-rate jitter (`CONFIG.audio.pitchJitter`); world one-shots also get a random stereo
  placement of +/-0.45.
- **Material-aware impacts.** `impact(force, material)` picks concrete (default), wood, metal or
  glass. `debris()` and `crumble()` cover scatter and structural collapse.
- **Footsteps.** Four surface sets (concrete x6, sand x4, wood x4, metal x4). `setFootstepSurface()`
  or the 4th argument of `footstepTick()` selects one; concrete is the default.
- **Vehicle loops.** One persistent looped source per slot, gain 0 until piloted. `engine` has two
  timbres — a real petrol car loop and a deep diesel loop — and `setEngine()` picks the diesel one
  for profiles that idle at or below rate 0.6 (the `heavy` profile: trucks, excavators, the crane).
- **Chainsaw** = a real power-tool motor loop (idle, always on while equipped) layered with a real
  saw-in-material loop while it is actually chewing a chunk.
- **Nuke / big blast** = the largest CC0 blast in the set layered with a 5 s distant-rumble tail.
- **Airstrike flyby / falling bomb** are real air-rush recordings with an automated downward
  `playbackRate` ramp for the doppler drop — no synthesis, just pitch automation on a real buffer.
- **Ambience** (`ambience(name)`) and the water sounds (`splash`, `wade`) ship with files and a
  public API but are not called by the game yet; wiring them up is a one-line change per event.
