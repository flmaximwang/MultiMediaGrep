// src/media/bookmark/index.js —— 书签引擎的公开入口
//
// 读侧（9z5.37.6）至少需要：
//   - deriveEntriesFromProbe / deriveEntriesFromOutline：没有 sidecar 时的推导，
//     与首次写入的 id 完全一致；
//   - readSidecar / sidecarPathFor / BOOKMARK_SIDECAR_SUFFIX：读已有 sidecar；
//   - bookmarkEngine / BOOKMARK_ID_PREFIX / formatEntry：展示格式。
//
// 写侧（工具层）需要 bookmarkEngine.execute()，嵌入器实现见 embedder-pdf.js /
// embedder-vtt.js（stage-2 ticket 9z5.37.2 / 9z5.37.4）。

export {
  BOOKMARK_SIDECAR_SUFFIX,
  entriesFingerprint,
  isValidSidecarId,
  parseSidecarText,
  readSidecar,
  serializeSidecar,
  sidecarPathFor,
  writeFileAtomic,
  writeSidecar,
} from './sidecar.js';

export {
  SIDECAR_VERSION,
  applyPatch,
  canonicalEntry,
  entryFields,
  entryIdNumber,
  formatClock,
  formatEntry,
  isBookmarkMedia,
  isEntryId,
  nextIdNumber,
  normalizeTitle,
  positionFields,
  sortEntries,
  validateAddEntry,
  validateStoredEntry,
  validateUpdatePatch,
} from './entries.js';

export { deriveEntriesFromOutline, deriveEntriesFromProbe, hasNativeOutline } from './derive.js';

export {
  BOOKMARK_ID_PREFIX,
  applyOperations,
  bookmarkEngine,
  bookmarkEntryAdapter,
  createSidecarEngine,
  limitsFromProbe,
} from './engine.js';

export {
  defaultBookmarkEmbedders,
  embedderFor,
} from './embedders.js';

export { pdfBookmarkEmbedder } from './embedder-pdf.js';
export { bookmarkVttPathFor, vttBookmarkEmbedder } from './embedder-vtt.js';
