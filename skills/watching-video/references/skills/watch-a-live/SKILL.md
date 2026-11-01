---
name: watch-a-live
description: "Use when asked to watch something in real time and keep a record — a Bilibili/YouTube/m3u8 livestream, or any local app whose screen+audio should be observed as it runs (Tencent Meeting, Zoom, a game). Records continuously and samples the recent window into keyframes for vision, appending to a running log."
version: 1.1.0
author: Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [livestream, live, 直播, recording, keyframe, vision, screen-capture, meeting]
    related_skills: [info-from-videos, record-a-mac-app]
---

# Watch a Live Source

Record continuously while sampling the **recent window** into keyframes for vision — so the agent can
report what is happening without watching every frame, and a full recording is kept for afterwards.
Two sources feed it: a **stream URL** (via yt-dlp) or **any local app** (via OBS + ScreenCaptureKit,
see `record-a-mac-app`). Sibling of the habit pack `info-from-videos` → its `watch-a-video` island
(recorded video / local files) — that pipeline moved out of this pack on 2026-10-13.

## When to Use

- "看这个直播" / "盯着这个直播间" / "实时记录这个直播" — a `live.bilibili.com/<room>` or `youtube.com/live/<id>` URL
- "盯着腾讯会议" / "watch this meeting" / "把这个程序运行过程记下来" — any app's own window+audio, recorded
  without capturing the whole screen
- Any request to observe something as it happens and produce a log of it

Not for: a finished VOD or a local file → `info-from-videos`（`watch-a-video` 岛）. Not for a one-shot recording with no log →
`record-a-mac-app` alone.

## Prerequisites

- **yt-dlp** (`~/.local/bin/yt-dlp`) — stream URLs only
- **ffmpeg** — `$HOME/.hermes/tools/ffmpeg-9.0.1-darwin-arm64` (prepend to PATH)
- **uv** — supplies numpy/Pillow to the keyframe extractor (`env -u PYTHONPATH uv run --with numpy --with Pillow`)
- **YouTube live only**: `--js-runtimes node`
- **Local app only**: OBS 30+ with the websocket server enabled → `record-a-mac-app`

## Two kinds of live source

Steps 2–4 below are identical for both; only **how the capture file is produced** differs.

| Source | Capture | Skill that owns the mechanics |
|---|---|---|
| a stream URL (Bilibili / YouTube / any m3u8) | `yt-dlp` writes a growing `.flv.part` | this one, below |
| **any local app** — Tencent Meeting, Zoom, a browser, a game | OBS writes a growing `.mkv` | `record-a-mac-app` |

The second row is what makes "watch an arbitrary program" possible: ScreenCaptureKit captures one
app's video **and audio** while it runs in the background, and the resulting `.mkv` is sampled here
exactly like a stream. That also closes the transcription half — the same file carries the audio, so
one recording feeds both the vision log and a whisper transcript.

## Procedure

### 0 — Confirm there is something to watch

For a stream URL:

```bash
export PATH="$HOME/.local/bin:$PATH"
yt-dlp --js-runtimes node --simulate --print "%(is_live)s | %(title).50s" "<live-url>"
```

`True` = live. A `Streamer is not live` error ends the task; do not start a capture.

For a local app there is no equivalent probe — instead confirm the app is running **with a visible
window** (not minimised, not hidden by Stage Manager; macOS stops drawing those and you record
black):

```bash
osascript -e 'tell application "System Events" to tell process "腾讯会议" to get size of every window'
# → "1581, 1040" = visible.  An empty result = no window; capture would be black.
```

### 1 — Start the capture (background, continuous)

**Stream URL** — `yt-dlp` writes a growing file:

```bash
export PATH="$HOME/.local/bin:$PATH"
mkdir -p /tmp/live-watch
nohup yt-dlp --js-runtimes node -f "best[ext=flv]/best" \
  -o "/tmp/live-watch/capture.%(ext)s" "<live-url>" \
  > /tmp/live-watch/capture.log 2>&1 &
echo $! > /tmp/live-watch/capture.pid
```

- **`-f "best[ext=flv]/best"` matters on Bilibili** — the default pick is an `fmp4` stream, which
  yt-dlp refuses with *"The extracted extension ('fmp4') is unusual and will be skipped for safety"*.
- yt-dlp writes `capture.flv.part` while the stream runs and renames it to `capture.flv` at the end.
  Sample the `.part` file — it is readable as it grows.
- yt-dlp handles the HLS playlist refresh for you, so a long stream needs no babysitting.

**Local app** — OBS records the app's own video+audio (mechanics in `record-a-mac-app`; it needs the
websocket server on and the app's bundle id):

