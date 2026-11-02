# MultiMediaGrep

**给 agent 的本地媒体感知工具（MCP server）。**

把**本地已有**的视频 / 录音 / 文档，变成 agent 能直接消化的材料：可直接看的图（分镜宫格、特写裁切）
＋ 按时间/页码对齐的文本清单。server 自己不调 LLM——理解由 agent 的多模态模型完成。

---

## 这是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 一个 **MCP server**（默认 stdio，可选 Streamable HTTP），只吃**本地绝对路径** | 不下载、不检索、不登录、不替你取数（取数属于 IntelligenceAtlas） |
| 只做「材料化」：出图 + 出带时间码/页码的文本清单 | 不调 LLM：不做总结、不做问答、不做转述 |
| ASR 与文档解析/OCR 走**你自己配**的外部服务与 key | 不内置本地 ASR / OCR 模型（mlx-whisper、rapidocr 都不再维护） |
| 缓存只写自己的缓存目录 | **绝不在你的文件旁边写任何东西** |

失败也是明说的：没配 ASR 就只给画面，扫描件没配 OCR 就只给页图，并在结果里写清楚原因——
**宁可说「没有文字」，也不编一段台词。**

## 工具（4 个，按动作命名，跨媒体复用）

| 工具 | 干什么 |
|---|---|
| `media_probe` | 探媒体：时长/分辨率/页数/编码、可用轨道、文字层可靠不可靠、能否做 ASR/OCR、文件自带的目录（PDF 书签 / 章节）。不花图片 token |
| `media_overview` | 总览：视频出分镜宫格图，录音出带时间轴转写，文档出页面图 + 每页文本；**额外返回全文落盘路径**。内联文字是预览（whole / skim / sampled 三档，另有 outline 目录视图），`view` 可控目录，`ocr: "force"` 可对坏文字层重新识别；`images: 0` + `transcript: "subtitle"` 可只读字幕 |
| `media_zoom` | 特写：取指定时间点/区间的单帧或文档某页，可裁切放大，用于读字（约 1900 token/张，最贵） |
| `media_locate` | 定位：给一句文本/关键词，返回它在视频/录音里的时间戳；文档返回页码 + 命中次数 + 命中附近的片段（不倾倒整页） |

用法指引（先 probe → 再 overview → 只 zoom 重要部分 → 长素材先收窄范围）写在工具描述与 server instructions 里。

## 0.2.0 有什么新东西（有破坏性变更）

- **文档 provider 拆成两个角色**：`MMGREP_OCR_PROVIDER`（只处理无文字层页，默认 `none`）与
  `MMGREP_TYPESET_PROVIDER`（只处理有文字层页、恢复结构不重识别字符，默认 `builtin`）。
  `MMGREP_DOC_PROVIDER` / `MMGREP_DOC_API_KEY` / `MMGREP_DOC_BASE_URL` / `MMGREP_DOC_MODEL`
  **已删除**，启动时会 warn 并指出替代变量。
- **来源新增 `text`（原生文字层 / 纯文本，字符精确、可原样引用）与 `mixed`（逐页来源不一致）**；
  文档逐页按 `textOrigin` 映射来源，`segments[]` / `matches[]` 里能看到 `textOrigin`。
- **内置目录**：`media_probe` 展示 PDF 书签（物理页 + 打印标签）与视频/录音章节；
  `media_overview` 的 `view` 参数支持 `auto` / `outline` / `text`（视频没有章节时不生成目录）。
- **内联预览分层**：文本三档 whole → skim（文档：全部 heading + 段首句）→ sampled（等距抽样 + 写明未覆盖页），另有 outline 目录视图；
  全文路径固定出现在 text content 末尾，读全文去读 `content.md`。
- **坏文字层可强制重识别**：probe 报 `text layer: looks unreliable (...)` 时用 `ocr: "force"`；
  provider 结果按页缓存，force 单独成键、不覆盖 auto。
- **文档定位不再倾倒整页**：返回页码 + 命中次数 + 命中附近的片段（`hits` / `snippet` / `fuzzy`），
  视频 / 录音仍是 `score`。
- **HTTP 客户端可覆盖内联上限**：请求头 `x-mmgrep-max-text-inline-chars`（硬上限 `200000`）。

