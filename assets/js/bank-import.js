/**
 * StayOps — bank statement import: parse (CSV in-browser, PDF/photo via
 * Claude vision) and de-duplicate against what is already in. Deciding what
 * each line IS moved to bank-explain.js; saving moved to supabase-bank-lines.js.
 */
import { localDateStr } from './utils.js';

function getSb() {
  return typeof window !== 'undefined' ? window._sb || null : null;
}

// Why the last parse produced nothing. Every bail below used to be a bare
// console.log + `return []`, so "empty file", "couldn't find the columns" and
// "the AI call was rejected" were indistinguishable to the host — the import
// just quietly did nothing. Mirrors the _lastReceiptUploadError pattern the
// receipt uploader uses to surface its real error in the banner.
let _lastBankImportError = '';
function _setBankImportError(msg) { _lastBankImportError = String(msg || ''); }

/** Read a JSON body without throwing. A non-OK ai-proxy reply often carries an
 *  EMPTY or non-JSON body — a 405 from a static dev server, a gateway error
 *  page, a proxy timeout. A bare `await res.json()` then throws "Unexpected end
 *  of JSON input", and because the categorise call did that BEFORE testing
 *  res.ok, one failed AI call aborted the entire import instead of degrading to
 *  rule-based categorisation. */
async function _safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

/** Report analysing-phase progress to the UI, if a UI is listening.
 *  Routed through globalThis so this parsing module keeps no UI imports, and
 *  so it is a harmless no-op when the importer runs headless or in tests. */
function _importProgress(step, detail) {
  try {
    if (typeof globalThis._bankImportProgress === 'function') globalThis._bankImportProgress(step, detail);
  } catch (_) { /* progress is cosmetic — never let it break an import */ }
}
/** Clear before a parse; read after one returns [] to explain why. */
export function resetBankImportError() { _lastBankImportError = ''; }
export function getBankImportError() { return _lastBankImportError; }


const SUMMARY_REGEX = /^(total|subtotal|opening|closing|balance brought|brought forward|statement period|page \d)/i;

function _detectDelimiter(lines) {
  // Check first few non-empty lines for tab vs comma dominance
  const sample = lines.filter(l => l.trim()).slice(0, 5);
  let tabs = 0, commas = 0;
  for (const line of sample) {
    tabs += (line.match(/\t/g) || []).length;
    commas += (line.match(/,/g) || []).length;
  }
  return tabs > commas ? '\t' : ',';
}

function parseCSVLine(line, delimiter) {
  const delim = delimiter || ',';
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === delim && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

function parseAUDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (slash) {
    let d = parseInt(slash[1], 10);
    let mo = parseInt(slash[2], 10);
    let y = parseInt(slash[3], 10);
    if (y < 100) y += 2000;
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  const tryDate = new Date(s);
  if (!Number.isNaN(tryDate.getTime())) {
    return localDateStr(tryDate);
  }
  return null;
}

function parseAmount(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw)
    .trim()
    .replace(/\$/g, '')
    .replace(/\s/g, '')
    .replace(/^\((.+)\)$/, '-$1'); // accounting negatives
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function findColIndexInHeaders(headers, patterns) {
  const norm = headers.map(normalizeHeader);
  for (const p of patterns) {
    const pl = p.toLowerCase();
    const i = norm.findIndex((h) => h === pl || h.includes(pl));
    if (i >= 0) return i;
  }
  return -1;
}

function parseCellDate(raw, dateFormat) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const df = String(dateFormat || 'DD/MM/YYYY')
    .toUpperCase()
    .replace(/\s+/g, '');
  if (df.includes('YYYY-MM-DD') || df === 'ISO') {
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  }
  if (df.includes('DD/MM') || df.includes('D/M/Y') || df === 'DMY') {
    const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (slash) {
      let d = parseInt(slash[1], 10);
      let mo = parseInt(slash[2], 10);
      let y = parseInt(slash[3], 10);
      if (y < 100) y += 2000;
      return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    }
  }
  return parseAUDate(s);
}

function colIndexOrNull(v, maxCols) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0 || n >= maxCols) return null;
  return n;
}

