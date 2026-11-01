/**
 * MinerU 云解析 API（/api/v4）适配器。
 *
 * 官方文档（实现时核对过，2026-11-01）：
 *   - 接口总览与参数表：https://mineru.net/apiManage/docs
 *   - 输出文件说明（zip 内的 full.md / content_list.json 等）：
 *     https://opendatalab.github.io/MinerU/reference/output_files/
 *   - 社区 v4 实现参考（含真实踩坑记录）：
 *     https://github.com/HuanLinOTO/dsh-plugin-mineru/issues/2
 *     https://github.com/neosun100/mineru-mcp-server
 *
 * 确认过的契约：
 *   1) POST {baseUrl}/file-urls/batch
 *      header: Authorization: Bearer <token>, Content-Type: application/json
 *      body:   { files: [{ name, data_id?, is_ocr?, page_ranges? }],
 *                model_version?, language?, enable_formula?, enable_table?, extra_formats? }
 *      resp:   { code, msg, trace_id, data: { batch_id, file_urls: [presigned PUT url] } }
 *   2) PUT presigned url —— 必须「裸请求」：不能带 Authorization / Content-Type
 *      （预签名已绑定签名头，多带一个头就会 403 SignatureDoesNotMatch）。
 *      Node 的 fetch 对 Buffer body 不会自动加 Content-Type，所以直接传 Buffer 即可。
 *   3) GET {baseUrl}/extract-results/batch/{batch_id}（带 Bearer）
 *      resp:   { code, msg, data: { batch_id, extract_result: [ { file_name, state,
 *                err_msg, full_zip_url, data_id, extract_progress } ] } }
 *      state 取值：waiting-file / pending / running / converting / done / failed
 *      （有些资料把结果数组写成 data.results，这里两种都兼容）
 *   4) GET full_zip_url —— 预签名 CDN 地址，同样不能带 Authorization。
 *      zip 内含 full.md、layout.json、*_model.json、*_content_list.json、
 *      *_content_list_v2.json、images/（云端 3.4.4 实测没有 middle.json）。
 *      云端 API 3.4.4 的结果包里**没有**逐页 / 逐文档的解析模式字段（无
 *      _parse_type / parse_mode），只有 layout.json 的 _backend（pipeline/vlm）
 *      与 _version_name；
 *      因此 textOrigin 的判定见 resolveTextOrigin() 与 README §4。
 *
 * 字段兼容说明（对不确定的字段做兜底）：
 *   - 结果数组：data.extract_result ?? data.results ?? data.extract_result[]
 *   - 结果包地址：full_zip_url ?? zip_url
 *   - content_list 文件名：content_list.json 或 <name>_content_list.json
 *   - 页码字段：page_idx（0 基）
 */

