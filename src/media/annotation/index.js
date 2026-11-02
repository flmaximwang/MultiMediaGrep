// src/media/annotation/index.js —— media_annotate 的批注模块入口
//
// 与 ../bookmark/index.js 对称：sidecar / entries / derive / embedders + 一个
// 用通用引擎（../bookmark/engine.js）组装出来的 annotationEngine。
//
// 与书签的差异全部通过引擎参数注入，不复制流程：
//   - label / sidecarNoun："media_annotate" / "annotation"（错误与提示文案）
//   - idPrefix："n"（n1、n2、…）
//   - sidecarSuffix：".mmgrep.annotation.json"
//   - adapter：annotationEntryAdapter（按媒体类型的批注 schema）
//   - deriveEntries：首次写入时从 probe.annotationOutline 导入（9z5.38.2 填数据源）
//   - resultKey：结果对象里的 "annotations"（书签是 "outline"）
//   - imageSidecarDetail：图片只写 sidecar 的检查说明

import { createSidecarEngine } from '../bookmark/engine.js';
import { ANNOTATION_ID_PREFIX, annotationEntryAdapter } from './entries.js';
import { deriveAnnotationEntriesFromProbe } from './derive.js';
import { defaultAnnotationEmbedders } from './embedders.js';
import { ANNOTATION_SIDECAR_SUFFIX } from './sidecar.js';

export {
  ANNOTATION_ID_PREFIX,
  DEFAULT_ANNOTATION_AUTHOR,
  MAX_NOTE_CHARS,
  MAX_AUTHOR_CHARS,
  DEFAULT_ANNOTATION_END_SECONDS,
  CREATABLE_ANNOTATION_TYPES,
  positionFields,
  entryFields,
  writableFields,
  isAnnotationMedia,
  normalizeNote,
  normalizeAuthor,
  normalizeType,
  isCreatableAnnotationType,
  defaultAnnotationEnd,
  canonicalAnnotation,
  validateStoredAnnotation,
  validateAddAnnotation,
  validateUpdateAnnotation,
  applyAnnotationPatch,
  sortAnnotations,
  formatAnnotationClock,
  formatAnnotation,
  annotationEntryAdapter,
} from './entries.js';

export {
  annotationEntriesOf,
  deriveAnnotationsFromOutline,
  deriveAnnotationEntriesFromProbe,
  hasNativeAnnotations,
} from './derive.js';

export {
  ANNOTATION_SIDECAR_SUFFIX,
  ANNOTATION_SIDECAR_ADAPTER,
  annotationSidecarPathFor,
  readAnnotationSidecar,
  parseAnnotationSidecarText,
  serializeAnnotationSidecar,
  writeAnnotationSidecar,
} from './sidecar.js';

export {
  defaultAnnotationEmbedders,
  annotationEmbedderFor,
  assertAnnotationEmbedderRegistry,
} from './embedders.js';

export { pdfAnnotationEmbedder, PDF_ANNOTATION_EMBED_TARGET } from './embedder-pdf.js';
export { ANNOTATION_VTT_SUFFIX, annotationVttPathFor, vttAnnotationEmbedder } from './embedder-vtt.js';

/** media_annotate 的通用引擎实例（pdf/video/audio 嵌入器在 38.1 是 TOOL_NOT_FOUND 占位） */
export const annotationEngine = createSidecarEngine({
  label: 'media_annotate',
  idPrefix: ANNOTATION_ID_PREFIX,
  sidecarSuffix: ANNOTATION_SIDECAR_SUFFIX,
  adapter: annotationEntryAdapter,
  embedders: defaultAnnotationEmbedders,
  deriveEntries: deriveAnnotationEntriesFromProbe,
  resultKey: 'annotations',
  idNoun: 'annotation',
  sidecarNoun: 'annotation',
  imageSidecarDetail: 'image: no native annotation surface; the sidecar is the only store',
});