完整的破坏性变更与迁移方法见 [`docs/RELEASE-NOTES-v0.2.0.md`](docs/RELEASE-NOTES-v0.2.0.md)。

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

读 **PDF 书签**（probe 的内置目录）另需 `qpdf`；缺了只是读不到目录，正文与页图不受影响。

**外部服务（可选）**：ASR（ElevenLabs 或任何 OpenAI `/audio/transcriptions` 兼容服务）与文档解析（MinerU）
由你用环境变量配置。文档解析拆成 OCR / typeset 两个角色：OCR 默认 `none`，typeset 默认本地 `builtin`（不联网）——
**不配也能用**，只是扫描页拿不到文字（详见下面「环境变量」）。

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
> [mmgrep] info: multimediagrep@0.2.0 ready on stdio
> [mmgrep] info: cache: /Users/you/.cache/multimediagrep (max 10737418240 bytes)
> [mmgrep] info: asr: none (no API key) · ocr: none · typeset: builtin
> [mmgrep] info: backends: video=ready audio=ready document=ready
> [mmgrep] info: image budget: 4000 tokens/call, maxEdge 1600px
> ```

```bash
# 2) 从 checkout 直接跑
git clone https://github.com/flmaximwang/MultiMediaGrep.git && cd MultiMediaGrep
npm install
node src/index.js
```

```bash
# 3) 从 GitHub 装（npm 还没发布时）
npx -y github:flmaximwang/MultiMediaGrep            # 临时拉取并启动
npm i -g github:flmaximwang/MultiMediaGrep           # 装成本地命令 multimediagrep-mcp
npm i -y https://github.com/flmaximwang/MultiMediaGrep/releases/download/v0.2.0/multimediagrep-mcp-0.2.0.tgz   # 只装 release 里的运行时包
```

> 从 GitHub 源码装会把整个仓库拉下来（源码与文档），首次安装比 npm 慢；
> release 里的 `.tgz` 只含运行时（src + 署名材料）。

**stdio 是默认传输方式；HTTP 是显式开启的选项。** 不传 `--http`、也不设 `MMGREP_TRANSPORT=http`
时，server 不会监听任何端口，仍由 MCP client 用 stdio 拉起——现有配置不需要任何改动。
HTTP 模式见下一节。

---

## HTTP 模式

不想让宿主用 stdio 拉起、或要让同一台机器上的多个进程共用一个 server 时，用 Streamable HTTP：

```bash
# 默认只监听 127.0.0.1:3927；stdio 仍是默认，必须显式 --http
npx -y multimediagrep-mcp --http

# 换个端口，并设置 Bearer 令牌（设置后每个请求都要带 Authorization）
npx -y multimediagrep-mcp --http --port 4000 --token '<你的令牌>'

# 也可以用环境变量（命令行优先于环境变量）
MMGREP_TRANSPORT=http MMGREP_HTTP_PORT=4000 MMGREP_HTTP_TOKEN='<你的令牌>' \
  npx -y multimediagrep-mcp
```

- 端点固定为 `POST /mcp`，默认地址 `http://127.0.0.1:3927/mcp`；`GET /mcp` → 405，
  其它路径 → 404。配了令牌时，未授权的请求在判断方法之前就先回 401。
- 启动横幅会写实际地址和 `auth: bearer set|unset`（只报有没有配，不打印令牌值）。
- 请求必须同时接受 JSON 和 SSE：`Accept: application/json, text/event-stream`；
  `Content-Type: application/json`。缺了分别回 406 / 415。
- 令牌只从 `Authorization: Bearer <令牌>` 读，不接受 query string（`?token=` 会被忽略并回 401）。
- HTTP 模式是**无状态**的：每个请求独立处理，不在内存里保留会话。

最小宿主配置（Claude Code 的 `claude mcp add`）：

```bash
claude mcp add --scope user --transport http multimediagrep \
  http://127.0.0.1:3927/mcp \
  --header "Authorization: Bearer <你的令牌>"
```

通用 JSON 形状（多数宿主叫 `mcpServers`；可复制的一份见
[`examples/mcp-config-http.json`](examples/mcp-config-http.json)）：

