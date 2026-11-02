# MultiMediaGrep — MCP 工具契约

> 面向 agent（调用方）与实现者（写 server 的人）的规格文档。**这不是代码**，是双方都要签字的约定。
>
> 状态：设计稿 v1 · 对应 beads `MultiMediaGrep-9z5.4`（工具 MCP 契约）与 `MultiMediaGrep-32x`（图片 token 预算）
>
> 上游参考：[`dsh-video-storyboard`](https://github.com/SAOS-3624/dsh-video-storyboard) v0.5.9（Apache-2.0）。本项目的视频模块部分派生自它，见 `NOTICE` / `CREDITS.md`。

---

## 1. 这份契约是什么

MultiMediaGrep 是一个 **MCP server**：默认走 stdio（由宿主拉起），也可以显式开启 Streamable HTTP（`POST /mcp`）。它给任何 MCP client 的 agent 提供「看 / 听」本地媒体的能力：

| 媒体 | agent 能拿到什么 |
|---|---|
| 视频 | 分镜宫格图（多格拼图，每格编号 + 时间戳）+ 按时间对齐的文本清单 |
| 录音 | 带时间轴的转写文本（可选音频包络图） |
| 文档 | 页面缩略图拼图 + 每页文字（若配置了文档解析服务） |

三条不可动摇的边界：

1. **server 自己绝不调用 LLM。** server 只做「取帧 / 转写 / 排版」，理解由 agent 自己的多模态模型完成。
2. **server 不做取数。** 只收本地文件的绝对路径；拒绝 URL；不碰 cookie、不替你管理凭据、不下载。provider key 只由调用方显式提供（环境变量或 HTTP 请求头）。
   唯一例外是 0.3.0 的两个写工具（`media_bookmark` / `media_annotate`）：它们会在源文件旁写
   `*.mmgrep.*` sidecar / VTT，并在 PDF 上**原地**写入目录 / 批注——只有用户明确调用写工具时才会发生，
   见 §15 / §16。
3. **server 不保存用户凭据。** stdio 模式不做鉴权；HTTP 模式只做 Bearer 令牌这一层接入控制。请求头里的 provider key 只活在这一个请求内，不落盘、不缓存、不回显。需要字幕就让取数层把字幕文件交给它。

契约里出现的一切**工具名、参数名、字段名、工具描述文本**都是英文（agent 的 API 面）；本文件的**正文说明是中文**。

---

## 2. 全局约定

### 2.1 媒体类型判定与后端分派

`mediaType` 有且只有三个取值：`video` / `audio` / `document`。

判定顺序（先扩展名，后容器嗅探；两者冲突时以容器嗅探为准）：

1. 扩展名落在下表 → 候选类型。
2. 用 `ffprobe`（视频/音频）或文件魔数 + 解析头（文档）确认：
   - 扩展名说是视频，但容器里**没有视频流** → 退化为 `audio`（例如伪装成 `.mp4` 的纯音频）。
   - 扩展名说是视频/音频，但容器里**只有视频流没有音频流** → 仍是 `video`（无声视频合法）。
   - 魔数是 `%PDF` → `document`（不论扩展名）。
3. 判定失败 → 抛 `UNSUPPORTED_MEDIA_TYPE`。

| mediaType | 扩展名（不区分大小写） | 判定依据 |
|---|---|---|
| `video` | `mp4` `m4v` `mov` `mkv` `webm` `avi` `flv` `wmv` `mpg` `mpeg` `mts` `m2ts` `ts` `3gp` | 容器含视频流 |
| `audio` | `mp3` `wav` `m4a` `aac` `flac` `ogg` `opus` `wma` `aiff` `aif` `amr` `m4b` `weba` | 容器含音频流且无视频流 |
| `document` | `pdf` `png` `jpg` `jpeg` `webp` `bmp` `gif` `tif` `tiff` `txt` `md` `markdown` `docx` `doc` `pptx` `ppt` `xlsx` `xls` `odt` `odp` `ods` | 魔数（PDF / 图片）或扩展名；Office 只识别、不解析 |

> **Office 文档（`docx` / `doc` / `pptx` / `ppt` / `xlsx` / `xls` / `odt` / `odp` / `ods`）会被判成
> `document`，但文档后端读不了它**：调用会返回 `UNSUPPORTED_MEDIA_TYPE`，文案里给出
> `soffice --headless --convert-to pdf <file>` 的下一步。别把它和「扫描件没 OCR」混为一谈。
> 图片类文档（`png` / `jpg` / …）按**一页文档**处理；多页 TIFF 只读第一页。

后端分派（`mediaType` → 具体实现）：

| mediaType | 后端 | 关键组成 |
|---|---|---|
| `video` | **视频后端** | 本项目自己的视频管线（部分模块派生自 `dsh-video-storyboard`）：`probe.js`（ffprobe）、`shots.js`/`storyboard.js`（镜头检测与分格）、`frames.js`/`sheet.js`（取帧与拼图）、`transcript.js`（转写） |
| `audio` | **录音后端** | ffmpeg 抽 16 kHz 单声道 WAV → ASR provider → 带时间轴的 segments；可选音频包络图 |
| `document` | **文档后端** | 页面栅格化（页图）＋ 可选文档解析 provider（每页文字） |

```mermaid
flowchart TD
  A["media_* tool call<br/>path = 本地绝对路径"] --> B{"mediaType?<br/>扩展名 + 容器嗅探"}
  B -->|video| V["视频后端<br/>本项目 video 模块<br/>（部分派生自上游）"]
  B -->|audio| AU["录音后端<br/>ffmpeg → WAV → ASR"]
  B -->|document| D["文档后端<br/>页面栅格化"]
  B -->|无法判定| E["✗ UNSUPPORTED_MEDIA_TYPE"]

  V --> V1["ffprobe<br/>duration / size / fps / tracks"]
  V --> V2["scan + plan<br/>镜头检测 → 分格"]
  V --> V3["frames + sheet<br/>→ 宫格 PNG"]
  V --> V4["字幕来源<br/>内嵌轨 / 字幕文件 / ASR"]

  AU --> AU1["ffmpeg 抽 16k 单声道 WAV"]
  AU1 --> AU2["ASR provider<br/>MMGREP_ASR_PROVIDER"]
  AU2 --> AU3["segments（带时间轴）"]
  AU3 -. "envelope=true 时" .-> AU4["音频包络 PNG"]

  D --> D1["页面栅格化<br/>→ 页图"]
  D --> D2["文档 provider<br/>MMGREP_OCR_PROVIDER / MMGREP_TYPESET_PROVIDER"]
  D2 --> D3["每页文字"]

  V4 --> T["统一 segments 模型<br/>{ startMs, endMs, text, page }"]
  AU3 --> T
  D3 --> T

  V3 --> OUT["全文落盘<br/>content.md / segments.jsonl / manifest.json"]
  AU3 --> OUT
  D3 --> OUT
  AU4 --> OUT
```

### 2.2 参数适用性（工具 × 参数 × 媒体）

**规则一：不属于该工具的参数由 `inputSchema` 直接拒绝。** 六个工具的 schema 都加了 `.strict()`：多传一个未声明的参数不会被忽略，而是由 MCP 输入校验返回错误（JSON-RPC `-32602`，文案里点名未知字段）。所以「`media_zoom` 能不能传 `view`」这种问题的答案是「不能传」——不是「传了没效果」。

**规则二：参数对当前媒体不适用时必须报错，不能静默忽略。** 静默忽略会让 agent 以为参数生效了，然后在错误的时间窗里读到错误的内容。

**每个工具接受哪些参数：**

| 参数 | `media_probe` | `media_overview` | `media_zoom` | `media_locate` | 媒体适用性 |
|---|:---:|:---:|:---:|:---:|---|
| `path` | ✅ 必填 | ✅ 必填 | ✅ 必填 | ✅ 必填 | video / audio / document |
| `subtitle` | ✅ | ✅ | — | ✅ | video / audio（document 报错） |
| `transcript` | ✅ | ✅ | — | ✅ | video / audio（document 报错） |
| `start` / `end` | — | ✅ | ✅（video，两个都给） | ✅ | video / audio（document 报错） |
| `segment` | — | ✅ | — | ✅ | video / audio（document 报错） |
| `pages` | — | ✅ | — | ✅ | document（video / audio 报错） |
| `ocr` | — | ✅ | — | ✅ | document（video / audio 报错） |
| `view` | — | ✅ | — | — | video / audio / document |
| `cells` | — | ✅ | — | — | video / document（audio 报错） |
| `images` | — | ✅ | — | — | video / document；audio 只接受 `0` |
| `maxEdge` | — | ✅ | ✅ | — | video / document（audio 报错） |
| `envelope` | — | ✅ | — | — | audio（video / document 报错） |
| `at` | — | — | ✅ | — | video（audio / document 报错） |
| `page` | — | — | ✅ | — | document（video / audio 报错） |
| `crop` | — | — | ✅ | — | video / document（audio 报错） |
| `query` | — | — | — | ✅ 必填 | video / audio / document |
| `max` | — | — | — | ✅ | video / audio / document |
| `includeFrame` | — | — | — | ✅ | video / document（audio 报错） |

`media_bookmark` 与 `media_annotate` 的参数是独立的写入口（`path` + `add` / `remove` / `update`，
annotate 另有 `author`），见 §15.2 / §16.2；它们同样 `.strict()`，不属于上面这张只读参数表。

**媒体不适用时的错误文案（`INVALID_ARGUMENT`，节选）：**

| 参数 | video | audio | document |
|---|---|---|---|
| `subtitle` | ✅ | ✅ | `subtitle is not applicable to document media. Documents have a page text layer, not a transcript.` |
| `transcript` | ✅ | ✅ | `transcript is not applicable to document media.` |
| `start` / `end` | ✅ | ✅ | `start is not applicable to document media. Use "pages" instead (e.g. pages: "3-10,15").` / 同文的 `end` 版本 |
| `segment` | ✅ | ✅ | `segment is not applicable to document media.` |
| `pages` | `pages is not applicable to video media. Use "start" and "end" (seconds) instead.` | `pages is not applicable to audio media. Use "start" and "end" (seconds) instead.` | ✅ |
| `ocr` | `ocr is not applicable to video media. Only documents have a page text layer or page images to OCR; video and audio use subtitles/transcript instead.` | 同文 `audio` 版本 | ✅ |
| `includeFrame` | ✅ | `includeFrame is not applicable to audio media. There are no frames to show.` | ✅ |
| `at` | ✅ | `at is not applicable to audio media. media_zoom returns one frame for video and one page image for document; for audio use media_locate to find timestamps.` | `at is not applicable to document media. media_zoom uses "at" (or "start"/"end") for video.` |
| `crop` | ✅ | `crop is not applicable to audio media.` | ✅ |
| `page` | `page is not applicable to video media. media_zoom uses "at" (or "start"/"end") for video.` | `page is not applicable to audio media.` | ✅ |
| `cells` | ✅ | `cells is not applicable to audio media. A recording has no frames; media_overview returns a timestamped transcript instead.` | ✅ |
| `images` | ✅ | `images is not applicable to audio media.`（`images: 0` 例外放行） | ✅ |
| `maxEdge` | ✅ | `maxEdge is not applicable to audio media.` | ✅ |
| `envelope` | `envelope is not applicable to video media. It only applies to audio recordings.` | ✅ | `envelope is not applicable to document media. It only applies to audio recordings.` |

**`view` 的语义是跨媒体统一的**（只有 `media_overview` 收它）：目录优先 / 只出目录 / 只出文本这三种行为对三种媒体相同。区别只在目录从哪来：**先 bookmark sidecar**（存在就是唯一来源），否则文件自带目录（PDF 书签、视频/录音章节），两者都没有时文档还能从 heading 生成（≥5 条），视频/录音不生成（server 不调 LLM）。详见 §15.10。

文档的 `cells` 语义是「每张拼图放几页缩略图」；视频的 `cells` 语义是「每张宫格放几个镜头格」。同一个名字，两种媒体各自解释——这是「按动作命名、跨媒体统一」的核心收益。

**`images: 0` = 零像素纯文本模式。** 三种媒体都认这个值：视频**不扫镜头、不抽帧**（这条路径上一次 ffmpeg 都不跑），录音**不出波形图**（`images: 0` 压过 `envelope: true`），文档**不渲染页图**（只回页文字）。返回的 `budget` 全是零（`requestedImages` / `producedImages` / `estimatedTokens`），全文照常落盘，窗口与续读提示不变。这是「只要文字、不想付画面钱」的入口。

### 2.3 时间与页码表示

**时间一律给两种表示**，缺一不可：

| 形式 | 字段命名 | 类型 | 含义 |
|---|---|---|---|
| 毫秒整数 | `startMs` / `endMs` / `atMs` | integer | 从媒体开头算起的毫秒数，**向下取整到整数毫秒**。JSON 里的权威值。 |
| 秒（浮点） | `startSec` / `endSec` / `atSec` | number | 同一时刻的秒表示，毫秒精度（例：`12.76`）。给人看、给 agent 心算用。 |
| 人类可读标签 | `startLabel` / `endLabel` | string | 文本清单里用的标签，格式 `mm:ss.mmm`；超过一小时用 `hh:mm:ss.mmm`。例：`00:12.760`。 |

页码：`page` 为 **1-based 整数**，闭区间。

**区间语义（收窄范围，写死，不给实现留歧义）**

| 媒体 | 范围参数 | 语义 | 边界 |
|---|---|---|---|
| video / audio | `start` / `end` | **闭区间** `[start, end]`，单位秒（浮点），**两端都含** | `start >= 0`；`end` 必须 `> start`；`end` 可以等于媒体时长 |
| document | `pages` | **闭区间**的逗号列表，如 `"3-10,15"`；每个区间**含首尾两页** | 页码 **1-based**；区间必须从小到大 |

**越界一律报错，绝不静默裁剪**（唯一例外见下表最后一行）：

| 情形 | 行为 |
|---|---|
| `pages` 页码 > 文档总页数 | **报错**，不裁剪 |
| `pages` 页码 < 1 | **报错** |
| `start` >= 媒体时长 | **报错**（窗口内没有任何内容可给） |
| `start` < 0 | **报错** |
| `end` <= `start` | **报错** |
| `end` > 媒体时长 | **裁剪到媒体末尾**，返回值里 `window.clipped = true` + 实际 `endMs` |

`end` 是唯一的例外：超出末尾通常意味着 agent 对素材长度估错，而不是「我要的东西不存在」，裁到末尾仍然交付了它想要的内容。`pages` 与 `start` 不适用这个宽容处理——它们越界说明参数本身写错了，必须让 agent 知道。

### 2.4 错误模型

工具失败时返回标准 MCP 错误结果：

```json
{
  "content": [ { "type": "text", "text": "INVALID_ARGUMENT: pages is invalid: \"abc\". ..." } ],
  "structuredContent": {
    "error": {
      "code": "INVALID_ARGUMENT",
      "message": "pages is invalid: \"abc\". Expected a comma-separated list of page numbers and closed ranges, e.g. \"3-10,15\".",
      "hint": "Use pages: \"3-10,15\"."
    }
  },
  "isError": true
}
```

**错误码全集：**

| code | 何时用 |
|---|---|
| `INVALID_ARGUMENT` | 参数缺失、类型错、取值非法、参数不适用于该媒体类型 |
| `PATH_NOT_FOUND` | 路径不存在 |
| `NOT_A_FILE` | 路径存在但不是普通文件（目录 / 设备 / 管道） |
| `NOT_A_LOCAL_PATH` | 传了 URL 或相对路径 |
| `UNSUPPORTED_MEDIA_TYPE` | 无法判定 mediaType |
| `OUT_OF_RANGE` | `start`/`end`/`pages` 超出媒体实际长度 |
| `NO_TRANSCRIPT` | 需要转写但没有任何可用来源（且不允许降级为纯画面） |
| `PROVIDER_NOT_CONFIGURED` | 需要 ASR / OCR / 文档解析，但对应 provider 未配置 |
| `PROVIDER_FAILED` | provider 已配置但调用失败（HTTP 错误 / 超时 / 坏响应） |
| `TRANSCRIPT_UNREADABLE` | 字幕文件存在但解析不出内容（显式 `subtitle` 统一转成 `INVALID_ARGUMENT`；自动发现路径只记 warning） |
| `BUDGET_EXCEEDED` | 请求超出图片预算硬上限 |
| `TOOL_NOT_FOUND` | `ffmpeg` / `ffprobe` / 页面栅格化器缺失 |
| `INTERNAL` | 其它未分类异常（必须带上原始 stack 摘要） |

**路径校验（每个工具都会跑，顺序固定）：**

1. 缺失 → `INVALID_ARGUMENT: path is required.`
2. 含协议头（匹配 `^[a-zA-Z][a-zA-Z0-9+.\-]*://` 或以 `//` 开头）→
   `NOT_A_LOCAL_PATH: path must be a local absolute file path; URLs are not accepted ("https://example.com/a.mp4"). This server never downloads anything — fetch the file first, then pass its local path.`
   （`file://` 同样拒绝：让 agent 传裸路径，避免 URI 转义歧义。）
3. 不是绝对路径 →
   `INVALID_ARGUMENT: path must be an absolute local path; got "videos/a.mp4". Use an absolute path such as "/abs/path/videos/a.mp4".`
4. 不存在 → `PATH_NOT_FOUND: path does not exist: "/abs/path/a.mp4".`
5. 不是普通文件 → `NOT_A_FILE: path is not a regular file: "/abs/path/a.mp4".`

**范围校验：**

| 情况 | 错误文案 |
|---|---|
| `start < 0` | `start must be >= 0.` |
| `end <= start` | `end must be greater than start (end=10, start=30).` |
| `start` 超出媒体时长 | `start (7200.0 s) is beyond the end of the media (duration 3600.0 s).` |
| `segment` 越界 | `segment must be an integer between 30 and 3600 (seconds).` |
| `pages` 为空串 | `pages must not be empty. Use a comma-separated list of page numbers and closed ranges, e.g. "3-10,15".` |
| `pages` 非法 token | `pages is invalid: "abc". Expected a comma-separated list of page numbers and closed ranges, e.g. "3-10,15".` |
| `pages` 页码 < 1 | `pages is invalid: "0". Page numbers start at 1.` |
| `pages` 区间倒置 | `pages is invalid: "10-3". Ranges must be low-to-high with inclusive bounds, e.g. "3-10".` |
| `pages` 越界 | `pages out of range: 12-15. This document has 8 pages.` |
| `crop` 越界 | `crop must satisfy 0 <= x, 0 <= y, x + width <= 1, y + height <= 1 (got x=0.9, width=0.3).` |

**`pages` 的解析规则（写死，不给实现留歧义）：**

- 语法：逗号分隔的 item 列表；item = `N` 或 `N-M`（闭区间）。
- 允许 item 周围有空白；允许重复；重复与重叠**去重后按升序合并**（`"3-10,15,3"` → `3,4,5,6,7,8,9,10,15`）。
- 不允许负数、小数、空 item（`"3,,5"`）、`M < N`。
- 省略 `pages` = 全文（全页）。
- 越界**报错**，不静默截断（agent 拼错页码时必须知道自己拼错了）。

### 2.5 转写来源与可信度

**每个工具的返回里都带「这段文字 / 这张图是哪来的」。** agent 必须知道自己在读的是字幕文件里的文字、机器猜的转写，还是根本没有文字——这三者的可信度差一个数量级。

`source` 枚举（**可信度口径**）：

| 值 | 含义 | 可信度 | agent 该怎么用 |
|---|---|---|---|
| `subtitle` | 字幕文件或容器内嵌字幕轨里的文字 | 中高 | 通常是作者原话，但**可能是自动生成的**：专有名词、数字要自己核对画面 |
| `text` | **原生文字**：PDF 文字层（`origin = "textlayer"`）或 `.txt` / `.md` 文件本身（`origin = "file"`） | **最高（字符级精确）** | **可当原话直接引用**；不需要为了核对字符去 zoom 页面图 |
| `ocr` | 从画面 / 页面上 OCR 出来的文字 | 中高 | 可引用，但专有名词、数字要自己核对 |
| `asr` | 语音识别转写 | **最低** | **不可当原话引用**——人名、数字、术语会错 |
| `visual` | 没有文字来源，只有画面 | — | 只能描述画面，不能转述「说了什么」 |
| `mixed` | **只用于整份 `transcript`**：返回的页来源不一致（例如封面是 `ocr`、正文是 `text`） | — | 看每页自己的 `source` 标签；不要用 `mixed` 推断单页可信度 |
| `none` | 该项为空（没有文字，也不谎报来源） | — | — |

`origin` 枚举（**来源渠道口径**）：`file`（外部字幕文件 / `.txt` / `.md`）/ `embedded`（容器内嵌字幕轨）/ `textlayer`（PDF 原生文字层）/ `asr` / `ocr` / `none`。

两个字段一起给：`source = "subtitle"` + `origin = "embedded"` = 视频自带的字幕轨；`source = "subtitle"` + `origin = "file"` = 取数层给的字幕文件；`source = "asr"` + `origin = "asr"` = 机器转的；`source = "text"` + `origin = "textlayer"` = PDF 原生文字层。

**文档的逐页映射（0.2.0 起，破坏性变更）：**

- provider / 抽取层返回 `textOrigin = "textlayer"` → `source = "text"`、`origin = "textlayer"`；
- `textOrigin = "ocr"` 或 `unknown`（provider 没声明）→ `source = "ocr"`、`origin = "ocr"`（不确定时取保守值）；
- 页上没有任何文字 → `source = "none"`、`origin = "none"`（扫描件没配 OCR 时**不能**谎报有文本）；
- 整份 `transcript.source`：所有返回页一致时取该值（含「整份都没文字」→ `none`），不一致 → `mixed`；
- `.txt` / `.md` 一律 `source = "text"`、`origin = "file"`；
- `origin` 枚举里没有 `mixed`：`source = "mixed"` 时 `origin` 只表示主要渠道（`textlayer` 优先），逐页口径以 `segments[].origin` 为准。

> `source = "text"` 的段落与 `subtitle` 一样在文本输出里加「」；`asr` 不加（见 §5.4）。

> **硬约束一：ASR 转写不得被当作原话引用。** ASR 会把人名、数字、专业术语听错——上游 `dsh-video-storyboard` 专门写了一个 OCR 模块来用画面里的硬字幕校正 ASR 文本，理由就是「画面更可信」。所以凡是 `source = "asr"` 的段落，工具描述与 server instructions 都要提醒 agent 标注不确定。

> **硬约束二：字幕不保证是作者原创，更不保证「可安全引用」。** 字幕轨与字幕文件同样可能是机器自动生成的（自动字幕 / 滚动式字幕）：里面的人名、数字、术语同样会错。所以工具描述、server instructions 与 overview 的 note 一律用中性措辞——`subtitle — from a subtitle file/track; usually the author's words, but may be auto-generated: check names and numbers against the frame.`，**不作任何绝对的可引用承诺**。cue 之间大面积时间重叠（> 30%）时，overview 与 locate 还要额外给出警告 `rolling/auto-style captions detected — treat like ASR: check names and numbers against the frame.`。

> **定位指标按媒体类型分两套。** 视频 / 录音的 `media_locate` 报 `score`（0–1，越大越像）；
> 文档的 `media_locate` 报 `hits`（该页命中几次）+ `snippet`（命中附近的片段），**没有 `score`**：
> 文档的 segment 粒度就是整页，同一个字段两种语义会打架。详见 §7.3.1。

### 2.6 长任务与进度通知

**server 不设每个工具自己的墙钟超时。** 阻塞调用的时长由素材长度、外部 provider 的超时（`MMGREP_ASR_TIMEOUT_MS` / `MMGREP_DOC_TIMEOUT_MS`）与宿主的客户端超时共同决定；HTTP 传输另有一层**整次请求**的 120 s 上限（见 §2.8），超过就先中止在途工具调用、响应尚未开始时回 504。

| 工具 | 是否发 progress notification |
|---|---|
| `media_probe` | 否（毫秒级返回） |
| `media_overview` | 是（`scanning` → `transcribing` → `rendering` 三阶段；`images: 0` 时三个阶段照样发，`rendering` 报 0 张图） |
| `media_zoom` | 否 |
| `media_locate` | 否 |

> 进度上报是**框架能力**：`createProgressReporter` 对六个工具都可用，但当前只有 `media_overview` 显式调用它。宿主没给 `progressToken`、宿主不支持 `notifications/progress`、或 `MMGREP_PROGRESS_NOTIFICATIONS=false` 时静默跳过，不影响结果。

progress token 形如 `media_overview 3/5 · scanning 0-300s`，让宿主 UI 能显示进度。**进度通知是 best-effort**。

### 2.7 缓存与落盘约定

| 约定 | 内容 |
|---|---|
| 缓存**主键** | **源文件内容的 sha256**（`sha256:<64 位 hex>`），不是路径 + 大小 + mtime。内容变了 → key 变了 → 缓存自然失效 |
| **快速指纹索引** | 另有一份 `fingerprint-index.json`：`sha256(绝对路径 + ':' + size + ':' + mtimeMs)` → 内容 sha256。命中指纹就跳过全文件哈希；不命中就老老实实算内容 hash 并写回索引 |
| 缓存目录 | `MMGREP_CACHE_DIR`（默认 `~/.cache/multimediagrep`），**绝不写到用户文件旁边**。唯一例外是写工具的 sidecar / VTT：它们按契约写到源文件旁（`*.mmgrep.*`，见 §15.4 / §16.4），不写缓存目录 |
| 容量 | `MMGREP_CACHE_MAX_BYTES`（默认 10 GiB），超出按 LRU 淘汰整条目 |
| provider 逐页结果缓存 | 文档 provider 的结果按页写入同一缓存树：namespace = `sha256:<源内容 hash>:doc-provider:<role>:<hash(源 hash + provider id + model + ocrMode + role)>`，每页存契约 v2 的 page 对象。同一范围再次调用（overview / locate 共享）不再请求 provider，只把缺失页发出去；工具参数 `ocr: "force"`（= 后端 `ocrMode=force`）单独成键，不覆盖 auto / 文字层结果 |
| 落盘产物 | `content.md` + `segments.jsonl` + `manifest.json`（三个必备）+ `document.json`（可选，cangjie `SourceDocument Contract v1`） |

细节见 §9。

### 2.8 传输方式：stdio 与 HTTP

| | stdio（默认） | Streamable HTTP（显式开启） |
|---|---|---|
| 怎么开 | 不传 `--http`、不设 `MMGREP_TRANSPORT` | `--http` 或 `MMGREP_TRANSPORT=http` |
| 监听 | 不监听端口；宿主用 stdin/stdout 通信 | `POST /mcp`，默认 `127.0.0.1:3927` |
| 鉴权 | 无（进程由宿主拉起，边界是宿主） | 可选 Bearer 令牌；配了令牌后每个请求都要带 `Authorization: Bearer <令牌>` |
| 凭据 | 只读 server 启动时的环境变量 / 配置 | 可用 `x-mmgrep-*` 请求头逐请求覆盖（见 §12.7） |
| 生命周期 | 进程阻塞到 client 关闭 stdin | 无状态：每个请求新建 server + transport，处理完即关 |
| 工具语义 | 完全相同 | 完全相同 |

两边的差异只影响「怎么连、用谁的 key」，不影响任何工具的参数、返回结构、错误码或图片预算。
HTTP 模式下，带了凭据头的请求会用本次请求解析出的配置新建 provider；**凭据不按请求缓存**，
请求结束即丢弃。没带任何凭据头的请求复用启动时的 runtime。

HTTP 端点对 `Accept` / `Content-Type` 有要求：请求必须同时接受 `application/json` 与
`text/event-stream`（否则 406），`Content-Type` 必须是 `application/json`（否则 415）。
端点只接受 `POST /mcp`；其它路径 404，其它方法 405。配了令牌时，缺失或错误的 `Authorization`
返回 401（`WWW-Authenticate: Bearer realm="multimediagrep"`），且鉴权在方法判断之前执行。
请求体上限 1 MiB（超出 413）；单次请求超时 120 s，超时会中止在途工具调用，响应尚未开始时回 504。

> HTTP 模式是 **opt-in**：不显式开启时 server 不监听任何端口，现有的 stdio 接入方式不需要改动。

---

## 3. 工具总览

| 工具 | 动作 | video | audio | document | 出图 |
|---|---|:---:|:---:|:---:|:---:|
| `media_probe` | 探媒体 | ✅ | ✅ | ✅ | 0 张 |
| `media_overview` | 总览 | ✅ | ✅ | ✅ | 0–4 张 |
| `media_zoom` | 特写 | ✅ | ❌ | ✅ | 1 张 |
| `media_locate` | 定位 | ✅ | ✅ | ✅ | 0–1 张 |
| `media_bookmark` | 增删改目录（**写**） | ✅ | ✅ | ✅（PDF / 图片） | 0 张 |
| `media_annotate` | 增删改批注（**写**） | ✅ | ✅ | ✅（PDF / 图片） | 0 张 |

**读的调用顺序建议：`media_probe` → `media_overview` → （必要时）`media_zoom` / `media_locate`。**

**写的调用顺序建议：先用 `media_probe` / `media_overview` / `media_locate` 找到页码或时间戳，再调用
`media_bookmark` / `media_annotate`；之后 probe / overview / locate 会从 sidecar 读回这份目录 / 批注。**
`media_bookmark` / `media_annotate` 是仅有的两个会改文件的工具（`destructiveHint: true`），完整契约见
§15 / §16；只想看不动文件时不要调用它们。

**每个工具的返回都带 `source` 字段**（`subtitle` / `text` / `ocr` / `asr` / `mixed` / `visual` / `none`）标注内容的来源与可信度，见 §2.5。`mixed` 只用于整份 `transcript`（逐页标签不一致），不会出现在单个 segment / match 上。

---

## 4. `media_probe` — 探媒体

> agent 的第一站。不花图片 token，几毫秒返回「这文件是什么、能怎么读」。

### 4.1 工具描述（英文，含中文触发词）

```
Inspect a local media file — video, audio recording, or document — and report what it is:
duration, resolution, page count, codec, available tracks (audio / subtitle / text layer), and
whether transcription (ASR) and OCR are available for this file.
(读取本地媒体的元信息：时长、分辨率、页数、编码、可用轨道（音轨 / 字幕轨 / 文本层），
以及能否做 ASR / OCR 的初判。)

Call this FIRST on any file you have not inspected yet. It costs no image tokens and decodes
nothing. Then pick the right next tool:
- video / audio  -> media_overview to read it
- document       -> media_overview to see page thumbnails and per-page text
- a specific moment or page -> media_zoom for a close-up
- "where was X said / on which page" -> media_locate for a timestamp or a page number

For documents it also checks whether the text layer looks unreliable — U+FFFD replacement
characters, private-use characters, isolated single letters, symbol noise — and, when it does,
points at media_overview({ path, ocr: "force" }) to re-recognize the pages.
(文档文字层看起来不可靠时会提示，可用 ocr: "force" 强制重新识别)

For audio it also reports a quick health check — average level, speech ratio and silence ratio
— so you know whether the recording actually contains audible speech before you spend an ASR
call on it. A recording that is effectively silent is reported as such and is never sent to ASR
(no hallucinated transcript).

It also shows ONE outline for the file, from the first available source: the bookmark sidecar
("<file>.mmgrep.bookmark.json", written by media_bookmark) when one exists, otherwise the
file's own outline — PDF bookmarks (PHYSICAL page numbers, the same 1-based numbers
media_overview accepts) or chapter markers in video/audio (title + start/end timestamps).
Every line carries a bookmark id ("b3  p.12  title" for PDFs, "b3  00:12:34  title" for
video/audio) — these are the ids media_bookmark accepts. When a sidecar exists, the last
outline line is "full detail: <sidecar path>": read that file for the complete outline.
The text shows at most 2 levels / 60 entries; structuredContent.outline has every entry, the
source and the sidecar path. Read-only: probing never creates or modifies a sidecar.
(读取侧只展示一份目录：sidecar 优先，其次文件自带目录；行首 b1…bN 就是 media_bookmark 的 id)

It also reports the ANNOTATIONS of the file: how many there are and where they live — the
annotation sidecar ("<file>.mmgrep.annotation.json", written by media_annotate) when one
exists, otherwise the file's own annotations (PDF annotation objects). Probe reports the
COUNT and the sidecar path only; the notes themselves are shown by media_overview, next to
the page / time range they belong to ("n3 (p.12): note" for PDFs, "n3 (00:12:34–00:12:39):
note" for video/audio). media_locate can also search the annotation text. Read-only:
probing never creates or modifies a sidecar.
(读取侧也展示批注：条数 + 侧车路径；note 本身在 overview 里按页 / 时间范围展示)

This server never downloads anything and never calls an LLM: you always pass a local absolute
path, and it only prepares images and text for your own model to look at.
```

### 4.2 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|:---:|---|---|
| `path` | string | ✅ | — | 本地文件绝对路径。拒绝 URL 与相对路径。 |
| `subtitle` | string \| integer | ❌ | — | 显式选择字幕来源（一个参数三种形态）。**绝对路径** → 本地字幕文件（`.srt`/`.vtt`/`.ass`/`.ssa`）；**非负整数** → ffprobe 流 index，必须是文本型字幕轨；**其他字符串** → 语言码，匹配轨的 `tags.language`（大小写不敏感，`zh` 也匹配 `chi`/`zho`，`en` 匹配 `eng`）。显式选择是排他的：不可用就报错，不回退。 |
| `transcript` | `"auto"` \| `"subtitle"` \| `"off"` | ❌ | `"auto"` | `"auto"` 字幕优先、ASR 兜底；`"subtitle"` 只读字幕、**绝不**调用 ASR，无字幕来源时 `segments = []` 并在 `transcript.reason` / `warnings` 说明；`"off"` 字幕与 ASR 都不做，`transcript.source = "none"`。 |

### 4.3 返回结构

`content` 里只有 **一个 text 块**（无图片），同时带 `structuredContent`：

| 字段 | 类型 | 含义 | 单位 |
|---|---|---|---|
| `mediaType` | `"video"` \| `"audio"` \| `"document"` | 判定出的媒体类型 | — |
| `path` | string | 解析后的绝对路径 | — |
| `sizeBytes` | integer | 文件大小 | byte |
| `modifiedMs` | integer | 最后修改时间（epoch） | ms |
| `durationMs` | integer \| null | 总时长（video/audio） | ms |
| `durationSec` | number \| null | 总时长（video/audio） | s |
| `width` | integer \| null | 画面宽（video，旋转已归一） | px |
| `height` | integer \| null | 画面高（video，旋转已归一） | px |
| `fps` | number \| null | 平均帧率（video） | fps |
| `rotation` | integer \| null | 旋转角，归一到 (-180,180] | 度 |
| `aspect` | number \| null | 显示宽高比（含 SAR 修正） | 比值 |
| `videoCodec` | string \| null | 视频编码名（video） | — |
| `container` | string \| null | 容器格式名 | — |
| `hasAudio` | boolean | 是否含音频流 | — |
| `audioCodec` | string \| null | 音频编码名 | — |
| `audioChannels` | integer \| null | 声道数 | 个 |
| `sampleRateHz` | integer \| null | 采样率 | Hz |
| `audioHealth` | object \| null | 音频体检结果（video/audio 才有；见 §4.3.1） | — |
| `pageCount` | integer \| null | 总页数（document） | 页 |
| `hasTextLayer` | boolean \| null | 是否已有文字层（document；**采样**首页/中间页/末页的结论，见 §4.3.2；本机没有文字抽取器时为 `null` = 判不出来） | — |
| `outline` | object \| null | 唯一一份目录（0.3.0 统一读取侧，见 §15.10）：来源依次是 bookmark sidecar → 文件自带目录（PDF 书签 / 视频录音章节）→ 文档 heading 生成（仅 overview）。没有目录时 `available = false` 且 `reason` 写明原因；`media` 是条目位置的口径（PDF 用页、视频/录音用时间），跑不到目录时可能为 `null` | — |
| `outline.available` | boolean | 是否有可展示的目录 | — |
| `outline.source` | `"sidecar"` \| `"pdf-bookmarks"` \| `"chapters"` \| `"headings"` \| null | 本次实际使用的来源；`sidecar` 永远优先 | — |
| `outline.media` | `"pdf"` \| `"video"` \| `"audio"` \| `"image"` \| null | 目录条目按哪种媒体格式化（决定 `p.` 还是时间戳） | — |
| `outline.generated` | boolean | 是否由 heading 生成（`source = "headings"` 时为 true） | — |
| `outline.total` | integer | 完整目录的条目总数（不是 probe 文本展示的条数） | 条 |
| `outline.entries[]` | array | **完整**目录，不截断（probe 文本最多 2 层 / 60 条）；条目带稳定的 `id` | — |
| `outline.entries[].id` | string | `b1`、`b2` …；与 media_bookmark 的 id 完全一致 | — |
| `outline.entries[].title` | string | 条目标题 | — |
| `outline.entries[].level` | integer | 书签层级，从 1 开始（PDF 目录才有） | — |
| `outline.entries[].page` | integer \| null | **物理**页码（与 `pages` 参数同一口径；PDF 目录才有） | 页 |
| `outline.entries[].label` | string \| null | 打印页标签（文件自带 PDF 书签且定义了 `/PageLabels` 时才有，如 `"xii"`、`"37"`；sidecar 条目不存 label） | — |
| `outline.entries[].start` / `end` | number | 章节起止，秒（video/audio）；`end` 可省略 | s |
| `outline.sidecarPath` | string \| null | 存在（或损坏）的 bookmark sidecar 绝对路径；只在有 sidecar 时出现 | — |
| `outline.sidecarError` | string \| null | sidecar 存在但读不了时的短原因（含路径）；此时目录回退到文件自带 / heading 生成 | — |
| `outline.reason` | string \| null | 没有目录 / 读不了目录的人话原因（如 qpdf 未安装、文件没有章节、sidecar 为空） | — |
| `annotations` | object | 唯一一份批注摘要（§16.10）：来源依次是 annotation sidecar → 文件自带 PDF 批注；对没有批注面的媒体（txt / Office）是 `media: null`、`available: false` 的对象 | — |
| `annotations.available` | boolean | 是否有批注 | — |
| `annotations.source` | `"sidecar"` \| `"file"` \| null | 批注来源 | — |
| `annotations.media` | `"pdf"` \| `"video"` \| `"audio"` \| `"image"` \| null | 批注媒体类型 | — |
| `annotations.total` | integer | 批注总数 | 条 |
| `annotations.sidecarPath` | string \| null | annotation sidecar 路径（存在或损坏时） | — |
| `annotations.sidecarError` | string \| null | sidecar 读不了时的短原因 | — |
| `annotations.reason` | string \| null | 没有批注 / 读不了的人话原因 | — |
| `annotations.note` | string \| null | 额外提示（例如损坏时「已回退到文件自带批注」） | — |
| `subtitleTracks` | array | 内嵌字幕轨 | — |
| `subtitleTracks[].index` | integer | 轨道序号 | — |
| `subtitleTracks[].language` | string \| null | 语言标签（BCP-47，可能为 null） | — |
| `subtitleTracks[].codec` | string \| null | 轨道编码（`subrip` / `ass` / …） | — |
| `subtitleTracks[].default` | boolean | 是否默认轨 | — |
| `audioTracks` | array | 音轨列表（结构同上，去掉 `default`） | — |
| `capabilities.asr.available` | boolean | 本文件能否做 ASR | — |
| `capabilities.asr.provider` | string \| null | 生效的 ASR provider 名 | — |
| `capabilities.asr.reason` | string \| null | 不可用时的原因（人话） | — |
| `capabilities.ocr.available` | boolean | 本文件能否做 OCR | — |
| `capabilities.ocr.provider` | string \| null | 生效的 OCR provider 名（只处理无文字层页） | — |
| `capabilities.ocr.reason` | string \| null | 不可用时的原因 | — |
| `capabilities.typeset.available` | boolean | 本文件能否做 typeset（有文字层页的阅读顺序 / 结构） | — |
| `capabilities.typeset.provider` | string \| null | 生效的 typeset provider 名（`builtin` 表示本地内置） | — |
| `capabilities.typeset.reason` | string \| null | 不可用时的原因 | — |
| `capabilities.transcriptSource` | `"subtitle"` \| `"text"` \| `"ocr"` \| `"asr"` \| `"visual"` \| `"mixed"` \| `"none"` | 本次探针判定会走哪条转写来源（可信度口径，见 §2.5）。文档的 `text` = 原生文字层；`mixed` = 文字层与 OCR 都可用，逐页路由结果可能混合 | — |
| `capabilities.transcriptOrigin` | `"file"` \| `"embedded"` \| `"textlayer"` \| `"asr"` \| `"ocr"` \| `"none"` | 来源渠道（外部文件 / 内嵌轨 / PDF 文字层 / ASR / OCR）。`transcriptSource = "mixed"` 时给主要渠道（`textlayer` 优先），逐页口径以结果里的 `segments[].origin` 为准 | — |
| `capabilities.transcriptPath` | string \| null | 若来源是文件，具体是哪个文件 | — |
| `capabilities.transcriptReason` | string \| null | 文件里有字幕轨、但本次没有用上时的可读原因（如只剩图形字幕轨）；与 `warnings` 中的条目同源 | — |
| `capabilities.textLayer.checked` | boolean | 是否真的查过文字层（document） | — |
| `capabilities.textLayer.reason` | string \| null | 判不出来时的原因（本机没装文字抽取器）；与「这份文档没有文字层」不是一回事 | — |
| `capabilities.textLayer.sampledPages` | integer[] | 计划采样的页码，按采样顺序 | 页 |
| `capabilities.textLayer.checkedPages` | integer[] | 实际读过的采样页（提前返回时比 `sampledPages` 短） | 页 |
| `capabilities.textLayer.textPage` | integer \| null | 第一个读到文字的采样页（`null` = 全部采样页都空，或根本没查） | 页 |
| `capabilities.textLayer.reliable` | boolean \| null | 采样页文本看起来是否可信（9z5.31 启发式：U+FFFD / 私用区 / 孤立单字母 / 非词 token）。`null` = 没样本可判（没有文字层、非 PDF，或本机没装抽取器） | — |
| `capabilities.textLayer.reasons` | string[] | 判定为不可靠的原因（人话，逐条）；可靠时为空数组 | — |
| `capabilities.textLayer.warning` | string \| null | 不可靠时的完整提示：`looks unreliable (<原因>) — consider media_overview({ path, ocr: "force" })`；可靠时为 `null` | — |
| `recommended.mode` | `"single"` \| `"sequence"` | 短素材一次读完 / 长素材分段读 | — |
| `recommended.segmentSec` | integer | 分段读时的建议窗口长度 | s |
| `recommended.overviewImages` | integer | 建议的 overview 图片数 | 张 |
| `recommended.cellsPerImage` | integer | 建议的每图格数 | 格 |
| `recommended.estimatedImageTokens` | integer | 按默认形状估算的图片 token | token |
| `recommended.note` | string | 一句话读法建议（人话，可直接给模型看） | — |

#### 4.3.1 音频体检（`audioHealth`）

**目的：在跑 ASR 之前先判断「这录音里到底有没有有效人声」。** 太安静的录音送进 ASR，模型会给你编出一整段幻觉台词——比没有转写更糟。

| 字段 | 类型 | 含义 | 单位 |
|---|---|---|---|
| `audioHealth.verdict` | `"has-speech"` \| `"too-quiet"` \| `"silent"` \| `"no-audio-track"` | 体检结论 | — |
| `audioHealth.meanDbfs` | number \| null | 全片平均音量（RMS 折算 dBFS，负数） | dBFS |
| `audioHealth.peakDbfs` | number \| null | 峰值音量 | dBFS |
| `audioHealth.speechRatio` | number \| null | 非静音时长 / 总时长 | 0–1 |
| `audioHealth.silenceRatio` | number \| null | 静音时长 / 总时长（= 1 − `speechRatio`） | 0–1 |
| `audioHealth.effective` | boolean | 是否认为「有有效声音」 | — |
| `audioHealth.note` | string | 一句话说明（人话，可直接给模型看） | — |

**判定阈值（可配，见 §12.5）：**

| verdict | 条件 | 行为 |
|---|---|---|
| `no-audio-track` | 文件里没有音频流 | 转写为空 |
| `silent` | `meanDbfs < -60` | 转写为空 |
| `too-quiet` | `meanDbfs < MMGREP_AUDIO_MIN_DBFS`（默认 `-35`）**或** `speechRatio < MMGREP_AUDIO_MIN_SPEECH_RATIO`（默认 `0.05`） | **按「无有效声音」处理**：不跑 ASR（避免幻觉段落），`capabilities.asr.available = false`，`reason` 写明原因 |
| `has-speech` | 其余 | 正常转写 |

**静音判定用的短时门限是 `-45 dBFS`**（短时 RMS 低于它算静音段），`speechRatio` 按此统计。

`effective = false` 时，`media_overview` / `media_locate` **不会**调用 ASR，而是返回空转写 + 明确原因。agent 应据此改用「只看画面」或要求用户换一份更清楚的录音。

#### 4.3.2 文字层探测（`hasTextLayer` / `capabilities.textLayer`）

文档的「有没有文字层」是**采样**结论，不是逐页保证：

- 采样页 = 首页 / 中间页（`ceil(n/2)`）/ 末页，按这个顺序去重（`n ≤ 2` 时自然退化）。
- 任一采样页有非空文字 → `hasTextLayer = true`，并在该页**提前结束**采样（`capabilities.textLayer.checkedPages` 只记读到的那几页）。
- 全部采样页都空 → `hasTextLayer = false`（全篇扫描件仍然是这个结论）。
- 本机**一个文字抽取器都没装**（pdftotext / mutool）→ `hasTextLayer = null`（= **判不出来**，不是「没有文字层」），`capabilities.textLayer.reason` 写明原因。

为什么不能只看第 1 页：图片封面 / 扫描信笺头 / 期刊 cover page 后面接数字正文，是极常见的 PDF 形态。只看第 1 页会把这种文档误判成「只能靠 OCR」，而 OCR provider 往往根本没配，于是一本能直接抽全文的文档被判死。

**逐页**结论不在这个探针字段上，而在抽取路径上：`media_overview` / `media_locate` 逐页拿文字层（有文字层的页可以按原样引用，没有的才需要 OCR）。

非 PDF 的两个例外：`txt` / `md` 恒为 `hasTextLayer = true`（文件本身就是文字层，`checked = true`，采样页为空数组）；图片类文档恒为 `hasTextLayer = false`（`checked = true`，没有文字层可查）。两者都不会出现 `null`。

**可疑文字层（9z5.31，最小启发式）：**「有文字层」不等于「文字是对的」——有些 PDF 的文字层是早先劣质 OCR 工具写进去的。probe 会对采样到的页文本（第一个命中的采样页）做一次保守检查，命中任一条件就报不可靠：

| 信号 | 阈值 | 为什么 |
|---|---|---|
| U+FFFD 替换字符 | ≥ 3 个，或占非空白字符 ≥ 0.2% | 字体 / 编码映射坏掉的典型症状 |
| 私用区字符（U+E000–U+F8FF） | ≥ 5 个，或占非空白字符 ≥ 0.5% | ToUnicode 映射缺失时的常见产物（正常 PDF 偶有零星图标字符，故不按 1 个就报） |
| 孤立单字母 token | ≥ 25% 的「有字母或数字的 token」 | 劣质 OCR「一个字一个字往外蹦」；正常论文约 2%–4% |
| 非词 token（不含字母 / 数字） | ≥ 30% 的 token | 符号噪声；正常论文约 0%–2% |

样本少于 20 个 token 时不按比例判定（避免一两个字符就误报）。判定结果写入 `capabilities.textLayer.reliable / reasons / warning`，文本输出把 `text layer:` 行换成：

```
text layer: looks unreliable (96% of word tokens are isolated single letters; 34% of tokens contain no letter or digit) — consider media_overview({ path, ocr: "force" })
```

这只是**提示**，不是断言：agent 看到后应改用 `media_overview({ path, ocr: "force" })`（或对指定页 force），让 OCR provider 重新识别；需要 OCR provider 已配置。

文本输出里的 `textLayer="..."` 属性随探针文案一并调整（见 9z5.21）：`null` 要渲染成 `unknown`，不能渲染成 `no` —— 否则等于在说「这份 PDF 没有文字层」。

### 4.4 文本输出形态

```
<media path="/abs/a.mp4" type="video" duration="600.00" durationMs="600000"
  size="1920x1080" fps="25.00" codec="h264" audio="present" container="mov,mp4"
  subtitles="no" />
asr: unavailable — MMGREP_ASR_PROVIDER is "none". Transcription will be empty.
ocr: not applicable to this media type.
typeset: not applicable to this media type.
transcript source: none
chapters: none — this file has no chapters (no chapter metadata in the container).
One overview is enough. media_overview({ path }) is the next step.
```

音频（体检结果也要出现在文本里，因为 agent 要靠它决定下一步）：

```
<media path="/abs/a.m4a" type="audio" duration="1845.00" durationMs="1845000"
  codec="aac" channels="1" samplerate="44100" audio="present" container="mov,mp4"
  subtitles="no" />
audio health: too-quiet — mean level -41.2 dBFS, speech ratio 3.1%
  The recording is too quiet or almost entirely silent; ASR is skipped to avoid hallucinated lines.
asr: unavailable — The recording is too quiet or almost entirely silent; ASR is skipped to avoid hallucinated lines.
ocr: not applicable to this media type.
typeset: not applicable to this media type.
transcript source: none
chapters: none — this file has no chapters (no chapter metadata in the container).
No usable speech detected; only metadata and waveform are available.
```

文档（0.2.0 起分行给出文字层 / 两个 provider 角色 / 实际来源，不再有互相矛盾的两行）：

```
<media path="/abs/a.pdf" type="document" pages="28" textLayer="yes" container="pdf" subtitles="no" />
asr: not applicable to this media type.
text layer: yes (sampled pages 1, 14; first text on page 1).
ocr provider: none — No OCR provider is configured (MMGREP_OCR_PROVIDER is "none"). Pages without a text layer are returned as page images only.
typeset provider: builtin.
transcript source: text
outline: none — this PDF has no bookmarks (no outline).
One overview shows page thumbnails and page text. Use media_zoom({ path, page }) to read a page closely.
```

文字层看起来是坏的时候（9z5.31），`text layer:` 行换成带下一步动作的形式：

```
text layer: looks unreliable (96% of word tokens are isolated single letters; 34% of tokens contain no letter or digit) — consider media_overview({ path, ocr: "force" })
```

- `text layer:` 与 `textLayer` 属性都是三态：`yes` / `no` / `unknown`（本机没有文字抽取器，**判不出来**，不是「没有文字层」）；`textLayer` 属性仍按「有没有文字层」给 `yes`，可疑结论只在分行里表达。
- `capabilities.textLayer.reliable = false` 时 agent 应改用 `ocr: "force"` 重新识别（见 §5.2 / §7.2）；可靠时 `reliable = true`、`warning = null`。
- `ocr provider:` / `typeset provider:` 分别说明两个角色；`none` 时附原因。
- `transcript source:` 是实际会走的来源：`text`（原生文字层 / 纯文本）、`ocr`（只有 OCR）、`mixed`（文字层与 OCR 都可用，逐页路由可能混合）、`none`。
- 旧输出里「OCR 不可用」与「文字来源是 OCR」同时出现的那种自相矛盾的说法不会再出现：provider 行描述角色可用性，`transcript source:` 描述实际文字来源，二者不是一回事。

**唯一一份目录（0.3.0）**——probe 在 `transcript` 行之后列出目录；来源是 bookmark sidecar、PDF 书签、
视频/录音章节三者中第一个可用的，不合并。行格式处处一致：PDF 是 `b1  p.1  title`（行首两空格表示
下一层），视频 / 录音是 `b1  00:00  title`；`b1…` 就是 media_bookmark 的 id。

```
outline: PDF outline — 24 entries — use the outline to pick a range
b1  p.1  Engineered human Argonaute 2 for targeted C-to-U RNA base editing
  b2  p.1  1.1 Loop-inducing gRNAs enable RNA editing by AGO2–APOBEC3A (A3A) fusions
b3  p.4  Methods
  ...
  +N more (full outline in structuredContent.outline)
How to read: use the outline to pick a range, e.g. media_overview({ path, pages: "1-5" }).
```

视频 / 录音的章节用时间戳，提示改成 `start` / `end`：

```
outline: container chapters — 4 chapters — use the outline to pick a range
b1  00:00  Opening
b2  00:02  Build Up
b3  00:05  Main Section
b4  00:09  Wrap Up
How to read: use the outline to pick a range, e.g. media_overview({ path, start: 0, end: 2 }).
```

文档没有书签、但请求范围里 ≥5 个 heading 时（只有 `media_overview` 会生成；probe 不生成）：

```
outline: generated from headings — 6 entries (best-effort: built from block structure; full outline in structuredContent.outline and manifest.json)
b1  p.1  1. Introduction
  b2  p.1  1.1 Scope
b3  p.3  2. Methods
...
```

- 首行说明来源（`sidecar` / `PDF outline` / `container chapters` / `generated from headings`）与条数；
  probe 文本最多 **2 层 / 60 条**，其余写 `+N more`；完整目录永远在 `structuredContent.outline`
  （overview 还写进 `manifest.json`）。
- **有 bookmark sidecar 时**：来源行是 `outline: sidecar — N entries — ...`，目录块最后一行是
  `full detail: /abs/a.pdf.mmgrep.bookmark.json`；probe 的 `How to read:` 行在目录块之后。
- 没有 sidecar 时，条目 id 由共享 derive 助手按文件自带目录顺序推导（b1…bN），与 media_bookmark
  首次导入完全一致；PDF 条目给**物理页码**（`pages` 参数接受的就是物理页），文件自带书签定义了
  `/PageLabels` 时 `structuredContent` 里另带 `label`（文本不显示 label）。
- 读取 PDF 书签用 qpdf（`pdftotext` / `pdfinfo` 读不了 outline）；qpdf 未安装时输出
  `outline: none — PDF bookmarks cannot be read: qpdf is not installed (...)`，不会静默省略。
- 没有书签的 PDF 输出 `outline: none — this PDF has no bookmarks (no outline).`；视频/录音没有章节时
  输出 `chapters: none — ...`。sidecar 损坏时回退到文件自带目录，并多一行
  `note: the bookmark sidecar "<path>" could not be read (...) — showing PDF outline instead.`。
- probe 还输出批注条数与 annotation sidecar 路径（§16.10）：

```
annotations: 2 (sidecar)
annotation sidecar: /abs/a.pdf.mmgrep.annotation.json
```


### 4.5 错误行为

- `path` 校验见 §2.4。
- `subtitle` 显式选择但不可用（文件不存在 / 不可读 / 不是字幕文件；轨道不存在 / 不是字幕轨 / 是图形字幕轨 / 没有段落；语言码无命中）→ **不报错**（probe 只报告，不使用）：`capabilities.transcriptSource = "none"`，`capabilities.transcriptReason` 给出具体原因；真正的报错发生在 `media_overview` / `media_locate`。probe 也不会拿自动发现的来源冒充这次显式选择。
- 媒体类型无法判定 → `UNSUPPORTED_MEDIA_TYPE`。
- 音频体检结论为 `too-quiet` / `silent` → **不报错**，但 `capabilities.asr.available = false`，且后续转写类工具会返回空转写 + 原因（见 §4.3.1）。

---

## 5. `media_overview` — 总览

> 主体功能。一次调用把「长什么样」和「说了什么」对齐交给 agent。

### 5.1 工具描述（英文，含中文触发词）

```
Build an overview of a local media file so you can read it without guessing.
(生成媒体总览：视频出分镜宫格图与按时间对齐的文本清单；录音出带时间轴的转写；文档出页面缩略图与每页文字。)

What you get depends on the media:
- video    : one or more numbered storyboard grids (each cell carries its cell number) plus a
             time-aligned text index of the cells
- audio    : a timestamped transcript, segment by segment
- document : a grid of page thumbnails plus page text, when a document parser is configured

For DOCUMENTS, ocr: "auto" (default) uses the PDF text layer where one exists and calls the OCR
provider only for pages without one; ocr: "force" re-recognizes every requested page with the
OCR provider, even pages that already have a text layer, and tags them (ocr). Use force when
media_probe says "text layer: looks unreliable" or when the extracted text is visibly garbled.
Forced results are cached separately from auto. (文档：ocr: "force" = 强制重新 OCR / 重新识别文字层)

Pass images: 0 for a text-only, zero-pixel overview: no grid is rendered and no frame is
decoded (a video costs no ffmpeg work at all), so you get only the transcript — or the page
text for a document — and the reported budget is all zeros. Use it when you only need the words.

TEXT SOURCE ORDER — subtitles first, ASR only as a fallback:
1. a subtitle you select explicitly (external subtitle file, track index or language code),
2. the subtitle track embedded in the container,
3. a subtitle file with the same base name in the same directory (a.srt next to a.mp4),
4. ASR — only when none of the above exists and an ASR provider is configured.
Every segment is tagged with its source. subtitle = from a subtitle file/track; usually the
author's words, but may be auto-generated: check names and numbers against the frame.
asr = machine transcription: names, numbers and jargon are often wrong, so do NOT quote an ASR
segment verbatim and do not present it as the speaker's exact words. visual = there is no text
at all, only the picture.

The storyboard grid is for FINDING things, not for reading them: cells are small, so text
inside a cell is usually unreadable. To read text on screen, call media_zoom on that moment
and read the cropped single frame.

The full text is NOT inlined. It is written to disk, and the text of the result ends with a line
like "full text: /abs/path/content.md (segments.jsonl, manifest.json in the same directory)".
That absolute path is what you read: content.md is the readable full text, segments.jsonl has
one segment per line, manifest.json records what was produced and how. Read those files section
by section and summarise them in chunks yourself — do not ask for the same range again just to
get more inline text. If the export could not be written, the line reads
"full text: NOT written — <reason>" instead.

The inline text is a PREVIEW with three tiers. (1) WHOLE: the requested range fits, and the
result says "complete text ... nothing omitted". (2) SKIM (documents only, when the document
parser exposes block structure): every heading plus the first complete sentence of each
paragraph, tables as "[table: caption]", with captions/footnotes/equations left out; each page
is labelled like "[page 4 · skim: 12 of 210 sentences]". A skim built from the built-in heuristic
blocks is best-effort — section structure may be wrong; read content.md for the authoritative
text. (3) SAMPLED: complete units — document sentences, video/audio transcript segments — are
sampled evenly, with a line like "preview: sampled 84 of 312 sentences across pages 1-28; not
represented: 2-6, 8-12". In a skim that still does not fit, all headings are kept and sentences
are sampled; only when even the headings do not fit are the headings sampled. Sampling never
drops a whole page silently: pages that could not be represented are listed, and a single
over-long unit is truncated with a trailing "…[+N chars]". Read content.md when you need the
complete text.

VIEW — the view parameter controls the inline text (default "auto"). The result carries ONE
outline from the first available source: the bookmark sidecar ("<file>.mmgrep.bookmark.json",
written by media_bookmark) when one exists, otherwise the file's own outline (PDF bookmarks, or
chapter markers in video/audio); a document without bookmarks may get an outline GENERATED FROM
ITS HEADINGS when the range has at least 5 headings, labelled "outline: generated from
headings" (best-effort). (1) "auto": if the requested range fits, you get the full text; if it
does not fit and there is an outline, the outline comes first (ids b1…bN with page numbers for
PDFs, timestamps for chapters) and the rest of the budget goes to the text preview; if there is
no outline, you get the normal skim/sampled preview. (2) "outline": return only the outline —
generated from headings for a document without bookmarks; for video/audio without chapters you
get an explicit "no chapters" message and NOTHING is generated, because this server never
invents an outline from content. In that case read the overview (or a start/end window) and
write your own outline from the time-aligned text and storyboard grids. (3) "text": ignore the
outline and force the text pipeline. The full outline (entries, source, sidecar path) is always
in structuredContent.outline and, for an overview that writes an export, in manifest.json. When
a sidecar exists its last outline line is "full detail: <sidecar path>" — read that file for the
complete bookmark detail.
(目录：sidecar 优先，其次文件自带目录，最后才是 heading 生成；view:auto 放不下时先出目录；view:outline 只出目录；view:text 只出文本)

The result also carries the ANNOTATIONS of the requested range, right next to the page /
time range they belong to: the annotation sidecar ("<file>.mmgrep.annotation.json", written
by media_annotate) when one exists, otherwise the file's own annotations (PDF annotation
objects). One annotation per line, in the same shape media_annotate writes
("n3 (p.12): note" for PDFs, "n3 (00:12:34–00:12:39): note" for video/audio). The line
starts with the annotation id (n1, n2, …) — these are the ids media_annotate accepts. The
author is in structuredContent.annotations only; the note text is shown as written.
(批注按请求范围展示：行首 n1…nN 就是 media_annotate 的 id)

Always call media_probe first: it tells you how long the file is, whether a subtitle source
exists, which transcript source applies, and which outline applies (bookmark sidecar first,
then the file's own PDF bookmarks / video-audio chapters, or headings for a document), for
free. Long media must be narrowed with
start/end (video, audio) or pages (document) — one giant grid of a two-hour film gives you
illegible cells and spoils the ending. Follow the continuation hint in the result to page
through the rest.
```

### 5.2 参数

| 参数 | 类型 | 必填 | 默认 | 适用 | 说明 |
|---|---|:---:|---|---|---|
| `path` | string | ✅ | — | 全部 | 本地绝对路径 |
| `subtitle` | string \| integer | ❌ | — | video, audio | 显式选择字幕来源：本地字幕文件绝对路径 / 字幕轨 index / 语言码（规则见 §8.5） |
| `transcript` | `"auto"` \| `"subtitle"` \| `"off"` | ❌ | `"auto"` | video, audio | `"auto"` 字幕优先、ASR 兜底；`"subtitle"` 只读字幕、绝不跑 ASR（无字幕来源时 `segments = []` 并说明原因）；`"off"` 字幕与 ASR 都不做（只出画面） |
| `start` | number | ❌ | `0` | video, audio | 起点（秒，浮点） |
| `end` | number | ❌ | 媒体末尾 | video, audio | 终点（秒，浮点） |
| `segment` | integer | ❌ | `300` | video, audio | 只给 `start` 不给 `end` 时的窗口长度（秒，30–3600） |
| `pages` | string | ❌ | 全文 | document | 页码范围，如 `"3-10,15"` |
| `ocr` | `"auto"` \| `"force"` | ❌ | `"auto"` | document | 页文字的获取方式。`"auto"`：有文字层就用文字层，只有没文字层的页走 OCR；`"force"`：请求的页**无论有没有文字层**都交给 OCR provider 重新识别，结果 `textOrigin = "ocr"`、页标 `(ocr)`，并单独缓存（不覆盖 auto 结果）。用在 probe 说 `text layer: looks unreliable` 时。需要已配置 OCR provider（`MMGREP_OCR_PROVIDER`），否则报 `PROVIDER_NOT_CONFIGURED`；纯文本 `.txt` / `.md` 没有页图，force 会报 `INVALID_ARGUMENT`；video / audio 传它报 `INVALID_ARGUMENT` |
| `view` | `"auto"` \| `"outline"` \| `"text"` | ❌ | `"auto"` | 全部 | 内联文字的内容。`"auto"`：请求范围放得下就给全文；放不下且有目录时先出目录，余量给文本预览；没有目录时走 skim / 抽样。目录来源按优先级：**bookmark sidecar → 文件自带 PDF 书签 / 章节 → 文档 ≥5 个 heading（只对文档生成）**，不合并（§15.10）。`"outline"`：只出这一份目录（视频/录音无章节时只给「无章节」说明，不生成内容；有 sidecar 时末行是 `full detail: <sidecar path>`）。`"text"`：忽略目录，强制走文本管线。完整目录始终在 `structuredContent.outline` 与 `manifest.json` |
| `cells` | integer | ❌ | video `9` / document `6` | video, document | 每张拼图的格数（video=镜头格，document=页缩略图），1–16 |
| `images` | integer | ❌ | `2` | video, document, audio（仅 `0`） | 返回几张拼图，`0`–`4`；`0` = 零像素纯文本模式（不出图，只回文字，`budget` 全零） |
| `maxEdge` | integer | ❌ | `1280` | video, document | 单张图最长边（px），上限 1600 |
| `envelope` | boolean | ❌ | `false` | audio | 是否附带音频包络图（P2，可选） |

### 5.3 返回结构

`content` 顺序：**先 text 块，后 image 块**（文本清单教 agent 怎么读这张宫格，所以先给）。
同时给 `structuredContent`。

| 字段 | 类型 | 含义 | 单位 |
|---|---|---|---|
| `mediaType` | string | 媒体类型 | — |
| `path` | string | 绝对路径 | — |
| `view` | `"auto"` \| `"outline"` \| `"text"` | 本次调用的 `view`（缺省为 `auto`） | — |
| `outline` | object | 本次的完整目录（sidecar / PDF 书签 / 章节 / 从 heading 生成，取第一个可用的）；`available=false` 时 `entries=[]` 且 `reason` 说明原因。字段同 §4.3 的 `outline`（含 `id` / `media` / `generated` / `sidecarPath` / `sidecarError`） | — |
| `window.startMs` / `window.endMs` | integer | 本次覆盖的时间窗 | ms |
| `window.startSec` / `window.endSec` | number | 同上，秒 | s |
| `window.pages` | integer[] \| null | 本次覆盖的页码（document） | 页 |
| `window.clipped` | boolean | `end` 是否被裁剪到媒体末尾（见 §2.3） | — |
| `images[]` | array | 返回的拼图 | — |
| `images[].index` | integer | 第几张（1-based） | — |
| `images[].width` / `images[].height` | integer | 图片尺寸 | px |
| `images[].cells` | integer | 这张图里放了几格 | 格 |
| `images[].mimeType` | `"image/png"` | 图片 MIME | — |
| `images[].bytes` | integer | 编码后字节数 | byte |
| `images[].estimatedTokens` | integer | 这张图的 token 估算 | token |
| `images[].source` | `"visual"` | 图内容恒为画面（宫格图里没有任何可引用的文字） | — |
| `segments[]` | array | 实际内联的单元清单（**节选**：文档 = 句子，视频/录音 = 转写段落） | — |
| `segments[].index` | integer | 序号（1-based；文档为句子在全文单元列表里的位置，`preview.mode = "skim"` 时为 skim 单元序号） | — |
| `segments[].startMs` / `endMs` | integer \| null | 时间范围（document 为 null） | ms |
| `segments[].startSec` / `endSec` | number \| null | 同上，秒 | s |
| `segments[].text` | string | 该段文字（可能为 ""，表示无台词） | — |
| `segments[].source` | `"subtitle"` \| `"text"` \| `"ocr"` \| `"asr"` \| `"visual"` \| `"none"` | 这段文字的来源与可信度（见 §2.5）。文档逐页：原生文字层 = `text`，OCR / 未声明 = `ocr`，无文字 = `none` | — |
| `segments[].origin` | `"file"` \| `"embedded"` \| `"textlayer"` \| `"asr"` \| `"ocr"` \| `"none"` | 来源渠道（文档：`textlayer` = PDF 文字层，`file` = `.txt` / `.md`） | — |
| `segments[].textOrigin` | `"textlayer"` \| `"ocr"` \| `"unknown"` \| null | 文档 provider / 抽取层对**这一页**的声明（`source` 就是按它映射的）；视频 / 录音为 null | — |
| `segments[].page` | integer \| null | 页码（document） | 页 |
| `transcript.source` | `"subtitle"` \| `"text"` \| `"ocr"` \| `"asr"` \| `"visual"` \| `"mixed"` \| `"none"` | 整份转写的来源与可信度。文档 `mixed` = 返回页的逐页标签不一致，看每页的 `source` | — |
| `transcript.origin` | `"file"` \| `"embedded"` \| `"textlayer"` \| `"asr"` \| `"ocr"` \| `"none"` | 来源渠道。`transcript.source = "mixed"` 时只表示主要渠道（`textlayer` 优先），逐页以 `segments[].origin` 为准 | — |
| `transcript.language` | string \| null | 语言 | — |
| `transcript.segmentCount` | integer | 总段落数（全文，不是节选数） | 条 |
| `transcript.provider` / `transcript.model` | string \| null | 本次实际用到的解析 provider 与模型（没有外部 provider 时为 null；两个角色都用同一 provider 时只出现一次） | — |
| `transcript.ocrProvider` | string \| null | 本次实际处理过返回页的 OCR 角色 provider（document；没用到时为 null） | — |
| `transcript.typesetProvider` | string \| null | 本次实际处理过返回页的 typeset 角色 provider（document；`builtin` = 本地内置；没用到时为 null） | — |
| `transcript.reason` | string \| null | 没有转写时的人话原因（`source = "none"` 时给出） | — |
| `pages[]` | array \| null | document 的每页文字（`{page, text, truncated}`） | — |
| `fullText.dir` | string | 全文落盘目录 | — |
| `fullText.contentMd` | string | `content.md` 绝对路径 | — |
| `fullText.segmentsJsonl` | string | `segments.jsonl` 绝对路径 | — |
| `fullText.manifestJson` | string | `manifest.json` 绝对路径 | — |
| `fullTextReason` | string \| null | 全文落盘失败的人话原因（`fullText = null` 时给出） | — |
| `truncated` | boolean | 内联清单是否是预览（`whole` 以外的 skim / sampled / outline 都是预览，不是全文） | — |
| `preview.mode` | `"whole"` \| `"skim"` \| `"sampled"` \| `"outline"` | `whole` = 请求范围整体内联（完整）；`skim` = 文档按契约 v2 blocks 速读（全部 heading + 段首句）；`sampled` = 完整单元等距抽样；`outline` = `view:"outline"` 只出目录（没有目录时给「无目录 / 无章节」说明） | — |
| `preview.units` | integer | 实际内联的单元数（skim 模式下 heading / 段首句 / 表格占位各算一个；其它模式文档 = 句子，视频/录音 = 转写段落） | 条 |
| `preview.totalUnits` | integer | 请求范围内的句子总数（文档；skim 与 sampled 同口径，逐页标注里的 N 也是它）。视频/录音为转写段落总数 | 条 |
| `preview.skimUnits` | integer | skim 模式下可用的 skim 单元总数（heading + 段首句 + 表格占位）；其它模式不出现 | 条 |
| `preview.headingsTotal` / `preview.headingsInlined` | integer | skim 模式下 heading 总数 / 实际内联的 heading 数；两者不等说明连 heading 都放不下、被等距抽样 | 条 |
| `preview.sampled` | boolean | skim 模式下是否有 skim 单元被抽样掉；其它模式不出现 | — |
| `preview.headingsSampled` | boolean | skim 模式下是否对 heading 本身做了抽样（只有全部 heading 都放不下时才为 `true`） | — |
| `preview.notRepresented` | integer[] | 没有被内联任何单元的页码（文档；其它媒体为空数组） | 页 |
| `preview.outlineSource` | `"sidecar"` \| `"pdf-bookmarks"` \| `"chapters"` \| `"headings"` \| `"none"` | 本次目录来源（有目录时出现；`sidecar` 永远优先） | — |
| `preview.outlineInlined` | integer | 实际写进内联文本的目录条目数（目录放不下时小于总数；`view:"outline"` 时也受上限约束） | 条 |
| `preview.outlineTotal` | integer | 目录条目总数（完整目录在 `structuredContent.outline`） | 条 |
| `annotations` | object | 本次范围内的批注（§16.10）：`available` / `source` / `media` / `total`（全部批注数）/ `totalInRange`（落在请求范围内的条数）/ `entries[]`（范围内的完整批注条目）/ `sidecarPath` / `sidecarError` / `reason` / `note` | — |
| `continuation` | object \| null | 续读提示 | — |
| `continuation.nextStartMs` / `nextStartSec` | integer / number | 下一段起点（video/audio） | ms / s |
| `continuation.nextPage` | integer | 下一批起始页（document） | 页 |
| `continuation.note` | string | 人话续读提示 | — |
| `budget.requestedImages` / `producedImages` | integer | 请求 vs 实际出的图数（`images: 0` 时两者都是 0） | 张 |
| `budget.requestedCells` / `producedCells` | integer | 请求 vs 实际出的格数（`images: 0` 时两者都是 0） | 格 |
| `budget.estimatedTokens` | integer | 本次总图片 token 估算（`images: 0` 时是 0） | token |
| `budget.limit` | integer | 本次调用的图片 token 上限 | token |
| `budget.warning` | string \| null | 超软预算时的降级建议 | — |

`document.json`（cangjie 契约的可选件，见 §9.4）**不在 `structuredContent.fullText` 里**：它与 `content.md` 写在同一目录，按 `fullText.dir` + `/document.json` 读取即可（overview 默认会写它）。

**全文路径必须同时出现在 `content[0].text` 里。** text 末尾固定有一行
`full text: <content.md 绝对路径> (segments.jsonl, manifest.json in the same directory)`；
落盘失败时这一行是 `full text: NOT written — <reason>`，同时 `structuredContent.fullText = null`
且 `fullTextReason` 给出原因（调用本身仍然成功）。续读提示 `continuation.note` 也出现在 text
末尾——只靠 `structuredContent` 的宿主否则永远看不到它们。

### 5.4 三种媒体的文本清单形态

**视频（video）**——按格，每行末尾标出来源：

```
<overview path="/abs/a.mp4" type="video" window="0.00-600.00" duration="600.00"
  grid="18 cells x 2 image(s)" cell="413x232" image="1280x720" tokens="~2458" audio="present"
  transcript="subtitle" origin="file" file="/abs/a.zh.srt" />
[cell 1  ] 00:00.000-00:33.333  (subtitle)  「……」
[cell 2  ] 00:33.333-01:06.667  (subtitle)  「……」
...
cost: 2 image(s) x ~1229 = ~2458 vision tokens · transcript from subtitle (/abs/a.zh.srt)
note: the grids are for locating. To read text on screen, media_zoom({ path, at }) and read
      the cropped single frame.
note: source is subtitle — from a subtitle file/track; usually the author's words, but may be
      auto-generated: check names and numbers against the frame.
full text: /home/me/.cache/multimediagrep/ab/12…/content.md (segments.jsonl, manifest.json in the same directory)
```

**零像素纯文本模式（`images: 0`）**——没有宫格就没有格位，段落按转写行列出：

```
<overview path="/abs/a.mp4" type="video" window="0.00-600.00" duration="600.00"
  audio="present" transcript="subtitle" origin="file" file="/abs/a.zh.srt" />
[seg 1   ] 00:00.000-00:03.120  (subtitle)  「……」
[seg 2   ] 00:03.120-00:07.480  (subtitle)  「……」
...
note: text-only mode (images: 0) — no storyboard grid was rendered and no frame was decoded.
note: to see the picture, call media_zoom({ path, at }) for a single frame.
note: source is subtitle — from a subtitle file/track; usually the author's words, but may be
      auto-generated: check names and numbers against the frame.
full text: /home/me/.cache/multimediagrep/ab/12…/content.md (segments.jsonl, manifest.json in the same directory)
```

**录音（audio）**——按段落：

```
<overview path="/abs/a.m4a" type="audio" duration="1845.00" transcript="asr" origin="asr"
  segments="212" />
[seg 1   ] 00:00.000-00:04.120  (asr)  「……」
[seg 2   ] 00:04.120-00:09.480  (asr)  「……」
note: source is asr — machine transcription. Names, numbers and jargon may be wrong; do not
      quote these lines as the speaker's exact words.
full text: /home/me/.cache/multimediagrep/ab/12…/content.md (segments.jsonl, manifest.json in the same directory)
```

**文档（document）**——按页。header 不再有 `text` 属性，改为 `source` + 本次实际处理返回页的角色：

```
<overview path="/abs/a.pdf" type="document" pages="1-12" grid="12 pages x 2 image(s)"
  image="1280x720" tokens="~2458" source="text" typesetProvider="builtin" />
[page 1  ] (text)  「……」
[page 2  ] (text)  「……」 「……」
preview: sampled 84 of 312 sentences across pages 1-12; not represented: 8-12.
note: page text comes from the native text layer (or the plain-text file) — characters are exact and may be quoted.
full text: /home/me/.cache/multimediagrep/ab/12…/content.md (segments.jsonl, manifest.json in the same directory)
```

逐页来源不一致时（封面是扫描图、正文是文字层），整份是 `source="mixed"`，只有真正 OCR 过的页标 `(ocr)`：

```
<overview path="/abs/a.pdf" type="document" pages="1-4" source="mixed"
  ocrProvider="mineru" typesetProvider="builtin" />
[page 1  ] (ocr)  「……」
[page 2  ] (text)  「……」
...
note: page sources differ — read the tag on each page (text = character-exact native text, ocr = machine recognition).
note: some page text comes from OCR — names, numbers and jargon may be misread; verify them
      against the page image via media_zoom({ path, page }).
full text: /home/me/.cache/multimediagrep/ab/12…/content.md (segments.jsonl, manifest.json in the same directory)
```

文字层不可靠、agent 用 `ocr: "force"` 重新识别后（请求页全部是 `(ocr)`；header 的 `source="ocr"`，`ocrProvider` 指向实际做识别的 provider）：

```
<overview path="/abs/a.pdf" type="document" pages="1-12" source="ocr" ocrProvider="mineru" />
[page 1  ] (ocr)  「……」
[page 2  ] (ocr)  「……」
note: some page text comes from OCR — names, numbers and jargon may be misread; verify them
      against the page image via media_zoom({ path, page }).
full text: /home/me/.cache/multimediagrep/ab/12…/content.md (segments.jsonl, manifest.json in the same directory)
```

OCR 的核对 note **只在真的有 OCR 页时出现**，不再无条件写给所有文档。请求范围整体放得下时是 tier 1，允许宣称完整（且只有此时可以）：

```
[page 1  ] (text)  「……」
[page 2  ] (text)  「……」
note: complete text of pages 1-2 (nothing omitted).
full text: /home/me/.cache/multimediagrep/ab/12…/content.md (segments.jsonl, manifest.json in the same directory)
```

**目录优先（0.3.0 统一目录）**——放不下且有目录时，`view:"auto"` 先给目录，余量才给文本；
`view:"outline"` 只给目录：

```
<overview path="/abs/book.pdf" type="document" pages="1-28" source="text" typesetProvider="builtin" />
outline: sidecar — 24 entries — full outline in structuredContent.outline and manifest.json
b1  p.1  Engineered human Argonaute 2 ...
  b2  p.2  Loop-inducing gRNAs ...
...
hint: pick a range with pages, e.g. media_overview({ path, pages: "1-5" }).
full detail: /abs/book.pdf.mmgrep.bookmark.json
[page 1  ] (text)  「……」
...
preview: skim — 84 of 620 sentences inlined across pages 1-28; all 24 headings kept; not represented: 21-28. Skim = headings + first sentence per paragraph (tables as [table: caption]).
full text: /home/me/.cache/multimediagrep/ab/12…/content.md (segments.jsonl, manifest.json in the same directory)
```

目录块本身也受内联预算约束：放不下时按 `maxChars` 截断，并在末尾写
`+N more entries (full outline in structuredContent.outline and manifest.json)`；连一条都放不下时
写 `(no entry fits the inline budget; read the full outline in structuredContent.outline / manifest.json)`。
**「完整 / 没有省略」的 note 只在 tier 1（whole）出现**——有目录 + 预览的组合永远不会说「complete」。

- 目录来源按优先级取第一个（sidecar → 文件自带 → heading 生成），不合并；`preview.outlineSource` /
  `outlineInlined` / `outlineTotal` 说明目录内联了多少条。
- 文档目录来自 heading 时头部标 `outline: generated from headings`（best-effort；builtin 启发式 blocks
  可能把结构判错）。
- 视频/录音有章节时用 `start`/`end` 提示；没有章节时 `view:"outline"` 只回一句「no chapters」，
  **不生成**任何目录内容。
- 有 sidecar 时，目录块最后一行是 `full detail: <sidecar path>`（在 `hint` 之后、文本预览之前）。
- `view:"text"` 跳过目录；`view:"auto"` 在请求范围整体放得下时也给全文（tier 1 优先于目录）。

范围内的批注跟在目录 / 文本旁（行格式与 media_annotate 结果一致；有 sidecar 时末行 `full detail:`）：

```
annotations (1 of 2 in pages 1-12, sidecar):
n1 (p.3): check this number
full detail: /abs/book.pdf.mmgrep.annotation.json
```


**文档预览的三层（9z5.32）**：whole（整体放得下）→ skim（契约 v2 blocks 可用时）→ sampled（没有 blocks 的旧路径，或 skim 也放不下时）。视频 / 录音**没有** skim，直接 whole → sampled。

skim 的内容是全部 heading + 每个段落的第一个完整句（复用 .20 的断句函数）；table 只留
`[table: <caption>]`（没有 caption 时只写 `[table]`），caption / footnote / equation 不进
速读视图。每页标注 `[page N · skim: X of Y sentences]`：X 是这页实际内联的 skim 单元数
（heading 也算一个），Y 是这页全文的句子数。builtin 启发式 blocks 生成的 skim 会在 note 里
标 best-effort：

```
[page 4 · skim: 38 of 210 sentences] (text)  ## 2. Methods 「This section describes the assay.」 [table: Table 2 | Results]
preview: skim — 38 of 210 sentences inlined across pages 1-12; all 12 headings kept; every requested page is represented. Skim = headings + first sentence per paragraph (tables as [table: caption]). Skim was built from heuristic blocks (best-effort): section structure may be wrong.
full text: /home/me/.cache/multimediagrep/ab/12…/content.md (segments.jsonl, manifest.json in the same directory)
```

skim 自己仍放不下时：**heading 全部保留**，段首句按页等距抽样（`preview.sampled = true`，
`preview.headingsInlined = preview.headingsTotal`）；只有连 heading 都放不下时才对 heading
本身等距抽样（`preview.headingsSampled = true`）。没有 blocks 的旧路径不做 skim，行为与
.20 一致：

```
[page 1  ] (text)  「……」
preview: sampled 84 of 312 sentences across pages 1-12; not represented: 8-12.
full text: /home/me/.cache/multimediagrep/ab/12…/content.md (segments.jsonl, manifest.json in the same directory)
```

### 5.5 降级形态（没有 ASR / OCR 时）

| 情形 | 降级行为 | agent 能看到什么 |
|---|---|---|
| video，有**字幕**（文件或内嵌轨） | 用字幕，`transcript.source = "subtitle"`，**不跑 ASR** | 画面 + 字幕文字（通常是作者原话，但可能是自动生成的，专名数字要核对画面） |
| video，无字幕但有音轨，`MMGREP_ASR_PROVIDER=none` | 照常出宫格图；`transcript.source = "none"`；每格 `text` 为空；清单末尾给出原因 | 只有画面。不能编造台词 |
| video，无音轨 | 同上，原因写「no audio track」 | 只有画面 |
| audio，**体检结论 too-quiet / silent** | **不跑 ASR**（避免幻觉段落）；`transcript.source = "none"`；说明写明「no effective speech」 | 什么都没有，只有一句说明 + 原因 |
| audio，有字幕但无 ASR | 用字幕，`transcript.source = "subtitle"` | 画面 + 字幕文字（同上，核对专名与数字） |
| document，**有文字层** | 不再把所有页标成 `ocr`：文字层页 `source = "text"`、`origin = "textlayer"`（字符精确，可引用）；`transcript.source = "text"`（有 OCR 角色参与时可能是 `mixed`） | 页面缩略图 + 文字层正文；无需为核对字符去 zoom |
| document，图片封面 + 数字正文 | 封面无文字（没配 OCR 时 `source = "none"`，配置 OCR 后为 `ocr`）；正文 `source = "text"`；整份 `transcript.source = "mixed"` | 每页行首标签 `(text)` / `(ocr)` / 不出现（无文字页）；按标签决定是否核对 |
| document，文字层像劣质 OCR 且**没有** OCR provider | probe 报 `text layer: looks unreliable (...)`；`media_overview({ ocr: "force" })` 报 `PROVIDER_NOT_CONFIGURED`（不静默退回坏文字层） | probe 的提示 + 错误 hint；可以先看页图，或配置 OCR provider 后重试 |
| document，文字层像劣质 OCR 且**配置了** OCR provider | `ocr: "force"` 重新识别请求页，逐页 `(ocr)`；auto 仍按原文字层（结果分开缓存） | 重新识别后的页文字 + 页图；专名数字仍建议核对 |
| document，`MMGREP_OCR_PROVIDER=none` 且无文字层 | 照常出页缩略图宫格；`pages[].text` 为空；`transcript.source = "none"` | 只有页面缩略图 |
| document，扫描件且 OCR 未配置 | 同上，且 `capabilities.ocr.available = false` | 只有页面缩略图；需要读字就 `media_zoom` 单页放大 |

**关键原则一：宁可明说「没有文字」，也不要把 `transcript.source` 写成 `none` 却让文本清单看起来像有内容。** 清单里每格没有台词时，格后面明确留空并给一行 `transcript: NONE (…reason…)`。

**关键原则二：字幕优先，ASR 只作兜底。** 只要有字幕（外部文件或内嵌轨），就**不**跑 ASR——字幕通常比 ASR 准，又免费；ASR 慢、贵、还会听错人名和数字。上游 `dsh-video-storyboard` 也是这个顺序（`transcript: "auto"` = 优先内嵌字幕轨，否则才 ASR）。注意「字幕优先」说的是**成本与速度**，不是**可信度的绝对保证**：自动生成的字幕同样走这条路，专名与数字仍要核对画面（见 §2.5）。

**关键原则三：宫格图只用来「找位置」，不用来「读文字」。** 宫格的一格通常只有几百像素，里面的字基本看不清。要读画面上的字，必须 `media_zoom` 裁出单帧再看。

### 5.6 错误行为

- `path` 校验见 §2.4；范围校验见 §2.4。
- `ocr` 用在 video / audio 上 → `INVALID_ARGUMENT`（见 §2.2）。
- `ocr: "force"` 用在 `.txt` / `.md` 上 → `INVALID_ARGUMENT`（纯文本本身没有页图可重新识别，文件就是文字层）。
- `ocr: "force"` 但没有可用的 OCR provider（没配、或配了但缺 key / 回环地址之外没有 key）→ `PROVIDER_NOT_CONFIGURED`，hint 指向 `MMGREP_OCR_PROVIDER` / `MMGREP_MINERU_API_KEY`（HTTP 模式可用 `x-mmgrep-ocr-provider` 头）。这是**唯一**一种「文档 overview 直接失败」的 provider 情形：force 是明确指令，不能静默退回坏文字层。auto 模式下 provider 失败只降级：有文字层的页照常返回，其余页给页图 + 警告。
- `cells` / `images` 越界 → `BUDGET_EXCEEDED`（见 §10）。
- 需要转写但完全无来源，且调用方要求了转写 → 不报错（出画面 + 说明）。只有 `media_locate` 这种「非要有转写不可」的工具才报 `NO_TRANSCRIPT`。

---

## 6. `media_zoom` — 特写

> 一次一张图，看清某一刻 / 某一页。**贵，所以只在 overview 告诉你「这里有事」时才用。**

### 6.1 工具描述（英文，含中文触发词）

```
Get a close-up of one moment in a local video, or one page of a local document, returned as a
single image. (取本地视频某一时刻的特写单帧，或本地文档某一页的整页 / 局部放大图。)

Use it after media_overview when one cell or page needs a closer look: "what exactly is on
screen at 01:12?" "what does line 3 of page 7 say?"

For video, pass at (a single timestamp) or start/end (a window — the sharpest frame inside it
is returned, and the exact timestamp is reported back). For a document, pass page, optionally
with crop. crop is {x, y, width, height}, each a fraction 0..1 of the frame or page, origin
top-left.

Keep it to one frame. It costs roughly 1,900 vision tokens — far more than a whole overview
cell. Zoom the parts that matter instead of re-scanning the file.

This is the ONLY tool whose image is meant for reading. A storyboard cell is a few hundred
pixels wide and the text inside it is unreadable; a cropped single frame at up to 1600 px is
readable. So: locate in the overview grid, then zoom to read. The returned image is always
source "visual" — what you read off it is your own reading of pixels, not a transcript, so
treat it as an observation rather than a quotation.
```

### 6.2 参数

| 参数 | 类型 | 必填 | 默认 | 适用 | 说明 |
|---|---|:---:|---|---|---|
| `path` | string | ✅ | — | 全部 | 本地绝对路径 |
| `at` | number | ⭕ | — | video | 精确时刻（秒，浮点）。与 `start`/`end` 互斥 |
| `start` / `end` | number | ⭕ | — | video | 时间窗（秒）；窗内选最清晰的一帧 |
| `page` | integer | ⭕ | — | document | 页码（1-based） |
| `crop` | object | ❌ | 全图 | video, document | `{x, y, width, height}`，全部是 0..1 的比例，原点左上 |
| `maxEdge` | integer | ❌ | `1600` | video, document | 输出图最长边（px），上限 1600 |

**互斥与必填规则：**

- video：必须给 `at`，或 `start`+`end`（两者都在）。`at` 与 `start`/`end` 不能同时给 → `INVALID_ARGUMENT: at and start/end are mutually exclusive — pass either a single timestamp or a window.`
- document：必须给 `page`。
- 音频 → `at is not applicable to audio media. …`（见 §2.2）。
- video 未给 `page` → `page is not applicable to video media. …`
- document 未给 `page` → `INVALID_ARGUMENT: page is required for document media.`
- video 既没 `at` 也没 `start` → `INVALID_ARGUMENT: for video, pass "at" (one timestamp) or both "start" and "end" (a window).`

### 6.3 返回结构

| 字段 | 类型 | 含义 | 单位 |
|---|---|---|---|
| `mediaType` | string | 媒体类型 | — |
| `path` | string | 绝对路径 | — |
| `target.kind` | `"frame"` \| `"page"` | 特写对象 | — |
| `target.atMs` / `atSec` | integer / number | 实际取到的帧时刻（video） | ms / s |
| `target.fromMs` / `toMs` | integer | 请求的时间窗（video，用了 `start`/`end` 时） | ms |
| `target.selection` | `"exact"` \| `"sharpest"` | 帧的选取方式 | — |
| `target.page` | integer \| null | 页码（document） | 页 |
| `target.crop` | object \| null | 实际使用的裁切区域 | 比例 |
| `image.width` / `image.height` | integer | 输出尺寸 | px |
| `image.mimeType` | `"image/png"` | 图片 MIME | — |
| `image.bytes` | integer | 编码后字节数 | byte |
| `image.estimatedTokens` | integer | 图片 token 估算 | token |
| `image.source` | `"visual"` | 图片恒为画面（不是转写，也不是 OCR） | — |
| `imageCount` | integer | 恒为 `1` | 张 |
| `text` | string | 人类/模型可读说明（含时间码与裁切描述） | — |

### 6.4 文本输出形态

```
<zoom path="/abs/a.mp4" kind="frame" at="01:12.480" atMs="72480" selection="sharpest"
  window="70.00-75.00" crop="full" image="1600x900" tokens="~1920" />
one frame at 00:01:12.480 (sharpest in 70.00-75.00s), full frame, 1600x900.
```

### 6.5 错误行为

- `at` 超出媒体时长 → `OUT_OF_RANGE: at (7200.0 s) is beyond the end of the media (duration 3600.0 s).`
- `crop` 越界 → `INVALID_ARGUMENT: crop must satisfy 0 <= x, 0 <= y, x + width <= 1, y + height <= 1 (got x=0.9, width=0.3).`
- `crop` 字段缺失或类型错 → `INVALID_ARGUMENT: crop must be an object {x, y, width, height} with four numbers in 0..1.`
- `page` 越界 → `OUT_OF_RANGE: page 15 is out of range. This document has 8 pages.`

---

## 7. `media_locate` — 定位

> 「那句话在第几分钟」/ 「那句话在第几页」。默认**纯文本、零图片**。

### 7.1 工具描述（英文，含中文触发词）

```
Find where something appears in a local media file and return its position: a timestamp
(milliseconds and seconds) for a video or recording, a page number for a document.
(定位：给一段文本或关键词，返回它在视频 / 录音里的时间戳，在文档里的页码。)

Use it when you know roughly what was said but not when ("where does it mention X"), or when
you need to know which page a phrase is on. Matching ignores punctuation, spacing and case,
and works for both Chinese and English. Long phrases match better than single characters.

For a video or recording, each match is a time window with a match score (0..1) and the
matched line. For a document, each match is a page: the page number, how many times the
query appears on that page (hits), and a short snippet around the first hit — never the
whole page. Pages that matched but did not fit are listed as "N more pages match: ...".
Read a full page with media_overview({ path, pages }).

For DOCUMENTS, ocr: "auto" (default) searches the PDF text layer where one exists and OCRs only
pages without one; ocr: "force" re-recognizes every requested page with the OCR provider first,
even pages that already have a text layer, and tags those matches (ocr). Use force when
media_probe says "text layer: looks unreliable". Forced results are cached separately from auto.
(文档：ocr: "force" = 强制重新 OCR / 重新识别文字层)

Text only by default — no image, no pixels spent. Add includeFrame: true to also get the
picture at the best match (one image, roughly 1,900 vision tokens).

A transcript is required: the embedded subtitle track, a subtitle you select explicitly, or ASR
configured via MMGREP_ASR_PROVIDER. Subtitles win over ASR. If none is available this tool
says so instead of guessing. Use media_overview if you only need the visuals.

Each match is tagged with its source. A match whose source is "asr" came from machine
transcription, so the wording may be wrong (names, numbers, jargon) — do not present it as the
speaker's exact words.

The result also carries the same single outline as media_probe / media_overview in
structuredContent.outline: the bookmark sidecar first, then the file's own PDF bookmarks or
chapter markers. Its entries carry the ids media_bookmark accepts (b1…bN), and
structuredContent.outline.sidecarPath / sidecarError point at the bookmark sidecar when one
exists. Locate is read-only: it never creates or modifies a sidecar.
(定位结果也带同一份目录：sidecar 优先，其次文件自带目录；line 首 b1…bN 可用于 media_bookmark)

It also searches the ANNOTATION text: the notes written next to the media (annotation
sidecar "<file>.mmgrep.annotation.json", or the file's own PDF annotations) are searched
too, and annotation hits are reported in their own "annotation matches" section. They are
marked as annotations (kind "annotation" plus the id, n1, n2, …) and are NEVER counted as
media content hits — the match count above them counts transcript / page matches only. An
annotation hit is a note somebody wrote; it is not something the media says.
(定位也搜批注文本；批注命中单独成段，不计入媒体命中数)
```

### 7.2 参数

| 参数 | 类型 | 必填 | 默认 | 适用 | 说明 |
|---|---|:---:|---|---|---|
| `path` | string | ✅ | — | 全部 | 本地绝对路径 |
| `query` | string | ✅ | — | 全部 | 要找的文本片段 / 关键词 |
| `max` | integer | ❌ | `5` | 全部 | 最多返回几条匹配，1–20 |
| `subtitle` | string \| integer | ❌ | — | video, audio | 显式选择字幕来源：文件绝对路径 / 字幕轨 index / 语言码（规则见 §8.5） |
| `transcript` | `"auto"` \| `"subtitle"` \| `"off"` | ❌ | `"auto"` | video, audio | `"subtitle"` 只查字幕、不跑 ASR；`"off"` 不接受任何转写来源 |
| `start` / `end` | number | ❌ | 全媒体 | video, audio | 只在这个时间窗里找 |
| `segment` | integer | ❌ | `300` | video, audio | 只给 `start` 不给 `end` 时的窗口长度 |
| `pages` | string | ❌ | 全文 | document | 只在这些页里找 |
| `ocr` | `"auto"` \| `"force"` | ❌ | `"auto"` | document | 同 `media_overview`：`"force"` 先让 OCR provider 重新识别请求页（有文字层也重识别），再在这些文字里定位；命中行标 `(ocr)`。需要已配置 OCR provider，否则报 `PROVIDER_NOT_CONFIGURED`；video / audio 传它报 `INVALID_ARGUMENT` |
| `includeFrame` | boolean | ❌ | `false` | video, document | 是否附带最佳匹配处的画面。视频给最佳时间窗的一帧；文档给最佳命中页的**页图**（页码看 `matches[0].page`；纯文本 `.txt` / `.md` 没有页图，只给 warning）。audio 传它报 `INVALID_ARGUMENT` |

> **没有 `includePageText` 这种参数。** 文档命中页的正文不会整页返回（见 §7.3.1）；需要整页文字时用
> `media_overview({ path, pages })` 或缓存里的 `content.md`。文本定位的默认输出是「页码 + 命中次数 + 片段」。

### 7.3 返回结构

| 字段 | 类型 | 含义 | 单位 |
|---|---|---|---|
| `mediaType` | string | 媒体类型 | — |
| `path` | string | 绝对路径 | — |
| `query` | string | 原始查询串 | — |
| `outline` | object | 与 probe / overview 相同的唯一一份目录（sidecar 优先；locate 不生成 heading 目录），字段同 §4.3 | — |
| `annotations` | object | 批注摘要（§16.10），字段同 §4.3 的 `annotations` | — |
| `annotationMatches[]` | array | 在批注 `note` 里搜到的命中；**永远不计入 `matches`**，也不与媒体内容混淆 | — |
| `annotationMatches[].kind` | `"annotation"` | 固定值，提醒调用方这不是媒体内容 | — |
| `annotationMatches[].id` | string | 批注 id（`n1` …） | — |
| `annotationMatches[].media` | string | 批注媒体类型 | — |
| `annotationMatches[].page` | integer \| null | 批注所在页（PDF） | 页 |
| `annotationMatches[].startMs` / `endMs` | integer \| null | 批注时间范围（video/audio） | ms |
| `annotationMatches[].startSec` / `endSec` | number \| null | 同上，秒 | s |
| `annotationMatches[].text` | string | 批注 note | — |
| `annotationMatches[].author` | string \| null | 批注作者 | — |
| `annotationMatches[].hits` / `fuzzy` | integer / boolean | 命中次数 / 是否 token 覆盖 | — |
| `annotationMatches[].source` | `"annotation"` | 固定值（与媒体 `source` 三档不混用） | — |
| `annotationMatches[].origin` | `"sidecar"` \| `"file"` \| null | 批注来源 | — |
| `annotationMatches[].line` | string | 与 media_annotate 结果同形的文本行（`n3 (p.12): note`） | — |
| `transcriptSource` | `"subtitle"` \| `"text"` \| `"ocr"` \| `"asr"` \| `"visual"` \| `"mixed"` \| `"none"` | 用的哪份转写（可信度口径，见 §2.5）。文档可能是 `text` / `ocr` / `mixed` | — |
| `transcriptOrigin` | `"file"` \| `"embedded"` \| `"textlayer"` \| `"asr"` \| `"ocr"` \| `"none"` | 来源渠道（文档：`textlayer` = PDF 文字层） | — |
| `matches[]` | array | 匹配列表（视频/录音按分数降序；文档按 §7.3.1 排序） | — |
| `matches[].rank` | integer | 名次（1-based） | — |
| `matches[].score` | number | 匹配分数（0–1，越大越像）——**仅视频 / 录音**，文档没有这个字段 | — |
| `matches[].hits` | integer | 该页命中次数——**仅文档**（精确短语计数） | 次 |
| `matches[].snippet` | string | 命中附近的片段——**仅文档**（首个命中 ±150 字符，对齐词边界） | — |
| `matches[].fuzzy` | boolean | 是否退化成 token 覆盖（没有整句命中）——**仅文档** | — |
| `matches[].startMs` / `endMs` | integer \| null | 时间范围（document 为 null） | ms |
| `matches[].startSec` / `endSec` | number \| null | 同上，秒 | s |
| `matches[].text` | string | 命中的原文（**文档不返回整页正文**，用 `snippet`） | — |
| `matches[].source` | `"subtitle"` \| `"text"` \| `"ocr"` \| `"asr"` \| `"visual"` \| `"none"` | 这段文字的来源与可信度（见 §2.5）；文档逐页映射（`text` / `ocr`） | — |
| `matches[].origin` | `"file"` \| `"embedded"` \| `"textlayer"` \| `"asr"` \| `"ocr"` \| `"none"` | 来源渠道 | — |
| `matches[].textOrigin` | `"textlayer"` \| `"ocr"` \| `"unknown"` \| null | 文档 provider / 抽取层对这一页的声明（`source` 按它映射）；视频 / 录音为 null | — |
| `matches[].page` | integer \| null | 页码（document） | 页 |
| `totalSegments` | integer | 搜索范围内的段落总数（document = 页数） | 条 |
| `searchedWindow.startMs` / `endMs` | integer \| null | 搜索范围 | ms |
| `searchedWindow.pages` | integer[] \| null | 搜索页码 | 页 |
| `frame` | object \| null | `includeFrame: true` 时的画面 | — |
| `frame.atMs` / `atSec` | integer / number | 帧时刻 | ms / s |
| `frame.width` / `height` | integer | 尺寸 | px |
| `frame.estimatedTokens` | integer | token 估算 | token |
| `text` | string | 人类/模型可读说明 | — |

#### 7.3.1 文档的定位口径（与视频 / 录音不同）

文档后端的 segment 粒度就是「一整页」：命中即整页，把整页回吐等于复述全文（一次调用可吐 12 KB+）。
所以文档侧不用 `score`，改用**命中次数 + 片段**：

| 项 | 口径 |
|---|---|
| `hits` | 该页的命中次数：精确短语（归一化 + 紧凑化后逐字匹配）出现次数；没有精确命中时退回 token 覆盖，`hits` = 命中 token 的出现次数，并置 `fuzzy = true` |
| `snippet` | 原文里首个命中 ±150 字符，对齐到词边界，折叠换行与排版空白；被截断处用 `…` 标记 |
| `source` | 该页文字的来源：`text`（原生文字层，字符精确）/ `ocr`（机器识别）。文本行写成 `page 11  hits=3 (text) 「…」`；`fuzzy` 命中写成 `(fuzzy, ocr)` |
| 排序 | **精确命中优先** → `hits` 降序 → 页码升序（token 覆盖会把只命中一个常见词的页也算进来，精确命中必须压过它们） |
| 整页正文 | **不再返回**。要整页用 `media_overview({ path, pages })` 或缓存里的 `content.md` |
| 输出预算 | 文本输出约 3 KB 上限：超了就少展示几页，其余折叠成一行 `N more pages match: 3, 9, 14`（页码升序）。被折叠的页**不算丢失**，文本里写明了页码 |
| `ocr` | `"force"` 时先重新识别请求页再定位；命中行的 `source` / `origin` / `textOrigin` 都是 `ocr`，文本行写 `(ocr)`。force 结果走独立缓存，和 auto / 文字层结果互不覆盖 |
| 候选窗口 | 一次 locate 最多向后端要 20 页候选（后端上限）：`N more pages match` 列的是**已知命中但没展示**的页；想看更后面的页，用 `pages` 缩小范围再查 |

> 视频 / 录音的 `score`（0–1）与文档的 `hits` 是两种粒度下的两种指标：前者比「像不像」，
> 后者比「命中几次」。同一字段两种语义会打架，所以文档侧**删掉** `score`，不要两套都留。

### 7.4 文本输出形态

视频 / 录音：

```
matches for "柏氏矢量" (2 of 128 segments):
  00:12.480-00:18.900  (0.92)  "我们今天讲的是柏氏矢量"
  03:41.100-03:47.260  (0.61)  "柏氏矢量这个概念"
Feed any of these windows to media_zoom({ path, start, end }) — no need to re-read the whole file.
```

文档（一行一页：页码 + 命中次数 + 来源标签 + 命中附近的片段，没有分数）：

```
matches for "deimmunization" (2 of 28 pages):
  page 11  hits=3 (text)  「…workflow for artificial intelligence-directed deimmunization.…」
  page 4  hits=1 (ocr)  「…the chimera was deimmunized by injection of…」
  2 more pages match: 7, 19
Feed any of these pages to media_zoom({ path, page }) — no need to re-read the whole file.
```

批注命中单独成段（永远不计入上面的媒体命中数）：

```
annotation matches for "deimmunization" (1):
  n2 (p.12): 这里的公式与正文不一致
note: the lines above are ANNOTATIONS — notes written next to the media (sidecar or the file itself),
not media content. They are not part of the transcript or the page text.
```

`(text)` 的片段来自原生文字层，字符精确；`(ocr)` 的片段经过字符识别，专名与数字建议 `media_zoom` 核对。

### 7.5 错误行为

- 无 `query` → `INVALID_ARGUMENT: query is required.`
- `ocr: "force"` 但没有可用的 OCR provider → `PROVIDER_NOT_CONFIGURED`（与 overview 同一套 hint）；`ocr: "force"` 用在 `.txt` / `.md` 上 → `INVALID_ARGUMENT`；video / audio 传 `ocr` → `INVALID_ARGUMENT`。
- **媒体没有可用文字** → `NO_TRANSCRIPT`（视频 / 录音：无字幕且无 ASR；文档：无文字层且无 OCR）。视频 / 录音的原文案：
  `no transcript available for this file and no ASR provider is configured (MMGREP_ASR_PROVIDER="none"). Pass subtitle with a local .srt/.vtt file, a track index, or a language code, or configure an ASR provider. For visuals only, use media_overview instead.`
  文档的原文案以 `cannot search this document: ` 开头，后面接具体原因（`no text layer and no OCR provider is configured.` / `no page text is available.` 等），hint 指向 OCR 配置。
- 文档的 OCR / typeset 角色**配置了但不可用**（缺 key、provider 初始化失败）→ `PROVIDER_NOT_CONFIGURED` / `PROVIDER_FAILED`，文案以 `cannot search this document: ` 开头——不像 overview 那样降级，因为 locate 必须要有文字可搜。
- `includeFrame: true` 但媒体是 audio → `includeFrame is not applicable to audio media. There are no frames to show.`
- 一条都没匹配上 → **不是错误**：`matches` 为空数组，文本里写 `no line matched "xxx" among 128 transcript segments. Try shorter keywords, or a phrase that appears verbatim.`

## 8. 字幕读取（`media_overview` 的纯文本模式）

> 把「已有的字幕」变成带时间轴的段落。字幕读取已并入 `media_overview`：`images: 0` 是零像素
> 纯文本模式，`transcript: "subtitle"` 让它只读字幕、绝不回退到 ASR，`subtitle` 参数显式选择来源。

### 8.1 怎么读

```
media_overview({ path, images: 0, transcript: "subtitle" })
media_overview({ path, images: 0, transcript: "subtitle", subtitle: "/abs/a.zh.srt" })
media_overview({ path, images: 0, transcript: "subtitle", subtitle: 2 })
media_overview({ path, images: 0, transcript: "subtitle", subtitle: "zh" })
```

- `images: 0`：不扫镜头、不抽帧、不出图，预算全零。
- `transcript: "subtitle"`：只走字幕来源；没有字幕时 `segments = []`、`transcript.source = "none"`，
  `transcript.reason` 与 `warnings` 写明原因，**不报错、不调用 ASR**。
- `subtitle`：显式选择字幕文件 / 内嵌轨 index / 语言码；给了就只用它，不可用报 `INVALID_ARGUMENT`，不静默回退。
- `start` / `end`：只保留落在这个时间窗内的段落。

> 需要「非要有文字不可、没有就报错」时用 `media_locate`：它的 `transcript: "auto"` 会先试字幕、再试 ASR，
> 两者都没有就报 `NO_TRANSCRIPT`（§7.5）。

### 8.2 参数

| 参数 | 类型 | 必填 | 默认 | 适用 | 说明 |
|---|---|:---:|---|---|---|
| `path` | string | ✅ | — | video, audio | 本地绝对路径（媒体本体） |
| `images` | integer | ❌ | 2 | video, audio | 只读字幕时必须给 `0`（零像素纯文本模式） |
| `transcript` | string | ❌ | `"auto"` | video, audio | 只读字幕时必须给 `"subtitle"`，否则 `"auto"` 会在没有字幕时回退到 ASR |
| `subtitle` | string \| integer | ❌ | — | video, audio | 显式选择字幕来源：本地字幕文件绝对路径 / 字幕轨 index / 语言码。给了就只用它 |
| `start` / `end` | number | ❌ | 全媒体 | video, audio | 只保留落在这个时间窗内的段落 |

> `media_overview` 不接受对 video / audio 传 `pages`（它们没有页码概念）：`pages is not applicable to video media. Use "start" and "end" (seconds) instead.` / 对 audio：`pages is not applicable to audio media. …`

### 8.3 返回结构

与字幕相关的字段（完整结构见 §5.3）：

| 字段 | 类型 | 含义 | 单位 |
|---|---|---|---|
| `transcript.source` | `"subtitle"` \| `"none"` | 内容来源与可信度（字幕恒为 `subtitle`，见 §2.5） | — |
| `transcript.origin` | `"file"` \| `"embedded"` \| `"none"` | 来源渠道 | — |
| `transcript.file` | string \| null | 来源文件路径（`origin: "file"` 时） | — |
| `transcript.language` | string \| null | 语言（内嵌轨时从轨元数据取） | — |
| `transcript.segmentCount` | integer | 段落数 | 条 |
| `segments[]` | array | 段落列表 | — |
| `segments[].index` | integer | 序号（1-based） | — |
| `segments[].startMs` / `endMs` | integer | 时间范围 | ms |
| `segments[].startSec` / `endSec` | number | 同上，秒 | s |
| `segments[].text` | string | 字幕正文（已剥 markup） | — |
| `segments[].source` | `"subtitle"` | 字幕恒为 `subtitle`（来自字幕文件 / 内嵌轨，可能是自动生成的） | — |
| `segments[].origin` | `"file"` \| `"embedded"` | 来源渠道 | — |
| `warnings[]` | array | 字幕来源相关警告（见 §8.5） | — |

### 8.4 文本输出形态

`images: 0` 时没有宫格格位，段落直接是转写行：

```
<overview path="/abs/a.mp4" type="video" window="0.00-12.00" duration="12.00" audio="present"
  transcript="subtitle" origin="file" file="/abs/a.zh.srt" />
[seg 1   ] 00:00.000-00:03.000  (subtitle)  「……」
[seg 2   ] 00:03.000-00:06.000  (subtitle)  「……」
```

字幕文本通常来自作者，但也可能是机器自动生成的：专有名词与数字要核对画面（见 §2.5）。cue 之间大面积时间重叠时（> 30%），overview 与 locate 还会给出警告 `rolling/auto-style captions detected — treat like ASR: check names and numbers against the frame.`。

### 8.5 字幕来源的判定顺序（写死）

> **通用规则**（`media_overview` / `media_locate` 共用前 3 步）：
> 显式 `subtitle` 选择 → 内嵌字幕轨 → 同目录同名文件自动发现。
> `media_overview` 在这三步都没命中时，`transcript: "auto"` 继续用 ASR 兜底；
> `transcript: "subtitle"` 则到此为止，返回空转写并写明原因。
> `media_locate` 因为非要有文字，字幕与 ASR 都没有时直接报 `NO_TRANSCRIPT`。

`media_overview` / `media_locate` 的 `transcript` 参数控制文字来源：

- `"auto"`（默认）：走完第 1–3 步，没命中才进入第 4 步 ASR 兜底。
- `"subtitle"`：只走第 1–3 步，**绝不**调用 ASR。没有字幕来源时 `segments = []`，`transcript.source = "none"`，
  `transcript.reason` 写明原因，`warnings` 含 `"no-subtitle-source"`；`media_locate` 因为非要有文字，会报 `NO_TRANSCRIPT`。
- `"off"`：第 1–4 步全部跳过，字幕也不读。`transcript.source = "none"`，`reason` 说明是调用方关闭，
  `warnings` 含 `"transcript-disabled"`。`media_probe` 的 `capabilities.asr.available` 为 `false`，
  `capabilities.transcriptSource` / `transcriptOrigin` 均为 `"none"`。

1. **显式 `subtitle` 给了** → 按形态解释，且只用它，**不静默回退**：
   - **绝对路径**（含路径分隔符或字幕扩展名的字符串）→ 本地字幕文件。文件不存在 / 不是普通文件 / 不可读 / 解析不出段落 → `INVALID_ARGUMENT`。
   - **非负整数**（也接受纯数字字符串）→ ffprobe 流 index。该 index 必须存在、是字幕轨、且不是图形字幕轨；否则 `INVALID_ARGUMENT`（图形轨的错误文案内嵌 `embedded-subtitle-bitmap-skipped (...)` 形态）。
   - **其他字符串** → 语言码，匹配轨的 `tags.language`（大小写不敏感；`zh` 也匹配 `chi`/`zho`，`en` 匹配 `eng`）。多条命中取文件中靠前的一条，其余命中的轨写进 `warnings`；无命中 → `INVALID_ARGUMENT`。
2. **容器内嵌字幕轨** → 取第一条文本型轨。多轨时按语言优先级 `zh-Hans` → `zh-CN` → `zh` → `en-US` → `en` → 轨道序号。
3. **同目录同名文件自动发现**（见下）。
4. （仅 `media_overview` / `media_locate`）**ASR 兜底** → provider 已配置且音频体检通过时跑 ASR。
5. 都没有 → `media_locate` 报 `NO_TRANSCRIPT`；`media_overview` 返回空转写 + 原因（见 §5.5）。

**字幕轨存在但没有用上时的警告（`warnings`）：**

只有文本型字幕轨能解析成文字；图形字幕轨（PGS / DVD / DVB / XSUB）会被跳过。为了不让 agent 把「有字幕但用不了」误当成「没有字幕」，以下情形必须写进 `media_overview` / `media_locate` 的 `warnings`，并由 `media_probe` 的 `capabilities.transcriptReason` 给出原因（多条以 `; ` 连接）：

| warning | 触发条件 |
|---|---|
| `embedded-subtitle-bitmap-skipped (<codec>, track <index>)` | 内嵌字幕轨是图形字幕（如 `hdmv_pgs_subtitle` / `dvd_subtitle` / `dvb_subtitle` / `xsub`），无法解析成文字 |
| `embedded-subtitle-empty (track <index>)` | 选中的文本型字幕轨抽出来后没有任何段落 |
| `embedded-subtitle-unreadable (track <index>): <message>` | 抽取内嵌字幕轨失败（ffmpeg 报错原文附在冒号后） |
| `subtitle-language-multiple-matches (language "<code>": tracks <a>, <b>; using track <a>)` | 显式 `subtitle` 语言码命中多条文本型字幕轨；按轨序取第一条，其余列在这里 |

轨道存在但上述原因让内嵌字幕没被采用时，仍会继续尝试同目录同名文件与 ASR；警告只解释「为什么没用内嵌轨」，不中断后续来源。

**同目录同名自动发现的规则：**

- 只在 `path` **所在的同一个目录**里找，**不向上、不向旁**。
- 候选扩展名：`.srt` `.vtt` `.ass` `.ssa`（不区分大小写）。
- 优先级：
  1. 精确同名：`a.mp4` → `a.srt` / `a.vtt` / `a.ass` / `a.ssa`（按此扩展名顺序）。
  2. 带语言后缀：`a.zh-Hans.srt` / `a.zh.srt` / `a.en.vtt` …（语言按上述优先级；同语言多个时取字典序最小）。
- 命中后**必须在返回值里报出实际用到的文件路径**（`transcript.file` / `capabilities.transcriptPath`），所以自动发现不是「悄悄发生」的。
- **本文件默认开启自动发现**（见 §13 的取舍说明）。

### 8.6 错误行为

- 显式 `subtitle` 不可用时，`media_overview` / `media_locate` 一律报 `INVALID_ARGUMENT`，**不静默回退**：
  - 文件不存在 → `subtitle file does not exist: "/abs/a.srt".`
  - 不是绝对路径 / URL → `subtitle file must be an absolute local path; got "a.srt". …` / `subtitle file must be a local absolute file path; URLs are not accepted ("https://…"). …`
  - 扩展名不在支持列表 → `subtitle file must be one of .srt, .vtt, .ass, .ssa (got ".txt").`
  - 解析不出段落 → `no subtitle cue could be parsed from "/abs/a.srt".`
  - 轨道 index 不存在 → `subtitle track index 9 does not exist in this file (subtitle tracks: zho (track 1), eng (track 2)).`
  - 轨道不是字幕轨 → `subtitle track index 0 is not a subtitle track (it is a video track).`
  - 图形字幕轨 → `subtitle track index 2 is a bitmap subtitle track and cannot be read as text: embedded-subtitle-bitmap-skipped (hdmv_pgs_subtitle, track 2).`
  - 语言码无命中 → `no subtitle track matches language "ja" (subtitle tracks: zho (track 1), eng (track 2)).`
  - 选中的字幕轨没有段落 → `subtitle track index 3 contains no subtitle cues.`
- `media_probe` 例外：同样的不可用情形**不报错**，只写进 `capabilities.transcriptSource = "none"` 与 `capabilities.transcriptReason`。
- 完全没有字幕来源：
  - `media_overview` + `transcript: "subtitle"` → 空段落 + `transcript.source = "none"` + `transcript.reason` + `warnings: ["no-subtitle-source"]`，不报错。
  - `media_locate` → `NO_TRANSCRIPT`（§7.5 文案）。

---

## 9. 全文落盘格式

`media_overview` 会把**全文**写到缓存目录，返回绝对路径。**全文不内联返回**；内联的只有受长度上限约束的节选。绝对路径同时写进 `content[0].text` 末尾的 `full text:` 行（见 §5.3）——只读 text content 的宿主也拿得到；落盘失败时该行是 `full text: NOT written — <reason>`，调用本身不失败。

落盘产物有 **4 个**：`content.md`（人读）、`segments.jsonl`（程序读）、`manifest.json`（本次导出的元信息），以及 **可选件** `document.json`（cangjie `SourceDocument Contract v1` 适配层，下游不需要 cangjie 时可以完全不看它）。

### 9.0 缓存键控：按**文件内容 hash**

**主键 = 源文件内容的 sha256**（不是路径 + 大小 + mtime）。

```
sha256:<64 位 hex>              同一份内容的默认产物
sha256:<64 位 hex>:<variant>    同一份内容的不同产物（宫格图 / 特写 / 全文 …）
```

内容变了 → hash 变了 → key 变了 → 缓存自然失效。不会出现「文件改了但缓存还命中」的错命中，也不需要靠 mtime 猜新鲜度。

**快速指纹索引（fast path）**：内容哈希要读整个文件（视频动辄几个 GB），所以另维护一份索引：

```
fingerprint = sha256(绝对路径 + ':' + size + ':' + mtimeMs)  →  内容 sha256
```

- 命中指纹 → 直接拿到内容 hash，**跳过全文件哈希**。
- 指纹不命中（文件改了 / 首次访问 / 索引损坏）→ 老老实实算内容 hash，并把新指纹写回索引。
- 指纹只是「快速路径的钥匙」，**不是身份**。真正的身份永远是内容 hash。

**已知取舍**：指纹用 `size + mtime` 做二次判定，若文件被改动后大小与 mtime 恰好不变，指纹会给出过期的内容 hash。这种情况极罕见（改文件通常会改 mtime），但不是零概率——下游若对准确性有硬要求，可删掉 `fingerprint-index.json` 强制每次重算。

目录布局（`MMGREP_CACHE_DIR` 下）：

```
~/.cache/multimediagrep/
  fingerprint-index.json          指纹索引（路径+大小+mtime → 内容 hash）
  <shard>/                        条目载荷：按 key 的前两位分片
    <stem>/                       key `sha256:ab12…cd` → `ab/12…cd`
      content.md
      segments.jsonl
      manifest.json
      document.json               # 可选件，见 §9.4
      images/
        overview-1.png
        overview-2.png
    <stem>.<variant>/             同一份内容的其它产物（如宫格图、特写图）
    .meta-<stem>.json             条目记录（LRU 与清理的依据）
```

文档 provider 的逐页结果也挂在这棵树里（namespace 含 provider / model / ocrMode / role，
每页一个 JSON），与全文产物共用同一套内容哈希、LRU 与容量上限；见 §2.7。
同一 provider 担两个角色且 `ocrMode=auto` 时，缺失的 typeset / OCR 页合并成**一次**
`role: "both"` 请求，按返回的 `textOrigin` 分配后再按每页实际路由到的角色落缓存。

### 9.1 `content.md`

给人读的 Markdown全文。视频/录音按段落分段，文档按页分节。

```markdown
# /abs/a.mp4

- mediaType: video
- duration: 600.00 s
- transcript: asr (elevenlabs / scribe_v1), language: zh
- generated: 2026-11-01T09:12:33Z

## 00:00.000 – 00:04.120

第一句。

## 00:04.120 – 00:09.480

第二句。
```

文档则是 `## Page 7` + 该页文字。

### 9.2 `segments.jsonl`

**一行一个 JSON 对象**（不是数组），便于流式读取：

```json
{"index":1,"startMs":0,"endMs":4120,"startSec":0,"endSec":4.12,"text":"第一句。","page":null,"speaker":null,"source":"asr","origin":"asr"}
{"index":2,"startMs":4120,"endMs":9480,"startSec":4.12,"endSec":9.48,"text":"第二句。","page":null,"speaker":null,"source":"asr","origin":"asr"}
{"index":1,"startMs":null,"endMs":null,"startSec":null,"endSec":null,"text":"第 1 页正文","page":1,"speaker":null,"source":"text","origin":"textlayer"}
```

字段：`index`（1-based）、`startMs`/`endMs`（integer ms，document 为 null）、`startSec`/`endSec`（number，document 为 null）、`text`、`page`（document 专用）、`speaker`（本版恒为 `null`：说话人分离还没有接到 segments，字段先占位），以及 `source` / `origin`（§2.5 的枚举；文档逐页可能是 `source = "text"` + `origin = "textlayer"`（PDF 文字层）、`source = "text"` + `origin = "file"`（`.txt` / `.md`）、`source = "ocr"` + `origin = "ocr"`，或 `none`）。`contentHash` 是归一化文本的哈希（扩展字段）。

> **`textOrigin` 不落盘。** 契约 v2 的逐页声明（`textlayer` / `ocr` / `unknown`）在工具返回的 `segments[]` / `matches[]` 里可见，但 `segments.jsonl` 只持久化映射后的 `source` / `origin`——下游要判断「这页是否原生文字层」，读 `source = "text"` + `origin = "textlayer"` 即可，信息没有丢。

### 9.3 `manifest.json`

```json
{
  "version": 1,
  "generator": { "name": "multimediagrep", "version": "<server version>" },
  "tool": "media_overview",
  "generatedAtMs": 1793508753000,
  "source": {
    "path": "/abs/a.mp4",
    "mediaType": "video",
    "sizeBytes": 104857600,
    "modifiedMs": 1793508700000,
    "sha256": "ab12…cd"
  },
  "window": { "startMs": 0, "endMs": 600000, "startSec": 0, "endSec": 600 },
  "pages": null,
  "outline": {
    "available": true,
    "source": "chapters",
    "generated": false,
    "media": "video",
    "total": 1,
    "entries": [
      { "id": "b1", "title": "Opening", "start": 0, "end": 2 }
    ],
    "sidecarPath": null,
    "sidecarError": null,
    "reason": null
  },
  "transcript": {
    "source": "asr",
    "provider": "elevenlabs",
    "model": "scribe_v1",
    "language": "zh",
    "segmentCount": 128,
    "file": "/abs/a.zh.srt"
  },
  "overview": {
    "images": [
      { "index": 1, "width": 1280, "height": 720, "cells": 9, "mimeType": "image/png", "bytes": 178204, "estimatedTokens": 1229 },
      { "index": 2, "width": 1280, "height": 720, "cells": 9, "mimeType": "image/png", "bytes": 178204, "estimatedTokens": 1229 }
    ],
    "estimatedTokens": 2458
  },
  "document": {
    "source_id": "src-3f2a9c81b40d",
    "version_id": "sha256:ab12…cd",
    "element_count": 128
  },
  "counts": { "segment": 128 },
  "provider": "elevenlabs",
  "warnings": []
}
```

| 字段 | 含义 |
|---|---|
| `generator.name` / `generator.version` | 产出方（`multimediagrep` / 当前 server 版本），下游据此判断字段含义是否兼容 |
| `document.source_id` | 稳定来源 ID（见 §9.4），**文件改名不变** |
| `document.version_id` | 内容版本 ID = `sha256:<hex>`，**内容变了就变** |
| `document.element_count` | `document.json` 里的 element 数量 |
| `counts` | 产物计数，按 segment 的粒度归类：`segment`（没有页码的段落：视频 / 录音）与 `page`（有页码的段落：文档）。两者不会同时出现 |
| `outline` | **完整**目录（sidecar / PDF 书签 / 视频章节 / heading 生成），字段与 §5.3 `structuredContent.outline` 相同：条目带 `id`；`source` 为 `sidecar` / `pdf-bookmarks` / `chapters` / `headings`；有 sidecar 时带 `sidecarPath` / `sidecarError`。没有目录时是 `available: false` 的对象，`reason` 说明原因 |
| `overview.images[]` | 每张图的描述（`index` / `width` / `height` / `cells` / `mimeType` / `bytes` / `estimatedTokens`），**不含像素、也不含文件名**——像素只在 `content` 的 image block 里，manifest 不引用图片文件 |
| `transcript` | 转写来源（`source` / `provider` / `model` / `language` / `segmentCount` / `file`）。**没有 `origin` 字段**：渠道口径在 `segments.jsonl` 的逐段 `origin` 上 |
| `provider` | 实际处理文字的外部 provider（没有时为 `null`） |
| `source.mediaType` | **真实**来源媒体类型（`video`/`audio`/`document`）。这是本项目自己的口径，与 cangjie 的 `media_type` 枚举不是一回事（见 §9.4 的偏差说明） |
| `source.sha256` | 源文件内容哈希，即缓存主键 |

`warnings` 收集本次运行的降级记录（ASR 未配置、文档解析未配置、格数被削减、文本被截断……），让下游蒸馏器知道这段文字的可信度。

### 9.4 `document.json`（可选件，cangjie `SourceDocument Contract v1`）

**用途**：本项目的下游蒸馏器例子是 **cangjie-skill**，它的 `SourceDocument Contract v1`（`schemas/contracts/source-document.schema.json`）明确写着「外部预处理仓库必须遵守」。所以我们**额外**写一份符合该契约的 `document.json`。

**它是可选件**：下游不需要 cangjie 时，只读 `content.md` / `segments.jsonl` / `manifest.json` 三个文件即可，产物完全够用。`document.json` 只是为 cangjie 链路准备的适配层。

```json
{
  "schema_version": 1,
  "source_id": "src-3f2a9c81b40d",
  "version_id": "sha256:ab12cd34ef5678901234567890abcdef1234567890abcdef1234567890abcdef",
  "title": "a",
  "media_type": "video",
  "language": ["zh"],
  "parser": "multimediagrep@<server version>",
  "elements": [
    {
      "element_id": "el-000001",
      "type": "transcript",
      "text": "第一句。",
      "heading_path": [],
      "page": null,
      "time_start_ms": 0,
      "time_end_ms": 4120,
      "bbox": null,
      "asset_ref": null,
      "confidence": null,
      "content_hash": "sha256:…",
      "source": "asr"
    }
  ]
}
```

**顶层字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema_version` | integer | 恒为 `1`（契约里是 `const`） |
| `source_id` | string | **稳定 ID：文件改名不得变成新来源**。取**文件名**的 sha256 前 12 位（形如 `src-3f2a9c81b40d`；不含目录）——所以把 `a.mp4` 改名成 `b.mp4` 仍然是同一个 `source_id`，版本差异由 `version_id` 区分 |
| `version_id` | string | `sha256:<hex>`，由**文件内容**确定性计算。内容变了它就变 |
| `title` | string | 展示用标题（默认取文件名去扩展名，如 `a.mp4` → `a`） |
| `media_type` | string | cangjie 契约枚举：`markdown` / `txt` / `pdf` / `html` / `epub` / `docx` / `pptx` / `xlsx` / `subtitle` / `audio` / `video` |
| `language` | string[] | 语言列表（BCP-47）。本版只有 `media_overview` 传值；探测不到时给占位 `["und"]`，不会是空数组 |
| `parser` | string | `名称@版本`，本项目为 `multimediagrep@<server version>`（与 `package.json` 同版本） |
| `elements` | object[] | 元素列表，见下 |

**element 字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `element_id` | string | `el-000001` 形式的六位序号（1-based） |
| `type` | string | 契约枚举：`heading` / `paragraph` / `list` / `table` / `image` / `formula` / `transcript` / `frame` / `code` |
| `text` | string | 元素文本 |
| `heading_path` | string[] | 所属标题层级路径。本版恒为 `[]`（保留字段，尚未从 heading 回填） |
| `page` | integer \| null | 页码（document 专用） |
| `time_start_ms` / `time_end_ms` | integer \| null | 时间范围（video / audio 专用） |
| `bbox` | number[] \| null | 4 元组 `[x, y, width, height]`。本版恒为 `null`（页面级坐标不在 v1 范围） |
| `asset_ref` | string \| null | 关联资产（图片 / 帧图）的相对路径。本版恒为 `null` |
| `confidence` | number \| null | 置信度 0–1。本版恒为 `null`（provider 尚未回传可信度） |
| `content_hash` | string | `sha256:<hex>`，由**归一化后的文本**（去首尾空白 + 折叠内部空白）确定性计算 |
| `source` | string | **我们额外加的字段**：文字来源与可信度，取 §2.5 的枚举 `subtitle` / `text` / `ocr` / `asr` / `visual` / `none`（element 粒度不会出现 `mixed`；`mixed` 只用于整份 `transcript`） |

> `source` 不在 cangjie 契约里，但契约没有禁止 `additionalProperties`，所以加它是合法的。它的价值：cangjie 的 element 没有「这段字是作者写的还是机器猜的」的概念，而下游蒸馏器需要这个区分（ASR 不可当原话引用）。

**类型映射规则**

| 本项目的产物 | element `type` | 填充的字段 |
|---|---|---|
| 字幕 / ASR 段落 | `transcript` | `text`、`time_start_ms`、`time_end_ms`、`source`（`subtitle`/`asr`）、`confidence` |
| 文档页文字 | `paragraph` | `text`、`page`、`heading_path`、`source`（`text` = 原生文字层 / 纯文本；`ocr` = 机器识别；`none` = 无文字页） |
| 画面帧 | `frame` | `asset_ref`（帧图路径）、`time_start_ms`、`source` = `visual` |

**已知偏差（必须知道）**：cangjie 的 `media_type` 枚举里**没有 `image`**。所以**图片类文档**（`png` / `jpg` / `webp` / `tiff` / `heic` …）在 `document.json` 里映射成 **`pdf`**（页面式文档）——这是为了让 `media_type` 落在契约枚举内。**真实来源类型记在 `manifest.json` 的 `source.mediaType`**（那里本项目用自己的口径，`document` 表示图片类文档）。下游若要区分「真 PDF」和「一堆图片」，读 manifest，不要读 `document.json` 的 `media_type`。

---

## 10. 图片 token 预算

> 对应 beads `MultiMediaGrep-32x`。这一节是**硬约束**，实现时必须照抄数值。

### 10.1 计价公式

两种计价模型都要算，取**较大者**作为 `estimatedTokens`（宁可报高，不让 agent 以为多要几张也不贵）：

```
gridTokens(w, h)   = ceil(w / 42) * (ceil(h / 42) + 1) + 2      # 42px 网格计价（DSH 口径）
pixelTokens(w, h) = ceil(w * h / 750)                          # 像素计价（API 宿主口径）
estimatedTokens    = max(gridTokens, pixelTokens)
```

网格公式取自上游 `dsh-video-storyboard/src/storyboard/plan.js` 的 `imageTokens()`；像素公式是 API 宿主的通行口径（Claude 一类按像素折算 token）。**两种都要报**：`estimatedTokens`（取大者）+ `estimatedTokensGrid` + `estimatedTokensPixels`。

### 10.2 硬上限（超出 → `BUDGET_EXCEEDED`）

| 项 | 上限 | 错误文案 |
|---|---|---|
| 单次调用返回图片数 | **4** | `requested 5 images but the per-call limit is 4. Reduce images to 4, or reduce cells and split the range into several calls with start/end.` |
| 每张图的格数 | **16** | `cells must be an integer between 1 and 16 (got 25).` |
| 单次调用总格数 | **64** | `requested 25 cells x 4 images = 100 cells but the per-call limit is 64. Lower cells, lower images, or split the range into several calls.` |
| 单图最长边 | **1600 px** | `maxEdge must be an integer between 256 and 1600 (got 3000).` |
| 单图像素数 | **2,000,000** | `the requested shape would need 3,240,000 pixels per image but the limit is 2,000,000. Lower cells or maxEdge.` |

**`images` 的下限是 0**（不是 1）：`images: 0` 是合法的零像素纯文本模式，`images: -1` 才报错 —— `images must be an integer >= 0 (got -1).`

### 10.3 软预算与默认形状

软预算：**单次调用 ≤ 4,000 图片 token**（`MMGREP_MAX_IMAGE_TOKENS`，默认 4000）。

| 工具 | `cells` 默认 | `images` 默认 | `maxEdge` 默认 | 默认形状 | 默认 token |
|---|---|---|---|---|---|
| `media_overview`（video） | 9 | 2 | 1280 | 2 × 9 格 @ 1280×720 | **2,458** |
| `media_overview`（document） | 6 | 2 | 1280 | 2 × 6 格 @ 1280×720 | **2,458** |
| `media_zoom` | — | 1 | 1600 | 1 帧 @ 1600×900 | **1,920** |
| `media_locate`（`includeFrame`） | — | 1 | 1280 | 1 帧 @ 1280×720 | **1,229** |
| `media_overview`（audio + `envelope`） | — | 1 | 1280 | 1 波形 @ 1280×720 | **1,229** |
| `media_overview`（`images: 0`） | — | 0 | — | 无图 | **0** |

**自动模式下**（agent 没显式给 `cells` / `images` / `maxEdge`），server **保证**默认形状落在软预算内；素材更长时按 §10.5 分页。

**显式模式下**（agent 给了形状），server **不偷偷改形**：按请求的形状出图，然后：
- 超出硬上限 → `BUDGET_EXCEEDED` 报错。
- 未超硬上限但超软预算 → 照出，但在 `budget.warning` 里写清楚，并给出削减建议。

> 理由：agent 明明要了 16 格却只拿到 9 格，会以为自己看过了 16 个瞬间。上游在这上面踩过坑（`cells: asked 16, produced 8`），我们把「问了 / 出了」两个数都报出来。

### 10.4 格数与可读性的关系

每格的像素 ≈ `maxEdge² / cells`（按 16:9、方阵近似）。三档可读性（沿用上游 `NEED_TIERS`）：

| 档位 | 每格至少 | 能干什么 |
|---|---|---|
| `text` | 480 × 270 | 读字幕 / 招牌 / UI 文字 |
| `scene`（默认目标） | 320 × 180 | 认人脸、认动作、认大标题 |
| `shot` | 160 × 90 | 只分辨「是不是另一个镜头」 |

**最小 `maxEdge` 表**（保证每格至少到 `scene` 档）：

| `cells` | 布局 | 最小 `maxEdge` | 该布局下每格 |
|---|---|---|---|
| 4 | 2 × 2 | 640 | 320 × 180 |
| 6 | 3 × 2 | 960 | 320 × 180 |
| 9 | 3 × 3 | 960 | 320 × 180 |
| 16 | 4 × 4 | 1280 | 320 × 180 |

**规则：`cells` 越大，`maxEdge` 也要跟着涨。** `cells=16` 配 `maxEdge=640` 会退化成 `shot` 档（160 × 90 的色块，不是内容）——server 在这种组合下**要么拒绝，要么在清单里明确警告「cells below readability target: shot-level」**。

**核心原则（沿用上游）：永远不要用「更小的格子」换「更多的覆盖面」。** 需要更多时刻就多出一张图：2 张 × 9 格 ≫ 1 张 × 16 格，同 token 量级但可读得多。

### 10.5 超出预算时的降级阶梯

按**这个顺序**降级，前面不行才动后面：

1. **先收窄范围**（agent 侧）：用 `start`/`end` 或 `pages` 只取真正需要的部分。多数「超预算」其实是「我本来就不需要整个文件」。
2. **拆成多次调用**（推荐）：按 `continuation.nextStartMs` / `nextPage` 一段一段走。每段一个调用，token 总量不变，但**每张图都保持可读**。
3. **减少图片数**（次选）：同样的格子数摊到更少张图上 → 每张图变大，可读性提升，token 总量基本不变。
4. **减少格数**（最后手段）：会让格子变小，可能跌破可读性档。server 必须同时警告。
5. **不要**「一次塞满」：把 60 分钟塞进一张图 = 得到 60 张看不清的色块，纯浪费。

### 10.6 典型场景预算表

| 场景 | 素材 | 推荐调用序列 | 每次图片数 | 每次 token（grid / pixel） | 单次合计 | 关键约束 |
|---|---|---|---|---|---|---|
| 短视频 | < 2 min | `probe` → `overview(cells 9, images 1)` | 1 | 591 / 1,229 | **1,229** | 一次读完 |
| 中视频 | 2–30 min | `probe` → `overview(cells 9, images 2)` | 2 | 591 / 1,229 | **2,458** | 一次读完；< 30 min 不必分段 |
| 长视频 | > 30 min | `probe` → `overview(start, segment 300)` 循环 | 1–2 | 591 / 1,229 | **2,458**/次 | **必须**分段；跟着 `continuation.nextStartMs` 走；不 segment 就别一次性 overview |
| 超长视频 / 电影 | > 90 min | `probe` → `overview(start, end)` 按剧情段落 | 1–2 | 591 / 1,229 | **2,458**/次 | 一次 overview 剧透且格子小；按段走 |
| 长文档 | > 30 页 | `probe` → `overview(pages "1-12", cells 6, images 2)` | 2 | 591 / 1,229 | **2,458**/次 | 每批 8–12 页；跟着 `continuation.nextPage` 走 |
| 短文档 | ≤ 30 页 | `probe` → `overview(cells 6, images 2)` | 1–2 | 591 / 1,229 | **2,458** | 一次读完 |
| 扫描件（无文本层） | 任意页数 | `probe` → `overview(pages …)` → `media_zoom(page)` | 每批 1–2 + 每次 zoom 1 | 1,229 + **1,920**/zoom | 视页数 | 只能看图；要读字必须逐页 zoom（最贵路径） |
| 录音 | 任意 | `probe` → `overview`（纯文本）→ `locate` | 0 | 0 | **0** | 零图片成本；录音是这条链路上最省的媒体 |
| 只要文字 | 任意 | `probe` → `overview(images: 0)` | 0 | 0 | **0** | 零像素模式：视频不扫镜头、不抽帧，只要字幕/转写；配 `transcript: "subtitle"` 时零 ASR |

### 10.7 与 beads 票的关系

- `MultiMediaGrep-32x` 的验收标准要求「数值以 `9z5.3` 实测的 client 图片上限为准」。**`9z5.3`（MCP 图片返回在 Claude Code 与 Hermes 中能被模型看到）尚未完成实测**，因此本节的数值是按上游 `plan.js` 的策略 + 常见宿主上限**推导**的，不是实测值。
- **实现前必须用 `9z5.3` 的实测结果复核本节的 4 张 / 16 格 / 1600 px / 4000 token 四个数**；若实测宿主上限更紧，以实测为准，本文件随之更新。
- 若宿主返回的图片被裁剪或降采样，**必须**在 `budget.warning` 里写明「host may downscale」，让 agent 知道它看到的格子比 `cell=` 标的小。

---

## 11. 用法指引与 server instructions

### 11.1 给 agent 的用法指引（内嵌在工具描述里）

0.2.0 起不再维护第三份独立的用法指引文本。给 agent 的指引只有两个权威来源，且都逐字来自本契约：

1. **六个工具描述**（§4.1 / §5.1 / §6.1 / §7.1 / §15.1 / §16.1）：每个工具自己该在什么时候用、参数怎么传、结果怎么读，都写在描述里。
2. **server instructions**（§11.2）：通过 MCP `initialize` 的 `instructions` 字段下发，讲清 probe → overview → zoom / locate 的读流程、bookmark / annotate 的写流程，以及全局纪律。

两者都由 `src/server/tools.js` / `src/server/server-instructions.js` 逐字复制，改契约等于改代码。几条不变的硬约束（描述与 instructions 里都能找到对应句子）：

- **只吃本地绝对路径**，不下载、不检索、不碰 cookie；server 不调 LLM，理解由 agent 的模型完成。
- **文字来源分三档可信度**：`text`（原生文字层 / 纯文本，字符精确，可原样引用）> `subtitle` / `ocr`（可能是机器生成 / 识别，专名数字要核对画面）> `asr`（机器听写，**不可当原话引用**）。`mixed` 只表示整份文档的逐页来源不一致。
- **全文永远落盘**：`media_overview` 的 text content 末尾有 `full text: <content.md 绝对路径> ...` 一行；内联的只是预览（文本三档 whole / skim / sampled，或 outline 目录视图），读全文要读文件。
- **宫格图只用来找位置**，读画面上的字必须 `media_zoom` 单帧放大。
- **长素材先收窄**（`start`/`end` 或 `pages`），再跟着 `continuation` 翻页；`view:"outline"` 先拿**唯一一份**目录（bookmark sidecar → 文件自带 PDF 书签 / 章节 → heading 生成）。
- **只有 `media_bookmark` / `media_annotate` 会改文件**：PDF 原地改 outline / 批注，视频/录音只写 `.mmgrep.*.vtt`，所有类型都写 `.mmgrep.*.json` sidecar；sidecar 是唯一真相源，外部改动会被下次写入覆盖，动原件前请 `git commit`。

### 11.2 server instructions（可直接粘贴进 MCP server 的 `instructions` 字段）

```text
MultiMediaGrep gives you eyes and ears over LOCAL media files: video, audio recordings and
documents. It never downloads anything and never calls an LLM — you always pass a local
absolute path, and it prepares images and text for your own multimodal model to look at.
Read with media_probe → media_overview → media_zoom / media_locate; write with
media_bookmark / media_annotate.

READING ORDER
1. media_probe first — cheap, no image tokens. Gives duration / page count / tracks and
   whether transcription (ASR), OCR and a native text layer are available for this file. For
   audio it also gives a health check (level, speech ratio): a recording with no effective
   speech yields an EMPTY transcript by design.
   If the probe says "text layer: looks unreliable", the PDF's text layer is probably the
   output of a bad OCR pass: call media_overview({ path, ocr: "force" }) to re-recognize the
   requested pages with the OCR provider (this needs MMGREP_OCR_PROVIDER configured). Forced
   pages are tagged "ocr" and cached separately from the default "auto".
   The probe shows ONE outline from the first available source: the bookmark sidecar
   ("<file>.mmgrep.bookmark.json", written by media_bookmark), otherwise the file's own
   outline — PDF bookmarks (PHYSICAL page numbers — the same 1-based numbers media_overview
   accepts — plus the printed page label when the PDF defines one) or chapter markers in
   video/audio files (title + start/end timestamps). Every entry carries an id (b1…bN); those
   are the ids media_bookmark accepts. Use the outline to pick a range instead of reading the
   whole file. When a sidecar exists, its last outline line is "full detail: <sidecar path>".
   The probe also reports the file's ANNOTATIONS (the count and the annotation sidecar path).
   The notes themselves are shown by media_overview and searched by media_locate.
2. media_overview — the main read. Video: numbered storyboard grids plus a time-aligned text
   index. Audio: a timestamped transcript. Document: page thumbnails plus page text.
   The full text of the requested range is written to disk, and the result text ends with a
   "full text: /abs/path/content.md ..." line. That absolute path is what you read
   (segments.jsonl and manifest.json sit in the same directory): read those files section by
   section and summarise them in chunks yourself — do not re-call the tool just to get more
   inline text. The inline list is a preview with three tiers: complete when the range fits
   ("complete text ... nothing omitted"); otherwise a document that exposes block structure is
   skimmed — every heading plus the first sentence of each paragraph (tables as
   "[table: caption]"), labelled per page like "[page 4 · skim: 12 of 210 sentences]". A skim
   built from built-in heuristic blocks is best-effort, so read content.md for the authoritative
   text. Everything else — video, audio, documents without blocks, or a skim that still does not
   fit — is sampled evenly from complete units, with a "preview: sampled ..." line naming what
   was inlined and the pages/ranges not represented. In a skim that does not fit, all headings
   are kept and sentences are sampled; only when even the headings do not fit are they sampled.
   The outline comes from the same single source as the probe: the bookmark sidecar first, then
   the file's own PDF bookmarks / video-audio chapters. A document without either may get an
   outline generated from its headings (at least 5), labelled "outline: generated from
   headings"; video/audio without chapters is NEVER given a generated outline. With view "auto"
   (default), a range that fits still returns the full text; when it does not fit and an outline
   exists, the outline comes first and the rest of the budget goes to the text preview. view
   "outline" returns only that outline. view "text" forces the text pipeline. When a sidecar
   exists, its last outline line is "full detail: <sidecar path>".
   The result also shows the ANNOTATIONS of the requested range, right next to the pages /
   time range they belong to: the annotation sidecar when one exists, otherwise the file's own
   PDF annotations. One per line, starting with its id ("n3 (p.12): note" for PDFs,
   "n3 (00:12:34–00:12:39): note" for video/audio) — those are the ids media_annotate accepts.
   The author is in structuredContent.annotations only. When an annotation sidecar exists, the
   block ends with "full detail: <sidecar path>".
3. media_zoom — only for parts that matter. One frame of a video (at, or a start/end window)
   or one page of a document, optionally cropped.
4. media_locate — "where was X said" (timestamp) or "on which page" (page number). Text only
   by default; includeFrame adds one picture at the best match. It carries the same single
   outline in structuredContent.outline, and it also searches annotation notes: annotation
   hits are marked as annotations, never as media content.

WRITING — bookmarks and annotations
- media_bookmark writes the outline (PDF bookmarks, video/audio chapters, or the sidecar for an
  image). media_annotate writes notes and comments. Call them only when the user asks you to
  change a file, after reading it.
- The sidecar next to the source is the single source of truth:
  "<file>.mmgrep.bookmark.json" and "<file>.mmgrep.annotation.json". Each write also embeds:
  a PDF's outline / annotation objects are rewritten IN PLACE — the PDF file itself changes,
  no copy is made, and the page content is not rewritten. A video or audio file is never
  modified: only "<file>.mmgrep.bookmark.vtt" / "<file>.mmgrep.annotation.vtt" is written.
  An image gets the sidecar only.
- The first write imports the file's own outline / annotations as b1…bN / n1…nN, then applies
  the call. Afterwards the sidecar wins: external edits to the file's own outline / annotations
  are overwritten by the next write. One call can mix add / remove / update (applied remove →
  update → add) and is all-or-nothing: if anything is invalid, nothing is written and every
  problem is listed at once. ids never change; new ids are max+1 and are never reused. Protect
  your originals with git (or a backup) before calling a write tool.
- The result lists the full outline / annotations in the read-side format, then the sidecar
  path, the embed target and every check result. Read-only tools never create or modify a
  sidecar.

TEXT SOURCE ORDER — subtitles first, ASR only as a fallback
1. a subtitle you select explicitly (subtitle: a file path, a track index, or a language code),
2. the subtitle track embedded in the container,
3. a subtitle file with the same base name in the same directory (a.srt next to a.mp4),
4. ASR, and only when none of the above exists.
Every segment carries a source tag. "subtitle" comes from a subtitle file/track; usually the
author's words, but may be auto-generated: check names and numbers against the frame.
"asr" is machine transcription: names, numbers and jargon are often wrong, so NEVER quote an
ASR segment as the speaker's exact words and never present it as a verbatim quotation.
"text" is native text — a PDF text layer or a plain-text file: character-exact, and may be
quoted directly.
"ocr" is text read off a rendered page — check names and numbers against the page image.
"mixed" (documents only) means the returned pages have different sources — read the tag on
each page before quoting.
"visual" means there is no text at all, only the picture.

READING PICTURES
The storyboard grid is for FINDING things, not reading them: a cell is only a few hundred
pixels wide, so text inside it is unreadable. To read text on screen, zoom — media_zoom on
that moment, then read the cropped single frame.

TOKEN DISCIPLINE
- Long media must be narrowed with start/end (video, audio) or pages (document) before you
  overview it, then paged through with the continuation hint in the result. A skim or sampled
  preview is not the full text — read content.md from disk instead of assuming the preview is
  complete.
- Prefer more images with fewer cells over one image with many cells: 2 images x 9 legible
  cells beats 1 image x 16 tiny ones at the same token order.
- Zoom only what the overview showed you is worth zooming into.
- A single call returns at most 4 images, at most 16 cells per image and at most 64 cells in
  total; a single image is at most 1600 px on its long edge. Exceeding that is an error with
  a suggested smaller shape, not a silent truncation.

WHEN TEXT IS UNAVAILABLE
If media_probe reports that no ASR provider, no OCR provider and no native text layer are
available, or that the recording has no effective speech, you get the visuals only: describe
what is on screen and state plainly that the spoken or written content was not available. Do
not invent dialogue, captions or page text.

FORMATS
- Timestamps are given both as integer milliseconds (*Ms) and as seconds (*Sec); both refer to
  the same instant.
- Video and audio ranges are closed intervals of seconds: start/end, both ends included.
- Document ranges use a comma-separated list of 1-based page numbers and closed ranges, e.g.
  "3-10,15". Out-of-range pages are an error, never a silent truncation.
- The full text of an overview is written to disk; the result text ends with the absolute path
  of content.md (segments.jsonl and manifest.json sit in the same directory). Read those instead
  of asking for more inline text. If the export failed, the line says "full text: NOT written —
  <reason>" and the inline preview is all you have.
- Annotation positions use the same units as the read tools: PDF page plus rect
  {x, y, width, height} as fractions 0..1 of the page (top-left origin, the same space as
  media_zoom crop); video/audio start/end in seconds, with end defaulted to start + 5 s and
  clipped to the media duration; an image uses rect only.
- Outline and annotation ids are stable: b1…bN for outlines, n1…nN for annotations. Pass them
  back to media_bookmark / media_annotate unchanged.

TOOL DESCRIPTIONS CARRY CHINESE TRIGGER WORDS (探媒体 / 视频 / 录音 / 文档 / 转写 / 字幕 /
关键帧 / 放大 / 提取文字 / 定位 / 截图), so Chinese requests match them too.
```

---

## 12. 环境变量

全部前缀 `MMGREP_`。查看方式：`env | grep MMGREP_`。

### 12.1 缓存

| 变量 | 类型 | 默认值 | 作用 | 没配 / 配错时的行为 |
|---|---|---|---|---|
| `MMGREP_CACHE_DIR` | string | `~/.cache/multimediagrep`（Linux/macOS） | 缓存根目录：抽帧、页图、转写、全文落盘都在这。**按文件内容 hash 键控**（主键 = 内容 sha256），另有一份指纹索引做快速路径，见 §9.0 | 用默认目录。目录不存在会自动创建；不可写时**调用不失败**：全文落盘退回系统临时目录，`full text:` 行会注明这份副本可能被清理（`structuredContent.fullText` 仍给出路径） |
| `MMGREP_CACHE_MAX_BYTES` | integer（字节） | `10737418240`（10 GiB） | 缓存总容量上限。超出时按 **LRU** 淘汰（先删最久未访问的整条目） | 用默认值。每次写入后检查一次；单条超过上限的产物直接跳过缓存并只返回本次结果 |

### 12.2 ASR provider

| 变量 | 类型 | 默认值 | 作用 | 没配 / 配错时的行为 |
|---|---|---|---|---|
| `MMGREP_ASR_PROVIDER` | string | `none` | 生效的 ASR 后端。`none` = 完全不做转写；`elevenlabs` = ElevenLabs；`openai-compatible` = 按 OpenAI `/audio/transcriptions` 方言的兼容服务。选定后只读取该 provider 自己那组 key / baseUrl / model 变量 | `none` → `capabilities.asr.available = false`，`reason` 写「MMGREP_ASR_PROVIDER is \"none\"」。此时**只出画面**。另外：音频体检判定 `too-quiet` / `silent` 时**即使配了 provider 也不跑 ASR**（见 §4.3.1）。未知 provider id → 记 warning 并回落到 `none` |
| `MMGREP_ELEVENLABS_API_KEY` | string | 空 | `elevenlabs` 的 API key | 云端 provider 缺 key → `PROVIDER_NOT_CONFIGURED`（不猜、不匿名试）。若 `MMGREP_ELEVENLABS_BASE_URL` 指向回环地址（`127.0.0.1` / `localhost` / `[::1]`），则**不需要** key |
| `MMGREP_ELEVENLABS_BASE_URL` | string | `https://api.elevenlabs.io/v1` | ElevenLabs 的 API 基址 | 用默认值。填回环地址即视为本地服务，免 key |
| `MMGREP_ELEVENLABS_MODEL` | string | `scribe_v1` | ElevenLabs 转写模型名 | 用默认值。模型不被 provider 接受 → `PROVIDER_FAILED`，并把 provider 的原话带上 |
| `MMGREP_OPENAI_COMPATIBLE_API_KEY` | string | 空 | `openai-compatible` 的 API key | 缺 key → `PROVIDER_NOT_CONFIGURED`；回环地址免 key |
| `MMGREP_OPENAI_COMPATIBLE_BASE_URL` | string | `https://api.openai.com/v1` | OpenAI 兼容服务的 API 基址 | 用默认值；自建服务显式填自己的地址 |
| `MMGREP_OPENAI_COMPATIBLE_MODEL` | string | `whisper-1` | OpenAI 兼容服务的转写模型名 | 用默认值。**不会**继承 ElevenLabs 的 `scribe_v1`；模型不被接受 → `PROVIDER_FAILED` |
| `MMGREP_ASR_LANGUAGE` | string | `auto` | 强制语言（BCP-47，如 `zh` / `en`）。`auto` = 由 provider 自动判定 | 用默认值。填了不被支持的语言 → `PROVIDER_FAILED`（provider 原话） |
| `MMGREP_ASR_MAX_BYTES` | integer | `104857600`（100 MiB） | 单次上传给 ASR 服务的音频上限 | 用默认值。超过时 provider 自己报错（不会切成无数片偷偷上传） |
| `MMGREP_ASR_DIARIZE` | boolean | `false` | 仅 `elevenlabs`：是否向服务请求说话人分离。**本版只透传请求，还没有把 speaker 回填到 segments**（字段恒为 `null`） | 用默认值；`openai-compatible` 忽略它 |
| `MMGREP_ASR_RESPONSE_FORMAT` | string | `verbose_json` | 仅 `openai-compatible`：请求的响应格式（要时间戳就得是 `verbose_json`） | 用默认值；服务不支持该格式 → `PROVIDER_FAILED` |
| `MMGREP_ASR_TIMESTAMP_GRANULARITIES` | string | 空 | 仅 `openai-compatible`：逗号分隔的时间戳粒度（`word` / `segment`） | 空 = 不传，由服务默认 |

> **provider 扩展变量**：`MMGREP_ASR_MAX_BYTES` / `MMGREP_ASR_DIARIZE` / `MMGREP_ASR_RESPONSE_FORMAT` /
> `MMGREP_ASR_TIMESTAMP_GRANULARITIES` 由 ASR provider 适配器直接读取（`src/providers/asr/`），
> 不经 `config.js`，所以不会出现在 `describeConfig()` 的输出里。

> 兼容兜底：`MMGREP_ASR_API_KEY` / `MMGREP_ASR_BASE_URL` / `MMGREP_ASR_MODEL` 在对应的 provider 专属变量未设置时仍然生效，但会在 `config.warnings` 里记一条弃用提示。**0.2.0 未删除它们**（本版删的是文档 provider 的 `MMGREP_DOC_*`）；按现有计划，删除会发生在后续大版本。旧 `MMGREP_ASR_MODEL` 与 `openai-compatible` 同用时还会额外警告该值可能不适配。

### 12.3 文档 provider：OCR 角色

0.2.0 起文档 provider 拆成 **ocr** / **typeset** 两个角色（契约 v2）。OCR 角色只处理
**没有文字层**的页（以及 `ocrMode=force` 的页）。工具参数 `ocr: "force"`（`media_overview` /
`media_locate`）由工具层转成后端的 `ocrMode=force`：请求页无论有没有文字层都交给这个角色，
结果 `textOrigin = "ocr"`、页标 `(ocr)`，并按独立缓存键保存。

| 变量 | 类型 | 默认值 | 作用 | 没配 / 配错时的行为 |
|---|---|---|---|---|
| `MMGREP_OCR_PROVIDER` | string | `none` | 无文字层页面的文字识别后端：`mineru` \| `none` | `none` → 扫描件 / 图片只出页图，`textOrigin = "unknown"`，`reason` 写明「MMGREP_OCR_PROVIDER is \"none\"」。未知 provider id → 记 warning 并回落到 `none` |
| `MMGREP_MINERU_API_KEY` | string | 空 | MinerU 的 API token（两个角色共用） | 云端 provider 缺 key → `PROVIDER_NOT_CONFIGURED`；回环地址免 key |
| `MMGREP_MINERU_BASE_URL` | string | `https://mineru.net/api/v4` | MinerU 的 API 基址（两个角色共用） | 用内置默认值 |
| `MMGREP_MINERU_MODEL` | string | 空 | MinerU 的解析模型名；留空 = 服务端默认（两个角色共用） | 用内置默认值 |

> 0.2.0 删除：`MMGREP_DOC_PROVIDER` / `MMGREP_DOC_API_KEY` / `MMGREP_DOC_BASE_URL` /
> `MMGREP_DOC_MODEL` **不再读取**。启动时检测到会 warn 并指出替代变量
> （`MMGREP_OCR_PROVIDER` / `MMGREP_TYPESET_PROVIDER` / `MMGREP_MINERU_*`），不静默忽略。

### 12.4 文档 provider：typeset 角色

typeset 角色只处理**有文字层**的页，恢复阅读顺序与结构；**不得重新识别字符**。
provider 无法保证原字符时必须返回 `textOrigin = "ocr"` / `"unknown"`。

| 变量 | 类型 | 默认值 | 作用 | 没配 / 配错时的行为 |
|---|---|---|---|---|
| `MMGREP_TYPESET_PROVIDER` | string | `builtin` | 有文字层页面的排版后端：`builtin` \| `mineru` \| `none` | `none` → 有文字层的页直接用原生 `pdftotext` 文本（无结构重排）。未知 provider id → 记 warning 并回落到 `builtin`。`builtin` 是本地实现，不联网 |
| `MMGREP_TYPESET_SKIP_SIMPLE` | boolean | `true` | 外部 typeset provider 是否跳过「builtin 判定为单栏的简单页」：`true` = 简单页交给本地 builtin，只把双栏 / 复杂页发给外部服务（省调用、省排队） | 用默认值。`false` = 所有有文字层的页都交给外部 typeset provider；非法值记 warning 并回落 `true` |

### 12.5 运行时与预算

| 变量 | 类型 | 默认值 | 作用 | 没配 / 配错时的行为 |
|---|---|---|---|---|
| `MMGREP_MAX_IMAGE_TOKENS` | integer | `4000` | 单次调用的图片 token 软预算（§10.3） | 用默认值。自动模式保证不超；显式模式超出只警告 |
| `MMGREP_MAX_IMAGE_EDGE` | integer | `1600` | 单张图最长边的全局上限（§10.2） | 用默认值。请求超过它 → `BUDGET_EXCEEDED` |
| `MMGREP_MAX_TEXT_INLINE_CHARS` | integer | `24000` | 内联文本预览的字符上限（含 header / notes / `full text:` 行）。超出时：有目录（bookmark sidecar、文件自带的 PDF 书签 / 章节，或只对 overview 生效的文档 ≥5 个 heading）时，`view:"auto"` 先出目录（最多占一半预算），余量再走文档 skim（全部 heading + 段首句，每页 `[page N · skim: X of Y sentences]`）/ 完整单元等距抽样；没有目录时直接 skim / 抽样。`view:"outline"` 只出目录。两种情况都写明未覆盖范围。HTTP 模式下可被请求头 `x-mmgrep-max-text-inline-chars` 按客户端覆盖（硬上限 `200000`） | 用默认值。**全文永远落盘，不受此限制** |
| `MMGREP_MAX_CONCURRENCY` | integer | `2` | 单次调用内并行跑的 ffmpeg / 渲染任务数 | 用默认值。机器弱时调成 `1` |
| `MMGREP_AUDIO_MIN_DBFS` | number | `-35` | 音频体检：判定「有有效声音」的平均音量下限（dBFS）。低于它 → `too-quiet`，**不跑 ASR** | 用默认值。录音确实偏小声时调低（如 `-45`） |
| `MMGREP_AUDIO_MIN_SPEECH_RATIO` | number | `0.05` | 音频体检：判定「有有效声音」的非静音时长占比下限（0–1） | 用默认值。与 `MMGREP_AUDIO_MIN_DBFS` 是 **或** 的关系，任一不满足即判 `too-quiet` |
| `MMGREP_ASR_TIMEOUT_MS` | integer | `120000` | ASR 单次请求超时 | 用默认值。超时 → `PROVIDER_FAILED: ASR request timed out after 120000 ms.` |
| `MMGREP_DOC_TIMEOUT_MS` | integer | `180000` | 文档解析单次请求超时（OCR 与 typeset 两个角色共用同一值） | 用默认值。超时 → `PROVIDER_FAILED` |
| `MMGREP_FFMPEG_PATH` | string | 空（按 PATH 查找） | ffmpeg 可执行文件路径 | 找不到 → `TOOL_NOT_FOUND: ffmpeg was not found on PATH. Install ffmpeg, or set MMGREP_FFMPEG_PATH.` |
| `MMGREP_FFPROBE_PATH` | string | 空（按 PATH 查找） | ffprobe 可执行文件路径 | 同上，文案换成 `ffprobe` |
| `MMGREP_LOG_LEVEL` | string | `info` | 日志级别：`error` / `warn` / `info` / `debug` | 用默认值。`debug` 会额外打印每阶段耗时（只进 stderr，不污染 MCP 输出） |
| `MMGREP_PROGRESS_NOTIFICATIONS` | boolean | `true` | 是否发 MCP `notifications/progress`（§2.6）。**本 server 的运维扩展**，不属于工具契约，宿主不支持时由框架静默跳过 | 用默认值。`false` = 完全不发进度通知，结果不变 |

> **HTTP 每请求覆盖（目前只有 `MMGREP_MAX_TEXT_INLINE_CHARS`）**：请求头
> `x-mmgrep-max-text-inline-chars` 的优先级是 **请求头 > `MMGREP_MAX_TEXT_INLINE_CHARS` > 默认 `24000`**。
> 头值必须是正整数：超过硬上限 `200000` 时按 `200000` 截断并记 warning；非法值（`0`、负数、
> 小数、带单位、非数字）记 warning 并回落到环境变量 / 默认值，**不会让请求失败**；空头等于没带。
> stdio 传输没有请求头，仍然只读环境变量；也**没有**按调用的工具参数——agent 不能自己调大。
> 头值不进日志（日志只出现头名），也不进 `requestOverrides`（那里只记录头名）。

> **文档 provider 逐页缓存键**（含 `ocrMode`；工具参数 `ocr: "force"` 单独成键、不覆盖 auto）
> 见 §2.7 与 §9.0。`ocr` 是工具参数，不是环境变量。

> **MCP 的 stdout 是协议通道**：日志一律走 stderr，`LOG_LEVEL` 控制不了这一点。

### 12.6 传输（HTTP 模式）

| 变量 | 类型 | 默认值 | 作用 | 没配 / 配错时的行为 |
|---|---|---|---|---|
| `MMGREP_TRANSPORT` | string | `stdio` | 传输方式：`stdio`（默认）或 `http` | 写错 → 记 warning 并回落 `stdio` |
| `MMGREP_HTTP_HOST` | string | `127.0.0.1` | HTTP 监听地址 | 非回环地址且没配令牌 → 记 warning（仍会启动并接受未认证请求） |
| `MMGREP_HTTP_PORT` | integer | `3927` | HTTP 监听端口（1–65535） | 非法值 → 记 warning 并用 `3927` |
| `MMGREP_HTTP_TOKEN` | string | 空 | Bearer 令牌；设置后每个请求必须带 `Authorization: Bearer <令牌>`。任意 UTF-8 字符都可以（比较时按原始字节做，不走字符串编码） | 空 = 不鉴权。只认 Authorization 头，不接受 query string |

命令行 `--http` / `--host` / `--port` / `--token` 优先于环境变量；`--host` / `--port` / `--token`
不带 `--http` 时不会改变传输方式。端点的 `Accept` / `Content-Type` 要求与状态码见 §2.8。

### 12.7 每请求凭据与设置头（仅 HTTP）

请求头名与 provider 专属环境变量一一对应（`MMGREP_FOO_BAR` → `x-mmgrep-foo-bar`）：

| 请求头 | 作用 | 对应环境变量 |
|---|---|---|
| `x-mmgrep-asr-provider` | 本次请求的 ASR provider：`elevenlabs` / `openai-compatible` | `MMGREP_ASR_PROVIDER` |
| `x-mmgrep-elevenlabs-api-key` | ElevenLabs key | `MMGREP_ELEVENLABS_API_KEY` |
| `x-mmgrep-elevenlabs-base-url` | ElevenLabs 基址 | `MMGREP_ELEVENLABS_BASE_URL` |
| `x-mmgrep-elevenlabs-model` | ElevenLabs 模型 | `MMGREP_ELEVENLABS_MODEL` |
| `x-mmgrep-openai-compatible-api-key` | OpenAI 兼容服务 key | `MMGREP_OPENAI_COMPATIBLE_API_KEY` |
| `x-mmgrep-openai-compatible-base-url` | OpenAI 兼容服务基址 | `MMGREP_OPENAI_COMPATIBLE_BASE_URL` |
| `x-mmgrep-openai-compatible-model` | OpenAI 兼容服务模型 | `MMGREP_OPENAI_COMPATIBLE_MODEL` |
| `x-mmgrep-asr-api-key` | 通用兜底 key（旧共用变量语义） | `MMGREP_ASR_API_KEY` |
| `x-mmgrep-ocr-provider` | 本次请求的 OCR 角色 provider：`mineru` / `none` | `MMGREP_OCR_PROVIDER` |
| `x-mmgrep-typeset-provider` | 本次请求的 typeset 角色 provider：`builtin` / `mineru` / `none` | `MMGREP_TYPESET_PROVIDER` |
| `x-mmgrep-mineru-api-key` | MinerU token（两个角色共用） | `MMGREP_MINERU_API_KEY` |
| `x-mmgrep-mineru-base-url` | MinerU 基址（两个角色共用） | `MMGREP_MINERU_BASE_URL` |
| `x-mmgrep-mineru-model` | MinerU 模型（两个角色共用） | `MMGREP_MINERU_MODEL` |
| `x-mmgrep-max-text-inline-chars` | 本次请求的内联文本上限（非凭据设置头）：正整数，超过硬上限 `200000` 截断并 warn，非法值 warn 后回落 | `MMGREP_MAX_TEXT_INLINE_CHARS` |

优先级（逐字段计算）：该 provider 的专属请求头 > 该 provider 的环境变量 >
启动配置（仅当 provider 相同）> provider 内置默认值。ASR 仍保留通用
`x-mmgrep-asr-api-key` 兜底；文档角色已删除通用 key 头（`x-mmgrep-doc-api-key` 等不再识别）。

- 请求头里的 provider 选择**只对当前请求生效**；未知 provider id → HTTP 400 / JSON-RPC `-32602`。
- 空头（空串或全空白）等于没带，不会覆盖服务器配置。
- 只带 provider 专属 key 头、却没选中该 provider（`x-mmgrep-asr-provider` 缺失且服务器 provider 为 `none`）时，该头不会自动启用 provider。
- 这些头的**值**不写日志、不进缓存、不出现在响应里；日志中出现的头值统一替换为 `[redacted]`（`x-mmgrep-max-text-inline-chars` 的值同样不进日志，只出现头名）。
- `x-mmgrep-max-text-inline-chars` 是**设置**头，不参与凭据检测：只带它时不会新建 provider，只覆盖内联上限。

---

## 13. 与上游 `dsh-video-storyboard` 的差异

上游 v0.5.9 的契约在 `src/tool-spec.js`（公开入口）→ `src/storyboard/tool-spec.js`（真正定义）。上游 5 个工具：`video_probe` / `video_storyboard` / `video_zoom` / `video_locate` 与一个字幕工具。

### 13.1 逐条差异

| # | 上游 | 本契约 | 原因 |
|---|---|---|---|
| 1 | 按**媒体**命名：`video_probe` / `video_storyboard` / `video_zoom` / `video_locate` / 字幕工具 | 按**动作**命名：`media_probe` / `media_overview` / `media_zoom` / `media_locate`（字幕读取并入 `media_overview`） | 跨媒体复用：同一动作在视频 / 录音 / 文档上语义一致，agent 学一套动词就够。`video_storyboard` → `media_overview`（"storyboard" 是视频特有的词，录音没故事板）。字幕不是独立动作，作为 `media_overview` 的纯文本模式提供 |
| 2 | 参数名 `input` | 参数名 `path` | `path` 直接表达「本地路径」这条硬约束；`input` 什么都能装 |
| 3 | `input` 接受 http(s) 链接；另有 `cookies` / `allowAnonymous` / `quality` / `scanHeight` / `zoomHeight` / `size` | **全部删除** | server 不做取数、不碰 cookie、不下载。这些参数是为 yt-dlp 下载链路的清晰度服务的，本地文件用不上 |
| 4 | `from` / `to` | `start` / `end` | 与 `at`（时刻）、`pages`（页码）在语义上更整齐；`from` 在 JS/DB 里含义太多 |
| 5 | 无 `pages` | 新增 `pages` | 文档没有「秒」，只有页码。上游完全没有文档概念 |
| 6 | 无裁切参数（只有字幕用的 `band`） | 新增 `crop` | 特写的核心能力就是取局部 |
| 7 | 无全文落盘 | `media_overview` 返回 `content.md` / `segments.jsonl` / `manifest.json` 的绝对路径 | 上游的清单是给人看的散文，受宿主 24k 字符上限截断（上游自己在 `format.js` 里写了这一条）。我们需要给下游蒸馏器一份**结构化全文** |
| 8 | ASR 后端写死为 OpenAI `/audio/transcriptions` 方言，配置在 `asr.json` / `DSH_ASR_*` | provider 化：`MMGREP_ASR_PROVIDER` + baseUrl / apiKey / model / language | 换后端不改代码。上游 `asr-contract.md` 本身就强调「provider-agnostic」，我们把它抬到配置层 |
| 9 | OCR 是「用硬字幕校正 ASR 文本」的附属功能，走 Python `rapidocr`（`src/ocr_bridge.py`） | OCR 是「扫描件没有文本层时的兜底」，独立 provider | **目标不同**：上游校正的是视频里的错字；我们补的是扫描件根本没有文字层 |
| 10 | 无文档支持 | 新增 document 后端（栅格化 + 文档解析 provider） | 项目需求 |
| 11 | 无录音支持 | 新增 audio 后端（ffmpeg → WAV → ASR） | 项目需求 |
| 12 | 5 个纠缠的尺寸旋钮：`cells` / `sheets` / `budget` / `need` / `maxPerSheet` / `size` | 收敛为 `cells` / `images` / `maxEdge` | 跨媒体后（文档用「页」当格）旋钮越少越好用。`budget` 折进 `maxEdge`；`need`（可读性档位）由服务端按 `cells` 推导，并在清单里报告实际档位 |
| 13 | `cellRange` / `textOnly` / `hotwords` / `planThresholds` / `sourceHash` / `pick` / `burn` / `minGap` / `adaptive` / `ocr` / `tileFirst` | 保留 `segment` 与 `transcript`；其余**下沉为服务端默认**或暂不支持 | 契约层只保留「agent 能自己决策」的旋钮；`burn`/`pick`/`minGap`/`adaptive` 是实现细节，让 agent 操心只会出乱子 |
| 14 | `cellId`（zoom 引用上次分镜的格号） | 取消 | `media_overview` 的每格都带 `startMs`/`endMs`，agent 直接传时间戳即可，不需要服务端维护 cell 映射表 |
| 15 | 返回 `{ images: [attachment], text }`，图片走 DSH `attachments` 服务 | 返回标准 MCP content blocks：`{type:"image", data: base64, mimeType}` + `structuredContent` | 我们是标准 MCP server，不依赖 DSH 宿主。附带收益：任何 MCP client 都能直接看到图 |
| 16 | 上游的字幕工具 = 把**硬字幕**裁成一条竖长图（`subtitle-strip.js` / `buildSubtitleStrip`） | 本契约 = 读字幕文件 / 内嵌字幕轨，解析成**带时间轴的文本段落**，由 `media_overview`（`images: 0` + `transcript: "subtitle"`）承担，不出图 | 需求定位不同。我们先做「读已有字幕」这件高频事；裁硬字幕带的能力可以由 `media_zoom` 的 `crop` 部分覆盖，属于可后置项 |
| 17 | 上游的字幕文件参数只吃 SRT 与 JSON（`[{start,end,text}]` / `[{from,to,text}]` / B 站 `{body:[…]}`） | 吃 `.srt` / `.vtt` / `.ass` / `.ssa` | 字幕文件更通用。**注意**：VTT/ASS 的解析是**新代码**，上游没有现成实现（上游 `transcript-file.js` 只有 SRT + JSON） |
| 18 | `video_locate` 用 LCS 归一化匹配（上游 `locate.js` 的 `matchSegments`，中英文同构、忽略标点空白） | 沿用同一套打分（由本项目 `src/media/match.js` 独立实现，思路来自上游） | 上游行为已验证（阈值 `minScore=0.34`、同分短句优先），不重写 |
| 19 | `video_locate` 纯文本、永不出图 | 默认纯文本，`includeFrame: true` 时附一张最佳匹配处的画面 | 保持上游的「定位不花像素」哲学，同时给需要看图的 agent 一个出口 |
| 20 | 无文档形态的 locate | `media_locate` 支持文档（返回页码 + 可选页图） | 跨媒体统一 |
| 21 | 无进度通知 | 长任务发 MCP progress notification | 上游靠 DSH 宿主；我们是标准 MCP，用标准机制 |
| 22 | 缓存目录 `DSH_VIDEO_CACHE_DIR`，单条上限 50 MB；**缓存键 = 路径 + 大小 + mtime** | `MMGREP_CACHE_DIR` + `MMGREP_CACHE_MAX_BYTES`（默认 10 GiB）；**缓存主键 = 文件内容的 sha256**，另有一份指纹索引（路径+大小+mtime → 内容 hash）做快速路径 | 统一前缀；本项目要缓存的是**全文与页图**，量级远大于上游的切点缓存。内容哈希做主键是 epic 决策 9：「文件改了但缓存还命中」是这类工具最致命的 bug，而 path+mtime 只是权宜之计。指纹索引解决「每次都全文件哈希」的代价 |
| 23 | 无 `media_probe` 的文档 / 音频形态 | `media_probe` 覆盖三种媒体 | 跨媒体统一 |
| 24 | 返回值里**不标**每段文字的来源，只有一个总的 `transcript="asr"` 之类的标记 | 每段带 `source`（`subtitle`/`text`/`ocr`/`asr`/`visual`/`none`；整份 `transcript` 还有 `mixed`）+ `origin`（`file`/`embedded`/`textlayer`/`asr`/`ocr`/`none`） | agent 必须能分辨「字幕文件里的文字」「PDF 原生文字层」和「机器猜的转写」。上游自己就踩过这个坑（专门写 OCR 模块用硬字幕校正 ASR），但**没有把可信度暴露给模型** |
| 25 | 上游的 `transcript: "auto"` 是「内嵌字幕轨优先，否则 ASR」，但显式字幕文件给了之后两者都跳过 | 明确的三级顺序：显式字幕选择 → 内嵌字幕轨 → ASR，并写进工具描述与 server instructions | 字幕优先是硬要求：**字幕准、免费、快**；ASR 会听错人名和数字。顺序必须写进 agent 看得到的文本里，不能只存在实现里 |
| 26 | 上游不做音频体检，直接送 ASR | `media_probe` 对音频返回 `audioHealth`（音量 / 语音占比 / 静音占比 / 判定），太安静直接**不跑 ASR** | 太安静的录音送进 ASR 会得到一整段幻觉台词，比没有转写更糟。体检必须发生在 ASR 之前，且结论要出现在 agent 看得到的文本里 |
| 27 | 上游 `video_zoom` 与 `video_storyboard` 都出图，没有「宫格只用来找位置」的约定 | 契约明确：**宫格图 = 找位置，裁切单帧 = 读文字** | 宫格一格只有几百像素，里面的字看不清；agent 常误以为「看过了图就知道上面写了什么」。这条必须写进用法指引，否则模型会拿宫格里的模糊笔画编内容 |

### 13.2 上游有、我们**故意不收**的能力

| 上游能力 | 上游位置 | 不收的原因 |
|---|---|---|
| URL 解析与下载（yt-dlp 集成） | `src/storyboard/fetch.js`（`resolveInput`）、`src/storyboard/ytdlp.js`、`src/storyboard/direct-url.js` | server 不做取数。取数在取数层（skills / 其它 agent），本 server 只处理已经落到本地的文件 |
| 浏览器时间线抓取 | `src/storyboard/browser-time.js` | 同上，属取数层 |
| 站点字幕轨抓取（如 C 站 CC） | `src/storyboard/subtitles.js`（`fetchRemoteSubtitles`） | 同上 |
| cookies / `allowAnonymous` / `DSH_VIDEO_COOKIES` | `src/storyboard/tool-spec.js` | 不碰 cookie |
| 下载清晰度控制（`quality` / `scanHeight` / `zoomHeight` / `size`） | 同上 | 本地文件永远读原分辨率，这些旋钮无意义 |
| 硬字幕带裁切（把画面上的字幕裁成竖长图） | `src/storyboard/subtitle-strip.js` | 与本契约的字幕读取语义不同（见 §13.1 #16）。作为 `media_zoom` + `crop` 的后置项 |
| 字幕带自动检测（`band` 参数 + 检测逻辑） | `src/storyboard/subtitle-strip.js` | 同上 |
| 陪看 `watch_together` | 属于 `dsh-watch-together` 包，不在上游 tool-spec 里 | 不在本次范围 |
| 热词 `hotwords` | 上游 `tool-spec.js` | 契约层先不做；需要时再加（会是个好用的旋钮） |
| 阈值覆盖 `planThresholds` | 同上 | 服务端内部调参，不该让 agent 传 |
| `sourceHash` | 同上 | 不再作为可选项：缓存**主键就是文件内容的 sha256**，内容哈希本来就必须算（上游把它做成可选只是因为它的缓存键是 path+size+mtime，不需要内容哈希） |
| `tileFirst` / `adaptive` / `minGap` / `pick` / `burn` | 同上 | 实现细节，下沉为服务端默认 |
| 观看状态 / 延迟标定（`watch.json` / `seen.jsonl` / `latency.json`） | `src/storyboard/memory.js`、`cache.js` 的 `PROTECTED_FILES` | 属于「陪看」产品形态，不属于工具契约 |
| `textOnly` / `cellRange` | 同上 | 由「全文落盘 + continuation 提示」取代：agent 要全文去读 `content.md` / `segments.jsonl`，不必再翻页 |

### 13.3 上游事实核对记录

| 核对点 | 结论 | 出处 |
|---|---|---|
| 上游 5 个工具名 | `video_storyboard` / `video_zoom` / `video_probe` / `video_locate` / 字幕工具 | `src/storyboard/tool-spec.js` 的 `TOOL_NAME` / `ZOOM_TOOL_NAME` / `PROBE_TOOL_NAME` / `LOCATE_TOOL_NAME` 与 `subtitlesToolSpec()` |
| 上游 `video_probe` 返回 | 只有 text，无图 | `probeToolSpec().output` |
| 上游 `video_locate` 返回 | 只有 text，无图 | `locateToolSpec().output` |
| 上游 `video_zoom` 参数 | `from` / `to` / `cells` / `cellId` / `crop` **没有** / 字幕文件参数等 | `zoomToolSpec().parameters` |
| 上游 `video_zoom` 必填 | 无 `cellId` 时必须给 `from` 与 `to` | `validateZoomArgs()` |
| 上游 `cells` 取值域 | storyboard 1–16，zoom 1–9 | `validateToolArgs()` / `validateZoomArgs()` |
| 上游 `budget` 取值域 | 320000–4000000 像素 | `validateToolArgs()` |
| 上游 `segment` 取值域 | 30–3600 秒 | `validateToolArgs()` |
| 上游 `maxStrips` / `band` | 1–40；`band` = `[y0,y1]` 比例 | `validateToolArgs()` |
| 上游图片计价 | `ceil(w/42) * (ceil(h/42)+1) + 2` | `src/storyboard/plan.js` 的 `imageTokens()` |
| 上游可读性档位 | `shot` 160×90 / `scene` 320×180 / `text` 480×270 | `src/storyboard/plan.js` 的 `NEED_TIERS` |
| 上游默认预算 | 1,200,000 像素/图（≈700 DSH token） | 上游 tool-spec 的 `budget` 描述 |
| 上游内联文本上限 | 24,000 字符，超出在 cell 边界截断 | `src/storyboard/format.js` 的 `formatManifest()` |
| 上游 locate 匹配 | LCS 归一化，`minScore=0.34`，同分短句优先 | `src/storyboard/locate.js` 的 `matchSegments()` |
| 上游字幕文件参数支持格式 | SRT / JSON 数组 / B 站 JSON | `src/storyboard/transcript-file.js` 头部注释 |
| 缓存目录 | `DSH_VIDEO_CACHE_DIR`，默认 `~/.cache/dsh-video-storyboard` | `src/storyboard/cache.js` 的 `cacheDir()` |
| 上游缓存键 | 路径 + 文件大小 + mtime 的哈希，**不含内容哈希** | `src/storyboard/cache.js` 的 key 构造；本项目改用**内容哈希**做主键（见 §9.0） |
| 上游 ASR 配置 | `asr.json` + `DSH_ASR_*`，OpenAI `/audio/transcriptions` 方言 | `docs/asr-contract.md` |

---

## 14. 未决问题（需要人来定）

> 0.2.0 已经落地的决策（文档 provider 双角色、`ocr: "force"`、目录 / `view`、`source` 新增 `text` / `mixed`、文档 locate 的 `hits` / `snippet`、provider 逐页缓存、24k 内联上限、同目录字幕自动发现、locate 默认不出图）不再列在这里——它们是契约本身，见对应章节。下面只列**仍未定或仍未验证**的事。

| # | 问题 | 我的建议 | 影响面 |
|---|---|---|---|
| 1 | **图片预算的四个数**（4 张 / 16 格 / 1600 px / 4000 token）是推导值，不是实测值 | 等 beads `9z5.3`（Claude Code / Hermes 实测）出来后按实测收紧 | §10 全部；实现必须先复核 |
| 2 | **`MMGREP_ELEVENLABS_BASE_URL` / `MMGREP_ELEVENLABS_MODEL` / `MMGREP_OPENAI_COMPATIBLE_BASE_URL` / `MMGREP_OPENAI_COMPATIBLE_MODEL` 的默认值** | 现值：ElevenLabs `https://api.elevenlabs.io/v1` + `scribe_v1`，OpenAI 兼容 `https://api.openai.com/v1` + `whisper-1`；但**本仓库未联网验证**各家当前的转写 endpoint 与模型名 | §12.2；配错会直接 `PROVIDER_FAILED` |
| 3 | **`MMGREP_MINERU_BASE_URL` / `MMGREP_MINERU_MODEL` 的默认值** | 现值：基址 `https://mineru.net/api/v4`、模型留空（服务端默认）；MinerU 的模型名与 `model_version` 语义**未在真实 key 上端到端验证**（beads `9z5.36` 是这条验证票） | §12.3；配错会 `PROVIDER_FAILED` |
| 4 | **`structuredContent` 的宿主兼容性** | 契约定义了结构化 payload，但**是否所有宿主都消费** `structuredContent` 需要按 SDK 版本验证；不支持时退化为只返回 content 文本块（文本内容不变，全文路径也在文本里） | §4.3 / §5.3 / §6.3 / §7.3 / §8.3 |
| 5 | **派生代码的许可与署名** | 上游 v0.5.0 起为 **Apache-2.0**。派生进来的部分保留上游署名：根目录 `NOTICE` 按 §4(d) 复现版权与授权，每个改动文件顶部按 §4(b) 标注修改；完整清单见 `CREDITS.md` | 打包与分发 |
| 6 | **音频体检的阈值** | 现值 `meanDbfs >= -35` 且 `speechRatio >= 0.05` 为「有有效声音」。这两个数是拍的，没有实测样本支撑；不同录音（手机远讲、会议室、播客）差别很大 | §4.3.1 / §12.5；上线前最好用一批真实录音回归 |
| 7 | **`speechRatio` 的静音门限（-45 dBFS）** | 短时 RMS 门限取 -45 dBFS，同样没实测 | §4.3.1；环境噪声大的录音需要调 |
| 8 | **指纹索引的过期窗口** | 指纹 = `sha256(path + ':' + size + ':' + mtimeMs)`。若文件被改动后**大小与 mtime 恰好都不变**，指纹会给出过期的内容 hash（概率极低但非零）。要不要提供「强制重算」开关（如 `MMGREP_CACHE_REHASH=1`），需要产品定 | §9.0 / §12.1 |
| 9 | **`document.json` 是否会变成必备件** | 现在是**可选件**（下游不需要 cangjie 时只读前三个）。若 cangjie 成为唯一或主要蒸馏器，它应当转正为必备并进契约测试 | §9.4 |
| 10 | **图片类文档 → `media_type: "pdf"` 的偏差** | cangjie 契约枚举里没有 `image`，所以图片文档在 `document.json` 里映射成 `pdf`，真实类型记在 `manifest.source.mediaType`。这是契约层面的妥协；若 cangjie 之后给枚举加了 `image`，映射应改回 | §9.4 |
| 11 | **builtin 启发式 blocks 的准确度** | builtin typeset 的「标题 / 双栏 / 表格」判定是启发式（见 `src/providers/doc/builtin.js`），skim 与生成的目录都标注了 best-effort。要提升结构准确度就配 `MMGREP_TYPESET_PROVIDER=mineru`；是否要再做一轮启发式回归，需产品定 | §5.4 skim、§5.1 目录 |
| 12 | **云端 MinerU 的 `textOrigin` 可能未知** | 云端结果包若不返回 `parse_mode` / OCR 证据，provider 只能保守标 `unknown`（下游按 `ocr` 处理）。是否要求用户显式声明 `model_version` 来消歧，需产品定 | §2.5 逐页映射、§12.3 |

---

## 15. `media_bookmark` — 增删改媒体目录（0.3.0）

> 0.3.0 新增的写工具。目录（书签 / 章节）的唯一真相源是源文件旁的
> `<file>.mmgrep.bookmark.json`（sidecar）；每次写入同时把目录嵌入文件本身：PDF 原地重写 outline，
> 视频 / 录音只写一个 VTT（**从不修改媒体文件**），图片只有 sidecar。

### 15.1 工具描述（英文，含中文触发词）

```text
Write bookmarks (an outline, chapters) into a local media file so they survive across sessions and are
visible to humans in the file itself: the PDF outline for a PDF, a sidecar VTT for video/audio, and a
sidecar JSON for every supported media type.
(写入书签 / 目录 / 章节：PDF 改写文件自带目录；视频、音频写同名 .mmgrep.bookmark.vtt；
所有类型都写 <file>.mmgrep.bookmark.json 侧车。中文触发词：书签、目录、章节、bookmark、outline、chapter。)

The sidecar "<file>.mmgrep.bookmark.json" is the single source of truth. The first write (no sidecar yet)
imports the file's own outline — PDF bookmarks, or video/audio chapter markers — as b1…bN in file order,
then applies this call. New ids are max+1 and are never reused; update keeps the id. One call can mix
add / remove / update; they are applied remove → update → add, all-or-nothing: if anything is invalid,
nothing is written and every problem is listed at once (unknown id, bad field, page/time out of range,
duplicate ids, malformed entry, …). An image has no native outline and gets the sidecar only; text and
Office documents are not supported.

WARNING — this tool modifies files:
- A PDF's outline is rewritten IN PLACE: the PDF file itself is modified in place, no copy is made.
- Files are written NEXT TO the source: a *.mmgrep.* sidecar for every media type, plus
  *.mmgrep.bookmark.vtt for video/audio. They are not written into the cache directory.
- When a sidecar already exists, external edits to the file's own outline are OVERWRITTEN on the next write.
- Protect your originals with git (or a backup) before calling this tool.

After the write, media_probe / media_overview / media_locate show this outline (ids b1…bN) instead of the
file's native one. The result contains the full outline, the sidecar path, the embed target, and every
check result. (书签 / 目录 / 章节 / bookmark / outline / chapter)
```

### 15.2 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|:---:|---|---|
| `path` | string | ✅ | — | 本地绝对路径（PDF / 图片 / 视频 / 录音） |
| `add` | array | ❌ | `[]` | 新增条目；**不许带 `id`**（id 由 server 分配） |
| `remove` | string[] | ❌ | `[]` | 要删除的 id（`b1`、`b12` …） |
| `update` | array | ❌ | `[]` | 要修改的条目：`{id, ...至少一个可改字段}`；不能改 id |

`add` / `remove` / `update` 至少给一个，三者全空会被拒绝。一次调用可以混用三种操作，依次应用
**remove → update → add**。

### 15.3 条目结构（按媒体）

**PDF**（`media: "pdf"`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|:---:|---|
| `title` | string | ✅ | 非空；首尾空白与连续空白会被折叠 |
| `page` | integer | ✅ | **物理**页码，1-based；probe 知道 `pageCount` 时校验 `1 ≤ page ≤ pageCount` |
| `level` | integer | ❌ | 书签层级，≥1 的整数，默认 1；决定 outline 的缩进 |

**视频 / 录音**（`media: "video"` \| `"audio"`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|:---:|---|
| `title` | string | ✅ | 非空；单行（写入 VTT 时折叠为一行） |
| `start` | number | ✅ | 起点，秒，≥0；知道时长时 `< duration` |
| `end` | number | ❌ | 终点，秒，必须 `> start` 且 `≤ duration`；省略时不写（回读时按 VTT 的缺省规则补） |

**图片**（`media: "image"`）：只有 `title`，没有位置字段。

通用规则：未知字段直接拒绝；`add` 条目里出现 `id` 会报错并提示「要换 id 请 remove 再 add」；
`update` 必须带 `id` 且至少改一个可写字段（PDF：`title` / `page` / `level`；视频/录音：
`title` / `start` / `end`）。

### 15.4 sidecar

- 路径：与源文件同目录、同 basename（**含扩展名**）加后缀：
  `/abs/a.pdf` → `/abs/a.pdf.mmgrep.bookmark.json`。
- 结构（UTF-8 JSON，`version` 固定 1）：

```json
{
  "version": 1,
  "media": "pdf",
  "entries": [
    { "id": "b1", "title": "Introduction", "page": 1, "level": 1 },
    { "id": "b2", "title": "Methods", "page": 3, "level": 2 }
  ]
}
```

- 条目按位置排序：PDF 按 `page`（稳定），视频 / 录音按 `start`（稳定），图片保持写入顺序。
- 条目字段就是 §15.3 的字段 + `id`；PDF 条目必须带 `page` 与 `level`。
- **sidecar 一旦存在就是唯一真相源**：后续读侧只展示它，写侧也只以它为基准。文件自带的
  outline 只在**第一次写入**时用来导入。
- 损坏的 sidecar（JSON 坏、`version` 不对、`media` 与文件不符、条目结构错、id 重复……）→
  `INVALID_ARGUMENT`，文案包含路径与每一个具体问题；**绝不覆盖**它，也不会拿文件自带目录顶替。
- 用户手工编辑 sidecar 是合法输入：只要结构合法就按原样接受（存储条目只做结构校验，不按当前
  页数 / 时长重新卡范围；旧条目不能因为文件变短而卡死写入）。
- 并发：没有锁与合并。两个写调用同时改同一个文件时，后写者胜出（sidecar 最后写入者胜出）。

### 15.5 id 规则与首次导入

- id 前缀固定 `b`：`b1`、`b2`、…；`isEntryId` 只认 `^b[1-9]\d*$`（没有 `b0`）。
- **首次写入**（sidecar 不存在）：用与读侧完全相同的 derive 助手，把文件自带目录按文件顺序导入成
  `b1…bN`，再应用本次操作。PDF 跳过没有物理页码的条目；视频 / 录音按章节顺序；图片没有可导入的
  原生目录（导入数恒为 0）。导入条目的 `title` 缺省为 `Page N` / `Chapter N`。
- 新增条目的 id = **操作前**条目里的 max + 1；同一次调用里连续新增会继续递增（不复用、不重排）。
- `update` 不改 id；`remove` 不重排剩余 id（删掉 `b2` 后不会把 `b3` 变成 `b2`）。
- 想换 id 只能 `remove` 再 `add`（会拿到新的 max+1）。

### 15.6 操作顺序与「全有或全无」

1. 读 sidecar（不存在 = 首次写入；损坏 = 立即失败，什么都不写）。
2. 首次写入时导入文件自带目录。然后按 **remove → update → add** 应用本次操作。
3. 所有问题一次性收集：重复 id、未知 id、`update` 与 `remove` 同一个 id、字段非法、越界页 /
   越界时间……全部列出来，文案形如：

```text
media_bookmark refused the request, so nothing was written:
  - remove[0]: unknown id "b9" (known: b1, b2, b3)
  - add[1]: page 99 is outside 1..28
Fix the listed problems and call again. Nothing was written: no sidecar, no embed target.
```

任何一条错误都意味着**没有 sidecar、没有嵌入、没有临时文件残留**。

### 15.7 嵌入目标

写入前先算好嵌入目标；每次写入都嵌入（没有 `embed` 开关）：

| 媒体 | 嵌入目标 | 行为 |
|---|---|---|
| PDF | 源 PDF 本身（**原地**） | 用 `mutool run pdf-outline-writer.js` 重写 outline；不出副本 |
| 视频 / 录音 | `<dir>/<basename>.mmgrep.bookmark.vtt` | WEBVTT；cue id = b1…；cue 文本 = title；缺省 `end` = 下一条 `start`，最后一条 = 媒体时长。**源媒体字节不变** |
| 图片 | 无（`(none — sidecar only)`） | 只写 sidecar |

写工具是 0.3.0 对「不写用户文件」的明确例外：sidecar / VTT 只落在源文件旁边、只写 `*.mmgrep.*`，
PDF 本身则被原地改写（不出副本）。

### 15.8 检查与原子性

顺序固定：**校验与合并 → 嵌入并跑完全部检查 → 原子写 sidecar → 回读 sidecar**。

- 临时文件与目标同目录（`.<basename>.mmgrep-tmp-<pid>-<rand>.pdf` + 计划 JSON），成功后
  `rename` 覆盖目标；失败删除临时文件，原文件字节不变。
- PDF outline 的检查项（顺序固定，任一失败即中止）：

| check | 内容 |
|---|---|
| `writer-exit` | mutool 退出码 0，临时 PDF 非空 |
| `qpdf-check` | `qpdf --check` 退出 0（或 3 = 只有警告）；没装 qpdf 时用 mutool 重新打开代替 |
| `page-text` | 页数、首页 / 中间页 / 末页文本与原文件一致 |
| `outline-readback` | 回读 outline 与 sidecar 逐项一致（标题、层级、物理页） |

- VTT 的检查项：`vtt-readback`（用自家解析器回读比对）、`media-unchanged`（源媒体哈希不变）；
  最后一条没有 `end` 且拿不到媒体时长时另加 `vtt-duration`。
- 嵌入失败 / 某项 check 失败 → `INTERNAL`，文案 `embedding failed for "<target>", so the sidecar
  was not written:` + 失败项；sidecar 不写。
- sidecar 用「临时文件 → rename」原子写；写完回读，条目 JSON 不一致 → `INTERNAL`
  （`read back a different sidecar than it wrote`）。
- sidecar 写失败时错误里注明「嵌入已经完成」——文件本体可能已经被改动，需要用户决定是否重试。
- 加密 / 签名 PDF → `UNSUPPORTED_MEDIA_TYPE`（提示先解密 / 去签名，不尝试写）；缺 `mutool` →
  `TOOL_NOT_FOUND` + 安装提示。
- 不做回滚 / 历史 / 外部改动检测；用户在 Acrobat 等处改的 outline 会在下一次写入时被 sidecar 覆盖。

### 15.9 返回结构

文本形如：

```text
Bookmarks written for "/abs/a.pdf" (pdf): 3 entries; imported 2 from the file's own outline.
applied: added b3
sidecar: /abs/a.pdf.mmgrep.bookmark.json
embed target: /abs/a.pdf (in place)
checks: writer-exit: ok (mupdf 1.x); qpdf-check: ok; page-text: ok (6 pages identical); outline-readback: ok (3 entries); sidecar-readback: ok (3 entries)

OUTLINE (3 entries, physical pages):
b1  p.1  Introduction
  b2  p.3  Methods
b3  p.9  Results
```

`structuredContent`：

| 字段 | 类型 | 含义 |
|---|---|---|
| `path` | string | resolved 绝对路径 |
| `media` | `"pdf"` \| `"video"` \| `"audio"` \| `"image"` | 书签媒体类型 |
| `sidecarPath` | string | sidecar 绝对路径 |
| `created` | boolean | 本次是否首次创建 sidecar |
| `imported` | integer | 首次写入时从文件自带目录导入的条目数 |
| `applied.remove` / `applied.update` / `applied.add` | integer | 三种操作实际生效的条数 |
| `embed.target` | string | 嵌入目标；没有嵌入器时是 `(none — sidecar only)` |
| `embed.checks[]` | array | 每项 `{name, ok, detail}` |
| `checks[]` | array | 汇总检查项（含 `sidecar-readback`） |
| `outline.source` | `"sidecar"` | 结果里的目录永远来自 sidecar |
| `outline.available` | boolean | 恒为 true（删光所有条目时 `total = 0`，sidecar 仍为空数组、仍是唯一真相源，见 §15.10） |
| `outline.total` / `outline.entries` | integer / array | 完整目录，条目已带 id |

工具的 annotation 是 `{readOnlyHint: false, destructiveHint: true, idempotentHint: false,
openWorldHint: false}`。

### 15.10 读侧行为（probe / overview / locate）

`media_probe`、`media_overview`（`view: "outline"` / `"auto"`）与 `media_locate` 展示**同一份**目录，
来源按优先级取第一个可用的，不合并、不去重：

1. **bookmark sidecar**（存在且可读时永远优先）；
2. 文件自带目录：PDF 书签 / 视频、录音的容器章节；
3. 文档 heading 生成（**仅 media_overview**，请求范围里 ≥5 个 heading 时）。

行格式处处一致：PDF `b1  p.1  Introduction`（层级用行首两空格缩进，最多 6 层），视频 / 录音
`b1  00:12:34  Opening`；没有作者 / agent 之分。首行给出 source 与条数，例如：

```text
outline: sidecar — 3 entries — use the outline to pick a range
outline: PDF outline — 68 entries — full outline in structuredContent.outline and manifest.json
outline: container chapters — 4 chapters — use the outline to pick a range
outline: generated from headings — 6 entries (best-effort: built from block structure; full outline in structuredContent.outline and manifest.json)
```

- 有 sidecar 时，目录块**最后一行**是 `full detail: <sidecar path>`（probe 的 `How to read:` 与
  overview 的 `note:` 在目录块之后）。
- 没有 sidecar 时，读侧用共享 derive 助手按文件自带目录顺序推导 b1…bN，**与 media_bookmark 首次
  导入完全一致**；probe 文本最多展示 2 层 / 60 条，其余 `+N more`，完整目录在
  `structuredContent.outline`（overview 还写进 `manifest.json`）。
- sidecar 损坏 → 回退到文件自带目录（或 overview 的 heading 生成），文本里给一行
  `note: the bookmark sidecar "<path>" could not be read (...) — showing <来源> instead.`，
  **不抛错**；`structuredContent.outline.sidecarError` 同样给出短原因。
- sidecar 合法但条目为空 → 以 sidecar 为准（`source: "sidecar"`、`available: false`、不显示文件自带
  目录）：用户删光了书签，不能把旧 outline 又拿出来。
- 只读工具**从不**创建、修改或删除 sidecar / VTT，也不会留下临时文件。
- 图片：probe 只在有 sidecar 时展示目录；overview / locate 同理。

### 15.11 错误码

| 码 | 场景 |
|---|---|
| `INVALID_ARGUMENT` | `path` / 参数 / 条目校验失败；sidecar 损坏；三种操作全空；`update` 想改 id；未知 id；页 / 时间越界 |
| `UNSUPPORTED_MEDIA_TYPE` | 该书签媒体类型不支持（如 Office）；PDF 加密 / 带签名 |
| `TOOL_NOT_FOUND` | 没有 `mutool`（写 PDF 用；文案带安装提示）；`qpdf` 缺失时可回退，不单独报错 |
| `INTERNAL` | 嵌入失败 / 某项 check 失败 / sidecar 写失败 / sidecar 回读不一致 |
| `PATH_NOT_FOUND` / `PATH_NOT_FILE` / `PATH_NOT_READABLE` | 见 §2.4 |

---

## 16. `media_annotate` — 增删改媒体批注（0.3.0）

> 0.3.0 新增的写工具。批注的唯一真相源是源文件旁的 `<file>.mmgrep.annotation.json`。每次写入同时
> 嵌入：PDF 原地写真正的批注对象（**不重写页面正文**），视频 / 录音只写
> `<file>.mmgrep.annotation.vtt`，图片只有 sidecar。批注与书签互不引用（两套 sidecar、两套 id）。

### 16.1 工具描述（英文，含中文触发词）

```text
Write annotations (notes, comments, sticky notes, marked areas) into a local media file so they
survive across sessions and are visible to humans in the file itself: real PDF annotation objects for a
PDF, a sidecar VTT for video/audio, and a sidecar JSON for every supported media type.
(写入批注 / 注释 / 评论 / 标注：PDF 原地写真正的批注对象；视频、音频写同名
.mmgrep.annotation.vtt；所有类型都写 <file>.mmgrep.annotation.json 侧车。
中文触发词：批注、注释、评论、标注、annotate、comment、note。)

The sidecar "<file>.mmgrep.annotation.json" is the single source of truth. The first write (no sidecar
yet) imports every note-like annotation of a PDF — Text, FreeText, Square, Circle, Line, Polygon,
PolyLine, Highlight, Underline, Squiggly, StrikeOut, Stamp, Caret and Ink, in page order — as n1…nN,
including its raw geometry and original author, then applies this call. Link annotations, form widgets
and popups are never imported or touched. Entries are anchored per media type:
- PDF: page (1-based PHYSICAL page) + type ("text" = sticky note, "square" = rectangle area; "square"
  also needs rect {x,y,width,height} as fractions 0..1 of the page). Other annotation types cannot be
  created in this version, but imported ones are kept verbatim (including raw geometry) and can be
  updated (note) or removed.
- video/audio: start (seconds, < duration) and optional end (default start + 5 s, clipped to the end of
  the media). No page, no rect, no type.
- image: rect only (fractions of the image); no page, start/end or type.
- every entry: note (plain text, 1..4000 characters, newlines allowed) and, for PDF, type.

Ids are n1, n2, …; new ids are max+1 and are never reused by this call; update keeps the id.
One call can mix add / remove / update; they are applied remove → update → add, all-or-nothing: if
anything is invalid, nothing is written and every problem is listed at once (unknown id, bad field,
page/time out of range, duplicate ids, malformed entry, …).

The author is resolved once per call: the "author" argument, else the MCP client's name, else
"MultiMediaGrep". The model name is never used. Imported annotations keep their original
author; update never changes it.

WARNING — this tool modifies files:
- A PDF is modified IN PLACE: annotation objects are written into the PDF file itself, no copy is made
  (the page content is not rewritten). Video and audio files are never modified — only the VTT is written.
- Files are written NEXT TO the source: a *.mmgrep.* sidecar for every media type, plus
  *.mmgrep.annotation.vtt for video/audio. They are not written into the cache directory.
- When a sidecar already exists, external edits to the file's own annotations are OVERWRITTEN on the next
  write. To change an annotation, use update; the sidecar wins over the file.
- Protect your originals with git (or a backup) before calling this tool.

The result lists every written annotation in the same shape the read side uses ("n1 (p.12): note",
"n1 (00:12:34–00:12:39): note"), plus the sidecar path, the embed target, and every check result.
(批注 / 注释 / 评论 / 标注 / annotate / comment / note)
```

### 16.2 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|:---:|---|---|
| `path` | string | ✅ | — | 本地绝对路径（PDF / 图片 / 视频 / 录音） |
| `add` | array | ❌ | `[]` | 新增批注；不许带 `id`；`author` 由 server 解析 |
| `remove` | string[] | ❌ | `[]` | 要删除的 id（`n1`、`n12` …） |
| `update` | array | ❌ | `[]` | `{id, ...至少一个可改字段}`；不能改 id、不能改 author |
| `author` | string | ❌ | — | 覆盖本次调用的作者名；≤200 字符 |

不传 `author` 时按：MCP `initialize` 的 `clientInfo.name`（如 `claude-code`）→ 都没有时
`"MultiMediaGrep"`。**不使用模型名、不读环境变量**。导入的批注保留原作者；`update` 不改 author。

### 16.3 条目结构（按媒体）

**PDF**（`media: "pdf"`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|:---:|---|
| `type` | `"text"` \| `"square"` | ✅ | 新建只支持这两种；其他类型（highlight / ink / …）只能从现有 PDF 导入 |
| `note` | string | ✅ | 纯文本，1–4000 字符；可多行 |
| `page` | integer | ✅ | 1-based **物理**页码；知道 `pageCount` 时校验上界 |
| `rect` | object | ❌ | `{x, y, width, height}`，0..1 比例、左上原点（与 `media_zoom` 的 `crop` 同一空间）；`square` **必填**；`text` 可省略（省略时放页面左上角留白并逐条错开）；四边都必须在 `[0,1]` 内且 `x+width ≤ 1`、`y+height ≤ 1` |

**视频 / 录音**（`media: "video"` \| `"audio"`）：`note`（必填）、`start`（秒，必填，≥0，< 时长）、
`end`（可选，默认 `start + 5` 秒并截到媒体时长，必须 `> start`）。没有页面、rect 或 type。

**图片**（`media: "image"`）：`note` + 可选 `rect`；只有 sidecar（图片没有原生批注面）。

### 16.4 sidecar

- 路径：`/abs/a.pdf` → `/abs/a.pdf.mmgrep.annotation.json`。
- 结构（`version` 固定 1）：

```json
{
  "version": 1,
  "media": "pdf",
  "entries": [
    { "id": "n1", "type": "text", "note": "check this number", "author": "claude-code",
      "page": 3, "rect": { "x": 0.1, "y": 0.2, "width": 0.2, "height": 0.05 } }
  ]
}
```

- 位置排序：PDF 按 `page` → `rect.y` → `rect.x`（没有 rect 的排后）→ id；视频 / 录音按 `start` → id；
  图片保持写入顺序。
- sidecar 一旦存在就是唯一真相源；损坏 → `INVALID_ARGUMENT`，绝不覆盖；存储条目只做结构校验
  （旧条目不能因为文件页数 / 时长变化而卡死写入）。
- 并发同 bookmark：后写者胜出。

### 16.5 id 规则与首次导入

- id 前缀固定 `n`：`n1`、`n2`、…；`isEntryId` 只认 `^n[1-9]\d*$`。
- **首次写入**导入 PDF 里的全部**注释类批注**：Text、FreeText、Square、Circle、Line、Polygon、
  PolyLine、Highlight、Underline、Squiggly、StrikeOut、Stamp、Caret、Ink。按 page → rect.y →
  rect.x 排序后连续编号 `n1…nN`；`note` 缺省 `(no note)`，`author` 缺省 `unknown`；`rect` 从批注
  几何换算成 0..1；每条保留原始几何（`raw`）供写入时匹配。
- **Link、表单 Widget、Popup 从不导入、从不修改**；FileAttachment / Movie / Screen / Sound /
  PrinterMark / TrapNet / Watermark / Redact 也不导入、不修改。
- 视频 / 录音 / 图片没有可导入的原生批注（导入数恒为 0）。
- 新增 id = 操作前 max + 1，同一调用内递增，不复用；`update` 不改 id；`remove` 不重排。
- 每次写入**整体替换** PDF 的注释类批注为 sidecar 内容；未改动条目按 raw 匹配保留原对象与外观流，
  只重建改动过的条目。v1 不能新建的类型（highlight / ink / …）导入后可以改 note、可以删，几何原样
  保存以便往返。

### 16.6 操作顺序与「全有或全无」

同 bookmark：读 sidecar → 首次写入导入 → **remove → update → add** → 一次性列出所有问题 →
任何错误都不写 sidecar、不嵌入、不留临时文件。`update` 与 `remove` 不能指向同一个 id；`update`
不能改 author；`rect` / `square` / `end > start` 等跨字段规则在合并后统一校验。

### 16.7 嵌入目标

| 媒体 | 嵌入目标 | 行为 |
|---|---|---|
| PDF | 源 PDF 本身（**原地**） | `mutool run pdf-annotation-writer.js preflight\|read\|write`；写真正的 Text / Square 批注对象；页面正文不重写 |
| 视频 / 录音 | `<dir>/<basename>.mmgrep.annotation.vtt` | WEBVTT；cue id = n1…；cue 正文 = note（多行保留，空行换成只含一个空格的行）；缺省 end = start + 5s（截到时长）；源媒体字节不变 |
| 图片 | 无（`(none — sidecar only)`） | 只写 sidecar |

新建 Text 是标准 PDF 便签（带 `/Popup`），图标 20×20pt；Square 的 `/Rect` 每边放宽 1pt；没有 rect 的
Text 放在页面左上角留白（边距 12pt、逐条下移 26pt）。

### 16.8 检查与原子性

顺序同 bookmark：校验与合并 → 嵌入 + 全部检查 → 原子写 sidecar → 回读。

| check | 内容 |
|---|---|
| `writer-exit` | mutool 退出码 0，临时 PDF 非空；detail 带 created / updated / kept / deleted 计数 |
| `qpdf-check` | 同 bookmark（0 或 3 通过；无 qpdf 用 mutool 重开） |
| `page-text` | 页数、首页 / 中间页 / 末页文本与原文件一致 |
| `annotation-readback` | 回读批注与 sidecar 逐条一致（Text 只比左上角；Square 留 2pt 容差） |
| `other-annotations` | Link / 表单 Widget / Popup 写入前后完全一致 |
| `vtt-readback` | VTT 版本才用：回读 cue 与 sidecar 比对 |
| `media-unchanged` | VTT 版本才用：源媒体哈希不变 |
| `vtt-end-default` | VTT 版本才用：缺省 end 已按规则补上 |

失败语义同 bookmark：嵌入失败 → `INTERNAL` 且 sidecar 不写；sidecar 写失败注明嵌入已完成；
sidecar 回读不一致 → `INTERNAL`。加密 / 签名 PDF 拒绝；缺 mutool → `TOOL_NOT_FOUND` + 安装提示。

### 16.9 返回结构

```text
Annotations written for "/abs/a.pdf" (pdf): 2 entries; imported 1 from the file's own annotations.
author: claude-code
applied: added n2
sidecar: /abs/a.pdf.mmgrep.annotation.json
embed target: /abs/a.pdf (in place)
checks: writer-exit: ok (mupdf 1.x, created 1, updated 0, kept 1, deleted 0); qpdf-check: ok; page-text: ok (6 pages identical); annotation-readback: ok (2 entries); other-annotations: ok (links/widgets/popups unchanged); sidecar-readback: ok (2 entries)

ANNOTATIONS (2 entries, physical pages):
n1 (p.3): check this number
n2 (p.12): 这里的公式与正文不一致
```

`structuredContent`：`path` / `media` / `sidecarPath` / `created` / `imported` / `applied` /
`author` / `embed` / `checks` / `annotations`（`{source: "sidecar", available: true, total, entries}`）。
annotation 同 bookmark：`destructiveHint: true`。

### 16.10 读侧行为（probe / overview / locate）

来源优先级：**annotation sidecar → 文件自带 PDF 批注**；不合并。sidecar 损坏时回退并给短原因；
sidecar 合法但为空时以 sidecar 为准（不回退）。

- `media_probe`：只给条数与 sidecar 路径，不展开 note：

```text
annotations: 2 (sidecar)
annotation sidecar: /abs/a.pdf.mmgrep.annotation.json
```

没有批注时 `annotations: 0 (none)`（文件自带批注时是 `annotations: 3 (the file's own annotations)`）。

- `media_overview`：在请求范围旁输出批注块，行格式与 `media_annotate` 结果一致：

```text
annotations (2 of 2 in pages 1-12, sidecar):
n1 (p.3): check this number
n2 (p.12): 这里的公式与正文不一致
full detail: /abs/a.pdf.mmgrep.annotation.json
```

最多 20 条 / 2000 字符，其余 `+N more annotations (all annotations in structuredContent.annotations)`；
`structuredContent.annotations` 带完整条目、source、`totalInRange` 与 sidecar 路径。视频 / 录音用
`n1 (00:12:34–00:12:39): note`，图片用 `n1: note`。

- `media_locate`：除了媒体文字，也在批注 `note` 里搜关键词；命中单独成段，永远不计入媒体命中数，
  并明确标注这是**批注**、不是媒体内容：

```text
annotation matches for "deimmunization" (1):
  n2 (p.12): check this number
note: the lines above are ANNOTATIONS — notes written next to the media (sidecar or the file itself),
not media content. They are not part of the transcript or the page text.
```

`structuredContent.annotationMatches[]` 每项 `{kind: "annotation", id, media, page, startMs, endMs,
startSec, endSec, text, author, hits, fuzzy, source: "annotation", origin, line}`。

- 只读工具**从不**创建 / 修改 / 删除 annotation sidecar 或 VTT。

### 16.11 错误码

同 §15.11；另外：

| 码 | 场景 |
|---|---|
| `INVALID_ARGUMENT` | `type` 不是 `text` / `square`（新建）；`square` 缺 `rect`；`rect` 越界；`note` 为空 / 超 4000 字；`author` 超 200 字；`end ≤ start` |
| `UNSUPPORTED_MEDIA_TYPE` | 批注不支持该媒体（Office）；PDF 加密 / 带签名 |
| `TOOL_NOT_FOUND` | 没有 `mutool`（写 PDF 批注；读 PDF 批注时缺它只降级为「读不到」，不报错） |

---