import { stat, readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

import { blocksToText, textToBlocks } from './builtin.js';

/** MinerU 默认接口地址。 */
export const MINERU_DEFAULT_BASE_URL = 'https://mineru.net/api/v4';
/** 默认超时（MinerU 是异步任务，轮询可能比较久）。 */
export const MINERU_DEFAULT_TIMEOUT_MS = 300_000;
/** 单文件大小上限：200MB（官方错误码 -60005）。 */
export const MINERU_MAX_FILE_BYTES = 200 * 1024 * 1024;
/** 单文件页数上限：200 页（官方错误码 -60006）。 */
export const MINERU_MAX_PAGES = 200;

/** 轮询退避参数。 */
const POLL_FIRST_MS = 1_500;
const POLL_MAX_MS = 10_000;
const POLL_FACTOR = 1.5;
const POLL_JITTER = 0.25;

/** 常见官方错误码 → 可读提示（见 https://mineru.net/apiManage/docs 的错误码表）。 */
const API_CODE_HINTS = {
  A0202: 'token is invalid — check MMGREP_MINERU_API_KEY',
  A0211: 'token has expired — create a new token at https://mineru.net/apiManage/token',
  '-500': 'request parameter error',
  '-10001': 'MinerU service error, please retry later',
  '-10002': 'request parameter error',
  '-60002': 'unsupported file type — MinerU accepts pdf/doc/docx/ppt/pptx/xls/xlsx and images',
  '-60003': 'file could not be read (it may be corrupted)',
  '-60004': 'file is empty',
  '-60005': 'file is larger than the 200MB limit',
  '-60006': 'file has more than 200 pages — split it first',
  '-60010': 'parse failed on the MinerU side',
  '-60018': 'daily free quota (1000 pages) is exhausted',
};

/**
 * 创建 MinerU 文档解析 provider。
 *
 * @param {object} [options]
 * @param {string} [options.apiKey] MinerU token（Bearer）。
 * @param {string} [options.baseUrl] 接口地址，默认 https://mineru.net/api/v4 。
 * @param {string} [options.model] model_version（pipeline / vlm / MinerU-HTML），留空则用服务端默认。
 *   typeset 角色会强制 pipeline；设为 vlm 等非 pipeline 值时 typeset / both 会报错。
 * @param {number} [options.timeoutMs] 整体超时，默认 300000。
 * @param {Function} [options.fetchImpl] 注入的 fetch 实现（测试用）。
 * @param {Function} [options.onProgress] 进度回调 ({stage, detail}) => void 。
 * @param {'ocr'|'typeset'|'both'} [options.role] 工厂创建时绑定的角色（只用于错误提示；parse 可覆盖）。
 * @param {number} [options.pollIntervalMs] 首次轮询间隔，默认 1500ms（测试可调小）。
 *
 * 契约 v2 的 OCR 模式由 parse({ ocrMode }) 决定：
 *   - 'auto'（默认）：不发送 is_ocr，让 MinerU 按文档自行选择；
 *   - 'force'：发送 is_ocr: true，要求对页面重新识别（9z5.31）。
 */
export function createMineruDocProvider(options = {}) {
  const opts = options ?? {};
  const apiKey = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
  const baseUrl = String(opts.baseUrl || MINERU_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const model = typeof opts.model === 'string' ? opts.model.trim() : '';
  const timeoutMs = normalizeTimeoutMs(opts.timeoutMs);
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  const constructorOnProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const constructorRole = normalizeRole(opts.role ?? 'both');
  const pollIntervalMs = normalizePollInterval(opts.pollIntervalMs);

  /** 打码：任何进入错误信息 / 日志的文本都不能带 token。 */
  const redact = (value) => {
    let out = String(value ?? '');
    if (apiKey) out = out.split(apiKey).join('***');
    return out;
  };

  /**
   * 带鉴权的 JSON 请求。返回解析后的 JSON；失败时抛出可诊断的错误。
   */
  async function requestJson(path, { method = 'GET', body, signal } = {}) {
    const url = `${baseUrl}${path}`;
    const headers = { Accept: 'application/json' };
    if (method !== 'GET' && method !== 'HEAD') headers['Content-Type'] = 'application/json';
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) {
        if (signal.reason?.code === 'MMGREP_DOC_TIMEOUT') {
          // 交给上层转换成带 batch_id 的超时错误
          const timeoutErr = new Error(`MinerU request timed out (${method} ${path}).`);
          timeoutErr.code = 'MMGREP_DOC_TIMEOUT';
          throw timeoutErr;
        }
        throw abortError(method, path);
      }
      throw new Error(`MinerU request failed (${method} ${path}): ${redact(err?.message || err)}`);
    }

    const raw = await res.text().catch(() => '');
    let json = null;
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      throw new Error(redact(httpErrorMessage(res, json, raw)));
    }
    const envelopeError = readEnvelopeError(json);
    if (envelopeError) {
      throw new Error(redact(`MinerU API error (${method} ${path}): ${envelopeError}`));
    }
    return json;
  }

  return {
    id: 'mineru',
    roles: Object.freeze(['ocr', 'typeset']),

    /**
     * 解析本地文档（契约 v2）。
     *
     * @param {object} input
     * @param {string} input.filePath
     * @param {any} [input.pages]
     * @param {'ocr'|'typeset'|'both'} [input.role] 默认 both。
     * @param {'auto'|'force'} [input.ocrMode] 默认 auto；force 时发送 is_ocr: true。
     * @param {AbortSignal} [input.signal]
     * @param {{onProgress?: Function}} [callOptions] 单次调用的进度回调，优先于构造时的 onProgress 。
     * @returns {Promise<{provider: string, model: string|null, pages: Array<{page: number, textOrigin: string, blocks: Array<object>, text: string, tables?: Array<object>}>, raw?: object}>}
     */
    async parse(input = {}, callOptions = {}) {
      const { filePath, pages, signal } = input ?? {};
      const role = normalizeRole(input?.role ?? constructorRole);
      const ocrMode = normalizeOcrMode(input?.ocrMode);
      const textPages = textPageSetFrom(input?.textLayers);
      const onProgress =
        typeof callOptions?.onProgress === 'function' ? callOptions.onProgress : constructorOnProgress;

      if (!apiKey) {
        throw new Error(
          `MinerU document provider is enabled (${roleEnvHint(role)}) but MMGREP_MINERU_API_KEY is missing. ` +
            'Set MMGREP_MINERU_API_KEY to a MinerU token (create one at https://mineru.net/apiManage/token), ' +
            'or set MMGREP_OCR_PROVIDER=none / MMGREP_TYPESET_PROVIDER=none to fall back to the PDF text layer / page images.',
        );
      }
      if (typeof fetchImpl !== 'function') {
        throw new Error('MinerU document provider requires a fetch implementation (global fetch is unavailable).');
      }
      if (!filePath || typeof filePath !== 'string') {
        throw new Error('MinerU document provider requires a filePath.');
      }
      assertRoleConfig({ role, ocrMode, model });

      const requested = normalizePageList(pages);
      const deadline = Date.now() + timeoutMs;
      const { signal: runSignal, cleanup } = combineSignals(signal, deadline);

      const report = (stage, detail) => {
        if (!onProgress) return;
        try {
          onProgress({ stage, detail: redact(detail) });
        } catch {
          /* 进度回调异常不能影响主流程 */
        }
      };

      try {
        const info = await stat(filePath).catch(() => null);
        if (!info || !info.isFile()) {
          throw new Error(`MinerU document provider cannot read file: ${filePath}`);
        }
        if (info.size > MINERU_MAX_FILE_BYTES) {
          throw new Error(
            `File is ${formatBytes(info.size)}, which exceeds MinerU's 200MB limit. Split the document before parsing it.`,
          );
        }
        if (info.size === 0) {
          throw new Error(`File is empty: ${filePath}`);
        }
        const bytes = await readFile(filePath);

        // 页数切批：单次任务最多 200 页，超出就按页范围拆成多个批次。
        const chunks = requested ? chunkPageList(requested, MINERU_MAX_PAGES) : [null];
        if (requested && chunks.length === 0) {
          throw new Error('The requested page range is empty.');
        }

        const merged = new Map(); // page -> { page, textOrigin, blocks, text, tables }
        const batchIds = [];
        const usedRanges = [];

        for (const chunk of chunks) {
          const pageRanges = chunk ? toPageRanges(chunk) : undefined;
          usedRanges.push(pageRanges ?? 'all');
          const result = await runOneBatch({
            filePath,
            bytes,
            pageRanges,
            chunk,
            requested,
            deadline,
            runSignal,
            report,
            role,
            ocrMode,
            textPages,
          });
          batchIds.push(result.batchId);
          for (const page of result.pages) {
            const existing = merged.get(page.page);
            if (existing) {
              existing.blocks = [...(existing.blocks ?? []), ...(page.blocks ?? [])];
              existing.text = blocksToText(existing.blocks);
              if (page.tables?.length) existing.tables = [...(existing.tables ?? []), ...page.tables];
            } else {
              merged.set(page.page, page);
            }
          }
        }

        const pagesOut = [...merged.values()].sort((a, b) => a.page - b.page);
        report('done', `MinerU parse finished: ${pagesOut.length} page(s).`);

        return {
          provider: 'mineru',
          model: model || null,
          pages: pagesOut,
          raw: {
            baseUrl,
            model: model || null,
            effectiveModel: modelForRequest(role, model) ?? null,
            role,
            ocrMode,
            batchIds,
            pageRanges: usedRanges,
          },
        };
      } finally {
        cleanup();
      }
    },

    /** 描述信息 —— 绝不包含 token。 */
    describe() {
      return { id: 'mineru', model: model || null, baseUrl, roles: ['ocr', 'typeset'] };
    },
  };

  /**
   * 跑完一个批次：申请上传地址 → PUT 上传 → 轮询 → 下载结果包 → 解包出页面。
   */
  async function runOneBatch({
    filePath,
    bytes,
    pageRanges,
    chunk,
    requested,
    deadline,
    runSignal,
    report,
    role,
    ocrMode,
    textPages,
  }) {
    // ---- 第 1 步：申请预签名上传地址 ----
    report('requesting', 'Requesting a MinerU upload URL...');
    const fileName = filePath.split(/[\\/]/).pop() || 'document.pdf';
    const fileEntry = { name: fileName };
    // 契约 v2：auto 不再强制 OCR；只有 force 才显式要求重新识别。
    if (ocrMode === 'force') fileEntry.is_ocr = true;
    if (pageRanges) fileEntry.page_ranges = pageRanges;
    const requestBody = { files: [fileEntry] };
    // typeset / both 角色必须钉在 pipeline（服务端默认也是 pipeline，这里显式发送，
    // 避免默认值变化时悄悄走 VLM → 重新识别字符）。
    const requestModel = modelForRequest(role, model);
    if (requestModel) requestBody.model_version = requestModel;

    const batchJson = await requestJson('/file-urls/batch', {
      method: 'POST',
      body: requestBody,
      signal: runSignal,
    });
    const batchData = batchJson?.data ?? {};
    const batchId = batchData.batch_id ?? batchData.batchId ?? null;
    if (!batchId) {
      throw new Error('MinerU did not return a batch_id for the upload request.');
    }
    // 兼容：官方是 data.file_urls 数组；个别实现可能用 data.upload_url。
    const uploadUrl = Array.isArray(batchData.file_urls)
      ? (batchData.file_urls[0] ?? null)
      : (batchData.upload_url ?? null);
    if (!uploadUrl) {
      throw new Error('MinerU did not return a presigned upload URL (data.file_urls was empty).');
    }

    // ---- 第 2 步：PUT 上传（不带 Authorization / Content-Type）----
    report('uploading', `Uploading ${fileName} (${formatBytes(bytes.byteLength)}) to MinerU...`);
    let uploadRes;
    try {
      uploadRes = await fetchImpl(uploadUrl, {
        method: 'PUT',
        body: bytes,
        headers: {},
        signal: runSignal,
      });
    } catch (err) {
      if (runSignal?.aborted) {
        if (runSignal.reason?.code === 'MMGREP_DOC_TIMEOUT') throw timeoutError(batchId, timeoutMs);
        throw abortError('PUT', 'presigned upload URL');
      }
      throw new Error(`MinerU upload failed: ${redact(err?.message || err)}`);
    }
    if (!uploadRes.ok) {
      const detail = await uploadRes.text().catch(() => '');
      throw new Error(
        `MinerU upload failed with HTTP ${uploadRes.status} ${uploadRes.statusText}` +
          `${detail ? `: ${redact(detail.slice(0, 400))}` : ''}` +
          ' (the presigned upload URL does not accept extra headers such as Authorization or Content-Type)',
      );
    }

    // ---- 第 3 步：轮询结果 ----
    report('parsing', `Waiting for MinerU to parse the document (batch_id=${batchId})...`);
    const result = await pollBatch({ batchId, deadline, runSignal, report });

    if (result.state === 'failed' || result.state === 'expired') {
      throw new Error(
        `MinerU parse failed (state=${result.state}, batch_id=${batchId}): ${result.errMsg || 'no error message returned'}`,
      );
    }
    const zipUrl = result.zipUrl;
    if (!zipUrl) {
      throw new Error(`MinerU reported state=done but returned no result package URL (batch_id=${batchId}).`);
    }

    // ---- 第 4 步：下载结果包（预签名地址，同样不带 Authorization）----
    report('downloading', 'Downloading the MinerU result package...');
    let zipRes;
    try {
      zipRes = await fetchImpl(zipUrl, { method: 'GET', headers: {}, signal: runSignal });
    } catch (err) {
      if (runSignal?.aborted) {
        if (runSignal.reason?.code === 'MMGREP_DOC_TIMEOUT') throw timeoutError(batchId, timeoutMs);
        throw abortError('GET', 'result package');
      }
      throw new Error(`MinerU result download failed: ${redact(err?.message || err)}`);
    }
    if (!zipRes.ok) {
      const detail = await zipRes.text().catch(() => '');
      throw new Error(
        `MinerU result download failed with HTTP ${zipRes.status} ${zipRes.statusText}` +
          `${detail ? `: ${redact(detail.slice(0, 400))}` : ''}`,
      );
    }
    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());

    // ---- 第 5 步：解包 ----
    report('unpacking', 'Extracting text and tables from the result package...');
    // 按「本批次实际请求的页范围」解包并过滤（切批时是 chunk，否则是整体范围）。
    const pages = extractPagesFromZip(zipBuffer, {
      range: chunk ?? requested,
      role,
      ocrMode,
      model,
      textPages,
    });
    return { batchId, pages };
  }

  /**
   * 轮询 extract-results/batch/{batch_id} 直到 done / failed / 超时。
   */
  async function pollBatch({ batchId, deadline, runSignal, report }) {
    let delay = pollIntervalMs;
    let polls = 0;
    for (;;) {
      if (Date.now() >= deadline) {
        throw timeoutError(batchId, timeoutMs);
      }
      let json;
      try {
        json = await requestJson(`/extract-results/batch/${encodeURIComponent(batchId)}`, { signal: runSignal });
      } catch (err) {
        if (err?.code === 'MMGREP_DOC_TIMEOUT') throw timeoutError(batchId, timeoutMs);
        throw err;
      }
      const data = json?.data ?? {};
      // 官方文档写 data.extract_result 是数组；为兼容其他实现，对象 / data.results 也接受。
      const rawResults = data.extract_result ?? data.results;
      const results = Array.isArray(rawResults)
        ? rawResults
        : rawResults && typeof rawResults === 'object'
          ? [rawResults]
          : Array.isArray(data)
            ? data
            : [];
      const entry = pickResultEntry(results);
      const state = String(entry?.state ?? '').toLowerCase();
      polls += 1;

      if (state === 'done') {
        const zipUrl =
          entry?.full_zip_url ?? entry?.zip_url ?? entry?.fullZipUrl ?? data.full_zip_url ?? data.zip_url ?? null;
        return { state, zipUrl, errMsg: entry?.err_msg ?? '' };
      }
      if (state === 'failed' || state === 'expired' || state === 'error' || state === 'cancelled') {
        return { state, zipUrl: null, errMsg: entry?.err_msg ?? '' };
      }
      if (state === 'pending' || state === 'running' || state === 'converting' || state === 'waiting-file' || state === '') {
        const progress = entry?.extract_progress ?? {};
        const detail =
          state === '' ? 'Waiting for MinerU to pick up the job...' : `MinerU state=${state} (poll #${polls})`;
        report('parsing', `${detail}${progress.total_pages ? `, ${progress.extracted_pages ?? 0}/${progress.total_pages} pages parsed` : ''}`);
      } else {
        report('parsing', `MinerU state=${state} (poll #${polls})`);
      }

      if (Date.now() + delay >= deadline) {
        throw timeoutError(batchId, timeoutMs);
      }
      try {
        await sleep(delay, runSignal);
      } catch {
        if (runSignal?.aborted) {
          if (runSignal.reason?.code === 'MMGREP_DOC_TIMEOUT') throw timeoutError(batchId, timeoutMs);
          throw new Error('MinerU parse was aborted by the caller.');
        }
        throw new Error('MinerU parse was interrupted while waiting for the job.');
      }
      delay = Math.min(POLL_MAX_MS, Math.round(delay * POLL_FACTOR * (1 + (Math.random() * 2 - 1) * POLL_JITTER)));
    }
  }
}

