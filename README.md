# MultiMediaGrep

**给 agent 的本地媒体感知工具（MCP server）。**

把**本地已有**的视频 / 录音 / 文档，变成 agent 能直接消化的材料：可直接看的图（分镜宫格、特写裁切）
＋ 按时间/页码对齐的文本清单。server 自己不调 LLM——理解由 agent 的多模态模型完成。

---

## 这是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 一个 **stdio MCP server**，只吃**本地绝对路径** | 不下载、不检索、不登录、不碰 cookie / 凭据（取数属于 IntelligenceAtlas） |
| 只做「材料化」：出图 + 出带时间码/页码的文本清单 | 不调 LLM：不做总结、不做问答、不做转述 |
| ASR 与文档解析/OCR 走**你自己配**的外部服务与 key | 不内置本地 ASR / OCR 模型（mlx-whisper、rapidocr 都不再维护） |
| 缓存只写自己的缓存目录 | **绝不在你的文件旁边写任何东西** |

失败也是明说的：没配 ASR 就只给画面，扫描件没配 OCR 就只给页图，并在结果里写清楚原因——
**宁可说「没有文字」，也不编一段台词。**

## 工具（5 个，按动作命名，跨媒体复用）

| 工具 | 干什么 |
|---|---|
| `media_probe` | 探媒体：时长/分辨率/页数/编码、可用轨道、能否做 ASR/OCR |
| `media_overview` | 总览：视频出分镜宫格图，录音出带时间轴转写，文档出页面图 + 每页文本；**额外返回全文落盘路径** |
| `media_zoom` | 特写：取指定时间点/区间的单帧或文档某页，可裁切放大，用于读字 |
| `media_locate` | 定位：给一句文本/关键词，返回它在视频/录音里的时间戳、在文档里的页码 |
| `video_subtitles` | 字幕：读本地 srt/vtt/ass 或视频内嵌字幕轨，解析成带时间轴的段落 |

用法指引（先 probe → 再 overview → 只 zoom 重要部分 → 长素材先收窄范围）写在工具描述与 server instructions 里。

---

## 环境要求

| 依赖 | 必需性 | 缺了会怎样 |
|---|---|---|
| **Node.js ≥ 20**（ESM，零构建步骤） | 必需 | 起不来 |
| **ffmpeg + ffprobe**（同一个发行版里通常一起装） | 视频 / 录音 / 文档**都需要** | 返回 `TOOL_NOT_FOUND: ffprobe is required but was not found on PATH…`；视频/录音连 `media_probe` 都跑不了，文档的 `media_probe` 还能用但出不了页图 |
| **poppler**（`pdftoppm` / `pdftotext` / `pdfinfo`）**或** `mutool`（mupdf-tools）**或** `gs`（ghostscript） | 只有读 **PDF** 时需要 | PDF 相关调用返回 `TOOL_NOT_FOUND`，提示装 `poppler-utils` / `mupdf-tools` / `ghostscript`；纯视频 / 录音不受影响 |

安装示例：

```bash
# macOS
brew install ffmpeg poppler        # 文档需要 poppler；只要视频可省略 poppler

# Debian / Ubuntu
sudo apt install ffmpeg poppler-utils

# Windows（winget）
winget install Gyan.FFmpeg          # PDF 另装 poppler（无官方 winget 包时用 scoop install poppler）
```

可选：把可执行文件放在 `PATH` 之外时，用 `MMGREP_FFMPEG_PATH` / `MMGREP_FFPROBE_PATH` 指定绝对路径。

**外部服务（可选）**：ASR（ElevenLabs 或任何 OpenAI `/audio/transcriptions` 兼容服务）与文档解析（MinerU）
由你用环境变量配置；**不配也能用**，只是拿不到文字层（详见下面「环境变量」）。

---

## 安装与运行

```bash
# 1) 免安装（发布到 npm 之后）
npx -y multimediagrep-mcp
```

> `npx -y multimediagrep-mcp` 会拉起 server 并**阻塞等待 stdio 上的 MCP 消息**——它没有交互界面，
> 通常由 MCP client 自动拉起。想确认它起没起得来，就手动跑一次，看 stderr 有没有启动横幅：
>
> ```
> [mmgrep] info: multimediagrep@0.1.0 ready on stdio
> [mmgrep] info: cache: /Users/you/.cache/multimediagrep (max 10737418240 bytes)
> [mmgrep] info: asr: none (no API key) · doc: none · ocr: none
> [mmgrep] info: backends: video=ready audio=ready document=ready
> [mmgrep] info: image budget: 4000 tokens/call, maxEdge 1600px
> ```

```bash
# 2) 从 checkout 直接跑
git clone <仓库地址> && cd MultiMediaGrep
npm install
node src/index.js
```

**只有 stdio 传输。** 没有 HTTP / SSE 端点，也没有 `--port` 之类的开关——它被谁拉起、怎么拉起，
由 MCP client 决定。

---

## 接入宿主

### Claude Code

