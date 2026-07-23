# Voxel Demolition — Phase 6 build prompt (for Claude Fable 5)

This is the final phase of the current **Voxel Demolition** roadmap. **Phases 1-5 are already built and approved**: the full single-player game — destructible ground/buildings, a first-person character, a weapon roster, a vehicle roster, 2-3 maps, and a lobby with nickname entry, full avatar customization, map selection, and manual map reset. Build directly on top of that existing codebase.

Your job now is **Phase 6: turning this into a working 1-4 player co-op game**, hosted from a dedicated Windows machine over LAN.

## Hosting model (already decided, don't relitigate)

- The game is hosted by a **dedicated headless Node.js server** running on a Windows 10 laptop (Ryzen 5 3550H / GTX 1650). This machine **does not render or play** — it only runs the server process.
- Other players join by opening a browser and typing the **host's local LAN IP address and port** (e.g. `192.168.1.42:3000`) — not `localhost`, since that always resolves to the joining player's own machine. On startup, the server must print its own LAN IP and the port clearly to the console so the host can read it off and share it with friends.
- Up to **4 players** per session.
- **The server is the authoritative source of truth for destruction physics.** All connected clients must see identical debris/chunk state — not each client approximating physics locally. Simulate destruction server-side and broadcast the resulting state (chunk detachment events, resulting body transforms) to clients, rather than trusting each client's own physics sim as truth.

## What needs to become networked

Take the existing single-player systems from Phases 1-5 and make them multiplayer-aware:
1. **Connection/session:** a player connects via WebSocket (`ws` package), sends their lobby choices (nickname + avatar from Phase 5), and joins the shared session on whichever map is currently active. Support up to 4 concurrent connections; handle a player disconnecting/reconnecting gracefully (existing players' game session should keep running, not crash or freeze, if someone drops).
2. **Player state sync:** each client sees every other connected player's character (position, orientation, animation state, held weapon/tool, customized appearance) updating in real time, not just their own. Use reasonable interpolation/smoothing on remote players' movement so it doesn't look jittery over LAN latency.
3. **Vehicle state sync:** the vehicle roster from Phase 3 — whoever is driving a given vehicle controls it locally with client-side prediction for responsiveness, but the server remains authoritative on its actual position/state so all clients converge on the same reality (standard client-prediction + server-reconciliation pattern for the driver; other clients just see the reconciled/broadcast state).
4. **Destruction sync:** this is the one that matters most given the server-authoritative rule above. When any player triggers destruction (weapon hit, vehicle collision), that event and its physics resolution should be simulated authoritatively on the server, with the resulting chunk/debris state broadcast to all clients so everyone sees the same buildings breaking apart the same way, not 4 divergent local simulations.
5. **Manual map reset (from Phase 5):** any connected player triggering reset should reset the map for the whole session — all connected clients, not just the player who triggered it.
6. **Map/lobby flow:** since multiple players are now sharing one live session, decide sensibly how map selection works with more than one person present (e.g. whoever connects first / hosts effectively picks, or a simple "vote/first-to-choose" — your call, keep it simple, note your choice back in your report since this wasn't explicitly specified).

## Windows launcher

Prepare a double-clickable **`.bat` file** for the Windows host machine that starts the server (`node server.js` or equivalent) and clearly prints the LAN IP:port to share. This is what the developer will actually double-click on the HP laptop to start hosting — it needs to just work with a double-click, no manual terminal commands required from that point on.

## Deploy / repo setup

- Initialize (or confirm/clean up) a **git repository** for the whole project, all phases included, ready to push to a **public GitHub repo** at `github.com/JerzySukiennik/voxel-demolition`.
- The intended host workflow: one-time `git clone` on the Windows laptop (after installing Node.js and Git there, one-time setup outside your control), then `git pull` for future updates, then double-click the `.bat` launcher.
- Add/update a README covering: what the project is, how to run it locally for development, and how the Windows host machine runs it in practice (clone → `.bat` → share the printed IP:port with friends → they open it in a browser).
- Do not actually push to GitHub or create the remote repo yourself — prepare everything locally (git init, commits, README) and let the developer handle the actual GitHub repo creation and push, since that's a developer-owned action.

## Definition of done for Phase 6

1. The server runs headless (no rendering) and prints its LAN IP:port on startup.
2. 4 separate browser clients (e.g. 4 browser tabs/windows pointed at the server's address, for local testing purposes) can connect simultaneously, each see each other's customized characters and vehicles moving in real time, and all see identical, server-authoritative destruction as any of them breaks things.
3. A player disconnecting doesn't break the session for the others.
4. Manual map reset (from Phase 5) resets the session for everyone connected, not just the triggering client.
5. A working `.bat` launcher exists for Windows.
6. The repo is in a clean, pushable state with a README explaining the host workflow, without you having actually pushed it anywhere.

## Explicitly out of scope for Phase 6
- No new weapons, vehicles, or maps beyond what Phases 2-4 already built.
- No voice/text chat.
- No matchmaking, internet-wide join codes, or anything beyond direct LAN IP entry — that's explicitly the chosen scope (see the earlier decision against port-forwarding/tunneling).
- No authentication/accounts — this is a private LAN game among friends, not a public service.

This closes out the currently-scoped roadmap. Report back on what was built, exactly how to test 4-player LAN play locally (since the developer can't easily test true multi-machine LAN play from within this build session), and flag any deviations — especially around the destruction-sync approach, since that's the highest-risk part of this phase.
