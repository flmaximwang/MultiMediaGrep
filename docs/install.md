# MultiMediaGrep 安装与运维指南

> 这份文档写给**第一次装它的人**：怎么把 server 接进宿主、怎么配外部服务、缓存放在哪、
> 出问题了怎么查、以及怎么确认「图片真的进了模型的眼睛」。
>
> 只想知道有哪些工具、参数怎么传 → 看 [`../README.md`](../README.md)。
> 想知道协议细节（返回字段、错误码、图片预算）→ 看 [`mcp-contract.md`](mcp-contract.md)。

---

## 1. 前置检查

在装之前先确认这三样：

```bash
node -v        # 需要 >= 20
ffmpeg -version   # 需要
ffprobe -version  # 需要（ffmpeg 发行版通常自带）
```

只有要读 **PDF** 时才需要下面这组里的**任意一个**：

```bash
pdftoppm -v    # poppler（推荐）
mutool -v      # 或 mutool（mupdf-tools）
gs --version   # 或 ghostscript
```

安装：

```bash
# macOS
brew install ffmpeg poppler

# Debian / Ubuntu
sudo apt install ffmpeg poppler-utils

# Windows（winget）
winget install Gyan.FFmpeg
```

> **工具放在 `PATH` 之外怎么办**：用 `MMGREP_FFMPEG_PATH` / `MMGREP_FFPROBE_PATH` 给绝对路径。
> PDF 工具没有对应的环境变量——它们按 `PATH` 找。

**PDF 书签（内置目录）另需 `qpdf`**：`pdftotext` / `pdfinfo` 读不了 outline。没装 qpdf 时
`media_probe` 仍能正常返回，只会在 `outline:` 行说明「PDF bookmarks cannot be read: qpdf is not installed」，
overview / zoom / locate 不受影响。

**可执行文件不在 PATH 里时的表现**：server 仍然能启动，但每个要抽帧/转码的调用都会返回
`TOOL_NOT_FOUND`（见 §6）。启动横幅里不会报错——**错误是调用时才给的**，不是启动时给的。

---

## 2. 宿主配置

server **默认走 stdio**：宿主用一条命令拉起它，不用开端口。需要多个进程共用一个 server
或跨机器访问时，可以显式开启 Streamable HTTP（`POST /mcp`），见 §2.6。不开启时它不监听任何东西。

### 2.1 Claude Code

**用 CLI 加（推荐）**：

```bash
# 用户级：所有项目都能用
claude mcp add --scope user multimediagrep \
  -e MMGREP_ASR_PROVIDER=elevenlabs \
  -e MMGREP_ELEVENLABS_API_KEY=sk-你的key \
  -- npx -y multimediagrep-mcp

# 项目级：写进项目里的 .mcp.json，随仓库提交给团队
claude mcp add --scope project multimediagrep -- npx -y multimediagrep-mcp
```

`--` 之后是真正被执行的命令；`-e KEY=VALUE` 可以写多次（`claude mcp add --help` 的用法示例）。
`--scope` 取 `local`（默认，只对当前项目+当前机器生效）、`user`（对所有项目）、`project`（写项目里的 `.mcp.json`）。

**手写 `.mcp.json`**（`claude mcp add --scope project` 生成的就是这个形状）：

```json
{
  "mcpServers": {
    "multimediagrep": {
      "command": "npx",
      "args": ["-y", "multimediagrep-mcp"],
      "env": {
        "MMGREP_ASR_PROVIDER": "elevenlabs",
        "MMGREP_ELEVENLABS_API_KEY": "sk-替换成你的key"
      }
    }
  }
}
```

> Claude Code 自己写出来的文件会多一个 `"type": "stdio"` 字段；有没有它都能用，
> 手写时省略兼容性更好（Claude Desktop 等只认 `command`/`args`/`env` 的宿主也认）。

### 2.2 Hermes

Hermes 的 MCP 管理是 `hermes mcp` 这一组子命令，stdio server 走 `--command`：

```bash
hermes mcp add multimediagrep \
  --command npx \
  --env MMGREP_ASR_PROVIDER=elevenlabs MMGREP_ELEVENLABS_API_KEY=sk-你的key \
  --args -y multimediagrep-mcp
```

要点：

- `--args` 之后的参数**原样透传**给命令，所以 `--args` 必须放在**最后**；
- `--env` 收 `KEY=VALUE`，可以给多个（`--env A=1 B=2`）；
- 加的过程中 Hermes 会**真的连一次**、把工具列出来让你勾选，然后写进 `~/.hermes/config.yaml`；
- 写进去的条目长这样（`enabled: true` 是加成功时自动加的）：

```yaml
mcp_servers:
  multimediagrep:
    command: npx
    args:
      - -y
      - multimediagrep-mcp
    env:
      MMGREP_ASR_PROVIDER: elevenlabs
      MMGREP_ELEVENLABS_API_KEY: sk-替换成你的key
    enabled: true
```

