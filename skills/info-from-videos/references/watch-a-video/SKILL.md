---
name: watch-a-video
description: "Use when 一条视频要看懂/总结/找里面某一刻的画面 — B站（BV 号 / URL）、YouTube、或本地视频/GIF 文件：取元信息与字幕、抽关键帧、再用 vision 读图。有 CC 字幕时先走字幕（最省），要画面才抽帧。不属于：没有字幕的纯音频转写 → video-transcript-summarization；直播 / 录屏 → watch-a-live。"
version: 2.1.0
author: Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [video, youtube, bilibili, keyframe, vision, subtitle]
    related_skills: [info-from-videos, video-transcript-summarization, bilibili-reading]
---

# Watch a Video

把一条视频「看」完的流水线：元信息 → 字幕 → （要画面才）下载 → 抽关键帧 → 读图。

## When to Use

- 「总结这条视频」/「这个视频讲了什么」/「看这个视频」/「帮我看看 BVxxx」
- B站（BV 号 / URL）、YouTube（watch / youtu.be / shorts）、本地 `.mp4`/`.mov`/`.mkv`/`.gif`
- 要**画面里的东西**：图上的点位、手绘框、表格数字、演示画面
- 不是：只想转写文字（→ `video-transcript-summarization`）、盯直播（→ `watch-a-live`）

## 三种来源

| 来源 | 元信息 | 字幕 | 下载 |
|---|---|---|---|
| **B站**（BV / URL） | `bili video BVxxx --yaml` | `bili video BVxxx --subtitle`（**要登录**） | `yt-dlp` |
| **YouTube**（URL） | `yt-dlp -J <url>` | `yt-dlp --write-auto-subs` | `yt-dlp` |
| **本地文件** | —（跳过） | 同目录的 `.srt`/`.vtt` | —（跳过） |

三条路在第 4 步汇合，之后与来源无关。

## 前置

- **B站要登录态**：匿名 `subtitle.available: false` 是常态，登录后才有 CC 字幕。
  登录判据与扫码脚本 → `~/.hermes/skills/info-from-videos/references/bilibili-login.md`
  （`bili status` 报出用户名 + 凭证里 `sessdata` 非空，两条都要）。
- **yt-dlp**：`~/.local/bin/yt-dlp`
- **ffmpeg**：`$HOME/.hermes/tools/ffmpeg-9.0.1-darwin-arm64`（不在默认 PATH 上，要前置）
- **Python 依赖**：`numpy` + `Pillow`，用 `env -u PYTHONPATH uv run --with numpy --with Pillow python3` 现给，别找解释器
- **YouTube**：JS 运行时 `yt-dlp --js-runtimes node`（本机 `~/.local/bin/node`；没有它格式列表不全）

## 流水线

### Step 1 — 元信息

```bash
# B站
bili video BVxxx --yaml                  # title / author / duration / description / subtitle.available

# YouTube
yt-dlp --js-runtimes node -J "https://www.youtube.com/watch?v=XXXX" \
  | jq '{title, uploader, duration, description, subtitles: (.subtitles|keys), auto: (.automatic_captions|keys)}'

# 本地文件
ffprobe -v error -show_entries format=duration,size -of default=nw=1 <file>
```

### Step 2 — 字幕（最省的一条腿，优先）

```bash
bili video BVxxx --subtitle                  # B站：登录后可用；纯文本，不用解析
bili video BVxxx --subtitle-timeline --yaml  # 要「第几秒说了什么」时用这个

yt-dlp --js-runtimes node --skip-download --write-auto-subs --sub-langs "en.*" \
  --sub-format vtt -o "/tmp/video-watch/v.%(ext)s" "<url>"     # YouTube → v.en.vtt

ls /path/to/*.srt /path/to/*.vtt             # 本地文件：有同名字幕就直接读
```

**字幕能回答问题就停在这里**，不要为了「完整」去下载视频。

### Step 3 — 下载（只在需要画面时）

```bash
mkdir -p /tmp/video-watch
yt-dlp --js-runtimes node --no-playlist -o "/tmp/video-watch/video.mp4" "<url>"
```

- `--no-playlist`：别把一整季下载下来。
- 一律下到 `/tmp/`，不污染工作区。
- 格式选择失败时去掉 `-f`，让 yt-dlp 自己挑。

### Step 4 — 抽关键帧

```bash
export PATH="$HOME/.hermes/tools/ffmpeg-9.0.1-darwin-arm64:$PATH"
env -u PYTHONPATH uv run --quiet --with numpy --with Pillow python3 scripts/extract_keyframes.py \
  /tmp/video-watch/video.mp4 \
  -o /tmp/video-watch/out \
  --cols 3 --sheet-max-cells 12 --sheet-width 1600 \
  --json
```

**三个参数不是可选项**（默认值面向人眼，对 vision 编码器太大）：
`--cols 3`、`--sheet-max-cells 12`、`--sheet-width 1600`（默认 `--sheet-width 9600` 会被 vision 拒收）。

产物：

```
/tmp/video-watch/out/
├── overview_01.jpg   ← 总览图（按时间顺序；帧多时自动分成多张）
├── frames/kf_001_0.000s.jpg   ← 单帧全分辨率图（读细节用这个）
└── keyframes.json    ← 尺寸/时长/帧率/帧数；keyframes[].{n,time,path,diff}
```

### Step 5 — 读图

先按顺序读**每一张**总览图，建立时间轴（哪一刻在讲什么）；要读图上的**细节**（点位、手绘框、
表格数字）就回到 `frames/` 挑那一帧裁开读：

```
vision_analyze(image_url="/tmp/video-watch/out/overview_01.jpg", question="这张关键帧总览图里，各格分别在讲什么？")
vision_analyze(image_url="/tmp/video-watch/out/frames/kf_012_183.500s.jpg", question="裁出右侧价格轴与手绘框，读出刻度与框的范围")
```

