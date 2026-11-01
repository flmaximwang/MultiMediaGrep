# Fixtures

Synthetic test material for MultiMediaGrep. **No third-party media lives in this
repository** — every asset below is generated from code, so the repository stays
small, licence-free and reproducible on macOS *and* Linux.

```bash
node fixtures/generate.mjs            # -> fixtures/generated/
node fixtures/generate.mjs --out /tmp/x
node --test test/fixtures.test.js     # regenerates into a temp dir and asserts the truth
```

The generator is **idempotent and deterministic**: running it twice produces
byte-identical files (ffmpeg is invoked with `-fflags +bitexact -flags:v +bitexact
-flags:a +bitexact -map_metadata -1`, and the MP3 is written without Xing/ID3
tags). A `manifest.json` in the output directory lists the size and SHA-256 of
every produced asset (it does not list itself), and the test suite re-runs the
generator to prove the bytes do not drift.

## Layout

| Path | What it is |
| --- | --- |
| `fixtures/generate.mjs` | Entry point. Generates every asset and the ground truth. |
| `fixtures/lib/*.mjs` | The generators: bitmap font, raster canvas, PNG codec, PDF writer, WAV codec, ffmpeg wrappers. |
| `fixtures/ground-truth/*.json` | **Committed** ground truth — the assertion baseline. |
| `fixtures/generated/` | Generated assets. Git-ignored; regenerate with `node fixtures/generate.mjs`. |

`fixtures/generate.mjs` writes the ground truth twice: once to
`fixtures/ground-truth/` (only when the default output directory is used, so a
custom `--out` never touches the committed files) and once to
`<out>/ground-truth/` for comparison. The test suite compares the two byte for
byte.

## Prerequisites

* **Node 20+** (ESM). No npm dependencies are added — only `node:zlib` and
  `node:child_process` are used.
* **ffmpeg + ffprobe** on `PATH` (developed against ffmpeg 9.0.2). Required
  encoders: `libx264`, `aac`, `mjpeg`, `libmp3lame`. The generator probes for
  them up front and aborts with a clear message instead of writing a
  half-finished fixture.
* **No fonts are needed.** See below.

### Why there is no `drawtext`

Many ffmpeg builds — including the one this project was developed against
(`ffmpeg 9.0.2` from Homebrew, configured without `--enable-libfreetype`) —
**do not have the `drawtext` filter**. Check with:

```bash
ffmpeg -filters | grep drawtext
```

Rather than depending on that filter and on system font paths (which differ
between macOS and Linux), all text is rendered by a **built-in 5x7 ASCII bitmap
font** in `fixtures/lib/bitmap-font.mjs`, drawn into a plain RGB buffer by
`fixtures/lib/raster.mjs`. The result is encoded to PNG by
`fixtures/lib/png.mjs` (also a hand-rolled encoder) and handed to ffmpeg as
image input. Consequences:

* identical pixels on every platform — the fixtures are byte-reproducible;
* no font files, no `fontconfig`, no `libfreetype`;
* the font is **uppercase-only**: lower-case input is rendered as upper case.
  Every ground-truth string is written in upper case so OCR output can be
  compared case-sensitively;
* a character the font does not have **throws** instead of silently rendering
  as `?`, so a typo cannot drift away from the ground truth.

System font paths were probed while developing this
(`/System/Library/Fonts/Supplemental/Arial.ttf` and `/System/Library/Fonts/Helvetica.ttc`
exist on macOS, `/usr/share/fonts/...` on most Linux distributions), but the
built-in font makes the whole question moot: **no font is required at all**, on
any platform, and no text has to be dropped.

## The assets and their ground truth

Ground truth lives in `fixtures/ground-truth/<id>.json`. The `id` matches the
file name of the asset (`sample-scene.mp4` → `sample-scene.json`).

### 1. `sample-scene.mp4` — hard cuts + a loudness jump

640x360, 24 fps, 12.000 s, H.264 video + AAC audio (44.1 kHz mono).

