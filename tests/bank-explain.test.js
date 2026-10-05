'use strict';
// The bank-line explain engine (assets/js/bank-explain.js).
//
// Fixtures are the real description shapes from the live ANZ account, because
// the old vendor rules keyed on the bank's prefix ("VISA DEBIT PURCHASE CARD")
// and the Money In screen offered one verb for four kinds of deposit. Every
// case here is a way the engine could be silently wrong about real money.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = pathToFileURL(path.join(__dirname, '..', 'assets', 'js', 'bank-explain.js')).href;
const utilsUrl = pathToFileURL(path.join(__dirname, '..', 'assets', 'js', 'utils.js')).href;
const load = () => import(modUrl);

const credit = (description, amount, date = '2026-08-03', extra = {}) =>
  ({ id: extra.id || description, date, amount, description, direction: 'credit', ...extra });
const debit = (description, amount, date = '2026-08-03', extra = {}) =>
  ({ id: extra.id || description, date, amount, description, direction: 'debit', ...extra });

test('counterpartyKey(): the merchant, not the bank prefix', async () => {
  const { counterpartyKey } = await load();
  const cases = [
    ['VISA DEBIT PURCHASE CARD 0500 BUNNINGS 450000 NORTHMEAD', 'BUNNINGS NORTHMEAD'],
    ['ANZ MOBILE BANKING PAYMENT 110245 TO Mr Brock Dewar', 'BROCK DEWAR'],
    ['TRANSFER FROM MARDINI C        KATOOMBA MO', 'MARDINI KATOOMBA'],
    ['PAYMENT FROM C MARDINI', 'MARDINI'],
    ['ACCOUNT SERVICING FEE', 'ACCOUNT SERVICING'],
    ['VISA DEBIT DEPOSIT TEMU.COM               PARRAMATTA', 'TEMU.COM PARRAMATTA'],
    ['SQ *CORNER COFFEE BURWOOD', 'CORNER COFFEE'],
    ['ANZ INTERNET BANKING BPAY SYDNEY WATER                  {757', 'SYDNEY WATER'],
    ['TRANSFER FROM PAYONEER AUSTRAL 366185591304590', 'PAYONEER'],
    ['VISA DEBIT DEPOSIT AMAZON RETA* AMAZON AU SYDNEY', 'AMAZON RETA'],
    ['PAYMENT TO MARDINI CHADDY', 'MARDINI CHADDY'],
  ];
  for (const [raw, want] of cases) assert.strictEqual(counterpartyKey(raw), want, raw);
});

test('detectPlatform(): Payoneer is how Airbnb lands; VRBO statements say Expedia', async () => {
  const { detectPlatform } = await load();
  assert.strictEqual(detectPlatform('TRANSFER FROM PAYONEER AUSTRAL 366185591304590'), 'airbnb');
  assert.strictEqual(detectPlatform('TRANSFER FROM PAYONEER AUSTRAL AIRBNB PAYMENTS'), 'airbnb');
  assert.strictEqual(detectPlatform('TRANSFER FROM VRBO HOLDINGS IN 12-03/26'), 'vrbo');
  assert.strictEqual(detectPlatform('EXPEDIA GROUP PAYMENT'), 'vrbo');
  assert.strictEqual(detectPlatform('BOOKING.COM B.V.'), 'booking_com');
  assert.strictEqual(detectPlatform('TRANSFER FROM MARDINI C'), null);
});

