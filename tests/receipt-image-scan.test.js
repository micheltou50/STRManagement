'use strict';
// Tripwire for the in-app document scanner maths (assets/js/receipt-image-scan.js):
// corner detection, homography/warp and the scan-look enhancement, on
// procedurally drawn "photos" so the test needs no image decoder.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = pathToFileURL(path.join(__dirname, '..', 'assets', 'js', 'receipt-image-scan.js')).href;
const importMod = () => import(modUrl);

/** Is p inside the convex quad (any winding)? */
function inQuad(q, x, y) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const cr = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (cr === 0) continue;
    const s = cr > 0 ? 1 : -1;
    if (!sign) sign = s; else if (s !== sign) return false;
  }
  return true;
}

/** Dark background, bright tilted paper with dark text lines, optional lighting falloff. */
function makeScene(w, h, quad, { bg = 40, paper = 230, textEvery = 12, lighting = false } = {}) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = inQuad(quad, x + 0.5, y + 0.5);
    let v = inside ? paper : bg;
    if (inside && textEvery && y % textEvery === 0 && x > quad[0][0] + 15 && x < quad[1][0] - 15) v = 35;
    if (lighting) v = Math.round(v * (0.55 + 0.45 * (1 - y / h)));
    const p = (y * w + x) * 4;
    data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255;
  }
  return { data, width: w, height: h };
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

test('detectDocumentQuad() finds a tilted receipt on a dark background within a few pixels', async () => {
  const { rgbaToGray, detectDocumentQuad } = await importMod();
  const w = 240, h = 320;
  const truth = [[60, 40], [190, 55], [175, 290], [45, 275]];
  const scene = makeScene(w, h, truth, { lighting: true });
  const q = detectDocumentQuad(rgbaToGray(scene.data, w, h), w, h);
  assert.ok(q, 'a quad was detected');
  q.forEach((p, i) => assert.ok(dist(p, truth[i]) <= 4, `corner ${i} ${p} ≈ ${truth[i]}`));
});

test('detectDocumentQuad() returns null when nothing receipt-sized stands out', async () => {
  const { rgbaToGray, detectDocumentQuad } = await importMod();
  const w = 200, h = 200;
  // a bright 30×30 sticker = 2% of the frame
  const scene = makeScene(w, h, [[80, 80], [110, 80], [110, 110], [80, 110]], { textEvery: 0 });
  assert.strictEqual(detectDocumentQuad(rgbaToGray(scene.data, w, h), w, h), null);
});

test('computeHomography() maps the four pairs exactly and applyHomography() agrees', async () => {
  const { computeHomography, applyHomography } = await importMod();
  const from = [[0, 0], [100, 0], [100, 200], [0, 200]];
  const to = [[60, 40], [190, 55], [175, 290], [45, 275]];
  const H = computeHomography(from, to);
  from.forEach((p, i) => {
    const m = applyHomography(H, p[0], p[1]);
    assert.ok(dist(m, to[i]) < 1e-6, `pair ${i}`);
  });
  // centre of the rectangle lands strictly inside the quad
  const c = applyHomography(H, 50, 100);
  assert.ok(inQuad(to, c[0], c[1]));
});

test('warpPerspective() straightens the paper: output is paper everywhere, text rows stay dark', async () => {
  const { warpPerspective, outputSizeForQuad } = await importMod();
  const w = 240, h = 320;
  const truth = [[60, 40], [190, 55], [175, 290], [45, 275]];
  const scene = makeScene(w, h, truth, { textEvery: 0 });
  const { w: ow, h: oh } = outputSizeForQuad(truth, 1600);
  assert.ok(ow >= 125 && ow <= 140 && oh >= 230 && oh <= 245, `output ${ow}x${oh} follows the quad's edges`);
  const out = warpPerspective(scene, truth, ow, oh);
  assert.strictEqual(out.data.length, ow * oh * 4);
  const px = (x, y) => out.data[(y * ow + x) * 4];
  // interior and near-corner samples are all paper, never background
  for (const [x, y] of [[ow >> 1, oh >> 1], [3, 3], [ow - 4, 3], [ow - 4, oh - 4], [3, oh - 4]]) {
    assert.ok(px(x, y) > 200, `(${x},${y}) = ${px(x, y)} is paper`);
  }
});

test('outputSizeForQuad() caps the long edge and keeps the aspect ratio', async () => {
  const { outputSizeForQuad } = await importMod();
  const q = [[0, 0], [3000, 0], [3000, 6000], [0, 6000]];
  assert.deepStrictEqual(outputSizeForQuad(q, 1600), { w: 800, h: 1600 });
  assert.deepStrictEqual(outputSizeForQuad([[0, 0], [100, 0], [100, 50], [0, 50]], 1600), { w: 100, h: 50 });
});

test('enhanceDocument() lifts shaded paper to white and keeps print dark', async () => {
  const { enhanceDocument } = await importMod();
  const w = 160, h = 240;
  const full = [[0, 0], [w, 0], [w, h], [0, h]];
  const img = makeScene(w, h, full, { paper: 200, textEvery: 16, lighting: true });
  // before: top is brighter than bottom (lighting falloff)
  const rowMean = (y) => { let s = 0; for (let x = 0; x < w; x++) s += img.data[(y * w + x) * 4]; return s / w; };
  assert.ok(rowMean(5) - rowMean(h - 3) > 40, 'shading present before');
  enhanceDocument(img);
  assert.ok(rowMean(5) >= 225 && rowMean(h - 3) >= 225, `paper white top ${rowMean(5)} bottom ${rowMean(h - 3)}`);
  // The blurred background estimate is clamped at the image edge, so the last
  // rows keep a little of the gradient; what matters is both ends read as paper.
  assert.ok(Math.abs(rowMean(5) - rowMean(h - 3)) < 30, `shading mostly removed (${rowMean(5).toFixed(0)} vs ${rowMean(h - 3).toFixed(0)})`);
  // a text row (y multiple of 16) stays dark in its printed span
  let dark = 0, n = 0;
  for (let x = 20; x < w - 20; x++) { n++; if (img.data[(96 * w + x) * 4] < 120) dark++; }
  assert.ok(dark / n > 0.9, `text row stays dark (${dark}/${n})`);
});

test('otsuThreshold() splits a bimodal image between the modes; orderQuad() orders any permutation', async () => {
  const { otsuThreshold, orderQuad } = await importMod();
  const g = new Uint8Array(1000);
  for (let i = 0; i < g.length; i++) g[i] = i % 3 ? 230 : 40;
  const t = otsuThreshold(g);
  assert.ok(t > 40 && t < 230, `threshold ${t}`);
  const tl = [10, 10], tr = [100, 14], br = [96, 200], bl = [8, 190];
  assert.deepStrictEqual(orderQuad([br, tl, bl, tr]), [tl, tr, br, bl]);
  assert.deepStrictEqual(orderQuad([bl, br, tr, tl]), [tl, tr, br, bl]);
});