* Cuts at **2000 / 5000 / 9000 ms** — frame **48 / 120 / 216**. The background
  switches instantly between four solid colours (a hard cut, not a cross-fade)
  and the on-screen text changes with it.
* Each segment prints its name in white on a black panel
  (`SCENE ONE` … `SCENE FOUR`), so the text survives 4:2:0 chroma
  subsampling and stays OCR-able.
* The audio is a pure tone: **440 Hz at −23.0 dBFS for 0–6 s**, then
  **880 Hz at −6.1 dBFS for 6–12 s** — a ~17 dB loudness jump exactly at 6000 ms.

### 2. `sample-subtitles.mp4` + `sample-subtitles.srt`

640x360, 24 fps, 12.000 s. The same four subtitle lines are **burned into the
picture** (yellow on a black band) *and* shipped as a sidecar `.srt`, so both
the "embedded subtitle" and the "subtitle file" code paths can be tested
against one timeline.

| # | start | end | text |
| --- | --- | --- | --- |
| 1 | 00:00:00,500 | 00:00:03,000 | FIRST SUBTITLE LINE |
| 2 | 00:00:03,000 | 00:00:06,000 | SECOND SUBTITLE LINE |
| 3 | 00:00:06,000 | 00:00:09,000 | THIRD SUBTITLE LINE |
| 4 | 00:00:09,000 | 00:00:11,500 | FOURTH SUBTITLE LINE |

Before 500 ms and after 11 500 ms the subtitle band is empty.

### 3. `sample-zoom.mp4` — readable text at known pixels

640x360, 24 fps, 8.000 s, static card:

* an 8-swatch colour chart (each swatch's colour and pixel rectangle is in the
  ground truth);
* the number **42** in 8x scale inside a black band;
* the caption **CROP TARGET ALPHA** in 3x scale inside a black band.

The ground truth gives the **pixel bounding box of every text run** and two
ready-made crop rectangles (`crops[]`), so "crop this region and read it" can
be asserted without an OCR engine.

### 4. `sample-tone.wav` and `sample-speechless.mp3`

`sample-tone.wav`: 10.000 s, 44.1 kHz, **stereo**, 16-bit PCM.

* left channel: 440 Hz, amplitude 0.5 (RMS 0.354)
* right channel: 220 Hz, amplitude 0.25 (RMS 0.177)
* silence windows: 2000–3000 ms and 6000–6500 ms on **both** channels,
  7500–8000 ms on the **right** channel only

`sample-speechless.mp3`: the same signal encoded with `libmp3lame` at 128 kbit/s
(stereo). Duration reads as ≈10.03 s because of the MP3 encoder padding
(~26 ms); the ground truth records `durationToleranceMs: 120` and
`encoderDelayMs: 26`.

> **ASR ground truth is deliberately absent.** Speech recognition needs a TTS
> voice that is identical on macOS and Linux, and none is available
> cross-platform. Assert ASR with a **stub provider**, not against these
> files — `sample-speechless.mp3` contains tones only and no voice at all
> (`hasSpeech: false`).
>
> As an extra, macOS-only, **optional** asset the generator produces
> `sample-speech-optional.wav` from `say` when it is available. It is *not*
> committed and *not* asserted against (the voice and duration differ per
> machine); its ground truth is written only to `<out>/ground-truth/` and is
> marked `"optional": true`.

### 5. `sample-text.pdf` — text layer + tables

6 pages, A4 (595x842 pt), written by hand in `fixtures/lib/pdf.mjs`.

* every page carries unique lines; the ground truth maps **page number → text
  lines → exact text-matrix position (x/y in points)**;
* pages 5 and 6 contain **vector tables** (drawn lines + column-aligned text);
  the ground truth lists every cell's text and position plus the column/row
  coordinates;
* the PDF uses the base-14 fonts Helvetica / Helvetica-Bold, so `pdftotext`
  and any PDF text extractor can read it.

### 6. `sample-scanned.pdf` — image-only pages (the OCR case)

