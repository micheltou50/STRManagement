/**
 * StayOps — deterministic parser for Airbnb host transaction-history CSV exports.
 *
 * WHY THIS EXISTS
 * Pasting a full financial year of Airbnb transactions returned HTTP 504. Two
 * independent walls, either of which is fatal on its own:
 *   1. Netlify kills a synchronous function at 10s. A model reading hundreds of
 *      rows and emitting a payout object for each cannot finish in that budget.
 *   2. The caller asks for max_tokens 4000 — roughly 25 reservations of output.
 *      Beyond that the reply is truncated and dies at JSON.parse instead.
 * Raising one limit just moves the failure. But an Airbnb export is STRUCTURED:
 * fixed columns, known types. Parsing it here is instant, free, exact, works
 * offline, and structurally cannot time out or truncate. The AI path stays for
 * PDFs, screenshots and unstructured pastes, where there is nothing to exploit.
 *
 * CONTRACT
 * parseAirbnbTransactionCsv() returns the SAME {payouts:[{...,lines:[...]}]}
 * shape the AI path produces, so every downstream consumer — the review screen,
 * savePayoutFromPasteModal, booking matching — is untouched.
 *
 * THREE OUTCOMES, NOT TWO. `null` means "not an Airbnb export, fall through to
 * AI". A recognised file with zero completed payouts returns recognised:true
 * with an EMPTY payouts array and must NOT fall through: the AI prompt says
 * "each Reservation is usually paired with its own Payout", so handing it a file
 * of accrued-but-unsettled stays makes it invent deposits that never reached the
 * bank. The case where this parser is most certain is the one where the model is
 * most dangerous.
 *
 * Integer CENTS throughout; 300.00 - 9.90 in floats is not 290.10. Divide by 100
 * only at emit.
 *
 * Pure: no window/document/globalThis, and zero imports, so tests import it in
 * bare Node. (bank-import.js and friends transitively pull config.js, which
 * touches window at module scope and throws outside a browser.)
 */

/** Column layout of the 21-field export, used when no header row is present
 *  (the "Completed Payouts" variant omits it). Verified against a real row:
 *  02/15/2026,,Reservation,HMCKAN8JN8,02/14/2026,02/14/2026,02/15/2026,1,
 *  Daniel Wilson,Glenhaven...,,,AUD,290.10,,9.90,,0.00,300.00,0.00,2026 */
const POSITIONAL = {
  date: 0, arriving: 1, type: 2, confirmation: 3, bookingDate: 4,
  startDate: 5, endDate: 6, nights: 7, guest: 8, listing: 9,
  details: 10, reference: 11, currency: 12, amount: 13, paidOut: 14,
  serviceFee: 15, fastPayFee: 16, cleaningFee: 17, grossEarnings: 18,
  occupancyTaxes: 19, year: 20,
};

/** Ordered so the more specific pattern wins: "Cleaning fee" must not be
 *  claimed by /fee/, and "Gross earnings" must not be claimed by /earnings/. */
const HEADER_PATTERNS = [
  ['paidOut', /^paid\s*out$/],
  ['grossEarnings', /gross/],
  ['serviceFee', /service\s*fee/],
  ['fastPayFee', /fast\s*pay/],
  ['cleaningFee', /clean/],
  ['occupancyTaxes', /occupancy|tax/],
  ['confirmation', /confirmation/],
  ['arriving', /arriv/],
  ['startDate', /start\s*date/],
  ['endDate', /end\s*date/],
  ['bookingDate', /booking\s*date/],
  ['currency', /currency/],
  ['listing', /listing/],
  ['nights', /night/],
  ['guest', /guest/],
  ['amount', /^amount$/],
  ['type', /^type$/],
  ['date', /^date$/],
];

/** The only lineType strings downstream understands. Anything else silently
 *  lands in the `adjustments` bucket at finance-payout-paste.js:485 — net stays
 *  right while gross/platformFee/adjustments are quietly mis-split. */