- 验证与生效：`hermes mcp test multimediagrep` 测连通；`hermes mcp list` 看列表；
  **已经开着的会话**要 `/reload-mcp` 才会加载新 server（或重开会话）。

> 上面这些命令来自本机 Hermes 的 CLI 源码（`hermes mcp add <name> --command <cmd> --args <args...> --env K=V`）。
> 不同版本的 Hermes 参数可能变，拿不准就敲 `hermes mcp add --help`；以 Hermes 自己的文档为准。

### 2.3 任意 MCP client

标准 client 配置（多数宿主叫 `mcpServers`）：

```json
{
  "mcpServers": {
    "multimediagrep": {
      "command": "npx",
      "args": ["-y", "multimediagrep-mcp"],
      "env": { "MMGREP_LOG_LEVEL": "info" }
    }
  }
}
```

完整可复制的一份在 [`../examples/mcp-config.json`](../examples/mcp-config.json)。

### 2.4 从 checkout 跑（不想装 npm 包时）

```bash
git clone https://github.com/flmaximwang/MultiMediaGrep.git
cd MultiMediaGrep
npm install
node src/index.js
```

配置里把 `command` 换成 `node`、`args` 换成 `["/绝对路径/MultiMediaGrep/src/index.js"]` 即可。

### 2.5 从 GitHub 装（npm 还没发布时）

仓库地址：<https://github.com/flmaximwang/MultiMediaGrep>（公开，Apache-2.0）。

```bash
# A) 临时拉取并启动（宿主拉起 server 时用这条）
npx -y github:flmaximwang/MultiMediaGrep

# B) 装成本地命令 multimediagrep-mcp
npm i -g github:flmaximwang/MultiMediaGrep

# C) 只装 release 里的运行时包（不含 test/ 与 fixtures/，体积最小）
npm i -y https://github.com/flmaximwang/MultiMediaGrep/releases/download/v0.2.0/multimediagrep-mcp-0.2.0.tgz
```

三种装法在宿主配置里的写法一样，只是 `command` / `args` 不同：

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

> A / B 会把整个仓库拉下来（源码与文档），首次安装比 npm 慢一些；
> C 只含运行时。`npx` 会在本地缓存，第二次启动就快了。
> 注意：GitHub 源的安装不走 npm registry 的版本号管理，升级要自己 `git pull` 或换回 npm 包。

### 2.6 HTTP 模式：远程访问与反向代理

HTTP 是**显式开启**的选项；不传 `--http` / 不设 `MMGREP_TRANSPORT=http` 时行为与以前完全一样。

```bash
# 只给本机用：默认监听 127.0.0.1:3927
multimediagrep-mcp --http

# 指定端口 + 令牌（命令行优先于环境变量）
multimediagrep-mcp --http --port 43927 --token '<你的令牌>'

# 等价的环境变量写法
MMGREP_TRANSPORT=http MMGREP_HTTP_HOST=127.0.0.1 MMGREP_HTTP_PORT=43927 \
  MMGREP_HTTP_TOKEN='<你的令牌>' multimediagrep-mcp
```

端点地址是 `http://<host>:<port>/mcp`，只接受 `POST`。请求必须同时接受 JSON 和 SSE：
`Accept: application/json, text/event-stream`；请求体用 `Content-Type: application/json`。

**令牌：非回环地址必须配。** `MMGREP_HTTP_HOST` 不是 `127.0.0.1` / `localhost` / `::1`
（包括 `0.0.0.0`）时，必须设置 `--token` / `MMGREP_HTTP_TOKEN`。注意：server **不会拒绝启动**，
只会在启动横幅里记一条 warning——没配令牌的端点对任何能连到该地址的人开放。
令牌只认 `Authorization: Bearer <令牌>`，query string 里的令牌会被忽略（仍然回 401）。
令牌可以是任意 UTF-8 字符串（服务端按原始字节比较）。

**不要在没有 TLS 的网络上裸跑。** 让 server 继续监听 `127.0.0.1`，由反向代理终结 TLS：

```nginx
# nginx 片段：TLS 在 nginx 终结；向上游只走本机回环的明文 HTTP
location /mcp {
    proxy_pass http://127.0.0.1:3927/mcp;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_read_timeout 125s;   # server 的请求超时是 120s
}
```

```bash
# Caddy：自动签证书；把整站反代到本机回环（路径原样保留）
caddy reverse-proxy --from mcp.example.com --to 127.0.0.1:3927
```

> 代理要原样转发 `Authorization` 头，不要把它改写成 query string。
> 跨机器调用时，客户端必须同时接受 `application/json` 与 `text/event-stream`。

**curl 自测**（两个头缺一不可）：

```bash
curl -sS -X POST http://127.0.0.1:3927/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <你的令牌>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'
```

返回值与错误码：