/* ------------------------------------------------------------------ *
 * 纯函数工具
 * ------------------------------------------------------------------ */

const DOC_ROLES = Object.freeze(['ocr', 'typeset', 'both']);
const OCR_MODES = Object.freeze(['auto', 'force']);

function normalizeRole(value) {
  const role = String(value ?? '').trim().toLowerCase();
  if (!DOC_ROLES.includes(role)) {
    throw new Error(`Invalid document provider role "${value ?? ''}". Supported roles: ${DOC_ROLES.join(', ')}.`);
  }
  return role;
}

function normalizeOcrMode(value) {
  const mode = String(value ?? 'auto').trim().toLowerCase();
  if (!OCR_MODES.includes(mode)) {
    throw new Error(`Invalid ocrMode "${value ?? ''}". Supported values: ${OCR_MODES.join(', ')}.`);
  }
  return mode;
}

function roleEnvHint(role) {
  if (role === 'ocr') return 'MMGREP_OCR_PROVIDER=mineru';
  if (role === 'typeset') return 'MMGREP_TYPESET_PROVIDER=mineru';
  return 'MMGREP_OCR_PROVIDER=mineru or MMGREP_TYPESET_PROVIDER=mineru';
}

/**
 * typeset 角色的硬约束：MinerU 必须跑 pipeline，且不能强制 OCR。
 *
 * 为什么是**硬错误**而不是 warning：typeset 角色一旦走 VLM（model_version=vlm），
 * 就是读页图重新识别字符，字符可能被改写；继续返回结果会让后端把 OCR 文本
 * 当成「可原话引用」的文字层。报错后文档后端会回退到原生文字层（textOrigin
 * textlayer），并给出一条 warning，数据不会静默变差。
 */
