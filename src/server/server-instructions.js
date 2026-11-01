// src/server/server-instructions.js —— MCP `instructions` 字段的最终文本。
//
// 出处：docs/mcp-contract.md §11.2「server instructions（可直接粘贴进 MCP server 的
// `instructions` 字段）」。**逐字复制，不要改写**：这一段是给 agent 的用法契约，
// 改动它等于改动契约本身。

export const SERVER_INSTRUCTIONS = `MultiMediaGrep gives you eyes and ears over LOCAL media files: video, audio recordings and
documents. It never downloads anything and never calls an LLM — you always pass a local
absolute path, and it prepares images and text for your own multimodal model to look at.

READING ORDER
1. media_probe first — cheap, no image tokens. Gives duration / page count / tracks and
   whether transcription (ASR) and OCR are available for this file. For audio it also gives a
   health check (level, speech ratio): a recording with no effective speech yields an EMPTY
   transcript by design.
2. media_overview — the main read. Video: numbered storyboard grids plus a time-aligned text
   index. Audio: a timestamped transcript. Document: page thumbnails plus page text.
   The full text of the requested range is written to disk, and the result text ends with a
   "full text: /abs/path/content.md ..." line. That absolute path is what you read
   (segments.jsonl and manifest.json sit in the same directory): read those files section by
   section and summarise them in chunks yourself — do not re-call the tool just to get more
   inline text. The inline list is a preview: complete when the range fits, otherwise sampled
   from complete units, with a "preview: sampled ..." line that names the units inlined and the
   pages/ranges not represented.
3. media_zoom — only for parts that matter. One frame of a video (at, or a start/end window)
   or one page of a document, optionally cropped.
4. media_locate — "where was X said" (timestamp) or "on which page" (page number). Text only
   by default; includeFrame adds one picture at the best match.

TEXT SOURCE ORDER — subtitles first, ASR only as a fallback
1. a subtitle you select explicitly (subtitle: a file path, a track index, or a language code),
2. the subtitle track embedded in the container,
3. a subtitle file with the same base name in the same directory (a.srt next to a.mp4),
4. ASR, and only when none of the above exists.
Every segment carries a source tag. "subtitle" is the author's own words — safe to quote.
"asr" is machine transcription: names, numbers and jargon are often wrong, so NEVER quote an
ASR segment as the speaker's exact words and never present it as a verbatim quotation.
"ocr" is text read off a rendered page — check names and numbers against the page image.
"visual" means there is no text at all, only the picture.

READING PICTURES
The storyboard grid is for FINDING things, not reading them: a cell is only a few hundred
pixels wide, so text inside it is unreadable. To read text on screen, zoom — media_zoom on
that moment, then read the cropped single frame.

TOKEN DISCIPLINE
- Long media must be narrowed with start/end (video, audio) or pages (document) before you
  overview it, then paged through with the continuation hint in the result. A sampled preview
  is not the full text — read content.md from disk instead of assuming the preview is complete.
- Prefer more images with fewer cells over one image with many cells: 2 images x 9 legible
  cells beats 1 image x 16 tiny ones at the same token order.
- Zoom only what the overview showed you is worth zooming into.
- A single call returns at most 4 images, at most 16 cells per image and at most 64 cells in
  total; a single image is at most 1600 px on its long edge. Exceeding that is an error with
  a suggested smaller shape, not a silent truncation.

WHEN TEXT IS UNAVAILABLE
If media_probe reports that no ASR provider and no OCR provider are configured, or that the
recording has no effective speech, you get the visuals only: describe what is on screen and
state plainly that the spoken or written content was not available. Do not invent dialogue,
captions or page text.

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

TOOL DESCRIPTIONS CARRY CHINESE TRIGGER WORDS (探媒体 / 视频 / 录音 / 文档 / 转写 / 字幕 /
关键帧 / 放大 / 提取文字 / 定位 / 截图), so Chinese requests match them too.`;

export default SERVER_INSTRUCTIONS;