function normalizeAiMapping(raw, sampleRowCells) {
  const maxCols = Math.max(1, sampleRowCells.length);
  if (!raw || typeof raw !== 'object') return null;
  const date_col = colIndexOrNull(raw.date_col, maxCols);
  const description_col = colIndexOrNull(raw.description_col, maxCols);
  if (date_col == null || description_col == null) return null;
  const amount_format = String(raw.amount_format || 'signed')
    .toLowerCase()
    .includes('separate')
    ? 'separate'
    : 'signed';
  let date_format = String(raw.date_format || 'DD/MM/YYYY');
  const has_header = !!raw.has_header;
  if (amount_format === 'separate') {
    const debit_col = colIndexOrNull(raw.debit_col, maxCols);
    const credit_col = colIndexOrNull(raw.credit_col, maxCols);
    if (debit_col == null && credit_col == null) return null;
    return {
      has_header,
      date_col,
      amount_col: colIndexOrNull(raw.amount_col, maxCols),
      description_col,
      date_format,
      amount_format: 'separate',
      debit_col,
      credit_col,
    };
  }
  const amount_col = colIndexOrNull(raw.amount_col, maxCols);
  if (amount_col == null) return null;
  return {
    has_header,
    date_col,
    amount_col,
    description_col,
    date_format,
    amount_format: 'signed',
    debit_col: null,
    credit_col: null,
  };
}

async function detectCsvFormatWithAi(sampleLines) {
  const system =
    '\
You are a CSV bank statement parser. Look at these sample rows from a bank CSV export and determine the column structure. The file may or may not have a header row.\n\
\n\
Respond ONLY in JSON, no markdown:\n\
{\n\
  "has_header": boolean,\n\
  "date_col": number (0-indexed column containing the date),\n\
  "amount_col": number (column containing the amount),\n\
  "description_col": number (column containing the transaction description),\n\
  "date_format": string ("DD/MM/YYYY" or "YYYY-MM-DD" or other),\n\
  "amount_format": string ("signed" if negative=debit, or "separate" if debit/credit are separate columns),\n\
  "debit_col": number or null (if separate debit column),\n\
  "credit_col": number or null (if separate credit column)\n\
}';
  const userMsg = 'Here are the first rows of the CSV:\n' + sampleLines.join('\n');
  try {
    const res = await (globalThis.authFetch || fetch)('/.netlify/functions/ai-proxy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.content || !data.content[0] || !data.content[0].text) {
      console.log('[StayOps] parseCSV: AI format detection HTTP/error', data.error || res.status);
      // 401 here means the request went out unauthenticated — the call falls
      // back to bare fetch when authFetch isn't assigned yet, which sends no
      // Authorization header and ai-proxy's verifyAuth rejects it. Name it, or
      // the host just sees "no transactions found".
      // Keep the SERVER's own wording. ai-proxy distinguishes "Missing
      // authorization token" (the request carried no Bearer header) from
      // "Invalid or expired token" (it did, and Supabase rejected it) — opposite
      // causes, opposite fixes, and a canned 401 string hides which one it was.
      const why = (data && data.error && (data.error.message || data.error)) || ('HTTP ' + res.status);
      _setBankImportError(
        res.status === 401
          ? `the AI column-detector was refused — ${why}`
          : `the AI column-detector failed (${why})`
      );
      return null;
    }
    const text = data.content[0].text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(text);
  } catch (e) {
    console.log('[StayOps] parseCSV: AI format detection failed', e && e.message ? e.message : e);
    _setBankImportError('the AI column-detector could not be reached (' + ((e && e.message) || e) + ')');
    return null;
  }
}

