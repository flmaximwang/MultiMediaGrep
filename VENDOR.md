# VENDOR.md — vendored 源码说明

本仓库把 **dsh-video-storyboard** 的源码 vendor 进了 `vendor/dsh-video-storyboard/`。
本文件是那份拷贝的**完整说明书**：哪些模块进来了、哪些删了、为什么删、哪些被本地改过、
以及以后怎么跟上游对比。

上游仓库里的算法代码（切点检测、排格规划、拼图、字幕解析、文本对齐）质量很高，
直接当 npm 依赖不划算（上游是 DeepSeek Harness 插件，包体小但和宿主耦合深），
所以按 beads 票 9z5.6 与 epic 决策 (18) 的做法：**把需要的源码 vendor 进仓库**，
而不是加一个依赖。

---

## 1. 上游坐标

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/SAOS-3624/dsh-video-storyboard |
| 版本 | 0.5.9 |
| tag | `v0.5.9` |
| commit | `6bc8291`（完整：`6bc82911e4326714a122bf1d34368534319b4a0f`） |
| 许可 | Apache-2.0 |
| vendor 时间 | 2026-11-01 |
| 机器可读坐标 | `vendor/dsh-video-storyboard/UPSTREAM.json` |

许可合规：上游 `LICENSE` / `NOTICE` / `CREDITS.md` **逐字复制**进 `vendor/dsh-video-storyboard/`
（一个字没改）；根目录另有本项目的 `LICENSE` / `NOTICE` / `CREDITS.md`。
被改动的 vendor 文件顶部都有 `Modifications:` 段落（Apache-2.0 §4(b)）。

---

## 2. vendor 目录结构（文件级）

```
vendor/dsh-video-storyboard/
├── LICENSE              ← 上游原文，逐字复制
├── NOTICE               ← 上游原文，逐字复制
├── CREDITS.md           ← 上游原文，逐字复制
├── CHANGELOG.md         ← 上游原文，逐字复制
├── UPSTREAM.json        ← 本项目新增：机器可读的上游坐标
└── src/
    ├── tool-spec.js                      ← 未改动
    └── storyboard/
        ├── audio.js                       ← 未改动
        ├── binaries.js                    ← 未改动
        ├── board.js                       ← 未改动
        ├── cache.js                       ← 未改动
        ├── cells.js                       ← 未改动
        ├── cli-options.js                 ← 未改动
        ├── density.js                     ← 未改动
        ├── flash.js                       ← 未改动
        ├── format.js                      ← ★ 本地改过
        ├── frames.js                      ← 未改动
        ├── index.js                       ← 未改动
        ├── injection.js                   ← 未改动（**保留**，见 §3.4）
        ├── layout.js                      ← 未改动
        ├── locate.js                      ← 未改动
        ├── measure.js                     ← 未改动
        ├── media-store.js                 ← 未改动
        ├── memory.js                      ← 未改动
        ├── ocr-subs.js                    ← ★ 本地改过
        ├── ocr.js                         ← ★ 本地改过
        ├── pipeline.js                    ← ★ 本地改过
        ├── plan.js                        ← 未改动
        ├── probe.js                       ← 未改动
        ├── provenance.js                  ← 未改动
        ├── scan.js                        ← 未改动
        ├── segments.js                    ← 未改动
        ├── sheet.js                       ← 未改动
        ├── storage.js                     ← 未改动
        ├── subtitle-strip.js              ← ★ 本地改过
        ├── subtitles.js                   ← ★ 本地改过
        ├── tool-spec.js                   ← 未改动
        └── transcript-file.js             ← ★ 本地改过
```

**没有 vendor 进来的上游目录**（不是漏了，是有意不拿）：

