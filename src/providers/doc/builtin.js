/**
 * 内置 typeset provider：为**已经有文字层**的页恢复阅读顺序与结构。
 *
 * 硬约束（契约 v2，见同目录 README §1）：
 *   typeset 角色**不得重新识别字符**。本 provider 只搬运调用方抽好的文字层文本，
 *   永远返回 `textOrigin: 'textlayer'`。
 *
 * 本票（9z5.28）只做最简实现：按空行切段落，每段一个 `paragraph` block。
 * 9z5.24 会在这里继续加柱检测 / 重排 / 标题与图注启发式；那时仍然只能基于
 * 文字层字符做结构判断，不得调用 OCR。
 *
 * 为什么文本由调用方传入：builtin 是**本地** provider，不解析文件、不联网；
 * 文档后端已经把逐页文字层抽好了（pdfSupport.extractTextLayers），通过
 * `parse({ textLayers })` 传进来即可，避免重复跑 pdftotext。
 */

/** 该 provider 支持的角色（注册表用）。 */
export const BUILTIN_ROLES = Object.freeze(['typeset']);

/**
 * 把 pages 参数规整成「1 起的页码集合」；返回 null 表示不限制。
 * 语义与 mineru.js 的 normalizePageList 一致（builtin 不 import mineru，避免循环依赖）。
 */
function pageSetFromSpec(pages) {
  if (pages === undefined || pages === null || pages === '') return null;
  let list = [];
  if (typeof pages === 'number') {
    list = [pages];
  } else if (Array.isArray(pages)) {
    if (pages.length === 2 && pages.every((n) => typeof n === 'number')) {
      const [from, to] = pages.map(Number);
      for (let page = from; page <= to; page += 1) list.push(page);
    } else {
      list = pages.slice();
    }
  } else if (typeof pages === 'object') {
    const from = pages.from ?? pages.start ?? pages.first;
    const to = pages.to ?? pages.end ?? pages.last;
    if (typeof from === 'number' && typeof to === 'number') {
      for (let page = Number(from); page <= Number(to); page += 1) list.push(page);
    } else if (typeof from === 'number') {
      list = [from];
    } else if (Array.isArray(pages.list)) {
      list = pages.list.slice();
    } else if (Array.isArray(pages.pages)) {
      list = pages.pages.slice();
    } else {
      throw new Error(
        'Invalid page range for the builtin typeset provider. Use {from, to}, [from, to], a page number, or {list: [...]}.',
      );
    }
  } else {
    throw new Error(
      'Invalid page range for the builtin typeset provider. Use {from, to}, [from, to], a page number, or {list: [...]}.',
    );
  }

  const out = new Set();
  for (const raw of list) {
    const page = Number(raw);
    if (!Number.isInteger(page) || page < 1) {
      throw new Error(`Invalid page number in the requested range: ${raw} (pages are 1-based).`);
    }
    out.add(page);
  }
  return out;
}

/** 契约 v2 允许的 block 类型。 */
const BLOCK_TYPES = new Set([
  'heading',
  'paragraph',
  'list',
  'table',
  'caption',
  'equation',
  'footnote',
]);

/**
 * 把一页文字层文本切成段落：空行分段，段内保留单换行。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitParagraphs(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/**
 * 文字层文本 → 最简 blocks（每段一个 paragraph）。
 *
 * @param {string} text
 * @returns {Array<{type: 'paragraph', text: string}>}
 */
export function textToBlocks(text) {
  return splitParagraphs(text).map((paragraph) => ({ type: 'paragraph', text: paragraph }));
}

/**
 * blocks → 纯文本（契约 v2 的 `text` 是「由 blocks 派生」的便利字段）。
 *
 * @param {Array<{text?: string}>} blocks
 * @returns {string}
 */
export function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => String(block?.text ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 规整 provider 返回的 blocks：丢掉空文本与未知类型，heading 的 level 只保留正整数。
 * 这个函数也被后端用于校验外部 provider 的输出（契约 v2 的公共形状）。
 *
 * @param {Array<object>} blocks
 * @returns {Array<{type: string, text: string, level?: number}>}
 */
export function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const text = String(block.text ?? '').trim();
    if (!text) continue;
    const type = BLOCK_TYPES.has(block.type) ? block.type : 'paragraph';
    const normalized = { type, text };
    const level = Number(block.level);
    if (Number.isInteger(level) && level > 0) normalized.level = level;
    out.push(normalized);
  }
  return out;
}

/**
 * 把调用方传入的逐页文字层文本规整成 Map<number, string>。
 * 接受 Map、数组（[{page,text}]）或普通对象（{ "1": "..." }）。
 *
 * @param {Map<number,string>|Array<{page:number,text:string}>|Record<string,string>|null|undefined} textLayers
 * @returns {Map<number,string>}
 */
export function normalizeTextLayers(textLayers) {
  const out = new Map();
  if (textLayers instanceof Map) {
    for (const [page, text] of textLayers) {
      const number = Number(page);
      if (Number.isInteger(number) && number >= 1) out.set(number, String(text ?? ''));
    }
    return out;
  }
  if (Array.isArray(textLayers)) {
    for (const entry of textLayers) {
      const page = Number(entry?.page);
      if (Number.isInteger(page) && page >= 1) out.set(page, String(entry?.text ?? ''));
    }
    return out;
  }
  if (textLayers && typeof textLayers === 'object') {
    for (const [page, text] of Object.entries(textLayers)) {
      const number = Number(page);
      if (Number.isInteger(number) && number >= 1) out.set(number, String(text ?? ''));
    }
  }
  return out;
}

/**
 * 创建内置 typeset provider。
 *
 * @returns {object} 契约 v2 的 provider 对象
 */
export function createBuiltinTypesetProvider() {
  return {
    id: 'builtin',
    roles: BUILTIN_ROLES,

    /**
     * @param {object} [input]
     * @param {'typeset'} [input.role] 只接受 typeset（默认）。
     * @param {Map|Array|object} [input.textLayers] 调用方抽好的逐页文字层文本。
     * @returns {Promise<{provider: 'builtin', model: null, pages: Array<object>, raw: object}>}
     */
    async parse(input = {}) {
      const role = input?.role ?? 'typeset';
      if (!BUILTIN_ROLES.includes(role)) {
        throw new Error(
          `The builtin typeset provider only supports role "typeset" (got "${role}"); it never re-recognizes characters. ` +
            'Configure MMGREP_OCR_PROVIDER for pages without a text layer.',
        );
      }

      const layers = normalizeTextLayers(input?.textLayers);
      const wanted = pageSetFromSpec(input?.pages);
      const pages = [...layers.entries()]
        .filter(([page]) => !wanted || wanted.has(page))
        .sort((a, b) => a[0] - b[0])
        .map(([page, text]) => {
          const blocks = textToBlocks(text);
          return {
            page,
            textOrigin: 'textlayer',
            blocks,
            text: blocksToText(blocks),
          };
        });

      return {
        provider: 'builtin',
        model: null,
        pages,
        raw: { role, pages: pages.length },
      };
    },

    /** 描述信息 —— builtin 没有凭据，也没有网络端点。 */
    describe() {
      return { id: 'builtin', model: null, baseUrl: null, roles: BUILTIN_ROLES };
    },
  };
}