function assertRoleConfig({ role, ocrMode, model }) {
  const modelId = normalizeModelId(model);
  if (role === 'typeset' && ocrMode === 'force') {
    throw new Error(
      'MinerU cannot serve the typeset role with ocrMode "force": the typeset role must preserve the PDF text layer ' +
        'and must never re-recognize characters. Use role "ocr" for forced re-OCR (the document backend does this ' +
        'when the caller asks for ocr: "force").',
    );
  }
  if ((role === 'typeset' || role === 'both') && modelId && modelId !== 'pipeline') {
    throw new Error(
      `MinerU cannot serve the ${role} role with MMGREP_MINERU_MODEL="${model}": the typeset role must preserve ` +
        'the PDF text layer, but model_version=vlm reads page images (effectively OCR) and other model versions ' +
        'do not guarantee native text extraction. Set MMGREP_MINERU_MODEL=pipeline (MinerU\'s default) or the ' +
        'x-mmgrep-mineru-model request header to pipeline, or set ' +
        'MMGREP_TYPESET_PROVIDER=builtin / none for pages that have a text layer.',
    );
  }
}

function normalizeModelId(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** 本次请求实际发送的 model_version。typeset / both 角色显式钉在 pipeline。 */
function modelForRequest(role, model) {
  if (role === 'typeset' || role === 'both') return 'pipeline';
  const value = String(model ?? '').trim();
  return value || undefined;
}

/**
 * 把调用方传入的 textLayers 规整成「有文字层的页码集合」（1 起）。
 *
 * 文档后端在 role: 'both' 时会把有文字层的页以 `{ [page]: text }` 传进来，
 * 用来把一次 MinerU 请求的结果按页拆成 textlayer / ocr。没传（undefined）
 * 返回 null —— 与「传了空对象」不同：后者表示确定没有文字层页。
 */
function textPageSetFrom(textLayers) {
  if (textLayers === undefined || textLayers === null) return null;
  const pages = new Set();
  const add = (value) => {
    const page = Number(value);
    if (Number.isInteger(page) && page >= 1) pages.add(page);
  };
  if (textLayers instanceof Map) {
    for (const key of textLayers.keys()) add(key);
  } else if (Array.isArray(textLayers)) {
    for (const entry of textLayers) add(entry?.page);
  } else if (typeof textLayers === 'object') {
    for (const key of Object.keys(textLayers)) add(key);
  } else {
    return null;
  }
  return pages;
}

/** 解析结果包里的解析模式，归一成 'txt'（文字层）/ 'ocr'，未知返回 null。 */
function normalizeParseMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  if (mode === 'ocr') return 'ocr';
  if (mode === 'txt' || mode === 'text' || mode === 'textlayer' || mode === 'text_layer') return 'txt';
  return null;
}

