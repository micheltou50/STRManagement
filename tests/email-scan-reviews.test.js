/**
 * StayOps — guest-review capture from Airbnb notification emails.
 *
 * Airbnb emails the host "<Name> left a 5-star review!" once a review is
 * public. The scan must (a) recognise only that email — never the "wrote you a
 * review" / "Write a review" ones that carry no text, (b) keep the PUBLIC text
 * and drop the private "NOTE FROM" section, (c) store it as a PENDING row in
 * the shared `reviews` table for the website admin to approve, and (d) only
 * mark the message processed once the row is safely stored.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { installFetchMock, resetAll } = require('./_mocks.js');

const SHARED = path.join(__dirname, '..', 'Netlify', 'functions', 'utils', 'email-scan-shared.js');

const _origLoad = Module._load;
const STUBS = {
  'web-push': { setVapidDetails() {}, async sendNotification() { return { statusCode: 201 }; } },
  '@sentry/node': new Proxy({}, { get: () => () => {} }),
};
function installModuleStubs() {
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
    return _origLoad.call(this, request, parent, isMain);
  };
}
function restoreModuleStubs() { Module._load = _origLoad; }
function loadShared() {
  delete require.cache[require.resolve(SHARED)];
  return require(SHARED);
}

const FROM = 'Airbnb <automated@airbnb.com>';
const SUBJECT = 'Euranie left a 5-star review!';
// Abridged copy of the real email (plain-text part).
const BODY = [
  'Read on for a snapshot of what they loved',
  'EURANIE RATED THEIR STAY 5 STARS!',
  'Euranie had great things to say about their stay—read on for a snapshot of what they loved most.',
  'FEEDBACK FROM THEIR STAY',
  '   Glenhaven - A Quintessential Katoomba Cottage',
  '   Oct 21 – 22, 2026',
  'OVERALL RATING 5',
  'Une maison au top, idéal pour une famille !',
  'Environnement calme et propice au repos.',
  'Je recommande 😊',
  'Michel a été très disponible et réactif lors d + More',
  'NOTE FROM EURANIE',
  'Michel, merci encore ! Votre maison est très agréable.',
  'SPECIAL THANKS',
  '   Spotless furniture & linens',
  'Read full review',
].join('\n');

const PROP = { id: 'prop-glenhaven', name: 'Glenhaven', mgmtFeeRate: 10, airbnbListingId: '', airbnbListingTitle: '' };

function makeCtx(fetchCalls) {
  return {
    supabaseUrl: 'https://sb.test', sbHeaders: {}, uid: 'user-1',
    existingBookings: [], propMap: [PROP], defaultProp: PROP, isSingleProperty: true,
    results: { imported: 0, updated: 0, cancelled: 0, skipped: 0, errors: 0, details: [] },
    needsReview: [], newlySkipped: [], emailFrom: FROM, supabaseAdmin: null,
    _calls: fetchCalls,
  };
}

/** Fetch mock: GET /reviews returns `existing`; POST /reviews echoes the row
 *  with an id (or fails with `postStatus`). */
function buildFetchMock({ existing = [], postStatus = 201 } = {}) {
  const calls = [];
  const fetchMock = async (url, init) => {
    const method = (init && init.method) || 'GET';
    calls.push({ url: String(url), method, body: init && init.body ? JSON.parse(init.body) : null });
    if (String(url).includes('/rest/v1/reviews') && method === 'POST') {
      if (postStatus >= 400) return { ok: false, status: postStatus, async text() { return 'boom'; }, async json() { return {}; } };
      const row = { id: 'rev-' + calls.length, ...JSON.parse(init.body) };
      return { ok: true, status: 201, async json() { return [row]; }, async text() { return JSON.stringify([row]); } };
    }
    if (String(url).includes('/rest/v1/reviews') && method === 'GET') {
      return { ok: true, status: 200, async json() { return existing; }, async text() { return JSON.stringify(existing); } };
    }
    return { ok: true, status: 200, async json() { return []; }, async text() { return '[]'; } };
  };
  return { fetchMock, calls };
}

