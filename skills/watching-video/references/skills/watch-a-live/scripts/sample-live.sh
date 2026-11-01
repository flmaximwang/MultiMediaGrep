#!/usr/bin/env bash
# One sampling round of a live capture.
#
# Cuts the tail of a growing capture file into a segment, extracts keyframes from it,
# and prints the overview sheets for the agent to read with vision_analyze.
#
# usage: sample-live.sh <capture-file> <rounds-root> [window-seconds] [label]
#
#   capture-file   the file yt-dlp is writing (may be *.part while the stream runs)
#   rounds-root    directory to keep one subdir per round
#   window-seconds how much of the tail to sample (default 300 = 5 min)
#   label          round name (default: UTC HHMMSS)
set -euo pipefail

CAP="${1:?capture file required}"
OUT="${2:?rounds root required}"
WIN="${3:-300}"
LABEL="${4:-$(date -u +%H%M%S)}"

FFMPEG="${FFMPEG:-ffmpeg}"
# The extractor moved to the habit pack `info-from-videos` (2026-10-13) — point at whichever copy exists.
EXTRACT_DEFAULT="$HOME/.skills-manager/skills/info-from-videos/references/watch-a-video/scripts/extract_keyframes.py"
[ -f "$EXTRACT_DEFAULT" ] || EXTRACT_DEFAULT="$HOME/.hermes/skills/info-from-videos/references/watch-a-video/scripts/extract_keyframes.py"
EXTRACT="${EXTRACT_KEYFRAMES:-$EXTRACT_DEFAULT}"

[ -f "$EXTRACT" ] || { echo "extractor not found: $EXTRACT (set EXTRACT_KEYFRAMES)" >&2; exit 1; }

ROUND="$OUT/round-$LABEL"
mkdir -p "$ROUND"
SEG="$ROUND/segment.mp4"

# tail cut — a few seconds of slack so the segment is never empty
"$FFMPEG" -y -v error -sseof "-$((WIN + 5))" -i "$CAP" -c copy "$SEG" 2>/dev/null

# keyframes — uv supplies numpy/Pillow so no venv juggling.
# `env -u PYTHONPATH` is required: the agent runtime exports a PYTHONPATH pointing at a
# python3.14 site-packages, while uv's default interpreter is 3.11 — numpy's compiled
# extension then fails to load ("No module named 'numpy._core._multiarray_umath'").
env -u PYTHONPATH uv run --quiet --with numpy --with Pillow python3 "$EXTRACT" "$SEG" \
  -o "$ROUND/kf" --cols 3 --sheet-max-cells 12 --sheet-width 1600 --json > "$ROUND/meta.json"

# what the agent should read
python3 - "$ROUND" <<'PY'
import json, pathlib, sys
round_dir = pathlib.Path(sys.argv[1])
meta = json.loads((round_dir / "meta.json").read_text())
print(f"round   {round_dir.name}")
print(f"window  {meta['duration_text']}  keyframes={meta['keyframe_count']}  sheets={meta['overview_count']}")
for p in meta["overviews"]:
    print(p)
PY