```bash
python3 .../record-a-mac-app/scripts/obsctl.py capture com.tencent.meeting   # once, on its own scene
python3 -c "import sys; sys.path.insert(0,'.../record-a-mac-app/scripts'); from obsctl import OBS; \
  OBS().req('StartRecord')"                                                  # start; file grows in place
```

OBS keeps writing one `.mkv` until `StopRecord`, so the file under `/tmp` is the live capture — no
`.part` rename, and no separate stop step beyond the one in §3.

### 2 — Sample a round (repeat every N minutes)

Identical for both sources — point it at whichever file is growing:

```bash
export PATH="$HOME/.hermes/tools/ffmpeg-9.0.1-darwin-arm64:$PATH"
CAP=$(ls /tmp/live-watch/capture.flv* 2>/dev/null | head -1 || ls -t /tmp/live-watch/*.mkv | head -1)
bash scripts/sample-live.sh "$CAP" /tmp/live-watch/rounds 300
```

Sampling a file that is **still being written works** — verified against a live OBS `.mkv`: cutting
the tail 12 s into a recording produced a valid segment (the same works for `.flv.part`).

It cuts the last ~5 minutes into a segment, extracts keyframes, and prints the overview sheet paths:

```
round   round-081534
window  0:28.033  keyframes=32  sheets=3
/tmp/live-watch/rounds/round-081534/kf/overview_01.jpg
...
```

Then read **every** printed sheet with `vision_analyze` and append one block per round to the log:

```markdown
## 16:10–16:15
<两句：画面里发生了什么，有没有值得注意的变化>
```

Sheets answer **"what changed / what is on screen", not "what exactly does that text say"** — each one
is a 12-tile grid downscaled into a single image, so fine text in it is not legible. Vision fills that
gap with plausible-looking wording rather than admitting it cannot read, so **never transcribe slide
bullets, numbers or names from a sheet, and never promote a sheet reading into a written record**. To
quote or archive text, cut that timestamp full-resolution and read the single frame:

```bash
ffmpeg -y -v error -ss <t> -i "$CAP" -frames:v 1 /tmp/f.png   # <t> from the tile's timestamp label
```

If the full-resolution frame is still unreadable, write "cannot read" — a confident paraphrase is worse
than a gap in the record.

### 3 — Stop and keep the record

**Stream URL**:

```bash
kill "$(cat /tmp/live-watch/capture.pid)"
```

**Local app** — stop OBS, which finalises the `.mkv`:

```bash
python3 -c "import sys; sys.path.insert(0,'.../record-a-mac-app/scripts'); from obsctl import OBS; \
  print(OBS().req('StopRecord')['outputPath'])"
```

The result of a session is:
```
/tmp/live-watch/
├── capture.flv  (or the OBS .mkv)  ← the full recording (the 记录)
├── capture.log                     ← yt-dlp log (stream route only)
├── log.md                          ← the running observation log written across rounds
└── rounds/round-*/                 ← per-round segment + keyframe sheets
```