```json
{
  "mcpServers": {
    "multimediagrep": {
      "type": "http",
      "url": "http://127.0.0.1:3927/mcp",
      "headers": { "Authorization": "Bearer <你的令牌>" }
    }
  }
}
```

> 监听非回环地址（如 `--host 0.0.0.0`）时必须配令牌。没配时 server **仍会启动**，只在启动横幅里
> 记一条 warning，端点对所有能连到该地址的人开放。不要在没有 TLS 的网络上裸跑；
> 反向代理与 curl 自测见 [`docs/install.md` §2.6](docs/install.md)。

---

## 接入宿主

### Claude Code

```bash
# 用户级（所有项目可用）
claude mcp add --scope user multimediagrep \
  -e MMGREP_ASR_PROVIDER=elevenlabs \
  -e MMGREP_ELEVENLABS_API_KEY=sk-你的key \
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
        "MMGREP_ELEVENLABS_API_KEY": "sk-替换成你的key",
        "MMGREP_OCR_PROVIDER": "mineru",
        "MMGREP_TYPESET_PROVIDER": "builtin",
        "MMGREP_MINERU_API_KEY": "替换成你的token"
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
  --env MMGREP_ASR_PROVIDER=elevenlabs MMGREP_ELEVENLABS_API_KEY=sk-你的key \
  --args -y multimediagrep-mcp
```

它会先连一次、列出工具让你勾选，然后写进 `~/.hermes/config.yaml` 的 `mcp_servers:`。
加完用 `hermes mcp test multimediagrep` 验连通，用 `/reload-mcp` 让**已经开着**的会话也加载上。

> `--args` 之后的参数原样透传给命令，所以 `--args` 必须放在最后。

### 其它 MCP client

任何吃标准 MCP client 配置的宿主都用同一段 JSON（键名通常是 `mcpServers`）：
可复制的一份见 [`examples/mcp-config.json`](examples/mcp-config.json)，
各宿主的完整写法见 [`docs/install.md`](docs/install.md) §2。

### 每请求凭据（仅 HTTP 模式）

HTTP 端点常被多个调用方共用，provider 的 key 不必都写死在 server 的环境变量里：
每个请求可以在头里临时覆盖 ASR / 文档 provider 的角色、key、基址和模型。

| 请求头 | 作用 | 对应环境变量 |
|---|---|---|
| `x-mmgrep-asr-provider` | 本次请求用哪个 ASR provider：`elevenlabs` / `openai-compatible` | `MMGREP_ASR_PROVIDER` |
| `x-mmgrep-elevenlabs-api-key` | ElevenLabs key | `MMGREP_ELEVENLABS_API_KEY` |
| `x-mmgrep-elevenlabs-base-url` | ElevenLabs 基址 | `MMGREP_ELEVENLABS_BASE_URL` |
| `x-mmgrep-elevenlabs-model` | ElevenLabs 模型 | `MMGREP_ELEVENLABS_MODEL` |
| `x-mmgrep-openai-compatible-api-key` | OpenAI 兼容服务的 key | `MMGREP_OPENAI_COMPATIBLE_API_KEY` |
| `x-mmgrep-openai-compatible-base-url` | OpenAI 兼容服务的基址 | `MMGREP_OPENAI_COMPATIBLE_BASE_URL` |
| `x-mmgrep-openai-compatible-model` | OpenAI 兼容服务的模型 | `MMGREP_OPENAI_COMPATIBLE_MODEL` |
| `x-mmgrep-asr-api-key` | 通用兜底 key（旧共用变量语义） | `MMGREP_ASR_API_KEY` |
| `x-mmgrep-ocr-provider` | 本次请求的 OCR 角色 provider：`mineru` / `none` | `MMGREP_OCR_PROVIDER` |
| `x-mmgrep-typeset-provider` | 本次请求的 typeset 角色 provider：`builtin` / `mineru` / `none` | `MMGREP_TYPESET_PROVIDER` |
| `x-mmgrep-mineru-api-key` | MinerU token（两个角色共用） | `MMGREP_MINERU_API_KEY` |
| `x-mmgrep-mineru-base-url` | MinerU 基址（两个角色共用） | `MMGREP_MINERU_BASE_URL` |
| `x-mmgrep-mineru-model` | MinerU 模型（两个角色共用） | `MMGREP_MINERU_MODEL` |
| `x-mmgrep-max-text-inline-chars` | 本次请求的内联文本上限（设置头，不是凭据）：正整数，硬上限 `200000` | `MMGREP_MAX_TEXT_INLINE_CHARS` |

