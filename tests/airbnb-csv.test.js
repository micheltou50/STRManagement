'use strict';
// Deterministic Airbnb transaction-CSV parser (assets/js/airbnb-csv.js).
//
// This parser replaces an AI call that returned HTTP 504 on a full financial
// year. Every case below exists because it is a way to be silently WRONG rather
// than loudly broken — wrong dates, wrong signs, swept-away rows, float drift.
// A parser that half-works is worse than the timeout it replaces, because the
// numbers look plausible.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = pathToFileURL(path.join(__dirname, '..', 'assets', 'js', 'airbnb-csv.js')).href;
const load = () => import(modUrl);

const HEADER = 'Date,Arriving by date,Type,Confirmation code,Booking date,Start date,End date,Nights,Guest,Listing,Details,Reference code,Currency,Amount,Paid out,Service fee,Fast pay fee,Cleaning fee,Gross earnings,Occupancy taxes,Earnings year';

// The exact row the host pasted when the 504 was reported.
const REAL_RESERVATION = '02/15/2026,,Reservation,HMCKAN8JN8,02/14/2026,02/14/2026,02/15/2026,1,Daniel Wilson,Glenhaven - A Quintessential Katoomba Cottage,,,AUD,290.10,,9.90,,0.00,300.00,0.00,2026';
const REAL_PAYOUT = '02/15/2026,,Payout,,,,,,,,Transfer to ANZ 8684,,AUD,,290.10,,,,,,2026';

const file = (...rows) => [HEADER, ...rows].join('\n');

test('the real pasted row: one payout, correct net, correct decomposition', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const out = parseAirbnbTransactionCsv(file(REAL_PAYOUT, REAL_RESERVATION));

  assert.ok(out, 'must recognise a genuine Airbnb export');
  assert.strictEqual(out.payouts.length, 1);
  const p = out.payouts[0];
  assert.strictEqual(p.platform, 'airbnb');
  assert.strictEqual(p.payoutDate, '2026-02-15', 'MM/DD/YYYY — not 2026-15-02');
  assert.strictEqual(p.currency, 'AUD');
  assert.strictEqual(p.payoutReference, null, 'must stay null so dedupe uses the natural key');
  assert.strictEqual(p.totalNet, 290.10);

  const accom = p.lines.find(l => l.lineType === 'accommodation');
  const fee = p.lines.find(l => l.lineType === 'host_fee');
  assert.strictEqual(accom.amount, 300.00, 'gross, i.e. Amount + service fee');
  assert.strictEqual(accom.confirmationCode, 'HMCKAN8JN8');
  assert.strictEqual(fee.amount, -9.90, 'written +9.90 in the file, MUST be emitted negative');
  assert.ok(!p.lines.some(l => l.lineType === 'cleaning_fee'), 'no line for a 0.00 cleaning fee');

  // The invariant the whole feature rests on: lines must sum to the real deposit.
  const sum = p.lines.reduce((a, l) => a + Math.round(l.amount * 100), 0);
  assert.strictEqual(sum, 29010);
  assert.ok(!p._unallocatedCents, 'a clean row needs no balancing line');
});

test('blank Gross earnings does not silently zero the accommodation line', async () => {
  // The gross-anchored formula was `gross - cleaning`; _parseMoneyCents('') is
  // null and `null - 0` is 0 in JS, not an error. Anchoring on Amount fixes it.
  const { parseAirbnbTransactionCsv } = await load();
  const noGross = '02/15/2026,,Reservation,HMX1,02/14/2026,02/14/2026,02/15/2026,1,Guest,Listing,,,AUD,290.10,,9.90,,0.00,,0.00,2026';
  const out = parseAirbnbTransactionCsv(file(REAL_PAYOUT, noGross));
  const accom = out.payouts[0].lines.find(l => l.lineType === 'accommodation');
  assert.strictEqual(accom.amount, 300.00);
  assert.ok(!out.payouts[0]._unallocatedCents, 'value must not land in a balancing line');
});