const CLAUDE_OK = {
  is_review: true,
  guestFirstName: 'Euranie',
  rating: 5,
  reviewText: 'Une maison au top, idéal pour une famille ! Environnement calme et propice au repos. Je recommande 😊 Michel a été très disponible et réactif lors d + More',
  isTruncated: true,
  stayPeriod: 'October 2026',
  listingTitle: 'Glenhaven - A Quintessential Katoomba Cottage',
  language: 'fr',
};

// ── Pre-filter ───────────────────────────────────────────────────────────────

test('looksLikeReviewEmail: accepts the "left a 5-star review!" email', () => {
  installModuleStubs();
  try {
    const { looksLikeReviewEmail } = loadShared();
    assert.equal(looksLikeReviewEmail(SUBJECT, FROM, BODY), true);
    assert.equal(looksLikeReviewEmail(SUBJECT, 'automated@airbnb.com', BODY), true);
    // Body-only signal (localised subject) still passes.
    assert.equal(looksLikeReviewEmail('Nouvel avis', FROM, BODY), true);
  } finally { restoreModuleStubs(); }
});

test('looksLikeReviewEmail: rejects the text-less sibling emails, bookings and spoofed senders', () => {
  installModuleStubs();
  try {
    const { looksLikeReviewEmail } = loadShared();
    assert.equal(looksLikeReviewEmail('Euranie wrote you a review', FROM, "You can read Euranie's review after you write one for them."), false);
    assert.equal(looksLikeReviewEmail('Write a review for Bryan, who checked out today', FROM, 'It only takes a moment to share this important feedback.'), false);
    assert.equal(looksLikeReviewEmail('Reservation confirmed - Glenhaven', FROM, 'Check-in Oct 21 ... Total payout $500'), false);
    assert.equal(looksLikeReviewEmail(SUBJECT, 'Airbnb <automated@airbnb.com.evil.net>', BODY), false);
    assert.equal(looksLikeReviewEmail(SUBJECT, 'someone@vrbo.com', BODY), false);
  } finally { restoreModuleStubs(); }
});

// ── Deterministic hints ──────────────────────────────────────────────────────

test('extractReviewHints: rating + name from the subject, truncation from the body', () => {
  installModuleStubs();
  try {
    const { extractReviewHints } = loadShared();
    const h = extractReviewHints(SUBJECT, BODY);
    assert.equal(h.rating, 5);
    assert.equal(h.guestFirstName, 'Euranie');
    assert.equal(h.truncated, true);
    const h2 = extractReviewHints('Nouvel avis', 'OVERALL RATING 4\nLovely place.');
    assert.equal(h2.rating, 4);
    assert.equal(h2.guestFirstName, null);
    assert.equal(h2.truncated, false);
  } finally { restoreModuleStubs(); }
});

// ── Normalisation ────────────────────────────────────────────────────────────

test('normalizeReview: strips "+ More", marks truncation with an ellipsis, keeps the original language', () => {
  installModuleStubs();
  try {
    const { normalizeReview, extractReviewHints } = loadShared();
    const r = normalizeReview(CLAUDE_OK, extractReviewHints(SUBJECT, BODY));
    assert.ok(r);
    assert.equal(r.guestName, 'Euranie');
    assert.equal(r.rating, 5);
    assert.equal(r.truncated, true);
    assert.ok(!/\+\s*More/.test(r.reviewText), 'no "+ More" marker');
    assert.ok(r.reviewText.endsWith('…'), 'truncated text ends with an ellipsis');
    assert.ok(r.reviewText.startsWith('Une maison au top'));
    assert.ok(!/merci encore/.test(r.reviewText), 'private note is not part of the text');
    assert.equal(r.stayDate, 'October 2026');
  } finally { restoreModuleStubs(); }
});

