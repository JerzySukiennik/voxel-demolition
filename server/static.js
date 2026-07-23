// static.js - dependency-free static file server for the repo root (no express). Traversal-safe.
import { createReadStream, promises as fsp } from "node:fs";
import { join, normalize, extname, sep } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

// Serve files under `root`. Returns true if it handled the request, false if the caller should
// (e.g. a WS upgrade path). Blocks path traversal outside root and never serves node_modules/.git.
export function makeStaticHandler(root) {
  const rootNorm = normalize(root);
  return async function handle(req, res) {
    try {
      let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      if (urlPath === "/") urlPath = "/index.html";
      // Resolve against root and confirm the result stays inside root (traversal guard).
      const full = normalize(join(rootNorm, urlPath));
      if (full !== rootNorm && !full.startsWith(rootNorm + sep)) {
        res.writeHead(403); res.end("Forbidden"); return true;
      }
      const rel = full.slice(rootNorm.length);
      if (rel.includes("node_modules") || rel.includes(".git" + sep) || rel.endsWith(".git")) {
        res.writeHead(404); res.end("Not found"); return true;
      }
      let stat;
      try { stat = await fsp.stat(full); } catch { res.writeHead(404); res.end("Not found"); return true; }
      let target = full;
      if (stat.isDirectory()) {
        target = join(full, "index.html");
        try { await fsp.stat(target); } catch { res.writeHead(404); res.end("Not found"); return true; }
      }
      const type = MIME[extname(target).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
      createReadStream(target).pipe(res);
      return true;
    } catch (e) {
      res.writeHead(500); res.end("Server error");
      return true;
    }
  };
}
