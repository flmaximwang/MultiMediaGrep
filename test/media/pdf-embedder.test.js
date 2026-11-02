// test/media/pdf-embedder.test.js —— PDF 书签写入器（9z5.37.2）
//
// 全部 PDF 都由 fixtures/lib/pdf.mjs 或本文件的 builder 现场生成（不提交二进制样本）：
//   - buildPDF：无书签 / 带书签 / 带页标签的多页 PDF；
//   - buildStructuredPdf：带 /Annots、/AcroForm 表单字段、/PageLabels、XMP 元数据、
//     /Info 与既有 outline 的 3 页 PDF（可选签名变体）。
// 依赖 mutool（写入工具）的用例在缺工具时整组跳过；qpdf / pdfinfo 只影响部分断言。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createPdfSupport, normalizePageText } from '../../src/backend/document/pdf.js';
import { createPdfBookmarkEmbedder } from '../../src/media/bookmark/embedder-pdf.js';
import {
  bookmarkEngine,
  readSidecar,
  serializeSidecar,
} from '../../src/media/bookmark/index.js';
import { run } from '../../src/media/ffmpeg.js';
import { ToolError } from '../../src/media/interface.js';
import { buildPDF, pdfTextOp } from '../../fixtures/lib/pdf.mjs';

/* ------------------------------------------------------------------ *
 * 工具可用性 / 跳过原因
 * ------------------------------------------------------------------ */

function toolAvailable(bin, args = ['-v']) {
  const result = spawnSync(bin, args, { stdio: 'ignore' });
  return result.error === undefined;
}

const hasMutool = toolAvailable('mutool');
const hasQpdf = toolAvailable('qpdf');
const hasPdfinfo = toolAvailable('pdfinfo');

const skipWriter = hasMutool ? false : 'mutool (mupdf-tools) is not installed';
const skipQpdf = hasQpdf ? false : 'qpdf is not installed';
const skipPdfinfo = hasPdfinfo ? false : 'pdfinfo (poppler-utils) is not installed';
const skipWriterQpdf = hasMutool && hasQpdf ? false : 'mutool + qpdf are required to build an encrypted PDF';

const pdfSupport = createPdfSupport();

