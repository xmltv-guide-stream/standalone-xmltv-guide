// -----------------------------------------------------------------------------
// HTTP server: hosts the config page + JSON API, serves the HLS output, and owns
// the GuidePipeline lifecycle. Single dependency-light entry point.
// -----------------------------------------------------------------------------
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_GUIDE_THEMES } from "./render.js";
import { loadConfig, saveConfig, defaultConfig, type Config } from "./config.js";
import { GuidePipeline } from "./pipeline.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
const DATA = resolve(process.env.DATA_DIR || "./data");
const CONFIG_PATH = process.env.CONFIG || join(DATA, "config.json");
const HLS_DIR = process.env.HLS_DIR || join(DATA, "hls");
const WORK_DIR = process.env.WORK_DIR || join(tmpdir(), "xmltv-guide-work");

const LOG_MAX = 800;
const logBuf: string[] = [];
function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`;
  logBuf.push(line); if (logBuf.length > LOG_MAX) logBuf.splice(0, logBuf.length - LOG_MAX);
  console.error(line);
}

function send(res: ServerResponse, code: number, body: string | Buffer, type = "text/plain"): void {
  res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*", "cache-control": "no-store" });
  res.end(body);
}
function json(res: ServerResponse, code: number, obj: unknown): void { send(res, code, JSON.stringify(obj), "application/json"); }
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const HLS_TYPES: Record<string, string> = { ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".m4s": "video/iso.segment", ".mp4": "video/mp4" };

async function main(): Promise<void> {
  let cfg = await loadConfig(CONFIG_PATH);
  if (!existsSync(CONFIG_PATH)) await saveConfig(CONFIG_PATH, cfg);

  const pipeline = new GuidePipeline(cfg, HLS_DIR, WORK_DIR, log);
  await pipeline.start();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;
    try {
      // --- HLS output (also handle CORS preflight) ---
      if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,PUT,POST,OPTIONS", "access-control-allow-headers": "content-type" }); return res.end(); }
      if (path === "/live.m3u8" || /^\/seg\d+\.ts$/.test(path) || path.endsWith(".m4s")) {
        const file = join(HLS_DIR, path.replace(/^\//, ""));
        if (!existsSync(file)) return send(res, 404, "not ready");
        const ext = path.slice(path.lastIndexOf("."));
        res.writeHead(200, { "content-type": HLS_TYPES[ext] || "application/octet-stream", "access-control-allow-origin": "*", "cache-control": ext === ".ts" ? "public, max-age=30" : "no-store" });
        return createReadStream(file).pipe(res);
      }

      // --- API ---
      if (path === "/api/config" && req.method === "GET") return json(res, 200, cfg);
      if (path === "/api/config" && req.method === "PUT") {
        const patch = JSON.parse(await readBody(req)) as Partial<Config>;
        cfg = { ...cfg, ...patch, video: { ...cfg.video, ...(patch.video ?? {}) }, channels: { ...cfg.channels, ...(patch.channels ?? {}) }, hls: { ...cfg.hls, ...(patch.hls ?? {}) }, themeOverride: patch.themeOverride ?? cfg.themeOverride, sources: patch.sources ?? cfg.sources };
        await saveConfig(CONFIG_PATH, cfg);
        log("[config] saved — restarting pipeline");
        pipeline.apply(cfg).catch((e) => log(`[config] apply error: ${(e as Error).message}`));
        return json(res, 200, cfg);
      }
      if (path === "/api/defaults" && req.method === "GET") return json(res, 200, defaultConfig());
      if (path === "/api/themes" && req.method === "GET") return json(res, 200, Object.entries(DEFAULT_GUIDE_THEMES).map(([id, t]) => ({ id, label: t.label })));
      if (path === "/api/channels" && req.method === "GET") return json(res, 200, pipeline.channelList());
      if (path === "/api/status" && req.method === "GET") return json(res, 200, { status: pipeline.status(), channels: pipeline.channelList().length, hls: existsSync(join(HLS_DIR, "live.m3u8")) });
      if (path === "/api/logs" && req.method === "GET") { const n = Number(url.searchParams.get("n")) || 400; return json(res, 200, { lines: logBuf.slice(-n) }); }
      if (path === "/api/reload" && req.method === "POST") { pipeline.apply(cfg).catch((e) => log(`[reload] ${(e as Error).message}`)); return json(res, 200, { ok: true }); }

      // --- config page (static) ---
      if (path === "/" || path === "/index.html") {
        const html = await readFile(join(PUBLIC, "index.html"), "utf8").catch(() => "<h1>xmltv-guide-hls</h1><p>public/index.html missing</p>");
        return send(res, 200, html, "text/html; charset=utf-8");
      }
      return send(res, 404, "not found");
    } catch (e) {
      log(`[http] ${req.method} ${path} error: ${(e as Error).message}`);
      return json(res, 500, { error: (e as Error).message });
    }
  });

  server.listen(cfg.port, () => {
    log(`[server] listening on http://0.0.0.0:${cfg.port}  — config UI: /   HLS: /live.m3u8`);
  });

  const shutdown = () => { pipeline.stop().finally(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
