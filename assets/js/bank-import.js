/**
 * StayOps — bank statement CSV import: parse, categorise (mappings + Haiku), dedupe, confirm/skip/log.
 */
import { getAllProperties } from './config.js';
import { localDateStr } from './utils.js';
import {
  findMatchesForTransaction,
  linkTransactionToExpense,
  autoReconcile,
  findPayoutMatchesForBankTransaction,
  linkTransactionToPayout,
} from './reconciliation.js';

export { autoReconcile };

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

const ALLOWED_AI_CATEGORIES = [
  'cleaning',
  'maintenance',
  'supplies',
  'utilities',
  'insurance',
  'council_rates',
  'strata',
  'mortgage',
  'advertising',
  'furniture',
  'linen',
  'gardening',
  'pest_control',
  'accounting',
  'other',
];

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

/**
 * Normalise description to a vendor pattern for mappings lookup.
 */
function normaliseVendorPattern(description) {
  let s = String(description || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/\bAU\b|\bAUS\b|\bAUSTRALIA\b/g, '');
  s = s.replace(/\bNSW\b|\bVIC\b|\bQLD\b|\bSA\b|\bWA\b|\bTAS\b|\bNT\b|\bACT\b/g, '');
  s = s.replace(/\*\d{4}\b|\*\d{6,}\b/g, '');
  s = s.replace(/\b\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{0,4}\b/g, '');
  s = s.replace(/\b\d{10,}\b/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  const parts = s.split(/\s+/).filter(Boolean).slice(0, 4);
  return parts.join(' ') || s;
}

function getSb() {
  return window._sb || null;
}

async function fetchVendorMappings(userId, pattern) {
  const sb = getSb();
  if (!sb || !userId || !pattern) return null;
  const { data, error } = await sb
    .from('vendor_mappings')
    .select('id, vendor_pattern, property_id, category, is_personal, times_used')
    .eq('user_id', userId)
    .eq('vendor_pattern', pattern)
    .maybeSingle();
  if (error) {
    console.log('[StayOps] vendor_mappings lookup error:', error.message || error);
    return null;
  }
  return data || null;
}

function propertyListForPrompt() {
  try {
    const props = getAllProperties() || [];
    return props
      .map((p) => {
        const name = p.name || p.propertyName || '';
        const suburb = p.suburb || '';
        const addr = p.address || '';
        return name ? name + (suburb ? ' (' + suburb + ')' : addr ? ' — ' + addr : '') : '';
      })
      .filter(Boolean)
      .join('; ');
  } catch (_) {
    return '';
  }
}

function resolvePropertyFromGuess(guess) {
  if (!guess) return { propertyId: null, propertyName: null };
  const g = String(guess).trim().toLowerCase();
  const props = getAllProperties() || [];
  for (const p of props) {
    const name = String(p.name || '').trim().toLowerCase();
    if (name && (g === name || g.includes(name) || name.includes(g))) {
      return { propertyId: p.supabaseId || null, propertyName: p.name || null };
    }
  }
  return { propertyId: null, propertyName: null };
}

async function callHaikuBatch(items, propertyListStr) {
  const cats = ALLOWED_AI_CATEGORIES.join(', ');
  const system =
    'You are categorising bank transactions for an Australian short-term rental property manager. For each transaction, determine the vendor name, expense category, and which property it likely belongs to based on location clues in the description.\n\n' +
    'Available properties: ' +
    (propertyListStr || '(none)') +
    '\n' +
    'Available categories: ' +
    cats +
    '\n\n' +
    'Respond ONLY in JSON array format, no markdown:\n' +
    "[{ \"index\": 0, \"vendor\": \"string\", \"category\": \"string\", \"property_guess\": \"string or null\", \"confidence\": \"high\"|\"medium\"|\"low\" }]";

  const userPayload = JSON.stringify(
    items.map((t) => ({ index: t.batchIndex, description: t.description, amount: t.amount, date: t.date }))
  );

  const res = await (globalThis.authFetch || fetch)('/.netlify/functions/ai-proxy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: userPayload }],
    }),
  });

  const data = await _safeJson(res);
  if (!res.ok || !data || !data.content || !data.content[0] || !data.content[0].text) {
    const why = (data && data.error && (data.error.message || data.error)) || ('HTTP ' + res.status);
    console.log('[StayOps] Claude categorise error:', why);
    // Surface the reason so a whole import that silently fell back to rules can
    // still explain itself, rather than only whispering it to the console.
    if (res.status === 401) _setBankImportError(`the AI was refused — ${why}`);
    // Returning null is not fatal — the caller falls back to rule-based
    // categorisation, so the import still completes without AI.
    return null;
  }
  const text = data.content[0].text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.log('[StayOps] Claude categorise JSON parse failed:', e.message);
    return null;
  }
}

