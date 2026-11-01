// src/server/backends.js —— 三个后端的集中接线点（video / audio / document）
//
// 后端约定（后端 agent 照此实现）：
//
//   src/backend/<type>/index.js
//     export function create<Type>Backend(ctx) -> {
//       probe(input, ctx)     -> ProbeResult
//       overview(input, ctx)  -> { segments, images, transcript, warnings }
//       zoom(input, ctx)      -> { images, target?, warnings }
//       locate(input, ctx)    -> { matches, transcript?, totalSegments?, frame?, warnings }
//       subtitles(input, ctx) -> { segments, origin?, sourcePath?, format?, language?, warnings }
//     }
//
// 后端文件**可能还不存在**。loadBackends() 必须优雅降级：缺失的模块 → 占位后端，
// 调用时抛 `INTERNAL: <type> backend is not implemented yet.`，这样框架可以独立启动、
// 独立测试；后端文件一落地，同一个 import 自动生效，不需要改 server 代码。

import { METHOD_MATRIX, METHODS, ToolError } from '../media/interface.js';

/** 三个后端的模块位置与工厂函数名（后端 agent 的唯一接线约定） */
export const BACKEND_SPECS = Object.freeze({
  video: Object.freeze({ module: '../backend/video/index.js', factory: 'createVideoBackend', label: 'video' }),
  audio: Object.freeze({ module: '../backend/audio/index.js', factory: 'createAudioBackend', label: 'audio' }),
  document: Object.freeze({ module: '../backend/document/index.js', factory: 'createDocumentBackend', label: 'document' }),
});

const STATUS = Symbol('mmgrep.backendStatus');

/**
 * 造一个「未实现」的占位后端：每个方法都抛 INTERNAL，提示去实现哪个文件。
 *
 * @param {'video'|'audio'|'document'} mediaType
 * @param {string|null} reason 缺失/加载失败的具体原因（写进 hint，方便排查）
 */
export function createPlaceholderBackend(mediaType, reason = null) {
  const backend = {};
  const message = `${mediaType} backend is not implemented yet.`;
  const hint = `Implement ${BACKEND_SPECS[mediaType]?.module ?? `src/backend/${mediaType}/index.js`} `
    + `(export ${BACKEND_SPECS[mediaType]?.factory ?? `create${mediaType}Backend`}(ctx)); see src/server/README.md.`
    + (reason ? ` Loader note: ${reason}` : '');
  for (const method of METHODS) {
    if (!(METHOD_MATRIX[mediaType] ?? []).includes(method)) continue;
    backend[method] = async () => {
      throw new ToolError('INTERNAL', message, hint);
    };
  }
  defineStatus(backend, { mediaType, implemented: false, reason, placeholder: true });
  return backend;
}

/** 把后端对象补全成「METHOD_MATRIX 里的每个方法都存在」，缺的方法给出清晰报错 */
function completeBackend(mediaType, backend, status) {
  const completed = { ...backend };
  for (const method of METHOD_MATRIX[mediaType] ?? []) {
    if (typeof backend?.[method] !== 'function') {
      completed[method] = async () => {
        throw new ToolError(
          'INTERNAL',
          `${mediaType} backend does not implement ${method}.`,
          `Implement ${method}(input, ctx) in ${BACKEND_SPECS[mediaType].module}.`,
        );
      };
      if (!status.missingMethods.includes(method)) status.missingMethods.push(method);
    }
  }
  defineStatus(completed, status);
  return completed;
}

function defineStatus(backend, status) {
  Object.defineProperty(backend, STATUS, { value: Object.freeze({ ...status }), enumerable: false });
  Object.defineProperty(backend, 'describeStatus', {
    value: () => backend[STATUS],
    enumerable: false,
  });
}

/** 读后端状态（给启动日志 / README 用） */
export function backendStatus(backend) {
  return backend?.[STATUS] ?? null;
}

/**
 * 加载三个后端。
 *
 * @param {object} [ctx] 传给后端工厂的上下文：{ cache, asrProvider, docProvider, logger, config }
 * @param {object} [options]
 * @param {object} [options.logger]
 * @param {(specifier: string) => Promise<object>} [options.importer] 测试注入用
 * @returns {Promise<{ video: object, audio: object, document: object }>}
 */
export async function loadBackends(ctx = {}, { logger = null, importer = null } = {}) {
  const load = importer ?? ((specifier) => import(specifier));
  const result = {};

  for (const [mediaType, spec] of Object.entries(BACKEND_SPECS)) {
    try {
      const mod = await load(spec.module);
      const factory = mod?.[spec.factory];
      if (typeof factory !== 'function') {
        const reason = `${spec.module} does not export a ${spec.factory}(ctx) function.`;
        logger?.warn?.(reason);
        result[mediaType] = createPlaceholderBackend(mediaType, reason);
        continue;
      }
      const backend = await factory(ctx);
      if (!backend || typeof backend !== 'object') {
        const reason = `${spec.factory}(ctx) did not return a backend object.`;
        logger?.warn?.(reason);
        result[mediaType] = createPlaceholderBackend(mediaType, reason);
        continue;
      }
      const status = {
        mediaType,
        implemented: true,
        reason: null,
        placeholder: false,
        missingMethods: [],
        module: spec.module,
        factory: spec.factory,
      };
      result[mediaType] = completeBackend(mediaType, backend, status);
      logger?.debug?.(`${mediaType} backend loaded from ${spec.module}`);
    } catch (error) {
      // 模块还不存在是**正常**的开发状态（其它 agent 尚未交付），用 debug 而不是 error。
      const missing = error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND';
      const reason = `${spec.module} could not be loaded: ${error?.message ?? error}`;
      if (missing) {
        logger?.info?.(`${mediaType} backend is not available yet (${spec.module}); using a placeholder.`);
      } else {
        logger?.warn?.(`${mediaType} backend failed to load; using a placeholder: ${error?.message ?? error}`);
      }
      result[mediaType] = createPlaceholderBackend(mediaType, reason);
    }
  }

  return result;
}
