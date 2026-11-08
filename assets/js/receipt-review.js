// ── IN-APP DOCUMENT SCANNER: CANVAS + CORNER-ADJUST REVIEW ──────────────────
// scanImageFileWithReview(file) is the photo counterpart of the native
// VisionKit flow: decode the picked/taken photo, find the receipt's corners
// (receipt-image-scan.js), let the host drag them on a full-screen review,
// then straighten + enhance and hand back a 1-page PDF in exactly the shape
// attachScannedReceipt() expects. Used for every image that arrives through a
// receipt <input type=file> — the Add form's two slots and the Edit modal —
// on iOS and web alike. PDFs never come here.
import {
  rgbaToGray, detectDocumentQuad, fullImageQuad, warpPerspective, outputSizeForQuad, enhanceDocument,
} from './receipt-image-scan.js';
import { buildJpegPdf, bytesToBase64 } from './receipt-pdf.js';

/** Working copy the warp samples from (never upscaled). */
const WORK_LONG_EDGE_PX = 2000;
/** Corner detection runs on a small copy — plenty for edges, cheap on phones. */
const DETECT_LONG_EDGE_PX = 480;
/** Matches the VisionKit path so both kinds of scan land the same size. */
const OUT_LONG_EDGE_PX = 1600;
const OUT_JPEG_QUALITY = 0.85;
const THUMB_LONG_EDGE_PX = 480;

export function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      // Some WKWebView builds balk at blob: URLs for camera captures — retry via data URL.
      const fr = new FileReader();
      fr.onload = () => {
        const im2 = new Image();
        im2.onload = () => resolve(im2);
        im2.onerror = () => reject(new Error('Could not decode the photo'));
        im2.src = fr.result;
      };
      fr.onerror = () => reject(new Error('Could not read the photo'));
      fr.readAsDataURL(file);
    };
    img.src = url;
  });
}

function drawToCanvas(img, longEdge) {
  const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
  const s = Math.min(1, longEdge / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * s));
  canvas.height = Math.max(1, Math.round(sh * s));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function release(canvas) { canvas.width = 0; canvas.height = 0; }

/**
 * @param {File} file an image file from a receipt <input type=file>
 * @param {{onRetake?: () => void}} [opts] onRetake runs synchronously inside the
 *   Retake tap (so a file input can be re-opened within the user gesture).
 * @returns {Promise<null | {pdfBase64:string, mediaType:'application/pdf', pageCount:1, thumbDataUrl:string, autoDetected:boolean}>}
 *   null when the host cancelled or chose Retake.
 */
export async function scanImageFileWithReview(file, opts = {}) {
  const img = await loadImageFromFile(file);
  const work = drawToCanvas(img, WORK_LONG_EDGE_PX);
  const det = drawToCanvas(img, DETECT_LONG_EDGE_PX);
  const dd = det.getContext('2d').getImageData(0, 0, det.width, det.height);
  const found = detectDocumentQuad(rgbaToGray(dd.data, det.width, det.height), det.width, det.height);
  const scale = work.width / det.width;
  release(det);
  const quad = found ? found.map(([x, y]) => [x * scale, y * scale]) : fullImageQuad(work.width, work.height);

  const review = await openCornerReview({ canvas: work, quad, autoDetected: !!found, onRetake: opts.onRetake });
  if (review.action !== 'use') { release(work); return null; }

  const src = work.getContext('2d').getImageData(0, 0, work.width, work.height);
  const { w, h } = outputSizeForQuad(review.quad, OUT_LONG_EDGE_PX);
  const warped = warpPerspective({ data: src.data, width: work.width, height: work.height }, review.quad, w, h);
  release(work);
  enhanceDocument(warped);

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  out.getContext('2d').putImageData(new ImageData(warped.data, w, h), 0, 0);
  const base64 = out.toDataURL('image/jpeg', OUT_JPEG_QUALITY).split(',')[1];
  const ts = Math.min(1, THUMB_LONG_EDGE_PX / Math.max(w, h));
  const thumb = document.createElement('canvas');
  thumb.width = Math.max(1, Math.round(w * ts)); thumb.height = Math.max(1, Math.round(h * ts));
  thumb.getContext('2d').drawImage(out, 0, 0, thumb.width, thumb.height);
  const thumbDataUrl = thumb.toDataURL('image/jpeg', 0.8);
  release(out); release(thumb);

  const pdf = buildJpegPdf([{ base64, width: w, height: h }]);
  return { pdfBase64: bytesToBase64(pdf), mediaType: 'application/pdf', pageCount: 1, thumbDataUrl, autoDetected: !!found };
}

