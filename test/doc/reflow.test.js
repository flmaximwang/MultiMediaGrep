// test/doc/reflow.test.js —— builtin typeset 的双栏重排（9z5.24）
//
// 覆盖三块：
//   1. 纯函数：柱检测 / 重排 / blocks 启发式（不依赖 PDF 工具）；
//   2. fixture 集成：sample-twocolumn.pdf 的双栏页重排、单栏与表格页不回归；
//   3. 路由集成：MMGREP_TYPESET_SKIP_SIMPLE 决定外部 provider 收到哪些页。

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createDocumentBackend } from '../../src/backend/document/index.js';
import { createPdfSupport } from '../../src/backend/document/pdf.js';
import {
  COLUMN_DETECTION,
  detectColumns,
  reflowTwoColumn,
  splitParagraphs,
  textToBlocks,
} from '../../src/providers/doc/builtin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATED = path.join(ROOT, 'fixtures', 'generated');
const GROUND_TRUTH = path.join(ROOT, 'fixtures', 'ground-truth');
const TWOCOL_PDF = path.join(GENERATED, 'sample-twocolumn.pdf');
const TEXT_PDF = path.join(GENERATED, 'sample-text.pdf');
const TWOCOL_GT_FILE = path.join(GROUND_TRUTH, 'sample-twocolumn-pdf.json');

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const fixturesReady = await exists(TWOCOL_PDF) && await exists(TEXT_PDF);
const pdfTools = await createPdfSupport().resolveTools();
const skipPdf = !fixturesReady || !pdfTools.textExtractor
  ? 'sample PDF fixtures and a PDF text extractor (pdftotext / mutool) are required'
  : false;
const skipPdfToTextRaw = skipPdf || pdfTools.textExtractor !== 'pdftotext'
  ? 'the raw-reading-order evidence test needs the pdftotext binary'
  : false;
const TWOCOL_GT = fixturesReady
  ? JSON.parse(await readFile(TWOCOL_GT_FILE, 'utf8'))
  : null;