```bash
# 用户级（所有项目可用）
claude mcp add --scope user multimediagrep \
  -e MMGREP_ASR_PROVIDER=elevenlabs \
  -e MMGREP_ASR_API_KEY=sk-你的key \
  -- npx -y multimediagrep-mcp

# 项目级（写进项目里的 .mcp.json，随仓库走）
claude mcp add --scope project multimediagrep -- npx -y multimediagrep-mcp
```

`.mcp.json` 片段（`claude mcp add --scope project` 生成的就是这个形状）：

```json
{
  "mcpServers": {
    "multimediagrep": {
      "command": "npx",
      "args": ["-y", "multimediagrep-mcp"],
      "env": {
        "MMGREP_ASR_PROVIDER": "elevenlabs",
        "MMGREP_ASR_API_KEY": "sk-替换成你的key",
        "MMGREP_DOC_PROVIDER": "mineru",
        "MMGREP_DOC_API_KEY": "替换成你的token"
      }
    }
  }
}
```

### Hermes

Hermes 用同名的 `hermes mcp add` 流程（stdio server）：

```bash
hermes mcp add multimediagrep \
  --command npx \
  --env MMGREP_ASR_PROVIDER=elevenlabs MMGREP_ASR_API_KEY=sk-你的key \
  --args -y multimediagrep-mcp
```

它会先连一次、列出工具让你勾选，然后写进 `~/.hermes/config.yaml` 的 `mcp_servers:`。
加完用 `hermes mcp test multimediagrep` 验连通，用 `/reload-mcp` 让**已经开着**的会话也加载上。

> `--args` 之后的参数原样透传给命令，所以 `--args` 必须放在最后。

### 其它 MCP client

任何吃标准 MCP client 配置的宿主都用同一段 JSON（键名通常是 `mcpServers`）：
可复制的一份见 [`examples/mcp-config.json`](examples/mcp-config.json)，
各宿主的完整写法见 [`docs/install.md`](docs/install.md) §2。

---

## 环境变量

全部前缀 `MMGREP_`，用 `env | grep MMGREP_` 查看当前值。**key 只写在你自己的配置文件里，
server 不会打印它**（日志与错误里只出现 `set` / `unset`）。

| 变量 | 默认值 | 作用 |
|---|---|---|
| `MMGREP_CACHE_DIR` | `~/.cache/multimediagrep` | 缓存根目录（抽帧、页图、转写、全文落盘都在这）。`~` 会展开；相对路径按 cwd 解析 |
| `MMGREP_CACHE_MAX_BYTES` | `10737418240`（10 GiB） | 缓存上限，支持 `512MB` / `10GB` / 纯字节数；超出按 LRU 淘汰 |
| `MMGREP_ASR_PROVIDER` | `none` | ASR 后端：`none`（不转写）/ `elevenlabs` / `openai-compatible` |
| `MMGREP_ASR_API_KEY` | 空 | ASR 的 API key。选了 provider 就**必填**——自建本地服务也要给一个非空值（可以随便写，如 `local`） |
| `MMGREP_ASR_BASE_URL` | `https://api.elevenlabs.io/v1` | ASR 的 API 基址。**默认值与 provider 无关**——用 `openai-compatible` 时必须显式改成你的服务地址 |
| `MMGREP_ASR_MODEL` | `scribe_v1` | ASR 模型名。**默认值与 provider 无关**——用 `openai-compatible` 时必须显式改成 `whisper-1` 之类，否则会把 `scribe_v1` 发给 OpenAI 兼容服务 |
| `MMGREP_ASR_LANGUAGE` | `auto` | 强制语言（BCP-47，如 `zh` / `en`）；`auto` = 让服务自己判断 |
| `MMGREP_ASR_TIMEOUT_MS` | `120000` | ASR 单次请求超时 |
| `MMGREP_DOC_PROVIDER` | `none` | 文档解析后端：`none`（只出页图）/ `mineru` |
| `MMGREP_DOC_API_KEY` | 空 | 文档解析服务的 token（MinerU：<https://mineru.net/apiManage/token>） |
| `MMGREP_DOC_BASE_URL` | `https://mineru.net/api/v4` | 文档解析的 API 基址 |
| `MMGREP_DOC_MODEL` | 空 | 解析模型名；留空 = 用服务端默认（MinerU 可选 `pipeline` / `vlm` / `MinerU-HTML`） |
| `MMGREP_DOC_TIMEOUT_MS` | `180000` | 文档解析单次请求超时（3 分钟）。MinerU 是「上传 → 排队 → 解析 → 下载」整段墙钟时间，排队久就调大 |
| `MMGREP_OCR_PROVIDER` | `none` | 预留给独立的本地 OCR 通道（契约 §12.4）。**当前版本未实现**：OCR 由文档解析 provider（MinerU）承担，这个变量只出现在启动横幅，不影响任何工具行为 |
| `MMGREP_MAX_IMAGE_TOKENS` | `4000` | 单次调用的图片 token **软预算**。超了自动模式会降形，显式模式只警告 |
| `MMGREP_MAX_IMAGE_EDGE` | `1600` | 单张图最长边的全局上限（px）。请求超过 → `BUDGET_EXCEEDED` |
| `MMGREP_LOG_LEVEL` | `info` | 日志级别：`error` / `warn` / `info` / `debug`。日志**一律走 stderr**（stdout 是协议通道） |

