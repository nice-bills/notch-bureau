import { simpleParser } from 'mailparser';

const MAX_PDFS = 3;

// PDF attachments of a DKIM-verified message. The caller has already checked the DKIM body hash,
// which covers every byte after the headers (all MIME parts, base64 attachments included) and
// refuses l= signatures, so what comes out of here is exactly what the provider's server signed.
export async function pdfAttachments(eml) {
  const parsed = await simpleParser(eml, { skipHtmlToText: true, skipImageLinks: true, skipTextToHtml: true });
  const pdfs = (parsed.attachments || []).filter((a) => {
    const type = String(a.contentType || '').toLowerCase();
    const name = String(a.filename || '').toLowerCase();
    return type === 'application/pdf' || name.endsWith('.pdf');
  });
  if (pdfs.length > MAX_PDFS) throw new Error(`email carries ${pdfs.length} PDF attachments (max ${MAX_PDFS})`);
  return pdfs.map((a) => ({ filename: a.filename || 'statement.pdf', content: a.content }));
}
