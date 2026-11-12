# Orpheon Eclipse Bridge

A pure **Eclipse addon bridge** for [MySpoti](https://github.com/MySpoti). It gives MySpoti one
ordered addon list, the way Stash manages its addons, and removes everything that belongs to
Eclipse Cloud.

- **No Eclipse Cloud account**
- **No login, token, premium or subscription checks**
- **No Apple Music, Qobuz or Tidal Cloud routes**
- **No primary/extra addon split**

Orpheon only talks to the Eclipse addons you add. Audio and downloads come from those addons.

> Not affiliated with Eclipse, MySpoti, Spotify, Tidal, Qobuz or Apple.

## Features

- **One addon list** — add any number of Eclipse addon manifest URLs.
- **Test, enable/disable, reorder, remove** — the first enabled addon with audio wins.
- **Per-addon settings from the manifest** — select, toggle, number, text and secret fields are read
  from each addon's own `settings` declaration and sent as query parameters on every request.
- **Exact Spotify identity first** — the bridge sends `spotifyUri` (and `isrc` when MySpoti knows it)
  to `/resolve`, so the addon can do `Spotify → ISRC → TIDAL` instead of guessing by title.
- **Search fallback** — addons without exact metadata are asked through `/search`; Orpheon only
  accepts a result when title/version, artist and duration agree.
- **Downloads** — `download.source` uses the same addon order and returns the addon's own file.
- **Health checks** — test each addon on the page; see HTTP status, latency and the last result.
- **Two-level local cache** — resolved addon IDs and stream URLs, with adjustable sizes and TTLs. Audio is never cached.
- **Prefetch next 1–3** — choose Off, Next 1, Next 2 or Next 3 on the page. When a song starts, Orpheon reads the queue snapshot and warms those tracks. It needs `playback.events`; the host still prefetches the immediate next track.
- **Readable page** — the addon list is not hidden behind MySpoti's mini player or bottom navigation.

## Install

Requirements: **MySpoti 2.4.0 or newer**.

### From the extension repository (recommended)

In MySpoti: **Settings → Extensions → Store → Add a repository**, then paste:

```
https://raw.githubusercontent.com/DarkyGuld/Orpheon-EclipseBridge/main/index.json
```

Use **Add a repository** for this URL. The **Install from an address** field expects a package zip
or a GitHub repository, not an `index.json`; pasting the index there gives
`no manifest.json at the root of the package`.

### Direct install (package)

In MySpoti: **Settings → Extensions → Store → Install from an address**, then paste:

```
https://github.com/DarkyGuld/Orpheon-EclipseBridge/releases/latest/download/extension.zip
```

The GitHub repository address also works there:

```
https://github.com/DarkyGuld/Orpheon-EclipseBridge
```

### From a zip

Download `dev.orpheon.eclipsebridge-1.0.7.zip` from `packages/` or the
[release](https://github.com/DarkyGuld/Orpheon-EclipseBridge/releases/tag/v1.0.7) and install it
from the extension store's local zip option.

## Add an addon

1. Open **Orpheon Eclipse Bridge → Open its page**.
2. Paste an addon manifest URL, for example:
   ```
   https://your-addon.example/stash/manifest.json
   ```
   A base URL such as `https://your-addon.example/stash` also works; Orpheon appends
   `/manifest.json`.
3. Press **Test** to confirm the addon and its routes answer.
4. Press **+ Add**.
5. Open **Settings** on the addon card and set its quality or other manifest settings.
6. Use the arrows to set the fallback order, or the switch to disable an addon temporarily.

A private addon URL may contain a token. Orpheon keeps the full URL on the device, sends it only to
that addon, and never writes it to logs. The page shows only the host.

## Playback order

For every song, Orpheon asks the enabled addons from top to bottom:

```
1. exact:  spotifyUri + isrc → /resolve → /stream/<id>
2. exact:  /resolve-isrc (when the addon has the isrc resource)
3. text:   title + artist + duration → /resolve → /stream/<id>
4. search: title + artist → /search → strict match → /stream/<id>
5. next addon
```

The fallback is only used when the previous route has no playable audio. A successful stream is
cached until its `expiresInMs`/`expiresAt`, so replays and seeks do not ask the addon again.

Downloads use the same order. `isrcMatched` is set only when the file was found by the song's ISRC.

## Local cache

Orpheon keeps two small caches in MySpoti's extension storage on the phone:

- **Resolved IDs** — `spotifyUri/ISRC → addon ID` (for example NullBeat's `nb:…`). Default 500 entries, 7 days.
- **Stream URLs** — the CDN address returned by the addon. Default 200 entries, 30 minutes.

On a play Orpheon tries the stream URL first, then the resolved ID with the addon's `/stream/<id>` (which uses NullBeat's own server cache), and only then a full `/resolve`. Both sizes and TTLs are adjustable on the page. MySpoti allows 512 KB of extension storage, so Orpheon trims the oldest entries if the chosen limits fill it.

This is **not an audio cache**. Audio still streams from the addon's CDN. Offline playback needs MySpoti's download feature.

## Prefetch

MySpoti already asks for the immediate next song ahead of time. Orpheon can add the next one
to three (default two) when the queue is readable: on a `start` event it takes the queue snapshot, finds the current
track and warms the next two resolve/stream answers. Only the stream address is cached, never
audio.

The queue snapshot comes from MySpoti's `playback.events` permission. While the app's own player
is active the queue can be hidden or stale; Orpheon validates that the current track is in the
snapshot and skips prefetch when it is not. Shuffled queues are skipped because their order is
not reliable. In those cases MySpoti's built-in one-track-ahead prefetch still applies.

## Why no MySpoti update is needed

MySpoti's audio hook already gives the extension the Spotify track `uri` and `id`. Orpheon builds
`spotify:track:<id>` and sends it as `spotifyUri` itself. The same applies to downloads. You do not
need a special MySpoti build for the exact route.

## Build

```bash
# validate
myspoti-ext check .

# package
myspoti-ext pack . packages

# write packages/index.json
myspoti-ext index packages "Orpheon Eclipse Bridge"
```

Or run `scripts/build.sh` from the repository root.

## Privacy

- No account, cloud session, analytics or telemetry.
- No requests to Eclipse Cloud, Spotify, Apple, Qobuz or Tidal from this extension.
- The only network requests are the manifest, resolve, search and stream calls to the addons you add.
- Addon URLs, tokens and secrets stay in MySpoti's extension storage on the device.
- Logs contain addon names, routes, HTTP status and timings, never full URLs or settings values.

## Changelog

### 1.0.7

- Wait up to 14 s for a slow addon stream (inside MySpoti's 15 s hook) so a cold TorBox/NullBeat resolve can finish instead of falling back.

### 1.0.6

- A timeout or 5xx no longer starts a second addon stream. The `/stream?trackId=` form is only tried on 404/400/405, and a 503 preparing is retried on the same URL.

### 1.0.5

- Two-level local cache: a resolved addon-ID cache (default 500, 7 days) and a stream-URL cache (default 200, 30 min). Adjust both on the page.
- Live now-playing, last request, last answer and activity log on the page.
- Flatter, simpler page.

### 1.0.4

- New simple page with live playback/cache updates and a prefetch setting (Off / 1 / 2 / 3).
- The page labels the resolve cache clearly and explains that it stores metadata, not audio.
- Prefetch shows `Queue hidden` when MySpoti does not expose the local queue.

### 1.0.3

- Prefetch the next two queue tracks when a song starts, so their resolve and stream answers are already in the cache.
- Adds the `playback.events` permission (read the queue). The update may ask you to accept it.

### 1.0.2

- Removed the automatic status probe. A slow or sleeping addon can no longer make MySpoti skip Orpheon before playback; the page keeps manual health checks.

### 1.0.1

- Hardened stream expiry: zero or already-expired addresses are not cached.
- Rate-limit and 401/403 answers from search are reported correctly.
- The status probe stops after 3.5 s even with a long addon list.

### 1.0.0

- First pure bridge release.
- Unified ordered addon list with add, test, enable/disable, reorder, remove.
- Per-addon manifest settings.
- Exact Spotify URI and ISRC resolution, plus search fallback.
- Downloads through the same addon order.
- Health status, stream cache and page spacing fix.