function heuristicCsvMapping(rows) {
  if (!rows.length) return null;
  const firstCell = String(rows[0].cells[0] || '').trim();
  const ddmmyyyy = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(firstCell);
  if (ddmmyyyy && rows[0].cells.length >= 3) {
    return {
      has_header: false,
      date_col: 0,
      amount_col: 1,
      description_col: 2,
      date_format: 'DD/MM/YYYY',
      amount_format: 'signed',
      debit_col: null,
      credit_col: null,
    };
  }
  const headers = rows[0].cells;
  const iDate = findColIndexInHeaders(headers, ['date']);
  let iAmt = findColIndexInHeaders(headers, ['amount', 'value']);
  const iDesc = findColIndexInHeaders(headers, [
    'description',
    'details',
    'narration',
    'transaction details',
    'particulars',
    'memo',
  ]);
  const iDeb = findColIndexInHeaders(headers, ['debit']);
  const iCred = findColIndexInHeaders(headers, ['credit']);
  if (iDate < 0 || iDesc < 0) return null;
  if (iDeb >= 0 || iCred >= 0) {
    return {
      has_header: true,
      date_col: iDate,
      amount_col: iAmt >= 0 ? iAmt : null,
      description_col: iDesc,
      date_format: 'DD/MM/YYYY',
      amount_format: 'separate',
      debit_col: iDeb >= 0 ? iDeb : null,
      credit_col: iCred >= 0 ? iCred : null,
    };
  }
  if (iAmt < 0) return null;
  return {
    has_header: true,
    date_col: iDate,
    amount_col: iAmt,
    description_col: iDesc,
    date_format: 'DD/MM/YYYY',
    amount_format: 'signed',
    debit_col: null,
    credit_col: null,
  };
}

function parseRowsWithBankMapping(rows, mapping) {
  const out = [];
  const start = mapping.has_header ? 1 : 0;
  for (let r = start; r < rows.length; r++) {
    const { cells, rawLine } = rows[r];
    if (!cells.length || cells.every((c) => !String(c).trim())) continue;
    const firstCell = String(cells[0] || '').trim();
    if (SUMMARY_REGEX.test(firstCell) || SUMMARY_REGEX.test(String(cells.join(' ')))) continue;

    const dateStr = parseCellDate(cells[mapping.date_col], mapping.date_format);
    const description = String(cells[mapping.description_col] || '').trim();

    let type;
    let amountVal = null;

    if (mapping.amount_format === 'separate') {
      const deb =
        mapping.debit_col != null ? parseAmount(cells[mapping.debit_col]) : null;
      const cred =
        mapping.credit_col != null ? parseAmount(cells[mapping.credit_col]) : null;
      if (deb != null && Math.abs(deb) > 0) {
        type = 'debit';
        amountVal = Math.abs(deb);
      } else if (cred != null && Math.abs(cred) > 0) {
        type = 'credit';
        amountVal = Math.abs(cred);
      } else continue;
    } else {
      const amt = parseAmount(cells[mapping.amount_col]);
      if (amt == null) continue;
      if (amt < 0) {
        type = 'debit';
        amountVal = Math.abs(amt);
      } else if (amt > 0) {
        type = 'credit';
        amountVal = amt;
      } else continue; // skip zero-amount rows
    }

    // Phase 2c: keep BOTH debits (expenses) and credits (platform payouts /
    // refunds / owner top-ups). Previous behaviour dropped credits, which
    // meant your Airbnb deposits could never be matched to a bank line.
    if (!dateStr || amountVal == null || amountVal <= 0 || !description) continue;
    out.push({
      date: dateStr,
      description,
      amount: amountVal,
      type,
      rawLine,
    });
  }
  return out;
}

/**
 * @param {string} fileText
 * @returns {Promise<{ date: string, description: string, amount: number, type: 'debit', rawLine: string }[]>}
 */
