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

Then point your player / restreamer at `http://<host>:8501/live.m3u8`, and open the
config page below to set things up.

## Configuration (built-in web page)

**Open `http://localhost:8501/` in a browser** (replace `localhost` with the
server's host/IP if it's on another machine; the port is the `port` setting,
default `8501`). This is the primary way to configure the service — you don't have
to hand-edit any files.

From that page you can:

- Set the **XMLTV source** (a local path or an `http(s)://` URL) and how often it refreshes.
- Change **video/HLS** settings (resolution, fps, segment length), **layout & motion**
  (columns, scroll speed, featured-rotation interval), and the **theme** + custom **font**.
- Point at **promo/trailer** and **music** folders, choose **which channels** to include,
  and add **Plex/Jellyfin/Emby** credentials (only needed for `art://` poster refs).
- Watch a live **status** indicator and a scrolling **log** panel.

Click **Save & restart** and the stream relaunches with the new settings — no
restart of the process needed. Everything has sensible defaults, so the only thing
you *must* set is the XMLTV source. (Settings are persisted to `data/config.json`;
see the reference below if you'd rather edit that file directly.)

## Consuming the HLS

The output is a standard live HLS playlist:

- Playlist: `http://<host>:<port>/live.m3u8`
- Segments: `http://<host>:<port>/segNNN.ts`

CORS is open (`Access-Control-Allow-Origin: *`) so browser players work too. To
re-mux it elsewhere without re-encoding (direct copy):

```bash
ffmpeg -i http://<host>:8501/live.m3u8 -c copy -f mpegts udp://...
```

## Settings reference

Every setting is editable from the web page above; this is what each one does (and
the keys, if you edit `data/config.json` directly instead):

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