async function withCache(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-reflow-'));
  const previous = process.env.MMGREP_CACHE_DIR;
  process.env.MMGREP_CACHE_DIR = path.join(dir, 'cache');
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.MMGREP_CACHE_DIR;
    else process.env.MMGREP_CACHE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * 纯函数：柱检测
 * ------------------------------------------------------------------ */

const LEFT_LINES = [
  'Programmable small RNA-protein complexes',
  'enable a single protein to serve as a',
  'flexible scaffold for targeting. These',
  'systems are limited by off-target activity',
  'and unknown interactions in primary cells.',
];
const RIGHT_LINES = [
  'To address these limitations, we developed',
  'a modular platform that couples engineered',
  'guide RNAs with a compact effector domain.',
  'The resulting complexes remain programmable',
  'while reducing unintended interactions.',
];

/** 构造 pdftotext -layout 风格的双栏页文本。 */
function twoColumnLayoutText() {
  const title = 'A SYNTHETIC TWO-COLUMN PAPER TITLE';
  const abstract = 'ABSTRACT: This fixture exercises the two-column reflow path with a full-width header.';
  const rows = LEFT_LINES.map((line, index) => `${line.padEnd(56)}    ${RIGHT_LINES[index]}`);
  return [title, abstract, '', ...rows].join('\n');
}

test('COLUMN_DETECTION：阈值是常量，80% 空白行阈值可被测试引用', () => {
  assert.equal(COLUMN_DETECTION.MIN_BLANK_RATIO, 0.8);
  assert.ok(COLUMN_DETECTION.MIN_GUTTER_WIDTH_CHARS >= 2);
  assert.ok(COLUMN_DETECTION.MAX_COLUMN_WIDTH_DIFFERENCE > 0);
});

test('detectColumns：双栏 layout → 中缝居中、两栏宽度相近', () => {
  const detection = detectColumns(twoColumnLayoutText());
  assert.equal(detection.twoColumn, true);
  assert.ok(detection.gutter, 'gutter must be detected');
  assert.ok(detection.gutter.width >= COLUMN_DETECTION.MIN_GUTTER_WIDTH_CHARS);
  assert.ok(detection.columns.left.lines >= COLUMN_DETECTION.MIN_COLUMN_LINES);
  assert.ok(detection.columns.right.lines >= COLUMN_DETECTION.MIN_COLUMN_LINES);
  const { left, right } = detection.columns;
  const asymmetry = Math.abs(left.width - right.width) / Math.max(left.width, right.width);
  assert.ok(asymmetry <= COLUMN_DETECTION.MAX_COLUMN_WIDTH_DIFFERENCE);
});

test('detectColumns：单栏正文与表格页不判双栏', () => {
  const single = [
    'A single-column page must not be reflowed. The',
    'table below keeps its layout and cell contents.',
    'The reflow detector must leave this page alone.',
    'These lines are short and ragged on the right.',
    'Nothing here looks like two balanced columns.',
  ].join('\n');
  assert.equal(detectColumns(single).twoColumn, false);

  const table = [
    'KEY                         VALUE                NOTE',
    'ALPHA                       ONE                  FIRST',
    'BETA                        TWO                  SECOND',
    'GAMMA                       THREE                THIRD',
    'DELTA                       FOUR                 FOURTH',
  ].join('\n');
  assert.equal(detectColumns(table).twoColumn, false);
});

/* ------------------------------------------------------------------ *
 * 纯函数：重排与 blocks
 * ------------------------------------------------------------------ */

test('reflowTwoColumn：左栏整段连续，右栏整段连续，句子不跨栏', () => {
  const reflowed = reflowTwoColumn(twoColumnLayoutText());
  const lines = reflowed.split('\n');

  // 左栏最后一行必须出现在右栏第一行之前；两栏内部保持原顺序。
  const leftIndexes = LEFT_LINES.map((line) => reflowed.indexOf(line));
  const rightIndexes = RIGHT_LINES.map((line) => reflowed.indexOf(line));
  for (const index of [...leftIndexes, ...rightIndexes]) assert.ok(index >= 0, 'every line must survive reflow');
  for (let i = 1; i < leftIndexes.length; i += 1) assert.ok(leftIndexes[i - 1] < leftIndexes[i]);
  for (let i = 1; i < rightIndexes.length; i += 1) assert.ok(rightIndexes[i - 1] < rightIndexes[i]);
  assert.ok(leftIndexes.at(-1) < rightIndexes[0], 'the left column must come before the right column');

  // 重排后的每一行只属于一栏，不能把左右两栏拼在同一行。
  for (const line of lines) {
    for (const leftLine of LEFT_LINES) {
      if (!line.includes(leftLine)) continue;
      for (const rightLine of RIGHT_LINES) assert.equal(line.includes(rightLine), false);
    }
  }

  // 横跨中缝的标题 / 摘要整行保留在栏内容之前。
  assert.ok(reflowed.indexOf('A SYNTHETIC TWO-COLUMN PAPER TITLE') >= 0);
  assert.ok(reflowed.indexOf('A SYNTHETIC TWO-COLUMN PAPER TITLE') < leftIndexes[0]);
  assert.ok(reflowed.indexOf('ABSTRACT:') > reflowed.indexOf('A SYNTHETIC TWO-COLUMN PAPER TITLE'));
  assert.ok(reflowed.indexOf('ABSTRACT:') < leftIndexes[0]);
});

test('textToBlocks：编号标题 level 按编号深度；Fig./Table 开头 → caption', () => {
  const blocks = textToBlocks([
    '1. Introduction',
    '',
    'This is a normal paragraph. It ends with a period.',
    '',
    '2.3 Methods',
    '',
    'Fig. 1. Left column before right column.',
    '',
    'Table 2. Heuristic block types.',
    '',
    'Second paragraph',
    '',
    'REFERENCES',
  ].join('\n'));

  assert.deepEqual(blocks, [
    { type: 'heading', level: 1, text: '1. Introduction' },
    { type: 'paragraph', text: 'This is a normal paragraph. It ends with a period.' },
    { type: 'heading', level: 2, text: '2.3 Methods' },
    { type: 'caption', text: 'Fig. 1. Left column before right column.' },
    { type: 'caption', text: 'Table 2. Heuristic block types.' },
    { type: 'paragraph', text: 'Second paragraph' },
    { type: 'heading', level: 1, text: 'REFERENCES' },
  ]);
});

/* ------------------------------------------------------------------ *
 * fixture 集成
 * ------------------------------------------------------------------ */

test('重排选择：无 -layout 的 poppler 阅读顺序在 fixture 第 2 页仍会交错（故按 gutter 切分）', {
  skip: skipPdfToTextRaw,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const { stdout } = await promisify(execFile)(
      'pdftotext',
      ['-enc', 'UTF-8', '-f', '2', '-l', '2', TWOCOL_PDF, '-'],
    );
    // 实测：raw 模式把右栏标题 "2.2" 排在左栏 "2.1" 之前，右栏正文也插在左栏之前。
    assert.ok(
      stdout.indexOf('2.2 Block heuristics') < stdout.indexOf('2.1 Reflow quality'),
      'raw reading order should interleave the two columns on this page (evidence for the gutter split)',
    );

    const layers = await createPdfSupport().extractTextLayers(TWOCOL_PDF, [2]);
    const reflowed = reflowTwoColumn(layers.pages.get(2).text);
    assert.ok(reflowed.indexOf('2.1 Reflow quality') < reflowed.indexOf('2.2 Block heuristics'));
    assert.ok(reflowed.indexOf('The reflowed page') < reflowed.indexOf('Short numbered lines'));
  });
});