export async function parseCSV(fileText) {
  const lines = String(fileText || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd());
  const delimiter = _detectDelimiter(lines);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    rows.push({ cells: parseCSVLine(line, delimiter), rawLine: line });
  }
  if (!rows.length) {
    console.log('[StayOps] Parsed 0 transactions from CSV');
    _setBankImportError('the file had no readable rows — it may be empty, or not a CSV');
    return [];
  }

  const sampleLines = rows.slice(0, 5).map((x) => x.rawLine);
  let mappingJson = await detectCsvFormatWithAi(sampleLines);
  let sampleCells = rows[0].cells;
  if (mappingJson && rows.length > 1 && mappingJson.has_header) {
    sampleCells = rows[1].cells;
  } else if (mappingJson) {
    sampleCells = rows[0].cells;
  }
  let mapping = mappingJson ? normalizeAiMapping(mappingJson, sampleCells) : null;

  if (mapping) {
    console.log('[StayOps] AI detected CSV format:', mapping);
  } else {
    const h = heuristicCsvMapping(rows);
    const normCells =
      h && h.has_header && rows.length > 1 ? rows[1].cells : rows[0].cells;
    mapping = h ? normalizeAiMapping(h, normCells) : null;
    if (mapping) {
      console.log('[StayOps] CSV format (heuristic fallback):', mapping);
    }
  }

  if (!mapping) {
    console.log('[StayOps] Parsed 0 transactions from CSV');
    // Distinguish the two ways this lands here: the AI column-detector never
    // answered (usually auth/proxy — see _setBankImportError in
    // detectCsvFormatWithAi), or it answered but neither it nor the heuristic
    // could identify a date/amount column.
    _setBankImportError(
      _lastBankImportError
        ? _lastBankImportError + ', and the fallback could not identify the date/amount columns'
        : "couldn't identify which columns hold the date and amount"
    );
    return [];
  }

  const out = parseRowsWithBankMapping(rows, mapping);
  console.log('[StayOps] Parsed', out.length, 'transactions from CSV');
  if (!out.length) {
    _setBankImportError(`the columns were detected (${rows.length} row${rows.length === 1 ? '' : 's'} read) but no row produced a usable date + amount`);
  }
  return out;
}

/**
 * Phase 2c+ : extract bank transactions from a PDF or image of a statement
 * using Claude Sonnet vision. Mirrors the payout-paste AI flow: same
 * document/image content block pattern, same Sonnet model. Returns rows
 * in the EXACT shape parseCSV produces so the downstream pipeline
 * (checkDuplicates -> categoriseTransactions -> review UI) is unchanged.
 *
 * @param {string} base64Data  bare base64 string (no data: URL prefix)
 * @param {string} mediaType   'application/pdf' or 'image/jpeg' / 'image/png' etc.
 * @returns {Promise<Array<{ date: string, description: string, amount: number, type: 'debit'|'credit', rawLine: string }>>}
 */
export async function parseBankFileWithAI(base64Data, mediaType) {
  if (!base64Data) return [];
  const aiUrl = '/.netlify/functions/ai-proxy';
  const promptInstructions = `You extract bank transactions from a bank statement (Australian bank, AUD).
Return ONLY valid JSON. No markdown, no commentary, no prose.

OUTPUT SHAPE — an array of transaction objects:
[
  {"date":"YYYY-MM-DD","description":"...","amount":0,"type":"debit"|"credit"}
]

EXTRACTION RULES
- One object per real transaction row in the statement
- date: ISO YYYY-MM-DD. Infer the year from the statement period if the
  row only shows day+month. Use posted/processed date if both are listed.
- description: the merchant / narration / details column, trimmed.
  Strip pure noise like card numbers (****1234) and trailing reference
  codes when they're not informative; KEEP merchant names intact.
- amount: positive number, no $, no commas
- type: "debit" for money OUT of the account (purchases, fees, transfers
  out), "credit" for money IN (deposits, refunds, transfers in, platform
  payouts like Airbnb / Booking.com).

SKIP these row types entirely (do not emit objects for them):
- Opening balance, closing balance, running-balance-only rows
- "Total debits", "Total credits", subtotal / summary rows
- Page headers / footers / statement metadata
- Continued-on-next-page markers
- "Interest charged" / "Interest paid" lines? KEEP these — they are real

If a row's amount is ambiguous (no clear sign / column), use your best
judgement based on description (e.g. "PURCHASE" = debit, "DEPOSIT" /
"PAYMENT FROM" = credit). When truly unsure, skip the row.

Return JUST the array. Example:
[{"date":"2026-03-09","description":"AIRBNB PAYMENTS","amount":1208.75,"type":"credit"},{"date":"2026-03-12","description":"BUNNINGS ROUSE HILL","amount":47.30,"type":"debit"}]`;

  const fileBlock = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }
    : { type: 'image',    source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64Data } };

  const res = await (globalThis.authFetch || fetch)(aiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [fileBlock, { type: 'text', text: promptInstructions }],
      }],
    }),
  });
  if (!res.ok) {
    console.log('[StayOps] parseBankFileWithAI HTTP error', res.status);
    _setBankImportError(
      res.status === 401
        ? 'the AI reader was rejected as signed-out (401) — reload and try again'
        : `the AI reader failed (HTTP ${res.status})`
    );
    return [];
  }
  const data = await _safeJson(res);
  const text = (data && data.content && data.content[0] && data.content[0].text) || '';
  const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.log('[StayOps] parseBankFileWithAI JSON parse error:', e && e.message);
    // Same failure mode the receipt reader hit: asked for JSON, got prose.
    _setBankImportError(
      text.trim()
        ? 'the AI described the file instead of returning data — it may not look like a statement'
        : 'the AI returned an empty response'
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    _setBankImportError('the AI returned an unexpected shape instead of a list of transactions');
    return [];
  }
  // Coerce to the same shape parseCSV returns, filtering anything malformed.
  const out = [];
  for (const r of parsed) {
    if (!r || typeof r !== 'object') continue;
    const date = String(r.date || '').slice(0, 10);
    const description = String(r.description || '').trim();
    const amount = Math.abs(Number(r.amount) || 0);
    const type = r.type === 'credit' ? 'credit' : 'debit';
    if (!date || !description || amount <= 0) continue;
    out.push({ date, description, amount, type, rawLine: JSON.stringify(r) });
  }
  console.log('[StayOps] parseBankFileWithAI extracted', out.length, 'transactions from', mediaType);
  return out;
}