| 情况 | HTTP 状态 |
|---|---|
| 正常 | 200 |
| 缺 / 错 `Authorization`（配了令牌时） | 401，带 `WWW-Authenticate: Bearer realm="multimediagrep"` |
| `Accept` 没同时包含 `application/json` 和 `text/event-stream` | 406 |
| `Content-Type` 不是 `application/json` | 415 |
| 路径不是 `/mcp` | 404 |
| 方法不是 `POST` | 405（`Allow: POST`） |
| JSON 解析失败 | 400（JSON-RPC `-32700`） |
| 请求体超过 1 MiB | 413 |
| 请求头里的 provider id 不认识 | 400（JSON-RPC `-32602`） |
| 单次请求超过 120 s | 504（响应尚未开始时；在途工具调用会先被中止） |

检查顺序是：先看路径（不是 `/mcp` → 404），再验令牌（配了令牌时 → 401），最后看方法（→ 405）。

每请求凭据头（`x-mmgrep-*`）见 README 的「每请求凭据」与契约 §12.7。

**按客户端覆盖内联上限。** 同一个 HTTP 端点可能被输出上限不同的宿主共用：客户端可以在
MCP 配置里加请求头 `x-mmgrep-max-text-inline-chars`，只对带了该头的请求生效。优先级是
**请求头 > `MMGREP_MAX_TEXT_INLINE_CHARS` > 默认 `24000`**；头值必须是正整数，超过硬上限
`200000` 时按 `200000` 截断并记 warning，非法值记 warning 后回落到环境变量 / 默认值（请求
不会失败），空头等于没带。stdio 没有请求头，仍然只读环境变量；也**没有**按调用的工具参数，
agent 不能自己调大。完整语义见契约 §12.5。

---

## 3. 外部服务（可选）

**不配任何服务也能用**——只是拿不到文字层：

| 媒体 | 没配服务时你得到什么 |
|---|---|
| 视频 | 分镜宫格图 + （如果有字幕文件/内嵌字幕轨）字幕文本；**没有**机器转写 |
| 录音 | 音频包络图（可选）+ 没有文字 |
| 文档 | 页面缩略图宫格 + （PDF 自带文字层时）文字；扫描件没有文字 |

### 3.1 ASR：ElevenLabs

1. 到 <https://elevenlabs.io/app/settings/api-keys> 取 API key。
2. 配上：

```bash
MMGREP_ASR_PROVIDER=elevenlabs
MMGREP_ELEVENLABS_API_KEY=sk-你的key
# 下面几个都有默认值，一般不用动
MMGREP_ELEVENLABS_BASE_URL=https://api.elevenlabs.io/v1
MMGREP_ELEVENLABS_MODEL=scribe_v1
MMGREP_ASR_LANGUAGE=auto
```

server 打的是 `POST {baseUrl}/speech-to-text`，认证头是 `xi-api-key`（不是 `Authorization`）。

**说话人分离**（可选，ElevenLabs 专有）：`MMGREP_ASR_DIARIZE=true`。注意本版只把该选项透传给服务，
`segments[].speaker` 还没有回填（恒为 `null`），不要据此宣称做了说话人标注。

### 3.2 ASR：任何 OpenAI `/audio/transcriptions` 兼容服务

```bash
MMGREP_ASR_PROVIDER=openai-compatible
MMGREP_OPENAI_COMPATIBLE_API_KEY=你的key
MMGREP_OPENAI_COMPATIBLE_BASE_URL=https://your-service/v1
MMGREP_OPENAI_COMPATIBLE_MODEL=whisper-1
```

> ⚠️ **`MMGREP_OPENAI_COMPATIBLE_BASE_URL` 默认是 `https://api.openai.com/v1`。**
> 用自建 / 第三方兼容服务时改成自己的地址；`MMGREP_OPENAI_COMPATIBLE_MODEL` 默认 `whisper-1`，
> 按服务实际支持的模型名改。默认值按 provider 分组，**不会**再把 ElevenLabs 的 `scribe_v1`
> 发给 OpenAI 兼容服务。

> ⚠️ **自建本地服务也必须给一个非空 `MMGREP_OPENAI_COMPATIBLE_API_KEY`**：provider 层是「key 为空就当没配置」，
> 即使 `MMGREP_OPENAI_COMPATIBLE_BASE_URL` 指向 `127.0.0.1`。本地服务不校验 key 时，随便填一个占位串即可
> （例如 `MMGREP_OPENAI_COMPATIBLE_API_KEY=local`）。
> 另外：只有本地地址时 `MMGREP_ASR_PROVIDER` 要写 `openai-compatible`，别写 `elevenlabs`。

### 3.3 文档解析：OCR 与 typeset 两个角色（MinerU）

0.2.0 起，文档 provider 拆成两个角色，分别配置：

- **OCR**（`MMGREP_OCR_PROVIDER`，默认 `none`）：只处理**没有文字层**的扫描页 / 图片；
  以及工具参数 `ocr: "force"` 明确要求重新识别的页（见下面的「坏文字层」）。
