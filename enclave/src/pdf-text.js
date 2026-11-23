// PDF -> positioned text lines, with pdf.js (no scripts, no fonts, no network: it only reads text).
//
// Why positions: a statement row is recognised by the COLUMN its pieces sit in, not by the words in
// them. A counterparty memo that wraps onto a new line stays in the memo column, so it can never
// pass for a transaction row, whatever it says.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const MAX_PDF_BYTES = 4 * 1024 * 1024;
export const MAX_PDF_PAGES = 60;
const MAX_ITEMS = 100_000;
const LINE_TOLERANCE = 2.5; // pt: items whose baselines are this close share a line

export class PdfError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PdfError';
    this.code = code; // 'password' | 'invalid' | 'too-large'
  }
}

// Returns { pages, lines } where every line is { page, y, items: [{ x, str }] } (items left to right,
// lines top to bottom, pages in order).
export async function readPdf(bytes) {
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
        row.items.push({ x, str: it.str.replace(/\s+/g, ' ').trim() });
      }
      rows.sort((a, b) => b.y - a.y); // PDF y grows upwards
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        lines.push(r);
      }
    }
    return { pages: doc.numPages, lines };
  } catch (e) {
    if (e instanceof PdfError) throw e;
    throw new PdfError('invalid', `could not read the statement PDF (${e?.message || e})`);
  } finally {
    await task.destroy().catch(() => {});
  }
}
