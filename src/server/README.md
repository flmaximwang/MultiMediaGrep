# src/server —— MultiMediaGrep MCP server 框架

本目录是 **MCP 协议层**：把 `src/media`（路径/范围校验、媒体判定、分派）、`src/cache`（落盘目录）、
`src/export`（content.md / segments.jsonl / manifest.json / document.json）、`src/providers`（ASR / 文档解析）
接成一个 stdio MCP server。**视频 / 音频 / 文档的具体解析逻辑不在这里**，由 `src/backend/<type>/` 提供。

设计约束（契约 §2、§10、§12）：

- **stdout 只承载 MCP 协议**；所有日志走 stderr（`createLogger` 固定写 `process.stderr`）。
- 不调 LLM、不联网取数。外部服务只有用户自己配置的 ASR 与文档解析 provider。
- 不新增 npm 依赖：`@modelcontextprotocol/sdk` 1.32.2 + `zod` 3.25.76。
- 注释中文，面向 agent 的字符串（工具描述、server instructions、错误文案）英文。

## 模块结构

| 文件 | 职责 |
|---|---|
| `../index.js` | 入口：建 runtime → 建 server → 接 `StdioServerTransport`；启动横幅写 stderr；SIGINT/SIGTERM 优雅退出 |
| `index.js` | `createServer()` / `createRuntime()`；加载 cache、provider、后端；组装 dispatcher |
| `http.js` | Streamable HTTP 传输（`POST /mcp`，无状态）：每个请求新建 server + transport，用完即关；Bearer 鉴权、请求体上限与超时 |
| `tools.js` | 4 个工具的 zod schema、参数×媒体校验、handler、进度上报、全文落盘、文本清单 |
| `backends.js` | 三个后端的集中动态导入；缺失/损坏 → 占位后端（调用时报 `INTERNAL`） |
| `images.js` | 图片 → MCP image content；契约 §10 的 token 计价、硬上限、软预算降级 |
| `errors.js` | `ToolError` / 任意异常 → 契约 §2.4 的 MCP 错误结果（`isError: true`） |
| `config.js` | 契约 §12 的全部 `MMGREP_*` 环境变量、默认值、日志器；`describeConfig()` 对 key 脱敏 |
| `server-instructions.js` | 契约 §11.2 的 server instructions 原文（启动时通过 MCP `initialize` 下发） |

## 本地运行

```bash
# 直接起（stdio server 阻塞等待 JSON-RPC；日志在 stderr）
node src/index.js

# 跑 server 测试（Node 22 把位置参数当 glob，不能传目录）
node --test "test/server/**/*.test.js"
```

接到宿主（Claude Desktop / 任意 MCP client）的配置示例：

```json
{
  "mcpServers": {
    "multimediagrep": {
      "command": "node",
      "args": ["/absolute/path/to/MultiMediaGrep/src/index.js"],
      "env": {
        "MMGREP_ASR_PROVIDER": "elevenlabs",
        "MMGREP_ELEVENLABS_API_KEY": "…",
        "MMGREP_DOC_PROVIDER": "mineru",
        "MMGREP_MINERU_API_KEY": "…"
      }
    }
  }
}
```

## 4 个工具

描述文本直接取自契约 §4–§7（英文 + 中文触发词），不要改写。`path` 恒为必填；`media_locate` 另需 `query`。

| 工具 | 参数（类型 / 适用媒体） |
|---|---|
| `media_probe` | `path`；`subtitle`（video/audio：文件绝对路径 / 字幕轨 index / 语言码）；`transcript`（video/audio，`auto`/`subtitle`/`off`） |
| `media_overview` | `path`；`start` / `end`（秒，video/audio）；`segment`（30–3600，video/audio）；`pages`（`"3-10,15"`，document）；`cells`（1–16，video/document）；`images`（0–4，video/document；audio 仅 `0` = 零像素纯文本模式）；`maxEdge`（256–1600，video/document）；`envelope`（audio）；`subtitle` / `transcript`（video/audio） |
| `media_zoom` | `path`；`at`（video）；`start` + `end`（video）；`page`（document）；`crop`（video/document）；`maxEdge` |
| `media_locate` | `path` + `query`；`max`（1–20）；`start` / `end` / `segment` / `pages`；`subtitle` / `transcript`；`includeFrame`（video/document） |

参数 schema 通过 `.describe()` 标注适用媒体类型；**传了不适用于该媒体类型的参数会返回契约 §2.2 的
`INVALID_ARGUMENT` 原文案**（`tools.js` 的 `PARAM_APPLICABILITY` / `checkApplicability`），不会静默忽略。
工具 schema 用 `z.object(shape).strict()`：未声明的参数直接被 SDK 拒绝。

