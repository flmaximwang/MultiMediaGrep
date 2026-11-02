# MultiMediaGrep v0.3.0

给 agent 的**本地媒体感知工具**：一个 MCP server（默认 stdio，可选 Streamable HTTP），把本地已有的
视频 / 录音 / 文档变成 agent 的多模态模型能直接消化的材料——**图**（分镜宫格、特写裁切、页面缩略图）
＋**按时间/页码对齐的文本**。server 自己不调 LLM，理解交给 agent。

0.3.0 把「读」补成「读 + 写」：新增 `media_bookmark`（目录 / 章节 / 书签）与 `media_annotate`
（批注 / 注释 / 评论），写进文件本身，并在源文件旁维护 sidecar JSON 作为唯一真相源。

- 仓库：<https://github.com/flmaximwang/MultiMediaGrep>
- 许可：Apache-2.0（部分模块改写自 dsh-video-storyboard v0.5.9，署名见 `NOTICE` / `CREDITS.md`）
- 契约：[`docs/mcp-contract.md`](mcp-contract.md)（§15 / §16 是两个写工具的完整契约）｜
  安装运维：[`docs/install.md`](install.md)

> **0.3.0 没有破坏性的 API 变更**：工具名、参数、环境变量、传输方式全部不变，四个原有只读工具的
> 调用方式不变。需要留意的只有**目录输出格式**：0.2.0 的 `- title — page N` 行在 0.3.0 统一成
> `b1  p.1  title` / `b1  00:00  title`，outline 条目也带上了 `id`（见下文「读侧」与「升级清单」）。

## 装

```bash
# 从 GitHub 装（npm 尚未发布）
npx -y github:flmaximwang/MultiMediaGrep

# 或装 release 里的运行时包
npm i -y https://github.com/flmaximwang/MultiMediaGrep/releases/download/v0.3.0/multimediagrep-mcp-0.3.0.tgz
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

环境要求：Node ≥ 20、`ffmpeg` + `ffprobe` 在 PATH 上；读 PDF 另需 `poppler` / `mutool` / `gs` 任意一个；
读 PDF 书签另需 `qpdf`（没装时 probe 会明说读不了，不会静默省略）；**写 PDF 的目录 / 批注、读 PDF
批注另需 `mutool`（mupdf-tools ≥ 1.28）**——缺了写 PDF 会返回 `TOOL_NOT_FOUND` 并给出安装命令。

## 六个工具

| 工具 | 干什么 | 会改文件？ | 图片开销 |
|---|---|---|---|
| `media_probe` | 类型、时长/页数、轨道、文字层是否可靠、能否 ASR/OCR、唯一一份目录（sidecar → 文件自带 → 无）与批注条数 | 否 | 0 |
| `media_overview` | 视频出分镜宫格 + 时间对齐文本；录音出带时间轴转写；文档出页图 + 每页文字。`images: 0` 为纯文本；`view` 控制目录；`ocr: "force"` 强制重识别；批注挂在页 / 时间段旁 | 否 | 0–4 张 |
| `media_zoom` | 视频某时刻的单帧 / 文档某页，可裁切，用于读画面上的字 | 否 | 1 张（~1900 token） |
| `media_locate` | 一句文本 → 视频/录音里的时间戳、文档里的页码 + 命中次数 + 片段；也会搜批注 note | 否 | 0（`includeFrame` 才 +1） |
| `media_bookmark` | 增删改目录 / 书签：PDF 原地改 outline；视频/录音写 `.mmgrep.bookmark.vtt`；所有类型写 `.mmgrep.bookmark.json` | **是** | 0 |
| `media_annotate` | 增删改批注：PDF 原地写批注对象；视频/录音写 `.mmgrep.annotation.vtt`；所有类型写 `.mmgrep.annotation.json` | **是** | 0 |

只读工具**从不**创建或修改 sidecar；写工具只碰 `*.mmgrep.*` 文件（外加 PDF 原地修改），不会把
sidecar 写进缓存目录，也不会碰你的其他文件。

## 写：media_bookmark

- **参数**：`path`，以及 `add` / `remove` / `update` 至少一个。一次调用可混用三种操作，依次应用
  **remove → update → add**；全有或全无：有任何问题就什么都不写，并一次列出所有错误。
- **条目**（按媒体类型）：
  - PDF：`title`（必填，非空）、`page`（必填，1-based **物理页**，知道页数时校验上界）、`level`
    （可选，≥1 的整数，默认 1）。
  - 视频 / 录音：`title`、`start`（秒，必填，≥0，知道时长时 < 时长）、`end`（可选，> start，≤ 时长）。
  - 图片：只有 `title`。
- **id**：`b1…bN`。首次写入（还没有 sidecar）时先把文件自带的目录导入成 b1…bN，再应用本次操作；
  之后 sidecar 是唯一真相源。`update` 不改 id；新增 id 取操作前的 max+1，同一次调用内递增，
  **永不复用**。
- **sidecar**：`<file>.mmgrep.bookmark.json`，结构
  `{"version": 1, "media": "pdf|video|audio|image", "entries": [...]}`；条目按位置排序
  （PDF 按页、视频/录音按 start、图片保持写入顺序）。
- **嵌入**：PDF 原地重写 outline（不出副本）；视频/录音**从不修改**，只写
  `<file>.mmgrep.bookmark.vtt`（WEBVTT，cue id = b1…，cue 文本 = 标题，缺省 end = 下一条 start /
  媒体时长）；图片只有 sidecar。
- **结果**：完整目录（与读侧同一格式）+ sidecar 路径 + 嵌入目标 + 每一项检查结果；
  `structuredContent` 另含 `created` / `imported` / `applied` / `checks` / `outline`。

## 写：media_annotate

- **参数**：`path`、`add` / `remove` / `update` 至少一个，以及可选的 `author`。
- **条目**（按媒体类型）：
  - PDF：`page`（1-based 物理页）+ `type`（`"text"` 便签 / `"square"` 矩形；新建只支持这两种）+
    可选 `rect`（`{x,y,width,height}`，0..1 比例、左上原点，与 `media_zoom` 的 `crop` 同一空间；
    `square` 必须给 rect，`text` 可省略——省略时写进页面左上角留白并逐条错开）+ `note`
    （纯文本，1..4000 字符）。
  - 视频 / 录音：`start` + 可选 `end`（缺省 = start + 5 秒，截到媒体时长）+ `note`。没有页面、
    rect 或 type。
  - 图片：可选 `rect` + `note`，只有 sidecar。
- **id / 导入**：`n1…nN`。首次写入导入 PDF 中全部注释类批注（Text、FreeText、Square、Circle、Line、
  Polygon、PolyLine、Highlight、Underline、Squiggly、StrikeOut、Stamp、Caret、Ink），按页 / 位置排序，
  保留原始几何与原作者；Link、表单 Widget、Popup 从不导入、从不修改。之后 sidecar 是唯一真相源，
  每次写入整体替换注释类批注为 sidecar 内容；未改动的条目保留原对象与外观流，只重建改动过的条目。
  其他类型（如 highlight / ink）不能新建，但导入后可以改 note 或删除。
- **author**：每次调用解析一次——`author` 参数 → MCP `initialize` 的 `clientInfo.name` →
  `"MultiMediaGrep"`；不使用模型名、不读环境变量。导入的批注保留原作者，`update` 不改作者。
- **sidecar**：`<file>.mmgrep.annotation.json`；结构同 bookmark，id 前缀 `n`。
- **嵌入**：PDF 原地写真正的批注对象（页面正文不重写）；视频/录音只写
  `<file>.mmgrep.annotation.vtt`（cue id = n1…，cue 正文 = note，多行保留）；图片只有 sidecar。

## 读侧：一份目录 + 范围批注

`media_probe`、`media_overview`（`view: "outline"` / `"auto"`）和 `media_locate` 只展示**一份**目录，
来源按优先级取第一个可用的，不合并、不去重：

1. **bookmark sidecar**（存在且可读时永远优先）；
2. 文件自带目录：PDF 书签 / 视频、录音的容器章节；
3. 文档 heading 生成（**仅 media_overview**，请求范围里 ≥5 个 heading 时）。

行格式处处一致：

```text
outline: sidecar — 3 entries — use the outline to pick a range
b1  p.1  Introduction
  b2  p.2  Methods
