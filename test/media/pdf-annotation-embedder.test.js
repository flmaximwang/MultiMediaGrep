// test/media/pdf-annotation-embedder.test.js —— PDF 注解嵌入器（9z5.38.2）
//
// 全部 PDF 都由本文件的 builder 现场生成（不提交二进制样本）：可带 Text /
// Square / Highlight / Ink / Link / Popup / Widget 批注、/AP 外观流、/Rotate 与
// /CropBox 变体、/PageLabels / XMP /Info，以及已签名变体。
//
// 覆盖 ticket 的验收点：
//   - 新增 text（带/不带 rect）与 square → 成为真正的 PDF 注释对象，回读一致；
//   - rect 在 /Rotate 0/90/180/270（含 /CropBox）下都落在正确的 PDF 用户空间坐标；
//   - 页面文字与页数不变（批注绝不写进页面内容），Link / 表单 Widget / Popup 不动；
//   - 首次写入导入全部 markup 批注（id 顺序 page → rect.y → rect.x，作者与原 note 保留）；
//   - 未改动的条目保留原注释对象与外观流（/AP 字节级不变），只重建改动的条目；
//   - 加密 / 已签名 PDF 明确拒绝，原文件不动、无临时文件；
//   - 缺 mutool → TOOL_NOT_FOUND + 安装提示；坏 writer → 原文件哈希不变、无临时文件；
//   - probe.annotationOutline 的接线形状（有批注 / 无批注 / 非 PDF）。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createDocumentBackend } from '../../src/backend/document/index.js';
import { createPdfSupport } from '../../src/backend/document/pdf.js';
import { annotationEngine } from '../../src/media/annotation/index.js';
import {
  createPdfAnnotationEmbedder,
  PDF_ANNOTATION_EMBED_TARGET,
  pdfAnnotationEmbedder,
} from '../../src/media/annotation/embedder-pdf.js';
import { run } from '../../src/media/ffmpeg.js';
import { ToolError } from '../../src/media/interface.js';

/* ------------------------------------------------------------------ *
 * 工具可用性 / 跳过原因
 * ------------------------------------------------------------------ */

function toolAvailable(bin, args = ['-v']) {
  const result = spawnSync(bin, args, { stdio: 'ignore' });
  return result.error === undefined;
}

const hasMutool = toolAvailable('mutool');
const hasQpdf = toolAvailable('qpdf');

const skipWriter = hasMutool ? false : 'mutool (mupdf-tools) is not installed';
const skipWriterQpdf = hasMutool && hasQpdf ? false : 'mutool + qpdf are required to build an encrypted PDF';

/** 1x1 PNG（非 PDF 媒体探测分支用） */
const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/* ------------------------------------------------------------------ *
 * 测试辅助
 * ------------------------------------------------------------------ */

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-pdf-annotation-'));
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

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function tempNames(dir) {
  return (await readdir(dir)).filter((name) => name.includes('.mmgrep-tmp-'));
}

async function assertNoTemp(dir, message) {
  assert.deepEqual(await tempNames(dir), [], message);
}

function errorOf(promise) {
  return promise.then(
    () => assert.fail('expected the call to reject'),
    (error) => error,
  );
}

/* ------------------------------------------------------------------ *
 * 现场生成的 PDF
 * ------------------------------------------------------------------ */

const PAGE_TEXTS = ['PAGE ONE ALPHA', 'PAGE TWO BRAVO', 'PAGE THREE CHARLIE'];

/** 批注描述 → PDF 注释字典（/Parent、/AP 的引用在 builder 里补） */
function annotationDict(annot, context) {
  const parts = ['/Type /Annot', `/Subtype /${annot.subtype}`];
  parts.push(`/Rect [${annot.rect.join(' ')}]`);
  if (annot.contents !== undefined) parts.push(`/Contents (${annot.contents})`);
  if (annot.author !== undefined) parts.push(`/T (${annot.author})`);
  if (annot.color) parts.push(`/C [${annot.color.join(' ')}]`);
  if (annot.icon) parts.push(`/Name /${annot.icon}`);
  if (annot.flags !== undefined) parts.push(`/F ${annot.flags}`);
  if (annot.quadPoints) parts.push(`/QuadPoints [${annot.quadPoints.join(' ')}]`);
  if (annot.inkList) parts.push(`/InkList [${annot.inkList.map((pts) => `[${pts.join(' ')}]`).join(' ')}]`);
  if (annot.vertices) parts.push(`/Vertices [${annot.vertices.join(' ')}]`);
  if (annot.fieldType) parts.push(`/FT /${annot.fieldType}`);
  if (annot.uri) parts.push(`/A << /S /URI /URI (${annot.uri}) >>`);
  if (annot.parentIndex !== undefined) parts.push(`/Parent ${context.annotRefs[annot.parentIndex]}`);
  if (annot.popupIndex !== undefined) parts.push(`/Popup ${context.annotRefs[annot.popupIndex]}`);
  if (context.apNumber !== null) parts.push(`/AP << /N ${context.apNumber} 0 R >>`);
  return `<< ${parts.join(' ')} >>`;
}

