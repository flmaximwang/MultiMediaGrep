# MultiMediaGrep v0.1.0

给 agent 的**本地媒体感知工具**：一个 stdio MCP server，把本地已有的视频 / 录音 / 文档，
变成 agent 的多模态模型能直接消化的材料——**图**（分镜宫格、特写裁切、页面缩略图）
＋**按时间/页码对齐的文本清单**。

- 仓库：<https://github.com/flmaximwang/MultiMediaGrep>
- 许可：Apache-2.0（部分模块改写自 dsh-video-storyboard v0.5.9，署名见 `NOTICE` / `CREDITS.md`）
- 契约：[`docs/mcp-contract.md`](docs/mcp-contract.md)｜安装运维：[`docs/install.md`](docs/install.md)

## 装

```bash
# 从 GitHub 装（npm 尚未发布）
npx -y github:flmaximwang/MultiMediaGrep

# 或装 release 里的运行时包
npm i -y https://github.com/flmaximwang/MultiMediaGrep/releases/download/v0.1.0/multimediagrep-mcp-0.1.0.tgz
```

宿主配置（Claude Code / Hermes / 任意 MCP client 同理）：

```json
{
  "mcpServers": {
    "multimediagrep": {
      "command": "npx",
      "args": ["-y", "github:flmaximwang/MultiMediaGrep"]
    }
  }
}
```

环境要求：Node ≥ 20、`ffmpeg` + `ffprobe` 在 PATH 上；读 PDF 另需 `poppler` / `mutool` / `gs` 任意一个。

## 四个工具

| 工具 | 干什么 | 图片开销 |
|---|---|---|
| `media_probe` | 类型、时长/页数、轨道、能否 ASR/OCR | 0 |
| `media_overview` | 视频出分镜宫格 + 时间对齐文本（`images: 0` 为纯文本）；录音出带时间轴转写；文档出页图 + 每页文字 | 0–4 张 |
| `media_zoom` | 视频某时刻的单帧 / 文档某页，可裁切，用于读画面上的字 | 1 张（~1900 token） |
| `media_locate` | 一句文本 → 视频/录音里的时间戳、文档里的页码 | 0（`includeFrame` 才 +1） |

## 迁移注记

`video_subtitles` 已并入 `media_overview`：纯字幕读取用
`media_overview({ path, images: 0, transcript: "subtitle" })`，需要显式选择来源时再加 `subtitle`
（本地字幕文件绝对路径 / 字幕轨 index / 语言码）。工具总数从 5 个变为 4 个，旧工具名不再注册。

## 这一版的边界（重要）

- **只吃本地绝对路径**，不下载、不检索、不碰 cookie / 凭据。
- **server 不调 LLM**：只准备图片和文本，理解由 agent 自己的模型完成。
- **字幕优先于 ASR**：显式字幕文件 → 内嵌字幕轨 → 同目录同名文件 → 才轮到 ASR。
  字幕是作者原话；ASR 是机器转写，人名与数字常错。
- **不配外部服务也能用**：只是拿不到文字层（扫描件只给页图）。
  ASR 与文档解析由用户自备 key，通过环境变量指定（ElevenLabs / OpenAI 兼容 / MinerU）。
- **没把握就说没有**：录音体检判定为静音时，转写故意留空，不编台词。

## 已知限制

- Office 文档（docx/pptx/xlsx）暂不支持，请先 `soffice --headless --convert-to pdf`。
- 独立的本地 OCR 通道（`MMGREP_OCR_PROVIDER`）尚未实现，OCR 由文档解析 provider 承担。
- 契约里的图片上限（4 张 / 16 格 / 1600 px / 4000 token）是按算法推导的，
  不是某个宿主的实测上限——请按 `docs/install.md` §7 在自己的宿主上确认一次。
