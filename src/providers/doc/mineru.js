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
 *      zip 内含 full.md、layout.json、*_model.json、*_content_list.json、images/。
 *
 * 字段兼容说明（对不确定的字段做兜底）：
 *   - 结果数组：data.extract_result ?? data.results ?? data.extract_result[]
 *   - 结果包地址：full_zip_url ?? zip_url
 *   - content_list 文件名：content_list.json 或 <name>_content_list.json
 *   - 页码字段：page_idx（0 基）
 */

import { stat, readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

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
  A0202: 'token is invalid — check MMGREP_DOC_API_KEY',
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
 * @param {number} [options.timeoutMs] 整体超时，默认 300000。
 * @param {Function} [options.fetchImpl] 注入的 fetch 实现（测试用）。
 * @param {Function} [options.onProgress] 进度回调 ({stage, detail}) => void 。
 * @param {boolean} [options.isOcr] 是否开启 OCR，默认 true（本 provider 主要用于扫描件）。
 * @param {number} [options.pollIntervalMs] 首次轮询间隔，默认 1500ms（测试可调小）。
 */
export function createMineruDocProvider(options = {}) {
  const opts = options ?? {};
  const apiKey = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
  const baseUrl = String(opts.baseUrl || MINERU_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const model = typeof opts.model === 'string' ? opts.model.trim() : '';
  const timeoutMs = normalizeTimeoutMs(opts.timeoutMs);
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  const constructorOnProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const isOcr = opts.isOcr === undefined ? true : Boolean(opts.isOcr);
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

    /**
     * 解析本地文档。
     *
     * @param {{filePath: string, pages?: any, signal?: AbortSignal}} input
     * @param {{onProgress?: Function}} [callOptions] 单次调用的进度回调，优先于构造时的 onProgress 。
     * @returns {Promise<{provider: string, model: string|null, pages: Array<{page: number, text: string, tables?: Array<object>}>, raw?: object}>}
     */
    async parse(input = {}, callOptions = {}) {
      const { filePath, pages, signal } = input ?? {};
      const onProgress =
        typeof callOptions?.onProgress === 'function' ? callOptions.onProgress : constructorOnProgress;

      if (!apiKey) {
        throw new Error(
          'MinerU document provider is enabled (MMGREP_DOC_PROVIDER=mineru) but MMGREP_DOC_API_KEY is missing. ' +
            'Set MMGREP_DOC_API_KEY to a MinerU token (create one at https://mineru.net/apiManage/token), ' +
            'or unset MMGREP_DOC_PROVIDER to fall back to page-image-only mode.',
        );
      }
      if (typeof fetchImpl !== 'function') {
        throw new Error('MinerU document provider requires a fetch implementation (global fetch is unavailable).');
      }
      if (!filePath || typeof filePath !== 'string') {
        throw new Error('MinerU document provider requires a filePath.');
      }

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

        const merged = new Map(); // page -> { page, text, tables }
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
          });
          batchIds.push(result.batchId);
          for (const page of result.pages) {
            const existing = merged.get(page.page);
            if (existing) {
              existing.text = [existing.text, page.text].filter(Boolean).join('\n');
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
      return { id: 'mineru', model: model || null, baseUrl };
    },
  };

  /**
   * 跑完一个批次：申请上传地址 → PUT 上传 → 轮询 → 下载结果包 → 解包出页面。
   */
  async function runOneBatch({ filePath, bytes, pageRanges, chunk, requested, deadline, runSignal, report }) {
    // ---- 第 1 步：申请预签名上传地址 ----
    report('requesting', 'Requesting a MinerU upload URL...');
    const fileName = filePath.split(/[\\/]/).pop() || 'document.pdf';
    const fileEntry = { name: fileName };
    if (isOcr) fileEntry.is_ocr = true;
    if (pageRanges) fileEntry.page_ranges = pageRanges;
    const requestBody = { files: [fileEntry] };
    if (model) requestBody.model_version = model;

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
    const pages = extractPagesFromZip(zipBuffer, { range: chunk ?? requested });
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
    hint = ' — authentication failed, check MMGREP_DOC_API_KEY (token) and its validity';
  } else if (res.status === 404) {
    hint = ' — endpoint not found, check MMGREP_DOC_BASE_URL';
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
 * 解包 MinerU 的结果 zip，产出页面数组。
 *
 * @param {Buffer} zipBuffer 结果 zip。
 * @param {{range?: number[]|null}} [opts] range 是本批次请求的页码列表（1 起），用于过滤与页码基准判定。
 *
 * 页码基准：content_list.json 里的 page_idx 是 0 基的原始页索引
 * （官方文档说明「抽页后保留原始页索引」），所以页码 = page_idx + 1。
 * 为了兼容「服务端按切片重新编号」的实现，若整批返回的 page_idx 都落在
 * [0, 范围长度-1] 内且落在 [起始页-1, 结束页-1] 之外，则按相对页码处理。
 */
export function extractPagesFromZip(zipBuffer, { range = null } = {}) {
  const entries = readZipEntries(zipBuffer);

  const contentListName = pickContentListName(entries);
  let pages = [];

  if (contentListName) {
    const items = parseJsonEntry(entries.get(contentListName), contentListName);
    pages = itemsToPages(items, { range });
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
    pages = [{ page, text, tables: [] }];
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

/** 把 content_list 的条目按页聚合成页面。 */
function itemsToPages(items, { range }) {
  if (!Array.isArray(items)) {
    throw new Error('MinerU content_list.json is not a JSON array.');
  }

  const byPage = new Map(); // pageIdx -> { textParts: [], tables: [] }
  const pageIdxs = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rawIdx = item.page_idx ?? item.pageIndex ?? item.page_index ?? item.page;
    const idx = Number(rawIdx);
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (!byPage.has(idx)) {
      byPage.set(idx, { textParts: [], tables: [] });
      pageIdxs.push(idx);
    }
    const bucket = byPage.get(idx);

    const type = String(item.type ?? '').toLowerCase();
    if (type === 'table') {
      const table = buildTable(item);
      bucket.tables.push(table);
      const parts = [table.caption, tableRowsToText(table.rows), table.footnote].filter(Boolean);
      if (parts.length) bucket.textParts.push(parts.join('\n'));
      continue;
    }
    const text = itemToText(item);
    if (text) bucket.textParts.push(text);
  }

  const offset = computePageOffset(pageIdxs, range);

  const pages = [];
  for (const [idx, bucket] of byPage) {
    pages.push({
      page: idx + 1 + offset,
      text: bucket.textParts.join('\n').trim(),
      tables: bucket.tables,
    });
  }
  return pages;
}

/**
 * 计算页码偏移量。
 *
 * 正常情况（官方语义：抽页后保留原始页索引）偏移为 0，页码 = page_idx + 1。
 * 兼容另一种实现：服务端把切片重新从 0 编号，此时 page_idx ∈ [0, 范围长度-1]，
 * 且不可能全部落在 [起始页-1, 结束页-1] 内 → 按相对页码换算，偏移 = 起始页 - 1。
 */
function computePageOffset(pageIdxs, range) {
  if (!range || !range.length || !pageIdxs.length) return 0;
  const start = range[0];
  const end = range[range.length - 1];
  const allWithinAbsolute = pageIdxs.every((i) => i >= start - 1 && i <= end - 1);
  if (allWithinAbsolute) return 0;
  const rangeLength = end - start + 1;
  const allWithinRelative = pageIdxs.every((i) => i >= 0 && i < rangeLength);
  return allWithinRelative ? start - 1 : 0;
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