优先级（逐字段）：该 provider 的专属请求头 > 该 provider 的环境变量 >
服务器启动配置（仅当 provider 相同）> provider 内置默认值。ASR 仍保留通用
`x-mmgrep-asr-api-key` 兜底；文档角色已删除通用 key 头。
请求头切换 provider 后只读新 provider 的变量组，不会借用另一个 provider 的 key；
头里写了未知的 provider id → HTTP 400（JSON-RPC `-32602`）。空头（空串 / 全空白）等于没带。

要让某个 provider 的专属头生效，得先用 `x-mmgrep-asr-provider` /
`x-mmgrep-ocr-provider` / `x-mmgrep-typeset-provider` 选中它（或服务器本身就选了同一个）。
只带 provider 专属 key 头、provider 仍是 `none` 时，
这个头不会自动启用 provider；**provider 的选择只对当前请求生效**。

**安全**：这些头的值只活在本次请求里——不写日志、不进缓存、不出现在响应里。server 会把本次请求
带过的所有凭据头值从日志里替换成 `[redacted]`。不要把真实 key 写进多人共享的客户端配置：
更稳妥的做法是让宿主连一个你自己控制的代理，由代理注入凭据头。

---

## 给第一次来的 agent：5 分钟上手

给一个**没有上下文**、只想「看看这个工具能干什么」的 agent：

1. **装起来**（宿主负责拉起它，不用自己开端口）：
   - Claude Code：`claude mcp add --scope user multimediagrep -- npx -y github:flmaximwang/MultiMediaGrep`
   - 其它 client：把 [`examples/mcp-config.json`](examples/mcp-config.json) 里的 `command` / `args` 换成上面那条命令即可。
2. **确认环境**：宿主里需要 `ffmpeg` + `ffprobe` 在 PATH 上；读 PDF 还要 `poppler` / `mutool` / `gs` 任意一个。
   缺了会返回 `TOOL_NOT_FOUND`，不会静默出错。
3. **先探后看**（省图片 token）：
   - `media_probe({ path })` → 类型、时长、有没有字幕轨、能不能 ASR/OCR。**不花任何图片 token**，先做这一步。
   - `media_overview({ path })` → 视频出分镜宫格图 + 时间对齐文本；录音出带时间轴转写；文档出页图 + 每页文字。
   - 文档的文字层可能是坏的（早先劣质 OCR 写进去的）：probe 会给出 `text layer: looks unreliable (...)`，这时用 `media_overview({ path, pages, ocr: "force" })` / `media_locate({ path, query, ocr: "force" })` 要求重新识别（需要已配置 OCR provider）。
   - `media_zoom({ path, at })` → 只在「画面上有字要读」时用，最贵（约 1900 token/张）。
   - `media_locate({ path, query })` → 「那句话在哪说的」，纯文本、零图片。
   - 想指定字幕来源时给 `media_probe` / `media_overview` / `media_locate` 传 `subtitle`：本地字幕文件绝对路径、字幕轨 index（非负整数），或语言码（如 `zh` / `en`）；显式指定不可用会直接报错，不会静默换成别的来源。
4. **记住三件事**：
   - 只吃**本地绝对路径**，它不下载任何东西；
   - server 自己不调 LLM，理解由你的模型完成；
   - **字幕优先于 ASR**：字幕通常比 ASR 准，但**可能是自动生成的**（专名、数字要核对画面）；ASR 是机器转写（人名、数字容易错，别当原话引用）。
5. **长素材先收窄**：视频/录音用 `start`/`end`，文档用 `pages`（如 `"3-10,15"`），再跟着结果里的 `continuation` 往下走。

没有 ASR key 也能用：只是拿不到文字层（文件自带字幕就照样出文本）。

## 环境变量

全部前缀 `MMGREP_`，用 `env | grep MMGREP_` 查看当前值。**key 只写在你自己的配置文件里，
server 不会打印它**（日志与错误里只出现 `set` / `unset`）。