function normaliseCategory(c) {
  const x = String(c || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (ALLOWED_AI_CATEGORIES.includes(x)) return x;
  const map = {
    'council rates': 'council_rates',
    'pest control': 'pest_control',
  };
  return map[x] && ALLOWED_AI_CATEGORIES.includes(map[x]) ? map[x] : 'other';
}

/**
 * @param {Awaited<ReturnType<typeof parseCSV>>} transactions
 * @param {string} userId
 */
export async function categoriseTransactions(transactions, userId) {
  const propertyListStr = propertyListForPrompt();
  const result = new Array(transactions.length);
  const needsAI = [];

  for (let i = 0; i < transactions.length; i++) {
    _importProgress('vendors', `${i + 1} of ${transactions.length}`);
    const t = transactions[i];
    const pattern = normaliseVendorPattern(t.description);
    const mapping = await fetchVendorMappings(userId, pattern);

    if (mapping && mapping.is_personal) {
      result[i] = {
        ...t,
        vendor: pattern,
        category: null,
        propertyId: null,
        propertyName: null,
        confidence: 'learned',
        skip: true,
        reason: 'personal',
        vendorPattern: pattern,
      };
      continue;
    }

    if (mapping && !mapping.is_personal) {
      const props = getAllProperties() || [];
      const prop = props.find((p) => String(p.supabaseId) === String(mapping.property_id));
      result[i] = {
        ...t,
        vendor: pattern,
        category: mapping.category,
        propertyId: mapping.property_id,
        propertyName: prop ? prop.name : null,
        confidence: 'learned',
        skip: false,
        vendorPattern: pattern,
      };
      continue;
    }

    needsAI.push({ ...t, origIndex: i, vendorPattern: pattern });
  }

  // Once the proxy has refused one batch it will refuse the rest identically
  // (it is down, or the session is not authenticated), so stop asking and let
  // every remaining row take the rule-based path. Without this a 95-row import
  // fired ten doomed requests and logged ten identical errors.
  let aiUnavailable = false;
  for (let start = 0; start < needsAI.length; start += 10) {
    const batch = needsAI.slice(start, start + 10);
    _importProgress('vendors', aiUnavailable
      ? `${Math.min(start + batch.length, needsAI.length)} of ${needsAI.length} — using rules`
      : `${Math.min(start + batch.length, needsAI.length)} of ${needsAI.length} with AI`);
    const batchForApi = batch.map((b, j) => ({
      batchIndex: j,
      description: b.description,
      amount: b.amount,
      date: b.date,
    }));
    const aiRaw = aiUnavailable ? null : await callHaikuBatch(batchForApi, propertyListStr);
    if (aiRaw == null && !aiUnavailable) {
      aiUnavailable = true;
      console.log('[StayOps] Bank import: AI categorisation unavailable — falling back to rules for the remaining rows');
    }
    const byIndex = new Map();
    if (Array.isArray(aiRaw)) {
      aiRaw.forEach((row) => {
        if (row && typeof row.index === 'number') byIndex.set(row.index, row);
      });
    }

    for (let j = 0; j < batch.length; j++) {
      const t = batch[j];
      const row = byIndex.get(j);
      const vendor = row && row.vendor ? String(row.vendor) : t.vendorPattern;
      const category = normaliseCategory(row && row.category);
      const guess = row && row.property_guess != null ? row.property_guess : null;
      const { propertyId, propertyName } = resolvePropertyFromGuess(guess);
      const conf = row && ['high', 'medium', 'low'].includes(row.confidence) ? row.confidence : 'medium';

      // Spread the source row FIRST. This used to rebuild from an explicit
      // field list, which silently dropped anything it didn't know about —
      // that is exactly how the importBatchId / bankAccountId / bankName
      // stamped at file level vanished before insert, leaving every imported
      // row with no account (invisible to the period reconcile) and no batch
      // (no undo). The learned-mapping branch above always spread; this one
      // must too. origIndex is stripped below since it is loop bookkeeping.
      result[t.origIndex] = {
        ...t,
        vendor,
        category,
        propertyId,
        propertyName,
        confidence: 'ai',
        aiConfidence: conf,
        skip: false,
        vendorPattern: t.vendorPattern,
      };
      delete result[t.origIndex].origIndex;
    }
  }

  return result.filter((x) => x != null);
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
    let reason;

    // Match against an already-logged EXPENSE within a date window (the bank
    // posts a few days after the expense was recorded), same amount, and a
    // similar vendor/description.
    const winLo = _shiftIsoDate(t.date, -DUP_DATE_WINDOW);
    const winHi = _shiftIsoDate(t.date, DUP_DATE_WINDOW);
    const { data: rows, error } = await sb
      .from('expenses')
      .select('id, amount, description, vendor, date, bank_transaction_id')
      .eq('user_id', userId)
      .gte('date', winLo)
      .lte('date', winHi);

    if (error) {
      console.log('[StayOps] checkDuplicates query error:', error.message || error);
    } else if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!amountClose(row.amount, t.amount)) continue;
        // THE BANK IS THE ARBITER. An expense that already carries its own bank
        // line is, by definition, accounted for by a DIFFERENT statement row, so
        // this incoming line cannot be its duplicate. Without this a recurring
        // same-amount payment (the weekly Megan Orme $165 clean) matched the
        // previous week's expense every import, greying out the whole statement
        // and saving nothing. Re-importing the SAME line is a separate concern,
        // caught by the bank_transactions pass below.
        if (row.bank_transaction_id) continue;
        const vendorMatch =
          row.vendor && t.vendor && descriptionSimilar(row.vendor, t.vendor);
        const descMatch = descriptionSimilar(row.description, t.description);
        if (vendorMatch || descMatch) {
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
          dupMatch = { kind: 'expense', label: row.vendor || row.description || '', amount: Number(row.amount) || 0, date: row.date };
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

    out.push({ ...t, isDuplicate, existingExpenseId, matchesExistingExpense, dupMatch, ...(reason ? { reason } : {}) });
  }
  return out;
}

