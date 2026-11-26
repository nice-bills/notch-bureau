// PDF -> positioned text lines, with pdf.js (no scripts, no fonts, no network: it only reads text).
//
// Why positions: a statement row is recognised by the COLUMN its pieces sit in, not by the words in
// them. A counterparty memo that wraps onto a new line stays in the memo column, so it can never
// pass for a transaction row, whatever it says.
import { getDocument, OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const MAX_PDF_BYTES = 4 * 1024 * 1024;
export const MAX_PDF_PAGES = 60;
const MAX_ITEMS = 100_000;
const MAX_OPS = 1_000_000;
const LINE_TOLERANCE = 2.5; // pt: items whose baselines are this close share a line

export class PdfError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PdfError';
    this.code = code; // 'password' | 'invalid' | 'too-large'
  }
}

// Returns { pages, lines } where every line is { page, y, items: [{ x, str }] } (items left to right,
// lines top to bottom, pages in order). Items also carry their own baseline `y` and width `w`.
// With `rules: true` it also returns rules[page - 1] = { h: [y...], v: [x...] }, the straight lines the page draws
// (table borders), in the same coordinates.
export async function readPdf(bytes, { rules = false } = {}) {
  const data = Uint8Array.from(bytes); // pdf.js takes ownership of (and detaches) what it is given
  if (data.length > MAX_PDF_BYTES) throw new PdfError('too-large', 'statement PDF is too large');
  if (!Buffer.from(data.subarray(0, 1024)).includes('%PDF-')) throw new PdfError('invalid', 'attachment is not a PDF');
  let task;
  let doc;
  try {
    task = getDocument({
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      verbosity: 0,
    });
    doc = await task.promise;
  } catch (e) {
    await task?.destroy?.().catch?.(() => {});
    if (e?.name === 'PasswordException') {
      throw new PdfError('password', 'the statement PDF is password-protected; request an unprotected statement (or remove the password) and send it again');
    }
    throw new PdfError('invalid', `could not read the statement PDF (${e?.message || e})`);
  }
  try {
    if (doc.numPages > MAX_PDF_PAGES) throw new PdfError('too-large', `statement PDF has too many pages (${doc.numPages})`);
    const lines = [];
    let items = 0;
    let ops = 0;
    const drawn = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { items: raw } = await page.getTextContent();
      items += raw.length;
      if (items > MAX_ITEMS) throw new PdfError('too-large', 'statement PDF has too much text');
      const rows = [];
      for (const it of raw) {
        if (typeof it.str !== 'string' || !it.str.trim()) continue;
        const x = it.transform[4];
        const y = it.transform[5];
        let row = rows.find((r) => Math.abs(r.y - y) <= LINE_TOLERANCE);
        if (!row) rows.push((row = { page: n, y, items: [] }));
        row.items.push({ x, y, w: it.width, str: it.str.replace(/\s+/g, ' ').trim() });
      }
      if (rules) {
        const list = await page.getOperatorList();
        ops += list.fnArray.length;
        if (ops > MAX_OPS) throw new PdfError('too-large', 'statement PDF has too much drawing');
        drawn.push(straightLines(list));
      }
      rows.sort((a, b) => b.y - a.y); // PDF y grows upwards
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        lines.push(r);
      }
    }
    return { pages: doc.numPages, lines, ...(rules ? { rules: drawn } : {}) };
  } catch (e) {
    if (e instanceof PdfError) throw e;
    throw new PdfError('invalid', `could not read the statement PDF (${e?.message || e})`);
  } finally {
    await task.destroy().catch(() => {});
  }
}

// The horizontal and vertical lines a page draws (stroked lines or hair-thin filled boxes), nearby ones merged.
function straightLines({ fnArray, argsArray }) {
  const h = [];
  const v = [];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
    else if (fn === OPS.constructPath && args[2]) {
      const [x0, y0, x1, y1] = args[2]; // the path's bounding box
      const ax = ctm[0] * x0 + ctm[2] * y0 + ctm[4];
      const ay = ctm[1] * x0 + ctm[3] * y0 + ctm[5];
      const bx = ctm[0] * x1 + ctm[2] * y1 + ctm[4];
      const by = ctm[1] * x1 + ctm[3] * y1 + ctm[5];
      if (Math.abs(by - ay) <= 1.5 && Math.abs(bx - ax) > 5) h.push((ay + by) / 2);
      else if (Math.abs(bx - ax) <= 1.5 && Math.abs(by - ay) > 5) v.push((ax + bx) / 2);
    }
  }
  const merge = (list) => list.sort((a, b) => a - b).filter((n, i) => i === 0 || n - list[i - 1] > LINE_TOLERANCE);
  return { h: merge(h), v: merge(v) };
}