| 变量 | 默认值 | 作用 |
|---|---|---|
| `MMGREP_TRANSPORT` | `stdio` | 传输方式：`stdio`（默认）或 `http`。`http` 时监听 `POST /mcp`；写错回落 `stdio` 并记 warning |
| `MMGREP_HTTP_HOST` | `127.0.0.1` | HTTP 监听地址。非回环地址必须配令牌；没配时只记 warning，端点仍会接受未认证请求 |
| `MMGREP_HTTP_PORT` | `3927` | HTTP 监听端口（1–65535；非法值回落 `3927`） |
| `MMGREP_HTTP_TOKEN` | 空 | Bearer 令牌。设置后每个请求必须带 `Authorization: Bearer <令牌>`；不接受 query string。令牌可以是任意 UTF-8 字符串 |
| `MMGREP_CACHE_DIR` | `~/.cache/multimediagrep` | 缓存根目录（抽帧、页图、转写、全文落盘都在这）。`~` 会展开；相对路径按 cwd 解析 |
| `MMGREP_CACHE_MAX_BYTES` | `10737418240`（10 GiB） | 缓存上限，支持 `512MB` / `10GB` / 纯字节数；超出按 LRU 淘汰 |
| `MMGREP_ASR_PROVIDER` | `none` | ASR 后端：`none`（不转写）/ `elevenlabs` / `openai-compatible`。选定后只读该 provider 自己那组变量 |
| `MMGREP_ELEVENLABS_API_KEY` | 空 | ElevenLabs 的 API key（`MMGREP_ASR_PROVIDER=elevenlabs` 时**必填**） |
| `MMGREP_ELEVENLABS_BASE_URL` | `https://api.elevenlabs.io/v1` | ElevenLabs 的 API 基址 |
| `MMGREP_ELEVENLABS_MODEL` | `scribe_v1` | ElevenLabs 转写模型名 |
| `MMGREP_OPENAI_COMPATIBLE_API_KEY` | 空 | OpenAI 兼容服务的 API key（`MMGREP_ASR_PROVIDER=openai-compatible` 时**必填**；自建本地服务也要填非空占位值，如 `local`） |
| `MMGREP_OPENAI_COMPATIBLE_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容服务的 API 基址；自建服务填自己的地址 |
| `MMGREP_OPENAI_COMPATIBLE_MODEL` | `whisper-1` | OpenAI 兼容服务的转写模型名 |
| `MMGREP_ASR_LANGUAGE` | `auto` | 强制语言（BCP-47，如 `zh` / `en`）；`auto` = 让服务自己判断 |
| `MMGREP_ASR_TIMEOUT_MS` | `120000` | ASR 单次请求超时 |
| `MMGREP_OCR_PROVIDER` | `none` | OCR 角色：只处理没有文字层的页，以及工具参数 `ocr: "force"` 指定的页。`none` / `mineru` |
| `MMGREP_TYPESET_PROVIDER` | `builtin` | typeset 角色：只处理有文字层的页，恢复结构、不重识别字符。`builtin` / `mineru` / `none` |
| `MMGREP_TYPESET_SKIP_SIMPLE` | `true` | 外部 typeset provider 只收双栏 / 复杂页，简单页交给本地 builtin |
| `MMGREP_MINERU_API_KEY` | 空 | MinerU 的 token（两个角色共用；<https://mineru.net/apiManage/token>） |
| `MMGREP_MINERU_BASE_URL` | `https://mineru.net/api/v4` | MinerU 的 API 基址（两个角色共用） |
| `MMGREP_MINERU_MODEL` | 空 | 解析模型名；留空 = 用服务端默认（MinerU 可选 `pipeline` / `vlm` / `MinerU-HTML`） |
| `MMGREP_DOC_TIMEOUT_MS` | `180000` | 文档解析单次请求超时（3 分钟）。MinerU 是「上传 → 排队 → 解析 → 下载」整段墙钟时间，排队久就调大 |
| `MMGREP_MAX_IMAGE_TOKENS` | `4000` | 单次调用的图片 token **软预算**。超了自动模式会降形，显式模式只警告 |
| `MMGREP_MAX_IMAGE_EDGE` | `1600` | 单张图最长边的全局上限（px）。请求超过 → `BUDGET_EXCEEDED` |
| `MMGREP_LOG_LEVEL` | `info` | 日志级别：`error` / `warn` / `info` / `debug`。日志**一律走 stderr**（stdout 是协议通道） |
| `MMGREP_MAX_TEXT_INLINE_CHARS` | `24000` | 内联文本预览上限；HTTP 模式可被 `x-mmgrep-max-text-inline-chars` 按客户端覆盖（硬上限 `200000`），全文始终落盘、不受限制 |
| `MMGREP_MAX_CONCURRENCY` | `2` | 单次调用的并行任务数 |