function hashDateAmountDesc(date, amount, description) {
  const str = String(date) + '|' + String(amount) + '|' + String(description || '');
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return 'h' + Math.abs(h).toString(16);
}

/**
 * @param {object} transaction enriched row
 * @param {string} userId
 * @param {string} propertyId
 * @param {string} category
 */
export async function confirmTransaction(transaction, userId, propertyId, category) {
  const sb = getSb();
  if (!sb) throw new Error('Supabase client not available');

  const pattern = transaction.vendorPattern || normaliseVendorPattern(transaction.description);
  const localId = 'bank-' + hashDateAmountDesc(transaction.date, transaction.amount, transaction.description);
  const direction = transaction.type === 'credit' ? 'credit' : 'debit';

  const bankPayload = {
    user_id: userId,
    date: transaction.date,
    amount: transaction.amount,
    description: transaction.description,
    bank_name: transaction.bankName || null,
    import_batch_id: transaction.importBatchId || null,
    // Which account this row belongs to. Without it a row is invisible to the
    // period reconcile, which filters by account — the worst failure mode,
    // because the balance would silently be computed over a subset.
    bank_account_id: transaction.bankAccountId || null,
    is_personal: false,
    skipped: false,
    direction,
  };

  // Credits (money in) route to platform_payouts matching instead of the
  // expense create-or-match path. The user shouldn't have to pick a category
  // for an Airbnb deposit — it's just a confirmation of a payout that's
  // already in the system.
  if (direction === 'credit') {
    const { data: bankRow, error: bankErr } = await sb
      .from('bank_transactions')
      .insert(bankPayload)
      .select()
      .single();
    if (bankErr) throw bankErr;
    const bankTxId = bankRow.id;

    const payoutMatches = await findPayoutMatchesForBankTransaction(transaction, userId);
    const top = payoutMatches[0];
    if (top && top.score >= 80) {
      await linkTransactionToPayout(bankTxId, top.payout.id);
      return {
        bankTransactionId: bankTxId,
        action: 'matched_payout',
        payout: top.payout,
        matchScore: top.score,
      };
    }
    return {
      bankTransactionId: bankTxId,
      action: 'credit_unmatched',
      payoutCandidates: payoutMatches.slice(0, 3),
    };
  }

  const { data: bankRow, error: bankErr } = await sb
    .from('bank_transactions')
    .insert(bankPayload)
    .select()
    .single();
  if (bankErr) throw bankErr;
  const bankTxId = bankRow.id;

  const matches = await findMatchesForTransaction(transaction, userId);
  const top = matches[0];

  // checkDuplicates already identified the expense this payment settles (same
  // amount, inside the date window, matching vendor/description). Trust it over
  // the score threshold: a near-miss of 79 would otherwise fall through and
  // CREATE a second expense for a purchase the host already entered — exactly
  // the double-record this path exists to prevent.
  const forcedExpenseId = transaction.matchesExistingExpense ? transaction.existingExpenseId : null;
  const targetExpenseId = forcedExpenseId || (top && top.score >= 80 ? top.expense.id : null);

  let expenseOut;

  if (targetExpenseId) {
    const linked = await linkTransactionToExpense(bankTxId, targetExpenseId);
    if (!linked.success) {
      console.log('[StayOps] confirmTransaction: linkTransactionToExpense failed');
      throw new Error('Failed to link bank transaction to expense');
    }

    expenseOut = (top && top.expense && top.expense.id === targetExpenseId)
      ? top.expense
      : { id: targetExpenseId };
    const v = expenseOut.vendor && String(expenseOut.vendor).trim();
    if (!v) {
      const vendorVal = transaction.vendor || pattern;
      const { data: patched, error: patchErr } = await sb
        .from('expenses')
        .update({ vendor: vendorVal })
        .eq('id', targetExpenseId)
        .select()
        .single();
      if (!patchErr && patched) expenseOut = patched;
      else if (patchErr) {
        console.log('[StayOps] confirmTransaction vendor patch error:', patchErr.message || patchErr);
      }
    }
  } else {
    const expensePayload = {
      user_id: userId,
      property_id: propertyId,
      amount: transaction.amount,
      category,
      date: transaction.date,
      description: transaction.description,
      vendor: transaction.vendor || pattern,
      gst: null,
      local_id: localId,
      reconciled: true,
      bank_transaction_id: bankTxId,
      payment_status: 'paid',
      updated_at: new Date().toISOString(),
    };

    const { data: inserted, error: insErr } = await sb.from('expenses').insert(expensePayload).select().single();
    if (insErr) throw insErr;

    const { error: linkErr } = await sb
      .from('bank_transactions')
      .update({ expense_id: inserted.id })
      .eq('id', bankTxId);
    if (linkErr) throw linkErr;

    expenseOut = inserted;
  }

  const { data: existingMap } = await sb
    .from('vendor_mappings')
    .select('id, times_used')
    .eq('user_id', userId)
    .eq('vendor_pattern', pattern)
    .maybeSingle();

  const nextUsed = (existingMap && existingMap.times_used != null ? Number(existingMap.times_used) : 0) + 1;
  const upsertPayload = {
    user_id: userId,
    vendor_pattern: pattern,
    property_id: propertyId,
    category,
    is_personal: false,
    times_used: nextUsed,
    updated_at: new Date().toISOString(),
  };

  const { error: mapErr } = await sb.from('vendor_mappings').upsert(upsertPayload, {
    onConflict: 'user_id,vendor_pattern',
  });
  if (mapErr) console.log('[StayOps] vendor_mappings upsert warning:', mapErr.message || mapErr);

  const action = top && top.score >= 80 ? 'matched' : 'created';
  return {
    ...expenseOut,
    action,
    expense: expenseOut,
    bankTransactionId: bankTxId,
  };
}

