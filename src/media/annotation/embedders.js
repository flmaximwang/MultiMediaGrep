// src/media/annotation/embedders.js —— 批注嵌入器注册表（按媒体类型）
//
// ============================ 嵌入器接口 ============================
// 与 ../bookmark/embedders.js 完全一致（同一个引擎、同一套失败语义），只是条目
// 是批注而不是书签：
//
//   {
//     media: 'pdf' | 'video' | 'audio',              // 批注没有 image 嵌入器
//     embedTarget(filePath) → string | null,         // 预览用：嵌入会写到哪
//     async embed({ filePath, media, entries, sidecarPath, signal })
//        → { target: string | null, checks: Array<{ name, ok, detail? }> }
//   }
//
// 注册表按**批注媒体类型**（pdf / video / audio / image）索引。image 没有嵌入器
// = 图片只写 sidecar（不写任何多余文件）；video/audio 写
// <basename>.mmgrep.annotation.vtt（从不改媒体文件）；pdf 原地写批注对象。
//
// 9z5.38.3 起：video / audio 已经是**真实现**（写
// <basename>.mmgrep.annotation.vtt，从不改媒体文件）；pdf 仍是 9z5.38.2 的
// TOOL_NOT_FOUND 占位（抛错 ⇒ sidecar 也不写）。
//
// 工具层可以注入假嵌入器（测试）或 null（只写 sidecar）。
// ===================================================================

import { pdfAnnotationEmbedder } from './embedder-pdf.js';
import { vttAnnotationEmbedder } from './embedder-vtt.js';

/** 默认批注嵌入器：PDF → 原地写批注对象；视频/音频 → sidecar VTT；图片 → 无 */
export const defaultAnnotationEmbedders = Object.freeze({
  pdf: pdfAnnotationEmbedder,
  video: vttAnnotationEmbedder,
  audio: vttAnnotationEmbedder,
});

/**
 * 取某媒体类型的批注嵌入器；没有注册返回 null（= 只写 sidecar）。
 *
 * @param {string} media
 * @param {Record<string, object>|null} registry null = 明确不要嵌入
 */
export function annotationEmbedderFor(media, registry = defaultAnnotationEmbedders) {
  if (!registry) return null;
  const embedder = registry[media];
  return embedder ?? null;
}

/**
 * 校验注册表结构（工具层/测试注入时用，尽早给出可读错误）。
 * @param {Record<string, object>|null} registry
 */
export function assertAnnotationEmbedderRegistry(registry) {
  if (registry === null || registry === undefined) return;
  if (typeof registry !== 'object' || Array.isArray(registry)) {
    throw new Error('annotationEmbedders must be an object keyed by media type');
  }
  for (const [media, embedder] of Object.entries(registry)) {
    if (!embedder || typeof embedder.embed !== 'function') {
      throw new Error(`annotationEmbedders["${media}"] must be an object with an embed() function`);
    }
  }
}
