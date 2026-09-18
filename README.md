# XMLTV Guide → HLS

A standalone service that turns **any XMLTV source** into a 1990s-style scrolling
TV-guide channel and serves it as **HLS** for anything external to consume (a
player, a restreamer, an IPTV setup, etc.). It's fully self-contained and does not
depend on the tv-next-scheduler project it was extracted from.

## What it does

- Reads a standard XMLTV file or URL (channels + programmes).
- Renders the classic cable-guide look: a scrolling grid (programmes sized by real
  duration, continuation arrows, category color-coding, taller movie blocks with
  rating/year/cast/synopsis), a fixed header with a live clock and time bar, a
  rotating **featured** panel with the show's poster, a **promo/trailer** window
  that shuffles clips from a folder, and background music.
- Composites it all with one ffmpeg process and writes an HLS playlist + segments.
- Hosts a **web config page** to edit and save every setting; saving restarts the
  stream with the new config.

## Requirements

- Node.js 20+
- `ffmpeg` and `ffprobe` on `PATH` (or set `FFMPEG` / `FFPROBE` env vars)

## Install & run

```bash
npm install
npm run build
npm start
```

Then open `http://localhost:8501/` to configure it, and point your player /
restreamer at `http://<host>:8501/live.m3u8`.

Set the **XMLTV source** (a local path or an `http(s)://` URL) and click
**Save & restart**. Everything else has sensible defaults.

## Consuming the HLS

The output is a standard live HLS playlist:

- Playlist: `http://<host>:<port>/live.m3u8`
- Segments: `http://<host>:<port>/segNNN.ts`

CORS is open (`Access-Control-Allow-Origin: *`) so browser players work too. To
re-mux it elsewhere without re-encoding (direct copy):

```bash
ffmpeg -i http://<host>:8501/live.m3u8 -c copy -f mpegts udp://...
```

## Configuration

All settings live in `data/config.json` (created on first run) and are editable
from the web page. Highlights:

- **xmltvSource** – file path or URL. **xmltvRefreshMin** – how often to re-read it.
- **refreshMin** – how often the visible time window is regenerated (ffmpeg
  restarts, continuing the same HLS playlist).
- **video** – width/height/fps. **hls** – segment length and playlist size.
- **columns / slotMinutes / scrollSpeed / promoRotateSec** – guide layout & motion.
- **themeId** (`cable`, `classic`, `mono`, `light`) + **fontFile** (point at a
  pixel/VCR TTF for the authentic look) + an advanced **themeOverride** JSON.
- **promoFolder / musicFolder** – scanned recursively; trailers need an audio track.
- **channels.include** – pick specific channels (empty = all) and **channels.max**.
- **sources** – Plex/Jellyfin/Emby address + token, only needed to resolve internal
  `art://` poster references (ordinary XMLTV `<icon>` URLs need no config).

### Environment overrides

- `FFMPEG`, `FFPROBE` – binary paths
- `DATA_DIR` (default `./data`), `CONFIG`, `HLS_DIR`, `WORK_DIR`

## Notes

- Posters come straight from each programme's `<icon>` URL, or from Plex/Jellyfin
  via `art://` refs + the configured source token — never from a third-party cache.
- The live clock uses the server's local time; set **Display TZ offset** to match
  the timezone your listings should read in.
- The guide only advances its window every `refreshMin`; a brief HLS discontinuity
  at each regeneration is normal and players handle it.

## License

MIT — see [LICENSE](LICENSE).