test('cleaning fee is itemised out of accommodation, never added on top', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const withClean = '03/02/2026,,Reservation,HMX2,03/01/2026,03/01/2026,03/03/2026,2,Guest,Listing,,,AUD,440.10,,9.90,,150.00,450.00,0.00,2026';
  const payout = '03/02/2026,,Payout,,,,,,,,Transfer to ANZ,,AUD,,440.10,,,,,,2026';
  const p = parseAirbnbTransactionCsv(file(payout, withClean)).payouts[0];

  const accom = p.lines.find(l => l.lineType === 'accommodation');
  const clean = p.lines.find(l => l.lineType === 'cleaning_fee');
  assert.strictEqual(clean.amount, 150.00);
  assert.strictEqual(accom.amount, 300.00, '450 gross MINUS the 150 cleaning, not 450');
  const sum = p.lines.reduce((a, l) => a + Math.round(l.amount * 100), 0);
  assert.strictEqual(sum, 44010, 'still sums to the deposit');
});

test('fast pay fee is charged, not swept into an unallocated adjustment', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const fastPay = '04/02/2026,,Reservation,HMX3,04/01/2026,04/01/2026,04/02/2026,1,Guest,Listing,,,AUD,285.10,,9.90,5.00,0.00,300.00,0.00,2026';
  const payout = '04/02/2026,,Payout,,,,,,,,Transfer,,AUD,,285.10,,,,,,2026';
  const p = parseAirbnbTransactionCsv(file(payout, fastPay)).payouts[0];
  const fees = p.lines.filter(l => l.lineType === 'host_fee');
  assert.strictEqual(fees.reduce((a, l) => a + Math.round(l.amount * 100), 0), -1490, 'service 9.90 + fast pay 5.00');
  assert.ok(!p._unallocatedCents, 'fast pay must not become an unallocated difference');
});

test('one deposit settling several reservations collapses to ONE payout', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const payout = '05/10/2026,,Payout,,,,,,,,Transfer,,AUD,,290.10,,,,,,2026';
  const r1 = '05/09/2026,,Reservation,HMA,05/01/2026,05/01/2026,05/02/2026,1,A,Listing,,,AUD,120.00,,0.00,,0.00,120.00,0.00,2026';
  const r2 = '05/09/2026,,Reservation,HMB,05/02/2026,05/02/2026,05/03/2026,1,B,Listing,,,AUD,170.10,,0.00,,0.00,170.10,0.00,2026';
  const out = parseAirbnbTransactionCsv(file(payout, r1, r2));
  assert.strictEqual(out.payouts.length, 1, 'two reservations, ONE bank deposit');
  assert.strictEqual(out.payouts[0].totalNet, 290.10);
  const sum = out.payouts[0].lines.reduce((a, l) => a + Math.round(l.amount * 100), 0);
  assert.strictEqual(sum, 29010, 'integer cents: 120.00 + 170.10 with no float drift');
});

test('a shortfall becomes ONE flagged balancing line, not a wrong net', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const payout = '06/10/2026,,Payout,,,,,,,,Transfer,,AUD,,290.10,,,,,,2026';
  const r1 = '06/09/2026,,Reservation,HMC,06/01/2026,06/01/2026,06/02/2026,1,A,Listing,,,AUD,250.00,,0.00,,0.00,250.00,0.00,2026';
  const p = parseAirbnbTransactionCsv(file(payout, r1)).payouts[0];
  const adj = p.lines.filter(l => l.lineType === 'adjustment');
  assert.strictEqual(adj.length, 1);
  assert.strictEqual(adj[0].amount, 40.10);
  assert.strictEqual(p._unallocatedCents, 4010, 'flagged so the variance warning still fires');
  const sum = p.lines.reduce((a, l) => a + Math.round(l.amount * 100), 0);
  assert.strictEqual(sum, 29010, 'net must equal the real deposit');
});

test('accrued rows above the newest payout are counted, never turned into deposits', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const future = '08/01/2026,,Reservation,HMFUT,07/01/2026,09/01/2026,09/03/2026,2,Future,Listing,,,AUD,500.00,,0.00,,0.00,500.00,0.00,2026';
  const out = parseAirbnbTransactionCsv(file(future, REAL_PAYOUT, REAL_RESERVATION));
  assert.strictEqual(out.payouts.length, 1, 'the unsettled stay must NOT invent a deposit');
  assert.strictEqual(out.meta.unpaidRows, 1);
});

