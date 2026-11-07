// ── RECEIPT PDF WRITER ──────────────────────────────────────────────────────
// Minimal PDF 1.4 writer that wraps one or more JPEG images as full-bleed
// pages. Pure (no DOM, no globals beyond atob/btoa/TextEncoder) so it runs in
// node tests as well as the browser. Used by:
//   • finance.js  receiptImageToPDF()  — one photo/A4 canvas → 1-page PDF
//   • receipt-scanner.js                — N scanned pages   → N-page PDF
// Every receipt in Supabase Storage is a PDF, whatever the capture path.

/** A4 portrait height in PDF points. Scanned pages are scaled so their longer
 *  edge is this long, which keeps mixed receipt/invoice scans a sensible size
 *  in every viewer without changing the image's aspect ratio. */
export const PDF_PAGE_LONG_EDGE_PT = 842;

/** PDF page box (points) for an image of the given pixel size. */
export function pagePointsForImage(width, height, longEdgePt = PDF_PAGE_LONG_EDGE_PT) {
  const w = Number(width) > 0 ? Number(width) : 1;
  const h = Number(height) > 0 ? Number(height) : 1;
  const scale = longEdgePt / Math.max(w, h);
  return { w: _pt(w * scale), h: _pt(h * scale) };
}

/** Round to 2dp and drop trailing zeros — PDF reals must not use exponents. */
function _pt(n) {
  return Number(Math.round(n * 100) / 100).toString();
}

export function base64ToBytes(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  let s = '';
  const CHUNK = 0x8000; // String.fromCharCode.apply has an argument-count cap
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/**
 * Build a PDF from JPEG pages.
 * @param {Array<{base64?:string, bytes?:Uint8Array, width:number, height:number, pageWidth?:number|string, pageHeight?:number|string}>} pages
 *   width/height are the JPEG's PIXEL dimensions (required by /DCTDecode).
 *   pageWidth/pageHeight are the page box in POINTS; omitted → derived from the
 *   pixel size via pagePointsForImage().
 * @returns {Uint8Array} the PDF bytes
 */
export function buildJpegPdf(pages) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('buildJpegPdf: no pages');
  const enc = new TextEncoder();
  const parts = [];
  const offsets = []; // byte offset of "n 0 obj", indexed by object number
  let pos = 0;
  const push = (chunk) => {
    const b = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
    parts.push(b);
    pos += b.length;
  };

  // Objects: 1 = catalog, 2 = page tree, then per page i (0-based):
  //   3+3i = page, 4+3i = content stream, 5+3i = image XObject.
  const n = pages.length;
  const pageObj = (i) => 3 + 3 * i;
  const contentObj = (i) => 4 + 3 * i;
  const imageObj = (i) => 5 + 3 * i;

  push('%PDF-1.4\n');
  // Binary-comment line so transports treat the file as binary (PDF spec §7.5.2).
  push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

  offsets[1] = pos;
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offsets[2] = pos;
  const kids = pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ');
  push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);

  pages.forEach((p, i) => {
    const jpeg = p.bytes instanceof Uint8Array ? p.bytes : base64ToBytes(p.base64);
    const pxW = Math.max(1, Math.round(Number(p.width) || 1));
    const pxH = Math.max(1, Math.round(Number(p.height) || 1));
    let pw = p.pageWidth, ph = p.pageHeight;
    if (!(Number(pw) > 0 && Number(ph) > 0)) ({ w: pw, h: ph } = pagePointsForImage(pxW, pxH));
    pw = _pt(Number(pw)); ph = _pt(Number(ph));

    offsets[pageObj(i)] = pos;
    push(`${pageObj(i)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Contents ${contentObj(i)} 0 R /Resources << /XObject << /Img ${imageObj(i)} 0 R >> >> >>\nendobj\n`);

    const stream = `q ${pw} 0 0 ${ph} 0 0 cm /Img Do Q`;
    offsets[contentObj(i)] = pos;
    push(`${contentObj(i)} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);

    offsets[imageObj(i)] = pos;
    push(`${imageObj(i)} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    push(jpeg);
    push('\nendstream\nendobj\n');
  });

  const size = 3 + 3 * n; // object count including the free object 0
  const xrefPos = pos;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let k = 1; k < size; k++) xref += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
  push(xref + `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  const out = new Uint8Array(pos);
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  return out;
}