另有 `MMGREP_FFMPEG_PATH` / `MMGREP_FFPROBE_PATH`（默认按 `PATH` 查找）、
`MMGREP_MAX_TEXT_INLINE_CHARS`（默认 24000）、`MMGREP_MAX_CONCURRENCY`（默认 2）等，
完整清单见 [`docs/mcp-contract.md` §12](docs/mcp-contract.md)。

---

## 第一次跑一遍

假设有一个本地视频 `/abs/path/demo.mp4`：

**1. 探（不花图片 token，几毫秒返回）**

```json
{ "path": "/abs/path/demo.mp4" }
```

返回里看四件事：媒体类型、时长、有没有字幕轨、`capabilities.asr.available`。
录音还会给一段 `audioHealth` 体检——如果结论是 `too-quiet` / `silent`，
**转写会故意是空的**（避免 ASR 编出一整段幻觉台词），这时该做的是换一份清楚的录音，而不是继续追问。

**2. 总览（主体动作）**

```json
{ "path": "/abs/path/demo.mp4", "cells": 9, "images": 2 }
```

出 2 张 3×3 的分镜宫格图 + 一份按格对齐的文本清单（每行末尾标了来源：`subtitle` / `asr` / `ocr` / `none`）。
**全文不内联**，而是落盘成三个文件并把路径返回给你：

| 文件 | 内容 |
|---|---|
| `content.md` | 人读 Markdown，按时间区间分节 |
| `segments.jsonl` | 一行一个 segment（JSON），机器读 |
| `manifest.json` | 工具、窗口、转写来源、图片描述、警告、计数 |

读这些文件要**自己分块总结**，不要为了拿更多内联文本反复调工具。

**3. 特写（贵，只在「这里有事」时用）**

```json
{ "path": "/abs/path/demo.mp4", "at": 72.5 }
```

宫格一格只有几百像素，里面的字基本看不清；**要读画面上的字必须 zoom**，
必要时再加 `crop`（`{x, y, width, height}`，全是 0..1 的比例，原点左上）裁出那块区域。

**4. 定位（纯文本，零图片）**

```json
{ "path": "/abs/path/demo.mp4", "query": "那句话是在哪说的" }
```

返回它在视频里的时间戳（毫秒 + 秒两种表示）、在文档里的页码。

> **长素材先收窄。** 超过 30 分钟的视频、超过 30 页的文档，先用 `start`/`end`（视频、录音）或
> `pages`（文档，如 `"3-10,15"`）取一小段，再跟着结果里的 `continuation` 提示一页页往下走。
> 一次 overview 硬上限是 4 张图、每张 16 格、单次共 64 格、单图最长边 1600px——
> 一张「两小时电影的大宫格」既看不清又剧透。

---

## 依赖、许可与上游致谢

- **运行时依赖**：`@modelcontextprotocol/sdk`（MIT）、`zod`（MIT）。没有构建步骤，纯 ESM。
- **系统依赖**：ffmpeg / ffprobe（不打包、不链接，按独立子进程调用）、poppler 或 mutool 或 gs（只读 PDF 时用）。
- **可选外部服务**：ElevenLabs（ASR）、MinerU（文档解析）。都是用户自备 key，代码里不含它们的凭据。
- **许可**：本项目 **Apache-2.0**（[`LICENSE`](LICENSE)）。
- **vendored 源码**：视频部分基于 Apache-2.0 的
  [dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard) v0.5.9 改造而来，
  源码在 `vendor/dsh-video-storyboard/`（[`VENDOR.md`](VENDOR.md) 逐文件说明改了什么；
  上游 `LICENSE` / `NOTICE` / `CREDITS.md` 逐字复制在同目录下）。
  被改动的文件顶部都有 `Modifications:` 段落（Apache-2.0 §4(b)）。
  完整署名见 [`NOTICE`](NOTICE) 与 [`CREDITS.md`](CREDITS.md)。

---

## 开发

纯 ESM JavaScript（Node ≥20），零构建步骤。规格与决策只在 beads（`bd`），不在本仓库写交接文档。

```bash
npm install
npm run check        # 语法检查（src/ 与 vendor/ 全量 node --check）
npm test             # node --test
npm run fixtures     # 生成测试素材（ffmpeg 脚本生成，仓库不含任何第三方媒体）
```

工具契约（参数、返回结构、错误码、图片预算）见 [`docs/mcp-contract.md`](docs/mcp-contract.md)；
安装、provider 配置、排障与验证清单见 [`docs/install.md`](docs/install.md)。
