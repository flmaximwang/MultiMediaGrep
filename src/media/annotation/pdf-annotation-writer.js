/*
 * PDF annotation writer for media_annotate — beads MultiMediaGrep-9z5.38.2.
 *
 * Tool choice (the same one the bookmark outline writer settled on in 9z5.37.2,
 * reused here on purpose — `mutool run` / mupdf 1.28.0 is the only tool on this
 * machine that can write *real* PDF annotation objects):
 *
 *   - mupdf's JS API has page.createAnnotation() / page.deleteAnnotation() and
 *     annot.setContents() / setAuthor() / setRect(); doc.save() copies the page
 *     content streams byte-identically and preserves /PageLabels, /Info, the XMP
 *     /Metadata stream, /AcroForm and every page /Annots entry it did not touch.
 *   - qpdf --update-from-json cannot write annotations at all (it only knows a
 *     fixed set of keys: acroform, attachments, …), and ghostscript re-encodes
 *     every page instead of preserving the original objects.
 *   - mupdf 1.28 quirks this script works around:
 *       * page.createAnnotation(type, rect) ignores the rect argument, so the
 *         real rectangle is set afterwards with annot.setRect().
 *       * annot.setRect() / getRect() speak mupdf's *display* coordinates:
 *         top-left origin, y pointing down, relative to the crop box's
 *         top-left corner, i.e. exactly the space media_zoom's crop fractions
 *         live in. The PDF /Rect is written in user space.
 *       * a Text annotation is always a 20x20 icon anchored at the requested
 *         top-left corner, and mupdf adds a /Popup sibling for every Text
 *         annotation it creates. Popups are never imported and never belong to
 *         a sidecar entry, so the sibling is left out of the rebuilt /Annots
 *         array; its /Popup link is kept so the pair stays a valid parent/child
 *         reference instead of leaving an orphaned object behind.
 *       * a Square's rectangle grows by half the border width on every side.
 *
 * The script is ES5 only (var / function, no template literals) because it runs
 * under MuJS, mupdf's JavaScript engine; `node --check` also accepts it.
 *
 * Modes (scriptArgs[0]):
 *   preflight <pdf>                  -> {ok, encrypted, needsPassword, pageCount, signatures, docMDP}
 *   read <pdf>                       -> {ok, pageCount, annotations:[...]}
 *   write <in.pdf> <out.pdf> <plan>  -> {ok, pageCount, created, updated, kept, deleted, removedPopups}
 *
 * Exactly one JSON line is printed. Failures print {ok:false,error} and exit
 * with a non-zero status.
 */

/* global scriptArgs, read, print, Document */