| 上游路径 | 为什么不要 |
|---|---|
| `bin/`（5 个 `.mjs`） | 上游 CLI（`storyboard.mjs` / `doctor.mjs` / `asr-check.mjs` …），依赖已删的 `fetch.js` / `url.js` / `asr.js` / `ytdlp.js`；本项目用 MCP 工具，不用 CLI |
| `test/`（37 个 `.mjs`） | 上游测试套件，一半测的是我们删掉的模块（取数、DSH 注册、ASR 生命周期）；本项目有自己的测试 |
| `docs/` | 上游文档 + 两张 PNG。上游 `NOTICE` 明确写「`docs/` 下的图片不在授权范围内」，所以整目录不拿 |
| `scripts/` | 上游自己的 `check-syntax.mjs` / `install-dev.mjs` / `export-cuts-mat.mjs`；本仓库有等价物 `scripts/check-syntax.mjs` |
| `README.md` / `README.zh.md` / `README.en.md` | 上游 README（~90 KB）。本文件承担同样的职责 |
| `dsh.plugin.json` / `cordis.patch.yml` | DeepSeek Harness 插件元数据，本项目不是 DSH 插件 |
| `.github/` / `.gitignore` / `.gitattributes` / `.mailmap` | 上游的 CI 与 git 配置，与代码无关 |

---

## 3. 删除了哪些，为什么

删除分四组。每一组都先查过**依赖图**（谁 import 它、它 import 谁），下面逐个写清楚。

### 3.1 取数相关（本项目不自己下载媒体）

取数职责已经迁到 IntelligenceAtlas（beads 决策 (18)），所以这一整组都删。

| 删掉的上游文件 | 为什么 | 谁 import 它（上游依赖图） |
|---|---|---|
| `src/storyboard/fetch.js` | `resolveInput()`：把 URL 变成本地文件（yt-dlp 下载 + DASH 音视频合流）。这是**下载视频**本身 | `pipeline.js`；`src/tools/{locate,probe,subtitles,zoom}.js` |
| `src/storyboard/direct-url.js` | 直链记忆/复用（`directFromSummary` / `recallDirect` / `rememberDirect`），是 URL 取数的一部分 | `fetch.js`；`src/tools/zoom.js` |
| `src/storyboard/url.js` | URL 规范化 + 「这个 URL 可不可取」断言 | `fetch.js`；`direct-url.js`；`src/tools/{probe,zoom}.js` |
| `src/storyboard/ytdlp.js` | 发现并准备 yt-dlp 可执行文件（`discoverYtdlp`），是取数链的一环 | `subtitles.js`；`bin/doctor.mjs` |
| `src/storyboard/browser-time.js` | 从开了调试端口的浏览器里捞 cookies —— 为「自动登录某个站点取字幕」服务 | `subtitles.js` |

> `browser-time.js` 的非取数用途：无。它整篇都是「从浏览器读 cookie / 调 CDP」。
> 所以**按删除处理**。

### 3.2 DeepSeek Harness 宿主耦合

| 删掉的上游文件 | 为什么 | 谁 import 它 |
|---|---|---|
| `src/index.js` | DSH 插件入口（cordis 的 `inject` / `apply`、15 秒看门狗、宿主包解析） | —（包根入口） |
| `src/tools/locate.js` | DSH 工具实现（`defineTool` 契约 + 宿主附件提交） | `src/storyboard/register.js` |
| `src/tools/probe.js` | 同上 | `src/storyboard/register.js` |
| `src/tools/storyboard.js` | 同上 | `src/storyboard/register.js` |
| `src/tools/subtitles.js` | 同上 | `src/storyboard/register.js` |
| `src/tools/zoom.js` | 同上 | `src/storyboard/register.js` |
| `src/tools/shared.js` | 同上（`attachSheetImages` 等宿主能力探测） | `src/tools/{storyboard,zoom}.js` |
| `src/storyboard/register.js` | 五个工具的注册入口 | `src/index.js` |
| `src/storyboard/asr-lifecycle.js` | 拉起 / 保活 / 空闲停止本地 ASR 服务进程 | `pipeline.js`；`bin/asr-check.mjs` |

`src/tools/` 整个目录删除还有一个硬理由：这 5 个工具全部 import 了 `fetch.js` / `url.js` /
`direct-url.js`，留着必然引用不存在的模块。

### 3.3 ASR 栈（本项目的 ASR 走自己的 provider）

