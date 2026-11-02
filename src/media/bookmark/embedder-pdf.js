// src/media/bookmark/embedder-pdf.js —— PDF 书签嵌入器（占位）
//
// 真正实现见 ticket 9z5.37.2：原地重写 PDF 的 /Outlines（不生成副本），
// 临时文件 → 校验（writer 退出码、qpdf --check、页数/首中末页文本不变、
// 回读目录与 sidecar 一致）→ rename；拒绝签名/加密 PDF。
// 本 ticket 只提供注册位置与失败行为：抛 TOOL_NOT_FOUND，sidecar 不会被写。

import { ToolError } from '../interface.js';

export const pdfBookmarkEmbedder = Object.freeze({
  media: 'pdf',

  /** 嵌入目标：PDF 就是源文件本身（原地修改） */
  embedTarget(filePath) {
    return filePath;
  },

  async embed() {
    throw new ToolError(
      'TOOL_NOT_FOUND',
      'writing the PDF outline in place is not implemented yet (ticket 9z5.37.2)',
      'The sidecar was not written, because media_bookmark only writes it after embedding succeeds. 9z5.37.2 implements this embedder (in-place /Outlines rewrite).',
    );
  },
});