Move these somewhere durable — `/tmp` is scratch. **A lecture / talk / seminar is archived to this user's
vault, not to a scratch dir**: one folder per lecture at
`~/Documents/Obsidian/Lectures/<YYYY>/<主题>_<报告人>_<YYYY-MM-DD>/`, holding `README.md` (the note),
`transcript.md`, `recording*.mkv` and `assets/`, classed by year. The full naming rules (topic shortened
to ≤20 chars, whole folder name ≤40, the note's frontmatter and its four body sections) are the spec at
`~/Documents/Obsidian/Lectures/README.md` — read that spec before building the folder instead of
inventing a layout. When a recording runs in several files, name them `recording-1-<what it holds>.mkv`
and say per file whether the **picture** and the **audio** are actually usable: a segment can be
all-silence or all-static-slide, and the note must not imply otherwise. Anything that is not a lecture
goes wherever the user says.

### 4 — Afterwards

Run the finished recording through the `watch-a-video` island of `info-from-videos` for a whole-stream summary
(the per-round sheets are already the timeline; the full pass is for a single consolidated view).

**On the local-app route, transcribe it too** — the OBS recording carries the app's audio, so the
same file gives both halves of the log. **`env -u PYTHONPATH` is required, not cosmetic**: the agent
runtime exports a PYTHONPATH for python3.14 while whisper's env is 3.11, and without it every run dies
with `No module named 'numpy._core._multiarray_umath'` — an error that blames numpy and sends you
chasing an install that is fine.

```bash
env -u PYTHONPATH ~/.local/bin/mlx_whisper --model mlx-community/whisper-large-v3-turbo \
  --output-format txt --language zh "$CAP"
```

**Check the recording is not silent before transcribing.** Whisper does not return nothing on silence —
it returns confident-looking captions from its training prior (a 1 s silent clip → `优优独播剧场——YoYo
Television Series Exclusive`; a 3-minute idle recording → one invented line repeated 14 times). Read
`max_volume` first; at `-91.0 dB` there is no speech to transcribe, so discard the text rather than
appending invented captions to the log:

```bash
ffmpeg -hide_banner -i "$CAP" -af volumedetect -f null - 2>&1 | grep max_volume
```

## Cadence

Default window and round length is **5 minutes**. Shorter (60–120 s) for fast-moving events
(esports, breaking news); longer (10–15 min) for talk streams, where a round would otherwise be
mostly one static camera. State the cadence you picked, and keep it steady so the log stays comparable.

**A meeting needs a shorter round than a stream.** Keyframes only capture *change*, so a talking-head
call yields very few frames per round while someone is speaking — 60–120 s keeps the log granular
enough to be useful. And a round can legitimately produce **one** keyframe when the picture is static;
that is not a failure.

## Pitfalls

- **`fmp4` is refused** — always pin `-f "best[ext=flv]/best"` on Bilibili.
- **Kill by PID file, not `pkill -f <url>`** — the URL pattern also matches your own shell.
- **Cutting the tail of a partial file prints `Invalid NAL unit size` / `missing picture` /
  `File ended prematurely` warnings** on stderr. This is normal for a mid-stream cut (both `.flv.part`
  and a live `.mkv`); the segment is still valid — check `ffprobe` duration rather than the warnings.
- **A segment can be empty right after starting** if the stream has not buffered yet. Wait one window
  before the first round.
- **Sample the recent window, not the whole file** — re-extracting keyframes from a multi-hour capture every round is quadratic and gets slower with every round.
- **The extractor needs numpy + Pillow.** System `python3` on this machine has neither; `env -u PYTHONPATH uv run --with numpy --with Pillow` is the reliable way (do not chase a venv path). **`env -u PYTHONPATH` is required, not cosmetic**: the agent runtime exports a `PYTHONPATH` pointing at a python3.14 site-packages while uv's default interpreter is 3.11, so numpy's extension fails with `No module named 'numpy._core._multiarray_umath'` — an error that blames numpy and sends you chasing an install that is fine.
- **Ask before leaving a capture running for hours**: it writes gigabytes continuously.

### Local-app route only

- **No visible window = black recording.** A minimised window, a Stage-Manager-hidden app, or an app
  that has closed its window records pure black — the source still reports `videoActive: true`, so
  check the actual frame, not the source state. Verified: Preview with its window closed recorded
  R=0 across the whole file.
- **The video source's `display_uuid` must be the display the target's window is ON.** The wrong
  display's UUID — or none at all — records pure black with **no error in the log**, and on a
  multi-display Mac it is the easy mistake to make (this is how a browser on the external display first
  recorded black). Use `record-a-mac-app`'s `capture` subcommand, which now resolves it from the
  bundle's front window and prints the UUID it chose; hand-rolling `CreateInput` silently omits it.
  Full 2×2 evidence in that skill's traps.
- **A browser records whatever it is showing, not a page you chose.** Application capture follows the
  app's drawn content, so for Chrome/Safari it is the **active tab** — switching tabs mid-recording
  switches what is recorded, and a background tab cannot be targeted. Bring the wanted tab and window
  to the front before starting. App **audio** is per-app, so a background tab keeps playing into the
  recording even while a different page is on screen.
- **A livestream that has ended is a static "current stream has ended" page in silence** — a valid
  recording with nothing in it. Read the keyframe sheet and `max_volume` before logging it as content.
- **Do not clear a whole scene to clean up.** Removing the last scene item of a source deletes that
  source outright (OBS garbage-collects unreferenced inputs) — clearing every item of a scene you shared
  with the user destroys their own sources. Remove only the items you added
  (`app-video <bundle>` / `app-audio <bundle>`).
- **`-sseof` near the start of a fresh recording samples the startup frames** — a 14 s old file
  sampled with a 15 s window cuts from the very beginning, where the capture may not have drawn yet.
  Wait at least one window before the first round.
- **The app being watched must not be minimised for the whole session.** Put it behind other windows
  instead; it keeps drawing and the capture keeps working.

## Verification

```bash
# stream is live
yt-dlp --js-runtimes node --simulate --print "%(is_live)s" "<live-url>"   # → True

# local app has a drawable window (empty output = would record black)
osascript -e 'tell application "System Events" to tell process "腾讯会议" to get size of every window'

# one round produces sheets
bash scripts/sample-live.sh "$CAP" /tmp/live-watch/rounds 60 probe | tail -3   # → overview_*.jpg paths
```

Verified end-to-end on the local-app route: OBS recorded Preview's window in the background, a round
sampled the **still-growing** `.mkv` 25 s in, and the keyframe sheet showed the red test image with
the cursor in two positions at `#1 0.00s` / `#2 4.87s` — i.e. the change was captured, not just a
frame.