### zod 必填字段的行为（已知决策）

`path`（和 `media_locate` 的 `query`）写在 schema 的 `required` 里，缺字段时由 MCP SDK 返回
input validation error（`isError: true`，没有 `structuredContent.error`）。这是有意为之：schema 必须
如实告诉 agent 哪些字段必填。**语义层**的错误（URL、相对路径、不存在、不是普通文件、空字符串 query）
仍然走 handler，返回契约 §2.4 的精确文案。测试覆盖了后者。

## 错误映射（契约 §2.4）

所有 handler 都被 `guardToolHandler()` 包住，异常一律**转换成结果**而不是 throw：

```
content: [{ type: "text", text: "<CODE>: <message>" }]
structuredContent: { error: { code, message, hint? , stack? } }
isError: true
```

| 情形 | 结果 |
|---|---|
| `ToolError` / 任何 `code` 属于 `ERROR_CODES` 的 `Error` | 原样透传 `code` / `message` / `hint` |
| 客户端取消（`AbortError`） | `INTERNAL`，message 说明 request was cancelled |
| 未知异常 | `INTERNAL`，`message: "unexpected server error: …"`，附 `stack` 摘要（前 6 行 / 1600 字符） |
| 非 `Error` 值 | `INTERNAL` |
| 消息中出现 `sk-…` / `Bearer …` | 落盘/返回前脱敏为 `sk-***` / `Bearer ***` |

框架自身产生的错误码：

| 码 | 触发点 |
|---|---|
| `INVALID_ARGUMENT` | 相对路径/空 path（`validatePath` 第 1–2 步）、参数不适用、`page`/`max`/`crop`/`segment` 形状、`at` vs `start/end` 互斥、`query` 为空、`pages` 语法 |
| `PATH_NOT_FOUND` | `validatePath` 第 3 步（媒体本体路径） |
| `NOT_A_FILE` | `validatePath` 第 4 步 |
| `NOT_A_LOCAL_PATH` | `validatePath`：URL / `file://` / 远程路径 |
| `UNSUPPORTED_MEDIA_TYPE` | 扩展名 + 魔数都识别不出（`detect.js` 抛错） |
| `OUT_OF_RANGE` | `start` / `at` 超出时长；`page` / `pages` 超出页数（`validateTimeRange` / `parsePages`） |
| `BUDGET_EXCEEDED` | 契约 §10.2 的六个硬上限（图片数、格数、maxEdge、像素） |
| `INTERNAL` | 占位后端、后端缺方法、后端抛未知异常、后端出图数不符合约定 |
| `NO_TRANSCRIPT` / `PROVIDER_NOT_CONFIGURED` / `PROVIDER_FAILED` / `TRANSCRIPT_UNREADABLE` | **后端 / provider 层**产生，框架原样透传 |
| `TOOL_NOT_FOUND` | 保留码；MCP SDK 自己处理未知工具 |

`src/media/interface.js` 的 `validatePath` / `parsePages` / `validateTimeRange` / `validateCrop` 全部复用，
server 层不重复实现。

## 进度通知（契约 §2.6）

长任务保持**阻塞调用**，同时（best-effort）发 `notifications/progress`：

- `createProgressReporter()` 读取 `extra._meta.progressToken`；宿主没给 token、`MMGREP_PROGRESS_NOTIFICATIONS=off`
  或 transport 不支持时静默跳过。
- 消息形如 `media_overview 2/5 · transcribing auto`，`total` 默认 5，`progress` 自增。
- `media_overview` 的三个阶段：`scanning <窗口>` → `transcribing <来源>` → `rendering N image(s)`。
- 通知失败只写 debug 日志，绝不影响工具结果。

## 图片预算（契约 §10）

`images.js` 在**出图前**校验硬上限、**出图后**核对实际产物：

- ≤4 张/调用、≤16 格/图、≤64 格/调用、长边 256–1600 px、单图 ≤2,000,000 px。
- 硬上限违反 → `BUDGET_EXCEEDED`，**不静默截断**。
- 软预算（`MMGREP_MAX_IMAGE_TOKENS`，默认 4000）：
  - agent 显式给了 `cells`/`images`/`maxEdge` → **不改形**，只给警告与降级建议；
  - 自动模式 → 先减图片数、再降 `maxEdge`，并说明改了什么；
  - 可读性不足（每格太小）→ 警告并给出建议 `maxEdge`。
- 图片以标准 MCP image content 返回；`structuredContent.images` 只放描述（尺寸、格数、token 估算）。

## 后端接口契约（给 `src/backend/**` 的实现者）

每个媒体类型一个模块，**集中接线点在 `src/server/backends.js`**：