b3  p.9  Results
full detail: /abs/path/paper.pdf.mmgrep.bookmark.json
```

视频 / 录音是 `b1  00:12:34  Opening`。没有 sidecar 时，目录 id 用共享的 derive 助手按文件自带目录的
顺序推导，**与 media_bookmark 首次导入完全一致**。sidecar 损坏时回退到文件自带目录，并在文本里给出
`note: ... could not be read ... — showing ... instead.`（不抛错）；sidecar 存在但条目为空时以 sidecar
为准，不回退。`structuredContent.outline` 始终带完整条目、`source`、`media`、`total`，有 sidecar 时
还有 `sidecarPath` / `sidecarError`；media_overview 的 `manifest.json` 写入同一份目录。

批注同理：probe 报条数与 sidecar 路径；overview 在请求范围旁输出
`annotations (N of M in ..., sidecar):` + `n3 (p.12): note` 行，sidecar 末行同样是
`full detail: <sidecar path>`；locate 在 note 里搜关键词，命中明确标成批注（`kind: "annotation"`），
不会和媒体内容混在一起。

## 检查与安全

- 写入顺序：**先嵌入并跑完全部检查，再原子写 sidecar**；sidecar 写完还会回读比对。任何一步失败：
  原文件不动（临时文件被删除）、sidecar 不写。
- PDF（outline）：`writer-exit`（mutool 退出 0 且临时文件非空）→ `qpdf-check`（qpdf `--check` 退出 0
  或仅有警告；没装 qpdf 时用 mutool 重新打开）→ `page-text`（页数、首/中/末页文本与原文件一致）→
  `outline-readback`（回读目录与 sidecar 一致）。
- PDF（批注）：`writer-exit` → `qpdf-check` → `page-text` → `annotation-readback`（逐条比对，位置留小
  容差）→ `other-annotations`（Link / Widget / Popup 写入前后完全一致）。
- 视频 / 录音：`vtt-readback`（用自家解析器读回比对）+ `media-unchanged`（源媒体字节不变），bookmark
  另在必要时检查 `vtt-duration`，annotation 另检查 `vtt-end-default`。
- 加密或签名 PDF 拒绝原地写（`UNSUPPORTED_MEDIA_TYPE`，提示先解密 / 去签名）；缺 `mutool` 返回
  `TOOL_NOT_FOUND` + 安装提示。
- 不做回滚 / 历史 / 外部改动检测：sidecar 一旦存在就是唯一真相源，用户在 Acrobat 等处改的目录 /
  批注会在下一次写入时被覆盖。**请在动原件前 `git commit`（或备份）**。

## 新功能

- 第 5 / 第 6 个 MCP 工具：`media_bookmark` / `media_annotate`（`destructiveHint: true`）。
- PDF 原地写 outline 与真正的批注对象；视频 / 录音只写 VTT，从不改媒体文件；图片只有 sidecar。
- 每个支持的类型都有 `<file>.mmgrep.*.json` sidecar（JSON、UTF-8、版本 1）。
- 读侧统一目录：sidecar → 文件自带 → heading 生成；统一 `b1  p.1  title` / `b1  00:12:34  title`
  格式与稳定 id；`full detail:` 末行指向 sidecar。
- 读侧批注：probe 条数 + sidecar 路径；overview 按页 / 时间段挂批注；locate 搜 note。
- 写工具的结果自带完整目录 / 批注、`created` / `imported` / `applied`、嵌入目标与逐项检查结果。
- server instructions 与工具描述同步更新，文档契约新增 §15（bookmark）与 §16（annotate）。

## 已知限制

- 批注新建只支持 PDF 的 `text` 与 `square`；highlight / underline / ink 等需要字符坐标，留到后续版本
  （导入与往返已支持）。
- 批注是 PDF 专属能力；图片 / 视频 / 录音只有 sidecar（+ VTT），没有原生批注面。
- 图片的书签 / 批注**只有 sidecar**，不会在图片文件里嵌入任何东西。
- 没有并发合并：两个写调用同时改同一个文件时，后写者覆盖先写者（sidecar 是最后写入者胜出）。
- 没有服务器状态 / 数据库 / 版本历史；跨机器协作请用 git 管理 sidecar 与 PDF。
- Office 文档（docx / pptx / xlsx …）仍不支持；先 `soffice --headless --convert-to pdf`。
- 写 PDF 需要较新的 `mutool`（mupdf-tools ≥ 1.28）；旧版本可能在 `writer-exit` 检查处失败，并明确
  报告缺少的能力。
- HTTP 模式单次请求上限 120 s（写 PDF 也受此限制；大文件建议 stdio）。

## 升级清单

- [ ] 升级到 0.3.0 不需要改工具调用或环境变量；四个只读工具的参数与返回主干不变。
- [ ] 如果会写 PDF（bookmark / annotate）或读 PDF 批注：安装 `mupdf-tools`，确认 `mutool` 在 `PATH` 上
      （`brew install mupdf-tools` / `apt install mupdf-tools`）。
- [ ] 如果解析 probe / overview 的**目录文本**：把 0.2.0 的 `- title — page N` 改成 `b1  p.1  title`
      （视频/音频 `b1  00:12:34  title`），header 变成 `outline: PDF outline — N entries ...` /
      `outline: container chapters — N chapters ...` / `outline: sidecar — N entries ...`。
- [ ] 如果解析 `structuredContent.outline.entries`：条目现在带 `id`；PDF 条目是
      `{id, title, page, level, label?}`，视频/音频条目是 `{id, title, start, end?}`（秒），不再有
      `startMs` / `endMs` / `startSec` / `endSec`；`source` 新增 `sidecar` 与 `headings`，并新增
      `media` / `generated` / `sidecarPath` / `sidecarError`。
- [ ] 如果解析 probe / overview 文本：新增 `annotations: N (...)` / `annotations (... ):` 块与
      `full detail: <sidecar path>` 行，按行解析的脚本要能忽略未知行。
- [ ] 在动真实文件前先 `git commit`（或备份）；先在副本上试一次 `media_bookmark` / `media_annotate`。
- [ ] 跑一遍 `npm test` 与 `node scripts/check-syntax.mjs`，再在宿主里做一次
      probe → overview → zoom → locate → bookmark → annotate 的冒烟。

## 验证

- `npm test`：681 项通过，0 失败（baseline 681）。
- `node scripts/check-syntax.mjs`：全量语法检查通过（`src/`、`test/`、`scripts/`、`fixtures/`）。
- 工具描述 / server instructions 与契约 §4.1 / §5.1 / §6.1 / §7.1 / §15.1 / §16.1 / §11.2 **逐字一致**。
- 示例配置 [`examples/mcp-config.json`](../examples/mcp-config.json) 与
  [`examples/mcp-config-http.json`](../examples/mcp-config-http.json) 可被 `JSON.parse` 解析，且只含当前变量 / 请求头。
