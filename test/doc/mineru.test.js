/**
 * MinerU 文档解析 provider 的测试。
 *
 * 全程离线：用 node:http 起一个本地 stub server 模拟 MinerU 云 API 的四步流程
 * （申请上传地址 → PUT 上传 → 轮询 → 下载结果包），zip 也是测试里现造的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMineruDocProvider } from '../../src/providers/doc/mineru.js';

/* ------------------------------------------------------------------ *
 * 最小 zip 构造器（store/deflate 都支持）
 * ------------------------------------------------------------------ */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/**
 * 造一个真实可读的 zip。
 * @param {Array<{name: string, data: string|Buffer}>} files
 */
function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const crc = crc32(data);
    const compressed = deflateRawSync(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method = deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(8, 10); // method
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

/* ------------------------------------------------------------------ *
 * 本地 stub server
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

/**
 * @param {object} [config]
 * @param {Array<object>} [config.pollResponses] 依次返回的轮询条目（用完重复最后一个）
 * @param {Function}  [config.zipFor] (batchId, requestBody) => Buffer
 * @param {number}    [config.requestStatus] 申请上传地址时的 HTTP 状态
 * @param {number}    [config.requestBody] 申请上传地址时的响应体
 */
async function startStub(config = {}) {
  const calls = [];
  const batchBodies = new Map();
  let batchCounter = 0;
  let pollCount = 0;
  const state = {
    pollResponses: config.pollResponses ?? [{ state: 'done' }],
    zipFor: config.zipFor,
    requestStatus: config.requestStatus ?? 200,
    requestBody: config.requestBody,
    uploadStatus: config.uploadStatus ?? 200,
    zipStatus: config.zipStatus ?? 200,
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://127.0.0.1');
      // provider 的 baseUrl 是 http://host/api/v4，这里剥掉前缀后再路由。
      const apiPath = url.pathname.startsWith('/api/v4') ? url.pathname.slice('/api/v4'.length) : url.pathname;
      calls.push({
        method: req.method,
        path: url.pathname,
        headers: { ...req.headers },
        body: raw.toString('utf8'),
      });

      if (req.method === 'POST' && apiPath === '/file-urls/batch') {
        if (state.requestStatus !== 200) {
          sendJson(res, state.requestStatus, state.requestBody ?? { code: -1, msg: 'boom' });
          return;
        }
        const body = JSON.parse(raw.toString('utf8') || '{}');
        batchCounter += 1;
        const batchId = `batch-${batchCounter}`;
        batchBodies.set(batchId, body);
        sendJson(res, 200, {
          code: 0,
          msg: 'ok',
          trace_id: 'trace-1',
          data: { batch_id: batchId, file_urls: [`${state.origin}/upload/${batchId}`] },
        });
        return;
      }

      if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) {
        res.writeHead(state.uploadStatus, { 'content-type': 'text/plain' });
        res.end(state.uploadStatus === 200 ? 'ok' : 'upload failed');
        return;
      }

      if (req.method === 'GET' && apiPath.startsWith('/extract-results/batch/')) {
        const batchId = apiPath.slice('/extract-results/batch/'.length);
        const responses = state.pollResponses;
        const entry = JSON.parse(JSON.stringify(responses[Math.min(pollCount, responses.length - 1)]));
        pollCount += 1;
        if (entry.state === 'done' && !entry.full_zip_url) {
          entry.full_zip_url = `${state.origin}/zip/${batchId}`;
        }
        sendJson(res, 200, {
          code: 0,
          msg: 'ok',
          data: { batch_id: batchId, extract_result: [entry] },
        });
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/zip/')) {
        const batchId = url.pathname.slice('/zip/'.length);
        const zip = state.zipFor ? state.zipFor(batchId, batchBodies.get(batchId)) : makeZip([]);
        if (state.zipStatus !== 200) {
          res.writeHead(state.zipStatus);
          res.end('zip failed');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length });
        res.end(zip);
        return;
      }

      sendJson(res, 404, { code: -1, msg: 'not found' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  state.origin = `http://127.0.0.1:${port}`;
  state.baseUrl = `${state.origin}/api/v4`;

  return {
    calls,
    state,
    baseUrl: state.baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/* ------------------------------------------------------------------ *
 * 测试辅助
 * ------------------------------------------------------------------ */

async function withTempFile(name, content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mmgrep-doc-'));
  const filePath = join(dir, name);
  await writeFile(filePath, content);
  try {
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 造一个 content_list.json 形态的结果包。 */
function contentListZip(items, name = 'content_list.json') {
  return makeZip([{ name, data: JSON.stringify(items) }]);
}

const SAMPLE_ITEMS = [
  { type: 'text', text: '第一页标题', text_level: 1, page_idx: 0 },
  { type: 'text', text: '第一页正文', page_idx: 0 },
  { type: 'text', text: '第二页正文', page_idx: 1 },
  {
    type: 'table',
    img_path: 'images/t.jpg',
    table_caption: ['表 1'],
    table_body: '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
    page_idx: 1,
  },
  { type: 'text', text: '第三页正文', page_idx: 2 },
];

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */

test('runs the upload → poll → download flow and maps pages correctly', async () => {
  const stub = await startStub({
    pollResponses: [
      { file_name: 'doc.pdf', state: 'running', err_msg: '', extract_progress: { extracted_pages: 1, total_pages: 3 } },
      { file_name: 'doc.pdf', state: 'done', err_msg: '' },
    ],
    zipFor: () => contentListZip(SAMPLE_ITEMS),
  });

  try {
    const provider = createMineruDocProvider({
      apiKey: 'secret-token',
      baseUrl: stub.baseUrl,
      timeoutMs: 10_000,
      pollIntervalMs: 1,
    });

    const result = await withTempFile('doc.pdf', '%PDF-1.4 fake', (filePath) =>
      provider.parse({ filePath }),
    );

    // 三步流程顺序：申请地址 → PUT 上传 → 轮询（先 running 后 done）→ 下载结果包
    const paths = stub.calls.map((c) => `${c.method} ${c.path}`);
    assert.equal(paths[0], 'POST /api/v4/file-urls/batch');
    assert.equal(paths[1], 'PUT /upload/batch-1');
    assert.equal(paths[2], 'GET /api/v4/extract-results/batch/batch-1');
    assert.equal(paths[3], 'GET /api/v4/extract-results/batch/batch-1');
    assert.equal(paths[4], 'GET /zip/batch-1');
    assert.equal(paths.length, 5);

    // 页码与文本映射正确
    assert.equal(result.provider, 'mineru');
    assert.deepEqual(
      result.pages.map((p) => p.page),
      [1, 2, 3],
    );
    assert.equal(result.pages[0].text, '第一页标题\n第一页正文');
    assert.equal(result.pages[1].text, '第二页正文\n表 1\nA | B\n1 | 2');
    assert.equal(result.pages[2].text, '第三页正文');

    // 表格结构
    assert.deepEqual(result.pages[1].tables[0].rows, [
      ['A', 'B'],
      ['1', '2'],
    ]);

    // 鉴权头只出现在 API 请求上
    const post = stub.calls[0];
    assert.equal(post.headers.authorization, 'Bearer secret-token');
    assert.equal(post.headers['content-type'], 'application/json');
    const postedBody = JSON.parse(post.body);
    assert.equal(postedBody.files[0].name, 'doc.pdf');
    assert.equal(postedBody.files[0].is_ocr, true);
    assert.equal(postedBody.model_version, undefined); // 默认留空，用服务端默认模型

    // 预签名 PUT 不能带 Authorization / Content-Type
    const put = stub.calls[1];
    assert.equal(put.headers.authorization, undefined);
    assert.equal(put.headers['content-type'], undefined);

    // 结果包下载也不能带 Authorization
    const zipCall = stub.calls.find((c) => c.path.startsWith('/zip/'));
    assert.equal(zipCall.headers.authorization, undefined);
  } finally {
    await stub.close();
  }
});

test('sends the requested page range and filters the returned pages', async () => {
  const stub = await startStub({
    zipFor: () =>
      contentListZip([
        { type: 'text', text: '第一页', page_idx: 0 },
        { type: 'text', text: '第二页', page_idx: 1 },
        { type: 'text', text: '第三页', page_idx: 2 },
      ]),
  });

  try {
    const provider = createMineruDocProvider({ apiKey: 'k', baseUrl: stub.baseUrl, timeoutMs: 10_000, pollIntervalMs: 1 });
    const result = await withTempFile('doc.pdf', 'x', (filePath) =>
      provider.parse({ filePath, pages: { from: 2, to: 3 } }),
    );

    const post = stub.calls[0];
    assert.equal(JSON.parse(post.body).files[0].page_ranges, '2-3');
    assert.deepEqual(
      result.pages.map((p) => p.page),
      [2, 3],
    );
    assert.equal(result.pages[0].text, '第二页');
  } finally {
    await stub.close();
  }
});

test('splits a request larger than 200 pages into several batches', async () => {
  const stub = await startStub({
    zipFor: (_batchId, requestBody) => {
      const range = requestBody?.files?.[0]?.page_ranges ?? '';
      const [from, to] = range.split('-').map(Number);
      const items = [];
      for (let p = from; p <= to; p += 1) {
        items.push({ type: 'text', text: `page ${p}`, page_idx: p - 1 });
      }
      return contentListZip(items);
    },
  });

  try {
    const provider = createMineruDocProvider({ apiKey: 'k', baseUrl: stub.baseUrl, timeoutMs: 20_000, pollIntervalMs: 1 });
    const result = await withTempFile('doc.pdf', 'x', (filePath) =>
      provider.parse({ filePath, pages: { from: 1, to: 450 } }),
    );

    const ranges = stub.calls
      .filter((c) => c.method === 'POST')
      .map((c) => JSON.parse(c.body).files[0].page_ranges);
    assert.deepEqual(ranges, ['1-200', '201-400', '401-450']);

    // 每个批次各自带自己的页码
    assert.equal(result.pages[0].page, 1);
    assert.equal(result.pages[200].page, 201);
    assert.equal(result.pages[449].page, 450);
    assert.equal(result.pages.length, 450);
  } finally {
    await stub.close();
  }
});

test('reports progress while polling', async () => {
  const stub = await startStub({
    pollResponses: [
      { state: 'running', err_msg: '' },
      { state: 'running', err_msg: '' },
      { state: 'done', err_msg: '' },
    ],
    zipFor: () => contentListZip([{ type: 'text', text: 'hi', page_idx: 0 }]),
  });

  try {
    const events = [];
    const provider = createMineruDocProvider({
      apiKey: 'k',
      baseUrl: stub.baseUrl,
      timeoutMs: 10_000,
      pollIntervalMs: 1,
      onProgress: (e) => events.push(e),
    });
    await withTempFile('doc.pdf', 'x', (filePath) => provider.parse({ filePath }));

    const stages = events.map((e) => e.stage);
    assert.ok(stages.includes('requesting'));
    assert.ok(stages.includes('uploading'));
    assert.ok(stages.includes('parsing'));
    assert.ok(stages.includes('downloading'));
    assert.ok(stages.includes('unpacking'));
    assert.ok(stages.includes('done'));
    assert.ok(events.every((e) => typeof e.detail === 'string' && e.detail.length > 0));
  } finally {
    await stub.close();
  }
});

test('a per-call progress callback overrides the constructor one', async () => {
  const stub = await startStub({ zipFor: () => contentListZip([{ type: 'text', text: 'hi', page_idx: 0 }]) });
  try {
    const constructorEvents = [];
    const callEvents = [];
    const provider = createMineruDocProvider({
      apiKey: 'k',
      baseUrl: stub.baseUrl,
      timeoutMs: 10_000,
      pollIntervalMs: 1,
      onProgress: (e) => constructorEvents.push(e),
    });
    await withTempFile('doc.pdf', 'x', (filePath) =>
      provider.parse({ filePath }, { onProgress: (e) => callEvents.push(e) }),
    );
    assert.equal(constructorEvents.length, 0);
    assert.ok(callEvents.length > 0);
  } finally {
    await stub.close();
  }
});

test('times out with a clear error that names the batch id', async () => {
  const stub = await startStub({ pollResponses: [{ state: 'running', err_msg: '' }] });
  try {
    const provider = createMineruDocProvider({ apiKey: 'k', baseUrl: stub.baseUrl, timeoutMs: 60, pollIntervalMs: 5 });
    await assert.rejects(
      () => withTempFile('doc.pdf', 'x', (filePath) => provider.parse({ filePath })),
      (err) => {
        assert.match(err.message, /timed out/i);
        assert.match(err.message, /batch_id=batch-1/);
        assert.match(err.message, /MMGREP_DOC_TIMEOUT_MS/);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test('a failed MinerU job surfaces the error message', async () => {
  const stub = await startStub({
    pollResponses: [{ state: 'failed', err_msg: '文件格式不支持，请上传符合要求的文件类型' }],
  });
  try {
    const provider = createMineruDocProvider({ apiKey: 'k', baseUrl: stub.baseUrl, timeoutMs: 10_000, pollIntervalMs: 1 });
    await assert.rejects(
      () => withTempFile('doc.pdf', 'x', (filePath) => provider.parse({ filePath })),
      (err) => {
        assert.match(err.message, /failed/i);
        assert.match(err.message, /文件格式不支持/);
        assert.match(err.message, /batch_id=batch-1/);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test('a 401 response is diagnosable and never leaks the token', async () => {
  const stub = await startStub({
    requestStatus: 401,
    requestBody: { success: false, msgCode: 'A0202', msg: 'user authenticate failed' },
  });
  try {
    const provider = createMineruDocProvider({ apiKey: 'super-secret-token', baseUrl: stub.baseUrl, timeoutMs: 5000 });
    await assert.rejects(
      () => withTempFile('doc.pdf', 'x', (filePath) => provider.parse({ filePath })),
      (err) => {
        assert.match(err.message, /401/);
        assert.match(err.message, /MMGREP_MINERU_API_KEY/);
        assert.match(err.message, /A0202/);
        assert.ok(!err.message.includes('super-secret-token'), 'error message must not contain the token');
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test('a 500 response is diagnosable', async () => {
  const stub = await startStub({ requestStatus: 500, requestBody: { code: -10001, msg: '服务异常' } });
  try {
    const provider = createMineruDocProvider({ apiKey: 'k', baseUrl: stub.baseUrl, timeoutMs: 5000 });
    await assert.rejects(
      () => withTempFile('doc.pdf', 'x', (filePath) => provider.parse({ filePath })),
      (err) => {
        assert.match(err.message, /500/);
        assert.match(err.message, /服务异常/);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test('a missing token produces a clear error naming the environment variable', async () => {
  const provider = createMineruDocProvider({ apiKey: '', baseUrl: 'http://127.0.0.1:1/api/v4' });
  await assert.rejects(
    () => withTempFile('doc.pdf', 'x', (filePath) => provider.parse({ filePath })),
    (err) => {
      assert.match(err.message, /MMGREP_MINERU_API_KEY/);
      assert.match(err.message, /MMGREP_DOC_PROVIDER/);
      return true;
    },
  );
});

test('describe() exposes the configuration but never the token', async () => {
  const provider = createMineruDocProvider({
    apiKey: 'super-secret-token',
    baseUrl: 'https://mineru.net/api/v4/',
    model: 'vlm',
  });
  const described = provider.describe();
  assert.deepEqual(described, { id: 'mineru', model: 'vlm', baseUrl: 'https://mineru.net/api/v4' });
  assert.ok(!JSON.stringify(described).includes('super-secret-token'));
  assert.equal(provider.id, 'mineru');
});

test('falls back to full.md when the package has no content list', async () => {
  const stub = await startStub({
    zipFor: () => makeZip([{ name: 'full.md', data: '# 标题\n\n正文内容' }]),
  });
  try {
    const provider = createMineruDocProvider({ apiKey: 'k', baseUrl: stub.baseUrl, timeoutMs: 10_000, pollIntervalMs: 1 });
    const result = await withTempFile('doc.pdf', 'x', (filePath) => provider.parse({ filePath }));
    assert.equal(result.pages.length, 1);
    assert.match(result.pages[0].text, /正文内容/);
  } finally {
    await stub.close();
  }
});

test('rejects an invalid page range', async () => {
  const provider = createMineruDocProvider({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1/api/v4' });
  await assert.rejects(
    () => withTempFile('doc.pdf', 'x', (filePath) => provider.parse({ filePath, pages: { from: 0, to: 3 } })),
    /1-based/,
  );
});

test('keeps absolute page indices when MinerU preserves them across a page range', async () => {
  const stub = await startStub({
    zipFor: () =>
      contentListZip([
        { type: 'text', text: 'p5', page_idx: 4 },
        { type: 'text', text: 'p6', page_idx: 5 },
        { type: 'text', text: 'p7', page_idx: 6 },
      ]),
  });
  try {
    const provider = createMineruDocProvider({ apiKey: 'k', baseUrl: stub.baseUrl, timeoutMs: 10_000, pollIntervalMs: 1 });
    const result = await withTempFile('doc.pdf', 'x', (filePath) =>
      provider.parse({ filePath, pages: { from: 5, to: 7 } }),
    );
    assert.deepEqual(
      result.pages.map((p) => p.page),
      [5, 6, 7],
    );
    assert.deepEqual(
      result.pages.map((p) => p.text),
      ['p5', 'p6', 'p7'],
    );
  } finally {
    await stub.close();
  }
});

test('re-bases page indices if the server renumbers a sliced range from zero', async () => {
  const stub = await startStub({
    zipFor: () =>
      contentListZip([
        { type: 'text', text: 'p5', page_idx: 0 },
        { type: 'text', text: 'p6', page_idx: 1 },
        { type: 'text', text: 'p7', page_idx: 2 },
      ]),
  });
  try {
    const provider = createMineruDocProvider({ apiKey: 'k', baseUrl: stub.baseUrl, timeoutMs: 10_000, pollIntervalMs: 1 });
    const result = await withTempFile('doc.pdf', 'x', (filePath) =>
      provider.parse({ filePath, pages: { from: 5, to: 7 } }),
    );
    assert.deepEqual(
      result.pages.map((p) => p.page),
      [5, 6, 7],
    );
    assert.equal(result.pages[0].text, 'p5');
  } finally {
    await stub.close();
  }
});

test('finds content_list.json inside a subdirectory of the result package', async () => {
  const stub = await startStub({
    zipFor: () =>
      makeZip([
        { name: 'doc/images/a.jpg', data: 'not an image' },
        { name: 'doc/content_list.json', data: JSON.stringify([{ type: 'text', text: '来自子目录', page_idx: 0 }]) },
      ]),
  });
  try {
    const provider = createMineruDocProvider({ apiKey: 'k', baseUrl: stub.baseUrl, timeoutMs: 10_000, pollIntervalMs: 1 });
    const result = await withTempFile('doc.pdf', 'x', (filePath) => provider.parse({ filePath }));
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].text, '来自子目录');
  } finally {
    await stub.close();
  }
});

test('rejects an empty page range', async () => {
  const provider = createMineruDocProvider({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1/api/v4' });
  await assert.rejects(
    () => withTempFile('doc.pdf', 'x', (filePath) => provider.parse({ filePath, pages: { from: 5, to: 3 } })),
    /empty/,
  );
});

test('a file that is missing on disk', async () => {
  const provider = createMineruDocProvider({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1/api/v4' });
  await assert.rejects(() => provider.parse({ filePath: '/definitely/not/here.pdf' }), /cannot read file/);
});