```
src/backend/<type>/index.js
  export function create<Type>Backend(ctx) -> { probe, overview, zoom, locate, subtitles }
```

`<type>` ∈ `video` / `audio` / `document`，工厂名分别是 `createVideoBackend` / `createAudioBackend` /
`createDocumentBackend`。模块是**动态导入**的：文件一落地自动生效，不需要改 server 代码。
不适用某方法时可以不实现（见方法矩阵）；实现了但返回非对象/抛错会降级为占位后端。

### 工厂 ctx（每个进程一份）

```js
{
  cache,        // src/cache 的实例，或 null
  asrProvider,  // ASR provider 实例，或 null（未配置）
  docProvider,  // 文档解析 provider 实例，或 null
  logger,       // { error, warn, info, debug }；只写 stderr
  onProgress,   // 工厂级进度上报（通常不用；每次调用还会收到新的）
  signal,       // AbortSignal | null（进程级）
  config,       // loadConfig() 的完整配置（见 config.js）
}
```

### 每次调用的 `(input, ctx)`

`input` 统一含 `{ path, mediaType, sizeBytes, modifiedMs, detectedBy }`，再加方法相关字段。
`ctx` 每次调用新建：

```js
{ cache, asrProvider, docProvider, logger, onProgress, signal, config }
```

`await ctx.onProgress({ stage: 'asr', used: '0:12 / 10:00' })` 会转成进度通知；`signal` 用于取消。

### 方法矩阵

| 方法 | video | audio | document |
|---|:---:|:---:|:---:|
| `probe` | ✓ | ✓ | ✓ |
| `overview` | ✓ | ✓ | ✓ |
| `zoom` | ✓ | — | ✓ |
| `locate` | ✓ | ✓ | ✓ |
| `subtitles` | ✓ | ✓ | — |

### 方法签名与返回形状

```js
probe(input, ctx) -> ProbeResult
```
`ProbeResult`（契约 §4.3；框架会补默认值，后端给了的优先）：
`mediaType, durationMs, durationSec, width, height, fps, rotation, aspect, videoCodec, container,
hasAudio, audioCodec, audioChannels, sampleRateHz, audioHealth, pageCount, hasTextLayer,
subtitleTracks[], audioTracks[], capabilities{ asr{available,provider,reason}, ocr{...},
transcriptSource, transcriptOrigin, transcriptPath }, recommended{...}`。
**probe 只报告、不报错**（契约 §4.5）：读不到就说 `null`/空数组。

```js
overview(input, ctx) -> { segments, images, transcript, warnings }
```
- `input`: `{ path, mediaType, sizeBytes, modifiedMs, detectedBy, subtitle, transcript,
  startMs, endMs, startSec, endSec, clipped, pages, pageCount, durationSec, envelope,
  cells?, images?, maxEdge? }`
- `segments[]`: `{ startMs, endMs, page?, text, source?, origin?, confidence?, bbox?, assetRef? }`
- `images[]`: `{ buffer: Buffer, mimeType?, width, height, cells?, index? }`（PNG/JPEG）
- `transcript`: `{ source, origin, language, provider, model, file? }`（`none` 也要给对象）
- `warnings[]`: string（原样并入返回）

```js
zoom(input, ctx) -> { images, target?, warnings }
```
- `input`: `{ path, mediaType, sizeBytes, modifiedMs, detectedBy, crop, maxEdge,
  atMs?, atSec?, selection?, startMs?, endMs?, startSec?, endSec?, clipped?, page? }`
- `images`: **恰好一张**；多了/少了 → 框架报 `INTERNAL`
- `target` 可选：`{ kind:'frame'|'page', atMs?, atSec?, fromMs?, toMs?, selection?, page?, crop? }`，
  框架会与请求参数合并

```js
locate(input, ctx) -> { matches, totalSegments?, transcript?, frame?, warnings }
```
- `input`: `{ path, mediaType, sizeBytes, modifiedMs, detectedBy, query, max,
  subtitle, transcript, startMs, endMs, startSec, endSec, clipped, pages, pageCount,
  durationSec, includeFrame }`
- `matches[]`: `{ startMs?, endMs?, page?, text, score?, source?, origin? }`；框架补 `rank` / `startSec` / `endSec`
- `frame`（`includeFrame` 时）：`{ buffer, atMs?, width, height, cells? }`

```js
subtitles(input, ctx) -> { segments, origin?, sourcePath?, format?, language?, warnings }
```
- `input`: `{ path, mediaType, sizeBytes, modifiedMs, detectedBy, subtitle,
  startMs, endMs, startSec, endSec, clipped }`
- `segments[]`: `{ startMs, endMs, text, source?, origin?, confidence? }`
- `sourcePath` 是字幕文件路径（内嵌轨给 `null`）；`format` 如 `srt` / `vtt` / `ass`

