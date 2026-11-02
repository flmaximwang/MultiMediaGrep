// src/media/bookmark/embedder-vtt.js —— 视频/音频书签嵌入器（占位）
//
// 真正实现见 ticket 9z5.37.4：只在源文件旁边写
// `<basename>.mmgrep.bookmark.vtt`，**绝不修改媒体文件本身**
// （cue id = 条目 id，cue 文本 = 标题，end 缺省 = 下一条 start / 媒体时长）。
// 本 ticket 只提供注册位置与失败行为：抛 TOOL_NOT_FOUND，sidecar 不会被写。

import path from 'node:path';

import { ToolError } from '../interface.js';

/** 视频/音频书签的 VTT 目标路径：与 sidecar 同目录、同样带完整文件名 */
export function bookmarkVttPathFor(filePath) {
  const resolved = path.resolve(String(filePath));
  return path.join(path.dirname(resolved), `${path.basename(resolved)}.mmgrep.bookmark.vtt`);
}

export const vttBookmarkEmbedder = Object.freeze({
  media: 'video',

  /** 嵌入目标：源文件旁边的 sidecar VTT（不改媒体文件） */
  embedTarget(filePath) {
    return bookmarkVttPathFor(filePath);
  },

  async embed() {
    throw new ToolError(
      'TOOL_NOT_FOUND',
      'writing the bookmark VTT is not implemented yet (ticket 9z5.37.4)',
      'The sidecar was not written, because media_bookmark only writes it after embedding succeeds. 9z5.37.4 implements this embedder (sidecar .mmgrep.bookmark.vtt).',
    );
  },
});
