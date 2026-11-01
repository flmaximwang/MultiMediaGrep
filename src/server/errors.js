// src/server/errors.js —— 统一错误模型（契约 §2.4）
//
// 目标：任何从 handler / backend / provider 冒出来的异常，都变成同一种 MCP 错误结果：
//
//   {
//     content: [{ type: 'text', text: 'CODE: message' }],
//     structuredContent: { error: { code, message, hint } },
//     isError: true
//   }
//
// 规则：
//   - ToolError（或任何带契约错误码的 Error）→ 原样透传 code / message / hint。
//   - 未知异常 → INTERNAL，并附 stack 摘要（契约要求「必须带上原始 stack 摘要」）。
//   - 真的不能把 stack 甩给 agent 的部分（比如几十层的 node_modules 帧）在摘要里截断。

import { ERROR_CODES, ToolError } from '../media/interface.js';

const CODE_SET = new Set(ERROR_CODES);

/** 错误结果里最多保留多少行 stack / 多少字符 */
const STACK_MAX_LINES = 6;
const STACK_MAX_CHARS = 1600;

/**
 * 判断一个异常是不是「已经带契约错误码」的异常。
 * 既认本仓库 ToolError，也认其它模块自己构造的 { code, message } Error（providers 常常这样做）。
 */
export function asCodedError(error) {
  if (!error || typeof error !== 'object') return null;
  if (error instanceof ToolError) return error;
  const code = typeof error.code === 'string' ? error.code : null;
  if (code && CODE_SET.has(code)) {
    const err = new ToolError(code, error.message || String(error), error.hint ?? null);
    if (error.stack) err.stack = error.stack;
    return err;
  }
  return null;
}

/** 把任意异常压成一段可读的 stack 摘要（不含完整依赖栈） */
export function stackSummary(error) {
  if (!error) return null;
  const stack = typeof error.stack === 'string' ? error.stack : null;
  if (!stack) return error.message ? `${error.name ?? 'Error'}: ${error.message}` : String(error);
  const lines = stack.split('\n').slice(0, STACK_MAX_LINES);
  let text = lines.join('\n');
  if (text.length > STACK_MAX_CHARS) text = `${text.slice(0, STACK_MAX_CHARS)}…`;
  return text;
}

/**
 * 把任意异常映射成契约 §2.4 的 MCP 错误结果。
 *
 * @param {unknown} error
 * @param {{ tool?: string, logger?: object }} [options]
 * @returns {{ content: object[], structuredContent: object, isError: true }}
 */
export function toErrorResult(error, { tool = null, logger = null } = {}) {
  const coded = asCodedError(error);
  if (coded) {
    logger?.debug?.(`tool ${tool ?? '?'} failed with ${coded.code}: ${coded.message}`);
    return coded.toResult();
  }

  // 客户端取消（AbortSignal）不算服务器 bug，但也得让调用方看到发生了什么。
  const aborted = error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
  const message = aborted
    ? 'request was cancelled by the client'
    : `unexpected server error${error?.message ? `: ${redactMessage(error.message)}` : ''}`;
  const summary = stackSummary(error);

  logger?.error?.(`tool ${tool ?? '?'} crashed: ${summary ?? message}`);

  const result = {
    content: [{ type: 'text', text: `INTERNAL: ${message}${summary ? `\n\n${summary}` : ''}` }],
    structuredContent: {
      error: {
        code: 'INTERNAL',
        message,
        hint: 'This is an unexpected server error, not a problem with your arguments. '
          + 'Retry once; if it persists, report the stack summary together with the tool name and arguments.',
        ...(summary ? { stack: summary } : {}),
      },
    },
    isError: true,
  };
  return result;
}

/**
 * 包一层工具 handler：捕获所有异常并转成错误结果。
 * 注意：SDK 自己捕获 handler 抛错时只会回传 `error.message`（丢掉 code / hint），
 * 所以错误必须在 handler 内部转好再返回，不能靠 throw。
 */
export function guardToolHandler(toolName, handler, { logger = null } = {}) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return toErrorResult(error, { tool: toolName, logger });
    }
  };
}

/**
 * 统一的「工具级错误结果」构造器：让 tools.js 不用重复写 content 结构。
 */
export function errorResult(code, message, hint = null) {
  return new ToolError(code, message, hint).toResult();
}

/**
 * 错误信息里的偶发敏感串（长 token / Bearer）打码。
 * provider 的 key 由 provider 自己打码；这里是最后一道保险。
 */
export function redactMessage(message) {
  return String(message)
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, 'sk-***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');
}