- **typeset**（`MMGREP_TYPESET_PROVIDER`，默认 `builtin`）：只处理**有文字层**的页，
  恢复阅读顺序与结构，**不会重新识别字符**。`builtin` 是本地实现，不联网；想让 MinerU
  也参与排版结构时再设成 `mineru`。

只想给扫描件加 OCR（最常见）：

```bash
MMGREP_OCR_PROVIDER=mineru
MMGREP_MINERU_API_KEY=你的token
# 默认值，一般不用动
MMGREP_MINERU_BASE_URL=https://mineru.net/api/v4
MMGREP_MINERU_MODEL=          # 留空 = 用服务端默认模型；也可填 pipeline / vlm / MinerU-HTML
MMGREP_DOC_TIMEOUT_MS=180000
```

如果还要 MinerU 做 typeset（有文字层页的阅读顺序 / 结构）：

```bash
MMGREP_TYPESET_PROVIDER=mineru
```

两个角色共用 `MMGREP_MINERU_*` 凭据与 `MMGREP_DOC_TIMEOUT_MS`。两个角色都是 `mineru`
且配置相同时，server 只发一次解析请求（按逐页 `textOrigin` 分配结果）。

provider 的解析结果**按页缓存**（键含源文件内容 sha256 + provider + model + `ocrMode` + role），
同一范围再次调用（overview / locate 共享）不再请求 provider，只补缺失页；`ocr:"force"` 单独成键，
不会覆盖 auto / 文字层的结果。缓存读坏当 miss、写失败只记 debug——缓存永远不是功能前提。

1. 到 <https://mineru.net/apiManage/token> 取 token。
2. 按上面的变量配置。

注意：

- MinerU 的流程是「申请预签名上传地址 → PUT 上传 → 轮询排队 → 下载结果包」，
  **排队时间算在 `MMGREP_DOC_TIMEOUT_MS` 里**（默认 3 分钟）。高峰期排队久就调大。
- 单文件 ≤ 200 MB、单次 ≤ 200 页；provider 会按 200 页一批自动切批。
- ⚠️ **源文件的物理页数**超过 200 页时，MinerU 可能直接拒绝（业务码 `-60006`），
  即使你只请求其中几页——那种超长 PDF 需要先在本地拆开。
- 文档 provider 失败时，`media_overview` **不报错**——有文字层的页退回原生文字层，
  没有文字层的页降级成「只有页面图 + 一条警告」；但 `media_locate`（必须要文字）会报
  `PROVIDER_FAILED` / `PROVIDER_NOT_CONFIGURED`。
- **坏文字层**：有些 PDF 的文字层是早先劣质 OCR 工具写进去的。`media_probe` 会报
  `text layer: looks unreliable (...)`；这时用 `media_overview({ path, pages, ocr: "force" })`
  或 `media_locate({ path, query, ocr: "force" })` 让 OCR 角色重新识别（有文字层也重识别，
  结果标 `(ocr)`、单独缓存）。没有配置 OCR provider 时 force 会直接报
  `PROVIDER_NOT_CONFIGURED`，不会静默退回坏文字层。
- **旧变量已删除**：`MMGREP_DOC_PROVIDER` / `MMGREP_DOC_API_KEY` /
  `MMGREP_DOC_BASE_URL` / `MMGREP_DOC_MODEL` 不再生效；启动时会 warn 并指出替代变量。

### 3.4 key 的处理

- key 只写在**你自己的**宿主配置或环境变量里，**不要提交进仓库**。
- server 从不打印 key：日志和错误里只会出现 `set` / `unset`，返回值里的 `describe()` 也不含 key。
- 错误信息里的 `sk-…` / `Bearer …` 会被脱敏成 `sk-***` / `Bearer ***`。
- HTTP 模式下，provider key 也可以放在 `x-mmgrep-*` 请求头里（见 README「每请求凭据」）：
  只对该请求生效，不缓存、不落盘、不出现在响应里；日志中出现的头值统一替换成 `[redacted]`。
  多人共享的端点不要让大家把真实 key 写进客户端配置——优先让宿主连一个你自己控制的代理，
  由代理注入凭据头。

---

### 3.5 环境变量总表

全部前缀 `MMGREP_`。**key 只回答「配没配」，永不打印值**；写错的值按「用默认值 + 记 warning」处理，不会让 server 崩。