test('builtin parse：sample-twocolumn.pdf 双栏页重排，单栏页与表格页不回归', {
  skip: skipPdf,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const pdfSupport = createPdfSupport();
    const layers = await pdfSupport.extractTextLayers(TWOCOL_PDF, [1, 2, 3]);
    const textLayers = Object.fromEntries([1, 2, 3].map((page) => [page, layers.pages.get(page).text]));

    const { createBuiltinTypesetProvider } = await import('../../src/providers/doc/builtin.js');
    const provider = createBuiltinTypesetProvider();
    const result = await provider.parse({ role: 'typeset', textLayers });
    const byPage = new Map(result.pages.map((page) => [page.page, page]));

    assert.deepEqual(result.raw.twoColumnPages, [1, 2]);
    assert.deepEqual(byPage.get(1).blocks, TWOCOL_GT.pages[0].expectedBlocks);
    assert.deepEqual(byPage.get(2).blocks, TWOCOL_GT.pages[1].expectedBlocks);

    // 第 3 页是单栏 + 表格：不能被重排，文字顺序与 -layout 一致。
    const page3Text = layers.pages.get(3).text;
    assert.equal(detectColumns(page3Text).twoColumn, false);
    assert.equal(byPage.get(3).text, splitParagraphs(page3Text).join('\n\n'));
    const order = ['3. Conclusion', 'KEY', 'ALPHA', 'BETA', 'GAMMA'];
    const positions = order.map((needle) => byPage.get(3).text.indexOf(needle));
    for (let i = 1; i < positions.length; i += 1) assert.ok(positions[i - 1] < positions[i]);
    assert.equal(byPage.get(3).textOrigin, 'textlayer');

    // 双栏页的左右栏在最终 text 里也必须先后连续。
    const page1 = byPage.get(1).text;
    const lastLeft = TWOCOL_GT.pages[0].leftLines.at(-1);
    const firstRight = TWOCOL_GT.pages[0].rightLines[0];
    assert.ok(page1.indexOf(lastLeft) < page1.indexOf(firstRight), 'left column must end before the right starts');
    for (const line of TWOCOL_GT.pages[0].leftLines) assert.ok(page1.includes(line));
    for (const line of TWOCOL_GT.pages[0].rightLines) assert.ok(page1.includes(line));
  });
});