/* ------------------------------------------------------------------ *
 * 测试辅助
 * ------------------------------------------------------------------ */

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-pdf-embedder-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function runTool(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

function qpdfJson(filePath, key) {
  const result = runTool('qpdf', ['--json', `--json-key=${key}`, filePath]);
  assert.equal(result.code, 0, `qpdf --json --json-key=${key} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function tempNames(dir) {
  return (await readdir(dir)).filter((name) => name.includes('.mmgrep-tmp-'));
}

/** 页数 + 首页/中间页/末页的规范化文字（与嵌入器的 page-text 检查同一口径） */
async function pageSnapshot(filePath) {
  const meta = await pdfSupport.readMetadata(filePath);
  const pages = [...new Set([1, Math.ceil(meta.pageCount / 2), meta.pageCount])];
  const extracted = await pdfSupport.extractText(filePath, pages);
  const texts = new Map();
  for (const page of pages) texts.set(page, normalizePageText(extracted.pages.get(page) ?? ''));
  return { pageCount: meta.pageCount, pages: texts };
}

function textPage(text) {
  return {
    kind: 'text',
    width: 300,
    height: 400,
    ops: [pdfTextOp(50, 200, text)],
    fonts: ['F1'],
  };
}

function buildTextPdf({ pages, outline = null, pageLabels = null }) {
  return buildPDF({ pages: pages.map((text) => textPage(text)), outline, pageLabels });
}

function entry(id, title, page, level = 1) {
  return { id, title, page, level };
}

function view(entries) {
  return entries.map((item) => ({ title: item.title, page: item.page, level: item.level ?? 1 }));
}

/** muJS 脚本：读回所有页面的注释（getType 返回 "Text" / "Square" 等名字） */
const ANNOTATION_SCRIPT = [
  'var doc = Document.openDocument(scriptArgs[0]);',
  'var out = [];',
  'for (var i = 0; i < doc.countPages(); i++) {',
  '  var page = doc.loadPage(i);',
  '  var annots = page.getAnnotations();',
  '  for (var j = 0; j < annots.length; j++) {',
  '    var annot = annots[j];',
  '    out.push({ page: i + 1, type: String(annot.getType()), contents: String(annot.getContents()) });',
  '  }',
  '}',
  'print(JSON.stringify(out));',
].join('\n');

async function readAnnotations(dir, filePath) {
  const scriptPath = path.join(dir, 'read-annotations.js');
  await writeFile(scriptPath, ANNOTATION_SCRIPT, 'utf8');
  const result = runTool('mutool', ['run', scriptPath, filePath]);
  assert.equal(result.code, 0, `mutool run failed: ${result.stderr}`);
  const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

/**
 * 手工构造的 3 页 PDF：Text + Square 注释、一个 /Tx 表单字段、/PageLabels、
 * XMP /Metadata、/Info、既有 outline（Keep One / Keep Two）。signed 变体再加一个
 * 已签名的 /Sig 字段（/V 指向 /Type /Sig 值字典）。
 */
function buildStructuredPdf({ signed = false } = {}) {
  const enc = (value) => Buffer.from(value, 'latin1');
  const objects = new Map();
  let next = 1;
  const add = (body) => {
    const num = next;
    next += 1;
    objects.set(num, Buffer.isBuffer(body) ? body : enc(body));
    return num;
  };
  const addStream = (dict, payload) => {
    const data = Buffer.isBuffer(payload) ? payload : enc(payload);
    return add(Buffer.concat([enc(`${dict} /Length ${data.length} >>\nstream\n`), data, enc('\nendstream')]));
  };

  add(''); // 1 = catalog（最后填）
  add(''); // 2 = page tree（最后填）

  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const texts = ['PAGE ONE ALPHA', 'PAGE TWO BRAVO', 'PAGE THREE CHARLIE'];
  const streams = texts.map((text) => addStream('<<', `BT /F1 12 Tf 1 0 0 1 50 200 Tm (${text}) Tj ET`));
  const textAnnot = add('<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents (note one) /T (alice) /F 4 >>');
  const squareAnnot = add('<< /Type /Annot /Subtype /Square /Rect [20 20 80 80] /Contents (square note) /IC [1 0 0] /F 4 >>');
  const widget = add('<< /Type /Annot /Subtype /Widget /FT /Tx /T (Field1) /V (value one) /Rect [10 300 200 320] /F 4 >>');

  const annotsByPage = [[textAnnot], [squareAnnot], [widget]];
  const pages = streams.map((stream, index) => add(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] `
      + `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R `
      + `/Annots [${annotsByPage[index].map((num) => `${num} 0 R`).join(' ')}] >>`,
  ));

  const pageLabels = add('<< /Nums [0 << /S /r >> 2 << /S /D /St 1 >>] >>');
  const xmp = '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    + '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    + '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt>'
    + '<rdf:li xml:lang="x-default">Metadata Title</rdf:li></rdf:Alt></dc:title></rdf:Description>'
    + '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const metadata = addStream('<< /Type /Metadata /Subtype /XML', Buffer.from(xmp, 'utf8'));

  // 既有书签：Keep One（第 1 页）/ Keep Two（第 2 页）
  const itemA = add('');
  const itemB = add('');
  const outline = add('');
  objects.set(itemA, enc(`<< /Title (Keep One) /Parent ${outline} 0 R /Dest [${pages[0]} 0 R /Fit] /Next ${itemB} 0 R >>`));
  objects.set(itemB, enc(`<< /Title (Keep Two) /Parent ${outline} 0 R /Dest [${pages[1]} 0 R /Fit] /Prev ${itemA} 0 R >>`));
  objects.set(outline, enc(`<< /Type /Outlines /Count 2 /First ${itemA} 0 R /Last ${itemB} 0 R >>`));

  let sigField = null;
  if (signed) {
    const sigValue = add(
      '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached '
        + '/ByteRange [0 0 0 0] /Contents <0000> /M (D:20260101000000Z) /Name (Test Signer) >>',
    );
    sigField = add(`<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /V ${sigValue} 0 R /Rect [10 100 200 130] /F 4 >>`);
  }

  const fieldRefs = [widget, ...(sigField === null ? [] : [sigField])].map((num) => `${num} 0 R`).join(' ');
  const acroForm = add(`<< /Fields [${fieldRefs}] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv ${font} 0 R >> >> >>`);
  const info = add('<< /Title (Info Title) /Author (Info Author) /Producer (fixtures) >>');

  objects.set(
    1,
    enc(
      `<< /Type /Catalog /Pages 2 0 R /PageLabels ${pageLabels} 0 R /AcroForm ${acroForm} 0 R `
        + `/Metadata ${metadata} 0 R /Outlines ${outline} 0 R >>`,
    ),
  );
  objects.set(2, enc(`<< /Type /Pages /Kids [${pages.map((num) => `${num} 0 R`).join(' ')}] /Count 3 >>`));

  let text = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  for (let num = 1; num < next; num += 1) {
    offsets[num] = Buffer.byteLength(text, 'latin1');
    text += `${num} 0 obj\n${objects.get(num).toString('latin1')}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(text, 'latin1');
  text += `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let num = 1; num < next; num += 1) {
    text += `${String(offsets[num]).padStart(10, '0')} 00000 n \n`;
  }
  text += `trailer\n<< /Size ${next} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(text, 'latin1');
}

function assertNoTemp(dir, message) {
  return tempNames(dir).then((names) => assert.deepEqual(names, [], message));
}

/* ------------------------------------------------------------------ *
 * 1) 无书签 PDF：新增 3 个条目（含 level-2），页数/文字不变，回读一致
 * ------------------------------------------------------------------ */

test('PDF 写入：无书签 PDF 新增 3 个条目（含二级），页数与文字不变、回读一致', { timeout: 120_000, skip: skipWriter }, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const pdfPath = path.join(ws.dir, 'plain.pdf');
  await writeFile(pdfPath, buildTextPdf({ pages: ['PAGE ONE ALPHA', 'PAGE TWO BRAVO', 'PAGE THREE CHARLIE', 'PAGE FOUR DELTA'] }));
  const beforeHash = await sha256(pdfPath);
  const before = await pageSnapshot(pdfPath);
  const sidecarPath = `${pdfPath}.mmgrep.bookmark.json`;

  const entries = [
    entry('b1', '第一章 概述', 1, 1),
    entry('b2', '背景 "quoted" \\ 路径 😀', 2, 2),
    entry('b3', '总结 — 特殊字符 © Æ', 4, 1),
  ];
  const result = await bookmarkEngine.embedders.pdf.embed({
    filePath: pdfPath,
    media: 'pdf',
    entries,
    sidecarPath,
    signal: null,
  });

  assert.equal(result.target, pdfPath);
  assert.deepEqual(result.checks.map((check) => check.name), ['writer-exit', 'qpdf-check', 'page-text', 'outline-readback']);
  for (const check of result.checks) {
    assert.equal(check.ok, true, `check "${check.name}" failed: ${check.detail}`);
  }

  // 页数不变、首页/中间页/末页文字不变
  const after = await pageSnapshot(pdfPath);
  assert.equal(after.pageCount, before.pageCount);
  for (const [page, text] of before.pages) {
    assert.equal(after.pages.get(page), text, `text of page ${page} changed`);
  }

  // 回读与 sidecar 条目一致（中文 / 引号 / 反斜杠 / emoji 都要原样）
  const outline = await pdfSupport.readOutline(pdfPath);
  assert.equal(outline.reader, hasQpdf ? 'qpdf' : null);
  const readback = outline.entries.map((item) => ({ title: item.title, page: item.page, level: item.level }));
  assert.deepEqual(readback, view(entries));

  // 原文件确实被重写，但仍是合法 PDF；嵌入器自己不写 sidecar / 不留临时文件
  assert.notEqual(await sha256(pdfPath), beforeHash);
  if (hasQpdf) {
    const check = runTool('qpdf', ['--check', pdfPath]);
    assert.ok(check.code === 0 || check.code === 3, `qpdf --check failed: ${check.stderr}`);
  }
  assert.equal(existsSync(sidecarPath), false);
  await assertNoTemp(ws.dir);
});

/* ------------------------------------------------------------------ *
 * 2) 已有书签：重命名 / 移动页码 / 改层级 / 删除作者条目
 * ------------------------------------------------------------------ */

test('PDF 写入：已有书签被整体替换（重命名 / 移动页码 / 改层级 / 删除旧条目）', { timeout: 120_000, skip: skipWriter }, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const pdfPath = path.join(ws.dir, 'outlined.pdf');
  await writeFile(pdfPath, buildTextPdf({
    pages: ['PAGE ONE', 'PAGE TWO', 'PAGE THREE', 'PAGE FOUR'],
    outline: [
      { title: 'Keep One', page: 1 },
      { title: 'Old Parent', page: 3, children: [{ title: 'Old Child', page: 4 }] },
    ],
    pageLabels: [{ startPage: 1, style: 'r' }, { startPage: 3, style: 'D', start: 1 }],
  }));
  const before = await pageSnapshot(pdfPath);
  const labelsBefore = hasQpdf ? qpdfJson(pdfPath, 'pagelabels') : null;

  const entries = [
    entry('b1', 'Renamed One', 2, 1),
    entry('b2', 'Promoted Child', 4, 2),
    entry('b3', 'Moved To End', 3, 1),
  ];
  const result = await bookmarkEngine.embedders.pdf.embed({
    filePath: pdfPath,
    media: 'pdf',
    entries,
    sidecarPath: `${pdfPath}.json`,
  });
  for (const check of result.checks) assert.equal(check.ok, true, `check "${check.name}" failed: ${check.detail}`);

  const outline = await pdfSupport.readOutline(pdfPath);
  assert.deepEqual(
    outline.entries.map((item) => ({ title: item.title, page: item.page, level: item.level })),
    view(entries),
  );
  assert.ok(!outline.entries.some((item) => /Old|Keep/.test(item.title)), 'author bookmarks must be removed');

  const after = await pageSnapshot(pdfPath);
  assert.equal(after.pageCount, before.pageCount);
  for (const [page, text] of before.pages) assert.equal(after.pages.get(page), text);

  // 页标签原样保留
  if (hasQpdf) {
    assert.deepEqual(qpdfJson(pdfPath, 'pagelabels'), labelsBefore);
    const check = runTool('qpdf', ['--check', pdfPath]);
    assert.ok(check.code === 0 || check.code === 3, `qpdf --check failed: ${check.stderr}`);
  }
  await assertNoTemp(ws.dir);
});

/* ------------------------------------------------------------------ *
 * 3) 保留注释 / 表单字段 / 页标签 / 元数据
 * ------------------------------------------------------------------ */

test('PDF 写入：保留注释、表单字段、页标签、Info 与 XMP 元数据', { timeout: 120_000, skip: skipWriter }, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const pdfPath = path.join(ws.dir, 'structured.pdf');
  await writeFile(pdfPath, buildStructuredPdf());
  const beforeAnnots = await readAnnotations(ws.dir, pdfPath);
  const before = await pageSnapshot(pdfPath);
  const labelsBefore = hasQpdf ? qpdfJson(pdfPath, 'pagelabels') : null;
  const acroBefore = hasQpdf ? qpdfJson(pdfPath, 'acroform') : null;

  const entries = [
    entry('b1', '前言', 1, 1),
    entry('b2', '第三章', 2, 2),
    entry('b3', '附录', 3, 1),
  ];
  const result = await bookmarkEngine.embedders.pdf.embed({
    filePath: pdfPath,
    media: 'pdf',
    entries,
    sidecarPath: `${pdfPath}.json`,
  });
  for (const check of result.checks) assert.equal(check.ok, true, `check "${check.name}" failed: ${check.detail}`);

  // 注释（Text + Square，含 /Contents）原样保留
  assert.deepEqual(await readAnnotations(ws.dir, pdfPath), beforeAnnots);

  // 表单字段（名字 / 值）原样保留
  if (hasQpdf) {
    const acroAfter = qpdfJson(pdfPath, 'acroform');
    assert.deepEqual(
      acroAfter.acroform.fields.map((field) => ({ fullname: field.fullname, fieldtype: field.fieldtype, value: field.value })),
      acroBefore.acroform.fields.map((field) => ({ fullname: field.fullname, fieldtype: field.fieldtype, value: field.value })),
    );
  }

  // 页标签 / Info / XMP 元数据 / 合法性
  if (hasQpdf) {
    assert.deepEqual(qpdfJson(pdfPath, 'pagelabels'), labelsBefore);
    const check = runTool('qpdf', ['--check', pdfPath]);
    assert.ok(check.code === 0 || check.code === 3, `qpdf --check failed: ${check.stderr}`);
  }
  if (hasPdfinfo) {
    const info = runTool('pdfinfo', [pdfPath]).stdout;
    assert.match(info, /^Title:\s+Info Title$/m);
    assert.match(info, /^Author:\s+Info Author$/m);
    assert.match(info, /^Metadata Stream:\s+yes$/m);
    assert.match(info, /^Form:\s+AcroForm$/m);
  }
  const after = await pageSnapshot(pdfPath);
  assert.equal(after.pageCount, before.pageCount);
  for (const [page, text] of before.pages) assert.equal(after.pages.get(page), text);

  // 新书签替换掉旧书签
  const outline = await pdfSupport.readOutline(pdfPath);
  assert.deepEqual(
    outline.entries.map((item) => ({ title: item.title, page: item.page, level: item.level })),
    view(entries),
  );
  await assertNoTemp(ws.dir);
});

/* ------------------------------------------------------------------ *
 * 4) 拒绝加密 PDF
 * ------------------------------------------------------------------ */

test('PDF 写入：加密 PDF（用户密码 / 仅所有者密码）明确拒绝，原文件不动', { timeout: 120_000, skip: skipWriterQpdf }, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const plainPath = path.join(ws.dir, 'plain.pdf');
  await writeFile(plainPath, buildTextPdf({ pages: ['PAGE ONE', 'PAGE TWO'] }));
  const plainHash = await sha256(plainPath);

  const cases = [
    { name: 'user-password', user: 'user-1', owner: 'owner-1' },
    { name: 'owner-only', user: '', owner: 'owner-2' },
  ];
  for (const variant of cases) {
    const encryptedPath = path.join(ws.dir, `enc-${variant.name}.pdf`);
    const encrypt = runTool('qpdf', ['--encrypt', variant.user, variant.owner, '256', '--', plainPath, encryptedPath]);
    assert.equal(encrypt.code, 0, `qpdf --encrypt failed: ${encrypt.stderr}`);

    await assert.rejects(
      bookmarkEngine.embedders.pdf.embed({
        filePath: encryptedPath,
        media: 'pdf',
        entries: [entry('b1', 'One', 1)],
        sidecarPath: `${encryptedPath}.json`,
      }),
      (error) => {
        assert.ok(error instanceof ToolError, 'must be a ToolError');
        assert.equal(error.code, 'UNSUPPORTED_MEDIA_TYPE');
        assert.match(error.message, /encrypted/);
        assert.match(error.hint, /qpdf --decrypt/);
        return true;
      },
    );
    await assertNoTemp(ws.dir);
  }

  // 明文原文件始终没有被触碰
  assert.equal(await sha256(plainPath), plainHash);
});

/* ------------------------------------------------------------------ *
 * 5) 拒绝已签名 PDF
 * ------------------------------------------------------------------ */

test('PDF 写入：已签名 PDF 明确拒绝，原文件不动', { timeout: 120_000, skip: skipWriter }, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const pdfPath = path.join(ws.dir, 'signed.pdf');
  await writeFile(pdfPath, buildStructuredPdf({ signed: true }));
  const beforeHash = await sha256(pdfPath);

  await assert.rejects(
    bookmarkEngine.embedders.pdf.embed({
      filePath: pdfPath,
      media: 'pdf',
      entries: [entry('b1', 'One', 1)],
      sidecarPath: `${pdfPath}.json`,
    }),
    (error) => {
      assert.ok(error instanceof ToolError, 'must be a ToolError');
      assert.equal(error.code, 'UNSUPPORTED_MEDIA_TYPE');
      assert.match(error.message, /digitally signed/);
      assert.match(error.hint, /signature/i);
      return true;
    },
  );
  assert.equal(await sha256(pdfPath), beforeHash);
  await assertNoTemp(ws.dir);
});

/* ------------------------------------------------------------------ *
 * 6) 缺写入工具：TOOL_NOT_FOUND + 安装提示；
 *    注入坏 writer：原文件哈希不变、不留临时文件
 * ------------------------------------------------------------------ */

test('PDF 写入：缺少 mutool 报 TOOL_NOT_FOUND 并给出安装提示', { timeout: 120_000 }, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const pdfPath = path.join(ws.dir, 'plain.pdf');
  await writeFile(pdfPath, buildTextPdf({ pages: ['PAGE ONE'] }));
  const beforeHash = await sha256(pdfPath);

  const embedder = createPdfBookmarkEmbedder({
    runCommand: async () => {
      throw new ToolError('TOOL_NOT_FOUND', 'spawn mutool ENOENT');
    },
  });
  await assert.rejects(
    embedder.embed({ filePath: pdfPath, media: 'pdf', entries: [entry('b1', 'One', 1)] }),
    (error) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.code, 'TOOL_NOT_FOUND');
      assert.match(error.message, /mutool/);
      assert.match(error.hint, /mupdf-tools/);
      return true;
    },
  );
  assert.equal(await sha256(pdfPath), beforeHash);
  await assertNoTemp(ws.dir);
});

test('PDF 写入：注入坏 writer → 原文件哈希不变、临时文件被清理、checks 报告失败', { timeout: 120_000, skip: skipWriter }, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const pdfPath = path.join(ws.dir, 'plain.pdf');
  await writeFile(pdfPath, buildTextPdf({ pages: ['PAGE ONE', 'PAGE TWO'] }));
  const beforeBytes = await readFile(pdfPath);
  const entries = [entry('b1', 'One', 1)];

  // (a) writer 声称成功，但把临时 PDF 写坏
  const corrupting = createPdfBookmarkEmbedder({
    runCommand: async (bin, args, options) => {
      const result = await run(bin, args, options);
      if (bin === 'mutool' && args[0] === 'run' && args[2] === 'write') {
        await writeFile(args[4], Buffer.from('this is not a PDF'));
      }
      return result;
    },
  });
  const corrupted = await corrupting.embed({ filePath: pdfPath, media: 'pdf', entries });
  assert.ok(corrupted.checks.some((check) => check.ok !== true), 'a corrupted temporary PDF must fail a check');
  assert.deepEqual(await readFile(pdfPath), beforeBytes);
  await assertNoTemp(ws.dir);

  // (b) writer 声称成功却没产出任何临时文件
  const lying = createPdfBookmarkEmbedder({
    runCommand: async (bin, args, options) => {
      if (bin === 'mutool' && args[0] === 'run' && args[2] === 'write') {
        return { code: 0, stdout: '{"ok":true,"entries":1,"pageCount":2}', stderr: '' };
      }
      return run(bin, args, options);
    },
  });
  const lied = await lying.embed({ filePath: pdfPath, media: 'pdf', entries });
  assert.equal(lied.checks[0].name, 'writer-exit');
  assert.equal(lied.checks[0].ok, false);
  assert.match(lied.checks[0].detail, /temporary PDF/);
  assert.deepEqual(await readFile(pdfPath), beforeBytes);
  await assertNoTemp(ws.dir);
});

/* ------------------------------------------------------------------ *
 * 7) 无法表达的层级序列（sidecar 按页码排序后子条目排在父条目前）
 * ------------------------------------------------------------------ */

test('PDF 写入：无法表达的层级序列报 INVALID_ARGUMENT，原文件不动', { timeout: 120_000, skip: skipWriter }, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const pdfPath = path.join(ws.dir, 'plain.pdf');
  await writeFile(pdfPath, buildTextPdf({ pages: ['PAGE ONE', 'PAGE TWO'] }));
  const beforeHash = await sha256(pdfPath);

  await assert.rejects(
    bookmarkEngine.embedders.pdf.embed({
      filePath: pdfPath,
      media: 'pdf',
      entries: [entry('b1', 'Orphan Child', 1, 2)],
      sidecarPath: `${pdfPath}.json`,
    }),
    (error) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /cannot skip levels/);
      return true;
    },
  );
  assert.equal(await sha256(pdfPath), beforeHash);
  await assertNoTemp(ws.dir);
});

/* ------------------------------------------------------------------ *
 * 8) AbortSignal：取消后不留临时文件、原文件不动
 * ------------------------------------------------------------------ */

test('PDF 写入：预约取消（已 abort / 写入后 abort）抛 AbortError 并清理临时文件', { timeout: 120_000, skip: skipWriter }, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const pdfPath = path.join(ws.dir, 'plain.pdf');
  await writeFile(pdfPath, buildTextPdf({ pages: ['PAGE ONE', 'PAGE TWO'] }));
  const beforeBytes = await readFile(pdfPath);
  const entries = [entry('b1', 'One', 1)];

  // (a) 调用前已经 abort
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    bookmarkEngine.embedders.pdf.embed({ filePath: pdfPath, media: 'pdf', entries, signal: preAborted.signal }),
    (error) => {
      assert.equal(error.name, 'AbortError');
      assert.match(error.message, /cancelled/);
      return true;
    },
  );
  assert.deepEqual(await readFile(pdfPath), beforeBytes);
  await assertNoTemp(ws.dir);

  // (b) writer 写完临时 PDF 后 abort：走清理路径
  const controller = new AbortController();
  const embedder = createPdfBookmarkEmbedder({
    runCommand: async (bin, args, options) => {
      const result = await run(bin, args, options);
      if (bin === 'mutool' && args[0] === 'run' && args[2] === 'write') controller.abort();
      return result;
    },
  });
  await assert.rejects(
    embedder.embed({ filePath: pdfPath, media: 'pdf', entries, signal: controller.signal }),
    (error) => {
      assert.equal(error.name, 'AbortError');
      return true;
    },
  );
  assert.deepEqual(await readFile(pdfPath), beforeBytes);
  await assertNoTemp(ws.dir);
});

/* ------------------------------------------------------------------ *
 * 9) 引擎集成：sidecar → embed → sidecar 回读，端到端一致
 * ------------------------------------------------------------------ */

test('PDF 写入：引擎端到端（sidecar 条目 → 写入 PDF → sidecar 回读）', { timeout: 120_000, skip: skipWriter }, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const pdfPath = path.join(ws.dir, 'book.pdf');
  await writeFile(pdfPath, buildTextPdf({ pages: ['PAGE ONE', 'PAGE TWO', 'PAGE THREE', 'PAGE FOUR'] }));
  const sidecarPath = bookmarkEngine.sidecarPath(pdfPath);
  const existing = [entry('b1', '第一章', 1, 1), entry('b2', '第一节', 2, 2)];
  await writeFile(sidecarPath, serializeSidecar('pdf', existing));
  const expected = [...existing, entry('b3', '第二章', 4, 1)];

  const probe = {
    mediaType: 'document',
    container: 'pdf',
    pageCount: 4,
    outline: { available: false, source: 'pdf-bookmarks', total: 0, entries: [], reason: null },
  };
  // 引擎要求至少一个操作：新增「第二章」→ 3 条 sidecar 条目（含二级）写进 PDF
  const result = await bookmarkEngine.execute({
    filePath: pdfPath,
    media: 'pdf',
    probe,
    operations: { add: [{ title: '第二章', page: 4 }] },
  });

  assert.equal(result.media, 'pdf');
  assert.equal(result.embed.target, pdfPath);
  assert.deepEqual(result.embed.checks.map((check) => check.name), ['writer-exit', 'qpdf-check', 'page-text', 'outline-readback']);
  assert.ok(result.checks.every((check) => check.ok === true), JSON.stringify(result.checks));
  assert.equal(result.outline.source, 'sidecar');
  assert.equal(result.outline.available, true);

  const sidecar = await readSidecar(sidecarPath, { media: 'pdf', idPrefix: bookmarkEngine.idPrefix });
  assert.deepEqual(
    sidecar.entries.map((item) => ({ title: item.title, page: item.page, level: item.level })),
    view(expected),
  );
  const outline = await pdfSupport.readOutline(pdfPath);
  assert.deepEqual(
    outline.entries.map((item) => ({ title: item.title, page: item.page, level: item.level })),
    view(expected),
  );
  await assertNoTemp(ws.dir);
});
