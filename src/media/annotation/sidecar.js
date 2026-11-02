// src/media/annotation/sidecar.js —— 批注 sidecar 的读写（薄封装）
//
// 原子写 / 损坏检测 / 临时文件清理都在 ../bookmark/sidecar.js 里（9z5.37.1 的框架），
// 这里只把「批注」的 adapter、后缀与错误文案固定下来，避免每个调用点重复传参：
//   - adapter：ANNOTATION_SIDECAR_ADAPTER（校验 / 规范化 / 排序）
//   - noun / toolName：错误信息说 "annotation sidecar" 与 "media_annotate"
//
// 文件位置：<dir>/<basename>.mmgrep.annotation.json
// 结构：{ version: 1, media, entries: [...] }；media ∈ pdf | video | audio | image。

import {
  canonicalAnnotation,
  sortAnnotations,
  validateStoredAnnotation,
} from './entries.js';
import {
  parseSidecarText,
  readSidecar,
  serializeSidecar,
  sidecarPathFor,
  writeSidecar,
} from '../bookmark/sidecar.js';

/** 批注 sidecar 后缀（写在源文件同目录，不写缓存目录） */
export const ANNOTATION_SIDECAR_SUFFIX = '.mmgrep.annotation.json';

/** <dir>/<basename>.mmgrep.annotation.json */
export function annotationSidecarPathFor(filePath) {
  return sidecarPathFor(filePath, ANNOTATION_SIDECAR_SUFFIX);
}

/** 批注 sidecar 的 adapter（引擎 / 读写函数共用同一份语义） */
export const ANNOTATION_SIDECAR_ADAPTER = Object.freeze({
  validateStored: (raw, options) => validateStoredAnnotation(raw, options),
  canonical: (media, raw) => canonicalAnnotation(media, raw),
  sort: (entries, media) => sortAnnotations(entries, media),
});

const SIDECAR_CONTEXT = Object.freeze({
  adapter: ANNOTATION_SIDECAR_ADAPTER,
  noun: 'annotation',
  toolName: 'media_annotate',
});

/**
 * 读批注 sidecar；不存在返回 {exists:false, entries:[]}，损坏抛 INVALID_ARGUMENT
 * （绝不覆盖）。
 *
 * @param {string} sidecarPath
 * @param {{media: string, idPrefix?: string}} options
 */
export async function readAnnotationSidecar(sidecarPath, { media, idPrefix = 'n' } = {}) {
  return readSidecar(sidecarPath, { media, idPrefix, ...SIDECAR_CONTEXT });
}

/** 解析 sidecar 文本（读侧 / 测试用；不碰文件系统） */
export function parseAnnotationSidecarText(text, { sidecarPath, media, idPrefix = 'n' } = {}) {
  return parseSidecarText(text, { sidecarPath, media, idPrefix, ...SIDECAR_CONTEXT });
}

/** 批注条目 → sidecar JSON 文本（字段顺序固定，末尾换行） */
export function serializeAnnotationSidecar(media, entries) {
  return serializeSidecar(media, entries, { adapter: ANNOTATION_SIDECAR_ADAPTER });
}

/** 原子写批注 sidecar（临时文件 → fsync → rename；失败清理临时文件） */
export async function writeAnnotationSidecar(sidecarPath, media, entries, { signal = null } = {}) {
  return writeSidecar(sidecarPath, media, entries, { signal, adapter: ANNOTATION_SIDECAR_ADAPTER });
}