test('recognised-but-nothing-payable returns an EMPTY array, not null', async () => {
  // null would fall through to the AI, whose prompt pairs each Reservation with
  // its own Payout — fabricating deposits that never reached the bank.
  const { parseAirbnbTransactionCsv } = await load();
  const accrualOnly = '08/01/2026,,Reservation,HMZ,07/01/2026,09/01/2026,09/03/2026,2,Future,Listing,,,AUD,500.00,,0.00,,0.00,500.00,0.00,2026';
  const out = parseAirbnbTransactionCsv(file(accrualOnly));
  assert.ok(out, 'must not return null');
  assert.strictEqual(out.recognised, true);
  assert.strictEqual(out.payouts.length, 0);
  assert.strictEqual(out.meta.unpaidRows, 1);
});

test('a payout row with an unreadable date is refused, not stamped with today', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const badDate = '31/13/2026,,Payout,,,,,,,,Transfer,,AUD,,290.10,,,,,,2026';
  const out = parseAirbnbTransactionCsv(file(badDate, REAL_RESERVATION));
  assert.strictEqual(out.payouts.length, 0, 'never emit a payout that will be dated today');
  assert.ok(out.meta.skipped.some(s => /unreadable date/.test(s.reason)));
});

test('a $0.00 transfer row does not create a payout', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const zero = '07/01/2026,,Payout,,,,,,,,Transfer,,AUD,,0.00,,,,,,2026';
  const out = parseAirbnbTransactionCsv(file(REAL_PAYOUT, REAL_RESERVATION, zero));
  assert.strictEqual(out.payouts.length, 1);
  assert.strictEqual(out.meta.zeroPayoutRows, 1);
});

test('two genuine same-date same-net payouts both survive dedupe', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const pay = '05/10/2026,,Payout,,,,,,,,Transfer,,AUD,,290.10,,,,,,2026';
  const r = '05/09/2026,,Reservation,HMD,05/01/2026,05/01/2026,05/02/2026,1,A,Listing,,,AUD,290.10,,0.00,,0.00,290.10,0.00,2026';
  const out = parseAirbnbTransactionCsv(file(pay, r, pay, r));
  assert.strictEqual(out.payouts.length, 2);
  assert.ok(!out.payouts[0].allowDuplicate);
  assert.strictEqual(out.payouts[1].allowDuplicate, true, 'or the second is silently swallowed');
});

test('resolution and cancellation rows attach as lines, not as new payouts', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const pay = '06/10/2026,,Payout,,,,,,,,Transfer,,AUD,,350.00,,,,,,2026';
  const res = '06/09/2026,,Reservation,HME,06/01/2026,06/01/2026,06/02/2026,1,A,Listing,,,AUD,300.00,,0.00,,0.00,300.00,0.00,2026';
  const resolution = '06/09/2026,,Resolution Adjustment,,,,,,,,Damage claim,,AUD,50.00,,,,,,,2026';
  const out = parseAirbnbTransactionCsv(file(pay, res, resolution));
  assert.strictEqual(out.payouts.length, 1);
  assert.ok(out.payouts[0].lines.some(l => l.lineType === 'resolution' && l.amount === 50.00));
});

test('negative amounts keep their sign', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const pay = '06/10/2026,,Payout,,,,,,,,Transfer,,AUD,,150.00,,,,,,2026';
  const refund = '06/09/2026,,Reservation,HMF,06/01/2026,06/01/2026,06/02/2026,1,A,Listing,,,AUD,-150.00,,0.00,,0.00,-150.00,0.00,2026';
  const res = '06/09/2026,,Reservation,HMG,06/01/2026,06/01/2026,06/02/2026,1,B,Listing,,,AUD,300.00,,0.00,,0.00,300.00,0.00,2026';
  const p = parseAirbnbTransactionCsv(file(pay, refund, res)).payouts[0];
  assert.ok(p.lines.some(l => l.amount === -150.00), 'must not be abs()ed');
});

test('every emitted lineType is one downstream understands', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const allowed = new Set(['accommodation', 'cleaning_fee', 'host_fee', 'adjustment', 'cancellation', 'resolution', 'tax', 'other']);
  const pay = '06/10/2026,,Payout,,,,,,,,Transfer,,AUD,,350.00,,,,,,2026';
  const rows = [
    // Amount is gross minus the service fee — an internally consistent row, or
    // the column cross-check rightly refuses the file.
    '06/09/2026,,Reservation,HMH,06/01/2026,06/01/2026,06/02/2026,1,A,L,,,AUD,290.10,,9.90,,50.00,300.00,0.00,2026',
    '06/09/2026,,Pass Through Tax,,,,,,,,Tax,,AUD,-10.00,,,,,,,2026',
    '06/09/2026,,Cancellation fee,,,,,,,,Cancel,,AUD,20.00,,,,,,,2026',
  ];
  const p = parseAirbnbTransactionCsv(file(pay, ...rows)).payouts[0];
  for (const l of p.lines) assert.ok(allowed.has(l.lineType), `bad lineType: ${l.lineType}`);
});

