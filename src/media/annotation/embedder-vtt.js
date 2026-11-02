// src/media/annotation/embedder-vtt.js —— 视频/录音批注嵌入器（占位）
//
// 本文件是 9z5.38.1 的**接缝**：9z5.38.3 只填这个文件，不改引擎 / sidecar / 工具层。
// 契约（9z5.38 父票 + 9z5.38.3）：
//   - 从 sidecar 生成 <basename>.mmgrep.annotation.vtt，**从不修改媒体文件**；
//   - cue id = 条目 id，cue 文本 = note（多行保留；空行替换掉，以免提前结束 cue）；
//   - 允许时间重叠；end 缺省 = start + 5 s（截到时长）；
//   - 复用 9z5.37.4 的 VTT 转义与写入（src/media/bookmark/embedder-vtt.js），
//     原子写 + 回读比对。
//
// 现在唯一的行为是抛 TOOL_NOT_FOUND：media_annotate 必须什么都不写。

import { ToolError } from '../interface.js';
import { sidecarPathFor } from '../bookmark/sidecar.js';

/** 视频/录音批注 VTT 的后缀（写在源文件同目录） */
export const ANNOTATION_VTT_SUFFIX = '.mmgrep.annotation.vtt';

/** <dir>/<basename>.mmgrep.annotation.vtt（9z5.38.3 写的就是这个路径） */
export function annotationVttPathFor(filePath) {
  return sidecarPathFor(filePath, ANNOTATION_VTT_SUFFIX);
}

/**
 * 视频/录音批注嵌入器接口（与 bookmark 嵌入器一致）：
 *   { media: 'video'|'audio', embedTarget(filePath) => string,
 *     async embed({ filePath, media, entries, sidecarPath, signal }) => { target, checks[] } }
 */
export const vttAnnotationEmbedder = Object.freeze({
  media: 'video',

  embedTarget(filePath) {
    return annotationVttPathFor(filePath);
  },

  async embed() {
    throw new ToolError(
      'TOOL_NOT_FOUND',
      'the video/audio annotation VTT writer is not implemented yet (beads ticket MultiMediaGrep-9z5.38.3), '
        + 'so media_annotate cannot write annotation VTT cues in this version. Nothing was written: '
        + 'the media file was not modified, no VTT was created and no sidecar was created.',
      'Wait for ticket MultiMediaGrep-9z5.38.3, or pass annotationEmbedders: null to write the sidecar only. '
        + 'The media file and its sidecar were left untouched.',
    );
  },
});
