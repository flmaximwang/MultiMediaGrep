// src/media/bookmark/embedders.js —— 书签嵌入器注册表（按媒体类型）
//
// ============================ 嵌入器接口 ============================
// 嵌入器负责把当前条目写进「媒体自己的目录」，这样人和别的工具不读 sidecar
// 也能看到书签。sidecar 仍是唯一真相源；嵌入只是投影。
//
//   {
//     media: 'pdf' | 'video' | 'audio' | 'image',   // 主要针对的媒体类型
//     embedTarget(filePath) → string | null,         // 预览用：嵌入会写到哪
//     async embed({ filePath, media, entries, sidecarPath, signal })
//        → { target: string | null, checks: Array<{ name, ok, detail? }> }
//   }
//
// 契约（引擎保证的顺序与失败语义）：
//   1. 引擎先完成全部校验与操作合并，再调用 embed；**嵌入成功后才写 sidecar**；
//   2. embed 可以按自己的方式写目标（例如 PDF 原地重写：临时文件 → 校验 → rename），
//      但必须自己保证原子性：失败时目标文件保持原样、不留下临时文件；
//   3. 失败必须 throw（ToolError 最佳，引擎会把错误原样上抛）；
//      若 embed 正常返回但 checks 里有 ok !== true 的项，引擎视为嵌入失败，
//      同样不写 sidecar，并把失败的检查项报给调用方；
//   4. signal 是 AbortSignal：长操作应定期检查并在取消时清理临时文件后抛 AbortError；
//   5. 返回的 target 用于结果文本（PDF = 源文件路径；VTT = sidecar .vtt 路径）。
//
// 注册表按**书签媒体类型**（pdf / video / audio / image）索引。某个类型没有
// 注册嵌入器 = 该类型只写 sidecar（图片就是这种情况；不写任何多余文件）。
// 9z5.38.1（media_annotate）可以传入自己的注册表复用同一引擎。
// ===================================================================

import { pdfBookmarkEmbedder } from './embedder-pdf.js';
import { vttBookmarkEmbedder } from './embedder-vtt.js';

/** 默认书签嵌入器：PDF → 原地重写目录；视频/音频 → sidecar VTT；图片 → 无 */
export const defaultBookmarkEmbedders = Object.freeze({
  pdf: pdfBookmarkEmbedder,
  video: vttBookmarkEmbedder,
  audio: vttBookmarkEmbedder,
});

/**
 * 取某媒体类型的嵌入器；没有注册返回 null（= 只写 sidecar）。
 *
 * @param {string} media
 * @param {Record<string, object>|null} registry null = 明确不要嵌入
 */
export function embedderFor(media, registry = defaultBookmarkEmbedders) {
  if (!registry) return null;
  const embedder = registry[media];
  return embedder ?? null;
}

/**
 * 校验注册表结构（工具层/测试注入时用，尽早给出可读错误）。
 * @param {Record<string, object>|null} registry
 */
export function assertEmbedderRegistry(registry) {
  if (registry === null || registry === undefined) return;
  if (typeof registry !== 'object' || Array.isArray(registry)) {
    throw new Error('bookmarkEmbedders must be an object keyed by media type');
  }
  for (const [media, embedder] of Object.entries(registry)) {
    if (!embedder || typeof embedder.embed !== 'function') {
      throw new Error(`bookmarkEmbedders["${media}"] must be an object with an embed() function`);
    }
  }
}