| 变量 | 默认值 | 作用 |
|---|---|---|
| `MMGREP_TRANSPORT` | `stdio` | 传输方式：`stdio` / `http`；写错回落 `stdio` |
| `MMGREP_HTTP_HOST` | `127.0.0.1` | HTTP 监听地址；非回环且无令牌 → 启动 warning |
| `MMGREP_HTTP_PORT` | `3927` | HTTP 监听端口（1–65535） |
| `MMGREP_HTTP_TOKEN` | 空 | Bearer 令牌；空 = 不鉴权 |
| `MMGREP_CACHE_DIR` | `~/.cache/multimediagrep` | 缓存根目录（`~` 展开，相对路径按 cwd） |
| `MMGREP_CACHE_MAX_BYTES` | `10737418240`（10 GiB） | 缓存上限，支持 `512MB` / `10GB` / 字节数；LRU 淘汰 |
| `MMGREP_ASR_PROVIDER` | `none` | `none` / `elevenlabs` / `openai-compatible` |
| `MMGREP_ELEVENLABS_API_KEY` | 空 | ElevenLabs key（回环 baseUrl 可免） |
| `MMGREP_ELEVENLABS_BASE_URL` | `https://api.elevenlabs.io/v1` | ElevenLabs 基址 |
| `MMGREP_ELEVENLABS_MODEL` | `scribe_v1` | ElevenLabs 转写模型 |
| `MMGREP_OPENAI_COMPATIBLE_API_KEY` | 空 | OpenAI 兼容服务 key（自建服务也要非空占位值） |
| `MMGREP_OPENAI_COMPATIBLE_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容服务基址 |
| `MMGREP_OPENAI_COMPATIBLE_MODEL` | `whisper-1` | OpenAI 兼容服务模型 |
| `MMGREP_ASR_LANGUAGE` | `auto` | 强制语言（BCP-47）；`auto` = 服务自己判断 |
| `MMGREP_ASR_TIMEOUT_MS` | `120000` | ASR 单次请求超时 |
| `MMGREP_ASR_MAX_BYTES` | `104857600`（100 MiB） | 单次上传音频上限（provider 层读取） |
| `MMGREP_ASR_DIARIZE` | `false` | 仅 ElevenLabs：请求说话人分离（本版只透传，`speaker` 未回填） |
| `MMGREP_ASR_RESPONSE_FORMAT` | `verbose_json` | 仅 OpenAI 兼容：响应格式（要时间戳就用它） |
| `MMGREP_ASR_TIMESTAMP_GRANULARITIES` | 空 | 仅 OpenAI 兼容：`word` / `segment` 时间戳粒度 |
| `MMGREP_OCR_PROVIDER` | `none` | OCR 角色：`mineru` / `none`，只处理无文字层页与 `ocr:"force"` 页 |
| `MMGREP_TYPESET_PROVIDER` | `builtin` | typeset 角色：`builtin` / `mineru` / `none`，只处理有文字层页 |
| `MMGREP_TYPESET_SKIP_SIMPLE` | `true` | 外部 typeset 只收双栏 / 复杂页，简单页交给 builtin |
| `MMGREP_MINERU_API_KEY` | 空 | MinerU token（两个角色共用） |
| `MMGREP_MINERU_BASE_URL` | `https://mineru.net/api/v4` | MinerU 基址（两个角色共用） |
| `MMGREP_MINERU_MODEL` | 空 | MinerU 模型；空 = 服务端默认（`pipeline` / `vlm` / `MinerU-HTML`） |
| `MMGREP_DOC_TIMEOUT_MS` | `180000` | 文档解析单次请求超时（OCR 与 typeset 共用） |
| `MMGREP_MAX_IMAGE_TOKENS` | `4000` | 单次调用图片 token 软预算 |
| `MMGREP_MAX_IMAGE_EDGE` | `1600` | 单图最长边硬上限（px） |
| `MMGREP_MAX_TEXT_INLINE_CHARS` | `24000` | 内联文本预览上限；HTTP 模式可被 `x-mmgrep-max-text-inline-chars` 覆盖，硬上限 `200000` |
| `MMGREP_MAX_CONCURRENCY` | `2` | 单次调用的并行任务数 |
| `MMGREP_AUDIO_MIN_DBFS` | `-35` | 音频体检：平均音量下限（低于 → `too-quiet`，不跑 ASR） |
| `MMGREP_AUDIO_MIN_SPEECH_RATIO` | `0.05` | 音频体检：非静音时长占比下限（与上一条是「或」） |
| `MMGREP_FFMPEG_PATH` | 空（按 PATH） | ffmpeg 可执行文件绝对路径 |
| `MMGREP_FFPROBE_PATH` | 空（按 PATH） | ffprobe 可执行文件绝对路径 |
| `MMGREP_LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug`（只写 stderr） |
| `MMGREP_PROGRESS_NOTIFICATIONS` | `true` | 是否发 MCP 进度通知（运维扩展，非工具契约） |

**0.2.0 删除的变量**（设置了也不生效，启动时 stderr 会 warn 并指出替代项）：

| 已删除 | 替代 |
|---|---|
| `MMGREP_DOC_PROVIDER` | `MMGREP_OCR_PROVIDER`（无文字层页）+ `MMGREP_TYPESET_PROVIDER`（有文字层页，默认 `builtin`） |
| `MMGREP_DOC_API_KEY` | `MMGREP_MINERU_API_KEY` |
| `MMGREP_DOC_BASE_URL` | `MMGREP_MINERU_BASE_URL` |
| `MMGREP_DOC_MODEL` | `MMGREP_MINERU_MODEL` |

