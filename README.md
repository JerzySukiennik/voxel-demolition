# Voxel Demolition

A Teardown-inspired, first-person voxel destruction sandbox that runs in the browser — now with
**1–4 player LAN co-op**. Smash buildings apart chunk-by-chunk with a weapon roster (sledgehammer,
C4, shotgun, rocket launcher), drive a full vehicle roster (cars, trucks, an excavator, a crane,
boats, a hover car, a helicopter, an airplane), across several maps. Destruction physics is
**server-authoritative**, so in co-op everyone sees the exact same buildings break the same way.

Built with three.js + Rapier (WASM), no build step — the browser loads ES modules from a CDN
importmap. The multiplayer host runs a headless Node.js server that simulates one authoritative
world and streams state to every connected browser.

## Controls

| Action | Key |
|---|---|
| Move | WASD / Arrows |
| Sprint | Shift |
| Jump | Space |
| Look | Mouse (click to lock) |
| Enter / exit vehicle | E (near a vehicle) |
| Vehicle menu (spawn) | Tab |
| Select weapon | 1 melee · 2 C4 · 3 shotgun · 4 rocket |
| Fire / place | Left mouse |
| Detonate C4 | Right mouse |
| Vehicle throttle / brake | W / S |
| Vehicle steer | A / D |
| Aircraft/hover up / down | Space / Shift |
| Aircraft rudder | Q / E |
| Pause menu (Reset map / Back to lobby) | Esc |

In co-op, **Reset map** resets destruction for the whole session.

## Run it locally (development)

```
npm install
npm start
```

`npm start` launches the host server and prints its LAN address. Open **http://localhost:3000** in a
browser to play. Open several browser **windows** (not background tabs — those get throttled) at the
same address to test multiple players locally.

For single-player only (no server), you can also serve the folder statically:

```
npm run serve       # http://localhost:8080  (or any static server / python -m http.server)
```

When the page can't reach a WebSocket host within 2 seconds it drops to offline single-player
automatically. Append `?solo=1` to skip the connection attempt entirely, or `?quick=1` to skip the
lobby, or `?map=town|yard|canyon|plaza` to preselect a map.

## Host a LAN game (the Windows machine)

One-time setup on the host laptop: install **Node.js LTS** and **Git**, then:

```
git clone https://github.com/JerzySukiennik/voxel-demolition
```

Then every time you want to host:

1. Double-click **`start.bat`** in the project folder (it runs `npm install` on first launch, then
   starts the server).
2. Read the line it prints: `PLAYERS JOIN AT: http://192.168.x.x:3000`.
3. Friends on the **same LAN** open that address in their browser — **not** `localhost` (localhost
   always resolves to their own machine, not the host).
4. The first player to join picks the map; everyone who joins after that lands on the live map. Up
   to **4 players** per session. If a player drops, the session keeps running for everyone else.

The host machine only runs the server — it does not render or play. On the first run, **Windows
Firewall** may ask for permission: click **Allow** for **private networks** so friends can reach it.

To update to a newer version later: `git pull`, then double-click `start.bat` again.

## Scope

LAN-only by design — no internet matchmaking, join codes, port forwarding, accounts, or chat. It's a
private co-op game for friends on the same network.