/**
 * 从结果包里读解析模式（如果有）。
 *
 * 官方 4.x 的 middle.json 在 `extensions.mineru.parse_mode` 记录最终模式（txt/ocr，
 * 不存 auto），历史 / 本地构建也可能在逐页对象上留 `_parse_type`。云端 API v4
 * （2026-11-02 实测 MinerU 3.4.4）**没有**任何解析模式字段：zip 里连 middle.json
 * 都没有，layout.json 只有 `_backend` / `_version_name`。所以这里只是「有就采信」，
 * 没有就交给角色 / 配置推断（见 resolveTextOrigin）。
 *
 * @returns {{documentMode: 'txt'|'ocr'|null, pageModes: Map<number,'txt'|'ocr'>}}
 */
function readPackageParseModes(entries) {
  const pageModes = new Map();
  let documentMode = null;

  // middle.json 优先于 layout.json；layout 的 _backend 不是解析模式，别误读。
  const names = [...entries.keys()]
    .filter((name) => /(?:^|\/)(?:\S*_)?(?:middle|layout)\.json$/i.test(name))
    .sort((a, b) => Number(/middle\.json$/i.test(b)) - Number(/middle\.json$/i.test(a)));

  for (const name of names) {
    const raw = entries.get(name).toString('utf8');
    // layout.json 可能很大；没有解析模式字段时不必 JSON.parse。
    if (!/"?_?parse_(?:mode|type)"?\s*:/.test(raw)) continue;
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      continue; // 可选元数据：坏了不影响正文抽取
    }
    if (!json || typeof json !== 'object') continue;

    if (!documentMode) {
      documentMode = normalizeParseMode(
        json.extensions?.mineru?.parse_mode ?? json.parse_mode ?? json._parse_type ?? json.parse_type,
      );
    }

    const pageList = Array.isArray(json.pages)
      ? json.pages
      : Array.isArray(json.pdf_info)
        ? json.pdf_info
        : Array.isArray(json.page_info)
          ? json.page_info
          : null;
    if (!pageList) continue;
    for (let index = 0; index < pageList.length; index += 1) {
      const page = pageList[index];
      if (!page || typeof page !== 'object') continue;
      const rawIdx = page.page_idx ?? page.pageIndex ?? page.index ?? index;
      const idx = Number(rawIdx);
      if (!Number.isInteger(idx) || idx < 0) continue;
      const mode = normalizeParseMode(page._parse_type ?? page.parse_mode ?? page.parse_type);
      // middle 先处理：已有值时不覆盖，避免 layout 的旧字段盖掉 canonical 值。
      if (mode && !pageModes.has(idx)) pageModes.set(idx, mode);
    }
  }

  return { documentMode, pageModes };
}

/**
 * 单页的 textOrigin。
 *
 * 依据（9z5.29 核实 + 2026-11-02 真实 API 实测）：
 *   1. 空文本 → unknown（没有字符来源可言）。
 *   2. force → ocr：调用方明确要求重新识别；即便结果包自称 txt 也按保守值标 OCR。
 *   3. model_version=vlm → ocr：VLM 读页图，字符来自识别。
 *   4. 结果包显式给出 parse_mode / _parse_type：txt → textlayer，ocr → ocr。
 *   5. typeset 角色（pipeline + is_ocr=false）→ textlayer：官方文档 + 实测确认
 *      有文字层的页保留原始字符（见 README §4 的核对记录）。
 *   6. 后端把某页列为「有文字层页」（textLayers 里有）→ textlayer。
 *   7. ocr 角色 → ocr；both 角色且后端给了文字层页集合时，集合外的页 → ocr
 *      （这些页没有文字层，MinerU 在 auto 下也会 OCR，实测第 28 页如此）。
 *   8. 其余（both 且拿不到逐页文字层信息）→ unknown（保守；下游按 OCR 处理）。
 */
function resolveTextOrigin({
  pageIdx,
  page,
  hasText,
  role,
  ocrMode,
  model,
  textPages,
  parseModes,
  defaultOrigin = 'unknown',
}) {
  if (!hasText) return 'unknown';
  if (ocrMode === 'force') return 'ocr';
  if (normalizeModelId(model) === 'vlm') return 'ocr';

  const packageMode = parseModes?.pageModes?.get(pageIdx) ?? parseModes?.documentMode ?? null;
  if (packageMode === 'ocr') return 'ocr';
  if (packageMode === 'txt') return 'textlayer';

  if (role === 'typeset') return 'textlayer';
  if (textPages?.has(page)) return 'textlayer';
  if (role === 'ocr') return 'ocr';
  if (role === 'both' && textPages) return 'ocr';
  return defaultOrigin;
}

function normalizeTimeoutMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : MINERU_DEFAULT_TIMEOUT_MS;
}

function normalizePollInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return POLL_FIRST_MS;
  return Math.max(1, Math.min(n, POLL_MAX_MS));
}

/**
 * 把外部传入的页范围规整成「1 起的、升序、去重」的页码数组；返回 null 表示全量。
 *
 * 支持的写法：
 *   - undefined / null            → 全量（null）
 *   - { from, to }                → 闭区间（也接受 start/end）
 *   - [from, to]                  → 闭区间（长度为 2 的数组按区间解释）
 *   - 5                           → 单页
 *   - { list: [1, 3, 5] }         → 离散页列表（也接受 { pages: [...] }）
 */
