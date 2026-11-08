// ── IN-APP DOCUMENT SCANNER: IMAGE MATHS ────────────────────────────────────
// Turns a photo of a receipt into a flat, evenly lit "scan": find the paper's
// four corners, straighten it with a perspective warp, then normalise the
// lighting so the paper reads white and the print dark. This is what runs for
// photos that come through the file picker (camera roll, or the picker's own
// Take Photo), on every platform. The native iOS tile uses VisionKit instead.
//
// Pure functions over plain {data, width, height} buffers — no DOM, so the
// node tests in tests/receipt-image-scan.test.js can exercise every step.
// receipt-review.js owns the canvas work and the corner-adjust UI.

/** Luma of an RGBA buffer → Uint8Array. */
export function rgbaToGray(rgba, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return out;
}

/** Separable box blur with running sums: O(pixels) whatever the radius. */
export function boxBlurGray(gray, w, h, r) {
  if (r <= 0) return Uint8Array.from(gray);
  const tmp = new Float32Array(w * h);
  const out = new Uint8Array(w * h);
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += gray[row + clampi(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / (2 * r + 1);
      sum += gray[row + clampi(x + r + 1, 0, w - 1)] - gray[row + clampi(x - r, 0, w - 1)];
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[clampi(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = Math.round(sum / (2 * r + 1));
      sum += tmp[clampi(y + r + 1, 0, h - 1) * w + x] - tmp[clampi(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}

function clampi(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Otsu's threshold: the grey level that best splits a bimodal histogram. */
export function otsuThreshold(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let wB = 0, sumB = 0, best = -1, firstT = 127, lastT = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; firstT = t; lastT = t; }
    else if (between === best) lastT = t; // plateau between two modes: take its middle
  }
  return Math.round((firstT + lastT) / 2);
}

export function thresholdMask(gray, t) {
  const m = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) m[i] = gray[i] > t ? 1 : 0;
  return m;
}

function erode3(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    out[i] = (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w]) ? 1 : 0;
  }
  return out;
}
function dilate3(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    out[i] = (mask[i] || (x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1]) || (y > 0 && mask[i - w]) || (y < h - 1 && mask[i + w])) ? 1 : 0;
  }
  return out;
}

/** Morphological opening (erode then dilate) — strips speckle smaller than ~2r px. */
export function morphOpen(mask, w, h, r = 1) {
  let m = mask;
  for (let i = 0; i < r; i++) m = erode3(m, w, h);
  for (let i = 0; i < r; i++) m = dilate3(m, w, h);
  return m;
}

/**
 * Largest 4-connected blob of 1s. Returns its area, bbox and boundary pixels
 * (component pixels with a non-component 4-neighbour or on the image edge).
 */
export function largestComponent(mask, w, h) {
  const label = new Int32Array(w * h); // 0 = unvisited
  const stack = new Int32Array(w * h);
  let bestArea = 0, bestLabel = 0, next = 1;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue;
    const id = next++;
    let sp = 0, area = 0;
    stack[sp++] = s; label[s] = id;
    while (sp) {
      const i = stack[--sp];
      area++;
      const x = i % w, y = (i - x) / w;
      if (x > 0 && mask[i - 1] && !label[i - 1]) { label[i - 1] = id; stack[sp++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !label[i + 1]) { label[i + 1] = id; stack[sp++] = i + 1; }
      if (y > 0 && mask[i - w] && !label[i - w]) { label[i - w] = id; stack[sp++] = i - w; }
      if (y < h - 1 && mask[i + w] && !label[i + w]) { label[i + w] = id; stack[sp++] = i + w; }
    }
    if (area > bestArea) { bestArea = area; bestLabel = id; }
  }
  if (!bestLabel) return null;
  const boundary = [];
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (label[i] !== bestLabel) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1
      || label[i - 1] !== bestLabel || label[i + 1] !== bestLabel
      || label[i - w] !== bestLabel || label[i + w] !== bestLabel) boundary.push([x, y]);
  }
  return { area: bestArea, boundary, bbox: { minX, minY, maxX, maxY } };
}

