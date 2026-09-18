// -----------------------------------------------------------------------------
// The HLS pipeline: parse XMLTV -> render SVG -> PNG -> ffmpeg composite -> HLS.
// -----------------------------------------------------------------------------
// One long-running service. It renders the grid/header/featured PNGs for the
// current time window, then runs ffmpeg to scroll the grid under the fixed header,
// rotate the featured panel, play promo clips + music, burn the live clock, and
// write an HLS playlist + segments. Every `refreshMin` (or when config changes) it
// re-renders the window and restarts ffmpeg, continuing the HLS media sequence so
// players keep following the same /live.m3u8.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdir, writeFile, copyFile, mkdir, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { Config } from "./config.js";
import { resolveTheme } from "./config.js";
import { loadXmltv, type ParsedXmltv } from "./xmltv.js";
import { loadIcon } from "./poster.js";
import {
  selectChannels, buildRows, allProgrammes, pickFeatured, slotFloor,
  renderGridSvg, renderHeaderSvg, renderFeaturedStripSvg, renderTimeBarSvg, renderPromoAreaSvg,
  guideGridHeight, guidePromoHeight, guideTimeBarHeight, guideFeaturedBandHeight, guidePromoBox,
} from "./render.js";

const VIDEO_EXT = /\.(mp4|mkv|mov|m4v|webm|avi|ts|wmv|flv|mpg|mpeg)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i;

// The whole guide is authored against a fixed 1080-tall "design" canvas (font
// sizes, theme heights, paddings are all tuned for it). We compose at that canvas
// — its width matched to the output's aspect ratio so nothing distorts — then
// scale the finished frame to the requested output resolution. Everything, themes
// included, therefore scales uniformly with the output.
const DESIGN_H = 1080;

interface Built {
  W: number; H: number;          // design canvas (compose here)
  outW: number; outH: number;    // requested output resolution (scale to here)
  GH: number; promoH: number; tbH: number; HH: number; bandH: number; scroll: boolean;
  nPicks: number; nPromo: number; rowCount: number; promoFiles: string[]; music: string; hasFont: boolean;
  pbox: { x: number; y: number; w: number; h: number };
}

interface TBuilt {
  W: number; H: number; outW: number; outH: number;
  promoH: number; tbH: number; HH: number; gridVis: number; speed: number;
  ghPrev: number; ghThis: number; phaseStart: number; tDock: number; tDockEnd: number;
  nPicks: number; nPromo: number; rowCount: number; promoFiles: string[]; music: string; hasFont: boolean;
  pbox: { x: number; y: number; w: number; h: number };
}

export class GuidePipeline {
  private cfg: Config;
  private readonly hlsDir: string;
  private readonly workRoot: string;
  private readonly log: (m: string) => void;
  private parsed: ParsedXmltv | null = null;
  private packager: ChildProcess | null = null;   // long-lived: owns the HLS playlist
  private source: ChildProcess | null = null;     // the LIVE compositor feeding the packager
  private pendingSource: ChildProcess | null = null; // next compositor, warming up before cutover
  private refreshTimer: NodeJS.Timeout | null = null;
  private xmltvTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private gen = 0;                 // work-dir generation, so restarts don't clash
  private lastStatus = "starting";
  // live scroll-phase tracking (so a transition can start exactly where the current
  // window's scroll is, and the cutover is seamless):
  private liveGH = 0;             // current window's grid height
  private liveSteadyStartMs = 0;  // wall time when the current window's steady loop hit pos 0
  private currentWindow: number | null = null;  // slot start (ms) of the live window

  constructor(cfg: Config, hlsDir: string, workRoot: string, log: (m: string) => void) {
    this.cfg = cfg; this.hlsDir = hlsDir; this.workRoot = workRoot; this.log = log;
  }

  status(): string { return this.lastStatus; }

  async start(): Promise<void> {
    this.stopped = false;
    await mkdir(this.hlsDir, { recursive: true });
    // fresh playlist for this run
    try { for (const f of readdirSync(this.hlsDir)) if (/^seg\d+\.ts$|\.m3u8$/.test(f)) await rm(join(this.hlsDir, f), { force: true }); } catch { /* ignore */ }
    await this.reloadXmltv();
    this.startPackager();      // owns the HLS output; never restarts on a window switch
    await this.swapSource(false);   // first compositor (steady; nothing to transition from)
    // Re-render the window exactly at each slot boundary (:00/:30) so the leftmost
    // time column and every show advance with the clock — aligned to the wall clock,
    // not to when the process happened to start. `refreshMin`, if smaller than a
    // slot, caps how long between refreshes (e.g. to refresh featured/trailers).
    this.armWindowRefresh();
    // periodic XMLTV refresh (for URL sources / updated files)
    this.xmltvTimer = setInterval(() => { void this.reloadXmltv(); }, Math.max(1, this.cfg.xmltvRefreshMin) * 60_000);
  }