test('rules: a platform deposit is a payout, a servicing fee is a Bank Fees expense, interest is interest', async () => {
  const { explainLine, BANK_FEES_CATEGORY } = await load();
  const payout = explainLine(credit('TRANSFER FROM PAYONEER AUSTRAL 366185591304590', 1305.45));
  assert.strictEqual(payout.kind, 'platform_payout');
  assert.strictEqual(payout.platform, 'airbnb');
  assert.strictEqual(payout.needsReview, false);

  const fee = explainLine(debit('ACCOUNT SERVICING FEE', 10));
  assert.strictEqual(fee.kind, 'expense');
  assert.strictEqual(fee.category, BANK_FEES_CATEGORY);
  assert.strictEqual(fee.needsReview, false);

  const adj = explainLine(credit('DEBIT INTEREST CHARGED ADJ DECREASE FROM 1', 0.01));
  assert.strictEqual(adj.kind, 'interest');
  assert.strictEqual(adj.needsReview, false);
});

test('memory: an exact key is certain and outranks the owner-name rule', async () => {
  const { explainLine, memoryKey } = await load();
  const memory = new Map([
    [memoryKey('debit', 'MARDINI CHADDY'), { kind: 'expense', category: 'Mortgage', propertyId: 'p-glen', timesUsed: 12, label: 'Mardini Chaddy' }],
  ]);
  const r = explainLine(debit('PAYMENT TO MARDINI CHADDY', 4710, '2026-07-07'), { memory, ownerNames: ['Chaddy Mardini'] });
  assert.strictEqual(r.kind, 'expense');
  assert.strictEqual(r.category, 'Mortgage');
  assert.strictEqual(r.propertyId, 'p-glen');
  assert.strictEqual(r.needsReview, false);
  assert.strictEqual(r.source, 'memory');
});

test('memory: the same first word is only a suggestion', async () => {
  const { explainLine, memoryKey } = await load();
  const memory = new Map([
    [memoryKey('credit', 'MARDINI KATOOMBA'), { kind: 'owner_funds', timesUsed: 35, label: 'Mardini C' }],
  ]);
  const r = explainLine(credit('PAYMENT FROM C MARDINI', 1690.44, '2026-03-23'), { memory });
  assert.strictEqual(r.kind, 'owner_funds');
  assert.strictEqual(r.needsReview, true);
  assert.strictEqual(r.source, 'memory');
});

test('a card refund links to the purchase it refunds, by merchant and amount', async () => {
  const { explainLine } = await load();
  const expenses = [
    { id: 'e-amz', merchant: 'Amazon', amount: 51.67, date: '2026-07-10', category: 'Furnishings & Equipment', propertyId: 'p1' },
    { id: 'e-other', merchant: 'Bunnings', amount: 51.67, date: '2026-07-10', category: 'Maintenance & Repairs' },
  ];
  const r = explainLine(credit('VISA DEBIT DEPOSIT AMAZON RETA* AMAZON AU SYDNEY', 51.67, '2026-07-14'), { expenses });
  assert.strictEqual(r.kind, 'expense_refund');
  assert.strictEqual(r.expenseId, 'e-amz');
  assert.strictEqual(r.category, 'Furnishings & Equipment');
  assert.strictEqual(r.propertyId, 'p1');
  assert.strictEqual(r.needsReview, false);
});

test('a part-refund links to the most recent purchase, an exact refund to the purchase itself', async () => {
  const { explainLine } = await load();
  const expenses = [
    { id: 'aug', merchant: 'Bunnings Warehouse', amount: 199, date: '2025-08-16', category: 'Furnishings & Equipment' },
    { id: 'jan', merchant: 'Bunnings Warehouse', amount: 448.77, date: '2026-01-24', category: 'Furnishings & Equipment' },
    { id: 'small', merchant: 'Bunnings Warehouse', amount: 60, date: '2025-12-13', category: 'Furnishings & Equipment' },
  ];
  const part = explainLine(credit('VISA DEBIT DEPOSIT BUNNINGS 450000           NORTHMEAD', 134.75, '2026-01-30'), { expenses });
  assert.strictEqual(part.expenseId, 'jan', 'nearest price ($199) loses to the most recent run');
  const exact = explainLine(credit('VISA DEBIT DEPOSIT BUNNINGS 450000           NORTHMEAD', 60, '2026-01-30'), { expenses });
  assert.strictEqual(exact.expenseId, 'small');
});

