---
name: bilibili-reading
description: "Use when the user asks about Bilibili history or videos."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Bilibili, 哔哩哔哩, B站, Social Media, Watch History, CLI]
    related_skills: [reddit-reading, web-content-extraction, install-hermes-skills]
---

# Bilibili Reading Skill

Answers questions about Bilibili from the terminal: the logged-in account's **watch history
(观看历史)**, watch-later (稍后再看), favorites, following, dynamics, plus any BV/video lookup,
videos-by-UP, and site search for videos or users. Read-only by default — the same CLI can
like / coin / triple / post dynamics, which needs write-capable credentials and is never run
unasked. Sibling of `reddit-reading` (platform data, no browser).

## When to Use

- "查我的 B站观看历史", "找我看过的那条视频", "我最近看了什么", "我收藏/稍后再看里有什么".
- "这个 BV 号 / b23.tv 链接是什么视频"（要的是**内容总结/转写** → 新包 `info-from-videos`，不在这里）.
- "B站上搜一下 X", "这个 UP 主最近发了什么".
- Not for browser-side history (Chrome/Safari 浏览记录) — that is a different data source.

## Prerequisites

- **CLI**: `uv tool install bilibili-cli` → `~/.local/bin/bili` (Python ≥ 3.10). `~/.local/bin`
  is not always on the agent shell's PATH — export it in the same command that calls `bili`.
- **Hermes skill that documents the CLI**: hub-installed `web/bilibili-cli` (community source,
  CAUTION verdict → install needs `--force`):
  `hermes skills install "skills-sh/public-clis/bilibili-cli/bilibili-cli" --category web --force -y`.
  It is hub-managed, so maintain it with `hermes skills update bilibili-cli`, never by editing the copy.
- **Auth**: history / watch-later / favorites / following / feed / my-dynamics need a login.
  The CLI auto-extracts cookies from Chrome, Firefox, Edge or Brave (Safari is not supported),
  so on a machine where the user browses B站 logged-in there is usually **nothing to do** — check
  before you ask for anything.  **On this machine (2026-09-30, measured)** the Chrome-cookie auto-login already
  works — the live account is **Swcpk**, so `bili history -n 5 --yaml` runs with no setup; the size flag is
  `-n` / `--max`, **not** `--count`.

## Procedure

① **Check auth first, always**: `bili status` → prints `authenticated: true` and exits 0 when a
credential is live (exit 1 = not logged in). Only if it says unauthenticated do you log in — and on an
unattended shell do **not** just run `bili login`: it draws its QR in the terminal (nobody there to
scan) and may even store an **empty `sessdata`** after a successful scan. The unattended recipe
(QR → PNG + verifying the credential) lives in the habit pack `info-from-videos` →
`references/bilibili-login.md`.

② **Cheap reads → `--yaml`** (token-efficient, agent-readable): `bili history -n 5 --yaml`,
`bili watch-later --yaml`, `bili favorites [ID] --yaml`, `bili following --yaml`, `bili feed --yaml`,
`bili my-dynamics --yaml`, `bili video BV1… --yaml`, `bili search "关键词" --type video --max 5`,
`bili user <uid>`, `bili user-videos <uid>`.

③ **Anything you must aggregate → `--json` into a file, then parse in Python.** Never eyeball a
long listing, and never truncate one inline: redirect the full output to a file and page it back
with `read_file`. A truncated view of a long run reads like success even when the run was cut short.

④ **"Find the video I watched about X" is a paged search, not a single call**: pull history
100 per page into files, merge, filter, then confirm. `scripts/find-in-history.py <keywords…>`
does exactly this (`--pages`, `--per-page`, `--all` for AND instead of OR). It prints the scanned
count and the covered `viewed_at` range so you can tell the user how far back you actually looked.

⑤ **Confirm the candidate before presenting it**: `bili video <BV> --yaml` and read `description`.
Report the winner as one line — `title` / `author` / `viewed_at` / duration / BV URL — and mention a
second candidate in one clause only when the cluster is genuinely ambiguous (结论先行; do not open
with a menu of candidates).

### Video content analysis has moved out (2026-10-13)

「把一条视频看懂 / 转写 / 总结」不归本 skill：字幕 → 抽关键帧 → 读图那套流水线，以及无字幕时的本地
ASR 路线，现在住在 habit 包 `InformationCollection` 的 L1 `info-from-videos`
（装好后在本机 `~/.hermes/skills/info-from-videos/`，岛内入口
`references/watch-a-video/SKILL.md` 与 `references/video-transcript-summarization/SKILL.md`）。
关键帧脚本随它一起搬走：
`~/.hermes/skills/info-from-videos/references/watch-a-video/scripts/extract_keyframes.py`
（跑法 `env -u PYTHONPATH uv run --quiet --with numpy --with Pillow python3 <脚本>`，ffmpeg 前置
`$HOME/.hermes/tools/ffmpeg-9.0.1-darwin-arm64`）。本 skill 只管账号侧数据与 BV → 视频详情。