| 删掉的上游文件 | 为什么 | 谁 import 它 |
|---|---|---|
| `src/storyboard/asr.js` | OpenAI 兼容的 `/audio/transcriptions` 客户端 + `~/.dsh/asr.json` 配置解析。本项目的 ASR 走自己的 provider 接口（ElevenLabs 等），vendor 里**不应该有第二套 ASR 实现** | `pipeline.js`；`format.js`；`subtitles.js`（只要 `parseSrt`） |
| `src/storyboard/transcript-cache.js` | 按片缓存 ASR 结果（`cachedTranscript` / `rememberTranscript`） | `pipeline.js` |

`asr.js` 里**与 ASR 无关的纯函数**没有跟着删，而是**原样搬到** `transcript-file.js`（见 §4）：
`alignCells`、`speechCurve`、`shortStamp`、`CELL_BREAK_GAP`、`filterSuspectSegments`、
`applyTermMap`、`extractSubtitleTrack`。`parseSrt` 本来就在 `transcript-file.js` 里有一份
更耐受的版本，直接复用。

### 3.4 本地 OCR 路径（本项目 OCR 走外部服务 MinerU）

| 删掉的上游文件 | 为什么 | 谁 import 它 |
|---|---|---|
| `src/storyboard/python.js` | 找一台装了 `rapidocr` / `rapidocr_onnxruntime` 的 python | **只有 `ocr.js`**（上游依赖图里它是孤儿） |
| `src/ocr_bridge.py` | Python 侧 OCR 桥接脚本（检测字幕带 / 读带内文字） | **只有 `ocr.js`**（通过 `OCR_BRIDGE` 路径常量） |

`ocr.js` **保留但改造**：Python 桥接换成**可注入的 OCR 后端**（见 §4）。
纯逻辑 `OCR_MAX_ITEMS` / `similarity()` / `shouldReplace()` **逐字未动** —— 那三条
「置信度 ≥ 0.65 / 长度差 ≤ 30% / 相似度 0.2–0.9」的替换判据是上游最有价值的一段纯逻辑，
而且对外接 OCR 服务（MinerU）一样成立。

### 3.5 ⚠ 与任务书不同的一处：`injection.js` **保留**了

任务书把 `src/storyboard/injection.js` 归在「DeepSeek Harness 宿主耦合」里要求删除。
**实际检查下来它跟 DSH 没有任何耦合**：76 行、零 import、纯正则扫描器，
只依赖 `segments` 数组，作用是把字幕/标题里「伪装成命令的句子」（"ignore previous instructions"、
「立即停止本轮回复」之类）标出来，写进清单的 `transcript.suspectInjection`。

删掉它会：

1. 丢掉一道防线 —— 本项目正是把**字幕文本喂给模型**的项目，这段扫描正好用得上；
2. 让 `pipeline.js` 多一处删除（那 5 行 `suspectInjection` 拼装 + 2 处清单字段）。

所以**保留**了它，并在 §4 的补丁清单里标明它是「未改动」状态。
**如果仍要删**：删 `vendor/dsh-video-storyboard/src/storyboard/injection.js`，
再去 `pipeline.js` 删掉 `import { findInjection }`、以及 `externalSource` / `suspectInjection`
两块与两处 `...(suspectInjection.length ? { suspectInjection } : {})` 即可。

### 3.6 汇总

- 删除 **18 个上游源文件** + `src/tools/` 整个目录 + `src/ocr_bridge.py`。
- 上游 `src/` 共 **50** 个文件，vendor 保留 **32** 个（其中 7 个本地改过）。

---

## 4. 本地改动过的文件清单

7 个文件被本地改过。**每一个文件顶部都有 `Modifications:` 段落**，写明改了什么、为什么。
这是 Apache-2.0 §4(b) 要求的「标注修改」，也是 `scripts/upstream-sync.mjs` 判断
「上游这次改动会不会撞上我们的补丁」的依据。