export function normalizePageList(pages) {
  if (pages === undefined || pages === null || pages === '') return null;

  let list = [];
  if (typeof pages === 'number') {
    list = [pages];
  } else if (Array.isArray(pages)) {
    if (pages.length === 2 && pages.every((n) => typeof n === 'number')) {
      list = rangeToList(pages[0], pages[1]);
    } else {
      list = pages.slice();
    }
  } else if (typeof pages === 'object') {
    const from = pages.from ?? pages.start ?? pages.first;
    const to = pages.to ?? pages.end ?? pages.last;
    if (typeof from === 'number' && typeof to === 'number') {
      list = rangeToList(from, to);
    } else if (typeof from === 'number') {
      list = [from];
    } else if (Array.isArray(pages.list)) {
      list = pages.list.slice();
    } else if (Array.isArray(pages.pages)) {
      list = pages.pages.slice();
    } else {
      throw new Error(
        'Invalid page range for the document provider. Use {from, to}, [from, to], a page number, or {list: [...]}.',
      );
    }
  } else {
    throw new Error(
      'Invalid page range for the document provider. Use {from, to}, [from, to], a page number, or {list: [...]}.',
    );
  }

  const out = [];
  for (const n of list) {
    const v = Number(n);
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`Invalid page number in the requested range: ${n} (pages are 1-based).`);
    }
    out.push(v);
  }
  out.sort((a, b) => a - b);
  return [...new Set(out)];
}

function rangeToList(from, to) {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) {
    throw new Error(`Invalid page range: ${from}-${to} (pages are 1-based integers).`);
  }
  if (b < a) return [];
  const out = [];
  for (let i = a; i <= b; i += 1) out.push(i);
  return out;
}

/** 把页码数组切成每份最多 maxSize 页的若干批。 */
export function chunkPageList(list, maxSize = MINERU_MAX_PAGES) {
  const chunks = [];
  for (let i = 0; i < list.length; i += maxSize) chunks.push(list.slice(i, i + maxSize));
  return chunks;
}

/** 把页码数组编码成 MinerU 的 page_ranges 字符串，例如 [1,2,3,5] → "1-3,5"。 */
export function toPageRanges(list) {
  const parts = [];
  let i = 0;
  while (i < list.length) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j += 1;
    parts.push(i === j ? `${list[i]}` : `${list[i]}-${list[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}

/** 从批量结果里挑出属于本次文件的那一条（单文件批次只有一条，取第一条即可）。 */
function pickResultEntry(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  return results[0];
}

/** 读取业务层错误（code != 0 或 success === false）。 */
function readEnvelopeError(json) {
  if (!json || typeof json !== 'object') return null;
  const code = json.code;
  if (typeof code === 'number' && code !== 0) {
    return formatApiCode(code, json.msg);
  }
  if (typeof code === 'string' && code !== '' && code !== '0') {
    return formatApiCode(code, json.msg);
  }
  if (json.success === false) {
    return formatApiCode(json.msgCode ?? json.code ?? 'unknown', json.msg);
  }
  if (typeof json.msgCode === 'string' && json.msgCode && json.data === undefined) {
    return formatApiCode(json.msgCode, json.msg);
  }
  return null;
}

function formatApiCode(code, msg) {
  const hint = API_CODE_HINTS[String(code)];
  return `${code}${msg ? `: ${msg}` : ''}${hint ? ` (${hint})` : ''}`;
}

/** 组装 HTTP 层错误信息。 */
function httpErrorMessage(res, json, rawText) {
  let detail = '';
  if (json && typeof json === 'object') {
    const code = json.code ?? json.msgCode;
    const msg = json.msg ?? json.message ?? '';
    detail = [code !== undefined ? `code=${code}` : '', msg].filter(Boolean).join(' ');
  } else if (rawText) {
    detail = rawText.slice(0, 400);
  }
  let hint = '';
  if (res.status === 401 || res.status === 403) {
    hint = ' — authentication failed, check MMGREP_MINERU_API_KEY (token) and its validity';
  } else if (res.status === 404) {
    hint = ' — endpoint not found, check MMGREP_MINERU_BASE_URL';
  } else if (res.status === 429) {
    hint = ' — rate limited or daily quota exhausted';
  } else if (res.status >= 500) {
    hint = ' — MinerU server error, retry later';
  }
  return `MinerU HTTP ${res.status} ${res.statusText}${hint}${detail ? `: ${detail}` : ''}`;
}

function timeoutError(batchId, timeoutMs) {
  const batch = batchId ? ` (batch_id=${batchId})` : '';
  const err = new Error(
    `MinerU parse timed out after ${timeoutMs}ms${batch}. The job may still be running on the MinerU side; ` +
      'retry later or raise MMGREP_DOC_TIMEOUT_MS.',
  );
  err.code = 'MMGREP_DOC_TIMEOUT';
  return err;
}

/** 把 abort 转成可读错误（区分超时与调用方主动取消）。 */
function abortError(method, label) {
  return new Error(`MinerU request was aborted (${method} ${label}).`);
}

/** 合并调用方的 AbortSignal 与内部超时信号。 */
function combineSignals(callerSignal, deadline) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort(Object.assign(new Error('timeout'), { code: 'MMGREP_DOC_TIMEOUT' }));
  }, Math.max(1, deadline - Date.now()));
  if (typeof timer.unref === 'function') timer.unref();

  const onCallerAbort = () => {
    controller.abort(Object.assign(new Error('aborted'), { code: 'MMGREP_DOC_ABORTED' }));
  };

  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      callerSignal?.removeEventListener?.('abort', onCallerAbort);
    },
  };
}

/** 可被 AbortSignal 打断的 sleep。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/* ------------------------------------------------------------------ *
 * zip 读取（零依赖：中央目录 + local header + inflateRaw）
 * ------------------------------------------------------------------ */

/**
 * 读取 zip 里的全部条目，返回 Map<name, Buffer>。
 * 只支持 store(0) 与 deflate(8) 两种压缩方式；不支持加密与 zip64。
 */
export function readZipEntries(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('Not a valid zip archive: end of central directory record not found.');

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error('Zip64 archives are not supported by the minimal zip reader.');
  }

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('Corrupt zip archive: bad central directory entry.');
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x0001) continue; // 加密条目，跳过
    if (name.endsWith('/')) continue; // 目录条目
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Corrupt zip archive: bad local header for "${name}".`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, Math.min(buf.length, dataStart + compSize));
    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw);
      } catch (err) {
        throw new Error(`Failed to inflate zip entry "${name}": ${err?.message || err}`);
      }
    } else {
      throw new Error(`Unsupported zip compression method ${method} for entry "${name}".`);
    }
    entries.set(name, data);
  }
  return entries;
}