后端应抛 `ToolError`（来自 `src/media/interface.js`）表达契约错误码；框架对未知异常兜底成 `INTERNAL`。

### 占位后端

`backends.js` 的 `createPlaceholderBackend(mediaType, reason)`：模块缺失、工厂缺失、工厂抛错或返回非对象时，
每个适用方法都抛

```
INTERNAL: <type> backend is not implemented yet.
```

`hint` 指向应实现的文件与 `src/server/README.md`。`loadBackends()` 通过非枚举的 `describeStatus()`
向启动日志报告 `video=ready|placeholder`，不会阻塞 server 启动。

## 全文落盘（契约 §9）

`media_overview` 成功后写 4 个文件（`document.json` 为可选件）：

| 文件 | 内容 |
|---|---|
| `content.md` | 人读 Markdown，按时间区间 / 页码分节 |
| `segments.jsonl` | 一行一个 segment（JSON） |
| `manifest.json` | 工具、窗口、页、转写来源、图片描述、警告、计数 |
| `document.json` | cangjie `SourceDocument Contract v1`；工具层 `document` 映射到 cangjie 枚举（`pdf`/`docx`/…，图片类文档按契约偏差映射为 `pdf`，真实类型只记在 `manifest.source.mediaType`） |

输出目录：`cache.prepareDir("sha256:<file-hash>")`；没有 cache 模块时退到
`os.tmpdir()/multimediagrep/<sha256>`。工具只返回绝对路径，不内联全文。

## 环境变量（契约 §12）

全部在 `config.js` 的 `loadConfig(env)` 里解析，非法值回落默认并记入 `config.warnings`（不崩 server）：

`MMGREP_CACHE_DIR` · `MMGREP_CACHE_MAX_BYTES` · `MMGREP_ASR_PROVIDER` ·
`MMGREP_ELEVENLABS_API_KEY` · `MMGREP_ELEVENLABS_BASE_URL` · `MMGREP_ELEVENLABS_MODEL` ·
`MMGREP_OPENAI_COMPATIBLE_API_KEY` · `MMGREP_OPENAI_COMPATIBLE_BASE_URL` ·
`MMGREP_OPENAI_COMPATIBLE_MODEL` · `MMGREP_ASR_LANGUAGE` · `MMGREP_ASR_TIMEOUT_MS` ·
`MMGREP_DOC_PROVIDER` · `MMGREP_MINERU_API_KEY` · `MMGREP_MINERU_BASE_URL` ·
`MMGREP_MINERU_MODEL` · `MMGREP_DOC_TIMEOUT_MS` · `MMGREP_OCR_PROVIDER` ·
`MMGREP_MAX_IMAGE_TOKENS` · `MMGREP_MAX_IMAGE_EDGE` ·
`MMGREP_MAX_TEXT_INLINE_CHARS` · `MMGREP_MAX_CONCURRENCY` · `MMGREP_AUDIO_MIN_DBFS` ·
`MMGREP_AUDIO_MIN_SPEECH_RATIO` · `MMGREP_FFMPEG_PATH` · `MMGREP_FFPROBE_PATH` · `MMGREP_LOG_LEVEL` ·
`MMGREP_PROGRESS_NOTIFICATIONS`（本 server 的扩展，默认 `on`）。

传输方式（`http.js`）：`MMGREP_TRANSPORT`（`stdio` 默认 / `http`）· `MMGREP_HTTP_HOST`（默认 `127.0.0.1`）·
`MMGREP_HTTP_PORT`（默认 `3927`）· `MMGREP_HTTP_TOKEN`（可选 Bearer 令牌；只说 `set` / `unset`，绝不打值）。
命令行 `--http` / `--host` / `--port` / `--token` 的优先级高于环境变量。

API key 只留在 runtime 里：`describeConfig()` 输出 `set` / `unset`，日志与错误结果不会出现原值。

## 测试

```
test/server/config.test.js    # §12 默认值 / 自定义 / 非法值 / 脱敏 / 日志器
test/server/errors.test.js    # §2.4 错误映射
test/server/images.test.js    # §10 计价 / 硬上限 / 软预算 / 降级
test/server/tools.test.js     # stub 后端：schema、适用性、4 个工具、进度、落盘
test/server/server.test.js    # spawn node src/index.js，StdioClientTransport 端到端
test/server/http.test.js      # Streamable HTTP：协议面、鉴权、路由、配置、超时中止
```

`test/server/server.test.js` 同时是「stdout 干净」的守门员：任何写进 stdout 的非 JSON-RPC 内容都会让
`Client.connect` / `listTools` 解析失败。
