'use strict';
// Tripwire for the shared receipt PDF writer (assets/js/receipt-pdf.js). Every
// receipt that reaches Supabase Storage goes through it — one A4 page from the
// photo path, N pages from the native document scanner — so a broken xref here
// means every viewer shows "file may be missing". Frontend modules are ESM, so
// we dynamic-import from this CJS test like frontend-pure.test.js does.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = pathToFileURL(path.join(__dirname, '..', 'assets', 'js', 'receipt-pdf.js')).href;
const importMod = () => import(modUrl);

// A real 2×3 px white JPEG (Pillow, quality 50) so the fixture is a decodable image.
const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD0CiiigD//2Q==';

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

/** Parse the xref table + trailer and check every offset lands on "n 0 obj". */
function checkXref(bytes) {
  const text = latin1(bytes);
  const sx = text.lastIndexOf('startxref\n');
  assert.ok(sx > 0, 'startxref present');
  const xrefPos = Number(text.slice(sx + 'startxref\n'.length).split('\n')[0]);
  assert.strictEqual(text.slice(xrefPos, xrefPos + 5), 'xref\n', 'startxref points at the xref table');
  const m = /^xref\n0 (\d+)\n/.exec(text.slice(xrefPos));
  assert.ok(m, 'xref header');
  const size = Number(m[1]);
  const rows = text.slice(xrefPos + m[0].length).split('\n').slice(0, size);
  assert.strictEqual(rows[0], '0000000000 65535 f ');
  for (let n = 1; n < size; n++) {
    const row = rows[n];
    assert.match(row, /^\d{10} 00000 n $/, `xref row ${n} is 20 bytes`);
    const off = Number(row.slice(0, 10));
    assert.strictEqual(text.slice(off, off + `${n} 0 obj`.length), `${n} 0 obj`, `object ${n} offset`);
  }
  assert.match(text.slice(xrefPos), new RegExp(`trailer\\n<< /Size ${size} /Root 1 0 R >>`));
  assert.ok(text.endsWith('%%EOF\n'));
  return { size, text };
}

test('buildJpegPdf() writes one page with an explicit A4-canvas page box (photo path)', async () => {
  const { buildJpegPdf } = await importMod();
  const bytes = buildJpegPdf([{ base64: TINY_JPEG_B64, width: 794, height: 1123, pageWidth: 794, pageHeight: 1123 }]);
  assert.ok(bytes instanceof Uint8Array);
  const { size, text } = checkXref(bytes);
  assert.strictEqual(size, 6); // 0 + catalog, pages, page, content, image
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.match(text, /\/Type \/Pages \/Kids \[3 0 R\] \/Count 1/);
  assert.match(text, /\/MediaBox \[0 0 794 1123\]/);
  assert.match(text, /\/Width 794 \/Height 1123 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode/);
  // The JPEG bytes are embedded verbatim with the right /Length.
  const jpeg = Buffer.from(TINY_JPEG_B64, 'base64');
  assert.match(text, new RegExp(`/Length ${jpeg.length} >>\\nstream\\n`));
  assert.ok(Buffer.from(bytes).includes(jpeg), 'JPEG embedded byte-for-byte');
});

test('buildJpegPdf() packs several scanned pages into one PDF, each page sized to its own scan', async () => {
  const { buildJpegPdf, pagePointsForImage } = await importMod();
  const pages = [
    { base64: TINY_JPEG_B64, width: 1200, height: 1600 }, // portrait receipt
    { base64: TINY_JPEG_B64, width: 1600, height: 1131 }, // landscape invoice
    { base64: TINY_JPEG_B64, width: 600, height: 1600 },  // long till receipt
  ];
  const bytes = buildJpegPdf(pages);
  const { size, text } = checkXref(bytes);
  assert.strictEqual(size, 3 + 3 * pages.length);
  assert.match(text, /\/Kids \[3 0 R 6 0 R 9 0 R\] \/Count 3/);
  for (const p of pages) {
    const { w, h } = pagePointsForImage(p.width, p.height);
    assert.strictEqual(Math.max(Number(w), Number(h)), 842, 'long edge is A4 height');
    assert.ok(text.includes(`/MediaBox [0 0 ${w} ${h}]`), `page box ${w}x${h}`);
    assert.ok(text.includes(`q ${w} 0 0 ${h} 0 0 cm /Img Do Q`), 'image drawn full-bleed');
    assert.ok(text.includes(`/Width ${p.width} /Height ${p.height}`), 'pixel size kept for DCTDecode');
  }
  // Every page object points at its own content + image objects.
  assert.match(text, /3 0 obj\n<< \/Type \/Page \/Parent 2 0 R [^\n]*\/Contents 4 0 R \/Resources << \/XObject << \/Img 5 0 R >> >> >>/);
  assert.match(text, /9 0 obj\n<< \/Type \/Page \/Parent 2 0 R [^\n]*\/Contents 10 0 R \/Resources << \/XObject << \/Img 11 0 R >> >> >>/);
});

test('buildJpegPdf() rejects an empty page list', async () => {
  const { buildJpegPdf } = await importMod();
  assert.throws(() => buildJpegPdf([]), /no pages/);
  assert.throws(() => buildJpegPdf(null), /no pages/);
});

test('pagePointsForImage() keeps aspect ratio and never emits exponent notation', async () => {
  const { pagePointsForImage } = await importMod();
  assert.deepStrictEqual(pagePointsForImage(1000, 2000), { w: '421', h: '842' });
  assert.deepStrictEqual(pagePointsForImage(3000, 1000), { w: '842', h: '280.67' });
  const tiny = pagePointsForImage(1, 100000);
  assert.doesNotMatch(tiny.w, /e/i);
  assert.ok(Number(tiny.w) > 0);
  // Garbage dimensions fall back to a square page rather than NaN.
  assert.deepStrictEqual(pagePointsForImage(0, undefined), { w: '842', h: '842' });
});

test('bytesToBase64() round-trips large buffers past the fromCharCode argument cap', async () => {
  const { bytesToBase64, base64ToBytes } = await importMod();
  const big = new Uint8Array(200000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
  const back = base64ToBytes(bytesToBase64(big));
  assert.strictEqual(back.length, big.length);
  assert.ok(Buffer.from(back).equals(Buffer.from(big)));
});
