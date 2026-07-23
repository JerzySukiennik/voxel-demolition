# Voxel Demolition — Phase 5 build prompt (for Claude Fable 5)

This continues **Voxel Demolition**. **Phases 1-4 are already built and approved**: destructible-ground/building pipeline, a first-person character, a weapon roster, a vehicle roster, and 2-3 real maps. Everything so far is still local/single-player with no formal join or customization flow — you've been loading maps and spawning in via temporary debug methods. Build directly on top of that existing codebase.

Your job now is **only Phase 5: the lobby and avatar system**. Stop and report back once this phase's definition of done is met — do not touch multiplayer/networking (that's Phase 6, the very next and final phase).

## Flow to build

On loading the game (before spawning into the world), the player sees a simple lobby/setup screen with:
1. **Nickname entry** — a text field, free text, reasonable length cap. This is preparing for Phase 6 multiplayer where other players will see this name, but for now it's just captured and can be displayed somewhere sensible (e.g. small always-on nametag-style label is NOT required yet since there's no one else to show it to locally — just make sure the value is captured and stored so Phase 6 can wire it into networking without rework).
2. **Avatar customization — full body-part editor.** Per the established decision, this is not just a color swatch or preset list: give the player separate customization controls for distinct body parts (e.g. head, torso, legs — use your judgment on the exact part breakdown given how the Phase 1 character model is actually constructed) with color and/or shape options per part. Show a live preview of the character as they adjust it. Build this as real, reusable character construction logic — not a fixed set of pre-baked whole-body skins — since Phase 6 will need to reconstruct other players' avatars from whatever choices get made here.
3. **Map selection** — replaces the temporary debug map-loading from Phase 4 with a real menu: show the 2-3 maps built in Phase 4 (name + maybe a thumbnail/preview if reasonably easy) and let the player pick which one to load into.

After confirming nickname + avatar + map, the player spawns into the chosen map wearing their customized character, exactly as before but now reached through this proper flow instead of a debug shortcut.

## In-game menu additions

Also add, accessible from within a running game session (not just at the lobby):
- **Manual map reset** — any player can trigger "reset this map" from an in-game menu at any time, which restores all destructible geometry (ground skin + buildings) back to its pre-damage state and clears/despawns settled debris. No automatic reset on a timer or on player disconnect — purely on-demand, per the earlier decision.
- A way to get back to the lobby / change map without needing to reload the whole page (nice to have, use your judgment on how much menu-plumbing this needs — don't over-engineer a full pause-menu system if a simple escape-key overlay covers it).

## Definition of done for Phase 5

1. Game opens to a lobby screen: nickname field, full body-part avatar editor with live preview, map selection among the Phase 4 maps.
2. Confirming spawns the player into the chosen map with their customized appearance and captured nickname.
3. An in-game option resets the current map's destruction state on demand, usable by the player at any time during play.
4. Character construction/customization data is structured cleanly enough that Phase 6 can serialize a player's nickname + avatar choices over the network without needing to redesign this system.

## Explicitly out of scope for Phase 5
- No actual multiplayer networking, no other players visible, no server — this is still single local player, just now reached through a proper lobby instead of a debug shortcut.
- No new weapons, vehicles, or maps beyond what already exists.
- No persistence of nickname/avatar choices across browser sessions unless it's trivial (e.g. `localStorage`) — not a requirement, just don't actively fight it if it falls out naturally.

Report back on what was built, how to test the lobby/avatar/map-select flow, and flag any deviations from this spec — especially how you structured avatar data, since that directly determines how easy Phase 6 will be. **Stop here — do not proceed to Phase 6.**
