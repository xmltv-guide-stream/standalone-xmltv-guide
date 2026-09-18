// -----------------------------------------------------------------------------
// Configuration: loaded from / saved to a JSON file, editable via the web page.
// -----------------------------------------------------------------------------
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_GUIDE_THEMES, type GuideTheme } from "./render.js";

export interface SourceCred { type: "plex" | "jellyfin" | "emby"; address: string; token: string }

export interface Config {
  port: number;
  xmltvSource: string;        // local file path or http(s) URL
  xmltvRefreshMin: number;    // re-parse the XMLTV this often
  offsetMin: number;          // display timezone offset from UTC, in minutes
  video: { width: number; height: number; fps: number };
  columns: number;            // half-hour columns across
  slotMinutes: number;        // minutes per column
  scrollSpeed: number;        // grid scroll px/sec
  refreshMin: number;         // regenerate the window (restart ffmpeg) this often
  promoRotateSec: number;     // featured panel rotation interval
  animateTimeChange: boolean; // classic time-bar scroll-up animation at slot changes
  themeId: string;
  fontFile: string;           // overrides the theme's fontFile if set
  themeOverride: Partial<GuideTheme>;
  channels: { include: string[]; max: number };
  promoFolder: string;        // trailer/promo clips (recursive)
  musicFolder: string;        // background music (recursive)
  sources: Record<string, SourceCred>;  // for art:// poster refs (Plex/Jellyfin/Emby)
  hls: { segmentSec: number; listSize: number };
}

export function defaultConfig(): Config {
  return {
    port: 8501,
    xmltvSource: "",
    xmltvRefreshMin: 30,
    offsetMin: -new Date().getTimezoneOffset(),
    video: { width: 1920, height: 1080, fps: 24 },
    columns: 3, slotMinutes: 30, scrollSpeed: 60, refreshMin: 30, promoRotateSec: 30, animateTimeChange: true,
    themeId: "cable", fontFile: "", themeOverride: {},
    channels: { include: [], max: 0 },
    promoFolder: "", musicFolder: "",
    sources: {},
    hls: { segmentSec: 4, listSize: 10 },
  };
}

export function resolveTheme(cfg: Config): GuideTheme {
  const base = DEFAULT_GUIDE_THEMES[cfg.themeId] ?? DEFAULT_GUIDE_THEMES.cable;
  const merged: GuideTheme = { ...base, ...(cfg.themeOverride || {}) };
  if (cfg.fontFile) merged.fontFile = cfg.fontFile;
  return merged;
}

/** Deep-ish merge of stored config over defaults (nested objects merged one level). */
function mergeConfig(stored: Partial<Config>): Config {
  const d = defaultConfig();
  return {
    ...d, ...stored,
    video: { ...d.video, ...(stored.video ?? {}) },
    channels: { ...d.channels, ...(stored.channels ?? {}) },
    hls: { ...d.hls, ...(stored.hls ?? {}) },
    themeOverride: { ...(stored.themeOverride ?? {}) },
    sources: { ...(stored.sources ?? {}) },
  };
}

export async function loadConfig(path: string): Promise<Config> {
  try { return mergeConfig(JSON.parse(await readFile(path, "utf8"))); }
  catch { return defaultConfig(); }
}
export async function saveConfig(path: string, cfg: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  await writeFile(path, JSON.stringify(cfg, null, 2), "utf8");
}
