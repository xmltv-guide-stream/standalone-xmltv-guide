// -----------------------------------------------------------------------------
// Featured-poster resolution. Two kinds of icon reference are supported:
//   * a plain http(s) URL  (most XMLTV feeds put a poster URL in <icon src=...>)
//   * an art://{sourceId}/{type}/{base64url(key)} ref (Plex/Jellyfin/Emby), which
//     is turned into a live image URL using the source's stored address + token.
// Either way the image is fetched and returned as a data: URL to embed in the SVG.
// -----------------------------------------------------------------------------
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { SourceCred } from "./config.js";

function mimeFor(p: string): string {
  return /\.png$/i.test(p) ? "image/png" : /\.webp$/i.test(p) ? "image/webp"
    : /\.gif$/i.test(p) ? "image/gif" : "image/jpeg";
}

/** Turn an art:// ref into a real source image URL (token included). */
export function resolveArtRef(ref: string, sources: Record<string, SourceCred>): string | undefined {
  const rest = ref.slice("art://".length);
  const s1 = rest.indexOf("/"), s2 = rest.indexOf("/", s1 + 1);
  if (s1 < 0 || s2 < 0) return undefined;
  const src = sources[rest.slice(0, s1)];
  if (!src?.address || !src.token) return undefined;
  const type = rest.slice(s1 + 1, s2);
  let key = ""; try { key = Buffer.from(rest.slice(s2 + 1), "base64url").toString("utf8"); } catch { return undefined; }
  const addr = src.address.replace(/\/+$/, "");
  if (type === "plex") {
    const m = key.match(/\/library\/metadata\/\d+/);
    const base = m ? m[0] : (key.startsWith("/") ? key.replace(/\/children\/?$/, "") : `/${key}`);
    return `${addr}${base}/thumb?X-Plex-Token=${encodeURIComponent(src.token)}`;
  }
  return `${addr}/Items/${encodeURIComponent(key)}/Images/Primary?api_key=${encodeURIComponent(src.token)}`;
}

/** Resolve an icon reference to a data: URL (or undefined if it can't be fetched). */
export async function loadIcon(ref: string | undefined, sources: Record<string, SourceCred>): Promise<string | undefined> {
  if (!ref) return undefined;
  if (ref.startsWith("data:")) return ref;
  const url = ref.startsWith("art://") ? resolveArtRef(ref, sources) : ref;
  if (!url) return undefined;
  try {
    if (/^https?:\/\//i.test(url)) {
      const res = await fetch(url);
      if (!res.ok) return undefined;
      const mime = res.headers.get("content-type")?.split(";")[0] || mimeFor(url);
      const buf = Buffer.from(await res.arrayBuffer());
      return `data:${mime};base64,${buf.toString("base64")}`;
    }
    const clean = url.replace(/^file:\/\//i, "");
    if (!existsSync(clean)) return undefined;
    return `data:${mimeFor(clean)};base64,${(await readFile(clean)).toString("base64")}`;
  } catch { return undefined; }
}