const LINE_TYPES = new Set([
  'accommodation', 'cleaning_fee', 'host_fee', 'adjustment',
  'cancellation', 'resolution', 'tax', 'other',
]);

/** The review screen only renders a booking picker for these (see
 *  finance-payout-paste.js:394). Attaching a confirmationCode to any other
 *  lineType auto-links it to a booking at save time with no UI to unlink it. */
const PICKABLE = new Set(['accommodation', 'cleaning_fee', 'cancellation', 'resolution']);

/**
 * Why the last parse gave up. Falling through to the AI in silence means a
 * mis-recognised file costs the host ten seconds and an unexplained 504, with
 * nothing to act on — the exact "no way of finding out" complaint this whole
 * screen exists to answer.
 */
let _lastRejection = null;
let _lastRejectionDetail = null;
export function lastAirbnbCsvRejection() { return _lastRejection; }

const REJECTION_TEXT = {
  empty: 'the file appears to be empty',
  no_header: 'no recognisable column headings, and the rows are not the 21-column layout',
  no_airbnb_row_types: 'no Payout or Reservation rows found in the Type column',
  money_or_date_column_unresolved: 'the Amount, Paid out or Date column could not be identified',
  money_columns_disagree: 'the money columns did not add up as expected, so the layout is probably different',
  dates_not_month_first: 'the dates are not in Airbnb’s month-first format',
};

/** Human-readable form of lastAirbnbCsvRejection(), for UI copy. Includes the
 *  concrete numbers where there are any — "the layout is probably different"
 *  is not something a host can act on, but a named row with two figures is. */
export function describeAirbnbCsvRejection() {
  const base = REJECTION_TEXT[_lastRejection] || 'the layout was not recognised';
  return _lastRejectionDetail ? `${base} (${_lastRejectionDetail})` : base;
}

function _reject(reason, detail) {
  _lastRejection = reason;
  _lastRejectionDetail = detail || null;
  return null;
}

/** Cheap "is this a spreadsheet export?" test, used to tell a wrong-layout CSV
 *  apart from genuinely unstructured prose. */
export function looksTabular(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 5) return false;
  // 3 commas, not 5: a 5-column bank export has only 4 per line, and it is just
  // as much a spreadsheet as a 21-column Airbnb one. Prose rarely reaches 3.
  const commaHeavy = lines.filter(l => (l.match(/,/g) || []).length >= 3).length;
  return commaHeavy >= Math.min(5, Math.floor(lines.length * 0.5));
}

/**
 * RFC-4180 tokenizer over the WHOLE text, not line by line: listing titles and
 * bank Details strings are free text and legitimately contain commas, quotes
 * and newlines. Both existing splitters in this repo mishandle a doubled quote.
 * @returns {string[][]}
 */
export function parseCsvRecords(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, ''); // Excel round-trip BOM
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;   // this field was quoted → do not trim its content
  let inQuotes = false;

  // Trim only unquoted fields: '"  Glenhaven, Katoomba "' keeps its spacing.
  const endField = () => { row.push(quoted ? field : field.trim()); field = ''; quoted = false; };
  const endRow = () => { endField(); records.push(row); row = []; };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; quoted = true; i += 1; continue; }
    if (ch === ',') { endField(); i += 1; continue; }
    if (ch === '\r' || ch === '\n') {
      endRow();
      i += (ch === '\r' && src[i + 1] === '\n') ? 2 : 1;
      continue;
    }
    field += ch; i += 1;
  }
  if (field !== '' || quoted || row.length) endRow();

  // Drop blank lines and the '--- file.csv ---' / '=== Sheet: x ===' banners the
  // attach handler injects (finance-payout-paste.js:103,153) — single-cell rows.
  return records.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

/**
 * Airbnb writes MM/DD/YYYY. The repo's other date parsers are day-first and
 * would turn 02/14/2026 into the invalid 2026-14-02.
 * @returns {string|null} ISO yyyy-mm-dd
 */