/** 从尾部往前找 EOCD 签名（注释最长 65535 字节）。 */
function findEndOfCentralDirectory(buf) {
  const minPos = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * 结果包 → 页面
 * ------------------------------------------------------------------ */

/**
 * 解包 MinerU 的结果 zip，产出契约 v2 的页面数组。
 *
 * @param {Buffer} zipBuffer 结果 zip。
 * @param {object} [opts]
 * @param {number[]|null} [opts.range] 本批次请求的页码列表（1 起），用于过滤与页码基准判定。
 * @param {'ocr'|'typeset'|'both'} [opts.role] 本次请求的角色。
 * @param {'auto'|'force'} [opts.ocrMode] 本次请求的 OCR 模式。
 * @param {string} [opts.model] 配置的 model_version。
 * @param {Set<number>|null} [opts.textPages] 有文字层的页码集合（后端 route 输入）。
 * @param {'textlayer'|'ocr'|'unknown'} [opts.textOrigin] 旧接口的兜底值。
 *
 * 页码基准：content_list.json 里的 page_idx 是 0 基的原始页索引
 * （官方文档说明「抽页后保留原始页索引」），所以页码 = page_idx + 1。
 * 为了兼容「服务端按切片重新编号」的实现，若整批返回的 page_idx 都落在
 * [0, 范围长度-1] 内且落在 [起始页-1, 结束页-1] 之外，则按相对页码处理。
 * 云端 API v4 实测确实会相对编号（请求 4,28 返回 page_idx 0,1）。
 */
export function extractPagesFromZip(
  zipBuffer,
  {
    range = null,
    textOrigin = 'unknown',
    role = 'both',
    ocrMode = 'auto',
    model = '',
    textPages = null,
  } = {},
) {
  const entries = readZipEntries(zipBuffer);
  const parseModes = readPackageParseModes(entries);
  const originOptions = {
    role,
    ocrMode,
    model,
    textPages,
    parseModes,
    defaultOrigin: textOrigin,
  };

  const contentListName = pickContentListName(entries);
  let pages = [];

  if (contentListName) {
    const items = parseJsonEntry(entries.get(contentListName), contentListName);
    pages = itemsToPages(items, { range, ...originOptions });
  } else {
    // 兜底：没有 content_list.json 时用 full.md（无法确定分页，整篇算作一页）。
    const mdName = pickMarkdownName(entries);
    if (!mdName) {
      throw new Error(
        'MinerU result package contains neither content_list.json nor full.md; cannot extract document text.',
      );
    }
    const text = entries.get(mdName).toString('utf8');
    const page = range && range.length ? range[0] : 1;
    const blocks = textToBlocks(text);
    pages = [{
      page,
      textOrigin: resolveTextOrigin({
        pageIdx: page - 1,
        page,
        hasText: blocks.length > 0,
        ...originOptions,
      }),
      blocks,
      text: blocksToText(blocks),
      tables: [],
    }];
  }

  // 只保留请求范围内的页。
  if (range && range.length) {
    const wanted = new Set(range);
    pages = pages.filter((p) => wanted.has(p.page));
  }
  return pages.sort((a, b) => a.page - b.page);
}

function pickContentListName(entries) {
  const names = [...entries.keys()];
  const exact = names.find((n) => /(?:^|\/)content_list\.json$/i.test(n));
  if (exact) return exact;
  return names.find((n) => /(?:^|\/)\S*_content_list\.json$/i.test(n)) ?? null;
}

function pickMarkdownName(entries) {
  const names = [...entries.keys()];
  return names.find((n) => /(?:^|\/)full\.md$/i.test(n)) ?? names.find((n) => /\.md$/i.test(n)) ?? null;
}

function parseJsonEntry(buffer, name) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    throw new Error(`Failed to parse "${name}" from the MinerU result package: ${err?.message || err}`);
  }
}

/**
 * 把 content_list 的条目按页聚合成契约 v2 的页面。
 *
 * blocks 映射（9z5.29）：
 *   text + text_level → heading（level = text_level）；title → heading（默认 level 1）
 *   text              → paragraph
 *   list / index      → list
 *   table             → table（结构化数据仍放在页面的 tables 里）
 *   image / chart     → caption（image_caption / chart_caption）
 *   equation          → equation
 *   page_footnote     → footnote
 *   其它带 text 的条目 → paragraph（code 等契约里没有的类型）
 *
 * text 字段由 blocks 派生（blocksToText），两者不一致时以 blocks 为准。
 */
function itemsToPages(items, {
  range,
  role,
  ocrMode,
  model,
  textPages,
  parseModes,
  defaultOrigin,
}) {
  if (!Array.isArray(items)) {
    throw new Error('MinerU content_list.json is not a JSON array.');
  }

  const byPage = new Map(); // pageIdx -> { blocks: [], tables: [] }
  const pageIdxs = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rawIdx = item.page_idx ?? item.pageIndex ?? item.page_index ?? item.page;
    const idx = Number(rawIdx);
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (!byPage.has(idx)) {
      byPage.set(idx, { blocks: [], tables: [] });
      pageIdxs.push(idx);
    }
    const bucket = byPage.get(idx);
    const type = String(item.type ?? '').toLowerCase();

    if (type === 'table') {
      const table = buildTable(item);
      bucket.tables.push(table);
      const parts = [table.caption, tableRowsToText(table.rows), table.footnote].filter(Boolean);
      if (parts.length) bucket.blocks.push({ type: 'table', text: parts.join('\n') });
      continue;
    }
    bucket.blocks.push(...itemToBlocks(item));
  }

  const pages = [];
  for (const [idx, bucket] of byPage) {
    const blocks = bucket.blocks;
    const page = pageNumberFor(idx, pageIdxs, range);
    pages.push({
      page,
      textOrigin: resolveTextOrigin({
        pageIdx: idx,
        page,
        hasText: blocks.length > 0,
        role,
        ocrMode,
        model,
        textPages,
        parseModes,
        defaultOrigin,
      }),
      blocks,
      text: blocksToText(blocks),
      tables: bucket.tables,
    });
  }
  return pages;
}