test('builtin parse：sample-text.pdf 的第 5/6 页（表格页）与当前输出一致', {
  skip: skipPdf,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const pdfSupport = createPdfSupport();
    const layers = await pdfSupport.extractTextLayers(TEXT_PDF, [5, 6]);
    const { createBuiltinTypesetProvider } = await import('../../src/providers/doc/builtin.js');
    const provider = createBuiltinTypesetProvider();
    const result = await provider.parse({
      role: 'typeset',
      textLayers: { 5: layers.pages.get(5).text, 6: layers.pages.get(6).text },
    });

    for (const page of result.pages) {
      const raw = layers.pages.get(page.page).text;
      assert.equal(detectColumns(raw).twoColumn, false);
      // .28 的 paragraph 输出 = 空行分段后用空行重新拼接；重排不得改变它。
      assert.equal(page.text, splitParagraphs(raw).join('\n\n'));
      assert.ok(page.blocks.length > 0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 路由集成：MMGREP_TYPESET_SKIP_SIMPLE
 * ------------------------------------------------------------------ */

function stubMineru() {
  const calls = [];
  const provider = {
    id: 'mineru',
    roles: ['ocr', 'typeset'],
    describe: () => ({ id: 'mineru', model: 'stub-mineru', baseUrl: null }),
    async parse(input) {
      calls.push(input);
      const pages = input.pages?.list
        ?? (input.pages?.from
          ? Array.from({ length: input.pages.to - input.pages.from + 1 }, (_, i) => input.pages.from + i)
          : []);
      return {
        provider: 'mineru',
        model: 'stub-mineru',
        pages: pages.map((page) => {
          const text = `external page ${page}`;
          return {
            page,
            textOrigin: 'textlayer',
            blocks: [{ type: 'paragraph', text }],
            text,
          };
        }),
      };
    },
  };
  return { provider, calls };
}

test('SKIP_SIMPLE=true（默认）：单栏页留在本地，只有双栏页发给外部 provider', {
  skip: skipPdf,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const stub = stubMineru();
    const backend = createDocumentBackend({
      typesetProvider: stub.provider,
      config: { typeset: { provider: 'mineru', apiKey: 'test-key' } },
    });

    const result = await backend.overview({
      path: TWOCOL_PDF,
      pages: [1, 2, 3],
      cells: 1,
      images: 0,
      maxEdge: 400,
    });

    assert.equal(stub.calls.length, 1);
    assert.deepEqual(stub.calls[0].pages, { from: 1, to: 2 }, 'page 3 is single-column: it must not be sent externally');
    assert.equal(stub.calls[0].role, 'typeset');
    assert.deepEqual(Object.keys(stub.calls[0].textLayers ?? {}), ['1', '2']);
    assert.match(stub.calls[0].textLayers[1], /Programmable small RNA-protein complexes/);
    assert.match(stub.calls[0].textLayers[2], /2\. Results/);

    const byPage = new Map(result.segments.map((segment) => [segment.page, segment]));
    assert.equal(byPage.get(1).text, 'external page 1');
    assert.equal(byPage.get(2).text, 'external page 2');
    // 第 3 页由 builtin 本地处理：仍然是表格页原文，不是 external。
    assert.match(byPage.get(3).text, /3\. Conclusion/);
    assert.doesNotMatch(byPage.get(3).text, /external/);
  });
});

test('SKIP_SIMPLE=false：所有有文字层的页都发给外部 provider', {
  skip: skipPdf,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const stub = stubMineru();
    const backend = createDocumentBackend({
      typesetProvider: stub.provider,
      config: { typeset: { provider: 'mineru', apiKey: 'test-key', skipSimple: false } },
    });

    const result = await backend.overview({
      path: TWOCOL_PDF,
      pages: [1, 2, 3],
      cells: 1,
      images: 0,
      maxEdge: 400,
    });

    assert.equal(stub.calls.length, 1);
    assert.deepEqual(stub.calls[0].pages, { from: 1, to: 3 });
    const byPage = new Map(result.segments.map((segment) => [segment.page, segment]));
    for (const page of [1, 2, 3]) assert.equal(byPage.get(page).text, `external page ${page}`);
  });
});

test('typeset=none：双栏页保持 -layout，并用 note 提醒阅读顺序可能交错', {
  skip: skipPdf,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: { typeset: { provider: 'none' } } });
    const result = await backend.overview({
      path: TWOCOL_PDF,
      pages: [1],
      cells: 1,
      images: 0,
      maxEdge: 400,
    });

    const note = result.warnings.find((warning) => /looks two-column/.test(warning));
    assert.ok(note, 'a two-column note is required when typeset is disabled');
    assert.match(note, /page 1 looks two-column; reading order may interleave/);
    assert.match(note, /MMGREP_TYPESET_PROVIDER=builtin/);
    // 没有重排：原始 -layout 的左右栏文字仍在同一行。
    assert.match(result.segments[0].text, /Programmable[\s\S]*To address/);
  });
});