export function _parseUsDateToIso(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/); // XLSX sometimes emits ISO
  if (iso) return iso[0];
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) return null;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  const y = Number(m[3]);
  // Reject rather than emit an invalid ISO string: a month > 12 means the file
  // is day-first, and every downstream date comparison would be silently wrong.
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Money → integer cents.
 * Blank and zero are NOT the same: '' means the column does not apply to this
 * row type (a Reservation has no Paid out), '0.00' is a real zero. Returning 0
 * for both makes a missing column indistinguishable from a genuine nil amount.
 * @returns {number|null} cents, or null when absent/unparseable
 */
export function _parseMoneyCents(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let neg = false;
  // Accounting negative — tested on the original, before any stripping, so it
  // is not confused with a trailing annotation like "290.10 (AUD)".
  if (/^\(\s*[\d.,$\s]+\s*\)$/.test(s)) { neg = true; s = s.replace(/[()]/g, ''); }
  s = s.replace(/\([^)]*\)/g, '');    // drop '(AUD)'-style annotations
  s = s.replace(/[A-Za-z$\s,]/g, ''); // currency codes, symbols, separators
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (s === '' || s === '.' || !/^\d*\.?\d*$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  if (!Number.isFinite(cents)) return null;
  return neg ? -cents : cents;
}

/** A record is a header when it names both a Type and a Paid out column.
 *  @returns {object|null} name → column index */
export function _resolveColumns(cells) {
  if (!Array.isArray(cells) || cells.length < 8) return null;
  const norm = cells.map(c => String(c ?? '').replace(/^\uFEFF/, '').trim().toLowerCase());
  const map = {};
  norm.forEach((label, idx) => {
    if (!label) return;
    for (const [key, re] of HEADER_PATTERNS) {
      if (map[key] === undefined && re.test(label)) { map[key] = idx; return; }
    }
  });
  if (map.type === undefined || map.paidOut === undefined) return null;
  return map;
}

function _cell(row, cols, key) {
  const idx = cols[key];
  if (idx === undefined || idx < 0 || idx >= row.length) return '';
  return row[idx] ?? '';
}

function _lineTypeFor(typeStr) {
  const t = String(typeStr || '').toLowerCase();
  if (/resolution/.test(t)) return 'resolution';
  if (/cancel/.test(t)) return 'cancellation';
  if (/tax/.test(t)) return 'tax';
  if (/adjust/.test(t)) return 'adjustment';
  if (/reservation/.test(t)) return 'accommodation';
  return 'other';
}

function _isPayoutRow(typeStr) {
  return /^(payout|transfer)/i.test(String(typeStr || '').trim());
}

/**
 * Decompose a Reservation row into line items.
 *
 * Anchored on the Amount column, NOT on Gross earnings. Gross is blank in some
 * export variants, and `_parseMoneyCents('')` is null — `null - 15000` evaluates
 * to -15000 in JS rather than throwing, so a gross-anchored formula emits a
 * confidently wrong negative line and sweeps the reservation's real value into
 * the balancing adjustment. Amount is the row's actual contribution to the
 * deposit, so anchoring there makes the lines sum to it by construction.
 *
 *   accommodation = amount + serviceFee + fastPayFee - cleaningFee
 *   cleaning_fee  = +cleaningFee                    (only when non-zero)
 *   host_fee      = -(serviceFee + fastPayFee)      (only when non-zero)
 *   sum           = amount                          ✓ always
 */