test('a card refund with no recorded purchase is still a refund, but asks', async () => {
  const { explainLine } = await load();
  const r = explainLine(credit('VISA DEBIT DEPOSIT MJS ELECTRICALSUPPLIES FAIRFIELD', 103.02), { expenses: [] });
  assert.strictEqual(r.kind, 'expense_refund');
  assert.strictEqual(r.expenseId, null);
  assert.strictEqual(r.needsReview, true);
});

test('an owner transfer is never mistaken for a refund of the mortgage that carries the same surname', async () => {
  const { explainLine } = await load();
  // The real shape: bank-import-created expenses carry the raw pattern as vendor.
  const expenses = [
    { id: 'e-mort', merchant: 'ANZ Mortgage', vendor: 'PAYMENT TO MARDINI CHADDY', amount: 4710, date: '2026-07-07', category: 'Mortgage' },
  ];
  const r = explainLine(credit('TRANSFER FROM MARDINI C        KATOOMBA MO', 1200, '2026-07-20'), { expenses });
  assert.strictEqual(r.kind, null, 'no signal, no memory → not decided, never a refund');
  assert.strictEqual(r.needsReview, true);
});

test('owner name: a transfer from a known owner is suggested as owner funds', async () => {
  const { explainLine } = await load();
  const r = explainLine(credit('TRANSFER FROM MARDINI C        KATOOMBA MO', 1200), { ownerNames: ['Chaddy Mardini'] });
  assert.strictEqual(r.kind, 'owner_funds');
  assert.strictEqual(r.needsReview, true);
});

test('a payment that equals one recorded expense links to it; a second payment cannot claim the same invoice', async () => {
  const { explainLines } = await load();
  const expenses = [
    { id: 'e-clean', merchant: 'Brock Dewar', amount: 620, date: '2026-08-01', category: 'Cleaning & Garden', propertyId: 'p1' },
  ];
  const lines = [
    debit('ANZ MOBILE BANKING PAYMENT 110245 TO Mr Brock Dewar', 620, '2026-08-03', { id: 'd1' }),
    debit('ANZ MOBILE BANKING PAYMENT 110246 TO Mr Brock Dewar', 620, '2026-08-05', { id: 'd2' }),
  ];
  const out = explainLines(lines, { expenses });
  const first = out.get('d1');
  const second = out.get('d2');
  assert.strictEqual(first.kind, 'expense');
  assert.strictEqual(first.expenseId, 'e-clean');
  assert.strictEqual(first.needsReview, false);
  assert.strictEqual(second.kind, 'expense');
  assert.strictEqual(second.expenseId, null);
  assert.strictEqual(second.needsReview, true, 'still an expense, but needs a category');
});

test('every payment is an expense: an unknown debit defaults to expense needing a category', async () => {
  const { explainLine } = await load();
  const r = explainLine(debit('VISA DEBIT PURCHASE CARD 0500 KMART MULGRAVE', 250.38));
  assert.strictEqual(r.kind, 'expense');
  assert.strictEqual(r.category, null);
  assert.strictEqual(r.needsReview, true);
  assert.strictEqual(r.source, 'default');
});

test('explainLines(): a platform deposit is linked to its one-to-one payout', async () => {
  const { explainLines } = await load();
  const payouts = [
    { _cloudId: 'p1', platform: 'airbnb', net: 1305.45, payoutDate: '2026-07-05', expectedArrivalDate: '2026-07-10', status: 'active', bankTransactionId: null },
    { _cloudId: 'p2', platform: 'airbnb', net: 999.88, payoutDate: '2026-05-28', expectedArrivalDate: '2026-06-04', status: 'active', bankTransactionId: null },
  ];
  const lines = [credit('TRANSFER FROM PAYONEER AUSTRAL 366185591304590', 1305.45, '2026-07-06', { id: 'c1' })];
  const out = explainLines(lines, { payouts });
  const r = out.get('c1');
  assert.strictEqual(r.kind, 'platform_payout');
  assert.strictEqual(r.payoutId, 'p1');
  assert.strictEqual(r.needsReview, false);
});