  /** Schedule the next window regeneration at the upcoming slot boundary (or sooner
   *  if refreshMin is shorter), then re-arm. */
  private armWindowRefresh(): void {
    const slotMs = Math.max(1, this.cfg.slotMinutes) * 60_000;
    const off = this.cfg.offsetMin * 60_000;
    const local = Date.now() + off;
    let delay = slotMs - (local % slotMs);           // ms to the next :00/:30 boundary
    const cap = Math.max(1, this.cfg.refreshMin) * 60_000;
    if (cap < delay) delay = cap;                    // honor a shorter refreshMin
    this.refreshTimer = setTimeout(() => {
      if (this.stopped) return;
      void this.swapSource(true);   // animate the time-change at slot boundaries
      this.armWindowRefresh();
    }, delay + 300);                                 // small guard so slotFloor lands in the new slot
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.xmltvTimer) clearInterval(this.xmltvTimer);
    this.killSource();
    if (this.packager) { try { this.packager.stdin?.end(); this.packager.kill("SIGKILL"); } catch { /* ignore */ } this.packager = null; }
  }

  /** Apply a new config: stop, swap, start fresh. */
  async apply(cfg: Config): Promise<void> {
    await this.stop();
    this.cfg = cfg;
    await this.start();
  }

  channelList(): { id: string; number: string; name: string }[] {
    if (!this.parsed) return [];
    return selectChannels(this.parsed, {}).map((c) => ({ id: c.id, number: c.number, name: c.name }));
  }

  private killSource(): void {
    if (this.pendingSource) { try { this.pendingSource.kill("SIGKILL"); } catch { /* ignore */ } this.pendingSource = null; }
    if (this.source) { try { this.source.kill("SIGKILL"); } catch { /* ignore */ } this.source = null; }
  }

  /** Start (or restart, if it died) the long-lived HLS packager. It reads MPEG-TS
   *  on stdin and only ever segments/copies it to HLS, so the playlist and all
   *  client connections survive every compositor swap. Wall-clock timestamps keep
   *  the HLS timeline monotonic across source restarts. */
  private startPackager(): void {
    const bin = process.env.FFMPEG || "ffmpeg";
    const p = spawn(bin, this.buildPackagerArgs(), { cwd: this.workRoot, stdio: ["pipe", "ignore", "pipe"] });
    this.packager = p;
    p.stdin?.on("error", () => { /* source gap / EPIPE — ignore, keep alive */ });
    p.stderr.on("data", (b: Buffer) => { const s = b.toString().trim(); if (s) this.log(`[ffmpeg-hls] ${s.replace(/\s+/g, " ").slice(0, 400)}`); });
    p.on("exit", (code) => {
      if (this.stopped || this.packager !== p) return;
      this.log(`[hls] packager exited (${code}); restarting`);
      setTimeout(() => { if (!this.stopped) { this.startPackager(); void this.swapSource(false); } }, 1000);
    });
  }

  // ---- render + swap the COMPOSITOR (make-before-break; packager stays up) --
  // Spin up the next compositor, wait until it's actually producing output, THEN
  // kill the old one and hand the new one to the packager. The old source feeds
  // the packager right up to the cutover, so there's no gap in the HLS output.
  private readonly CUTOVER_BYTES = 96 * 1024;   // "producing" once this much is buffered
  private readonly CUTOVER_TIMEOUT_MS = 8000;   // don't hang if output is slow to start

  private async swapSource(animate = false): Promise<void> {
    if (this.stopped || !this.parsed) return;
    if (!this.packager) this.startPackager();
    if (this.pendingSource) { try { this.pendingSource.kill("SIGKILL"); } catch { /* ignore */ } this.pendingSource = null; }
    const gen = ++this.gen;
    const work = join(this.workRoot, `g${gen}`);
    try {
      await mkdir(work, { recursive: true });
      const spec = await this.prepareSpec(work, animate);
      if (!spec) return;
      const bin = process.env.FFMPEG || "ffmpeg";
      const spawnMs = Date.now();
      const next = spawn(bin, spec.args, { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
      this.pendingSource = next;
      next.stderr.on("data", (b: Buffer) => { const s = b.toString().trim(); if (s) this.log(`[ffmpeg-src] ${s.replace(/\s+/g, " ").slice(0, 400)}`); });

      // Buffer the new compositor's output until it's clearly producing, then cut
      // over: kill the old source and flush the buffer + live pipe into the packager.
      let cut = false; const buffered: Buffer[] = []; let bytes = 0;
      const cutover = () => {
        if (cut || this.stopped) return;
        cut = true; clearTimeout(guard); next.stdout.off("data", onData);
        const old = this.source;
        this.source = next; this.pendingSource = null;
        if (old) { try { old.stdout?.unpipe(); old.kill("SIGKILL"); } catch { /* ignore */ } }
        if (this.packager?.stdin) {
          for (const c of buffered) { try { this.packager.stdin.write(c); } catch { /* ignore */ } }
          next.stdout.pipe(this.packager.stdin, { end: false });
        }
        buffered.length = 0;
        // record the live window's scroll phase for the NEXT transition
        this.liveGH = spec.gh;
        this.liveSteadyStartMs = spawnMs + spec.steadyStartOffsetMs;
        this.currentWindow = spec.window;
        this.lastStatus = "streaming";
        this.log(`[hls] ${spec.desc} (no gap; packager live)`);
      };
      const onData = (chunk: Buffer) => { if (cut) return; buffered.push(chunk); bytes += chunk.length; if (bytes >= this.CUTOVER_BYTES) cutover(); };
      next.stdout.on("data", onData);
      const guard = setTimeout(cutover, this.CUTOVER_TIMEOUT_MS);

      next.on("exit", (code) => {
        void rm(work, { recursive: true, force: true }).catch(() => {});
        if (!cut) {
          // died during warmup → keep the CURRENT window running, retry shortly
          clearTimeout(guard); next.stdout?.off("data", onData);
          if (this.pendingSource === next) this.pendingSource = null;
          if (!this.stopped) { this.lastStatus = `new source failed (${code}); keeping current`; this.log(`[hls] new compositor exited during warmup (${code}); keeping current window`); setTimeout(() => { void this.swapSource(false); }, 3000); }
          return;
        }
        // died after cutover (it was the live source) → respawn (steady)
        try { next.stdout?.unpipe(); } catch { /* ignore */ }
        if (!this.stopped && this.source === next) { this.lastStatus = `source exited (${code}); restarting`; setTimeout(() => { void this.swapSource(false); }, 1500); }
      });
    } catch (e) {
      this.lastStatus = `swap error: ${(e as Error).message}`;
      this.log(`[hls] swap error: ${(e as Error).message}`);
    }
  }

  /** Build the ffmpeg spec for the next compositor: an animated time-change
   *  transition when the slot rolled over (and we have a live window), else a plain
   *  steady window. Returns args + the metadata needed to track the live scroll
   *  phase. */
  private async prepareSpec(work: string, animate: boolean): Promise<{ args: string[]; gh: number; steadyStartOffsetMs: number; window: number; desc: string } | null> {
    const cfg = this.cfg;
    const slotMs = Math.max(1, cfg.slotMinutes) * 60_000;
    const thisWindow = slotFloor(Date.now(), Math.max(1, cfg.slotMinutes), cfg.offsetMin);
    const canAnimate = animate && cfg.animateTimeChange && this.liveGH > 0 &&
      this.currentWindow != null && this.currentWindow !== thisWindow;
    if (canAnimate) {
      const t = await this.renderTransitionAssets(work, thisWindow);
      if (t) {
        const args = this.buildTransitionArgs(work, t);
        return { args, gh: t.ghThis, steadyStartOffsetMs: Math.round(t.tDockEnd * 1000), window: thisWindow, desc: `time-change transition → new window (${t.rowCount} rows)` };
      }
      // fall through to steady if transition assets couldn't be built
    }
    const built = await this.renderAssets(work);
    if (!built) return null;
    const args = await this.buildFfmpegArgs(work, built);
    return { args, gh: built.GH, steadyStartOffsetMs: 0, window: thisWindow, desc: `new window — ${built.rowCount} rows, ${built.nPromo} promo clip(s)` };
  }

  private async reloadXmltv(): Promise<void> {
    if (!this.cfg.xmltvSource) { this.lastStatus = "no XMLTV source configured"; return; }
    try {
      this.parsed = await loadXmltv(this.cfg.xmltvSource);
      this.log(`[xmltv] loaded ${this.parsed.channels.length} channels, ${[...this.parsed.byChannel.values()].reduce((n, a) => n + a.length, 0)} programmes from ${this.cfg.xmltvSource}`);
    } catch (e) {
      this.log(`[xmltv] load FAILED: ${(e as Error).message}`);
    }
  }

  // ---- render the three PNGs + collect media -------------------------------
  private async renderAssets(work: string): Promise<Built | null> {
    const cfg = this.cfg; const theme = resolveTheme(cfg);
    // Compose on a 1080-tall canvas whose width matches the output aspect ratio, so
    // scaling to the real output resolution is uniform (no distortion, no per-value
    // scaling of themes/fonts). Keep both dimensions even for the encoder.
    const outW = Math.max(2, Math.round(cfg.video.width / 2) * 2);
    const outH = Math.max(2, Math.round(cfg.video.height / 2) * 2);
    const designW = Math.max(2, Math.round((DESIGN_H * outW) / outH / 2) * 2);
    const layout = { width: designW, height: DESIGN_H, columns: Math.max(1, cfg.columns), slotMinutes: Math.max(5, cfg.slotMinutes) };
    const now = Date.now();
    const channels = selectChannels(this.parsed!, { include: cfg.channels.include, max: cfg.channels.max });
    if (!channels.length) { this.lastStatus = "no channels in XMLTV"; this.log("[hls] no channels selected/available"); return null; }
    const { rows, colTimes, windowStart, windowEnd } = buildRows(this.parsed!, channels, now, layout.columns, layout.slotMinutes, cfg.offsetMin);

    // featured picks + poster resolution (live fetch)
    const picks = pickFeatured(allProgrammes(this.parsed!, channels), 6, now, cfg.offsetMin);
    await Promise.all(picks.map(async (p) => { p.iconData = await loadIcon(p.iconPath, cfg.sources); }));
    const posters = picks.filter((p) => p.iconData).length;
    this.log(`[featured] ${picks.length} picks, ${posters} posters resolved`);

    const gridSvg = renderGridSvg(rows, layout, theme, windowStart, windowEnd, cfg.offsetMin);
    const headerSvg = renderHeaderSvg(colTimes, layout, cfg.offsetMin, theme);
    const featSvg = renderFeaturedStripSvg(picks, layout, theme);

    const font = (theme.fontFile || "").trim();
    if (font && !existsSync(font)) this.log(`[font] not found: "${font}" — using a system font`);
    const fontOpt = font && existsSync(font) ? { loadSystemFonts: false, fontFiles: [font] } : { loadSystemFonts: true };
    const png = (svg: string) => Buffer.from(new Resvg(svg, { font: fontOpt }).render().asPng());
    await writeFile(join(work, "grid.png"), png(gridSvg));
    await writeFile(join(work, "header.png"), png(headerSvg));
    await writeFile(join(work, "feat.png"), png(featSvg));
    let hasFont = false;
    if (font && existsSync(font)) { try { await copyFile(font, join(work, "font.ttf")); hasFont = true; } catch { /* system font */ } }

    // promo clips (recursive, keep those with an audio track), music (recursive random)
    const probe = process.env.FFPROBE || "ffprobe";
    let promoFiles: string[] = [];
    if (cfg.promoFolder && existsSync(cfg.promoFolder)) {
      try {
        const all = (await readdir(cfg.promoFolder, { recursive: true })).filter((f) => VIDEO_EXT.test(String(f))).map((f) => join(cfg.promoFolder, String(f)));
        for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
        for (const full of all.slice(0, 40)) {
          if (promoFiles.length >= 24) break;
          try { const r = spawnSync(probe, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", full], { encoding: "utf8" }); if ((r.stdout || "").trim()) promoFiles.push(full); } catch { /* skip */ }
        }
        if (promoFiles.length && promoFiles.length < 6) { const base = [...promoFiles]; let i = 0; while (promoFiles.length < 6) promoFiles.push(base[i++ % base.length]); }
      } catch { promoFiles = []; }
    }
    let music = "";
    if (cfg.musicFolder && existsSync(cfg.musicFolder)) {
      try { const files = (await readdir(cfg.musicFolder, { recursive: true })).filter((f) => AUDIO_EXT.test(String(f))); if (files.length) music = join(cfg.musicFolder, String(files[Math.floor(Math.random() * files.length)])); } catch { /* none */ }
    }
    this.log(`[hls] promo ${promoFiles.length} clip(s)${music ? `, music ${music.split(/[\\/]/).pop()}` : ""}`);

    const GH = guideGridHeight(rows, theme, windowStart);
    const promoH = guidePromoHeight(theme, layout.height);
    const tbH = guideTimeBarHeight(theme);
    const gridVis = layout.height - (promoH + tbH);
    // Scroll cheaply: pre-stack the grid vertically ONCE here so the live ffmpeg
    // just loops the decoded image and `crop`s the visible window each frame (cost
    // is flat in channel count). Only needed when the grid is taller than the
    // visible area. Doing the vstack per-frame, or re-decoding via -loop 1, is what
    // made CPU scale with channel count.
    const scroll = GH > gridVis;
    if (scroll) {
      const bin = process.env.FFMPEG || "ffmpeg";
      const r = spawnSync(bin, ["-hide_banner", "-loglevel", "error", "-y", "-i", "grid.png", "-i", "grid.png", "-filter_complex", "vstack=inputs=2", "-frames:v", "1", "grid2.png"], { cwd: work });
      if (r.status !== 0) this.log(`[hls] grid pre-stack failed (${r.status}); scrolling may be heavier`);
    }
    return {
      W: layout.width, H: layout.height, outW, outH, GH, promoH, tbH, HH: promoH + tbH, scroll,
      bandH: guideFeaturedBandHeight(theme, layout.height), nPicks: Math.max(1, picks.length),
      nPromo: promoFiles.length, rowCount: rows.length, promoFiles, music, hasFont,
      pbox: guidePromoBox(layout, theme),
    };
  }

  // ---- assemble the ffmpeg command (HLS output) ----------------------------
  private async buildFfmpegArgs(_work: string, b: Built): Promise<string[]> {
    const cfg = this.cfg; const theme = resolveTheme(cfg);
    const FPS = String(cfg.video.fps || 24);
    const SPEED = Math.max(1, cfg.scrollSpeed || 60);
    const rotateSec = Math.max(5, cfg.promoRotateSec || 30);
    const hex = (c: string) => (c || "#FFFFFF").replace(/^#/, "0x");

    const period = b.nPicks * rotateSec;
    const featY = `-${b.bandH}*floor(mod(t\\, ${period})/${rotateSec})`;
    // Scroll cheaply: decode each PNG ONCE (loop filter), then extract the visible
    // window from a vertically-doubled grid with a single `crop` — cost is O(frame)
    // not O(grid height), so CPU stays flat no matter how many channels there are.
    // (The old split+two-overlay-of-a-tall-image approach re-touched the whole grid
    //  every frame and scaled linearly with channel count.)
    const gridVis = b.H - b.HH;
    // input 1 is grid2.png (pre-doubled) when scrolling, else grid.png (static)
    const chains: string[] = [
      `[1:v]loop=loop=-1:size=1:start=0,fps=${FPS}[g]`,
      `[2:v]loop=loop=-1:size=1:start=0,fps=${FPS}[hdr]`,
      `[3:v]loop=loop=-1:size=1:start=0,fps=${FPS}[ft]`,
    ];
    if (b.scroll) chains.push(`[g]crop=${b.W}:${gridVis}:0:'mod(t*${SPEED}\\, ${b.GH})'[gw]`);
    else chains.push(`[g]null[gw]`); // grid shorter than the window — show it static
    chains.push(`[0:v][gw]overlay=x=0:y=${b.HH}[o1]`);
    chains.push(`[o1][hdr]overlay=x=0:y=0[o2]`);
    chains.push(`[o2][ft]overlay=x=0:y='${featY}'[o3]`);
    let last = "o3";
    if (b.nPromo > 0) {
      const segs: string[] = [];
      for (let i = 0; i < b.nPromo; i++) {
        const idx = 5 + i;
        chains.push(`[${idx}:v]scale=${b.pbox.w}:${b.pbox.h}:force_original_aspect_ratio=increase,crop=${b.pbox.w}:${b.pbox.h},setsar=1,fps=30,format=yuv420p[pv${i}]`);
        chains.push(`[${idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[pa${i}]`);
        segs.push(`[pv${i}][pa${i}]`);
      }
      chains.push(`${segs.join("")}concat=n=${b.nPromo}:v=1:a=1[promovideo][promoaudio]`);
      chains.push(`[${last}][promovideo]overlay=x=${b.pbox.x}:y=${b.pbox.y}[o5]`);
      last = "o5";
    }
    const clockFont = b.hasFont ? "fontfile=font.ttf:" : "";
    const clockFS = Math.round(b.tbH * 0.5);
    const clockY = `${b.promoH}+(${b.tbH}-th)/2`;
    const t12 = `%{localtime\\:%I}\\:%{localtime\\:%M}\\:%{localtime\\:%S} %{localtime\\:%p}`;
    chains.push(`[${last}]drawtext=${clockFont}text='${t12}':fontcolor=${hex(theme.clockColor)}:fontsize=${clockFS}:x=24:y=${clockY}[vd]`);
    // scale the finished design-canvas frame to the requested output resolution
    if (b.W === b.outW && b.H === b.outH) chains.push(`[vd]null[v]`);
    else chains.push(`[vd]scale=${b.outW}:${b.outH}:flags=lanczos,setsar=1[v]`);

    let audioMap = "4:a";
    if (b.nPromo > 0) {
      chains.push(`[4:a]volume=${b.music ? 0.4 : 0},aresample=48000[bed]`);
      chains.push(`[promoaudio]volume=1.6[pa]`);
      chains.push(`[bed][pa]amix=inputs=2:duration=longest:dropout_transition=0[aout]`);
      audioMap = "[aout]";
    }

    const promoInputs: string[] = [];
    for (const f of b.promoFiles) promoInputs.push("-i", f);

    const seg = Math.max(2, cfg.hls.segmentSec || 4);
    // The compositor encodes to MPEG-TS on stdout; the long-lived packager segments
    // it to HLS. Keyframes are aligned to the segment length so the packager can cut
    // clean segments without re-encoding.
    return [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-re", "-f", "lavfi", "-i", `color=c=${(theme.bg || "#000000").replace(/^#/, "0x")}:s=${b.W}x${b.H}:r=${FPS}`,
      // single-frame reads; the loop filter repeats the decoded frame (decode once).
      // grid2.png is the pre-doubled grid used for seamless crop-scrolling.
      "-i", b.scroll ? "grid2.png" : "grid.png",
      "-i", "header.png",
      "-i", "feat.png",
      ...(b.music ? ["-stream_loop", "-1", "-i", b.music] : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]),
      ...promoInputs,
      "-filter_complex", chains.join(";"),
      "-map", "[v]", "-map", audioMap,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-g", String(Math.round(Number(FPS) * seg)), "-force_key_frames", `expr:gte(t,n_forced*${seg})`,
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-f", "mpegts", "pipe:1",
    ];
  }

  /** Promo/trailer clips (recursive, audio-only kept) + a random music track. */
  private async gatherMedia(): Promise<{ promoFiles: string[]; music: string }> {
    const cfg = this.cfg; const probe = process.env.FFPROBE || "ffprobe";
    let promoFiles: string[] = [];
    if (cfg.promoFolder && existsSync(cfg.promoFolder)) {
      try {
        const all = (await readdir(cfg.promoFolder, { recursive: true })).filter((f) => VIDEO_EXT.test(String(f))).map((f) => join(cfg.promoFolder, String(f)));
        for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
        for (const full of all.slice(0, 40)) {
          if (promoFiles.length >= 24) break;
          try { const r = spawnSync(probe, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", full], { encoding: "utf8" }); if ((r.stdout || "").trim()) promoFiles.push(full); } catch { /* skip */ }
        }
        if (promoFiles.length && promoFiles.length < 6) { const base = [...promoFiles]; let i = 0; while (promoFiles.length < 6) promoFiles.push(base[i++ % base.length]); }
      } catch { promoFiles = []; }
    }
    let music = "";
    if (cfg.musicFolder && existsSync(cfg.musicFolder)) {
      try { const files = (await readdir(cfg.musicFolder, { recursive: true })).filter((f) => AUDIO_EXT.test(String(f))); if (files.length) music = join(cfg.musicFolder, String(files[Math.floor(Math.random() * files.length)])); } catch { /* none */ }
    }
    return { promoFiles, music };
  }

  // ---- classic time-change transition: render the assets --------------------
  private async renderTransitionAssets(work: string, thisWindow: number): Promise<TBuilt | null> {
    const cfg = this.cfg; const theme = resolveTheme(cfg);
    const outW = Math.max(2, Math.round(cfg.video.width / 2) * 2);
    const outH = Math.max(2, Math.round(cfg.video.height / 2) * 2);
    const designW = Math.max(2, Math.round((DESIGN_H * outW) / outH / 2) * 2);
    const layout = { width: designW, height: DESIGN_H, columns: Math.max(1, cfg.columns), slotMinutes: Math.max(5, cfg.slotMinutes) };
    const slotMs = layout.slotMinutes * 60_000;
    const prevWindow = thisWindow - slotMs;
    const channels = selectChannels(this.parsed!, { include: cfg.channels.include, max: cfg.channels.max });
    if (!channels.length) return null;
    const prev = buildRows(this.parsed!, channels, prevWindow, layout.columns, layout.slotMinutes, cfg.offsetMin);
    const cur = buildRows(this.parsed!, channels, thisWindow, layout.columns, layout.slotMinutes, cfg.offsetMin);
    const ghPrev = guideGridHeight(prev.rows, theme, prev.windowStart);
    const ghThis = guideGridHeight(cur.rows, theme, cur.windowStart);
    const promoH = guidePromoHeight(theme, layout.height);
    const tbH = guideTimeBarHeight(theme);
    const HH = promoH + tbH; const gridVis = layout.height - HH;
    const speed = Math.max(1, cfg.scrollSpeed || 60);

    const picks = pickFeatured(allProgrammes(this.parsed!, channels), 6, thisWindow, cfg.offsetMin);
    await Promise.all(picks.map(async (p) => { p.iconData = await loadIcon(p.iconPath, cfg.sources); }));

    const font = (theme.fontFile || "").trim();
    const fontOpt = font && existsSync(font) ? { loadSystemFonts: false, fontFiles: [font] } : { loadSystemFonts: true };
    const png = (svg: string) => Buffer.from(new Resvg(svg, { font: fontOpt }).render().asPng());
    await writeFile(join(work, "gridPrev.png"), png(renderGridSvg(prev.rows, layout, theme, prev.windowStart, prev.windowEnd, cfg.offsetMin)));
    await writeFile(join(work, "gridThis.png"), png(renderGridSvg(cur.rows, layout, theme, cur.windowStart, cur.windowEnd, cfg.offsetMin)));
    await writeFile(join(work, "tbarPrev.png"), png(renderTimeBarSvg(prev.colTimes, layout, cfg.offsetMin, theme)));
    await writeFile(join(work, "tbarThis.png"), png(renderTimeBarSvg(cur.colTimes, layout, cfg.offsetMin, theme)));
    await writeFile(join(work, "promoarea.png"), png(renderPromoAreaSvg(layout, theme)));
    await writeFile(join(work, "feat.png"), png(renderFeaturedStripSvg(picks, layout, theme)));
    let hasFont = false;
    if (font && existsSync(font)) { try { await copyFile(font, join(work, "font.ttf")); hasFont = true; } catch { /* system font */ } }

    // scroll strip = [prev grid][this time bar][this grid][this grid]
    // (this grid doubled so the post-transition steady loop wraps seamlessly)
    const bin = process.env.FFMPEG || "ffmpeg";
    const vs = spawnSync(bin, ["-hide_banner", "-loglevel", "error", "-y", "-i", "gridPrev.png", "-i", "tbarThis.png", "-i", "gridThis.png", "-i", "gridThis.png", "-filter_complex", "vstack=inputs=4", "-frames:v", "1", "strip.png"], { cwd: work });
    if (vs.status !== 0) { this.log(`[hls] transition strip build failed (${vs.status})`); return null; }

    // begin the transition exactly where the current window's scroll is now
    const elapsed = Math.max(0, Date.now() - this.liveSteadyStartMs) / 1000;
    const phaseStart = ghPrev > 0 ? (((elapsed * speed) % ghPrev) + ghPrev) % ghPrev : 0;
    const tDock = (ghPrev - phaseStart) / speed;
    const tDockEnd = tDock + tbH / speed;

    const { promoFiles, music } = await this.gatherMedia();
    return {
      W: layout.width, H: layout.height, outW, outH, promoH, tbH, HH, gridVis, speed,
      ghPrev, ghThis, phaseStart, tDock, tDockEnd, nPicks: Math.max(1, picks.length),
      nPromo: promoFiles.length, rowCount: cur.rows.length, promoFiles, music, hasFont, pbox: guidePromoBox(layout, theme),
    };
  }

  // ---- classic time-change transition: build the ffmpeg command -------------
  private buildTransitionArgs(_work: string, t: TBuilt): string[] {
    const cfg = this.cfg; const theme = resolveTheme(cfg);
    const FPS = String(cfg.video.fps || 24); const S = t.speed;
    const rotateSec = Math.max(5, cfg.promoRotateSec || 30);
    const hex = (c: string) => (c || "#FFFFFF").replace(/^#/, "0x");
    // grid crop: finish scrolling prev grid + this time bar rising, then loop this grid
    const cropY = `if(lt(t,${t.tDockEnd}), ${t.phaseStart} + t*${S}, ${t.ghPrev + t.tbH} + mod((t-${t.tDockEnd})*${S}\\, ${t.ghThis}))`;
    // prev time bar: pinned, then slides up and off (masked by the promo backdrop)
    const prevBarY = `if(lt(t,${t.tDock}), ${t.promoH}, if(lt(t,${t.tDockEnd}), ${t.promoH}-(t-${t.tDock})*${S}, ${t.promoH - t.tbH}))`;
    // this time bar: hidden, then rises from the grid top and docks
    const thisBarY = `if(lt(t,${t.tDock}), ${t.H}, if(lt(t,${t.tDockEnd}), ${t.HH}-(t-${t.tDock})*${S}, ${t.promoH}))`;
    const featY = `-${t.H}*floor(mod(t\\, ${t.nPicks * rotateSec})/${rotateSec})`;
    const chains: string[] = [
      `[1:v]loop=loop=-1:size=1:start=0,fps=${FPS}[strip]`,
      `[2:v]loop=loop=-1:size=1:start=0,fps=${FPS}[tp]`,
      `[3:v]loop=loop=-1:size=1:start=0,fps=${FPS}[tt]`,
      `[4:v]loop=loop=-1:size=1:start=0,fps=${FPS}[parea]`,
      `[5:v]loop=loop=-1:size=1:start=0,fps=${FPS}[ftr]`,
      `[strip]crop=${t.W}:${t.gridVis}:0:'${cropY}'[gw]`,
      `[0:v][gw]overlay=x=0:y=${t.HH}[o1]`,
      `[o1][tp]overlay=x=0:y='${prevBarY}'[o2]`,
      `[o2][tt]overlay=x=0:y='${thisBarY}'[o3]`,
      `[o3][parea]overlay=x=0:y=0[o4]`,        // promo/featured backdrop masks the outgoing bar
      `[o4][ftr]overlay=x=0:y='${featY}'[o5]`,
    ];
    let last = "o5";
    if (t.nPromo > 0) {
      const segs: string[] = [];
      for (let i = 0; i < t.nPromo; i++) {
        const idx = 7 + i;
        chains.push(`[${idx}:v]scale=${t.pbox.w}:${t.pbox.h}:force_original_aspect_ratio=increase,crop=${t.pbox.w}:${t.pbox.h},setsar=1,fps=30,format=yuv420p[pv${i}]`);
        chains.push(`[${idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[pas${i}]`);
        segs.push(`[pv${i}][pas${i}]`);
      }
      chains.push(`${segs.join("")}concat=n=${t.nPromo}:v=1:a=1[pvid][paud]`);
      chains.push(`[${last}][pvid]overlay=x=${t.pbox.x}:y=${t.pbox.y}[o6]`);
      last = "o6";
    }
    const clockFont = t.hasFont ? "fontfile=font.ttf:" : "";
    const clockFS = Math.round(t.tbH * 0.5);
    const clockY = `${t.promoH}+(${t.tbH}-th)/2`;
    const t12 = `%{localtime\\:%I}\\:%{localtime\\:%M}\\:%{localtime\\:%S} %{localtime\\:%p}`;
    chains.push(`[${last}]drawtext=${clockFont}text='${t12}':fontcolor=${hex(theme.clockColor)}:fontsize=${clockFS}:x=24:y=${clockY}[vd]`);
    if (t.W === t.outW && t.H === t.outH) chains.push(`[vd]null[v]`);
    else chains.push(`[vd]scale=${t.outW}:${t.outH}:flags=lanczos,setsar=1[v]`);
    let audioMap = "6:a";
    if (t.nPromo > 0) {
      chains.push(`[6:a]volume=${t.music ? 0.4 : 0},aresample=48000[bed]`);
      chains.push(`[paud]volume=1.6[pab]`);
      chains.push(`[bed][pab]amix=inputs=2:duration=longest:dropout_transition=0[aout]`);
      audioMap = "[aout]";
    }
    const promoInputs: string[] = [];
    for (const f of t.promoFiles) promoInputs.push("-i", f);
    const seg = Math.max(2, cfg.hls.segmentSec || 4);
    return [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-re", "-f", "lavfi", "-i", `color=c=${(theme.bg || "#000000").replace(/^#/, "0x")}:s=${t.W}x${t.H}:r=${FPS}`,
      "-i", "strip.png",
      "-i", "tbarPrev.png",
      "-i", "tbarThis.png",
      "-i", "promoarea.png",
      "-i", "feat.png",
      ...(t.music ? ["-stream_loop", "-1", "-i", t.music] : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]),
      ...promoInputs,
      "-filter_complex", chains.join(";"),
      "-map", "[v]", "-map", audioMap,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-g", String(Math.round(Number(FPS) * seg)), "-force_key_frames", `expr:gte(t,n_forced*${seg})`,
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-f", "mpegts", "pipe:1",
    ];
  }

  // ---- the long-lived HLS packager (reads MPEG-TS on stdin) -----------------
  private buildPackagerArgs(): string[] {
    const seg = Math.max(2, this.cfg.hls.segmentSec || 4);
    const list = Math.max(3, this.cfg.hls.listSize || 10);
    const m3u8 = join(this.hlsDir, "live.m3u8");
    const segPat = join(this.hlsDir, "seg%d.ts");
    return [
      "-hide_banner", "-loglevel", "error",
      // re-stamp incoming packets by arrival time so the HLS timeline stays
      // monotonic across compositor swaps (the source's PTS resets each restart)
      "-use_wallclock_as_timestamps", "1",
      "-fflags", "+genpts+igndts",
      "-f", "mpegts", "-i", "pipe:0",
      "-c", "copy",
      "-f", "hls", "-hls_time", String(seg), "-hls_list_size", String(list),
      // append_list keeps ONE continuous playlist; a discontinuity is marked at each
      // source swap so players resync cleanly instead of treating it as the end.
      "-hls_flags", "append_list+delete_segments+omit_endlist+independent_segments+discont_start",
      "-hls_segment_type", "mpegts", "-hls_segment_filename", segPat,
      m3u8,
    ];
  }
}