// ── Corner-adjust review (full-screen) ──────────────────────────────────────
const STYLE_ID = 'scan-review-style';
const CSS = `
#scan-review{position:fixed;inset:0;z-index:10003;background:#0f1713;color:#fff;display:flex;flex-direction:column;font-family:'Plus Jakarta Sans',system-ui,sans-serif;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
#scan-review .sr-top{display:flex;align-items:center;justify-content:space-between;padding:12px 14px 6px}
#scan-review .sr-title{font-size:16px;font-weight:700}
#scan-review .sr-hint{font-size:12px;color:#b9c7bf;padding:0 14px 8px;min-height:16px}
#scan-review .sr-x{background:rgba(255,255,255,.12);border:none;color:#fff;width:34px;height:34px;border-radius:50%;font-size:17px;cursor:pointer;line-height:1}
#scan-review .sr-stage{flex:1;position:relative;overflow:hidden;touch-action:none;margin:0 10px}
#scan-review .sr-stage canvas{position:absolute;border-radius:6px}
#scan-review .sr-stage svg{position:absolute;overflow:visible}
#scan-review .sr-poly{fill:rgba(143,175,133,.18);stroke:#8FAF85;stroke-width:3;vector-effect:non-scaling-stroke}
#scan-review .sr-hit{fill:transparent;cursor:grab}
#scan-review .sr-dot{fill:#2C4A3E;stroke:#fff;stroke-width:3;vector-effect:non-scaling-stroke;pointer-events:none}
#scan-review .sr-actions{display:flex;gap:10px;padding:12px 14px 14px}
#scan-review .sr-btn{flex:1;border:none;border-radius:12px;padding:13px 10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}
#scan-review .sr-btn.secondary{background:rgba(255,255,255,.12);color:#fff}
#scan-review .sr-btn.primary{background:var(--primary,#2C4A3E);color:#fff;flex:1.6}
#scan-review .sr-reset{background:none;border:none;color:#b9c7bf;font-size:12px;text-decoration:underline;cursor:pointer;font-family:inherit;padding:0}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID; st.textContent = CSS;
  document.head.appendChild(st);
}

/**
 * Show the photo with a draggable quad. Resolves {action:'use', quad} with the
 * quad in the canvas's pixel coordinates, {action:'cancel'} or {action:'retake'}.
 */
export function openCornerReview({ canvas, quad, autoDetected, onRetake }) {
  return new Promise((resolve) => {
    ensureStyle();
    const existing = document.getElementById('scan-review');
    if (existing) existing.remove();
    const iw = canvas.width, ih = canvas.height;
    const pts = quad.map(([x, y]) => [x, y]);
    const root = document.createElement('div');
    root.id = 'scan-review';
    root.innerHTML = `
      <div class="sr-top"><div class="sr-title">Adjust the corners</div><button type="button" class="sr-x" aria-label="Cancel">✕</button></div>
      <div class="sr-hint">${autoDetected ? 'Drag the circles if the outline missed an edge.' : 'Could not find the edges automatically — drag the circles onto the receipt’s corners.'}</div>
      <div class="sr-stage"></div>
      <div style="text-align:center;padding:4px 0 2px"><button type="button" class="sr-reset">Reset corners</button></div>
      <div class="sr-actions">
        <button type="button" class="sr-btn secondary sr-retake">Retake</button>
        <button type="button" class="sr-btn primary sr-use">Use scan</button>
      </div>`;
    const stage = root.querySelector('.sr-stage');
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${iw} ${ih}`);
    const poly = document.createElementNS(svgNS, 'polygon');
    poly.setAttribute('class', 'sr-poly');
    svg.appendChild(poly);
    const handles = pts.map((_, i) => {
      const g = document.createElementNS(svgNS, 'g');
      const hit = document.createElementNS(svgNS, 'circle'); hit.setAttribute('class', 'sr-hit');
      const dot = document.createElementNS(svgNS, 'circle'); dot.setAttribute('class', 'sr-dot');
      g.appendChild(hit); g.appendChild(dot); g.dataset.idx = String(i);
      svg.appendChild(g);
      return { g, hit, dot };
    });
    stage.appendChild(canvas);
    stage.appendChild(svg);
    document.body.appendChild(root);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    let box = { left: 0, top: 0, width: 1, height: 1 };
    const unit = () => iw / box.width; // image px per CSS px
    function layout() {
      const r = stage.getBoundingClientRect();
      const pad = 8;
      const s = Math.min((r.width - pad * 2) / iw, (r.height - pad * 2) / ih);
      const dw = Math.max(1, iw * s), dh = Math.max(1, ih * s);
      box = { left: (r.width - dw) / 2, top: (r.height - dh) / 2, width: dw, height: dh };
      for (const el of [canvas, svg]) {
        el.style.left = box.left + 'px'; el.style.top = box.top + 'px';
        el.style.width = box.width + 'px'; el.style.height = box.height + 'px';
      }
      svg.setAttribute('width', box.width); svg.setAttribute('height', box.height);
      draw();
    }
    function draw() {
      poly.setAttribute('points', pts.map(p => p.join(',')).join(' '));
      const u = unit();
      handles.forEach((hd, i) => {
        hd.hit.setAttribute('cx', pts[i][0]); hd.hit.setAttribute('cy', pts[i][1]); hd.hit.setAttribute('r', 28 * u);
        hd.dot.setAttribute('cx', pts[i][0]); hd.dot.setAttribute('cy', pts[i][1]); hd.dot.setAttribute('r', 11 * u);
      });
    }
    function toImage(ev) {
      const r = svg.getBoundingClientRect();
      const x = (ev.clientX - r.left) * (iw / r.width);
      const y = (ev.clientY - r.top) * (ih / r.height);
      return [Math.min(iw, Math.max(0, x)), Math.min(ih, Math.max(0, y))];
    }
    let drag = null; // { idx, pointerId }
    handles.forEach((hd, i) => {
      hd.g.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        drag = { idx: i, pointerId: ev.pointerId };
        try { hd.g.setPointerCapture(ev.pointerId); } catch (_e) { /* older WebKit */ }
      });
      const move = (ev) => {
        if (!drag || drag.idx !== i || ev.pointerId !== drag.pointerId) return;
        ev.preventDefault();
        pts[i] = toImage(ev);
        draw();
      };
      const end = (ev) => { if (drag && drag.idx === i && ev.pointerId === drag.pointerId) drag = null; };
      hd.g.addEventListener('pointermove', move);
      hd.g.addEventListener('pointerup', end);
      hd.g.addEventListener('pointercancel', end);
    });
    // Tap anywhere on the stage: move the nearest corner there (big-finger fallback).
    stage.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest && ev.target.closest('g')) return;
      const p = toImage(ev);
      let best = 0, bd = Infinity;
      pts.forEach((q, i) => { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = i; } });
      if (bd <= 90 * unit()) { pts[best] = p; draw(); }
    });

    const onResize = () => layout();
    window.addEventListener('resize', onResize);
    const finish = (result) => {
      window.removeEventListener('resize', onResize);
      document.body.style.overflow = prevOverflow;
      root.remove();
      resolve(result);
    };
    root.querySelector('.sr-x').addEventListener('click', () => finish({ action: 'cancel' }));
    root.querySelector('.sr-reset').addEventListener('click', () => { quad.forEach((p, i) => { pts[i] = [p[0], p[1]]; }); draw(); });
    root.querySelector('.sr-retake').addEventListener('click', () => {
      // Run the caller's re-open synchronously inside this tap: iOS only opens
      // a file picker from within a user gesture.
      try { if (typeof onRetake === 'function') onRetake(); } catch (e) { console.warn('[Scan] retake failed:', e); }
      finish({ action: 'retake' });
    });
    root.querySelector('.sr-use').addEventListener('click', () => finish({ action: 'use', quad: pts.map(p => [p[0], p[1]]) }));

    requestAnimationFrame(layout);
  });
}
