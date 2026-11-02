// src/server/server-instructions.js —— MCP `instructions` 字段的最终文本。
//
// 出处：docs/mcp-contract.md §11.2「server instructions（可直接粘贴进 MCP server 的
// `instructions` 字段）」。**逐字复制，不要改写**：这一段是给 agent 的用法契约，
// 改动它等于改动契约本身。

export const SERVER_INSTRUCTIONS = `MultiMediaGrep gives you eyes and ears over LOCAL media files: video, audio recordings and
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
关键帧 / 放大 / 提取文字 / 定位 / 截图), so Chinese requests match them too.`;

export default SERVER_INSTRUCTIONS;