function amountClose(a, b, tol = 0.01) {
  return Math.abs(Number(a) - Number(b)) <= tol;
}

function descriptionSimilar(d1, d2) {
  const a = String(d1 || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const b = String(d2 || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length < b.length ? a : b;
  const long = a.length >= b.length ? a : b;
  if (short.length >= 8 && long.includes(short.slice(0, Math.min(12, short.length)))) return true;
  const wa = new Set(a.split(/\s+/).filter((w) => w.length > 2));
  const wb = new Set(b.split(/\s+/).filter((w) => w.length > 2));
  let n = 0;
  wa.forEach((w) => {
    if (wb.has(w)) n++;
  });
  return n >= 2 || (n >= 1 && wa.size <= 3);
}

// Bank-narration boilerplate carries no identity, and descriptionSimilar
// accepts a single shared token for short strings — so a merchant literally
// named "ANZ Mortgage" would text-match EVERY "ANZ MOBILE BANKING PAYMENT …"
// narration via the shared "anz". Strip the boilerplate from both sides before
// comparing, so only the words that name someone can match.
const NARRATION_STOPWORDS = new Set([
  'anz', 'visa', 'debit', 'credit', 'card', 'purchase', 'payment', 'payments',
  'transfer', 'banking', 'mobile', 'internet', 'bpay', 'eftpos', 'deposit',
  'the', 'and', 'pty', 'ltd', 'from', 'account',
]);

function merchantSimilar(merchant, bankDescription) {
  const strip = (s) => String(s || '').toLowerCase().split(/\s+/)
    .filter((w) => w.length > 2 && !NARRATION_STOPWORDS.has(w)).join(' ');
  return descriptionSimilar(strip(merchant), strip(bankDescription));
}

// Days between the expense date and the bank posting it. An expense is dated
// when the invoice is, but it is paid days later, so the real-world lag is
// bigger than "a couple of days". At 4 this window missed by ONE day on the
// common case (Bunnings 22 Jul paid 27 Jul, two Megan Orme cleans 23 Jun paid
// 29 Jun) and, finding no match, the importer authored a second expense for a
// purchase already recorded -- $1,768 double-counted in a single import.
// Amount still has to agree to the cent, so widening the window costs precision
// only when the same amount recurs inside ten days.
const DUP_DATE_WINDOW = 10;

function _shiftIsoDate(iso, delta) {
  // UTC math so a local timezone can't roll the calendar date back a day
  // (new Date('...T00:00:00') is local but toISOString() is UTC).
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {Awaited<ReturnType<categoriseTransactions>>} transactions
 * @param {string} userId
 */
export async function checkDuplicates(transactions, userId) {
  const sb = getSb();
  if (!sb || !userId) {
    return transactions.map((t) => ({ ...t, isDuplicate: false, existingExpenseId: null }));
  }

  const out = [];
  for (const t of transactions) {
    _importProgress('duplicates', `${out.length + 1} of ${transactions.length}`);
    let isDuplicate = false;
    let existingExpenseId = null;
    // Distinct from isDuplicate: this row IS the payment for an expense the host
    // already recorded, so it must be imported and linked, not discarded.
    let matchesExistingExpense = false;
    let dupMatch = null;
    let nearMiss = null;
    let reason;

    // Match against an already-logged EXPENSE within a date window (the bank
    // posts a few days after the expense was recorded), same amount, and a
    // similar vendor/description. `merchant` is in the select because it is the
    // field hosts actually fill in — "Megan Orme" — while `description` holds
    // invoice prose and `vendor` is usually blank on manual entries. Comparing
    // only the latter two meant an exact-amount payment to a recorded merchant
    // failed the text gate and minted a duplicate expense.
    const winLo = _shiftIsoDate(t.date, -DUP_DATE_WINDOW);
    const winHi = _shiftIsoDate(t.date, DUP_DATE_WINDOW);
    const { data: rows, error } = await sb
      .from('expenses')
      .select('id, amount, description, vendor, merchant, date, bank_transaction_id, property_id, category')
      .eq('user_id', userId)
      .gte('date', winLo)
      .lte('date', winHi);

    if (error) {
      console.log('[StayOps] checkDuplicates query error:', error.message || error);
    } else if (Array.isArray(rows)) {
      for (const row of rows) {
        // THE BANK IS THE ARBITER. An expense that already carries its own bank
        // line is, by definition, accounted for by a DIFFERENT statement row, so
        // this incoming line cannot be its duplicate. Without this a recurring
        // same-amount payment (the weekly Megan Orme $165 clean) matched the
        // previous week's expense every import, greying out the whole statement
        // and saving nothing. Re-importing the SAME line is a separate concern,
        // caught by the bank_transactions pass below.
        if (row.bank_transaction_id) continue;
        const amountGap = Math.abs(Number(row.amount) - Number(t.amount));
        if (amountGap > 0.5) continue;
        const vendorMatch =
          row.vendor && t.vendor && descriptionSimilar(row.vendor, t.vendor);
        const descMatch = descriptionSimilar(row.description, t.description);
        const merchantMatch = merchantSimilar(row.merchant, t.description);
        const textMatch = vendorMatch || descMatch || merchantMatch;

        // Tier 2 — close, but not certain: the amount is off by up to 50c on a
        // matching merchant (an invoice of $178.75 paid as $178.50 by typo).
        // This is a QUESTION for the host, not an answer. It used to be neither
        // linked nor asked: any row the exact-match tier rejected fell through
        // to "create a new expense", so a 25c mistype silently double-counted
        // the clean. Best candidate wins: smallest amount gap, then nearest
        // date.
        //
        // DELIBERATELY NOT a near-miss: an exact amount with no text match.
        // The score path in confirmTransaction already auto-links those at
        // >= 80, and bankImportApplyMatchPreviews locks the row with a green
        // "Matches" strip — asking a question about the same expense would
        // fight that tier (two owners, contradictory UI), and because the
        // score is >= 80 a "No" answer would be silently overridden by the
        // score-path link. Review caught exactly that. One owner per case:
        // exact amount → score path; near amount + text → this question.
        //
        // Credits never ask: a refund can equal a recorded expense to the
        // cent, but confirmTransaction's credit branch returns before any
        // expense linking, so the promise "Will link" would be a lie.
        if (!amountClose(row.amount, t.amount) || !textMatch) {
          if (amountGap > 0.01 && textMatch && t.type !== 'credit') {
            const dayGap = Math.abs(
              (new Date(String(row.date).slice(0, 10) + 'T00:00:00Z') -
               new Date(String(t.date).slice(0, 10) + 'T00:00:00Z')) / 86400000);
            const cand = {
              id: row.id,
              label: row.merchant || row.vendor || row.description || 'expense',
              amount: Number(row.amount) || 0,
              date: row.date,
              diff: amountGap,
              days: dayGap,
              propertyId: row.property_id || '',
              category: row.category || '',
            };
            if (!nearMiss || cand.diff < nearMiss.diff - 1e-9 ||
                (Math.abs(cand.diff - nearMiss.diff) < 1e-9 && cand.days < nearMiss.days)) {
              nearMiss = cand;
            }
          }
          continue;
        }
        {
          // NOT a duplicate — this is the PAYMENT for an expense the host already
          // entered, which is precisely what reconciliation is for.
          //
          // This used to set isDuplicate, and canBankImportRow drops duplicates,
          // so the bank row was discarded. The importer therefore kept only the
          // payments it could NOT explain (minting an expense for each, hence the
          // "Unknown" rows) and threw away the ones it could — leaving the
          // matching expense permanently unpayable, with no bank line in
          // existence to match it to later. 33 expenses ended up in that state.
          //
          // Let it import instead: confirmTransaction already links a row to a
          // matching expense at score >= 80, and bankImportApplyMatchPreviews
          // already copies that expense's property/category onto the row and
          // marks it confirmed. Only a genuine RE-IMPORT of the same statement
          // line (the bank_transactions pass below) is a real duplicate.
          existingExpenseId = row.id;
          matchesExistingExpense = true;
          dupMatch = { kind: 'expense', label: row.merchant || row.vendor || row.description || '', amount: Number(row.amount) || 0, date: row.date };
          // A certain match supersedes any near-miss candidate collected earlier.
          nearMiss = null;
          break;
        }
      }
    }

    // Otherwise, was this line already imported on a previous statement? Match
    // on the same window + amount + similar description (not an exact string,
    // so whitespace/format drift can't sneak a re-import through).
    if (!isDuplicate) {
      const { data: btxRows, error: bErr } = await sb
        .from('bank_transactions')
        .select('id, expense_id, amount, description, date')
        .eq('user_id', userId)
        .gte('date', winLo)
        .lte('date', winHi);

      if (bErr) {
        console.log('[StayOps] checkDuplicates bank_transactions error:', bErr.message || bErr);
      } else if (Array.isArray(btxRows)) {
        for (const btx of btxRows) {
          if (!amountClose(btx.amount, t.amount)) continue;
          // Fuzzy description match, OR (both descriptions blank → fall back to an
          // exact same-day match so re-imports of blank-description rows are still
          // caught, which the old exact-string check did).
          const bothBlank = !String(btx.description || '').trim() && !String(t.description || '').trim();
          if (!(descriptionSimilar(btx.description, t.description) || (bothBlank && btx.date === t.date))) continue;
          isDuplicate = true;
          existingExpenseId = btx.expense_id || null;
          reason = 'already imported';
          dupMatch = { kind: 'import', label: btx.description || '', amount: Number(btx.amount) || 0, date: btx.date };
          break;
        }
      }
    }

    // A near-miss only survives when nothing certain claimed the row — a
    // confirmed expense match or a prior-import duplicate outranks a question.
    // Written explicitly (null, not omitted): checkDuplicates runs TWICE in the
    // pipeline (before and after categorisation), and `...t` carries pass 1's
    // decoration into pass 2 — a row that upgraded to a certain match must not
    // keep a stale question from the earlier pass.
    const keepNearMiss = nearMiss && !matchesExistingExpense && !isDuplicate;
    out.push({
      ...t, isDuplicate, existingExpenseId, matchesExistingExpense, dupMatch,
      nearMissExpense: keepNearMiss ? nearMiss : null,
      ...(reason ? { reason } : {}),
    });
  }
  return out;
}