## Quick Reference

| Need | Command | Login |
|---|---|---|
| Login state | `bili status` | — |
| 观看历史 | `bili history [-p N] [-n 1..100] [--yaml\|--json]` | ✔ |
| 稍后再看 / 收藏 / 关注 / 动态 | `bili watch-later` / `favorites [ID]` / `following` / `feed` / `my-dynamics` | ✔ |
| Video detail + description | `bili video BV1… --yaml` | — |
| Search videos / users | `bili search "q" --type video\|user --max N [--page P]` | — |
| UP 资料 / 投稿列表 | `bili user <uid>` / `bili user-videos <uid>` | — |
| Trending / rank | `bili hot` / `bili rank [--day N]` | — |

## Pitfalls

- **The size flag is `-n` / `--max` (1–100), not `--count`.** `--count` fails with
  `No such option '--count'. Did you mean '--json'?`. Paging is `-p` / `--page` (≥ 1).
- **History pages are time windows, not a backlog cursor.** 100 items/page covered only ~11 days on
  an active account (8 pages ≈ 800 items). When the target is older than the pages you pulled, raise
  `--pages`, then report the real covered range instead of implying you searched everything.
- **A title cannot identify a video described abstractly.** "优化大型代码工程的插件" matched both a
  59-second plugin promo and a 13-minute repo walkthrough. Filter on title **and** author, include the
  ecosystem's own acronym for the thing described (DeepSeek Harness shows up as **DSH**), then settle
  the choice by reading `description`.
- **`subtitle.available: false` 多半只是「没登录」，不是这个视频真没字幕**：先看 `bili status` 报不报出
  用户名（登录做法与新坑见新包 `info-from-videos` 的 `references/bilibili-login.md` —— 非交互环境里
  `bili login` 会存下**空的 `sessdata`**）。真要取内容、且登录后确实无字幕，才退到 `description` /
  `bili audio BV…`（ASR 用的 WAV）—— 不要声称总结是从不存在的字幕来的。
- **Don't search B站 when the user means their own history**, and vice versa: `bili search` covers the
  whole site, `bili history` only the account. Picking the wrong one wastes the whole turn.
- **macOS keychain popup on every command**: bilibili-cli's `auth.py` has `CREDENTIAL_TTL_DAYS=7` — when the saved credential is older than 7 days, it attempts to refresh from the browser, which triggers a macOS Keychain authorization prompt on every single command. Fix: edit the installed `auth.py` (under `~/.local/share/uv/tools/bilibili-cli/lib/python3.11/site-packages/bili_cli/auth.py`) and change `CREDENTIAL_TTL_DAYS = 7` to `CREDENTIAL_TTL_DAYS = 9999`. This skips the browser refresh entirely. If the credential truly expires, the CLI will fall back to browser extraction (popup returns) — run `bili login` to refresh. **The patch lives in the installed package, so `uv tool upgrade bilibili-cli` reverts it** — after any upgrade, re-check `CREDENTIAL_TTL_DAYS` before assuming the popup is gone for good.
- **Read-only unless asked**: like / coin / triple / unfollow / dynamic-post / dynamic-delete act on the
  user's real account and need write-capable credentials. Never run them to "test" the CLI.
- **抽关键帧的参数（`--cols 3 --sheet-max-cells 12 --sheet-width 1600`）与读图的坑不再写在这里** ——
  它们跟着脚本搬进了新包 `info-from-videos` 的 `watch-a-video` 岛（同一件事写两处必然漂移）。
- **Installing a skill you just wrote: push it to GitHub, then install by `owner/repo/path`.** `hermes skills install` accepts only hub identifiers and URLs — a local directory is not a supported identifier shape and fails with `Could not download '<path>'` (a `file://` URL fails the same way). Do **not** fall back to `cp -r` into `<HERMES_HOME>/skills/`: a hand-copied directory has **no lock entry**, so `hermes skills check` / `update` / `uninstall` never see it again and it can never be maintained. The route is `gh repo create <owner>/<repo>` → `git push` → `hermes skills install "<owner>/<repo>/skills/<name>" --category <cat> -y`. Load `install-hermes-skills` first instead of improvising — it owns the identifier grammar and the scan gate.
- The watch history is the user's own data; quote only what answers the question (a match's title,
  author, time, BV) rather than dumping the whole listing into a chat.

## Verification

```bash
export PATH="$HOME/.local/bin:$PATH"
bili status                 # authenticated: true, exit 0
bili history -n 5 --yaml    # data.items[*].{bvid,title,author,viewed_at}
```

`scripts/find-in-history.py --help` prints its argument defaults; a run with no match exits 0 and
prints `0 match(es)` plus the scanned range, so an empty result is distinguishable from a failed one.