test('confirmation codes only ride lines the review screen can unlink', async () => {
  // finance-payout-paste.js renders a booking picker for 4 lineTypes only; a
  // code on any other line auto-links at save with no way to undo it.
  const { parseAirbnbTransactionCsv } = await load();
  const pickable = new Set(['accommodation', 'cleaning_fee', 'cancellation', 'resolution']);
  const p = parseAirbnbTransactionCsv(file(REAL_PAYOUT, REAL_RESERVATION)).payouts[0];
  for (const l of p.lines) {
    if (l.confirmationCode) assert.ok(pickable.has(l.lineType), `${l.lineType} must not carry a code`);
  }
});

test('every record is accounted for — nothing is silently dropped', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const out = parseAirbnbTransactionCsv(file(REAL_PAYOUT, REAL_RESERVATION, REAL_RESERVATION));
  const m = out.meta;
  const tallied = m.headerRows + m.payoutRows + m.itemRows + m.unpaidRows + m.zeroPayoutRows + m.skipped.length;
  assert.strictEqual(tallied, m.totalRecords, 'a leaked row is a row the host never sees');
});

// ---- tokenizer + primitives -------------------------------------------------

test('CSV tokenizer: quoted commas, escaped quotes, embedded newlines, CRLF', async () => {
  const { parseCsvRecords } = await load();
  assert.strictEqual(parseCsvRecords('a,"Glenhaven, Katoomba",c')[0][1], 'Glenhaven, Katoomba');
  assert.strictEqual(parseCsvRecords('a,"He said ""hi""",c')[0][1], 'He said "hi"', 'both existing repo splitters fail this');
  assert.strictEqual(parseCsvRecords('a,"line1\nline2",c').length, 1, 'newline inside quotes is not a row break');
  assert.deepStrictEqual(parseCsvRecords('a,b\r\nc,d'), [['a', 'b'], ['c', 'd']]);
  assert.strictEqual(parseCsvRecords('\uFEFFDate,Type')[0][0], 'Date', 'BOM stripped');
});

test('_parseUsDateToIso: month-first, and rejects rather than emitting nonsense', async () => {
  const { _parseUsDateToIso } = await load();
  assert.strictEqual(_parseUsDateToIso('02/14/2026'), '2026-02-14');
  assert.strictEqual(_parseUsDateToIso('12/25/2026'), '2026-12-25');
  assert.strictEqual(_parseUsDateToIso('01/02/2026'), '2026-01-02', 'ambiguous reads as 2 Jan');
  assert.strictEqual(_parseUsDateToIso('13/01/2026'), null, 'month 13 must be refused');
  assert.strictEqual(_parseUsDateToIso(''), null);
});

test('_parseMoneyCents: blank is not zero, and separators parse', async () => {
  const { _parseMoneyCents } = await load();
  assert.strictEqual(_parseMoneyCents(''), null, 'blank means the column does not apply');
  assert.strictEqual(_parseMoneyCents('0.00'), 0, 'a real zero');
  assert.strictEqual(_parseMoneyCents('1,234.56'), 123456);
  assert.strictEqual(_parseMoneyCents('$1,234.56'), 123456);
  assert.strictEqual(_parseMoneyCents('(50.00)'), -5000, 'accounting negative');
  assert.strictEqual(_parseMoneyCents('-150.00'), -15000);
  assert.strictEqual(_parseMoneyCents('290.10 (AUD)'), 29010);
  assert.strictEqual(_parseMoneyCents('n/a'), null);
});

// ---- rejection: half-parsing is worse than the AI fallback -------------------

test('non-Airbnb input returns null so the AI fallback still runs', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const bank = 'Date,Description,Debit,Credit,Balance\n05/01/2026,EFTPOS WOOLWORTHS,45.20,,1000.00';
  assert.strictEqual(parseAirbnbTransactionCsv(bank), null);
  assert.strictEqual(parseAirbnbTransactionCsv('Please find attached my statement for June.'), null);
  assert.strictEqual(parseAirbnbTransactionCsv(''), null);
});

