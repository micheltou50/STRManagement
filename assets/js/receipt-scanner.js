// ── NATIVE RECEIPT SCANNER (Capacitor iOS) ───────────────────────────────────
// "Scan it like the Notes app": inside the native iOS build the
// @capgo/capacitor-document-scanner plugin opens Apple's VisionKit document
// camera (live edge detection, auto-capture, perspective correction, filters,
// multi-page). Every page it returns is downscaled here and packed into ONE
// multi-page PDF, which then flows through the existing receipt pipeline
// unchanged (staged as media type application/pdf → uploaded to Supabase
// Storage → read by Claude as a document).
//
// The web/PWA build has no VisionKit, so hasNativeDocumentScanner() is false
// there and every entry point falls back to the plain <input type="file">.
// Capacitor exposes natively-registered plugins on Capacitor.Plugins.<jsName>
// without a JS import (see JSExport.swift), which is how App/Filesystem/
// PushNotifications are already used in this codebase.
import { buildJpegPdf, bytesToBase64 } from './receipt-pdf.js';

/** Longest edge, in px, each scanned page is downscaled to before PDF packing.
 *  Receipts are text: 1600px stays crisp while keeping a 10-page scan well
 *  under the AI proxy's request-size limit. */
const PAGE_LONG_EDGE_PX = 1600;
const PAGE_JPEG_QUALITY = 0.85;
/** Fallback encode when a long scan would still be too big for one request. */
const SMALL_LONG_EDGE_PX = 1200;
const SMALL_JPEG_QUALITY = 0.75;
/** Netlify Functions reject bodies over 6 MB; base64 adds a third, so cap the
 *  raw JPEG total well below that. */
const MAX_TOTAL_JPEG_BYTES = 4.2 * 1024 * 1024;
const THUMB_LONG_EDGE_PX = 480;

export function hasNativeDocumentScanner() {
  try {
    const cap = globalThis.Capacitor;
    if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return false;
    const DS = cap.Plugins && cap.Plugins.DocumentScanner;
    return !!(DS && typeof DS.scanDocument === 'function');
  } catch (_e) {
    return false;
  }
}

/** Mark the document so CSS/markup can swap "Snap a receipt" affordances for
 *  scanner ones. Idempotent; safe to call before login. */
export function initReceiptScannerUI() {
  if (typeof document === 'undefined' || !document.body) return;
  if (!hasNativeDocumentScanner()) return;
  document.body.classList.add('doc-scanner');
  document.querySelectorAll('[data-scan-title]').forEach(el => { el.textContent = 'Scan a receipt'; });
  document.querySelectorAll('[data-scan-subtitle]').forEach(el => {
    el.textContent = 'Edges are detected and straightened, then we auto-fill amount, vendor and category.';
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode a scanned page'));
    img.src = src;
  });
}

/** Draw an image onto a canvas whose longer edge is `longEdge` px (never
 *  upscaled) and return its JPEG. */
function drawScaled(img, longEdge, quality) {
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const scale = Math.min(1, longEdge / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  // Release the backing store promptly — iOS WKWebView canvas memory is tight.
  canvas.width = 0; canvas.height = 0;
  return { dataUrl, base64: dataUrl.split(',')[1], width: w, height: h };
}

function toDataUrl(raw) {
  return /^data:/i.test(raw) ? raw : 'data:image/jpeg;base64,' + raw;
}

/** Decode each scanned page in turn (never all at once — a 24-page scan of
 *  12 MP frames would exhaust the webview) and re-encode at the given size. */
async function renderPages(rawPages, longEdge, quality) {
  const pages = [];
  let totalBytes = 0;
  let thumbDataUrl = null;
  for (let i = 0; i < rawPages.length; i++) {
    const img = await loadImage(toDataUrl(rawPages[i]));
    const page = drawScaled(img, longEdge, quality);
    if (i === 0) thumbDataUrl = drawScaled(img, THUMB_LONG_EDGE_PX, 0.8).dataUrl;
    pages.push({ base64: page.base64, width: page.width, height: page.height });
    totalBytes += Math.floor(page.base64.length * 0.75);
  }
  return { pages, totalBytes, thumbDataUrl };
}

let _scanInFlight = false;

/**
 * Open the native document scanner (VisionKit) and return the raw pages.
 * @returns {Promise<string[]|null>} base64 JPEG per page; null when the user
 *   cancelled or captured nothing. Throws when the plugin is unavailable or
 *   fails, so callers can fall back to the file picker.
 */
export async function scanReceiptPages() {
  if (!hasNativeDocumentScanner()) throw new Error('Document scanner is not available on this device');
  if (_scanInFlight) return null; // VisionKit is modal; a second call would be rejected anyway
  _scanInFlight = true;
  try {
    const DS = globalThis.Capacitor.Plugins.DocumentScanner;
    const res = await DS.scanDocument({ responseType: 'base64', croppedImageQuality: 92 });
    if (!res || res.status === 'cancel') return null;
    const raw = Array.isArray(res.scannedImages) ? res.scannedImages.filter(s => typeof s === 'string' && s.length) : [];
    return raw.length ? raw : null;
  } finally {
    _scanInFlight = false;
  }
}

/**
 * Downscale the scanned pages and pack them into ONE multi-page PDF.
 * @param {string[]} rawPages base64 JPEGs from scanReceiptPages()
 * @returns {Promise<{pdfBase64:string, mediaType:'application/pdf', pageCount:number, thumbDataUrl:string}>}
 */
export async function packScannedPages(rawPages) {
  const raw = Array.isArray(rawPages) ? rawPages.filter(Boolean) : [];
  if (!raw.length) throw new Error('No scanned pages to pack');
  let rendered = await renderPages(raw, PAGE_LONG_EDGE_PX, PAGE_JPEG_QUALITY);
  if (rendered.totalBytes > MAX_TOTAL_JPEG_BYTES) rendered = await renderPages(raw, SMALL_LONG_EDGE_PX, SMALL_JPEG_QUALITY);
  const pdfBytes = buildJpegPdf(rendered.pages);
  return {
    pdfBase64: bytesToBase64(pdfBytes),
    mediaType: 'application/pdf',
    pageCount: rendered.pages.length,
    thumbDataUrl: rendered.thumbDataUrl,
  };
}

/** Convenience: scan, then pack. null when cancelled. */
export async function scanReceiptToPdf() {
  const raw = await scanReceiptPages();
  return raw ? packScannedPages(raw) : null;
}

/** Label shown next to a staged scan, e.g. "📄 Scanned receipt · 3 pages". */
export function scanSummaryLabel(pageCount) {
  const n = Number(pageCount) || 1;
  return `📄 Scanned receipt · ${n} page${n === 1 ? '' : 's'}`;
}