/**
 * 手工构造 PDF。
 *
 * @param {{
 *   pageCount?: number,
 *   width?: number, height?: number,
 *   cropBox?: number[]|null,
 *   rotate?: number,
 *   annotations?: Array<object>,   // {page, subtype, rect, contents?, author?, ap?, parentIndex?, ...}
 *   signed?: boolean,
 * }} spec
 */
function buildAnnotatedPdf({
  pageCount = 3,
  width = 300,
  height = 400,
  cropBox = null,
  rotate = 0,
  annotations = [],
  signed = false,
} = {}) {
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

  add(''); // 1 = catalog
  add(''); // 2 = page tree

  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const streams = [];
  for (let index = 0; index < pageCount; index += 1) {
    const text = PAGE_TEXTS[index] ?? `PAGE ${index + 1}`;
    streams.push(addStream('<<', `BT /F1 12 Tf 1 0 0 1 50 200 Tm (${text}) Tj ET`));
  }

  // /AP 外观流对象先建（字典里引用对象号）
  const apNumbers = annotations.map((annot) => (
    annot.ap ? addStream('<< /Type /XObject /Subtype /Form /BBox [0 0 100 20]', annot.ap) : null
  ));
  const annotNumbers = annotations.map(() => add(''));
  const annotRefs = annotNumbers.map((num) => `${num} 0 R`);
  annotations.forEach((annot, index) => {
    objects.set(annotNumbers[index], enc(annotationDict(annot, { annotRefs, apNumber: apNumbers[index] })));
  });

  const pageNumbers = streams.map((stream, index) => {
    const refs = annotations
      .map((annot, annotIndex) => (annot.page === index + 1 ? annotRefs[annotIndex] : null))
      .filter((ref) => ref !== null);
    return add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] `
        + (cropBox ? `/CropBox [${cropBox.join(' ')}] ` : '')
        + (rotate ? `/Rotate ${rotate} ` : '')
        + `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R `
        + `/Annots [${refs.join(' ')}] >>`,
    );
  });

  const pageLabels = add('<< /Nums [0 << /S /r >> 2 << /S /D /St 1 >>] >>');
  const xmp = '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    + '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    + '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt>'
    + '<rdf:li xml:lang="x-default">Metadata Title</rdf:li></rdf:Alt></dc:title></rdf:Description>'
    + '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const metadata = addStream('<< /Type /Metadata /Subtype /XML', Buffer.from(xmp, 'utf8'));

  const fieldNumbers = annotations
    .map((annot, index) => (annot.subtype === 'Widget' ? annotNumbers[index] : null))
    .filter((num) => num !== null);
  let signatureField = null;
  if (signed) {
    const sigValue = add(
      '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached '
        + '/ByteRange [0 0 0 0] /Contents <0000> /M (D:20260101000000Z) /Name (Test Signer) >>',
    );
    signatureField = add(
      `<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /V ${sigValue} 0 R /Rect [10 100 200 130] /F 4 >>`,
    );
    fieldNumbers.push(signatureField);
  }
  const acroForm = add(
    `<< /Fields [${fieldNumbers.map((num) => `${num} 0 R`).join(' ')}] /DA (/Helv 0 Tf 0 g) `
      + `/DR << /Font << /Helv ${font} 0 R >> >> >>`,
  );
  const info = add('<< /Title (Info Title) /Author (Info Author) /Producer (fixtures) >>');

  objects.set(
    1,
    enc(
      `<< /Type /Catalog /Pages 2 0 R /PageLabels ${pageLabels} 0 R /AcroForm ${acroForm} 0 R `
        + `/Metadata ${metadata} 0 R >>`,
    ),
  );
  objects.set(2, enc(`<< /Type /Pages /Kids [${pageNumbers.map((num) => `${num} 0 R`).join(' ')}] /Count ${pageCount} >>`));

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

/* ------------------------------------------------------------------ *
 * 用独立的 mutool 脚本读取 PDF 里的注释对象（不经过被测试的实现）
 * ------------------------------------------------------------------ */

const READ_ANNOTS_SCRIPT = [
  'var doc = Document.openDocument(scriptArgs[0]);',
  'var out = [];',
  'for (var i = 0; i < doc.countPages(); i++) {',
  '  var page = doc.loadPage(i);',
  '  var annots = page.getObject().get("Annots");',
  '  if (!annots) continue;',
  '  for (var j = 0; j < annots.length; j++) {',
  '    var dict = annots.get(j).resolve();',
  '    if (!dict) continue;',
  '    var subtype = dict.get("Subtype") ? String(dict.get("Subtype").asName()) : "";',
  '    var rectObj = dict.get("Rect");',
  '    var rect = null;',
  '    if (rectObj && rectObj.isArray && rectObj.isArray()) {',
  '      rect = [];',
  '      for (var k = 0; k < rectObj.length; k++) rect.push(rectObj.get(k).asNumber());',
  '    }',
  '    var contents = dict.get("Contents") ? String(dict.get("Contents").asString()) : "";',
  '    var author = dict.get("T") ? String(dict.get("T").asString()) : "";',
  '    var fieldType = dict.get("FT") ? String(dict.get("FT").asName()) : "";',
  '    var ap = dict.get("AP");',
  '    var apText = "";',
  '    if (ap) {',
  '      var apN = ap.get("N");',
  '      if (apN) {',
  '        var bytes = apN.readRawStream();',
  '        for (var b = 0; b < bytes.length; b++) apText += String.fromCharCode(bytes[b]);',
  '      }',
  '    }',
  '    out.push({',
  '      page: i + 1, subtype: subtype, contents: contents, author: author,',
  '      rect: rect, fieldType: fieldType, apText: apText, hasPopup: dict.get("Popup") !== null,',
  '      hasParent: dict.get("Parent") !== null',
  '    });',
  '  }',
  '}',
  'print(JSON.stringify(out));',
].join('\n');

async function readAnnotsRaw(dir, filePath) {
  const scriptPath = path.join(dir, 'read-annotations.js');
  await writeFile(scriptPath, READ_ANNOTS_SCRIPT, 'utf8');
  const result = runTool('mutool', ['run', scriptPath, filePath]);
  assert.equal(result.code, 0, `mutool run failed: ${result.stderr}`);
  const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function countOf(list, subtype) {
  return list.filter((annot) => annot.subtype === subtype).length;
}

function closeTo(actual, expected, tolerance, message) {
  if (!Array.isArray(actual)) assert.fail(`${message}: no rect (got ${JSON.stringify(actual)})`);
  for (let index = 0; index < expected.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= tolerance,
      `${message}: rect[${index}] ${actual[index]} is not within ${tolerance} of ${expected[index]} (rect ${JSON.stringify(actual)})`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 引擎 / 探针
 * ------------------------------------------------------------------ */

function probeOf(filePath) {
  return createDocumentBackend({ config: {} }).probe({ path: filePath });
}

const pdfSupport = createPdfSupport();

async function annotate({ filePath, operations, embedder = undefined, author = 'Agent' }) {
  const probe = await probeOf(filePath);
  return annotationEngine.execute({
    filePath,
    media: 'pdf',
    probe,
    operations,
    embedder,
    context: { author },
  });
}

function checkNames(result) {
  return result.checks.map((check) => check.name);
}

/** 标准的三页 PDF：Text（带 /AP）+ Square + Highlight + Ink + Link + Popup + Widget */
function standardPdf() {
  return buildAnnotatedPdf({
    annotations: [
      {
        page: 1,
        subtype: 'Text',
        rect: [10, 300, 30, 320],
        contents: 'note one',
        author: 'alice',
        color: [1, 0, 0],
        icon: 'Comment',
        flags: 4,
        ap: 'q 1 0 0 rg 0 0 20 20 re f Q',
        popupIndex: 6,
      },
      { page: 1, subtype: 'Square', rect: [40, 100, 120, 160], contents: 'square note', color: [0, 0, 1], flags: 4 },
      {
        page: 1,
        subtype: 'Highlight',
        rect: [100, 200, 260, 220],
        quadPoints: [100, 220, 260, 220, 100, 200, 260, 200],
        contents: 'highlight note',
        author: 'bob',
        color: [1, 1, 0],
        flags: 4,
      },
      { page: 2, subtype: 'Ink', rect: [40, 40, 120, 90], inkList: [[10, 10, 20, 20, 30, 15]], contents: 'ink note', author: 'carol', flags: 4 },
      { page: 1, subtype: 'Link', rect: [10, 10, 200, 30], uri: 'https://example.com/', flags: 4 },
      { page: 1, subtype: 'Widget', rect: [10, 250, 200, 270], fieldType: 'Tx', contents: '', author: '', flags: 4 },
      { page: 1, subtype: 'Popup', rect: [30, 280, 130, 320], parentIndex: 0, flags: 4 },
    ],
  });
}

/* ------------------------------------------------------------------ *
 * 1) 新增 text（带 / 不带 rect）与 square：回读一致，页面文字不变
 * ------------------------------------------------------------------ */

test('PDF 注解写入：新增 text（带/不带 rect）与 square，回读一致、页面文字不变', {
  timeout: 120_000,
  skip: skipWriter,
}, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const pdfPath = path.join(ws.dir, 'report.pdf');
  await writeFile(pdfPath, standardPdf());

  const textBefore = await pdfSupport.extractText(pdfPath, [1, 2, 3]);
  const before = await readAnnotsRaw(ws.dir, pdfPath);

  const result = await annotate({
    filePath: pdfPath,
    operations: {
      add: [
        { type: 'text', note: 'first agent note', page: 1, rect: { x: 0.5, y: 0.1, width: 0.1, height: 0.05 } },
        { type: 'text', note: 'margin note', page: 3 },
        { type: 'square', note: 'agent box', page: 2, rect: { x: 0.2, y: 0.2, width: 0.4, height: 0.3 } },
      ],
    },
  });

  // 五项校验 + sidecar 回读，顺序固定
  assert.deepEqual(checkNames(result), [
    'writer-exit',
    'qpdf-check',
    'page-text',
    'annotation-readback',
    'other-annotations',
    'sidecar-readback',
  ]);
  assert.deepEqual(result.checks.filter((check) => check.ok !== true), []);
  // 就地写回：嵌入目标就是 PDF 本身
  assert.equal(result.embed.target, pdfPath);
  assert.equal(pdfAnnotationEmbedder.embedTarget(pdfPath), pdfPath);
  assert.equal(PDF_ANNOTATION_EMBED_TARGET, 'in-place');
  assert.equal(result.imported, 4);

  // 页面文字与页数不变
  const textAfter = await pdfSupport.extractText(pdfPath, [1, 2, 3]);
  for (const page of [1, 2, 3]) {
    assert.equal(textAfter.pages.get(page), textBefore.pages.get(page));
  }

  // 批注真的写进了 /Annots
  const after = await readAnnotsRaw(ws.dir, pdfPath);
  const agentNotes = after.filter((annot) => annot.contents === 'first agent note'
    || annot.contents === 'margin note'
    || annot.contents === 'agent box');
  assert.equal(agentNotes.length, 3);
  const byNote = (note) => agentNotes.find((annot) => annot.contents === note);
  assert.equal(byNote('first agent note').subtype, 'Text');
  assert.equal(byNote('first agent note').author, 'Agent');
  assert.equal(byNote('margin note').subtype, 'Text');
  assert.equal(byNote('margin note').page, 3);
  assert.equal(byNote('agent box').subtype, 'Square');
  // square 的 /Rect：请求 (0.2,0.2,0.4,0.3) on 300x400 → 显示 (60,80)-(180,200) →
  // PDF y 翻转 (60, 200)-(180, 320)，mupdf 每边再放大 1pt
  closeTo(byNote('agent box').rect, [60, 200, 180, 320], 2, 'square /Rect');

  // 原有批注一个都没丢；受保护的 Link / Widget / Popup 数量不变
  assert.equal(countOf(before, 'Link'), countOf(after, 'Link'));
  assert.equal(countOf(before, 'Widget'), countOf(after, 'Widget'));
  assert.equal(countOf(before, 'Popup'), countOf(after, 'Popup'));
  assert.equal(countOf(after, 'Highlight'), 1);
  assert.equal(countOf(after, 'Ink'), 1);

  await assertNoTemp(ws.dir, 'no temporary file may be left behind');
});

/* ------------------------------------------------------------------ *
 * 2) 不带 rect 的 text 在同一页横向错开
 * ------------------------------------------------------------------ */

test('PDF 注解写入：同一页多个不带 rect 的 text 横向错开，不叠在一起', {
  timeout: 120_000,
  skip: skipWriter,
}, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const pdfPath = path.join(ws.dir, 'margin.pdf');
  await writeFile(pdfPath, buildAnnotatedPdf({ pageCount: 1 }));

  const result = await annotate({
    filePath: pdfPath,
    operations: {
      add: [
        { type: 'text', note: 'margin one', page: 1 },
        { type: 'text', note: 'margin two', page: 1 },
        { type: 'text', note: 'margin three', page: 1 },
      ],
    },
  });
  assert.deepEqual(result.checks.filter((check) => check.ok !== true), []);

  const annots = (await readAnnotsRaw(ws.dir, pdfPath)).filter((annot) => annot.subtype === 'Text');
  assert.equal(annots.length, 3);
  const xs = annots.map((annot) => annot.rect[0]).sort((a, b) => a - b);
  // 320 高的页面上，三个图标都在左上角同一行，但 x 依次错开
  for (let index = 1; index < xs.length; index += 1) {
    assert.ok(xs[index] - xs[index - 1] >= 20, `icons must not stack: ${JSON.stringify(xs)}`);
  }
  for (const annot of annots) {
    // 显示坐标 y=12..32（400 高的页面）→ PDF /Rect y 368..388
    closeTo([annot.rect[1], annot.rect[3]], [368, 388], 2, 'margin icons sit at the top of the page');
  }
});

/* ------------------------------------------------------------------ *
 * 3) rect 在 /Rotate 0/90/180/270（含 /CropBox）下都落在正确的 PDF 坐标
 * ------------------------------------------------------------------ */

test('PDF 注解写入：rect 在 /Rotate 0/90/180/270（含 /CropBox）下都换算正确', {
  timeout: 120_000,
  skip: skipWriter,
}, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  // 400x400 页面 + CropBox [50 50 350 350]：四种旋转下 display 尺寸都是 300x300。
  // 请求 fraction (0.1,0.2,0.2,0.1) → display (30,60)-(90,90)。
  const cases = [
    { rotate: 0, expected: [80, 260, 140, 290] },
    { rotate: 90, expected: [110, 80, 140, 140] },
    { rotate: 180, expected: [260, 110, 320, 140] },
    { rotate: 270, expected: [260, 260, 290, 320] },
  ];

  for (const { rotate, expected } of cases) {
    const pdfPath = path.join(ws.dir, `rot${rotate}.pdf`);
    await writeFile(pdfPath, buildAnnotatedPdf({
      pageCount: 1,
      width: 400,
      height: 400,
      cropBox: [50, 50, 350, 350],
      rotate,
    }));

    const result = await annotate({
      filePath: pdfPath,
      operations: {
        add: [{ type: 'square', note: `rotated ${rotate}`, page: 1, rect: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 } }],
      },
    });
    assert.deepEqual(result.checks.filter((check) => check.ok !== true), [], `rotation ${rotate}`);

    const annots = await readAnnotsRaw(ws.dir, pdfPath);
    assert.equal(annots.length, 1, `rotation ${rotate}`);
    closeTo(annots[0].rect, expected, 2, `rotation ${rotate} /Rect`);

    // 回读的 fraction 与写入的 rect 一致（同样经过旋转换算）
    const entry = result.annotations.entries[0];
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.ok(
        Math.abs(entry.rect[key] - { x: 0.1, y: 0.2, width: 0.2, height: 0.1 }[key]) < 0.01,
        `rotation ${rotate} ${key}: ${entry.rect[key]}`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * 4) 首次写入导入全部 markup 批注：id 顺序 page → rect.y → rect.x
 * ------------------------------------------------------------------ */

test('PDF 导入：首次写入导入全部 markup 批注，id 顺序 page → rect.y → rect.x', {
  timeout: 120_000,
  skip: skipWriter,
}, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const pdfPath = path.join(ws.dir, 'import.pdf');
  // /Annots 顺序故意打乱：Square（y=0.6）在前，Text（y=0.2）在后；
  // 第 2 页还有一条 Ink；Link / Widget / Popup 不算 markup，不导入。
  await writeFile(pdfPath, buildAnnotatedPdf({
    annotations: [
      { page: 1, subtype: 'Square', rect: [10, 100, 60, 160], contents: 'square note', author: 'alice', flags: 4 },
      { page: 1, subtype: 'Text', rect: [10, 300, 30, 320], contents: 'text note', author: 'bob', flags: 4, popupIndex: 5 },
      { page: 2, subtype: 'Ink', rect: [40, 40, 120, 90], inkList: [[10, 10, 20, 20]], contents: 'ink note', author: 'carol', flags: 4 },
      { page: 1, subtype: 'Link', rect: [10, 10, 200, 30], uri: 'https://example.com/', flags: 4 },
      { page: 1, subtype: 'Widget', rect: [10, 250, 200, 270], fieldType: 'Tx', flags: 4 },
      { page: 1, subtype: 'Popup', rect: [30, 280, 130, 320], parentIndex: 1, flags: 4 },
    ],
  }));

  const probe = await probeOf(pdfPath);
  // 读侧接线：probe 里能看到三条 markup 批注（Link / Widget / Popup 不算）
  assert.equal(probe.annotationOutline.available, true);
  assert.equal(probe.annotationOutline.source, 'pdf-annotations');
  assert.equal(probe.annotationOutline.total, 3);

  const result = await annotationEngine.execute({
    filePath: pdfPath,
    media: 'pdf',
    probe,
    operations: { add: [{ type: 'text', note: 'agent note', page: 3 }] },
    context: { author: 'Agent' },
  });
  assert.deepEqual(result.checks.filter((check) => check.ok !== true), []);
  assert.equal(result.created, true);
  assert.equal(result.imported, 3);

  const entries = result.annotations.entries;
  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.type, entry.note, entry.author]),
    [
      ['n1', 'text', 'text note', 'bob'], // page 1, rect.y = 0.2
      ['n2', 'square', 'square note', 'alice'], // page 1, rect.y = 0.6
      ['n3', 'ink', 'ink note', 'carol'], // page 2
      ['n4', 'text', 'agent note', 'Agent'], // 新增
    ],
  );
  // 不可新建的类型保留原始几何，用来在后续写入里「认领」同一个批注对象
  assert.equal(entries[2].raw.subtype, 'Ink');
  assert.deepEqual(entries[2].raw.rect, [40, 40, 120, 90]);
  assert.deepEqual(entries[2].raw.inkList, [[10, 10, 20, 20]]);
  assert.equal(entries[0].raw.subtype, 'Text');
  assert.equal(entries[1].raw.subtype, 'Square');

  // sidecar 真的落盘了，且与结果一致
  assert.equal(existsSync(annotationEngine.sidecarPath(pdfPath)), true);
  const sidecar = JSON.parse(await readFile(annotationEngine.sidecarPath(pdfPath), 'utf8'));
  assert.equal(sidecar.entries.length, 4);
});

/* ------------------------------------------------------------------ *
 * 5) 未改动的条目保留原注释对象与外观流
 * ------------------------------------------------------------------ */

test('PDF 往返：未改动的条目保留原注释对象与 /AP 外观流，只重建改动的条目', {
  timeout: 120_000,
  skip: skipWriter,
}, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const pdfPath = path.join(ws.dir, 'roundtrip.pdf');
  await writeFile(pdfPath, standardPdf());

  const first = await annotate({
    filePath: pdfPath,
    operations: { add: [{ type: 'text', note: 'agent note', page: 3 }] },
  });
  assert.deepEqual(first.checks.filter((check) => check.ok !== true), []);

  const textEntry = first.annotations.entries.find((entry) => entry.note === 'note one');
  const highlightEntry = first.annotations.entries.find((entry) => entry.type === 'highlight');
  assert.ok(textEntry && highlightEntry);

  const beforeAnnots = await readAnnotsRaw(ws.dir, pdfPath);
  const beforeByNote = new Map(beforeAnnots.map((annot) => [`${annot.page}|${annot.contents}`, annot]));

  // 只改一条导入批注的 note；其余条目原样不动
  const second = await annotate({
    filePath: pdfPath,
    operations: { update: [{ id: highlightEntry.id, note: 'edited highlight' }] },
  });
  assert.deepEqual(second.checks.filter((check) => check.ok !== true), []);

  const afterAnnots = await readAnnotsRaw(ws.dir, pdfPath);
  const afterByNote = new Map(afterAnnots.map((annot) => [`${annot.page}|${annot.contents}`, annot]));

  // 改过的只剩一条：highlight 的 note 变了，但对象还在原页原位置
  const editedHighlight = afterAnnots.find((annot) => annot.contents === 'edited highlight');
  assert.ok(editedHighlight);
  assert.equal(editedHighlight.subtype, 'Highlight');
  assert.deepEqual(editedHighlight.rect, beforeByNote.get(`1|highlight note`).rect);
  assert.equal(afterAnnots.filter((annot) => annot.subtype === 'Highlight').length, 1);

  // 未改动的批注：/AP 字节、/Rect、/Contents、/T 全部原封不动
  for (const note of ['note one', 'square note', 'ink note']) {
    const before = beforeAnnots.find((annot) => annot.contents === note);
    assert.ok(before, `missing ${note} before`);
    const after = afterByNote.get(`${before.page}|${note}`);
    assert.ok(after, `missing ${note} after`);
    assert.equal(after.subtype, before.subtype);
    assert.deepEqual(after.rect, before.rect);
    assert.equal(after.author, before.author);
    assert.equal(after.apText, before.apText, `appearance stream of "${note}" must be preserved byte for byte`);
  }

  // Link / Widget / Popup 数量不变
  for (const kind of ['Link', 'Widget', 'Popup']) {
    assert.equal(countOf(afterAnnots, kind), countOf(beforeAnnots, kind), kind);
  }
});

/* ------------------------------------------------------------------ *
 * 6) 删除条目：批注消失，Popup 随父对象移除，Link / Widget 不受影响
 * ------------------------------------------------------------------ */

test('PDF 往返：删除条目后批注消失，孤儿子 Popup 随父对象移除，Link / Widget 不动', {
  timeout: 120_000,
  skip: skipWriter,
}, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const pdfPath = path.join(ws.dir, 'delete.pdf');
  await writeFile(pdfPath, standardPdf());

  const first = await annotate({
    filePath: pdfPath,
    operations: { add: [{ type: 'square', note: 'keep me', page: 3, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }] },
  });
  assert.deepEqual(first.checks.filter((check) => check.ok !== true), []);

  const textEntry = first.annotations.entries.find((entry) => entry.note === 'note one');
  const beforeAnnots = await readAnnotsRaw(ws.dir, pdfPath);
  const linkBefore = beforeAnnots.filter((annot) => annot.subtype === 'Link');
  const widgetBefore = beforeAnnots.filter((annot) => annot.subtype === 'Widget');
  assert.equal(countOf(beforeAnnots, 'Popup'), 1);

  // 删除带 Popup 的 Text：popup 必须跟着走，否则 /Parent 悬空
  const second = await annotate({ filePath: pdfPath, operations: { remove: [textEntry.id] } });
  assert.deepEqual(second.checks.filter((check) => check.ok !== true), []);
  const otherCheck = second.checks.find((check) => check.name === 'other-annotations');
  assert.match(otherCheck.detail, /removed with their replaced annotation/);

  const afterAnnots = await readAnnotsRaw(ws.dir, pdfPath);
  assert.equal(afterAnnots.filter((annot) => annot.contents === 'note one').length, 0);
  assert.equal(countOf(afterAnnots, 'Popup'), 0);
  assert.deepEqual(afterAnnots.filter((annot) => annot.subtype === 'Link'), linkBefore);
  assert.deepEqual(afterAnnots.filter((annot) => annot.subtype === 'Widget'), widgetBefore);
  // 其他批注还在
  assert.equal(afterAnnots.filter((annot) => annot.contents === 'square note').length, 1);
  assert.equal(afterAnnots.filter((annot) => annot.contents === 'keep me').length, 1);
});

/* ------------------------------------------------------------------ *
 * 7) 加密 PDF：明确拒绝
 * ------------------------------------------------------------------ */

test('PDF 拒绝：加密 PDF 明确报错，原文件不动、无临时文件', {
  timeout: 120_000,
  skip: skipWriterQpdf,
}, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const plainPath = path.join(ws.dir, 'plain.pdf');
  const encryptedPath = path.join(ws.dir, 'encrypted.pdf');
  await writeFile(plainPath, standardPdf());
  const encrypted = runTool('qpdf', ['--encrypt', 'user', 'owner', '256', '--', plainPath, encryptedPath]);
  assert.equal(encrypted.code, 0, encrypted.stderr);

  const hashBefore = await sha256(encryptedPath);

  // 嵌入器自己必须先拒绝（探针层对加密 PDF 的读取是读侧票的事，这里直接
  // 调用嵌入器，保证拒绝逻辑与它的清晰报错不依赖探针）
  const embedderError = await errorOf(
    createPdfAnnotationEmbedder().embed({ filePath: encryptedPath, media: 'pdf', entries: [] }),
  );
  assert.equal(embedderError.code, 'UNSUPPORTED_MEDIA_TYPE');
  assert.match(embedderError.message, /encrypted/);
  assert.match(embedderError.hint, /qpdf --decrypt/);
  assert.equal(await sha256(encryptedPath), hashBefore);

  // 引擎路径同样拒绝：嵌入器的错误原样往上抛，sidecar 不会写
  const engineError = await errorOf(annotationEngine.execute({
    filePath: encryptedPath,
    media: 'pdf',
    probe: { pageCount: 3 },
    operations: { add: [{ type: 'text', note: 'x', page: 1 }] },
    context: { author: 'Agent' },
  }));
  assert.equal(engineError.code, 'UNSUPPORTED_MEDIA_TYPE');
  assert.match(engineError.message, /encrypted/);

  assert.equal(await sha256(encryptedPath), hashBefore);
  await assertNoTemp(ws.dir);
  assert.equal(existsSync(annotationEngine.sidecarPath(encryptedPath)), false);
});

/* ------------------------------------------------------------------ *
 * 8) 已签名 PDF：明确拒绝
 * ------------------------------------------------------------------ */

test('PDF 拒绝：已签名 PDF 明确报错，原文件不动、无临时文件', {
  timeout: 120_000,
  skip: skipWriter,
}, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const pdfPath = path.join(ws.dir, 'signed.pdf');
  await writeFile(pdfPath, buildAnnotatedPdf({
    annotations: [{ page: 1, subtype: 'Text', rect: [10, 300, 30, 320], contents: 'note', author: 'alice', flags: 4 }],
    signed: true,
  }));

  const hashBefore = await sha256(pdfPath);
  const error = await errorOf(annotate({
    filePath: pdfPath,
    operations: { add: [{ type: 'text', note: 'x', page: 1 }] },
  }));
  assert.equal(error.code, 'UNSUPPORTED_MEDIA_TYPE');
  assert.match(error.message, /digitally signed/);
  assert.match(error.message, /Signature1/);
  assert.match(error.hint, /signature/);
  assert.equal(await sha256(pdfPath), hashBefore);
  await assertNoTemp(ws.dir);
  assert.equal(existsSync(annotationEngine.sidecarPath(pdfPath)), false);
});

/* ------------------------------------------------------------------ *
 * 9) 缺 mutool → TOOL_NOT_FOUND + 安装提示
 * ------------------------------------------------------------------ */

test('PDF 缺工具：没有 mutool → TOOL_NOT_FOUND 且带安装提示', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const pdfPath = path.join(ws.dir, 'nofile.pdf');
  await writeFile(pdfPath, standardPdf());

  const embedder = createPdfAnnotationEmbedder({
    runCommand: async () => {
      throw new ToolError('TOOL_NOT_FOUND', 'missing', '');
    },
  });
  const error = await errorOf(embedder.embed({ filePath: pdfPath, media: 'pdf', entries: [] }));
  assert.equal(error.code, 'TOOL_NOT_FOUND');
  assert.match(error.message, /mutool/);
  assert.match(error.hint, /mupdf-tools/);
});

/* ------------------------------------------------------------------ *
 * 10) 坏 writer：原文件不动、临时文件清理、checks 报告失败
 * ------------------------------------------------------------------ */

test('PDF 坏 writer：原文件哈希不变、临时文件被清理、check 报告失败且不写 sidecar', {
  timeout: 120_000,
  skip: skipWriter,
}, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const pdfPath = path.join(ws.dir, 'broken.pdf');
  await writeFile(pdfPath, standardPdf());
  const hashBefore = await sha256(pdfPath);

  // 真 mutool 的 preflight/read 照常，只有 write 模式返回垃圾
  const embedder = createPdfAnnotationEmbedder({
    runCommand: async (bin, args, options) => {
      const result = await run(bin, args, options);
      if (args.includes('write')) return { code: 0, stdout: 'garbage\n', stderr: '' };
      return result;
    },
  });

  const error = await errorOf(annotate({
    filePath: pdfPath,
    operations: { add: [{ type: 'text', note: 'nope', page: 1 }] },
    embedder,
  }));
  assert.equal(error.code, 'INTERNAL');
  assert.match(error.message, /writer-exit/);
  assert.match(error.message, /sidecar was not written/);
  assert.equal(await sha256(pdfPath), hashBefore);
  await assertNoTemp(ws.dir);
  assert.equal(existsSync(annotationEngine.sidecarPath(pdfPath)), false);
});

/* ------------------------------------------------------------------ *
 * 11) probe.annotationOutline 接线
 * ------------------------------------------------------------------ */

test('probe.annotationOutline：有批注 / 无批注 / 非 PDF 三种形状', {
  timeout: 120_000,
  skip: skipWriter,
}, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const annotated = path.join(ws.dir, 'annotated.pdf');
  await writeFile(annotated, buildAnnotatedPdf({
    annotations: [
      { page: 1, subtype: 'Text', rect: [10, 300, 30, 320], contents: 'note one', author: 'alice', flags: 4 },
      { page: 2, subtype: 'Square', rect: [40, 100, 120, 160], contents: 'square note', flags: 4 },
    ],
  }));
  const withAnnotations = (await probeOf(annotated)).annotationOutline;
  assert.equal(withAnnotations.available, true);
  assert.equal(withAnnotations.source, 'pdf-annotations');
  assert.equal(withAnnotations.total, 2);
  assert.equal(withAnnotations.reason, null);
  assert.deepEqual(Object.keys(withAnnotations.entries[0]).sort(), ['author', 'note', 'page', 'raw', 'rect', 'type']);
  assert.equal(withAnnotations.entries[0].type, 'text');
  assert.equal(withAnnotations.entries[0].note, 'note one');
  assert.equal(withAnnotations.entries[0].author, 'alice');
  assert.equal(withAnnotations.entries[1].type, 'square');

  const plain = path.join(ws.dir, 'plain.pdf');
  await writeFile(plain, buildAnnotatedPdf());
  const withoutAnnotations = (await probeOf(plain)).annotationOutline;
  assert.equal(withoutAnnotations.available, false);
  assert.equal(withoutAnnotations.source, null);
  assert.equal(withoutAnnotations.total, 0);
  assert.deepEqual(withoutAnnotations.entries, []);
  assert.match(withoutAnnotations.reason, /no annotations/);

  const image = path.join(ws.dir, 'pixel.png');
  await writeFile(image, PNG_PIXEL);
  const notPdf = (await probeOf(image)).annotationOutline;
  assert.equal(notPdf.available, false);
  assert.match(notPdf.reason, /only PDF documents/);
});

/* ------------------------------------------------------------------ *
 * 12) 预约取消
 * ------------------------------------------------------------------ */

test('PDF 注解写入：取消（已 abort）抛 AbortError 且不留临时文件、不写 sidecar', {
  timeout: 120_000,
  skip: skipWriter,
}, async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const pdfPath = path.join(ws.dir, 'abort.pdf');
  await writeFile(pdfPath, standardPdf());
  const hashBefore = await sha256(pdfPath);

  const embedder = createPdfAnnotationEmbedder();
  const controller = new AbortController();
  controller.abort();
  const error = await errorOf(embedder.embed({
    filePath: pdfPath,
    media: 'pdf',
    entries: [],
    signal: controller.signal,
  }));
  assert.equal(error.name, 'AbortError');
  assert.equal(await sha256(pdfPath), hashBefore);
  await assertNoTemp(ws.dir);
});

/* ------------------------------------------------------------------ *
 * 13) 独立的 PDF 副本也走一遍（避免只覆盖手工 fixture 的形状）
 * ------------------------------------------------------------------ */

test('PDF 注解写入：仓库 fixtures 里的 PDF 也能加批注（若存在）', {
  timeout: 120_000,
  skip: skipWriter,
}, async (t) => {
  const fixturesDir = path.resolve(import.meta.dirname, '../../fixtures/generated');
  const sample = path.join(fixturesDir, 'sample-outline.pdf');
  if (!existsSync(sample)) {
    t.skip('fixtures/generated/sample-outline.pdf is not generated');
    return;
  }
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const pdfPath = path.join(ws.dir, 'sample.pdf');
  await copyFile(sample, pdfPath);

  const textBefore = await pdfSupport.extractText(pdfPath, [1]);
  const result = await annotate({
    filePath: pdfPath,
    operations: {
      add: [{ type: 'text', note: 'fixture note', page: 1, rect: { x: 0.4, y: 0.6, width: 0.05, height: 0.05 } }],
    },
  });
  assert.deepEqual(result.checks.filter((check) => check.ok !== true), []);
  const annots = await readAnnotsRaw(ws.dir, pdfPath);
  assert.equal(annots.filter((annot) => annot.contents === 'fixture note').length, 1);
  const textAfter = await pdfSupport.extractText(pdfPath, [1]);
  assert.equal(textAfter.pages.get(1), textBefore.pages.get(1));
});