function _reservationLines(row, cols) {
  const amountCents = _parseMoneyCents(_cell(row, cols, 'amount'));
  if (amountCents === null) return null;
  const serviceCents = _parseMoneyCents(_cell(row, cols, 'serviceFee')) ?? 0;
  const fastPayCents = _parseMoneyCents(_cell(row, cols, 'fastPayFee')) ?? 0;
  const cleaningCents = _parseMoneyCents(_cell(row, cols, 'cleaningFee')) ?? 0;

  const feeCents = serviceCents + fastPayCents;
  const accomCents = amountCents + feeCents - cleaningCents;

  const guest = String(_cell(row, cols, 'guest') || '').trim();
  const nights = String(_cell(row, cols, 'nights') || '').trim();
  const code = String(_cell(row, cols, 'confirmation') || '').trim() || null;
  const who = guest || String(_cell(row, cols, 'listing') || '').trim() || 'Reservation';
  const desc = nights ? `${who} · ${nights} night${nights === '1' ? '' : 's'}` : who;

  const lines = [{ lineType: 'accommodation', description: desc, amount: accomCents / 100, confirmationCode: code }];
  if (cleaningCents !== 0) {
    lines.push({ lineType: 'cleaning_fee', description: 'Cleaning fee', amount: cleaningCents / 100, confirmationCode: code });
  }
  if (feeCents !== 0) {
    // Fees are written positive in the file and MUST be emitted negative, or
    // both net and platform_fee are inflated with nothing validating it.
    // No confirmationCode: the review screen has no picker for host_fee, so a
    // code here would auto-link to a booking with no way to undo it.
    lines.push({ lineType: 'host_fee', description: 'Airbnb host service fee', amount: -feeCents / 100, confirmationCode: null });
  }
  return { lines, amountCents };
}

/** Any non-Reservation, non-Payout row: one line, sign preserved, attached to
 *  the enclosing payout rather than creating one of its own. */
function _otherLine(row, cols, typeStr) {
  const amountCents = _parseMoneyCents(_cell(row, cols, 'amount'));
  if (amountCents === null) return null;
  const lineType = _lineTypeFor(typeStr);
  const code = String(_cell(row, cols, 'confirmation') || '').trim() || null;
  const detail = String(_cell(row, cols, 'details') || '').trim();
  return {
    lines: [{
      lineType: LINE_TYPES.has(lineType) ? lineType : 'other',
      description: detail || String(typeStr || 'Adjustment').trim(),
      amount: amountCents / 100,
      confirmationCode: PICKABLE.has(lineType) ? code : null,
    }],
    amountCents,
  };
}

/**
 * Cross-check the column binding before trusting a whole financial year to it.
 *
 * A header that resolves Type and Paid out but binds the WRONG money column
 * still passes a shape check — and then emits an entire FY of confident $0.00
 * payouts, masked by the balancing line. So verify against an identity the file
 * already carries: for reservation rows that publish Gross earnings, the
 * accommodation figure derived from Amount must equal it.
 *
 * Also validates date order using the nights identity (end - start === nights),
 * which detects a day-first file in one line even when every date is ambiguous.
 * @returns {string|null} failure reason, or null when the binding is sound
 */
