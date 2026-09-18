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
  selectChannels, buildRows, allProgrammes, pickFeatured,
  renderGridSvg, renderHeaderSvg, renderFeaturedStripSvg,
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

export class GuidePipeline {
  private cfg: Config;
  private readonly hlsDir: string;
  private readonly workRoot: string;
  private readonly log: (m: string) => void;
  private parsed: ParsedXmltv | null = null;
  private child: ChildProcess | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private xmltvTimer: NodeJS.Timeout | null = null;
  private segStart = 0;
  private stopped = false;
  private gen = 0;                 // work-dir generation, so restarts don't clash
  private lastStatus = "starting";

  constructor(cfg: Config, hlsDir: string, workRoot: string, log: (m: string) => void) {
    this.cfg = cfg; this.hlsDir = hlsDir; this.workRoot = workRoot; this.log = log;
  }

  status(): string { return this.lastStatus; }

  async start(): Promise<void> {
    this.stopped = false;
    await mkdir(this.hlsDir, { recursive: true });
    await this.reloadXmltv();
    await this.cycle();
    // periodic window refresh (re-render + restart ffmpeg)
    this.refreshTimer = setInterval(() => { void this.cycle(); }, Math.max(1, this.cfg.refreshMin) * 60_000);
    // periodic XMLTV refresh (for URL sources / updated files)
    this.xmltvTimer = setInterval(() => { void this.reloadXmltv(); }, Math.max(1, this.cfg.xmltvRefreshMin) * 60_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.xmltvTimer) clearInterval(this.xmltvTimer);
    this.killChild();
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

  private killChild(): void {
    if (this.child) { try { this.child.kill("SIGKILL"); } catch { /* ignore */ } this.child = null; }
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

  // ---- one render + (re)start cycle ----------------------------------------
  private async cycle(): Promise<void> {
    if (this.stopped || !this.parsed) return;
    const gen = ++this.gen;
    const work = join(this.workRoot, `g${gen}`);
    try {
      await mkdir(work, { recursive: true });
      const built = await this.renderAssets(work);
      if (!built) return;
      const args = await this.buildFfmpegArgs(work, built);
      this.killChild();
      const bin = process.env.FFMPEG || "ffmpeg";
      this.log(`[hls] (re)starting ffmpeg — window ${new Date().toLocaleString()}, ${built.rowCount} rows, ${built.nPromo} promo clip(s), start_number ${this.segStart}`);
      const child = spawn(bin, args, { cwd: work, stdio: ["ignore", "ignore", "pipe"] });
      this.child = child;
      this.lastStatus = "streaming";
      child.stderr.on("data", (b: Buffer) => { const s = b.toString().trim(); if (s) this.log(`[ffmpeg] ${s.replace(/\s+/g, " ").slice(0, 400)}`); });
      child.on("exit", (code) => {
        // bump the media sequence so the next run continues cleanly
        this.segStart += this.countSegments();
        void rm(work, { recursive: true, force: true }).catch(() => {});
        if (!this.stopped && this.child === child) { this.lastStatus = `ffmpeg exited (${code}); restarting`; setTimeout(() => { void this.cycle(); }, 1500); }
      });
    } catch (e) {
      this.lastStatus = `cycle error: ${(e as Error).message}`;
      this.log(`[hls] cycle error: ${(e as Error).message}`);
    }
  }

  private countSegments(): number {
    try { return readdirSync(this.hlsDir).filter((f) => /^seg\d+\.ts$/.test(f)).length + this.cfg.hls.listSize; }
    catch { return this.cfg.hls.listSize; }
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
    const m3u8 = join(this.hlsDir, "live.m3u8");
    const segPat = join(this.hlsDir, "seg%d.ts");
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
      "-f", "hls", "-hls_time", String(seg), "-hls_list_size", String(Math.max(3, cfg.hls.listSize || 10)),
      "-hls_flags", "append_list+delete_segments+omit_endlist+independent_segments",
      "-hls_segment_type", "mpegts", "-hls_segment_filename", segPat, "-start_number", String(this.segStart),
      m3u8,
    ];
  }
}