test('normalizeReview: falls back to the subject rating, refuses to invent text or rating', () => {
  installModuleStubs();
  try {
    const { normalizeReview } = loadShared();
    const noRating = normalizeReview({ ...CLAUDE_OK, rating: null, isTruncated: false }, { rating: 4, guestFirstName: 'Euranie', truncated: false });
    assert.equal(noRating.rating, 4);
    assert.equal(noRating.truncated, false);
    assert.ok(!noRating.reviewText.endsWith('…'));
    assert.equal(normalizeReview({ ...CLAUDE_OK, rating: null }, { rating: null }), null, 'no rating anywhere → null');
    assert.equal(normalizeReview({ ...CLAUDE_OK, reviewText: '' }, { rating: 5 }), null, 'no text → null');
    assert.equal(normalizeReview({ ...CLAUDE_OK, rating: 9 }, { rating: 5 }).rating, 5, 'out-of-range Claude rating → hint');
  } finally { restoreModuleStubs(); }
});

// ── Prompt ───────────────────────────────────────────────────────────────────

test('buildReviewPrompt: excludes the private note and treats the email as untrusted', () => {
  installModuleStubs();
  try {
    const { buildReviewPrompt } = loadShared();
    const p = buildReviewPrompt(SUBJECT, FROM, BODY, 'Glenhaven', null);
    assert.match(p, /NOTE FROM/);
    assert.match(p, /UNTRUSTED/);
    assert.match(p, /Do not translate/);
    assert.match(p, /"is_review"/);
    assert.ok(p.includes(BODY));
    const multi = buildReviewPrompt(SUBJECT, FROM, BODY, null, '1. "Glenhaven"\n2. "Seaview"');
    assert.match(multi, /"propertyMatch"/);
  } finally { restoreModuleStubs(); }
});

// ── Processing ───────────────────────────────────────────────────────────────

test('processReviewResult: stores a PENDING airbnb review on the resolved property and marks the email processed', async () => {
  installModuleStubs();
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  try {
    const { processReviewResult, extractReviewHints } = loadShared();
    const ctx = makeCtx(calls);
    await processReviewResult(CLAUDE_OK, extractReviewHints(SUBJECT, BODY), 'msg-1', 'gmail', ctx);

    const posts = calls.filter(c => c.method === 'POST' && c.url.includes('/rest/v1/reviews'));
    assert.equal(posts.length, 1, 'exactly one review row inserted');
    const row = posts[0].body;
    assert.equal(row.status, 'pending');
    assert.equal(row.platform, 'airbnb');
    assert.equal(row.property_id, 'prop-glenhaven');
    assert.equal(row.guest_name, 'Euranie');
    assert.equal(row.rating, 5);
    assert.equal(row.stay_date, 'October 2026');
    assert.ok(row.review_text.endsWith('…'));
    assert.ok(!/merci encore/.test(row.review_text));
    assert.equal(row.return_code, undefined, 'no guest return code on an imported review');

    assert.equal(ctx.results.reviews, 1);
    assert.equal(ctx.results.imported, 0, 'a review is not a booking');
    assert.deepEqual(ctx.newlySkipped, ['msg-1'], 'message marked processed');
    const d = ctx.results.details.find(x => x.msgId === 'msg-1');
    assert.equal(d.status, 'review');
    assert.equal(d.truncated, true);
    assert.equal(d.assigned_property, 'Glenhaven');
  } finally { resetAll(); restoreModuleStubs(); }
});

test('processReviewResult: an already-stored review (same guest, same opening words) is not inserted twice', async () => {
  installModuleStubs();
  const existing = [{ id: 'rev-old', status: 'approved', review_text: 'Une maison au top, idéal pour une famille ! Environnement calme…' }];
  const { fetchMock, calls } = buildFetchMock({ existing });
  installFetchMock(fetchMock);
  try {
    const { processReviewResult, extractReviewHints } = loadShared();
    const ctx = makeCtx(calls);
    await processReviewResult(CLAUDE_OK, extractReviewHints(SUBJECT, BODY), 'msg-2', 'gmail', ctx);
    assert.equal(calls.filter(c => c.method === 'POST').length, 0, 'no insert');
    assert.equal(ctx.results.reviews || 0, 0);
    assert.equal(ctx.results.skipped, 1);
    assert.deepEqual(ctx.newlySkipped, ['msg-2'], 'duplicate email is still marked processed');
  } finally { resetAll(); restoreModuleStubs(); }
});

