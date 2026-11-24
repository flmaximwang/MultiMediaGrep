# MultiMediaGrep

MultiMediaGrep 是一个面向多模态 agent 的本地媒体感知 MCP server。它读取本地的视频、音频和文档，将其转化为模型可直接消费的图像（分镜宫格、单帧特写、页面缩略图）以及按时间码或页码对齐的文本索引。服务端本身不调用 LLM，理解与推理完全交由宿主 agent 完成。

在设计上，它只处理本地绝对路径，不负责网络下载或内容检索；语音转写（ASR）与扫描件识别（OCR）通过外部服务配置接入，未配置时只返回可见画面并如实说明文本缺失。除自身的缓存目录外，只有调用写工具时才会在源文件旁生成 `.mmgrep.*` sidecar / VTT 文件或原地更新 PDF 的目录与批注。

相关文档：[安装与运维指南](docs/install.md) · [MCP 工具契约](docs/mcp-contract.md) · [版本变更记录](CHANGELOG.md)

## 工具集

MultiMediaGrep 提供六个跨媒体复用的工具：

| 工具 | 用途 |
|---|---|
| `media_probe` | 读取媒体元信息（时长、分辨率、页数、编码、轨道、文字层状态、ASR/OCR 可用性及目录批注数量），不消耗图片 token。 |
| `media_overview` | 生成视频分镜宫格、音频时间轴转写或文档页图与文本预览；完整文本会落盘至 `content.md` 供按需读取。 |
| `media_zoom` | 提取指定时间点或区间的视频单帧，或渲染文档单页（支持局部裁切），用于辨认画面细节与文字。 |
| `media_locate` | 按关键词检索字幕、文档文本、转写或批注内容，返回匹配的时间戳、页码及上下文片段（纯文本，无图片）。 |
| `media_bookmark` | 写入或更新目录与章节信息；维护 `<file>.mmgrep.bookmark.json`，并同步嵌入 PDF outline 或生成 `.mmgrep.bookmark.vtt`。 |
| `media_annotate` | 写入或更新批注；维护 `<file>.mmgrep.annotation.json`，并同步写入 PDF 批注或生成 `.mmgrep.annotation.vtt`。 |

> 调用 `media_bookmark` 或 `media_annotate` 会直接修改目标 PDF（不保留原件副本）并在源文件旁创建 sidecar 文件，修改重要文件前建议先做版本控制或备份。详细行为见 [MCP 工具契约](docs/mcp-contract.md) §15 与 §16。

## 部署与接入

最省事的方式是直接使用 **Magpie** 部署并接入，无需手动维护宿主配置与环境变量。

如需手动安装或自托管，请先确保系统已安装 Node.js >= 20 与 `ffmpeg` / `ffprobe`。处理 PDF 时，读取需要 `poppler`、`mutool` 或 `gs` 之一，写入目录/批注及读取自带批注需要 `mutool`，读取 PDF 书签则建议安装 `qpdf`。

```bash
# 通过 npx 直接运行（默认 stdio）
npx -y github:flmaximwang/MultiMediaGrep

# 或安装 release 运行时包（不含测试与示例素材）
npm i -y https://github.com/flmaximwang/MultiMediaGrep/releases/download/v0.3.1/multimediagrep-mcp-0.3.1.tgz
```

在支持 MCP 的客户端中添加如下配置即可使用（完整环境变量模板见 [examples/mcp-config.json](examples/mcp-config.json)）：

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

需要多客户端共享或远程访问时，可通过 `--http` 启动 Streamable HTTP 服务（默认监听 `127.0.0.1:3927/mcp`，支持 `--port`、`--token` 以及 `x-mmgrep-*` 每请求凭据头）。如需对无字幕音视频进行转写或对扫描件 PDF 进行识别，可在环境中配置 ASR（支持 `elevenlabs`、`openai-compatible`、`deepseek`）与文档解析（OCR 支持 `mineru`，排版解析默认本地 `builtin`）。

完整的系统依赖安装、各宿主接入方式、HTTP 反向代理配置及全量环境变量说明，请参阅 [docs/install.md](docs/install.md)。

## 使用方式

面对一个本地媒体文件（例如 `/abs/path/demo.mp4`），推荐按从轻到重的顺序渐进读取：

1. **探测信息**：先调用 `media_probe` 检查文件时长或页数、可用字幕轨、文字层质量以及 ASR/OCR 配置状态，避免盲目拉取图片。
2. **获取总览**：调用 `media_overview`（如视频可指定 `cells: 9, images: 2`）获取分镜或页面缩略图与对齐的文本预览。当文本较长时，内联返回仅作预览，完整文本会写入磁盘上的 `content.md`、`segments.jsonl` 与 `manifest.json`，直接分块读取文件即可。对于超过 30 分钟的视频或 30 页的文档，建议通过 `start`/`end` 或 `pages` 分段读取。
3. **检索与特写**：需要查找具体内容位置时使用纯文本的 `media_locate`；只有在必须看清画面细节或屏幕文字时，再对目标时间点或页码调用 `media_zoom`（可配合 `crop` 参数局部放大）。涉及语音内容时，优先采信人工字幕而非机器转写（ASR 对专有名词和数字并不可靠）。
4. **写入标记**：定位完成后，可按需使用 `media_bookmark` 或 `media_annotate` 持久化章节与批注；一旦生成 sidecar 文件，后续读取将以 sidecar 作为唯一数据源。

## 开发

本项目采用纯 ESM 编写，无构建步骤，运行时仅依赖 `@modelcontextprotocol/sdk` 与 `zod`。

```bash
npm install
npm run check      # 全量语法检查
npm test           # 运行测试套件（node --test）
npm run fixtures   # 通过 ffmpeg 脚本生成本地测试素材
```

## 许可与致谢

本项目基于 Apache-2.0 协议开源（见 [LICENSE](LICENSE)）。`src/backend/video/` 目录下的 `geometry.js`、`frames.js`、`sheet.js`、`shots.js` 以及 `storyboard.js` 中的 `mapPool` 改写自 Apache-2.0 协议的 [dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard) v0.5.9，完整署名信息见 [NOTICE](NOTICE) 与 [CREDITS.md](CREDITS.md)。