- 每格下方的 `#序号 时间戳` 就是 `frames/` 的文件名与 `ffmpeg -ss` 的值。
- 缺帧的画面（PPT 翻页少）不代表抽帧失败 —— 只保留「画面真的变了」的帧是这个脚本的定义。

## 关键帧工具

`scripts/extract_keyframes.py` 来自 [ztough926/video-understanding](https://github.com/ztough926/video-understanding)（GPL-3.0）。
逐帧比像素差，只保留画面真的变了的帧：阈值 = 中位差 × 灵敏度，夹在 [0.008, 0.08]。纯图像算法，不调模型。
典型：3 分钟视频（5000+ 帧）→ 50–100 关键帧 → 4–8 张总览图。

## 速查

| 要什么 | 命令 |
|---|---|
| B站元信息 | `bili video BVxxx --yaml` |
| B站字幕（需登录） | `bili video BVxxx --subtitle` |
| B站评论 | `bili video BVxxx --comments` |
| YouTube 元信息 | `yt-dlp --js-runtimes node -J <url> \| jq '{title,uploader,duration}'` |
| YouTube 字幕 | `yt-dlp --js-runtimes node --write-auto-subs --sub-langs "en.*" --sub-format vtt <url>` |
| 下载 | `yt-dlp --js-runtimes node --no-playlist -o /tmp/video-watch/video.mp4 <url>` |
| 抽关键帧 | `env -u PYTHONPATH uv run --quiet --with numpy --with Pillow python3 scripts/extract_keyframes.py <file> -o <out> --cols 3 --sheet-max-cells 12 --sheet-width 1600 --json` |
| 出单帧全分辨率图 | `ffmpeg -y -v error -ss <t> -i video.mp4 -frames:v 1 /tmp/f.png` |
| 读图 | `vision_analyze(image_url=…)` |

## 坑（规则 + 机制）

- **总览图只用来定位，读细节必须回单帧。** 一张 12 格的 1600px 总览图丢给 `vision_analyze`
  实测**会超时**（2026-10-13，A股行情截图那轮反复触发），侥幸返回时细节也是糊的 ——
  图上文字与手绘框只有全分辨率单帧才读得准。做法：从 `frames/` 挑帧，或用
  `ffmpeg -y -v error -ss <t> -i video.mp4 -frames:v 1 f.png` 现出，需要放大就再加
  `-vf "crop=w:h:x:y,scale=iw*2:ih*2:flags=lanczos"`，然后**一帧一问**。
- **解析字幕 YAML 不要用嵌套量词正则。** `-st --yaml` 的正文是几千字一块，`(.+?)+` 这类写法
  实测当场回溯炸掉；逐行处理：切 `text:` 到 `\n  comments:` 之间 → 每行 strip → 去首尾单引号 → 拼全文。
  纯文本直接用 `--subtitle`，根本不用解析。
- **一定要带 `--cols 3 --sheet-max-cells 12 --sheet-width 1600`**：默认 `--sheet-width 9600`
  产出的图 vision 编码器直接拒。
- **总览图要全部读完**，不是只读第一张（帧多时脚本会分成多张）。
- **B站 CC 字幕要登录**：匿名时 `subtitle.available: false` 是常见情形 —— 不要据此说
  「这个视频没有字幕」，先按 `~/.hermes/skills/info-from-videos/references/bilibili-login.md` 确认登录态。登录后仍为 false
  才是真没有，转 `video-transcript-summarization` 走 ASR。
- **YouTube 要有 JS 运行时**：本机没有 deno，`--js-runtimes node` 不能省。
- **依赖与解释器**：本机 `python3` 没有 numpy/Pillow，`~/.hermes/tools/python-*` 也没有。
  用 `env -u PYTHONPATH uv run --with numpy --with Pillow python3 <脚本>` 现给依赖。
  **`env -u PYTHONPATH` 不是可省的**：运行时导出的 `PYTHONPATH` 指向 python3.14 的 site-packages，
  而 uv 默认用 3.11，numpy 的扩展加载失败并报 `No module named 'numpy._core._multiarray_umath'`
  （报错怪 numpy，引你去修一个本来没坏的安装）。
- **ffmpeg 不在默认 PATH 上**，每次前置 `$HOME/.hermes/tools/ffmpeg-9.0.1-darwin-arm64`。

## 完整例子

```bash
export PATH="$HOME/.local/bin:$HOME/.hermes/tools/ffmpeg-9.0.1-darwin-arm64:$PATH"
SKILL=~/.hermes/skills/info-from-videos/references/watch-a-video   # 装好后就在这儿

# --- B站（需登录）---
bili video BV1bban6dE4C --yaml                    # 1. 元信息 + subtitle.available
bili video BV1bban6dE4C --subtitle                # 2. 有字幕 → 直接拿全文；没有 → 走 ASR
mkdir -p /tmp/video-watch
yt-dlp --no-playlist -o "/tmp/video-watch/video.mp4" "https://www.bilibili.com/video/BV1bban6dE4C"   # 3.
env -u PYTHONPATH uv run --quiet --with numpy --with Pillow python3 "$SKILL/scripts/extract_keyframes.py" \
  /tmp/video-watch/video.mp4 -o /tmp/video-watch/out --cols 3 --sheet-max-cells 12 --sheet-width 1600 --json  # 4.
# 5. vision_analyze 读 overview_*.jpg，细节回 frames/

# --- YouTube ---
yt-dlp --js-runtimes node --write-auto-subs --sub-langs "en.*" --sub-format vtt \
  -o "/tmp/video-watch/yt.%(ext)s" "<youtube-url>"   # 先字幕，再决定要不要下载
```
