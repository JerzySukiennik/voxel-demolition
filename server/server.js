// server.js - Voxel Demolition LAN host: HTTP static + WebSocket on ONE port, 60 Hz authoritative sim
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import RAPIER from "@dimforge/rapier3d-compat";
import { CONFIG } from "../src/config.js";
import { RATES, INTERVALS } from "../src/net/protocol.js";
import { makeStaticHandler } from "./static.js";
import { Session } from "./session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.normalize(path.join(__dirname, "..")); // repo root — clients get index.html/src/assets
const PORT = parseInt(process.env.PORT || "3000", 10);
const DT = CONFIG.fixedDt;

// Pick the most likely LAN IPv4 (prefer 192.168.*, then 10.*, then 172.16-31.*), list all candidates.
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== "IPv4" && ni.family !== 4) continue;
      if (ni.internal) continue;
      out.push({ name, addr: ni.address });
    }
  }
  const rank = (a) => (a.startsWith("192.168.") ? 0 : a.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
  out.sort((a, b) => rank(a.addr) - rank(b.addr));
  return out;
}

async function main() {
  await RAPIER.init();
  const session = new Session(RAPIER, console);

  const staticHandler = makeStaticHandler(ROOT);
  const httpServer = http.createServer((req, res) => { staticHandler(req, res); });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    const conn = {
      pid: null,
      send(obj) { if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch (e) {} } },
      // Needed by Session._completeJoin: a cold map build finishes a tick or more after the hello, and
      // the client may have given up and closed in the meantime.
      get open() { return ws.readyState === ws.OPEN; },
      close() { try { ws.close(); } catch (e) {} },
    };
    ws._conn = conn;
    ws._alive = true;
    ws._missed = 0;
    ws.on("pong", () => { ws._alive = true; ws._missed = 0; });
    // Push current session/lobby state so the client's lobby can show "session in progress".
    conn.send(session.describe());
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      try { session.handle(conn, msg); } catch (e) { console.error("[server] handler error:", e); }
    });
    ws.on("close", () => { try { session.handleClose(conn); } catch (e) { console.error("[server] close error:", e); } });
    ws.on("error", () => {});
  });

  // ws keepalive: ping every 10 s, terminate after 2 missed pongs (brief §5).
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws._alive) {
        ws._missed = (ws._missed || 0) + 1;
        if (ws._missed >= RATES.missedPingsBeforeTerminate) { ws.terminate(); continue; }
      }
      ws._alive = false;
      try { ws.ping(); } catch (e) {}
    }
  }, RATES.pingMs);

  // 60 Hz fixed-dt sim loop with a real-time accumulator (cap substeps to avoid a spiral of death).
  let last = Date.now();
  let acc = 0;
  const simTimer = setInterval(() => {
    const now = Date.now();
    let elapsed = (now - last) / 1000;
    last = now;
    if (elapsed > 0.25) elapsed = 0.25;
    acc += elapsed;
    let n = 0;
    while (acc >= DT && n < 8) { session.step(DT); acc -= DT; n++; }
    if (acc > DT) acc = 0;
  }, 1000 / 120);

  // Broadcast timers (frozen rates): pstate+vstate 20 Hz, debris 10 Hz.
  const pstateTimer = setInterval(() => session.broadcastPState(), INTERVALS.pstate);
  const vstateTimer = setInterval(() => session.broadcastVState(), INTERVALS.vstate);
  const debrisTimer = setInterval(() => session.broadcastDebris(), INTERVALS.debris);

  httpServer.listen(PORT, "0.0.0.0", () => {
    const cands = lanAddresses();
    const ip = cands.length ? cands[0].addr : "127.0.0.1";
    console.log("");
    console.log("==================================================================");
    console.log("  VOXEL DEMOLITION — LAN host running");
    console.log("==================================================================");
    console.log(`  HTTP + WebSocket on port ${PORT}`);
    if (cands.length) {
      console.log("  LAN address candidates:");
      for (const c of cands) console.log(`     - http://${c.addr}:${PORT}   (${c.name})`);
    } else {
      console.log("  No external LAN IPv4 found — only localhost is available.");
    }
    console.log("");
    console.log("  >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>");
    console.log(`  >>  PLAYERS JOIN AT:  http://${ip}:${PORT}`);
    console.log("  >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>");
    console.log("");
    console.log("  (Friends open that address in a browser — NOT localhost.)");
    console.log("  The host machine runs this server only; it does not render.");
    console.log("  First player to join picks the map; others join it live. Max 4.");
    console.log("==================================================================");
  });

  const shutdown = () => {
    clearInterval(pingTimer); clearInterval(simTimer);
    clearInterval(pstateTimer); clearInterval(vstateTimer); clearInterval(debrisTimer);
    try { wss.close(); } catch (e) {}
    try { httpServer.close(); } catch (e) {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error("[server] fatal:", e); process.exit(1); });