(function () {
  var DEFAULT_NOTE = '(no note)';
  var DEFAULT_AUTHOR = 'unknown';

  // Note-like annotations: these are the ones media_annotate owns. Everything
  // else (Link, form Widget, Popup, FileAttachment, …) is never imported and
  // never modified.
  var NOTE_SUBTYPES = {
    Text: true,
    FreeText: true,
    Square: true,
    Circle: true,
    Line: true,
    Polygon: true,
    PolyLine: true,
    Highlight: true,
    Underline: true,
    Squiggly: true,
    StrikeOut: true,
    Stamp: true,
    Caret: true,
    Ink: true
  };

  // mupdf turns a Text annotation into a 20x20 icon.
  var TEXT_ICON_SIZE = 20;
  // Sidecar "text" entries without a rectangle are placed on the top-left
  // margin; every further one on the same page is shifted to the right so they
  // never stack on top of each other.
  var TEXT_MARGIN = 12;
  var TEXT_STEP = 26;
  /* Two annotations whose display rects differ by less than this are "the same
   * annotation": mupdf pads Square borders by 1pt per side, so the tolerance
   * has to absorb that. */
  var MATCH_TOLERANCE_POINTS = 3;

  function fail(message) {
    throw new Error(message);
  }

  function deref(object) {
    if (!object) return null;
    try {
      return object.resolve();
    } catch (error) {
      return object;
    }
  }

  function text(value) {
    if (value === null || value === undefined) return '';
    try {
      return value.asString();
    } catch (error) {
      return String(value);
    }
  }

  function number(value) {
    if (!value) return null;
    try {
      return value.asNumber();
    } catch (error) {
      return null;
    }
  }

  /* /Subtype and friends are names, not strings. */
  function nameOf(value) {
    var resolved = deref(value);
    if (!resolved) return '';
    try {
      if (resolved.isName && resolved.isName()) return resolved.asName();
    } catch (error) {
      /* fall through */
    }
    return text(resolved);
  }

  function trim(value) {
    return String(value === null || value === undefined ? '' : value).replace(/^\s+/, '').replace(/\s+$/, '');
  }

  function collapse(value) {
    return trim(value).replace(/\s+/g, ' ');
  }

  function effectiveNote(value, fallback) {
    var trimmed = trim(value);
    return trimmed === '' ? fallback : trimmed;
  }

  function effectiveAuthor(value, fallback) {
    var collapsed = collapse(value);
    return collapsed === '' ? fallback : collapsed;
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function numbersOf(array) {
    var out = [];
    if (!array || !array.isArray || !array.isArray()) return out;
    for (var i = 0; i < array.length; i++) out.push(number(deref(array.get(i))));
    return out;
  }

  function nestedNumbersOf(array) {
    var out = [];
    if (!array || !array.isArray || !array.isArray()) return out;
    for (var i = 0; i < array.length; i++) out.push(numbersOf(deref(array.get(i))));
    return out;
  }

  function hashBytes(bytes) {
    var hash = 2166136261;
    if (!bytes) return '';
    for (var i = 0; i < bytes.length; i++) {
      var code = bytes[i];
      if (typeof code !== 'number') code = bytes.charCodeAt(i) & 0xff;
      hash = (hash ^ (code & 0xff)) >>> 0;
      hash = (hash * 16777619) >>> 0;
    }
    return hash.toString(16);
  }

  function streamHash(value) {
    var resolved = deref(value);
    if (!resolved) return '';
    try {
      if (!resolved.isStream || !resolved.isStream()) return '';
      var bytes = resolved.readRawStream();
      if (!bytes) return '';
      return 'stream:' + bytes.length + ':' + hashBytes(bytes);
    } catch (error) {
      return 'stream:?';
    }
  }

  /* Canonical, object-number independent description of a PDF value. */
  function describeDeep(value, depth) {
    if (value === null || value === undefined) return '';
    if (depth > 5) return '…';
    var resolved = deref(value);
    if (!resolved) return '';
    try {
      if (resolved.isString && resolved.isString()) return '(' + resolved.asString() + ')';
      if (resolved.isName && resolved.isName()) return '/' + resolved.asName();
      if (resolved.isNumber && resolved.isNumber()) return String(resolved.asNumber());
      if (resolved.isBoolean && resolved.isBoolean()) return String(resolved.asBoolean());
      if (resolved.isNull && resolved.isNull()) return 'null';
      if (resolved.isArray && resolved.isArray()) {
        var parts = [];
        for (var i = 0; i < resolved.length; i++) parts.push(describeDeep(resolved.get(i), depth + 1));
        return '[' + parts.join(' ') + ']';
      }
      if (resolved.isDictionary && resolved.isDictionary()) {
        var keys = [];
        resolved.forEach(function (item, key) {
          keys.push(key);
        });
        keys.sort();
        var entries = [];
        for (var k = 0; k < keys.length; k++) {
          entries.push('/' + keys[k] + ' ' + describeDeep(resolved.get(keys[k]), depth + 1));
        }
        return '<<' + entries.join(' ') + '>>';
      }
    } catch (error) {
      return '?';
    }
    return String(resolved);
  }

  function pageGeometry(page) {
    var dict = page.getObject();
    var box = null;
    try {
      box = deref(dict.getInheritable('CropBox'));
    } catch (error) {
      box = null;
    }
    if (!box) box = deref(dict.get('CropBox'));
    if (!box) {
      try {
        box = deref(dict.getInheritable('MediaBox'));
      } catch (error) {
        box = null;
      }
    }
    if (!box) box = deref(dict.get('MediaBox'));
    var values = numbersOf(box);
    if (values.length < 4) values = [0, 0, 612, 792];
    var x0 = Math.min(values[0], values[2]);
    var y0 = Math.min(values[1], values[3]);
    var x1 = Math.max(values[0], values[2]);
    var y1 = Math.max(values[1], values[3]);
    var rotate = number(deref(dict.get('Rotate')));
    if (rotate === null) {
      try {
        rotate = number(deref(dict.getInheritable('Rotate')));
      } catch (error) {
        rotate = null;
      }
    }
    if (rotate === null) rotate = 0;
    rotate = ((Math.round(rotate) % 360) + 360) % 360;
    if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270) rotate = 0;
    var width = x1 - x0;
    var height = y1 - y0;
    var swapped = rotate === 90 || rotate === 270;
    return {
      x0: x0,
      y0: y0,
      x1: x1,
      y1: y1,
      rotate: rotate,
      displayWidth: swapped ? height : width,
      displayHeight: swapped ? width : height
    };
  }

  /* Display coordinates (top-left origin, y down) -> PDF user space. */
  function displayToPdf(geometry, dx, dy) {
    if (geometry.rotate === 90) return { x: geometry.x0 + dy, y: geometry.y0 + dx };
    if (geometry.rotate === 180) return { x: geometry.x1 - dx, y: geometry.y0 + dy };
    if (geometry.rotate === 270) return { x: geometry.x1 - dy, y: geometry.y1 - dx };
    return { x: geometry.x0 + dx, y: geometry.y1 - dy };
  }

  /* PDF user space -> display coordinates. */
  function pdfToDisplay(geometry, px, py) {
    if (geometry.rotate === 90) return { x: py - geometry.y0, y: px - geometry.x0 };
    if (geometry.rotate === 180) return { x: geometry.x1 - px, y: py - geometry.y0 };
    if (geometry.rotate === 270) return { x: geometry.y1 - py, y: geometry.x1 - px };
    return { x: px - geometry.x0, y: geometry.y1 - py };
  }

  function clamp(value, low, high) {
    if (value < low) return low;
    if (value > high) return high;
    return value;
  }

  /* PDF user space rectangle -> media_zoom style fractions (top-left origin). */
  function fractionRect(geometry, pdfRect) {
    if (!pdfRect || pdfRect.length < 4) return null;
    var a = pdfToDisplay(geometry, pdfRect[0], pdfRect[1]);
    var b = pdfToDisplay(geometry, pdfRect[2], pdfRect[3]);
    var left = Math.min(a.x, b.x);
    var right = Math.max(a.x, b.x);
    var top = Math.min(a.y, b.y);
    var bottom = Math.max(a.y, b.y);
    if (!(geometry.displayWidth > 0) || !(geometry.displayHeight > 0)) return null;
    var x = clamp(left / geometry.displayWidth, 0, 1);
    var y = clamp(top / geometry.displayHeight, 0, 1);
    var width = clamp((right - left) / geometry.displayWidth, 0, 1 - x);
    var height = clamp((bottom - top) / geometry.displayHeight, 0, 1 - y);
    if (!(width > 0) || !(height > 0)) return null;
    return { x: x, y: y, width: width, height: height };
  }

  /* media_zoom style fractions -> display coordinates. */
  function displayRect(geometry, rect) {
    var x = rect.x * geometry.displayWidth;
    var y = rect.y * geometry.displayHeight;
    var width = rect.width * geometry.displayWidth;
    var height = rect.height * geometry.displayHeight;
    return [x, y, x + width, y + height];
  }

  function rawRect(annot) {
    return numbersOf(deref(annot.get('Rect')));
  }

  function kindOf(subtype) {
    if (subtype === 'Link') return 'link';
    if (subtype === 'Widget') return 'widget';
    if (subtype === 'Popup') return 'popup';
    if (NOTE_SUBTYPES[subtype]) return 'markup';
    return 'other';
  }

  function readPageRecords(doc, pageIndex) {
    var page = doc.loadPage(pageIndex);
    var geometry = pageGeometry(page);
    var dict = page.getObject();
    var array = dict.get('Annots');
    var records = [];
    if (!array || !array.isArray || !array.isArray()) {
      return { page: pageIndex + 1, geometry: geometry, records: records };
    }
    for (var i = 0; i < array.length; i++) {
      var ref = array.get(i);
      var refName = String(ref);
      var annot = deref(ref);
      if (!annot) continue;
      var subtype = nameOf(annot.get('Subtype'));
      var rect = rawRect(annot);
      var popupRef = annot.get('Popup') ? String(annot.get('Popup')) : null;
      var parentRef = annot.get('Parent') ? String(annot.get('Parent')) : null;
      records.push({
        ref: refName,
        refObject: ref,
        index: i,
        page: pageIndex + 1,
        subtype: subtype,
        kind: kindOf(subtype),
        dict: annot,
        contents: text(deref(annot.get('Contents'))),
        author: text(deref(annot.get('T'))),
        subject: text(deref(annot.get('Subj'))),
        rect: rect.length === 4 ? rect : null,
        fraction: rect.length === 4 ? fractionRect(geometry, rect) : null,
        quadPoints: numbersOf(deref(annot.get('QuadPoints'))),
        inkList: nestedNumbersOf(deref(annot.get('InkList'))),
        vertices: numbersOf(deref(annot.get('Vertices'))),
        color: numbersOf(deref(annot.get('C'))),
        flags: number(deref(annot.get('F'))),
        icon: text(deref(annot.get('Name'))),
        popupRef: popupRef,
        parentRef: parentRef
      });
    }
    return { page: pageIndex + 1, geometry: geometry, records: records };
  }

  function rectKey(record) {
    if (!record.rect) return 'none';
    return record.rect.map(function (value) {
      return value === null ? '?' : value.toFixed(3);
    }).join(',');
  }

  /* A stable fingerprint of the annotations media_annotate must not touch. */
  function protectedSignature(record, parentRecord) {
    var parts = [record.kind, record.subtype, 'p' + record.page, 'rect:' + rectKey(record)];
    if (record.kind === 'link') {
      parts.push('A:' + describeDeep(record.dict.get('A'), 0));
      parts.push('Dest:' + describeDeep(record.dict.get('Dest'), 0));
    } else if (record.kind === 'widget') {
      parts.push('FT:' + describeDeep(record.dict.get('FT'), 0));
      parts.push('T:' + describeDeep(record.dict.get('T'), 0));
      parts.push('V:' + describeDeep(record.dict.get('V'), 0));
      parts.push('DA:' + describeDeep(record.dict.get('DA'), 0));
    } else if (record.kind === 'popup') {
      parts.push('parent:' + (parentRecord ? parentRecord.subtype + '@' + rectKey(parentRecord) : 'none'));
    }
    parts.push('C:' + (record.contents || ''));
    parts.push('T:' + (record.author || ''));
    parts.push('S:' + (record.subject || ''));
    parts.push('F:' + (record.flags === null ? 'null' : record.flags));
    parts.push('C1:' + (record.color || []).join(','));
    parts.push('AP:' + streamHash(deref(record.dict.get('AP')) ? deref(record.dict.get('AP')).get('N') : null));
    return parts.join('|');
  }

  function annotationRaw(record) {
    var raw = { subtype: record.subtype };
    if (record.rect) raw.rect = record.rect;
    if (record.quadPoints && record.quadPoints.length) raw.quadPoints = record.quadPoints;
    if (record.inkList && record.inkList.length) raw.inkList = record.inkList;
    if (record.vertices && record.vertices.length) raw.vertices = record.vertices;
    if (record.color && record.color.length) raw.color = record.color;
    if (record.flags !== null) raw.flags = record.flags;
    if (record.icon) raw.icon = record.icon;
    return raw;
  }

  function readAnnotations(inputPath) {
    var doc = Document.openDocument(inputPath);
    var pageCount = doc.countPages();
    var annotations = [];
    var pageBoxes = [];
    for (var i = 0; i < pageCount; i++) {
      var info = readPageRecords(doc, i);
      pageBoxes.push({
        page: info.page,
        x0: info.geometry.x0,
        y0: info.geometry.y0,
        x1: info.geometry.x1,
        y1: info.geometry.y1,
        rotate: info.geometry.rotate,
        displayWidth: info.geometry.displayWidth,
        displayHeight: info.geometry.displayHeight
      });
      for (var j = 0; j < info.records.length; j++) {
        var record = info.records[j];
        var parentRecord = null;
        if (record.parentRef) {
          for (var k = 0; k < info.records.length; k++) {
            if (info.records[k].ref === record.parentRef) parentRecord = info.records[k];
          }
        }
        annotations.push({
          page: record.page,
          index: record.index,
          kind: record.kind,
          subtype: record.subtype,
          contents: record.contents,
          author: record.author,
          subject: record.subject,
          rect: record.fraction,
          raw: annotationRaw(record),
          signature: protectedSignature(record, parentRecord)
        });
      }
    }
    return { ok: true, pageCount: pageCount, pageBoxes: pageBoxes, annotations: annotations };
  }

  function collectSignatureFields(fields, out) {
    if (!fields || !fields.isArray || !fields.isArray()) return;
    for (var i = 0; i < fields.length; i++) {
      var field = deref(fields.get(i));
      if (!field) continue;
      var kids = deref(field.get('Kids'));
      if (kids) collectSignatureFields(kids, out);
      var type = nameOf(field.get('FT'));
      if (type === 'Sig') {
        var value = field.get('V');
        out.push({ name: text(deref(field.get('T'))), signed: value !== null && value !== undefined });
      }
    }
  }

  function preflight(inputPath) {
    var doc = Document.openDocument(inputPath);
    var trailer = doc.getTrailer();
    var encrypted = trailer.get('Encrypt') !== null && trailer.get('Encrypt') !== undefined;
    var signatures = [];
    var acroForm = deref(trailer.get('Root')) ? null : null;
    var root = deref(trailer.get('Root'));
    if (root) {
      var form = deref(root.get('AcroForm'));
      if (form) collectSignatureFields(deref(form.get('Fields')), signatures);
    }
    var perms = deref(trailer.get('Perms'));
    var docMDP = perms ? perms.get('DocMDP') !== null && perms.get('DocMDP') !== undefined : false;
    return {
      ok: true,
      encrypted: encrypted,
      needsPassword: doc.needsPassword(),
      pageCount: doc.countPages(),
      signatures: signatures,
      docMDP: docMDP
    };
  }

  function subtypeForEntry(entry) {
    var type = collapse(entry && entry.type ? entry.type : '').toLowerCase();
    if (type === 'text') return 'Text';
    if (type === 'square') return 'Square';
    if (isPlainObject(entry.raw) && entry.raw.subtype) return text(entry.raw.subtype);
    if (type === '') return 'Text';
    return type.charAt(0).toUpperCase() + type.slice(1);
  }

  function isCreatable(subtype) {
    return subtype === 'Text' || subtype === 'Square';
  }

  function rectsMatch(a, b, tolerance) {
    if (!a || !b) return false;
    for (var i = 0; i < 4; i++) {
      if (a[i] === null || b[i] === null) return false;
      if (Math.abs(a[i] - b[i]) > tolerance) return false;
    }
    return true;
  }

  /*
   * Geometry comparisons happen in display POINTS, not in fractions: mupdf
   * pads a Square's /Rect by one point on every side, and a page can be a few
   * hundred points wide, so a fraction tolerance would either be far too tight
   * on a large page or far too loose on a small one.
   */
  function rectsMatchPoints(a, b, tolerance) {
    if (!a || !b) return false;
    for (var i = 0; i < 4; i++) {
      if (Math.abs(a[i] - b[i]) > tolerance) return false;
    }
    return true;
  }

  /* A Text annotation's icon is 20x20 no matter what was requested: compare corners only. */
  function cornersMatchPoints(a, b, tolerance) {
    if (!a || !b) return false;
    return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
  }

  /*
   * Which existing annotation object does a sidecar entry own?
   *
   * - An entry imported from the file carries its original geometry in `raw`;
   *   that is its identity, so an unchanged entry keeps its original object
   *   (and its appearance stream).
   * - An entry without `raw` was added through media_annotate. It still has to
   *   be matched on the next write, otherwise every write would delete and
   *   recreate it: a text or square annotation placed by us sits exactly at the
   *   requested spot, so the position is the identity here.
   *   A Text annotation has a forced 20x20 icon, so only its top-left corner is
   *   comparable; everything else is compared as a whole rect.
   */
  function findMatch(entry, subtype, records, claimed, targetDisplay, geometry) {
    var raw = isPlainObject(entry.raw) ? entry.raw : null;
    var i;
    var record;
    // 1) Identity recorded at import time: the absolute /Rect is exact, so an
    //    unchanged imported annotation is found again without touching it.
    if (raw) {
      for (i = 0; i < records.length; i++) {
        record = records[i];
        if (claimed[record.ref]) continue;
        if (record.kind !== 'markup') continue;
        if (record.subtype !== subtype) continue;
        if (raw.rect) {
          if (record.rect && rectsMatch(raw.rect, record.rect, 0.05)) return record;
          continue;
        }
        if (raw.contents !== undefined) {
          if (text(raw.contents) === record.contents && text(raw.author) === record.author) return record;
        }
      }
    }
    // 2) Position: where media_annotate placed this entry last time. Without
    //    this an unchanged entry would be deleted and recreated on every write.
    if (!targetDisplay) return null;
    for (i = 0; i < records.length; i++) {
      record = records[i];
      if (claimed[record.ref]) continue;
      if (record.kind !== 'markup') continue;
      if (record.subtype !== subtype) continue;
      if (!record.fraction) continue;
      if (cornersMatchPoints(displayRect(geometry, record.fraction), targetDisplay, MATCH_TOLERANCE_POINTS)) {
        return record;
      }
    }
    return null;
  }

  function planDefaults(plan) {
    var defaults = { note: DEFAULT_NOTE, author: DEFAULT_AUTHOR };
    if (isPlainObject(plan) && isPlainObject(plan.defaults)) {
      if (typeof plan.defaults.note === 'string') defaults.note = plan.defaults.note;
      if (typeof plan.defaults.author === 'string') defaults.author = plan.defaults.author;
    }
    return defaults;
  }

  function writeAnnotations(inputPath, outputPath, plan) {
    var defaults = planDefaults(plan);
    var entries = isPlainObject(plan) && Array.isArray(plan.entries) ? plan.entries : [];
    var doc = Document.openDocument(inputPath);
    var pageCount = doc.countPages();

    var pages = [];
    for (var i = 0; i < pageCount; i++) pages.push(readPageRecords(doc, i));

    var claimed = {};
    var kept = [];
    var updated = [];
    var created = [];
    var deleted = [];
    var removedPopups = [];
    var placements = [];
    var textSlots = {};

    for (var e = 0; e < entries.length; e++) {
      var entry = entries[e];
      var pageNumber = entry && typeof entry.page === 'number' ? Math.round(entry.page) : 0;
      if (pageNumber < 1 || pageNumber > pageCount) {
        fail('entry ' + (entry && entry.id ? entry.id : e + 1) + ' points at page ' + pageNumber + ', but the PDF has ' + pageCount + ' pages');
      }
      var pageInfo = pages[pageNumber - 1];
      var subtype = subtypeForEntry(entry);
      var note = effectiveNote(entry.note, defaults.note);
      var author = effectiveAuthor(entry.author, defaults.author);
      var rect = isPlainObject(entry.rect) ? entry.rect : null;
      var display = null;
      if (rect) {
        display = displayRect(pageInfo.geometry, rect);
      } else {
        var slot = textSlots[pageNumber] || 0;
        textSlots[pageNumber] = slot + 1;
        display = [
          TEXT_MARGIN + slot * TEXT_STEP,
          TEXT_MARGIN,
          TEXT_MARGIN + slot * TEXT_STEP + TEXT_ICON_SIZE,
          TEXT_MARGIN + TEXT_ICON_SIZE
        ];
      }
      var match = findMatch(entry, subtype, pageInfo.records, claimed, display, pageInfo.geometry);

      if (match) {
        claimed[match.ref] = true;
        var unchangedNote = effectiveNote(match.contents, defaults.note) === note;
        var unchangedAuthor = effectiveAuthor(match.author, defaults.author) === author;
        var moved = false;
        if (isPlainObject(entry.rect) && match.fraction) {
          var matchDisplay = displayRect(pageInfo.geometry, match.fraction);
          moved = subtype === 'Text'
            ? !cornersMatchPoints(matchDisplay, display, MATCH_TOLERANCE_POINTS)
            : !rectsMatchPoints(matchDisplay, display, MATCH_TOLERANCE_POINTS);
        }
        if (unchangedNote && unchangedAuthor && !moved) {
          kept.push({ id: entry.id, page: pageNumber, subtype: subtype });
          placements.push({
            id: entry.id,
            page: pageNumber,
            subtype: subtype,
            contents: match.contents,
            author: match.author,
            rect: match.fraction
          });
          continue;
        }
        if (moved && !isCreatable(subtype)) {
          fail(
            'cannot move the ' + subtype + ' annotation ' + (entry.id || '') + ': media_annotate can only place text and square annotations. Delete it and add a square instead.'
          );
        }
        if (moved) {
          // Rebuild: the old object goes away, a fresh one takes its place.
          // The old record stays unclaimed, so the /Annots rebuild below drops
          // it together with its popup.
          match = null;
        } else {
          match.dict.put('Contents', doc.newString(note));
          match.dict.put('T', doc.newString(author));
          match.dict.put('M', doc.newString(pdfDate(new Date())));
          updated.push({ id: entry.id, page: pageNumber, subtype: subtype });
          placements.push({
            id: entry.id,
            page: pageNumber,
            subtype: subtype,
            contents: note,
            author: author,
            rect: match.fraction
          });
          continue;
        }
      }

      if (!isCreatable(subtype)) {
        fail(
          'cannot recreate the ' + subtype + ' annotation ' + (entry.id || '') + ': media_annotate can only create text and square annotations'
        );
      }

      var page = doc.loadPage(pageNumber - 1);
      var annot = page.createAnnotation(subtype, [0, 0, 0, 0]);
      annot.setRect(display);
      annot.setContents(note);
      annot.setAuthor(author);
      var newRef = String(annot.getObject());
      // mupdf adds a /Popup sibling for every Text annotation it creates and
      // appends it to the page /Annots array. The sibling is NOT copied into
      // the rebuilt /Annots array below (popups are never imported and never
      // part of a sidecar entry), but the /Popup link is kept so the pair stays
      // a valid parent/child reference instead of leaving an orphaned object
      // behind (mupdf writes every object it allocated, referenced or not).
      // Pre-existing popups are never touched: they stay in /Annots with their
      // original /Rect and /Parent, and the `other-annotations` check compares
      // them byte for byte.
      created.push({
        id: entry.id,
        page: pageNumber,
        subtype: subtype,
        ref: newRef,
        refObject: annot.getObject()
      });
      placements.push({
        id: entry.id,
        page: pageNumber,
        subtype: subtype,
        contents: note,
        author: author,
        rect: fractionRect(pageInfo.geometry, displayToPdfRect(pageInfo.geometry, display))
      });
    }

    // Rebuild the /Annots arrays: every markup annotation that was not claimed
    // by a sidecar entry is dropped, the protected annotations (Link, form
    // Widget, Popup) stay exactly where they are.
    for (var p = 0; p < pages.length; p++) {
      var info2 = pages[p];
      var pageDict = doc.loadPage(p).getObject();
      var array = pageDict.get('Annots');
      var hasArray = !!array && !!array.isArray && array.isArray();
      var createdHere = [];
      for (var c = 0; c < created.length; c++) {
        if (created[c].page === info2.page) createdHere.push(created[c].refObject);
      }
      if (!hasArray && createdHere.length === 0) continue;

      var droppedMarkup = [];
      var droppedMarkupRefs = {};
      for (var r = 0; r < info2.records.length; r++) {
        var record = info2.records[r];
        if (record.kind === 'markup' && !claimed[record.ref]) {
          droppedMarkup.push(record);
          droppedMarkupRefs[record.ref] = true;
        }
      }
      for (var d = 0; d < droppedMarkup.length; d++) {
        deleted.push({ page: droppedMarkup[d].page, subtype: droppedMarkup[d].subtype, reason: 'replaced' });
      }
      var survivors = [];
      for (var s = 0; s < info2.records.length; s++) {
        var keep = info2.records[s];
        if (keep.kind === 'markup' && !claimed[keep.ref]) continue;
        if (keep.kind === 'popup' && keep.parentRef && droppedMarkupRefs[keep.parentRef]) {
          // The popup of a replaced annotation goes away with its parent —
          // otherwise /Parent would dangle and the PDF would be broken.
          var popupParent = null;
          for (var q = 0; q < info2.records.length; q++) {
            if (info2.records[q].ref === keep.parentRef) popupParent = info2.records[q];
          }
          removedPopups.push({ page: keep.page, signature: protectedSignature(keep, popupParent) });
          continue;
        }
        survivors.push(keep.refObject);
      }
      for (var n = 0; n < createdHere.length; n++) survivors.push(createdHere[n]);
      var newArray = doc.newArray();
      for (var t = 0; t < survivors.length; t++) newArray.push(survivors[t]);
      pageDict.put('Annots', newArray);
    }

    doc.save(outputPath);

    return {
      ok: true,
      pageCount: pageCount,
      created: created,
      updated: updated,
      kept: kept,
      deleted: deleted,
      removedPopups: removedPopups,
      placements: placements
    };
  }

  function displayToPdfRect(geometry, display) {
    var a = displayToPdf(geometry, display[0], display[1]);
    var b = displayToPdf(geometry, display[2], display[3]);
    return [
      Math.min(a.x, b.x),
      Math.min(a.y, b.y),
      Math.max(a.x, b.x),
      Math.max(a.y, b.y)
    ];
  }

  function pdfDate(date) {
    function pad(value) {
      return value < 10 ? '0' + value : String(value);
    }
    return (
      'D:' +
      date.getUTCFullYear() +
      pad(date.getUTCMonth() + 1) +
      pad(date.getUTCDate()) +
      pad(date.getUTCHours()) +
      pad(date.getUTCMinutes()) +
      pad(date.getUTCSeconds())
    );
  }

  var result = { ok: false, error: 'usage: pdf-annotation-writer.js preflight|read|write …' };
  try {
    var mode = scriptArgs[0];
    if (mode === 'preflight') {
      result = preflight(scriptArgs[1]);
    } else if (mode === 'read') {
      result = readAnnotations(scriptArgs[1]);
    } else if (mode === 'write') {
      var planText = read(scriptArgs[3]);
      result = writeAnnotations(scriptArgs[1], scriptArgs[2], JSON.parse(planText));
    } else {
      result = { ok: false, error: 'unknown mode: ' + mode };
    }
  } catch (error) {
    result = { ok: false, error: text(error && error.message ? error.message : error) };
  }
  print(JSON.stringify(result));
  if (!result.ok) throw new Error(result.error);
})();
