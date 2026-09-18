// -----------------------------------------------------------------------------
// Generic XMLTV parsing (standard single-file, multi-channel format).
// -----------------------------------------------------------------------------
// Unlike a per-channel guide, a normal XMLTV file has <channel> elements (id,
// display-name, optional lcn/number, icon) and <programme channel="..."> elements
// for every channel in one document. We parse both, keeping the metadata the
// scrolling guide needs (title, sub-title, desc, category, rating, year, cast,
// icon). Timestamps carry their own "+HHMM" offset, which we honour.

import { readFile } from "node:fs/promises";

export interface GuideProgram {
  startMs: number; stopMs: number; title: string;
  category?: string; rating?: string; year?: string; desc?: string;
  cast?: string; subTitle?: string; icon?: string;
}
export interface XmltvChannel { id: string; number: string; name: string; icon?: string }
export interface ParsedXmltv {
  channels: XmltvChannel[];
  byChannel: Map<string, GuideProgram[]>;
}

/** Parse an XMLTV "YYYYMMDDHHMMSS +HHMM" timestamp to epoch ms (honours the
 *  embedded offset; assumes UTC if none is present). */
export function parseXmltvTime(s: string): number {
  const m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/.exec(s);
  if (!m) return NaN;
  const [, Y, Mo, D, H, Mi, Se, tz] = m;
  let off = 0;
  if (tz) off = (tz[0] === "-" ? -1 : 1) * (parseInt(tz.slice(1, 3), 10) * 60 + parseInt(tz.slice(3, 5), 10));
  return Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +Se) - off * 60000;
}

function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}
function tag(inner: string, name: string): string | undefined {
  const m = inner.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? decode(m[1]).trim() : undefined;
}
function attr(el: string, name: string): string | undefined {
  const m = el.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? decode(m[1]) : undefined;
}

const PROG_RE = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
const CHAN_RE = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi;

function parseProgramme(attrs: string, inner: string): { channel: string; prog: GuideProgram } | null {
  const start = attr(attrs, "start");
  const channel = attr(attrs, "channel");
  if (!start || !channel) return null;
  const stop = attr(attrs, "stop");
  const rating = inner.match(/<rating\b[^>]*>[\s\S]*?<value\b[^>]*>([\s\S]*?)<\/value>/i);
  const date = inner.match(/<date\b[^>]*>(\d{4})/i);
  const iconM = inner.match(/<icon\b[^>]*\bsrc="([^"]+)"/i);
  const actors = [...inner.matchAll(/<actor\b[^>]*>([\s\S]*?)<\/actor>/gi)].map((m) => decode(m[1]).trim()).filter(Boolean);
  const startMs = parseXmltvTime(start);
  const stopMs = stop ? parseXmltvTime(stop) : startMs + 30 * 60000;
  return {
    channel,
    prog: {
      startMs, stopMs,
      title: tag(inner, "title") ?? "",
      subTitle: tag(inner, "sub-title"),
      category: tag(inner, "category"),
      desc: tag(inner, "desc"),
      rating: rating ? decode(rating[1]).trim() : undefined,
      year: date ? date[1] : undefined,
      icon: iconM ? decode(iconM[1]).trim() : undefined,
      cast: actors.length ? actors.slice(0, 3).join(", ") : undefined,
    },
  };
}

const isNumeric = (s: string): boolean => /^\d+(\.\d+)?$/.test(s);
/** Collapse consecutive duplicate whitespace-separated tokens ("3.9 3.9 CBS" -> "3.9 CBS"). */
function collapseDupTokens(s: string): string {
  const out: string[] = [];
  for (const p of s.split(/\s+/).filter(Boolean)) if (out[out.length - 1]?.toLowerCase() !== p.toLowerCase()) out.push(p);
  return out.join(" ");
}
/** Pick a clean channel name from XMLTV's several <display-name>s. ErsatzTV emits
 *  the combined "NUM NAME", the number alone, and the name alone; we want just the
 *  call sign so "CH 3.9" + name doesn't render as "3.9 3.9 CBS". */
function pickChannelName(names: string[], number: string): string {
  const nonNum = names.filter((n) => !isNumeric(n));
  // 1) a pure call sign: not the number and not the "NUM …" combined form
  if (number) {
    const pure = nonNum.find((n) => n !== number && !n.startsWith(number + " "));
    if (pure) return collapseDupTokens(pure);
  }
  // 2) else take the first non-numeric and strip a leading number token that
  //    matches this channel's number (the "NUM NAME" combined form)
  let cand = nonNum[0] || names[0] || "";
  if (number && cand.startsWith(number + " ")) cand = cand.slice(number.length + 1).trim();
  return collapseDupTokens(cand);
}

function parseChannel(attrs: string, inner: string): XmltvChannel | null {
  const id = attr(attrs, "id");
  if (!id) return null;
  const names = [...inner.matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/gi)].map((m) => decode(m[1]).trim()).filter(Boolean);
  const lcn = tag(inner, "lcn");
  const number = (lcn || names.find(isNumeric) || "").trim();
  const name = pickChannelName(names, number) || id;
  const iconM = inner.match(/<icon\b[^>]*\bsrc="([^"]+)"/i);
  return { id, number, name, icon: iconM ? decode(iconM[1]) : undefined };
}

/** Parse a full XMLTV document into channels + programmes-by-channel. */
export function parseXmltv(xml: string): ParsedXmltv {
  const channels: XmltvChannel[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(CHAN_RE)) {
    const c = parseChannel(m[1], m[2]);
    if (c && !seen.has(c.id)) { seen.add(c.id); channels.push(c); }
  }
  const byChannel = new Map<string, GuideProgram[]>();
  for (const m of xml.matchAll(PROG_RE)) {
    const p = parseProgramme(m[1], m[2]);
    if (!p || !Number.isFinite(p.prog.startMs)) continue;
    const arr = byChannel.get(p.channel);
    if (arr) arr.push(p.prog); else byChannel.set(p.channel, [p.prog]);
  }
  for (const arr of byChannel.values()) arr.sort((a, b) => a.startMs - b.startMs);

  // Some XMLTV feeds omit <channel> blocks — synthesise channels from programme ids.
  if (!channels.length) {
    let n = 1;
    for (const id of byChannel.keys()) channels.push({ id, number: String(n++), name: id });
  } else {
    // keep only channels that actually have programmes, preserving document order
    for (const id of byChannel.keys()) if (!seen.has(id)) channels.push({ id, number: "", name: id });
  }
  return { channels, byChannel };
}

/** Load XMLTV from a local path or an http(s) URL. */
export async function loadXmltv(src: string): Promise<ParsedXmltv> {
  let xml: string;
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`XMLTV fetch failed: ${res.status} ${res.statusText}`);
    xml = await res.text();
  } else {
    xml = await readFile(src, "utf8");
  }
  return parseXmltv(xml);
}