<!-- upstream-sync:patch-list -->
```json
{
  "modified": [
    "src/storyboard/format.js",
    "src/storyboard/ocr-subs.js",
    "src/storyboard/ocr.js",
    "src/storyboard/pipeline.js",
    "src/storyboard/subtitle-strip.js",
    "src/storyboard/subtitles.js",
    "src/storyboard/transcript-file.js"
  ],
  "deleted": [
    "src/index.js",
    "src/ocr_bridge.py",
    "src/storyboard/asr-lifecycle.js",
    "src/storyboard/asr.js",
    "src/storyboard/browser-time.js",
    "src/storyboard/direct-url.js",
    "src/storyboard/fetch.js",
    "src/storyboard/python.js",
    "src/storyboard/register.js",
    "src/storyboard/transcript-cache.js",
    "src/storyboard/url.js",
    "src/storyboard/ytdlp.js",
    "src/tools/locate.js",
    "src/tools/probe.js",
    "src/tools/shared.js",
    "src/tools/storyboard.js",
    "src/tools/subtitles.js",
    "src/tools/zoom.js"
  ]
}
```
<!-- /upstream-sync:patch-list -->

### 逐文件说明

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `src/storyboard/pipeline.js` | 删 `resolveInput()`（改成只吃本地路径）、删上游 ASR 调用块（改成宿主用 `transcriptSegments` 递进来）、删 `asrLife` / `scheduleStop` / `keepAlive`、删 `willTranscribe()`、术语表改从 `terms` 选项拿、站点字幕改用 `sourceUrl` + `fetchOptions.ytdlp`、纯工具函数改从 `./transcript-file.js` import | vendor 不做取数、不跑 ASR、不起停宿主进程 |
| `src/storyboard/ocr.js` | 删 `ocrPython()` / `runBridge()` / `OCR_BRIDGE` / `~/.dsh/video.json` 配置读取；新增 `setOcrBackend()` / `getOcrBackend()`；`detectSubtitleBand()` / `readBand()` 改为转发给注入的后端 | 本地 rapidocr 桥接不需要了，OCR 走外部服务 |
| `src/storyboard/ocr-subs.js` | 删 `ocrPython()` 调用与 `python` 参数；没注册后端时返回 `skipped / no-ocr-backend` | 同上 |
| `src/storyboard/subtitle-strip.js` | 同上；没后端时字幕带退回 `DEFAULT_BAND`（`default-bottom`）—— 检测本来就是可选的 | 同上 |
| `src/storyboard/subtitles.js` | 删 `discoverYtdlp` / `configuredPort` / `writeBrowserCookiesFile`；yt-dlp 改为宿主用 `ytdlp: {bin, prefix?}` 参数递进来；删 `~/.dsh/video.json` 的 cookie 兜底（cookies 必须显式传）；`parseSrt` 改从 `./transcript-file.js` import | 不自己找 yt-dlp、不自己翻浏览器；凭据由宿主管 |
| `src/storyboard/format.js` | 删 `import { canTranscribe, resolveAsrConfig }` 与那段「没配 key 所以转写关闭」的提示 | vendor 不该替宿主断言 ASR 后端状态 |
| `src/storyboard/transcript-file.js` | **接收**从 `asr.js` 搬来的 7 个纯函数（逐字未改）；加 `execFile` / `promisify` / `DEFAULT_FFMPEG` import | `asr.js` 整体删除后，这些纯函数得有地方住 |

### 宿主要接的两个新接口

1. **OCR 后端注入**（对应 `ocr.js`）
   ```js
   import { setOcrBackend } from './vendor/dsh-video-storyboard/src/storyboard/ocr.js';
   setOcrBackend({
     detectBand: async ({ frames }) => ({ ok: true, band: [0.82, 0.98], detected: true }),
     readBand:  async ({ images }) => ({ ok: true, items: [{ text: '…', conf: 0.9 }] }),
   });
   ```
   不注册 → OCR 相关路径自动 `skipped`，不影响出图。

2. **ASR 结果递进 pipeline**
   ```js
   runStoryboard({
     input: '/path/to/local.mp4',
     transcriptSegments: [{ from: 0, to: 2.5, text: '…' }],  // 宿主自己的 ASR provider 出的
     transcriptModel: 'elevenlabs',
     transcriptSeconds: 12.4,
     terms: { '彗差': '像差' },
   });
   ```
   pipeline 会把它标成 `source:'asr'`，下游（清单措辞、硬字幕校正）与上游口径一致。

---

## 5. 怎么跟上游对比

### 5.1 看某个文件被我们改了什么