/**
 * 一条 content_list 条目 → 0..n 个契约 v2 block。
 * table 在 itemsToPages 里单独处理（还要收集结构化 tables）。
 */
function itemToBlocks(item) {
  const type = String(item.type ?? '').toLowerCase();
  switch (type) {
    case 'text': {
      const text = stringOf(item.text);
      if (!text) return [];
      const level = headingLevel(item);
      return level ? [{ type: 'heading', level, text }] : [{ type: 'paragraph', text }];
    }
    case 'title': {
      const text = stringOf(item.text);
      if (!text) return [];
      return [{ type: 'heading', level: headingLevel(item) ?? 1, text }];
    }
    case 'list':
    case 'index': {
      const text = stringList(item.list_items ?? item.items).join('\n');
      return text ? [{ type: 'list', text }] : [];
    }
    case 'image':
      return [...captionBlocks(item.image_caption), ...footnoteBlocks(item.image_footnote)];
    case 'chart':
      return [
        ...captionBlocks(item.chart_caption),
        ...paragraphBlocks(item.content),
        ...footnoteBlocks(item.chart_footnote),
      ];
    case 'equation': {
      const text = stringOf(item.text ?? item.latex ?? item.equation);
      return text ? [{ type: 'equation', text }] : [];
    }
    case 'page_footnote':
    case 'footnote': {
      const text = stringOf(item.text);
      return text ? [{ type: 'footnote', text }] : [];
    }
    case 'caption': {
      const text = stringList(item.text ?? item.caption).join('\n');
      return text ? [{ type: 'caption', text }] : [];
    }
    default: {
      // code / header / footer / page_number / aside_text 等：契约里没有对应类型，
      // 保留文字（itemToText 会拼接 code_body / code_caption 等字段）。
      const text = itemToText(item);
      return text ? [{ type: 'paragraph', text }] : [];
    }
  }
}

function headingLevel(item) {
  const level = Number(item?.text_level ?? item?.level);
  return Number.isInteger(level) && level > 0 ? level : null;
}

function stringOf(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function stringList(value) {
  if (Array.isArray(value)) return value.map((entry) => stringOf(entry)).filter(Boolean);
  const text = stringOf(value);
  return text ? [text] : [];
}

function captionBlocks(value) {
  const text = stringList(value).join('\n');
  return text ? [{ type: 'caption', text }] : [];
}

function footnoteBlocks(value) {
  const text = stringList(value).join('\n');
  return text ? [{ type: 'footnote', text }] : [];
}

function paragraphBlocks(value) {
  const text = stringOf(value);
  return text ? [{ type: 'paragraph', text }] : [];
}

/**
 * content_list 的 page_idx → 真实页码（1 起）。
 *
 * 正常情况（官方语义：抽页后保留原始页索引）页码 = page_idx + 1。
 * 兼容另一种实现：服务端把本批切片重新从 0 编号。此时 page_idx 是本批请求页列表的
 * **下标**，页码 = range[page_idx]（离散页列表也成立；不能简单加 start-1，否则请求
 * [4,28] 会把第 28 页算成第 6 页）。判断依据：page_idx 全部落在
 * [0, range.length-1] 且没有全部落在绝对区间 [start-1, end-1] 内。
 */
function pageNumberFor(idx, pageIdxs, range) {
  if (!range || !range.length || !pageIdxs.length) return idx + 1;
  const start = range[0];
  const end = range[range.length - 1];
  const allWithinAbsolute = pageIdxs.every((i) => i >= start - 1 && i <= end - 1);
  if (allWithinAbsolute) return idx + 1;
  const allWithinRelative = pageIdxs.every((i) => i >= 0 && i < range.length);
  if (!allWithinRelative) return idx + 1;
  const mapped = range[idx];
  return Number.isInteger(mapped) ? mapped : idx + 1;
}

/** 把一条 content_list 条目转成纯文本。 */
function itemToText(item) {
  const type = String(item.type ?? '').toLowerCase();
  const join = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).join('\n') : '');
  switch (type) {
    case 'text':
    case 'equation':
    case 'page_footnote':
      return typeof item.text === 'string' ? item.text : '';
    case 'list':
    case 'index':
      return join(item.list_items);
    case 'image':
      return [join(item.image_caption), join(item.image_footnote)].filter(Boolean).join('\n');
    case 'chart':
      return [join(item.chart_caption), join(item.chart_footnote), item.content || ''].filter(Boolean).join('\n');
    case 'code':
      return [item.code_body || '', join(item.code_caption)].filter(Boolean).join('\n');
    case 'table':
      return [join(item.table_caption), join(item.table_footnote)].filter(Boolean).join('\n');
    default:
      return typeof item.text === 'string' ? item.text : '';
  }
}

/** 把 table 条目转成结构化表格。 */
function buildTable(item) {
  const html = typeof item.table_body === 'string' ? item.table_body : '';
  const rows = parseHtmlTableRows(html);
  const caption = Array.isArray(item.table_caption) ? item.table_caption.filter(Boolean).join('\n') : '';
  const footnote = Array.isArray(item.table_footnote) ? item.table_footnote.filter(Boolean).join('\n') : '';
  return { rows, html, caption, footnote };
}

/** 把表格 HTML 解析成二维数组。 */
export function parseHtmlTableRows(html) {
  const rows = [];
  if (typeof html !== 'string' || !html) return rows;
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let trMatch;
  while ((trMatch = trRe.exec(html)) !== null) {
    const cells = [];
    cellRe.lastIndex = 0;
    let cellMatch;
    while ((cellMatch = cellRe.exec(trMatch[1])) !== null) {
      cells.push(decodeEntities(stripTags(cellMatch[2])));
    }
    rows.push(cells);
  }
  return rows;
}

function tableRowsToText(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  return rows.map((row) => (Array.isArray(row) ? row.join(' | ') : String(row))).join('\n');
}

function stripTags(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|tr)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}