test('a day-first file is refused rather than parsed into wrong dates', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  // 06/01, 07/01, 08/01 all look like valid months, but end - start never
  // matches Nights, which is the tell.
  const rows = [1, 2, 3].map(i =>
    `0${i + 5}/01/2026,,Reservation,HM${i},01/01/2026,0${i + 5}/01/2026,0${i + 5}/03/2026,5,G,L,,,AUD,100.00,,0.00,,0.00,100.00,0.00,2026`);
  const pay = '09/01/2026,,Payout,,,,,,,,Transfer,,AUD,,300.00,,,,,,2026';
  assert.strictEqual(parseAirbnbTransactionCsv(file(pay, ...rows)), null);
});

test('headerless export parses via the positional fallback', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const out = parseAirbnbTransactionCsv([REAL_PAYOUT, REAL_RESERVATION].join('\n'));
  assert.ok(out, 'the Completed Payouts variant omits the header row');
  assert.strictEqual(out.payouts.length, 1);
  assert.strictEqual(out.payouts[0].totalNet, 290.10);
});

test('attach-handler banners and appended exports do not break parsing', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  // The strings finance-payout-paste.js actually injects, plus a second file.
  const text = ['--- transactions.csv ---', '=== Sheet: Sheet1 ===', file(REAL_PAYOUT, REAL_RESERVATION), file(REAL_PAYOUT, REAL_RESERVATION)].join('\n');
  const out = parseAirbnbTransactionCsv(text);
  assert.ok(out);
  assert.strictEqual(out.payouts.length, 2, 'columns re-bind on the second header');
});

test('multi-currency rows never cross-attach', async () => {
  const { parseAirbnbTransactionCsv } = await load();
  const audPay = '05/10/2026,,Payout,,,,,,,,Transfer,,AUD,,100.00,,,,,,2026';
  const audRes = '05/09/2026,,Reservation,HMA,05/01/2026,05/01/2026,05/02/2026,1,A,L,,,AUD,100.00,,0.00,,0.00,100.00,0.00,2026';
  const usdPay = '05/12/2026,,Payout,,,,,,,,Transfer,,USD,,200.00,,,,,,2026';
  const usdRes = '05/11/2026,,Reservation,HMB,05/01/2026,05/01/2026,05/02/2026,1,B,L,,,USD,200.00,,0.00,,0.00,200.00,0.00,2026';
  const out = parseAirbnbTransactionCsv(file(audPay, audRes, usdPay, usdRes));
  assert.strictEqual(out.payouts.length, 2);
  assert.strictEqual(out.payouts[0].currency, 'AUD');
  assert.strictEqual(out.payouts[1].currency, 'USD');
  assert.strictEqual(out.payouts[1].totalNet, 200.00, 'never summed across currencies');
});

test('the module imports with no window defined', async () => {
  // Tripwire: keeps airbnb-csv.js free of config.js-tainted imports, which
  // throw at module scope outside a browser.
  assert.strictEqual(typeof globalThis.window, 'undefined');
  const mod = await load();
  assert.strictEqual(typeof mod.parseAirbnbTransactionCsv, 'function');
});

test('a rejection always carries a reason the UI can show', async () => {
  // Falling through to the AI in silence costs ten seconds and returns an
  // unexplained 504 — the host is left with nothing to act on.
  const { parseAirbnbTransactionCsv, lastAirbnbCsvRejection, describeAirbnbCsvRejection, looksTabular } = await load();

  assert.strictEqual(parseAirbnbTransactionCsv('Please see attached.'), null);
  assert.ok(lastAirbnbCsvRejection(), 'a reason must be recorded');
  assert.ok(describeAirbnbCsvRejection().length > 10, 'and be human-readable');

  // A bank CSV has neither the headings nor the 21-column shape.
  const bank = 'Date,Description,Debit,Credit,Balance\n' + Array.from({ length: 8 },
    (_, i) => `0${i + 1}/01/2026,EFTPOS SHOP,45.20,,1000.00`).join('\n');
  assert.strictEqual(parseAirbnbTransactionCsv(bank), null);
  assert.strictEqual(lastAirbnbCsvRejection(), 'no_header');

  // Right headings, wrong vocabulary in the Type column.
  const wrongTypes = file(...Array.from({ length: 6 },
    (_, i) => `0${i + 1}/01/2026,,Groceries,,,,,,,,Shop,,AUD,45.20,,,,,,,2026`));
  assert.strictEqual(parseAirbnbTransactionCsv(wrongTypes), null);
  assert.strictEqual(lastAirbnbCsvRejection(), 'no_airbnb_row_types');

  // A successful parse must clear the previous reason.
  assert.ok(parseAirbnbTransactionCsv(file(REAL_PAYOUT, REAL_RESERVATION)));
  assert.strictEqual(lastAirbnbCsvRejection(), null);

  assert.strictEqual(looksTabular(bank), true, 'a CSV is tabular');
  assert.strictEqual(looksTabular('Please see attached.'), false, 'prose is not');
});