**仍保留但已弃用的 ASR 兜底**：`MMGREP_ASR_API_KEY` / `MMGREP_ASR_BASE_URL` / `MMGREP_ASR_MODEL`
在对应 provider 专属变量未设置时生效，并记一条弃用 warning（0.2.0 未删除）。

## 4. 缓存：位置、结构与清理

### 4.1 放在哪

默认 `~/.cache/multimediagrep`（`MMGREP_CACHE_DIR` 可改；`~` 会展开，相对路径按进程 cwd 解析）。

**绝不在你的源文件旁边写任何东西**——所有抽帧、页图、转写、全文落盘都在缓存目录里。

### 4.2 目录结构

```
~/.cache/multimediagrep/
├── fingerprint-index.json        快速指纹索引（路径+大小+mtime → 内容 sha256）
├── <2 位分片>/<62 位摘要>/       条目目录（按**文件内容 sha256** 键控）
│   ├── content.md                全文（人读）
│   ├── segments.jsonl            全文（一行一个 segment）
│   ├── manifest.json             这次产出了什么
│   ├── document.json             可选件（cangjie SourceDocument Contract v1）
│   ├── images/                   宫格图 / 特写图
│   └── doc-provider/...          文档 provider 的逐页结果（page-0001.json …，见 §3.3）
└── <2 位分片>/.meta-<摘要>.json  条目记录（大小、创建与最后使用时间）
```

**按内容 hash 键控**：文件内容变了 → key 变了 → 旧产物自动作废，不会出现「文件改了还命中旧缓存」。

### 4.3 容量与淘汰

- 上限 `MMGREP_CACHE_MAX_BYTES`，默认 **10 GiB**；支持 `512MB` / `10GB` / 纯字节数。
- 每次写入后检查一次，超了按 **LRU** 淘汰整条目（依据条目记录里的「最后使用时间」，
  不用文件 mtime、也不用 atime）。
- 刚写好、正要返回给 agent 的那一条**永远不会被立刻删掉**——所以单次调用有可能让缓存短暂超限。

### 4.4 清理

```bash
# 全清（安全：只删自己的缓存目录）
rm -rf ~/.cache/multimediagrep

# 只清某个文件的产物（按内容 hash 找目录）
ls ~/.cache/multimediagrep/*/            # 目录名就是摘要
rm -rf ~/.cache/multimediagrep/ab/abcdef.../

# 换机器 / 换用户时：把 MMGREP_CACHE_DIR 指到新目录即可
```

`media_overview` 返回的 `fullText.dir` 就是这次落盘的目录，可以直接去读那三个文件。
`document.json`（cangjie `SourceDocument Contract v1`）默认也会写在同一目录；下游不需要 cangjie 时完全可以不读它。

---

## 5. 用起来：probe → overview → zoom → locate

调用顺序是契约里写死的用法指引（也在 server instructions 里下发给 agent）：

| 步骤 | 工具 | 花多少图片 token |
|---|---|---|
| 1. 先摸清这是什么 | `media_probe` | 0 |
| 2. 主体阅读 | `media_overview` | 0–4 张（默认 2 张：视频 9 格/张，文档 6 格/张） |
| 3. 只放大有用的部分 | `media_zoom` | 1 张（~1900 token，**最贵**） |
| 4. 「那句话在哪」 | `media_locate` | 0（`includeFrame: true` 才 +1 张） |

> 只需要字幕文字时，用 `media_overview` + `images: 0` + `transcript: "subtitle"`（或带 `subtitle` 显式选择来源）：零图片，只回转写段落。

**长素材先收窄**：超过 30 分钟的视频、超过 30 页的文档，先用 `start`/`end` 或 `pages` 取一小段，
再跟着结果里的 `continuation.nextStartMs` / `continuation.nextPage` 一段段往下走。

**内联的只是预览，全文永远落盘。** `media_overview` 的 text content 末尾有
`full text: <content.md 绝对路径> (segments.jsonl, manifest.json in the same directory)` 一行；
内联文字分三档：whole（请求范围整体放得下）、skim（文档有 blocks 时：全部 heading + 段首句）、
sampled（完整单元等距抽样，并写明未覆盖页）；`view:"outline"` 时只出目录。
`view:"auto"` 在放不下且有目录（PDF 书签 / 视频章节 / 文档 ≥5 个 heading）时先出目录；
视频/录音没有章节时 `view:"outline"` 只给「no chapters」，不生成内容。

单次调用的硬上限（超了报 `BUDGET_EXCEEDED`，**不会静默截断**）：
4 张图 / 每张 16 格 / 单次共 64 格 / 单图最长边 1600 px / 单图 ≤ 2,000,000 像素；
软预算 `MMGREP_MAX_IMAGE_TOKENS`（默认 4000）超出时自动模式会降形并在结果里说明改了什么。

---