function _crossCheck(rows, cols) {
  if (cols.amount === undefined || cols.paidOut === undefined || cols.date === undefined) {
    return 'money_or_date_column_unresolved';
  }
  let agreed = 0;
  let disagreed = 0;
  let firstMismatch = null;
  let nightsChecked = 0;
  let nightsAgree = 0;

  for (const row of rows) {
    if (agreed + disagreed >= 8 && nightsChecked >= 3) break;
    const type = _cell(row, cols, 'type');
    if (_isPayoutRow(type) || !/reservation/i.test(String(type))) continue;

    if (agreed + disagreed < 8) {
      const grossCents = _parseMoneyCents(_cell(row, cols, 'grossEarnings'));
      const built = _reservationLines(row, cols);
      if (grossCents !== null && built) {
        const accom = built.lines.find(l => l.lineType === 'accommodation');
        const cleaning = built.lines.find(l => l.lineType === 'cleaning_fee');
        // Gross covers accommodation + cleaning; both are itemised subsets.
        const derived = Math.round((accom ? accom.amount : 0) * 100)
          + Math.round((cleaning ? cleaning.amount : 0) * 100);
        if (Math.abs(derived - grossCents) <= 1) {
          agreed += 1;
        } else {
          disagreed += 1;
          if (!firstMismatch) {
            firstMismatch = `row dated ${_cell(row, cols, 'date') || '?'}: Amount ${_cell(row, cols, 'amount') || '(blank)'}`
              + ` plus fees ${_cell(row, cols, 'serviceFee') || '0'}/${_cell(row, cols, 'fastPayFee') || '0'}`
              + ` gives ${(derived / 100).toFixed(2)}, but Gross earnings reads ${(grossCents / 100).toFixed(2)}`;
          }
        }
      }
    }

    if (nightsChecked < 3) {
      const start = _parseUsDateToIso(_cell(row, cols, 'startDate'));
      const end = _parseUsDateToIso(_cell(row, cols, 'endDate'));
      const nights = Number(String(_cell(row, cols, 'nights') || '').trim());
      if (start && end && Number.isFinite(nights) && nights > 0) {
        nightsChecked += 1;
        const spanned = Math.round((new Date(end + 'T00:00:00Z') - new Date(start + 'T00:00:00Z')) / 86400000);
        if (spanned === nights) nightsAgree += 1;
      }
    }
  }

  // Reject only on WHOLESALE disagreement. Failing on the first mismatching row
  // was far too strict: pass-through occupancy taxes, part refunds and resolution
  // credits all legitimately break the Amount-plus-fees-equals-Gross identity on
  // individual rows, and rejecting the file over one of them threw away a
  // perfectly parseable year. A genuinely mis-bound column fails EVERY row, which
  // is what this now tests. Residual per-row error is caught downstream by the
  // balancing line and its variance warning, in front of the host, before saving.
  if (agreed === 0 && disagreed >= 3) {
    return { reason: 'money_columns_disagree', detail: firstMismatch };
  }
  // Every checkable row disagreeing means the dates are not month-first.
  if (nightsChecked >= 3 && nightsAgree === 0) return { reason: 'dates_not_month_first' };
  return null;
}

/**
 * @param {string} text raw CSV (or Excel converted to CSV) pasted by the host
 * @returns {{source:string, recognised:boolean, payouts:Array, meta:object}|null}
 *   null → not an Airbnb transaction export; caller should fall back to AI.
 */