3 pages, A4. Each page is a 1240x1754 px (150 dpi) **JPEG** (`/DCTDecode`
XObject) that was rasterised in Node and encoded with ffmpeg's `mjpeg`
encoder.

* there is **no text layer**: the file contains no `/Font` resource and no
  `Tj` operator, which is exactly what makes it a "scanned document";
* the ground truth lists the text that is visible in each page image (and the
  pixel box of every line) so an OCR provider can be asserted against it.

### 7. `sample-image.png` — single-page image document

1240x1754 px, RGB PNG with a title, body lines and a rule line. The ground
truth lists every text line with its pixel bounding box. Used to exercise the
"image file" document backend.

## Ground-truth schema

```jsonc
{
  "id": "sample-scene",
  "kind": "video",              // video | audio | pdf | image
  "file": "sample-scene.mp4",
  "generator": "fixtures/generate.mjs",
  "durationMs": 12000,
  "cutsMs": [2000, 5000, 9000],
  "segments": [
    {
      "index": 0,
      "startMs": 0, "endMs": 2000,
      "startFrame": 0, "endFrame": 48,
      "text": "SCENE ONE",
      "bgColor": "#C81E1E", "bgColorRgb": [200, 30, 30],
      "textScale": 5,
      "textOrigin": { "x": 40, "y": 40 },
      "textPanel": { "x": 30, "y": 30, "width": 435, "height": 103 },
      "textBoxes": [{ "text": "SCENE ONE", "x": 40, "y": 40, "width": 265, "height": 35 }]
    }
  ],
  "audio": {
    "codec": "aac", "sampleRate": 44100, "channels": 1,
    "volumeJumpsMs": [6000],
    "segments": [
      { "toneHz": 440, "peakAmplitude": 0.1, "expectedMeanVolumeDb": -23.01 }
    ],
    "loudnessJumpDb": 16.9
  }
}
```

Every file follows the same idea: `id`, `kind`, `file`, then the fields that
matter for the asset (`durationMs`, `pageCount`, `cues`, `segments`, `lines`,
`tables`, `regions`, `crops`, …). Times are **milliseconds**, pixel geometry is
**pixels of the frame/image**, PDF geometry is **points**.

## How the test suite checks the truth

`test/fixtures.test.js` regenerates everything into a temp directory and then:

* compares every committed ground-truth file with the freshly generated one;
* re-runs the generator and asserts the bytes did not change (idempotency);
* `ffprobe`s each media file (duration, stream types, resolution, frame rate);
* extracts **individual frames by index** (`select=eq(n\,N)`) as raw RGB and
  compares the ink pattern with a reference rendering rebuilt from the ground
  truth — the burnt-in text is checked by mask intersection-over-union, and
  the scene cuts by the median frame colour on both sides of the boundary;
* measures the loudness jump with `ffmpeg -af volumedetect` on both sides of
  6 s;
* parses the WAV in pure Node and uses the Goertzel algorithm to prove the
  left channel carries 440 Hz and the right one 220 Hz, and that the silence
  windows are really silent;
* counts `/Type /Page` objects in both PDFs, extracts the text layer with a
  small content-stream parser and compares it (text **and** coordinates) with
  the ground truth, and asserts that `sample-scanned.pdf` contains **no**
  `/Font` resource;
* decodes `sample-image.png` with the hand-rolled PNG decoder and checks the
  ink inside every ground-truth text box.

## Platform notes

* **macOS and Linux behave identically.** No system font, no platform-specific
  binary. The only platform difference is the optional `say` asset described
  above.
* **MP3 encoder padding** makes `sample-speechless.mp3` about 31 ms longer
  than 10 s; use `durationToleranceMs` from the ground truth.
* **AAC encoding** shifts the measured mean volume by well under 0.2 dB; the
  test allows ±1.5 dB.
* `sample-scanned.pdf` depends on ffmpeg's `mjpeg` encoder. Without it the
  generator fails loudly — it never writes a half-finished fixture.
