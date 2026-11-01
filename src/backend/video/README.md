# 视频后端

`createVideoBackend(ctx)` 返回 `{ probe, overview, zoom, locate, subtitles }`，接口与字段见
`docs/mcp-contract.md` §4–§8。这里不调用 LLM、不联网、不下载；所有临时文件只写
`MMGREP_CACHE_DIR`（默认 `~/.cache/multimediagrep`）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 五个工具入口、窗口校验、NO_TRANSCRIPT 文案 |
| `probe.js` | ffprobe 读流信息；只解码音频流做 audioHealth（带进程内缓存） |
| `transcript.js` | 转写来源解析：显式文件 → 内嵌轨 → 同名字幕 → ASR 兜底 |
| `storyboard.js` | 镜头切点、格范围、宫格拼图 |
| `shots.js` | 扫描镜头切点（HSV 加权，失败降级为「均分」） |
| `frames.js` | 取帧、锐度选帧、PNG 编码（走 `media/ffmpeg.js`，认 `MMGREP_FFMPEG_PATH`） |
| `sheet.js` | 宫格纯绘制层：画布布局、填色、点阵数字、编号徽标、贴帧 |
| `geometry.js` | 显示几何换算：帧率/SAR 解析、旋转归一、显示宽高比 |
| `capture.js` | zoom / locate(includeFrame) 单帧抓取与缩放后裁切 |
| `work.js` | 按 路径+大小+mtime 生成缓存工作目录 |

## 关键约定

- **字幕优先**：`resolveSubtitleSource` 命中时绝不运行 ASR；命中不了且
  `transcript !== 'off'`、有 `ctx.asrProvider`、音频体检有效时才转写，
  且只转调用窗口（16 kHz 单声道、按静音切 ≤45 s 块）。
- **来源标注**：字幕段落 `source: 'subtitle'`（`origin: file | embedded`），
  ASR 段落 `source: 'asr'`（`origin: 'asr'`）。没有转写时 `source: 'none'`。
- **overview** 的格范围严格覆盖 `startMs..endMs`：第一格从起点开始、最后一格在终点结束；
  镜头切点只用于对齐边界。输出格数不超过 `cells × images`，且窗口过短时宁可少给。
- **zoom** 的 `crop` 是输出图的分数坐标，在缩放到 `maxEdge` 后再裁。
- **二进制 PNG** 走临时文件再读回：共享 `run()` 的 stdout 是字符串，不能承载二进制。
- **Apache-2.0 派生**：`shots.js` / `frames.js` / `sheet.js` / `geometry.js` 派生自
  dsh-video-storyboard v0.5.9（© 2026 SAOS-3624），各文件的改动声明见仓库根目录 `NOTICE`。
