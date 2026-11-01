---
name: download-from-anywhere
description: "Fallback general-purpose download workflow — use ONLY when no site-specific download skill (model-download, gif-search, etc.) matches. Covers tool selection (aria2c/curl), proxy policy, background execution with logs, and long-download cron monitoring with auto-resume."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [download, aria2c, curl, cron]
    related_skills: []
---

# File Download Workflow

## Overview

A structured workflow for downloading files from the terminal: choose the right tool, respect the proxy policy, run in the background with logs, and automatically monitor long downloads with cron-based progress checks and auto-resume.

## When to Use

**⚠️ This is a FALLBACK workflow.** Before using this skill, check if a site-specific download skill exists (e.g. `model-download` for HuggingFace models, `gif-search` for Tenor GIFs) and prefer that one.

Use this general-purpose workflow when:
- The file source has no specialized download skill
- User says "下载 [URL]" / "帮我下载" / "download this file" and the source isn't covered by another skill
- You need to fetch any binary, installer, dataset, or large file from a generic URL
- File is large enough (> 100 MB) that it might take minutes to hours
- User shares a direct URL that they want saved locally

**Don't use for:** one-shot trivial `curl | sh` install scripts (run inline in fast foreground).

## Foreground vs Background
- **Foreground**: Only for very small files (< 100 MB) that download in seconds.
- **Background**: For anything larger than 100 MB or expected to take more than a few seconds.

## Tool Selection

- First Priority: `aria2c` — multi-threaded, supports auto-resume, robust for large files
  - Foreground: `aria2c --max-concurrent-downloads=1` for small files
  - Background: `aria2c --background=true` for large files
- Second Priority: `curl -C -` — fallback when aria2c unavailable, `
  - Foreground: `curl -L -o <file> <url>` for small files
  - Background: `nohup curl -L -o <file> <url> > <log> 2>&1 &` for large files with auto-resume

## Proxy Policy
Export proxies before downloading

```bash
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=socks5://127.0.0.1:7890
```

## Foreground Execution
For small files, run in foreground and show progress:
**aria2c foreground**
```bash
aria2c --max-concurrent-downloads=1 --dir=~/Downloads/ --out="$FILENAME" "$URL"
```

**curl foreground**
```bash
curl -L -o ~/Downloads/"$FILENAME" "$URL"
```

## Background Execution & Logging
All non-trivial downloads run in the background and log output:

```
~/Downloads/download_logs/
├── <filename-1>.log
├── <filename-2>.log
└── ...
```

**curl download**
```bash
mkdir -p ~/Downloads/download_logs/
nohup curl -L -o ~/Downloads/"$FILENAME" "$URL" > ~/Downloads/download_logs/"$FILENAME".log 2>&1 &

echo "PID: $!"
```

**aria2c download**
```bash
mkdir -p ~/Downloads/download_logs/
aria2c --background=true --dir=~/Downloads/ --out="$FILENAME" --log-level=notice --log=~/Downloads/download_logs/"$FILENAME".log "$URL"

echo "PID: $!"
```

Then **respond immediately** to the user with a status table — do not wait for the download to finish.

### 3. Check progress

aria2c writes lines like `[#gid X.XGiB/Y.YGiB(ZZ%) CN:N DL:SPEED ETA:...]` to stderr, which hfd.sh redirects into the log file:

```bash
tail -20 $TARGET_DIR/dl_<MARKER>.log
```

Progress line format: `[#69c7f1 3.1GiB/20GiB(15%) CN:4 DL:859KiB ETA:5h58m53s]`

| Token | Meaning |
|-------|---------|
| `X.XGiB/Y.YGiB(ZZ%)` | Downloaded / Total (percent) |
| `CN:N` | Number of connections |
| `DL:SPEED` | Current download speed |
| `ETA:TIME` | Estimated time remaining |

- If `DL:0B` persists for several minutes and `CN:0`, it's stalled. Kill and restart:
- If `(ERR)` was observed in the final lines, it's stalled. Kill and restart.

```bash
pkill -f "hfd.*<REPO_ID>" 2>/dev/null
pkill -f "aria2c.*<REPO_ID>" 2>/dev/null
sleep 2

export HF_ENDPOINT=https://hf-mirror.com
$SCRIPT <REPO_ID> --include <MODEL_FILE> --local-dir $TARGET_DIR \
  >> $TARGET_DIR/dl_<MARKER>.log 2>&1 &
```

### 4. Cron monitoring (for downloads > 500 MB, REQUIRED)

Set up **immediately** after launching.

| File size | Cron interval |
|-----------|---------------|
| 500 MB – 5 GB | 1 minute |
| 5 – 20 GB | 3 minutes |
| 20+ GB | every 10 minutes |

Use the agent's cronjob tool (`schedule` must include `every` for recurring):

```json
{
  "action": "create",
  "name": "<Family>-download-monitor",
  "schedule": "every <INTERVAL>",
  "prompt": "Check download progress of <MODEL_FILE> at $TARGET_DIR/.\\nRead the last 20 lines of $TARGET_DIR/dl_<MARKER>.log with tail -20.\\nCheck if aria2c process is running.\\nReport current progress, speed, ETA.\\nIf DL:0B for extended time, suggest restart.\\nDeliver result back to origin.",
  "enabled_toolsets": ["terminal"]
}
```

## Checking Completeness
- To verify if the download is complete, check log files first for completion messages:
  - For aria2c, look for "Download complete" or check the GID status.
  - For curl, check if the log shows "100%" or if the process has exited.
- Then, try to find a hash from the source (e.g. MD5/SHA256), 
  - If hash is provided, compute the hash of the downloaded file and compare.
  - If no hash is provided, try to find the expected file size from the source
    - If file size is known, compare it to the size of the downloaded file.
    - If file size is unknown, inform the user that completeness cannot be verified without a hash or expected size.

## Common Pitfalls

1. **Proxy for HuggingFace: not black-and-white.** The proxy policy table above is authoritative — direct first (fastest for data), but retry with proxy if SSL fails (~1.5 MB/s on some CDN endpoints). Don't dogmatically "always direct" or "always proxy"; test each session's speed first.

2. **Forgetting `-C -` on curl fallback.** Without it, a resume attempt re-downloads from scratch. Always include `-C -` for curl.

3. **Waiting for the download to finish before replying to the user.** Launch in background and immediately give the user a status table. They expect async for anything over a few seconds.

4. **Not checking if aria2c is installed.** Always check first (`which aria2c` or `brew list aria2`). If missing, install with `brew install aria2` in background or fall back to `curl -C -`.

5. **Running download in foreground with a short timeout.** Long downloads need `background=true` + `notify_on_complete=true` or cron monitoring. Foreground with timeout=180 will be killed prematurely.

6. **Skipping log directory.** Without logs, you can't check progress or debug failures. Always redirect to `~/Downloads/download_logs/`.

## Verification Checklist

- [ ] Tool selected: aria2c preferred, curl fallback with `-C -`
- [ ] Correct proxy policy applied (direct first, retry with proxy if SSL fails)
- [ ] File saved to `~/Downloads/` unless user specified otherwise
- [ ] Background mode with log redirect to `~/Downloads/download_logs/<file>.log`
- [ ] Immediate response with status table (file, tool, PID, progress URL if any)
- [ ] For large files: cron monitoring set up (30-min interval)
- [ ] Completeness verified (hash or expected size)