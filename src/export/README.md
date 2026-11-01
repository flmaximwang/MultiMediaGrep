# src/export —— 全文落盘

把一次媒体分析（视频/录音/文档）变成下游蒸馏器能直接吃的材料。**纯 Node，零依赖**。

## 产物

写到缓存目录（`MMGREP_CACHE_DIR` 下）的一个条目目录里：

| 文件 | 给谁看 | 内容 |
|---|---|---|
| `content.md` | 人 / 蒸馏器 | 首行是绝对路径，随后元信息列表；段落按 `## mm:ss.mmm – mm:ss.mmm` 分节，文档按 `## Page N` 分节 |
| `segments.jsonl` | 程序 | 一行一个 segment（不是数组），字段见下 |
| `manifest.json` | 程序 | 本次导出的元信息：来源、时间窗、转写来源、图片清单、警告 |
| `document.json` | cangjie-skill | **可选件**：符合 cangjie-skill `SourceDocument Contract v1` 的 SourceDocument |

## segment 模型

```json
{"index":1,"startMs":0,"endMs":4120,"startSec":0,"endSec":4.12,"text":"第一句。",
 "page":null,"speaker":null,"source":"subtitle","origin":"file","contentHash":"sha256:…"}
```

- `source`：`subtitle`（作者字幕，可当原话引用）/ `ocr`（页面 OCR，专名数字需核对）/ `asr`（语音识别，**不可当原话引用**）/ `visual`（只有画面）/ `none`
- `origin`：`file`（外部字幕文件）/ `embedded`（容器内嵌字幕轨）/ `asr` / `ocr` / `none`
- 文档段落 `startMs`/`endMs` 为 `null`，用 `page` 定位。

## API

```js
import { exportAnalysis } from './src/export/index.js';

const result = await exportAnalysis({
  outDir,                       // 缓存条目目录
  source: { path, mediaType, sha256, sizeBytes, modifiedMs, durationMs, durationSec, pageCount },
  mediaType: 'video',           // video | audio | document
  segments: [{ startMs, endMs, text, source, origin, ... }],
  transcript: { source: 'asr', provider: 'elevenlabs', model: 'scribe_v1', language: 'zh' },
  overview: { images: [...], cells: [...], estimatedTokens },
  window: { startMs, endMs },
  language: ['zh-CN'],
});
// → { contentPath, segmentsPath, manifestPath, documentPath, manifest, segments }
```

低层零件：`normalizeSegments`（校验+补齐秒字段）、`renderContentMd`、`renderSegmentsJsonl`、`buildManifest`、`buildCangjieDocument`。

## 约定

- **可复现**：同样的输入 + 同样的 `generatedAtMs`，产出字节相同（`manifest` 里除路径外无抖动）。
- `source_id` = 文件名 sha256 前 12 位 → **文件改名不会变成新来源**；内容变化由 `version_id`（内容哈希）区分。
- 图片类文档：`document.json` 的 `media_type` 映射为 `pdf`（cangjie 枚举里没有 `image`），真实类型记在 `manifest.source.mediaType`。