/** Andrew's monotone chain. Returns the hull counter-clockwise (y down → visually clockwise). */
export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** The 4 hull vertices enclosing the most area — a clean quad's corners. */
export function maxAreaQuad(hull, maxPts = 60) {
  if (!hull || hull.length < 4) return null;
  let pts = hull;
  if (pts.length > maxPts) {
    pts = [];
    for (let i = 0; i < maxPts; i++) pts.push(hull[Math.floor(i * hull.length / maxPts)]);
  }
  const n = pts.length;
  let best = -1, bq = null;
  for (let i = 0; i < n - 3; i++) for (let j = i + 1; j < n - 2; j++) for (let k = j + 1; k < n - 1; k++) for (let l = k + 1; l < n; l++) {
    const a = polygonArea([pts[i], pts[j], pts[k], pts[l]]);
    if (a > best) { best = a; bq = [pts[i], pts[j], pts[k], pts[l]]; }
  }
  return bq;
}

/** Order 4 points as [top-left, top-right, bottom-right, bottom-left]. */
export function orderQuad(pts) {
  const bySum = pts.slice().sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  const tl = bySum[0], br = bySum[3];
  const rest = pts.filter(p => p !== tl && p !== br);
  const [p, q] = rest;
  // top-right has the larger x − y
  const tr = (p[0] - p[1]) > (q[0] - q[1]) ? p : q;
  const bl = tr === p ? q : p;
  return [tl, tr, br, bl];
}

export function isConvexQuad(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cr === 0) continue;
    if (!sign) sign = cr > 0 ? 1 : -1;
    else if ((cr > 0 ? 1 : -1) !== sign) return false;
  }
  return sign !== 0;
}

export function fullImageQuad(w, h) {
  return [[0, 0], [w, 0], [w, h], [0, h]];
}

/**
 * Find the receipt in a (small, ~480px) greyscale image. Paper is assumed to be
 * the largest bright region. Returns [tl,tr,br,bl] or null when nothing
 * plausible stands out — the caller then offers the whole frame for manual
 * corner adjustment.
 */
export function detectDocumentQuad(gray, w, h, opts = {}) {
  const minAreaFrac = opts.minAreaFrac ?? 0.12;
  const blurred = boxBlurGray(gray, w, h, 2);
  const t = otsuThreshold(blurred);
  const mask = morphOpen(thresholdMask(blurred, t), w, h, 1);
  const comp = largestComponent(mask, w, h);
  if (!comp || comp.area < minAreaFrac * w * h) return null;
  const quad = maxAreaQuad(convexHull(comp.boundary));
  if (!quad) return null;
  const q = orderQuad(quad.map(p => [p[0], p[1]]));
  if (!isConvexQuad(q) || polygonArea(q) < minAreaFrac * w * h) return null;
  // Blur + opening shave a pixel or two off the paper; push the corners back out.
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const grow = opts.grow ?? 1.5;
  return q.map(([x, y]) => {
    const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1;
    return [clampf(x + dx / d * grow, 0, w), clampf(y + dy / d * grow, 0, h)];
  });
}

function clampf(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Solve the 3×3 homography H with to ≈ H·from for 4 point pairs (DLT, 8×8 Gaussian elimination). */
export function computeHomography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) throw new Error('Degenerate quad');
    if (piv !== col) { [A[piv], A[col]] = [A[col], A[piv]]; [b[piv], b[col]] = [b[col], b[piv]]; }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (!f) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const hv = b.map((v, i) => v / A[i][i]);
  return Float64Array.from([hv[0], hv[1], hv[2], hv[3], hv[4], hv[5], hv[6], hv[7], 1]);
}

export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Output pixel size for a quad: its longest opposite edges, capped to maxLongEdge. */
export function outputSizeForQuad(quad, maxLongEdge = 1600) {
  const [tl, tr, br, bl] = quad;
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let w = Math.max(len(tl, tr), len(bl, br));
  let h = Math.max(len(tl, bl), len(tr, br));
  const s = Math.min(1, maxLongEdge / Math.max(w, h, 1));
  w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
  return { w, h };
}