export function parseAirbnbTransactionCsv(text) {
  const records = parseCsvRecords(text);
  if (!records.length) return _reject('empty');

  const meta = {
    totalRecords: records.length,
    headerRows: 0,
    payoutRows: 0,
    itemRows: 0,
    unpaidRows: 0,
    zeroPayoutRows: 0,
    skipped: [],
    listings: [],
    currencies: [],
  };

  let cols = null;
  const payouts = [];
  let open = null;              // the payout currently accumulating lines
  const listings = new Set();
  const currencies = new Set();

  const skip = (idx, reason, row) => {
    meta.skipped.push({ index: idx, reason, preview: (row || []).slice(0, 4).join(',').slice(0, 80) });
  };

  // Resolve columns once up front so the cross-check can run against real rows
  // before a single payout is built.
  const headerIdx = records.findIndex(r => _resolveColumns(r) !== null);
  if (headerIdx >= 0) {
    cols = _resolveColumns(records[headerIdx]);
  } else if (records.some(r => r.length === POSITIONAL.year + 1)) {
    cols = { ...POSITIONAL }; // headerless "Completed Payouts" variant
  }
  if (!cols) return _reject('no_header');

  const bodyRows = records.filter((r, i) => i !== headerIdx && r.length > 4);
  // Must actually look like this export: a Type column carrying Airbnb's own
  // vocabulary. A bank CSV or a Booking.com statement stops here.
  const typedRows = bodyRows.filter(r => {
    const t = String(_cell(r, cols, 'type') || '');
    return _isPayoutRow(t) || /reservation|resolution|adjust|cancel|tax/i.test(t);
  });
  if (!typedRows.length) return _reject('no_airbnb_row_types');

  const failure = _crossCheck(bodyRows, cols);
  if (failure) return _reject(failure.reason, failure.detail); // half-parsing is worse than falling back to AI

  records.forEach((row, idx) => {
    if (idx === headerIdx) { meta.headerRows += 1; return; }
    if (row.length <= 4) { skip(idx, 'too few columns', row); return; }
    // A second header (two exports appended) re-binds the columns.
    const rebind = _resolveColumns(row);
    if (rebind) { cols = rebind; meta.headerRows += 1; return; }

    const type = String(_cell(row, cols, 'type') || '').trim();
    const currency = String(_cell(row, cols, 'currency') || '').trim().toUpperCase() || 'AUD';

    if (_isPayoutRow(type)) {
      const paidOutCents = _parseMoneyCents(_cell(row, cols, 'paidOut'));
      const payoutDate = _parseUsDateToIso(_cell(row, cols, 'date'));
      if (payoutDate === null) {
        // finance-payout-paste.js:501 falls back to today's date for a null,
        // which would file the payout in the wrong year and give it a dedupe
        // key that can never match the real deposit. Refuse the whole file.
        skip(idx, 'payout row has an unreadable date', row);
        open = null;
        meta.payoutRows += 1;
        return;
      }
      if (paidOutCents === null || paidOutCents === 0) {
        // Airbnb emits $0.00 transfer rows; a zero payout can never match a
        // deposit and would pollute the (date, net) dedupe key space.
        meta.zeroPayoutRows += 1;
        open = null;
        return;
      }
      meta.payoutRows += 1;
      open = {
        platform: 'airbnb',
        payoutReference: null,
        payoutDate,
        expectedArrivalDate: _parseUsDateToIso(_cell(row, cols, 'arriving')),
        currency,
        totalNet: paidOutCents / 100,
        lines: [],
        _paidOutCents: paidOutCents,
        _linesCents: 0,
      };
      currencies.add(currency);
      payouts.push(open);
      return;
    }

    // Item row.
    if (!open) {
      // Accrued but not yet settled — sits above the newest Payout row. Turning
      // it into a payout would invent a deposit that never hit the bank.
      meta.unpaidRows += 1;
      return;
    }
    if (currency !== open.currency) {
      skip(idx, `currency ${currency} does not match this payout (${open.currency})`, row);
      return;
    }
    const built = /reservation/i.test(type) ? _reservationLines(row, cols) : _otherLine(row, cols, type);
    if (!built) { skip(idx, 'no readable amount', row); return; }
    meta.itemRows += 1;
    open.lines.push(...built.lines);
    open._linesCents += built.amountCents;
    const listing = String(_cell(row, cols, 'listing') || '').trim();
    if (listing) listings.add(listing);
  });

  // Balance every payout to the real deposit, and FLAG it. net_amount is what
  // bank reconciliation matches on, so it must equal Paid out — but forcing
  // lines to sum exactly would make the review screen's variance warning
  // (finance-payout-paste.js:387) mathematically unreachable. The flag is what
  // keeps the mismatch visible.
  for (const p of payouts) {
    const diff = p._paidOutCents - p._linesCents;
    if (diff !== 0) {
      p.lines.push({
        lineType: 'adjustment',
        description: 'Unallocated difference — check this against the statement',
        amount: diff / 100,
        confirmationCode: null,
      });
      p._unallocatedCents = diff;
    }
    delete p._linesCents;
    delete p._paidOutCents;
  }

  meta.listings = Array.from(listings);
  meta.currencies = Array.from(currencies);

  // Two legitimate payouts sharing a date and net exist (a single-listing host
  // across 30+ deposits). findExistingPayout keys on (platform, date, net±0.01),
  // so the second would match the first just inserted and be silently dropped
  // together with its lines. Mark it as a known-good repeat.
  const seenKey = new Set();
  for (const p of payouts) {
    const key = `${p.payoutDate}|${p.totalNet.toFixed(2)}|${p.currency}`;
    if (seenKey.has(key)) p.allowDuplicate = true;
    seenKey.add(key);
  }

  _lastRejection = null;
  _lastRejectionDetail = null;
  // 'csv' — NOT a new value. platform_payouts_source_check already allows
  // exactly ('manual','paste_ai','csv','email','api'); inventing 'paste_csv'
  // made every insert fail the constraint.
  return { source: 'csv', recognised: true, payouts, meta };
}
