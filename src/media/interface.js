// src/media/interface.js —— 工具层与后端之间的公共契约
// 契约来源：docs/mcp-contract.md §2.1–§2.4（错误码全集、路径校验、范围校验、pages 解析规则）。
// 这里只做「校验 + 分派」，不做任何媒体解析。

import { stat } from 'node:fs/promises';
import path from 'node:path';

/** 契约 §2.4 的错误码全集 */
export const ERROR_CODES = Object.freeze([
  'INVALID_ARGUMENT', 'PATH_NOT_FOUND', 'NOT_A_FILE', 'NOT_A_LOCAL_PATH', 'UNSUPPORTED_MEDIA_TYPE',
  'OUT_OF_RANGE', 'NO_TRANSCRIPT', 'PROVIDER_NOT_CONFIGURED', 'PROVIDER_FAILED',
  'TRANSCRIPT_UNREADABLE', 'BUDGET_EXCEEDED', 'TOOL_NOT_FOUND', 'INTERNAL',
]);

/** 工具失败时抛出：带错误码与提示，转成 MCP 的 isError 结果 */
export class ToolError extends Error {
  constructor(code, message, hint = null) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.hint = hint;
  }

  /** 契约 §2.4 的错误结果形状 */
  toResult() {
    return {
      content: [{ type: 'text', text: `${this.code}: ${this.message}` }],
      structuredContent: {
        error: { code: this.code, message: this.message, hint: this.hint },
      },
      isError: true,
    };
  }
}

const PROTOCOL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * 路径校验：契约 §2.4 的固定五步。
 * 1 缺失 → 2 协议头/URL → 3 非绝对路径 → 4 不存在 → 5 非普通文件
 */
export async function validatePath(inputPath) {
  if (inputPath === undefined || inputPath === null || inputPath === '') {
    throw new ToolError('INVALID_ARGUMENT', 'path is required.');
  }
  const raw = String(inputPath);
  if (PROTOCOL_RE.test(raw) || raw.startsWith('//')) {
    throw new ToolError(
      'NOT_A_LOCAL_PATH',
      `path must be a local absolute file path; URLs are not accepted ("${raw}"). This server never downloads anything — fetch the file first, then pass its local path.`,
      'Pass a bare absolute path such as "/abs/path/a.mp4".',
    );
  }
  if (!path.isAbsolute(raw)) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `path must be an absolute local path; got "${raw}". Use an absolute path such as "/abs/path/videos/a.mp4".`,
    );
  }
  const resolved = path.resolve(raw);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new ToolError('PATH_NOT_FOUND', `path does not exist: "${resolved}".`);
  }
  if (!info.isFile()) {
    throw new ToolError('NOT_A_FILE', `path is not a regular file: "${resolved}".`);
  }
  return resolved;
}

/**
 * 解析 pages 规格：逗号分隔的 `N` 或 `N-M`（闭区间）。
 * 去重 + 合并升序；越界报错不静默截断（契约 §2.4）。
 */
export function parsePages(spec, { pageCount = null } = {}) {
  const text = String(spec).trim();
  if (!text) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      'pages must not be empty. Use a comma-separated list of page numbers and closed ranges, e.g. "3-10,15".',
      'pages: "3-10,15"',
    );
  }
  const pages = new Set();
  for (const token of text.split(',')) {
    const item = token.trim();
    if (!item) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `pages is invalid: "${text}". Expected a comma-separated list of page numbers and closed ranges, e.g. "3-10,15".`,
        'pages: "3-10,15"',
      );
    }
    const range = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(item);
    if (!range) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `pages is invalid: "${item}". Expected a comma-separated list of page numbers and closed ranges, e.g. "3-10,15".`,
        'pages: "3-10,15"',
      );
    }
    const low = Number(range[1]);
    const high = range[2] === undefined ? low : Number(range[2]);
    if (low < 1) {
      throw new ToolError('INVALID_ARGUMENT', `pages is invalid: "${item}". Page numbers start at 1.`);
    }
    if (high < low) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `pages is invalid: "${item}". Ranges must be low-to-high with inclusive bounds, e.g. "3-10".`,
      );
    }
    if (pageCount !== null && high > pageCount) {
      throw new ToolError('OUT_OF_RANGE', `pages out of range: ${low}-${high}. This document has ${pageCount} pages.`);
    }
    for (let p = low; p <= high; p += 1) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * 时间区间校验（视频/录音）。
 * start 越界报错；end 越界裁到末尾并标记 clipped（契约 §2.4 的例外条款）。
 */
export function validateTimeRange({ startSec = null, endSec = null, durationSec = null } = {}) {
  const start = startSec === null || startSec === undefined ? null : Number(startSec);
  let end = endSec === null || endSec === undefined ? null : Number(endSec);
  if (start !== null && (!Number.isFinite(start) || start < 0)) {
    throw new ToolError('INVALID_ARGUMENT', 'start must be >= 0.');
  }
  if (start !== null && end !== null && end <= start) {
    throw new ToolError('INVALID_ARGUMENT', `end must be greater than start (end=${end}, start=${start}).`);
  }
  let clipped = false;
  if (durationSec !== null && durationSec !== undefined) {
    if (start !== null && start > durationSec) {
      throw new ToolError(
        'OUT_OF_RANGE',
        `start (${start.toFixed(1)} s) is beyond the end of the media (duration ${durationSec.toFixed(1)} s).`,
      );
    }
    if (end !== null && end > durationSec) {
      end = durationSec;
      clipped = true;
    }
  }
  return {
    startMs: start === null ? null : Math.round(start * 1000),
    endMs: end === null ? null : Math.round(end * 1000),
    startSec: start,
    endSec: end,
    clipped,
  };
}

/** 裁切框校验：比例制（0..1），契约 §2.4 */
export function validateCrop(crop) {
  if (!crop) return null;
  const { x, y, width, height } = crop;
  const bad = !(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1 && y + height <= 1);
  if (bad) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `crop must satisfy 0 <= x, 0 <= y, x + width <= 1, y + height <= 1 (got x=${x}, width=${width}).`,
    );
  }
  return { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
}

/**
 * 方法适用矩阵：哪个媒体类型支持哪个工具方法。
 * 契约 §2.2 的参数适用性总表在这里落到「方法级」。
 */
export const METHOD_MATRIX = Object.freeze({
  video: ['probe', 'overview', 'zoom', 'locate'],
  audio: ['probe', 'overview', 'locate'],
  document: ['probe', 'overview', 'zoom', 'locate'],
});

export const METHODS = Object.freeze(['probe', 'overview', 'zoom', 'locate']);

/**
 * 分派器：按 mediaType 选后端，再按方法选实现。
 * 后端对象形如 { probe, overview, zoom, locate }（不适用的方法可以缺省）。
 */
export function createDispatcher(backends) {
  return {
    supports(mediaType, method) {
      return (METHOD_MATRIX[mediaType] ?? []).includes(method);
    },
    async call(mediaType, method, input, ctx) {
      if (!METHODS.includes(method)) {
        throw new ToolError('INVALID_ARGUMENT', `unknown method: ${method}`);
      }
      if (!this.supports(mediaType, method)) {
        throw new ToolError(
          'INVALID_ARGUMENT',
          `${method} is not applicable to ${mediaType} media. Supported methods for ${mediaType}: ${(METHOD_MATRIX[mediaType] ?? []).join(', ')}.`,
        );
      }
      const backend = backends[mediaType];
      if (!backend || typeof backend[method] !== 'function') {
        throw new ToolError('INTERNAL', `${mediaType} backend does not implement ${method}.`);
      }
      return backend[method](input, ctx);
    },
  };
}
