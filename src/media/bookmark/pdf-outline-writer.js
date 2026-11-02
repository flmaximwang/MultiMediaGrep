// src/media/bookmark/pdf-outline-writer.js —— PDF outline 原地重写脚本（由 mutool run 执行）
//
// 为什么用 mutool（完整核实记录见 embedder-pdf.js 顶部注释）：
//   - mutool 1.28 的 mupdf JS API 有完整 outline 迭代器（insert / delete / up /
//     down / update），只改 /Outlines 树；doc.save() 默认按原字节复制页面内容流，
//     不会重新编码（实测内容流 shasum 不变）。
//   - qpdf 12.4.2 不能改 outline：`qpdf --json-help` 的输入键里没有 outlines
//     （outlines 只是输出键），`--update-from-json` 只能改附件之类的固定字段。
//   - ghostscript 会重新蒸馏整份 PDF（内容流、对象号全变），被任务书排除。
//   - 附带能力（9z5.38.2 注解嵌入器会复用）：mupdf JS 有 page.createAnnotation()
//     / page.deleteAnnotation()，能新建 Text / Square 注释并生成外观流。
//
// 这个文件同时必须能通过 `node --check`（scripts/check-syntax.mjs 扫 src/ 下所有
// .js），而 mutool 内置的是 MuJS（ES5）：因此这里只用 var / function / 字符串拼接，
// 不用 const / let / 箭头函数 / 模板字符串 / for...of —— 否则 node 侧能过、mutool
// 侧会在解析阶段失败（而且 mutool 解析失败时退出码是 0，stdout 无 JSON）。
//
// 用法（由 embedder-pdf.js 调用；stdout 只输出一行 JSON，失败时再 throw（退出码 1））：
//   mutool run pdf-outline-writer.js preflight <input.pdf>
//   mutool run pdf-outline-writer.js write <input.pdf> <output.pdf> <entries.json>
(function () {
  /** outline 条目数上限：防止坏输入把迭代器卡死 */
  var MAX_ITEMS = 100000;

  function fail(message) {
    throw new Error(message);
  }

  /** 尽量把间接引用解析成直接对象；解析失败就原样返回。 */
  function deref(object) {
    if (!object) return null;
    try {
      if (typeof object.resolve === 'function') {
        var resolved = object.resolve();
        if (resolved) return resolved;
      }
    } catch (error) {
      // 解析失败（坏引用）当作没有这个对象
    }
    return object;
  }

  /** 把 PDF 名字/字符串对象转成 JS 字符串；null → ''。 */
  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  /** 从 outline 条目的 uri（#page=12&view=Fit）里取 1-based 物理页号；取不到 → null。 */
  function pageFromUri(uri) {
    var raw = text(uri);
    var marker = raw.indexOf('#page=');
    if (marker < 0) return null;
    var rest = raw.substring(marker + 6);
    var digits = '';
    for (var i = 0; i < rest.length; i++) {
      var ch = rest.charAt(i);
      if (ch < '0' || ch > '9') break;
      digits += ch;
    }
    if (digits === '') return null;
    var page = parseInt(digits, 10);
    return page > 0 ? page : null;
  }

  /** 递归收集签名表单域：/FT /Sig 且 /V 非空 = 已签名。 */
  function collectSignatureFields(fields, out) {
    if (!fields) return out;
    var count = 0;
    try {
      count = fields.length === null || fields.length === undefined ? 0 : Number(fields.length);
    } catch (error) {
      return out;
    }
    for (var i = 0; i < count; i++) {
      var field = deref(fields.get(i));
      if (!field) continue;
      var fieldType = text(field.get('FT'));
      if (fieldType === '/Sig') {
        var value = field.get('V');
        out.push({ name: text(field.get('T')), signed: value !== null && value !== undefined });
      }
      var kids = field.get('Kids');
      if (kids && kids.isArray && kids.isArray()) collectSignatureFields(kids, out);
    }
    return out;
  }

  /** loadOutline() 的嵌套数组 → 扁平 [{title, page, level}]。 */
  function flattenOutline(items, level, out) {
    if (!items) return out;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      out.push({ title: text(item.title), page: pageFromUri(item.uri), level: level });
      if (item.down && item.down.length) flattenOutline(item.down, level + 1, out);
    }
    return out;
  }

  /** 只读检查：加密 / 需要密码 / 已签名 / 页数 / 现有 outline。 */
  function preflight(inputPath) {
    var doc = Document.openDocument(inputPath);
    var trailer = doc.getTrailer();
    var result = {
      ok: true,
      encrypted: false,
      needsPassword: false,
      pageCount: null,
      signatures: [],
      docMDP: false,
      outline: [],
      outlineError: null
    };
    try {
      result.encrypted = trailer.get('Encrypt') !== null;
    } catch (error) {
      // 读不到 trailer 的 Encrypt 就当没加密；后面的页数检查会兜底
    }
    try {
      result.needsPassword = doc.needsPassword() ? true : false;
    } catch (error) {
      // 同上
    }
    if (result.encrypted || result.needsPassword) {
      // 加密文档不继续读页面：避免 mupdf 静默用空密码解密后给出误导性结构
      return result;
    }
    result.pageCount = doc.countPages();
    try {
      var root = trailer.get('Root');
      if (root) {
        var acroForm = deref(root.get('AcroForm'));
        if (acroForm) result.signatures = collectSignatureFields(acroForm.get('Fields'), []);
        var perms = deref(root.get('Perms'));
        if (perms) result.docMDP = perms.get('DocMDP') !== null;
      }
    } catch (error) {
      result.signatureError = text(error && error.message ? error.message : error);
    }
    try {
      result.outline = flattenOutline(doc.loadOutline(), 1, []);
    } catch (error) {
      result.outlineError = text(error && error.message ? error.message : error);
    }
    return result;
  }

  /** 校验 write 模式的 entries（embedder 已校验过一遍，这里防御性再校验）。 */
  function validateEntries(entries, pageCount) {
    if (!entries || typeof entries.length !== 'number') fail('entries must be an array');
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry || typeof entry !== 'object') fail('entries[' + i + '] must be an object');
      var title = entry.title;
      if (typeof title !== 'string' || title.trim() === '') fail('entries[' + i + '].title must be a non-empty string');
      var page = entry.page;
      if (typeof page !== 'number' || page % 1 !== 0 || page < 1 || page > pageCount) {
        fail('entries[' + i + '].page must be an integer between 1 and ' + pageCount + ' (got ' + page + ')');
      }
      var level = entry.level === null || entry.level === undefined ? 1 : entry.level;
      if (typeof level !== 'number' || level % 1 !== 0 || level < 1) {
        fail('entries[' + i + '].level must be an integer >= 1 (got ' + level + ')');
      }
    }
  }

  /** 把迭代器游标推到当前层的末尾。 */
  function cursorToEnd(iterator) {
    var guard = 0;
    while (iterator.item() !== null) {
      if (iterator.next() !== 0) break;
      guard++;
      if (guard > MAX_ITEMS) fail('outline iteration did not terminate');
    }
  }

  /** 删光现有 outline，再按 entries 顺序重建整棵树，最后保存到 outputPath。 */
  function writeOutline(inputPath, outputPath, entriesPath) {
    var entries = JSON.parse(read(entriesPath));
    var doc = Document.openDocument(inputPath);
    var trailer = doc.getTrailer();
    var encrypted = false;
    try {
      encrypted = trailer.get('Encrypt') !== null;
    } catch (error) {
      // 见 preflight
    }
    if (encrypted) fail('refusing to write into an encrypted PDF');
    if (doc.needsPassword()) fail('refusing to write into a password-protected PDF');
    var pageCount = doc.countPages();
    validateEntries(entries, pageCount);

    var iterator = doc.outlineIterator();
    var removed = 0;
    while (iterator.item() !== null) {
      iterator.delete();
      removed++;
      if (removed > MAX_ITEMS) fail('too many existing outline items to delete');
    }

    // 当前游标所在的层级：1 = 顶层末尾（删除后游标停在顶层末尾）
    var cursorLevel = 1;
    var previousLevel = 1;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var level = entry.level === null || entry.level === undefined ? 1 : entry.level;
      if (level > cursorLevel + 1) {
        fail(
          'outline entry "' + entry.title + '" is level ' + level
            + ' but the previous entry is level ' + previousLevel
            + '; a PDF outline cannot skip levels (every level-' + (level - 1) + ' entry needs a parent)'
        );
      }
      var target = level;
      while (cursorLevel > target) {
        if (iterator.item() !== null) fail('outline cursor is not at the end of level ' + cursorLevel);
        iterator.up();
        cursorLevel--;
        cursorToEnd(iterator);
      }
      while (cursorLevel < target) {
        if (iterator.item() !== null) fail('outline cursor is not at the end of level ' + cursorLevel);
        iterator.prev();
        if (iterator.item() === null) {
          fail(
            'outline entry "' + entry.title + '" is level ' + level
              + ' but there is no level-' + cursorLevel + ' entry to nest it under'
          );
        }
        iterator.down();
        cursorLevel++;
        cursorToEnd(iterator);
      }
      iterator.insert({ title: entry.title, uri: '#page=' + entry.page, open: true });
      if (iterator.item() !== null) fail('outline insert did not leave the cursor at the end of the level');
      previousLevel = level;
    }

    doc.save(outputPath);
    return { ok: true, pageCount: pageCount, entries: entries.length, removed: removed };
  }

  var result = { ok: false, error: 'usage: mutool run pdf-outline-writer.js preflight <input.pdf> | write <input.pdf> <output.pdf> <entries.json>' };
  try {
    var mode = scriptArgs[0];
    if (mode === 'preflight') {
      result = preflight(scriptArgs[1]);
    } else if (mode === 'write') {
      result = writeOutline(scriptArgs[1], scriptArgs[2], scriptArgs[3]);
    } else {
      fail('unknown mode: ' + text(mode));
    }
  } catch (error) {
    result = { ok: false, error: text(error && error.message ? error.message : error) };
  }
  print(JSON.stringify(result));
  if (!result.ok) throw new Error(result.error);
})();