## 6. 排障

| 症状 | 原因 | 怎么办 |
|---|---|---|
| `TOOL_NOT_FOUND: ffprobe is required but was not found on PATH. Install ffmpeg (which bundles ffprobe) and retry.` | 没装 ffmpeg | 装 ffmpeg，或 `MMGREP_FFPROBE_PATH` / `MMGREP_FFMPEG_PATH` 给绝对路径 |
| `TOOL_NOT_FOUND: ffmpeg is not installed or not on PATH.` | 同上 | 同上 |
| `TOOL_NOT_FOUND: no PDF page rasterizer is available on this machine (pdftoppm, mutool, and gs were all missing).` | 没装 PDF 栅格化工具 | 装 `poppler-utils` / `mupdf-tools` / `ghostscript` 任意一个 |
| `TOOL_NOT_FOUND: cannot read PDF metadata: no PDF tool is installed (pdfinfo, mutool, or qpdf).` | 同上（缺的是元信息工具） | 同上 |
| probe 说 `asr: unavailable — …` | 没配 ASR / 缺 key / 体检判定无声（`too-quiet` / `silent`） | 配 `MMGREP_ASR_PROVIDER` + 对应 provider 的 key（§3.1 / §3.2），或传一个本地字幕文件；体检无声时换一份清楚的录音 |
| probe 说 `ocr provider: none — No OCR provider is configured (MMGREP_OCR_PROVIDER is "none"). Pages without a text layer are returned as page images only.` | 没配 OCR | 配 `MMGREP_OCR_PROVIDER=mineru` + `MMGREP_MINERU_API_KEY`（§3.3）；扫描件没 OCR 就只能看页图 |
| `PROVIDER_NOT_CONFIGURED`（文档，含 `ocr: "force"`） | 选了 provider 但缺 key；或 force 时根本没配 OCR provider | `MMGREP_MINERU_API_KEY` 填上，或把对应角色设成 `none`（`MMGREP_OCR_PROVIDER=none` / `MMGREP_TYPESET_PROVIDER=none`）退回「只有页图」/「原生文字层」 |
| `PROVIDER_FAILED: … HTTP 401/403 …` | key 不对 / token 过期 | 换 key；MinerU 常见业务码 `A0202`（token 错）、`A0211`（token 过期） |
| `PROVIDER_FAILED`，但我明明用的是自己的服务 | `MMGREP_OPENAI_COMPATIBLE_BASE_URL` / `MMGREP_OPENAI_COMPATIBLE_MODEL` 没改 | 这两个的默认值是 OpenAI 官方的 `https://api.openai.com/v1` + `whisper-1`；用自己的服务时显式写上（见 §3.2） |
| `PROVIDER_FAILED: … HTTP 404 …` | 基址写错 | 检查 `MMGREP_ELEVENLABS_BASE_URL` / `MMGREP_OPENAI_COMPATIBLE_BASE_URL` / `MMGREP_MINERU_BASE_URL` |
| `PROVIDER_FAILED: ASR request timed out after 120000 ms.` | ASR 超时 | 调大 `MMGREP_ASR_TIMEOUT_MS`；或换更快的模型 |
| `PROVIDER_FAILED` + 排队很久 | MinerU 排队 | 调大 `MMGREP_DOC_TIMEOUT_MS`（默认 180000） |
| `NO_TRANSCRIPT: no transcript available for this file and no ASR provider is configured (MMGREP_ASR_PROVIDER="none"). …` | `media_locate` 要文字但没有（**overview 不报这个错**：它返回空转写 + 原因） | 配 ASR，或给 `subtitle` 传一个本地 `.srt`/`.vtt` 文件、字幕轨 index 或语言码；也可以改用 `media_overview({ images: 0, transcript: "subtitle", subtitle })` 只读字幕 |
| `NO_TRANSCRIPT: cannot search this document: no text layer and no OCR provider is configured. There is nothing to search.` | 扫描件没 OCR，又要定位文字 | 配文档 provider，或先把 PDF 转成带文字层的版本 |
| 录音转写永远是空的 | 音频体检判定 `too-quiet` / `silent`（**故意的**） | 换一份清楚的录音；或调低 `MMGREP_AUDIO_MIN_DBFS` / `MMGREP_AUDIO_MIN_SPEECH_RATIO` |
| `BUDGET_EXCEEDED: requested 5 images but the per-call limit is 4. …` | 一次要太多图 | 减 `images`/`cells`，或用 `start`/`end` / `pages` 分段 |
| `BUDGET_EXCEEDED: maxEdge must be an integer between 256 and 1600 (got 3000).` | 图太大 | 调小 `maxEdge`（全局上限是 `MMGREP_MAX_IMAGE_EDGE`） |
| `INVALID_ARGUMENT: path must be an absolute local path; got "videos/a.mp4". …` | 传了相对路径 | 传绝对路径 |
| `NOT_A_LOCAL_PATH: path must be a local absolute file path; URLs are not accepted …` | 传了 URL | **本 server 不下载**：先把文件取到本地，再传本地路径 |
| `UNSUPPORTED_MEDIA_TYPE`（Office 文档） | `.docx/.pptx/.xlsx` 等暂不支持 | 先转 PDF：`soffice --headless --convert-to pdf <file>` |
| stdout 出现非 JSON-RPC 内容，client 报解析错 | 有东西往 stdout 写了 | 本 server 的日志一律走 stderr；如果你自己套了 wrapper，注意别把日志打到 stdout |
| 环境变量写错了但 server 没崩 | 设计如此 | 非法值回落默认值 + 记一条 warning；`MMGREP_LOG_LEVEL=debug` 能看到更多 |