/** Straighten: map the quad onto an outW×outH rectangle with bilinear sampling. */
export function warpPerspective(src, quad, outW, outH) {
  const { data, width: sw, height: sh } = src;
  const H = computeHomography([[0, 0], [outW, 0], [outW, outH], [0, outH]], quad);
  const out = new Uint8ClampedArray(outW * outH * 4);
  let o = 0;
  for (let y = 0; y < outH; y++) {
    const yc = y + 0.5;
    for (let x = 0; x < outW; x++) {
      const xc = x + 0.5;
      const wv = H[6] * xc + H[7] * yc + H[8];
      let sx = (H[0] * xc + H[1] * yc + H[2]) / wv - 0.5;
      let sy = (H[3] * xc + H[4] * yc + H[5]) / wv - 0.5;
      sx = sx < 0 ? 0 : sx > sw - 1 ? sw - 1 : sx;
      sy = sy < 0 ? 0 : sy > sh - 1 ? sh - 1 : sy;
      const x0 = sx | 0, y0 = sy | 0;
      const x1 = x0 < sw - 1 ? x0 + 1 : x0, y1 = y0 < sh - 1 ? y0 + 1 : y0;
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      out[o++] = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
      out[o++] = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
      out[o++] = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
      out[o++] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}

/**
 * Scan look: estimate the paper's local brightness (a max-filtered, heavily
 * blurred copy at quarter scale, so printed text does not drag it down) and
 * divide it out, so shadows and vignetting vanish and the paper reads white.
 * Colour is preserved; a mild contrast curve sharpens the print. In place.
 */
export function enhanceDocument(img, opts = {}) {
  const { data, width: w, height: h } = img;
  const target = opts.target ?? 240;
  const maxGain = opts.maxGain ?? 3;
  const contrast = opts.contrast ?? 1.12;
  const gray = rgbaToGray(data, w, h);
  // quarter-scale background estimate
  const f = 4, sw = Math.max(1, Math.ceil(w / f)), sh = Math.max(1, Math.ceil(h / f));
  const small = new Uint8Array(sw * sh);
  const cnt = new Uint16Array(sw * sh);
  const acc = new Uint32Array(sw * sh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = ((y / f) | 0) * sw + ((x / f) | 0);
    acc[si] += gray[y * w + x]; cnt[si]++;
  }
  for (let i = 0; i < small.length; i++) small[i] = cnt[i] ? Math.round(acc[i] / cnt[i]) : 0;
  let bg = small;
  for (let i = 0; i < 2; i++) bg = maxFilter3(bg, sw, sh);
  bg = boxBlurGray(bg, sw, sh, Math.max(2, Math.round(Math.max(sw, sh) / 12)));
  for (let y = 0; y < h; y++) {
    const syf = Math.min(sh - 1, Math.max(0, (y + 0.5) / f - 0.5));
    const y0 = syf | 0, y1 = Math.min(sh - 1, y0 + 1), fy = syf - y0;
    for (let x = 0; x < w; x++) {
      const sxf = Math.min(sw - 1, Math.max(0, (x + 0.5) / f - 0.5));
      const x0 = sxf | 0, x1 = Math.min(sw - 1, x0 + 1), fx = sxf - x0;
      const b = bg[y0 * sw + x0] * (1 - fx) * (1 - fy) + bg[y0 * sw + x1] * fx * (1 - fy)
        + bg[y1 * sw + x0] * (1 - fx) * fy + bg[y1 * sw + x1] * fx * fy;
      let gain = target / Math.max(b, 30);
      if (gain > maxGain) gain = maxGain;
      const p = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let v = data[p + c] * gain;
        v = 128 + (v - 128) * contrast;
        data[p + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  return img;
}

function maxFilter3(src, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = clampi(y + dy, 0, h - 1);
      for (let dx = -1; dx <= 1; dx++) {
        const v = src[yy * w + clampi(x + dx, 0, w - 1)];
        if (v > m) m = v;
      }
    }
    out[y * w + x] = m;
  }
  return out;
}
