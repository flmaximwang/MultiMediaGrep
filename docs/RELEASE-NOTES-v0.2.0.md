# MultiMediaGrep v0.2.0

给 agent 的**本地媒体感知工具**：一个 MCP server（默认 stdio，可选 Streamable HTTP），把本地已有的
视频 / 录音 / 文档变成 agent 的多模态模型能直接消化的材料——**图**（分镜宫格、特写裁切、页面缩略图）
＋**按时间/页码对齐的文本**。server 自己不调 LLM，理解交给 agent。

- 仓库：<https://github.com/flmaximwang/MultiMediaGrep>
- 许可：Apache-2.0（部分模块改写自 dsh-video-storyboard v0.5.9，署名见 `NOTICE` / `CREDITS.md`）
- 契约：[`docs/mcp-contract.md`](mcp-contract.md)｜安装运维：[`docs/install.md`](install.md)

> **0.2.0 有破坏性变更。** 升级前先读下面的「破坏性变更与迁移」：环境变量、`source` / `origin`
  枚举、文档 `media_locate` 的返回字段、overview 的 header 属性都变了。
> 只做文档/配置变更的话，按「升级清单」逐条替换即可。

## 装

```bash
# 从 GitHub 装（npm 尚未发布）
npx -y github:flmaximwang/MultiMediaGrep

# 或装 release 里的运行时包
npm i -y https://github.com/flmaximwang/MultiMediaGrep/releases/download/v0.2.0/multimediagrep-mcp-0.2.0.tgz
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

环境要求：Node ≥ 20、`ffmpeg` + `ffprobe` 在 PATH 上；读 PDF 另需 `poppler` / `mutool` / `gs`
任意一个；读 PDF 书签另需 `qpdf`（没装时 probe 会明说读不了，不会静默省略）。

## 四个工具

| 工具 | 干什么 | 图片开销 |
|---|---|---|
| `media_probe` | 类型、时长/页数、轨道、文字层是否可靠、能否 ASR/OCR、文件自带目录（PDF 书签 / 章节） | 0 |
| `media_overview` | 视频出分镜宫格 + 时间对齐文本；录音出带时间轴转写；文档出页图 + 每页文字。`images: 0` 为纯文本；`view` 控制目录；`ocr: "force"` 强制重识别 | 0–4 张 |
| `media_zoom` | 视频某时刻的单帧 / 文档某页，可裁切，用于读画面上的字 | 1 张（~1900 token） |
| `media_locate` | 一句文本 → 视频/录音里的时间戳、文档里的页码 + 命中次数 + 片段 | 0（`includeFrame` 才 +1） |

## 破坏性变更与迁移

### 1. 环境变量：文档 provider 改成 OCR / typeset 两个角色

0.1.0 的单个文档解析 provider 被拆成两个角色，旧变量**全部删除**、不再读取：

| 0.1.0（已删除） | 0.2.0 替代 |
|---|---|
| `MMGREP_DOC_PROVIDER` | `MMGREP_OCR_PROVIDER`（只处理**没有文字层**的页，默认 `none`）+ `MMGREP_TYPESET_PROVIDER`（只处理**有文字层**的页，默认 `builtin`） |
| `MMGREP_DOC_API_KEY` | `MMGREP_MINERU_API_KEY`（两个角色共用） |
| `MMGREP_DOC_BASE_URL` | `MMGREP_MINERU_BASE_URL` |
| `MMGREP_DOC_MODEL` | `MMGREP_MINERU_MODEL` |

- 默认行为变了：不配任何变量时，**有文字层的 PDF 仍然能读**（typeset 默认本地 `builtin`），
  只有扫描页 / 图片需要 OCR（默认 `none`，给页图不编文字）。
- `MMGREP_DOC_*` 设置在环境里不会生效，启动时 stderr 会警告并指出替代变量名。
- HTTP 每请求头同步替换：`x-mmgrep-ocr-provider` / `x-mmgrep-typeset-provider` 取代
  `x-mmgrep-doc-provider`；`x-mmgrep-mineru-*` 取代 `x-mmgrep-doc-api-key` 等。
  旧头不再识别。
- 新增 `MMGREP_TYPESET_SKIP_SIMPLE`（默认 `true`）：外部 typeset provider 只收双栏 / 复杂页，
  简单页交给本地 builtin，省调用与排队。完整变量表见 [`docs/install.md` §3.5](install.md)。

### 2. `source` / `origin` 枚举扩展

`source` 新增两个值，`origin` 新增一个值。**所有消费者（含下游蒸馏器）都要处理新枚举**：

| 字段 | 0.1.0 | 0.2.0 |
|---|---|---|
| `source` | `subtitle` / `ocr` / `asr` / `visual` / `none` | 再加 `text`（原生文字层 / 纯文本，**字符精确、可原样引用**）与 `mixed`（仅整份 `transcript`：逐页来源不一致） |
| `origin` | `file` / `embedded` / `asr` / `ocr` / `none` | 再加 `textlayer`（PDF 原生文字层）；`.txt` / `.md` 用 `source="text"` + `origin="file"` |

文档逐页映射（依据 provider 的 `textOrigin`）：`textlayer` → `source="text"`；`ocr` / `unknown` →
`source="ocr"`（不确定时取保守值）；无文字页 → `none`。0.1.0 把所有页一律标成 `ocr`，
所以升级后**看到 `text` 的页不需要再为了核对字符去 zoom**；看到 `ocr` 仍建议核对专名与数字。
`mixed` 只出现在整份 `transcript`，单个 segment / match 上不会出现。

### 3. 文档 `media_locate`：`score` 与整页正文被 `hits` / `snippet` / `fuzzy` 取代

文档的 segment 粒度就是整页，0.1.0 的「命中即回吐整页 + 一个恒为 1.00 的 `score`」既贵又没信息量。
0.2.0 起：

| 0.1.0（文档） | 0.2.0（文档） |
|---|---|
| `matches[].score`（0–1，实际恒为 1.00） | **没有 `score`**；改用 `matches[].hits`（该页命中几次）、`matches[].snippet`（首个命中 ±150 字符）、`matches[].fuzzy`（是否退化成 token 覆盖） |
| `matches[].text` = 整页正文 | **不返回整页正文**；要整页用 `media_overview({ path, pages })` 或 `content.md` |
| 命中多少页就回吐多少页，单次可吐 12 KB+ | 文本输出约 3 KB 上限；放不下的页折成一行 `N more pages match: 3, 9, 14`（不算丢失） |

**视频 / 录音完全不变**：仍是 `score`（0–1）+ 时间戳 + 命中行。文档排序改为
「精确命中优先 → `hits` 降序 → 页码升序」。

### 4. `media_overview` 文档 header：`text="<provider>"` 换成 `source` + 两个角色

0.1.0 的 `<overview ... text="mineru" />` 里那个值其实是 provider id，而原生文字层根本没有 provider，
容易误导。0.2.0 起文档 header 改为：

```
<overview path="/abs/a.pdf" type="document" pages="1-12" source="text" typesetProvider="builtin" />
```

- `source`：整份文件的实际文字来源（`text` / `ocr` / `mixed` / `none`）。
- `ocrProvider` / `typesetProvider`：**本次真正处理过返回页**的角色（没用到就不出现）。
- probe 的文本也同步改版：不再出现「`ocr: unavailable` 却 `transcript source: ocr`」这种自相矛盾；
  改成 `text layer:`（yes / no / unknown）、`ocr provider:`、`typeset provider:`、`transcript source:` 分行。
  解析 probe 文本的脚本要跟着改。

### 5. 文档 provider 契约 v2：`blocks` + `textOrigin` + 角色

自己写文档 provider 的人需要更新（内置的 MinerU / builtin 已适配）：

- 返回值从「每页一段 `text`」升级为「每页 `{ page, textOrigin, blocks, text }`」：
  `blocks` 是结构化的 heading / paragraph / list / table / caption / equation / footnote，
  `textOrigin` 是这一页字符的真正来源（`textlayer` / `ocr` / `unknown`）。
- 角色语义：`ocr` 只处理**没有文字层**的页与 `ocr:"force"` 的页；`typeset` 只处理**有文字层**的页，
  **不得重新识别字符**；无法保证原字符时必须报 `textOrigin="ocr"` / `"unknown"`。
- 失败语义：`media_overview` 的 auto 模式会降级（有文字层的页保留、其余给页图 + 警告）；
  `media_locate` 与 `ocr:"force"` 会报 `PROVIDER_FAILED` / `PROVIDER_NOT_CONFIGURED`。
- 接口与迁移样例见 [`src/providers/doc/README.md`](../src/providers/doc/README.md)。

### 6. 行为修正（会影响解析结果的预期）

- **文字层探测改为采样首页 / 中间页 / 末页**：图片封面 + 数字正文的 PDF 不再被误判成「没有文字层」；
  本机没有文字抽取器时 `hasTextLayer = null`（**判不出来**），不再笼统写成 `false`。
- **文档预览不再静默丢页**：0.1.0 一页超长就整页消失、后面的页也一起消失，文本末尾还宣称「包含每一页」；
  0.2.0 改为分层预览（whole / skim / sampled / outline），超长单元硬截断并标 `…[+N chars]`，
  未覆盖的页写进 `not represented: …`。全文路径固定出现在 text content 末尾。
- **字幕措辞改为中性**：不再承诺「字幕是作者原话、可安全引用」；滚动式字幕的时间重叠 cue 会合并，
  并给出 `rolling/auto-style captions detected …` 警告。

## 新功能

- **内联预览分档 + 全文路径行**：文本预览三档——whole（整体放得下）→ skim（文档：全部 heading + 段首句）→
  sampled（完整单元等距抽样，逐页列出未覆盖范围）；另有 outline 视图（只出目录）。`media_overview` 的 text
  content 末尾固定有 `full text: <content.md 绝对路径> (segments.jsonl, manifest.json in the same directory)`；
  落盘失败时是 `full text: NOT written — <reason>`。
- **`view` 参数（auto / outline / text）**：PDF 书签、视频/录音章节作为目录先给出来；文档没有书签时
  可以从 ≥5 个 heading 生成（标 `outline: generated from headings`，best-effort）；视频/录音没有章节时
  明确说「no chapters」，**不生成**内容（server 不调 LLM）。
- **`ocr: "force"`**：probe 发现文字层可疑（U+FFFD / 私用区 / 孤立单字母 / 符号噪声）时给出提示，
  agent 可要求对请求页重新 OCR；结果标 `(ocr)`、单独缓存，不覆盖 auto / 文字层结果。没配 OCR provider
  时明确报 `PROVIDER_NOT_CONFIGURED`，不静默退回坏文字层。
- **provider 逐页缓存**：键含源文件内容 sha256 + provider + model + `ocrMode` + role；overview 与 locate
  共享，同一范围再次调用只补缺失页。缓存读坏当 miss、写失败只记 debug。
- **builtin typeset（本地、不联网）**：PDF 双栏阅读顺序重排 + 启发式 blocks（标题 / 段落 / 表格），
  让有文字层的页也能出 skim 与目录。启发式结构可能判错，输出里会标 best-effort。
- **`x-mmgrep-max-text-inline-chars` 请求头**：HTTP 客户端可按请求覆盖内联上限（硬上限 `200000`，
  非法值 warn 后回落，不会让请求失败）；stdio 仍只读环境变量。
- **MinerU 适配器 v2**：输出 `blocks` 与逐页 `textOrigin`，支持 OCR `auto` / `force`；typeset 角色
  钉在 `pipeline`（不重识别字符，官方文档 + `src/providers/doc/README.md` §4 有核对记录）。
- **字幕滚动 cue 合并**：大面积时间重叠的 cue 合并成一段，避免同一句话重复。
- **PDF 文字层逐页采样**：probe 的 `textLayer.sampledPages` / `checkedPages` / `textPage` 说明结论是怎么来的。

## 已知限制

- 云端 MinerU 3.4.4 的结果包**没有逐页 `parse_mode` 字段**：provider 只能按 `model_version`、角色与
  `layout.json` 的 `_backend` 推断；推断不出的页标 `textOrigin="unknown"`（下游按 OCR 处理）。
- builtin typeset 的 blocks 是启发式（标题 / 双栏 / 表格），结构可能判错；要更高准确度请配
  `MMGREP_TYPESET_PROVIDER=mineru`。skim 与生成的目录都会标 best-effort。
- Office 文档（docx / pptx / xlsx …）仍不支持，只能先 `soffice --headless --convert-to pdf`。
- 没有本地 ASR / OCR 模型：ASR 与 OCR 都要外部服务；不配时只出画面 / 页图，并明确说明原因。
- HTTP 模式单次请求上限 120 s；MinerU 排队久时请用 stdio，或把 `MMGREP_DOC_TIMEOUT_MS` 调大并注意
  宿主 / 代理的超时。
- 契约里的图片上限（4 张 / 16 格 / 1600 px / 4000 token）仍是按算法推导的，不是某个宿主的实测上限
  （beads `9z5.3` 的宿主实测尚未完成）。
- 真实 MinerU key + 真实论文的端到端验证仍在 beads `9z5.36`；本版发布说明不宣称该验证已完成。

## 升级清单

- [ ] 环境变量：删掉 `MMGREP_DOC_*`；需要 OCR 的扫描件配 `MMGREP_OCR_PROVIDER=mineru` +
      `MMGREP_MINERU_API_KEY`；需要外部排版再配 `MMGREP_TYPESET_PROVIDER=mineru`。
- [ ] HTTP 客户端：把 `x-mmgrep-doc-provider` / `x-mmgrep-doc-api-key` 换成
      `x-mmgrep-ocr-provider` / `x-mmgrep-typeset-provider` / `x-mmgrep-mineru-*`。
- [ ] 消费者：处理 `source` 的新值 `text` / `mixed` 与 `origin` 的新值 `textlayer`。
- [ ] 文档 locate：改读 `hits` / `snippet` / `fuzzy`，不要再依赖 `score` 或 `matches[].text`。
- [ ] 解析 overview / probe 文本的脚本：文档 header 的 `text=` 改成 `source=` + `ocrProvider=` /
      `typesetProvider=`；probe 的 `ocr:` 行改成 `text layer:` / `ocr provider:` / `typeset provider:`。
- [ ] 自写 provider：按契约 v2 返回 `blocks` 与 `textOrigin`（见 `src/providers/doc/README.md`）。
- [ ] 跑一遍 `npm test`（554 项）与 `node scripts/check-syntax.mjs`，再在宿主里做一次
      probe → overview → zoom → locate 的冒烟。

## 验证

- `npm test`：554 项通过，0 失败（baseline 554）。
- `node scripts/check-syntax.mjs`：全量语法检查通过（`src/`、`test/`、`scripts/`、`fixtures/`）。
- 工具描述 / server instructions 与契约 §4.1 / §5.1 / §6.1 / §7.1 / §11.2 **逐字一致**。
- 示例配置 [`examples/mcp-config.json`](../examples/mcp-config.json) 与
  [`examples/mcp-config-http.json`](../examples/mcp-config-http.json) 可被 `JSON.parse` 解析，且只含当前变量 / 请求头。