// Row where Amount + fees === Gross earnings (self-consistent).
const okRow = (d, code, gross) => {
  const g = gross.toFixed(2);
  const amt = (gross - 9.90).toFixed(2);
  return `${d}/2026,,Reservation,${code},01/01/2026,${d}/2026,${d}/2026,0,G,Listing,,,AUD,${amt},,9.90,,0.00,${g},0.00,2026`;
};
// Same row but Gross earnings deliberately inconsistent.
const oddRow = (d, code) =>
  `${d}/2026,,Reservation,${code},01/01/2026,${d}/2026,${d}/2026,0,G,Listing,,,AUD,290.10,,9.90,,0.00,777.77,0.00,2026`;

test('a few inconsistent rows do NOT throw away a parseable year', async () => {
  // Pass-through taxes, part refunds and resolution credits all legitimately
  // break the Amount+fees===Gross identity on individual rows. Rejecting the
  // whole file over one of them sent a good export to the AI, which then 504'd.
  const { parseAirbnbTransactionCsv } = await load();
  const pay = '05/20/2026,,Payout,,,,,,,,Transfer,,AUD,,2000.00,,,,,,2026';
  const rows = [
    okRow('05/01', 'HM1', 300), okRow('05/02', 'HM2', 400),
    okRow('05/03', 'HM3', 500), okRow('05/04', 'HM4', 600),
    oddRow('05/05', 'HM5'), oddRow('05/06', 'HM6'),
  ];
  const out = parseAirbnbTransactionCsv(file(pay, ...rows));
  assert.ok(out, 'a mostly-consistent file must still parse');
  assert.strictEqual(out.payouts.length, 1);
});

test('a wholesale-mis-bound file is refused, and says which numbers disagreed', async () => {
  const { parseAirbnbTransactionCsv, lastAirbnbCsvRejection, describeAirbnbCsvRejection } = await load();
  const pay = '05/20/2026,,Payout,,,,,,,,Transfer,,AUD,,2000.00,,,,,,2026';
  const rows = ['05/01', '05/02', '05/03', '05/04'].map((d, i) => oddRow(d, 'HM' + i));
  assert.strictEqual(parseAirbnbTransactionCsv(file(pay, ...rows)), null);
  assert.strictEqual(lastAirbnbCsvRejection(), 'money_columns_disagree');
  const msg = describeAirbnbCsvRejection();
  assert.match(msg, /777\.77/, 'the message must name the actual figures');
  assert.match(msg, /300\.00/);
});

test('source is a value the database actually allows', async () => {
  // platform_payouts_source_check permits only manual/paste_ai/csv/email/api.
  // An invented value passes every test and fails every insert at runtime.
  const { parseAirbnbTransactionCsv } = await load();
  const out = parseAirbnbTransactionCsv(file(REAL_PAYOUT, REAL_RESERVATION));
  assert.ok(['manual', 'paste_ai', 'csv', 'email', 'api'].includes(out.source), `bad source: ${out.source}`);
});

test('reservation lines carry guest and check-in so a codeless booking can match', async () => {
  // 7 of 60 bookings came from the original spreadsheet import with no
  // confirmation code, so code-only matching could never link their payouts.
  const { parseAirbnbTransactionCsv } = await load();
  const p = parseAirbnbTransactionCsv(file(REAL_PAYOUT, REAL_RESERVATION)).payouts[0];
  const accom = p.lines.find(l => l.lineType === 'accommodation');
  assert.strictEqual(accom.guestName, 'Daniel Wilson');
  assert.strictEqual(accom.checkin, '2026-02-14', 'the stay start, ISO, from the Start date column');
});
