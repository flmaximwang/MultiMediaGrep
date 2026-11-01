/**
 * Hand-rolled PDF writer (no dependencies).
 *
 * Supports two page flavours:
 *   - `text`  pages: a content stream built from text / line / rectangle ops,
 *                  with Type1 base-14 fonts (Helvetica, Helvetica-Bold).
 *   - `image` pages: a single JPEG XObject (/DCTDecode) covering the page.
 *                  Image pages carry **no** /Font resource, which is exactly
 *                  what the "scanned document" fixture needs (no text layer).
 *
 * Content streams are written uncompressed on purpose: it keeps the output
 * byte-identical across runs and lets a plain regex-based parser extract the
 * text for ground-truth assertions.
 */

import crypto from 'node:crypto';

const BASE_FONTS = {
  F1: 'Helvetica',
  F2: 'Helvetica-Bold',
};

/** Escape a string for a PDF literal string `( ... )`. */
export function pdfEscapeString(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** One text-showing operator, positioned by a text matrix. */
export function pdfTextOp(x, y, text, { font = 'F1', size = 12 } = {}) {
  const n = Number.isInteger(size) ? size : Math.round(size * 100) / 100;
  return `BT /${font} ${n} Tf 1 0 0 1 ${x} ${y} Tm (${pdfEscapeString(text)}) Tj ET`;
}

/** A stroked line segment. */
export function pdfLineOp(x0, y0, x1, y1, { width = 1 } = {}) {
  return `${width} w ${x0} ${y0} m ${x1} ${y1} l S`;
}

/**
 * Extract the text runs written by `pdfTextOp` from a raw content stream.
 * Used by the test suite to compare the PDF text layer with the ground truth.
 */
export function extractTextOps(contentStream) {
  const out = [];
  const re = /1 0 0 1 ([\d.]+) ([\d.]+) Tm \((.*?)\) Tj/g;
  let m = re.exec(contentStream);
  while (m !== null) {
    const text = m[3].replace(/\\([()\\])/g, '$1');
    out.push({ x: Number(m[1]), y: Number(m[2]), text });
    m = re.exec(contentStream);
  }
  return out;
}

/**
 * Build a PDF file.
 *
 * Optional structures (9z5.33 fixtures):
 *   - `outline`: [{title, page, children?: [...]}, ...] — a PDF outline / bookmark
 *     tree. `page` is the 1-based PHYSICAL page (the page order in `pages`), not a
 *     printed page label. Nested `children` become level 2, 3, ... entries.
 *   - `pageLabels`: [{startPage, style, prefix?, start?}, ...] — PDF /PageLabels
 *     ranges. `startPage` is 1-based physical; `style` is a PDF label style letter
 *     ("D" decimal, "r"/"R" roman, "a"/"A" alphabetic). E.g.
 *     [{startPage: 1, style: "r"}, {startPage: 3, style: "D", start: 1}]
 *     labels physical pages 1-2 "i", "ii" and physical page 3 "1".
 *
 * @param {{pages: Array, outline?: Array|null, pageLabels?: Array|null}} spec
 * @returns {Buffer}
 */
export function buildPDF({ pages, outline = null, pageLabels = null }) {
  // Object 1 = catalog, object 2 = page tree; user objects start at 3.
  const objects = new Map();
  let nextNum = 3;

  const add = (body) => {
    const num = nextNum;
    nextNum += 1;
    objects.set(num, Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
    return num;
  };

  const addStream = (dict, payload) => {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'latin1');
    return add(
      Buffer.concat([
        Buffer.from(`${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
        data,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    );
  };

  const usedFonts = new Set();
  for (const page of pages) {
    if (page.kind === 'text') for (const f of page.fonts ?? []) usedFonts.add(f);
  }
  const fontObjNums = {};
  for (const [name, base] of Object.entries(BASE_FONTS)) {
    if (usedFonts.has(name)) {
      fontObjNums[name] = add(
        `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`,
      );
    }
  }

  const pageObjNums = [];
  for (const page of pages) {
    let content;
    let resources;
    let contentNum;
    if (page.kind === 'image') {
      const imageNum = addStream(
        '<< /Type /XObject /Subtype /Image /Width ' +
          `${page.imageWidth} /Height ${page.imageHeight} /ColorSpace /DeviceRGB ` +
          '/BitsPerComponent 8 /Filter /DCTDecode',
        page.jpeg,
      );
      content = ['q', `${page.width} 0 0 ${page.height} 0 0 cm`, '/Im0 Do', 'Q'].join('\n');
      contentNum = addStream('<<', content);
      resources = `<< /XObject << /Im0 ${imageNum} 0 R >> /ProcSet [/PDF /ImageB /ImageC] >>`;
    } else {
      contentNum = addStream('<<', page.ops.join('\n'));
      const fontRefs = (page.fonts ?? [])
        .map((f) => `/${f} ${fontObjNums[f]} 0 R`)
        .join(' ');
      resources = `<< /Font << ${fontRefs} >> /ProcSet [/PDF /Text] >>`;
    }
    const pageNum = add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] ` +
        `/Resources ${resources} /Contents ${contentNum} 0 R >>`,
    );
    pageObjNums.push(pageNum);
  }

  // /PageLabels（可选）：页码标签只影响「打印页码」，不影响物理页序号。
  let pageLabelsNum = null;
  if (Array.isArray(pageLabels) && pageLabels.length > 0) {
    const nums = pageLabels.map((spec) => {
      const index = Math.max(0, Number(spec.startPage ?? 1) - 1);
      const parts = [];
      if (spec.style) parts.push(`/S /${String(spec.style).replace(/^\//, '')}`);
      if (spec.prefix !== undefined) parts.push(`/P (${pdfEscapeString(spec.prefix)})`);
      if (spec.start !== undefined) parts.push(`/St ${Math.round(Number(spec.start))}`);
      return `${index} << ${parts.join(' ')} >>`;
    });
    pageLabelsNum = add(`<< /Nums [ ${nums.join(' ')} ] >>`);
  }

  // /Outlines（可选）：书签树。每个条目 /Dest 指向物理页对象，qpdf 会把它解析成
  // destpageposfrom1（1-based），与 media_overview 的 pages 参数同一口径。
  let outlineRootNum = null;
  if (Array.isArray(outline) && outline.length > 0) {
    const alloc = () => {
      const num = nextNum;
      nextNum += 1;
      return num;
    };
    const pageRefFor = (entry) => {
      const page = Number(entry?.page);
      if (!Number.isInteger(page) || page < 1 || page > pageObjNums.length) {
        throw new Error(`outline entry "${entry?.title}" has no valid physical page (${entry?.page})`);
      }
      return pageObjNums[page - 1];
    };
    const buildLevel = (entries, parentRef) => {
      const nums = entries.map(() => alloc());
      let descendantCount = 0;
      entries.forEach((entry, index) => {
        const children = Array.isArray(entry.children) ? entry.children : [];
        const child = children.length > 0 ? buildLevel(children, `${nums[index]} 0 R`) : null;
        const dict = [
          `/Title (${pdfEscapeString(entry.title)})`,
          `/Parent ${parentRef}`,
          `/Dest [${pageRefFor(entry)} 0 R /Fit]`,
        ];
        if (index > 0) dict.push(`/Prev ${nums[index - 1]} 0 R`);
        if (index < nums.length - 1) dict.push(`/Next ${nums[index + 1]} 0 R`);
        if (child) dict.push(`/First ${child.first} 0 R /Last ${child.last} 0 R /Count ${child.count}`);
        objects.set(nums[index], Buffer.from(`<< ${dict.join(' ')} >>`, 'latin1'));
        descendantCount += 1 + (child?.count ?? 0);
      });
      return { first: nums[0], last: nums[nums.length - 1], count: descendantCount };
    };
    const rootNum = alloc();
    const root = buildLevel(outline, `${rootNum} 0 R`);
    objects.set(
      rootNum,
      Buffer.from(
        `<< /Type /Outlines /First ${root.first} 0 R /Last ${root.last} 0 R /Count ${root.count} >>`,
        'latin1',
      ),
    );
    outlineRootNum = rootNum;
  }

  const total = nextNum - 1;

  const chunks = [];
  let offset = 0;
  const push = (buf) => {
    chunks.push(buf);
    offset += buf.length;
  };

  push(Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1'));

  const offsets = [];
  const writeObject = (num, body) => {
    offsets[num] = offset;
    push(Buffer.from(`${num} 0 obj\n`, 'latin1'));
    push(body);
    push(Buffer.from('\nendobj\n', 'latin1'));
  };

  const catalogParts = ['/Type /Catalog', '/Pages 2 0 R'];
  if (outlineRootNum !== null) catalogParts.push(`/Outlines ${outlineRootNum} 0 R`);
  if (pageLabelsNum !== null) catalogParts.push(`/PageLabels ${pageLabelsNum} 0 R`);
  writeObject(1, Buffer.from(`<< ${catalogParts.join(' ')} >>`, 'latin1'));
  writeObject(
    2,
    Buffer.from(
      `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageObjNums.length} >>`,
      'latin1',
    ),
  );
  for (let num = 3; num <= total; num += 1) {
    writeObject(num, objects.get(num));
  }

  const xrefStart = offset;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let num = 1; num <= total; num += 1) {
    xref += `${String(offsets[num]).padStart(10, '0')} 00000 n \n`;
  }
  push(Buffer.from(xref, 'latin1'));

  const id = crypto
    .createHash('sha256')
    .update(Buffer.concat([...objects.values()]))
    .digest('hex')
    .slice(0, 32);
  push(
    Buffer.from(
      `trailer\n<< /Size ${total + 1} /Root 1 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xrefStart}\n%%EOF\n`,
      'latin1',
    ),
  );

  return Buffer.concat(chunks);
}

/** Number of page objects in a PDF buffer (counts `/Type /Page` dicts). */
export function countPages(pdfBuffer) {
  const text = pdfBuffer.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
}

/**
 * Extract every content stream of a PDF buffer (only works for the
 * uncompressed streams this module writes).
 */
export function extractContentStreams(pdfBuffer) {
  const text = pdfBuffer.toString('latin1');
  const streams = [];
  const re = /stream\r?\n([\s\S]*?)\nendstream/g;
  let m = re.exec(text);
  while (m !== null) {
    streams.push(m[1]);
    m = re.exec(text);
  }
  return streams;
}