test('explainLines(): a payout with two candidate deposits links neither', async () => {
  const { explainLines } = await load();
  const payouts = [
    { _cloudId: 'p1', platform: 'airbnb', net: 1373.14, payoutDate: '2026-04-26', expectedArrivalDate: '2026-05-01', status: 'active' },
  ];
  const lines = [
    credit('TRANSFER FROM PAYONEER AUSTRAL 1', 1373.14, '2026-04-27', { id: 'c1' }),
    credit('TRANSFER FROM PAYONEER AUSTRAL 2', 1373.14, '2026-04-28', { id: 'c2' }),
  ];
  const out = explainLines(lines, { payouts });
  assert.strictEqual(out.get('c1').payoutId, null);
  assert.strictEqual(out.get('c2').payoutId, null);
  assert.strictEqual(out.get('c1').kind, 'platform_payout', 'the kind is still certain; only the link waits');
});

test('a deposit equal to one booking\'s payout is suggested as a direct booking', async () => {
  const { explainLine } = await load();
  const bookings = [{ id: 'b1', guestName: 'Kyle', hostPayout: 850, checkin: '2026-08-10', checkout: '2026-08-13', platform: 'direct', status: 'confirmed' }];
  const r = explainLine(credit('OSKO PAYMENT FROM K ARMSTRONG', 850, '2026-08-01'), { bookings });
  assert.strictEqual(r.kind, 'direct_booking');
  assert.strictEqual(r.bookingId, 'b1');
  assert.strictEqual(r.needsReview, true);
});

test('kinds are gated by direction', async () => {
  const { kindsForDirection, isValidKind, kindLabel } = await load();
  assert.ok(kindsForDirection('credit').includes('platform_payout'));
  assert.ok(!kindsForDirection('credit').includes('expense'));
  assert.ok(kindsForDirection('debit').includes('expense'));
  assert.strictEqual(isValidKind('expense', 'credit'), false);
  assert.strictEqual(kindLabel('owner_funds', 'credit'), 'Owner funds in');
  assert.strictEqual(kindLabel('owner_funds', 'debit'), 'Owner funds out');
  assert.strictEqual(kindLabel(null, 'debit'), 'Not decided');
});

test('summariseLines(): the queue is kind-less OR needs-review, in integer cents', async () => {
  const { summariseLines } = await load();
  const s = summariseLines([
    { direction: 'credit', amount: 0.1, kind: 'platform_payout', needsReview: false },
    { direction: 'credit', amount: 0.2, kind: null, needsReview: true },
    { direction: 'debit', amount: 10, kind: 'expense', needsReview: true },
    { direction: 'debit', amount: 5, kind: 'expense', needsReview: false },
  ]);
  assert.strictEqual(s.toDecide, 2);
  assert.strictEqual(s.toDecideCents, 1020);
  assert.strictEqual(s.inCents, 30);
  assert.strictEqual(s.outCents, 1500);
  assert.strictEqual(s.explainedIn, 1);
  assert.strictEqual(s.explainedOut, 1);
});

test('fyOfDate() / fyBounds(): 30 June and 1 July sit in different years, no Date round-trip', async () => {
  const { fyOfDate, fyBounds } = await import(utilsUrl);
  assert.strictEqual(fyOfDate('2026-06-30'), 2025);
  assert.strictEqual(fyOfDate('2026-07-01'), 2026);
  assert.strictEqual(fyOfDate('2026-10-04'), 2026);
  assert.strictEqual(fyOfDate(''), null);
  assert.deepStrictEqual(fyBounds(2026), { start: '2026-07-01', end: '2027-06-30' });
});
