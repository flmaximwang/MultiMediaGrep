// src/media/annotation/embedder-pdf.js —— PDF 批注嵌入器（占位）
//
// 本文件是 9z5.38.1 的**接缝**：9z5.38.2 只填这个文件，不改引擎 / sidecar / 工具层。
// 契约（9z5.38 父票 + 9z5.38.2）：
//   - 原地把 sidecar 里的注释类批注写回 PDF（Text / Square 新建；其余类型往返）；
//   - 页面内容、Link / Widget / Popup 与未改动条目保持原样；
//   - 先写临时文件 → 校验（回读批注 + 首/中/末页文本 + qpdf/mutool 重开）→ rename；
//   - 失败时原文件 hash 不变、无临时文件残留；拒绝签名 / 加密 PDF。
//
// 现在唯一的行为是抛 TOOL_NOT_FOUND：media_annotate 必须什么都不写
// （引擎保证：嵌入失败时 sidecar 不写、临时文件清掉）。

import { resolve } from 'node:path';
import { ToolError } from '../interface.js';

/** 嵌入目标就是 PDF 自身（原地写）；读取侧 / 结果文本用它展示 embed target */
export const PDF_ANNOTATION_EMBED_TARGET = 'in-place';

/**
 * PDF 批注嵌入器接口（与 bookmark 嵌入器一致）：
 *   { media: 'pdf', embedTarget(filePath) => string|null,
 *     async embed({ filePath, media, entries, sidecarPath, signal }) => { target, checks[] } }
 */
export const pdfAnnotationEmbedder = Object.freeze({
  media: 'pdf',

  embedTarget(filePath) {
    return resolve(String(filePath));
  },

  async embed() {
    throw new ToolError(
      'TOOL_NOT_FOUND',
      'the PDF annotation writer is not implemented yet (beads ticket MultiMediaGrep-9z5.38.2), '
        + 'so media_annotate cannot write PDF annotation objects in this version. Nothing was written: '
        + 'the PDF was not modified and no sidecar was created.',
      'Wait for ticket MultiMediaGrep-9z5.38.2, or pass annotationEmbedders: null to write the sidecar only. '
        + 'The PDF and its sidecar were left untouched.',
    );
  },
});