传输相关的命令行开关（`--http` / `--host` / `--port` / `--token`）优先于上表的环境变量。

> 旧的 `MMGREP_ASR_API_KEY` / `MMGREP_ASR_BASE_URL` / `MMGREP_ASR_MODEL` 仍会在
> 对应的 provider 专属变量未设置时兜底，但启动时会记一条弃用 warning。
> **0.2.0 已删除** `MMGREP_DOC_PROVIDER` / `MMGREP_DOC_API_KEY` / `MMGREP_DOC_BASE_URL` /
> `MMGREP_DOC_MODEL`：设置这些变量不会再生效，启动时会 warn 并指出新变量名。
> 同一进程里可以同时存在多家 provider 的 key，server 只读当前选中 provider 的那一组。

另有 `MMGREP_FFMPEG_PATH` / `MMGREP_FFPROBE_PATH`（默认按 `PATH` 查找）、
`MMGREP_AUDIO_MIN_DBFS` / `MMGREP_AUDIO_MIN_SPEECH_RATIO`（音频体检阈值）、
`MMGREP_PROGRESS_NOTIFICATIONS`（默认 `true`）等，完整清单见
[`docs/install.md` §3.5](docs/install.md) 与 [`docs/mcp-contract.md` §12](docs/mcp-contract.md)。

---

## 第一次跑一遍

假设有一个本地视频 `/abs/path/demo.mp4`：

**1. 探（不花图片 token，几毫秒返回）**

```json
{ "path": "/abs/path/demo.mp4" }
```

返回里看五件事：媒体类型、时长、有没有字幕轨、`capabilities.asr.available` / `capabilities.ocr.available`，以及文件自带的目录（PDF 书签 / 章节）。
录音还会给一段 `audioHealth` 体检——如果结论是 `too-quiet` / `silent`，
**转写会故意是空的**（避免 ASR 编出一整段幻觉台词），这时该做的是换一份清楚的录音，而不是继续追问。

**2. 总览（主体动作）**

```json
{ "path": "/abs/path/demo.mp4", "cells": 9, "images": 2 }
```

出 2 张 3×3 的分镜宫格图 + 一份按格对齐的文本清单（每行末尾标了来源：`subtitle` / `text` / `ocr` / `asr` / `none`；整份文档来源不一致时 header 是 `mixed`）。
**全文不内联**，而是落盘成三个主文件（另加可选的 `document.json`）并把路径返回给你：

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

返回它在视频 / 录音里的时间戳（毫秒 + 秒两种表示）；文档返回页码、命中次数与命中附近的片段——不会把整页正文倒出来。

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
- **派生源码**：`src/backend/video/` 下的 `geometry.js`、`frames.js`、`sheet.js`、`shots.js`
  以及 `storyboard.js` 的 `mapPool` 派生自 Apache-2.0 的
  [dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard) v0.5.9（已修改）。
  被改动的文件顶部都有 `Modifications:` 段落（Apache-2.0 §4(b)）。
  完整署名见 [`NOTICE`](NOTICE) 与 [`CREDITS.md`](CREDITS.md)。

---

## 开发

纯 ESM JavaScript（Node ≥20），零构建步骤。规格与决策只在 beads（`bd`），不在本仓库写交接文档。

```bash
npm install
npm run check        # 语法检查（src/、test/、scripts/、fixtures/ 全量 node --check）
npm test             # node --test
npm run fixtures     # 生成测试素材（ffmpeg 脚本生成，仓库不含任何第三方媒体）
```

工具契约（参数、返回结构、错误码、图片预算）见 [`docs/mcp-contract.md`](docs/mcp-contract.md)；
安装、provider 配置、排障与验证清单见 [`docs/install.md`](docs/install.md)。