/**
 * @param {object} transaction
 * @param {string} userId
 * @param {boolean} markAsPersonal
 */
export async function skipTransaction(transaction, userId, markAsPersonal = false) {
  const sb = getSb();
  if (!sb) {
    console.log('[StayOps] skipTransaction: no Supabase client');
    return null;
  }

  const pattern = transaction.vendorPattern || normaliseVendorPattern(transaction.description);
  const bankPayload = {
    user_id: userId,
    date: transaction.date,
    amount: transaction.amount,
    description: transaction.description,
    bank_name: transaction.bankName || null,
    import_batch_id: transaction.importBatchId || null,
    // Which account this row belongs to. Without it a row is invisible to the
    // period reconcile, which filters by account — the worst failure mode,
    // because the balance would silently be computed over a subset.
    bank_account_id: transaction.bankAccountId || null,
    is_personal: markAsPersonal,
    skipped: true,
  };

  const { error: bankErr } = await sb.from('bank_transactions').insert(bankPayload);
  if (bankErr) {
    console.log('[StayOps] skipTransaction bank insert error:', bankErr.message || bankErr);
    return null;
  }

  if (markAsPersonal) {
    const upsertPayload = {
      user_id: userId,
      vendor_pattern: pattern,
      property_id: transaction.propertyId || null,
      category: transaction.category || 'other',
      is_personal: true,
      times_used: 1,
      updated_at: new Date().toISOString(),
    };

    const { error } = await sb.from('vendor_mappings').upsert(upsertPayload, {
      onConflict: 'user_id,vendor_pattern',
    });
    if (error) console.log('[StayOps] skipTransaction mapping error:', error.message || error);
  }

  return { skipped: true, vendor_pattern: pattern };
}

/**
 * @param {string} userId
 * @param {string} filename
 * @param {{ total: number, imported: number, skipped: number, duplicates: number }} stats
 */
export async function logImportSession(userId, filename, stats) {
  const sb = getSb();
  if (!sb || !userId) {
    console.log('[StayOps] logImportSession skipped — no client or userId');
    return null;
  }
  const row = {
    user_id: userId,
    import_date: new Date().toISOString(),
    filename: filename || '',
    total_rows: stats.total != null ? stats.total : 0,
    imported: stats.imported != null ? stats.imported : 0,
    skipped: stats.skipped != null ? stats.skipped : 0,
    duplicates: stats.duplicates != null ? stats.duplicates : 0,
  };
  const { data, error } = await sb.from('bank_import_log').insert(row).select().single();
  if (error) {
    console.log('[StayOps] bank_import_log insert error:', error.message || error);
    return null;
  }
  console.log('[StayOps] Logged bank import session', data && data.id);
  return data;
}
