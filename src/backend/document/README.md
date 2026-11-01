# 文档后端（document）

把本地文档变成 agent 能读的材料：**页面缩略图拼图** + **按页对齐的文字**，必要时用
`media_zoom` 放大单页。职责与返回结构见 `docs/mcp-contract.md` §4.3 / §5 / §6 / §7。

server 本身**不调用任何 LLM**。扫描件 / 图片的 OCR 交给用户配置的 `ctx.docProvider`
（例如 MinerU，见 `src/providers/doc/README.md`）；没配就只返回页面图，让多模态模型自己看。

## 支持范围

| 输入 | 页数 | `pageCount` | `hasTextLayer` | `width` / `height` |
| --- | --- | --- | --- | --- |
| PDF（`.pdf`，或魔数 `%PDF`） | 实际页数 | PDF 页数 | 第 1 页文字层采样 | **pt**（第一页页面尺寸；`/Rotate` 90/270 已交换宽高） |
| 图片（`.png .jpg .jpeg .webp .bmp .gif .tif .tiff`） | 1 | 1 | `false` | **px**（原图像素） |
| 纯文本（`.txt .md .markdown`） | 1 | 1 | `true` | `null` |

- Office（`.docx .doc .pptx .ppt .xlsx .xls`）以及 `.odt .ods .odp .rtf .epub`：
  `UNSUPPORTED_MEDIA_TYPE`，hint 提示 **Office 支持暂缓，先用 LibreOffice 转 PDF**
  （`soffice --headless --convert-to pdf <file>`）。
- 纯文本没有页面图：`overview` 返回 0 张图 + 警告，整份文字放在第 1 页的 segment 里；
  `zoom` 对纯文本报 `UNSUPPORTED_MEDIA_TYPE`。
- 文件类型判定魔数优先：`%PDF` / PNG / JPEG / GIF / TIFF / WebP 即使扩展名不对也按内容识别。

## PDF 工具链（运行时探测，不假设已安装）

| 用途 | 顺序 | 缺失时 |
| --- | --- | --- |
| 页面栅格化 | `pdftoppm` → `mutool draw` → `gs` | `TOOL_NOT_FOUND`，hint 点名装 `poppler-utils` / `mupdf-tools` / `ghostscript` |
| 文字层 | `pdftotext -layout -enc UTF-8` → `mutool draw -F txt` | 视为「无文字层」；扫描件需要 OCR provider |
| 页数 / 页尺寸 | `pdfinfo` → `mutool info` → `qpdf --show-npages` | `TOOL_NOT_FOUND`；qpdf 没有页尺寸时用 72 dpi 渲染首页量像素兜底 |

`ffmpeg` / `ffprobe` 是硬依赖：拼图、裁切、缩放、图片尺寸都走它们。所有命令都用
`spawn` 的参数数组调用（`src/media/ffmpeg.js` 的 `run()`），不经 shell。

## 文字从哪里来

`overview` / `locate` 的顺序：**`ctx.docProvider` → PDF 文字层 → 空 + 警告**。

- provider 成功时逐页使用它的 `text`；缺失的页再用 PDF 文字层补齐。
- provider 抛错时 `overview` **不报错**：降级成页面图 + 警告；`locate` 是纯文字需求，
  没有兜底文字时按错误码报 `PROVIDER_FAILED` / `PROVIDER_NOT_CONFIGURED`。
- 完全没有文字、也没有 provider 时，`locate` 报 `NO_TRANSCRIPT`
  （`no text layer and no OCR provider is configured`）；`overview` 仍返回页面图 + 警告。
- 每页 segment 的 `source` / `origin` 均为 `ocr`（文档页文字的契约口径），
  `startMs` / `endMs` 为 `null`——文档没有时间轴，位置就是 `page`。
- provider 的文字如果包含表格，当前只取 `text` 字段；表格结构暂不透传。

## 图片预算与抽样

`overview` 严格遵守 server 传入的图片预算（契约 §10）：

- 每张拼图 ≤ `cells` 格、≤ `images` 张、长边 ≤ `maxEdge`、单图 ≤ 2,000,000 px；
- 请求页数超过 `cells × images` 时**均匀抽样**（保留首尾页）而不是只取前几页；
  文字仍然覆盖所有请求页，并给出「图只覆盖 N/M 页」的警告；
- 拼图用 ffmpeg 的 `scale + pad + xstack` 生成，格内页面比例不一致时留白；
- `zoom` 输出**恰好一张** PNG：先按裁切区估算 DPI 渲染整页，再 `crop + scale`
  到 `maxEdge`（默认 1600）。裁切太小、600 dpi 也填不满时会给出 warning。
- `locate({ includeFrame: true })` 用最佳匹配页渲染一张 ≤1280 px 的 PNG；
  纯文本没有页面图，`includeFrame` 降级为 warning。

## 临时文件

只在 `MMGREP_CACHE_DIR`（默认 `~/.cache/multimediagrep`）下的
`work/document/<内容 sha256>/` 里建临时目录，用完即删；**绝不在用户文件旁边写任何东西**。
PDF 元信息按「路径 + 大小 + mtime」做进程内短缓存，避免一次调用里 probe 和
overview/locate 重复跑 `pdfinfo` / `pdftotext`。

## 已知限制

- 扫描件 / 图片的文字质量完全取决于 provider；没配 provider 时只能看页面图。
- PDF 页尺寸按第一页报告；混合页面尺寸的文档里，其余页的页尺寸不单独上报
  （裁切仍按该页实际渲染像素做比例裁切）。
- `mutool draw -p` 是密码参数，不是页码参数；本后端用位置参数选页（已按实际 CLI 验证）。
- 超大 PDF 的 `pdftotext` 输出受 `run()` 的 8 MB stdout 上限约束（共享模块的现状）。