```bash
UP=~/.hermes/cache/scratch/dsh-video-storyboard
V=vendor/dsh-video-storyboard

diff -u "$UP/src/storyboard/pipeline.js" "$V/src/storyboard/pipeline.js"
```

整棵树扫一遍：

```bash
diff -ru "$UP/src" "$V/src"
```

（`LICENSE` / `NOTICE` / `CREDITS.md` / `CHANGELOG.md` 应当**零差异** —— 逐字复制的东西不许改。）

### 5.2 看上游有什么新东西 —— `scripts/upstream-sync.mjs`

```bash
# 用本地 clone（离线可跑）
node scripts/upstream-sync.mjs --upstream ~/.hermes/cache/scratch/dsh-video-storyboard

# 用 GitHub URL（会浅克隆到临时目录，需要网络）
node scripts/upstream-sync.mjs --upstream https://github.com/SAOS-3624/dsh-video-storyboard

# 指定别的起点
node scripts/upstream-sync.mjs --upstream <path> --since v0.5.0
```

它会：

1. 打印上游最新 tag 与 commit；
2. 列出 `--since`（缺省 = `UPSTREAM.json` 的 `commit`）以来的新提交；
3. 解析上游 `CHANGELOG.md` 里比当前 vendor 版本新的条目；
4. 把改动文件映射到 vendor 路径，标出**哪些撞上了我们本地改过的文件**；
5. 打印「待吸收清单」markdown 表格（上游 commit / 改动文件 / CHANGELOG 摘要 / 是否本地改过 / 建议动作）。

**它只产出清单，绝不自动合入** —— 不写任何文件、不动 git 索引、不切分支。
「建议动作」一列只会给出这三类提示：

| 建议动作 | 含义 |
|---|---|
| `可直接覆盖（本地无改动）` | vendor 里那份与上游逐字相同，直接用上游版本替换即可 |
| `⚠ 需人工合并（本地有改动）` | 撞上补丁清单，**必须人工看 diff** 后再决定 |
| `⚠ 本地已删除该文件：确认是否需要恢复` | 上游改了这个我们删掉的文件 |
| `不 vendor（上游非源码文件）` | 上游改的是 `test/`、`docs/`、`bin/` 之类，本仓库不拿 |

### 5.3 合入一次上游更新的手工流程

1. 跑 `scripts/upstream-sync.mjs`，拿到待吸收清单。
2. 对清单里「需人工合并」的文件，逐个 `diff -u` 上游与 vendor，**手工**把上游的改动搬过来，
   同时保住我们本地的 `Modifications:` 说明（更新它，让它继续准确）。
3. 同步 `vendor/dsh-video-storyboard/UPSTREAM.json` 的 `version` / `tag` / `commit`。
4. 同步 `vendor/dsh-video-storyboard/{LICENSE,NOTICE,CREDITS.md,CHANGELOG.md}`（**逐字覆盖**，不许手改）。
5. 更新本文件 §1 的上游坐标、§3 的删除清单、§4 的补丁清单（含机器可读 JSON 块）。
6. 跑 `npm run check`（`node scripts/check-syntax.mjs`）与 vendor 导入自检。

---

## 6. 快速自检

```bash
# 语法
npm run check

# vendor 全部模块能不能 import
node -e '
const V="./vendor/dsh-video-storyboard/src";
for (const m of ["tool-spec.js","storyboard/index.js","storyboard/pipeline.js","storyboard/plan.js",
  "storyboard/scan.js","storyboard/sheet.js","storyboard/frames.js","storyboard/locate.js",
  "storyboard/subtitles.js","storyboard/transcript-file.js","storyboard/probe.js","storyboard/format.js",
  "storyboard/storage.js","storyboard/cache.js","storyboard/board.js","storyboard/segments.js",
  "storyboard/density.js","storyboard/layout.js","storyboard/cells.js","storyboard/measure.js",
  "storyboard/audio.js","storyboard/binaries.js","storyboard/ocr-subs.js","storyboard/subtitle-strip.js",
  "storyboard/provenance.js","storyboard/media-store.js","storyboard/memory.js","storyboard/flash.js",
  "storyboard/cli-options.js"]) { await import(`${V}/${m}`); }
console.log("all vendor modules import OK");
' --input-type=module
```