test('processReviewResult: "no public text" and unparseable results are skipped and marked processed', async () => {
  installModuleStubs();
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  try {
    const { processReviewResult } = loadShared();
    const ctx = makeCtx(calls);
    await processReviewResult({ is_review: false }, { rating: null }, 'msg-3', 'gmail', ctx);
    await processReviewResult({ is_review: true, reviewText: '', rating: 5 }, { rating: 5 }, 'msg-4', 'gmail', ctx);
    assert.equal(calls.filter(c => c.method === 'POST').length, 0);
    assert.equal(ctx.results.skipped, 2);
    assert.deepEqual(ctx.newlySkipped, ['msg-3', 'msg-4']);
  } finally { resetAll(); restoreModuleStubs(); }
});

test('processReviewResult: transient Claude failure and failed insert are retried (not marked processed)', async () => {
  installModuleStubs();
  try {
    const { processReviewResult, extractReviewHints } = loadShared();

    const a = buildFetchMock();
    installFetchMock(a.fetchMock);
    const ctx1 = makeCtx(a.calls);
    await processReviewResult({ _transientError: true, _errMsg: '529' }, { rating: 5 }, 'msg-5', 'gmail', ctx1);
    assert.equal(ctx1.results.errors, 1);
    assert.deepEqual(ctx1.newlySkipped, [], 'transient failure is retried next scan');
    resetAll();

    const b = buildFetchMock({ postStatus: 500 });
    installFetchMock(b.fetchMock);
    const ctx2 = makeCtx(b.calls);
    await processReviewResult(CLAUDE_OK, extractReviewHints(SUBJECT, BODY), 'msg-6', 'outlook', ctx2);
    assert.equal(ctx2.results.errors, 1);
    assert.equal(ctx2.results.reviews || 0, 0);
    assert.deepEqual(ctx2.newlySkipped, [], 'failed insert is retried next scan');
  } finally { resetAll(); restoreModuleStubs(); }
});

test('processReviewResult: multi-property host — the listing title picks the property', async () => {
  installModuleStubs();
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  try {
    const { processReviewResult, extractReviewHints } = loadShared();
    const seaview = { id: 'prop-seaview', name: 'Seaview', mgmtFeeRate: 0, airbnbListingId: '', airbnbListingTitle: '' };
    const ctx = makeCtx(calls);
    ctx.propMap = [seaview, PROP];
    ctx.defaultProp = seaview;
    ctx.isSingleProperty = false;
    await processReviewResult({ ...CLAUDE_OK, propertyMatch: 'Glenhaven' }, extractReviewHints(SUBJECT, BODY), 'msg-7', 'gmail', ctx);
    const post = calls.find(c => c.method === 'POST');
    assert.ok(post);
    assert.equal(post.body.property_id, 'prop-glenhaven');
  } finally { resetAll(); restoreModuleStubs(); }
});

// ── Summary ──────────────────────────────────────────────────────────────────

test('buildSummaryResponse: reports captured reviews alongside booking changes', () => {
  installModuleStubs();
  try {
    const { buildSummaryResponse } = loadShared();
    const ids = new Set(['a', 'b']); ids._totalNew = 2;
    const onlyReviews = buildSummaryResponse(ids, { imported: 0, updated: 0, cancelled: 0, reviews: 2, skipped: 0, errors: 0, details: [] }, [], ['a', 'b']);
    assert.equal(onlyReviews.reviews, 2);
    assert.match(onlyReviews.message, /2 guest reviews captured/);
    const mixed = buildSummaryResponse(ids, { imported: 1, updated: 0, cancelled: 0, reviews: 1, skipped: 0, errors: 0, details: [] }, [], ['a', 'b']);
    assert.match(mixed.message, /1 imported/);
    assert.match(mixed.message, /1 guest review captured/);
    const none = buildSummaryResponse(ids, { imported: 0, updated: 0, cancelled: 0, skipped: 2, errors: 0, details: [] }, [], ['a', 'b']);
    assert.equal(none.reviews, 0);
    assert.equal(none.message, 'No new booking changes found');
  } finally { restoreModuleStubs(); }
});