---

## 7. 验证清单：图片真的进了模型的眼睛吗？

「图片能不能被模型看到」是**宿主侧**的事（有的宿主会裁剪、会降采样、会直接丢掉 image block）。
server 只能保证自己交出去的东西是对的。下面几步用来确认链路是通的。

### 7.1 先在协议层确认 server 交出了图片

用 [MCP Inspector](https://www.npmjs.com/package/@modelcontextprotocol/inspector) 直接看原始报文：

```bash
npx @modelcontextprotocol/inspector npx -y multimediagrep-mcp
```

在 Inspector 里调 `media_overview`（先 `media_probe` 拿到时长），结果里应该看到：

- `content` 数组里有一个 `{ "type": "text", … }` 块，**以及每张图一个**
  `{ "type": "image", "data": "<base64>", "mimeType": "image/png" }` 块；
- `structuredContent.images[]` 里只有**描述**（`width` / `height` / `cells` / `estimatedTokens`），
  **没有像素**——像素只在 `content` 的 image block 里；
- `structuredContent.fullText` 里有 `contentMd` / `segmentsJsonl` / `manifestJson` 三个绝对路径；
- `structuredContent.budget` 里有这次花了多少图片 token。

**快速自检**：把 `content` 里那个 image block 的 `data`（base64）长度乘 0.75，得到的字节数应该和
`structuredContent.images[0].bytes` **基本相等**（例：`data` 长 45836 字符 → 34375 字节，
`bytes` 字段就是 34375）。如果 `data` 是一小截字符串，说明图没生成成功。

### 7.2 再在宿主里确认模型看得见

在宿主（Claude Code / Hermes）里对同一个短文件调一次 `media_overview`，然后**直接问模型**：

> 「刚才那张宫格图里，你看到的是几个画面？画面里有没有文字？」

- 模型能描述出画面内容 → image block 确实到了模型；
- 模型说「我只能看到一段文字描述 / 一个路径」 → **宿主把图片丢了**（或降采样到不可读），
  这时把 `structuredContent.images[]` 的尺寸告诉它，或改用 `media_zoom`（单张 1600 px，更抗降采样）；
- 模型说图是空的 / 全黑 → 回去看 §7.1：先确认 `data` 不是空的。

### 7.3 单帧路径（更严格）

`media_zoom` **只**返回一张图，是最严格的测试：

```json
{ "path": "/abs/path/demo.mp4", "at": 72.5 }
```

期望：`content` 里恰好 1 个 image block；`structuredContent.image.estimatedTokens ≈ 1920`；
`structuredContent.image.source = "visual"`。

如果 `media_zoom` 的图能看见、`media_overview` 的宫格看不见，多半是**格数太多被降采样**——
用 `cells: 4` + `maxEdge: 1600` 再试一次（2×2 布局，每格 800×450，远超「scene」档要求的 320×180）。

### 7.4 三步一起做完的检查表

- [ ] `media_probe` 能返回，且 `capabilities.asr.available` / `capabilities.ocr.available` 与你的配置一致；
- [ ] `media_overview` 返回的 `content` 里有 image block（协议层确认，见 §7.1）；
- [ ] 模型能**描述**出画面内容（宿主层确认，见 §7.2）。

三步全过 = 图片链路通。任一步不过，就按 §6 的表对症下药。

> 顺带一提：契约 §10 里的那几个数（4 张 / 16 格 / 1600 px / 4000 token）是按上游算法**推导**的，
> 不是对某个宿主的实测上限——**这份检查表就是用来在你自己宿主上确认实际表现的**。

---

## 8. 没验证过的事（照实说）

- 本文档里的 Claude Code 与 Hermes 命令，是在**本机安装的这两个 CLI** 上核对过帮助文本 /
  源码得到的；不同版本的参数可能不同，以 `claude mcp add --help` / `hermes mcp add --help` 为准。
- npm 包名与版本、发布流程**没有在本仓库里验证过**——本文档只描述「怎么装、怎么配、怎么查」。
- 仓库地址、主页、issue 追踪链接现在都指向 <https://github.com/flmaximwang/MultiMediaGrep>；
  其它没核实过的信息（作者邮箱、CI 徽章、npm 页）仍然不写。
