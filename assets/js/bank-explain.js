/**
 * StayOps — the bank-line explain engine.
 *
 * Every bank line gets exactly one KIND (what sort of money movement it is)
 * plus, where something exists to link to, a LINK (an expense, a payout, a
 * booking). The Transaction Map could only say "expense" or "payout"; the live
 * account had 37 owner top-ups, 9 supplier refunds and a cent of interest that
 * could never be either, so they sat as "Unexplained" for a year.
 *
 * The rule for money out is deliberately blunt: EVERY PAYMENT IS AN EXPENSE
 * unless the host says it is owner funds, a transfer or personal. A debit the
 * engine cannot categorise is still an expense — it just asks "is this
 * category right?" instead of "what is this?".
 *
 * Order of authority per line (first certain answer wins):
 *   1. memory   — what the host decided last time this merchant appeared
 *   2. rules    — platform names, bank fees, interest
 *   3. evidence — an expense / payout / booking that this line settles
 *   4. memory by first token, owner names, refund signals  (suggestions only)
 *   5. default  — debit → expense needing a category; credit → unknown
 *
 * Three tiers fall out: certain (applied, needsReview=false), suggested
 * (pre-filled, needsReview=true), unknown (kind=null, needsReview=true).
 *
 * Pure: no window/document at module scope, so tests/bank-explain.test.js
 * can import it from the CJS harness.
 */
import { planPayoutAutoMatch, toCents } from './money-in-model.js';

// ── Kinds ─────────────────────────────────────────────────────────────────────

export const KIND_LABELS = {
  platform_payout: 'Platform payout',
  direct_booking: 'Direct booking payment',
  expense_refund: 'Refund of an expense',
  owner_funds: 'Owner funds',
  transfer: 'Transfer between my accounts',
  interest: 'Interest or bank adjustment',
  other_income: 'Other income',
  personal: 'Personal',
  expense: 'Expense',
  guest_refund: 'Refund to a guest',
};

export const CREDIT_KINDS = ['platform_payout', 'direct_booking', 'expense_refund', 'owner_funds', 'transfer', 'interest', 'other_income', 'personal'];
export const DEBIT_KINDS = ['expense', 'owner_funds', 'transfer', 'guest_refund', 'personal'];

/** Kinds that count towards nothing: not income, not cost. */
export const NEUTRAL_KINDS = new Set(['owner_funds', 'transfer', 'personal']);

export const BANK_FEES_CATEGORY = 'Bank Fees';

export function kindsForDirection(direction) {
  return direction === 'credit' ? CREDIT_KINDS : DEBIT_KINDS;
}

/** Human label, with the direction folded in for the two-way kinds. */
export function kindLabel(kind, direction) {
  if (!kind) return 'Not decided';
  if (kind === 'owner_funds') return direction === 'credit' ? 'Owner funds in' : 'Owner funds out';
  if (kind === 'transfer') return direction === 'credit' ? 'Transfer in' : 'Transfer out';
  return KIND_LABELS[kind] || kind;
}

export function isValidKind(kind, direction) {
  return kindsForDirection(direction).includes(kind);
}

// ── Counterparty normalisation ────────────────────────────────────────────────
//
// vendor_mappings keyed on the first four words of the raw description, which
// on an ANZ statement are the bank's own ("VISA DEBIT PURCHASE CARD" → 29
// rules, all useless). The key here is the MERCHANT: bank phrases, reference
// numbers, card suffixes, states and company suffixes are stripped first, and
// the key is the first two real words that are left.

const BANK_PHRASES = [
  /\b(ANZ|NAB|CBA|COMMBANK|WESTPAC|ING|MACQUARIE)\s+(MOBILE|INTERNET|ONLINE|NET)\s+BANKING\s+(PAYMENT|TRANSFER|BPAY|FUNDS\s+TFR)\b/g,
  /\b(MOBILE|INTERNET|ONLINE|NET)\s+BANKING\b/g,
  /\bVISA\s+DEBIT\s+(PURCHASE|DEPOSIT|REFUND|RETURN|REVERSAL)(\s+CARD)?\b/g,
  /\bDEBIT\s+CARD\s+(PURCHASE|DEPOSIT|REFUND)\b/g,
  /\bEFTPOS\s+(PURCHASE|DEPOSIT|REFUND)?\b/g,
  /\bDIRECT\s+(DEBIT|CREDIT|PAYMENT)\b/g,
  /\bCARD\s+\d{2,4}\b/g,
  /\bCARD\b/g,
  /\b(PAYMENT|TRANSFER|TFR|XFER)\s+(TO|FROM)\b/g,
  /\bPAYMENT\b/g,
  /\bTRANSFER\b/g,
  /\bBPAY\b/g,
  /\bPURCHASE\b/g,
  /\bDEPOSIT\b/g,
  /\bWITHDRAWAL\b/g,
  /\bOSKO\b/g,
  /\bPAYID\b/g,
  /\b(MR|MRS|MS|MISS|DR)\b/g,
];

// Card processors that sit in front of the real merchant name.
const PROCESSOR_PREFIX = /\b(SQ|SMP|EZI|ZLR|IPY|DBS|LSP|SP|TST|PP|PAYPAL|GPAY|SUMUP|CKO|PY)\s*\*\s*/g;

// Company suffixes and states. Cities are deliberately NOT here: "SYDNEY WATER"
// is a merchant, and a trailing suburb never changes the first two words.
const NOISE_WORDS = new Set([
  'PTY', 'LTD', 'LIMITED', 'INC', 'LLC', 'CO', 'CORP', 'THE', 'A', 'AN', 'AND', 'OF',
  'AUSTRALIA', 'AUSTRAL', 'AU', 'AUS', 'NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT',
  'VALUE', 'DATE', 'REF', 'REFERENCE', 'RECEIPT', 'TO', 'FROM', 'VIA',
]);

/** Merchant tokens of a raw description, bank noise removed. */
export function counterpartyTokens(description) {
  let s = String(description || '').toUpperCase();
  s = s.replace(PROCESSOR_PREFIX, ' ');
  s = s.replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, ' ');   // dates
  s = s.replace(/\b[A-Z]{1,3}\d{5,}\b/g, ' ');                // P194857632, HM12345
  s = s.replace(/\b\d{4,}\b/g, ' ');                          // card suffixes, references
  s = s.replace(/[*#~`@{}()[\]|\\"]+/g, ' ');
  for (const re of BANK_PHRASES) s = s.replace(re, ' ');
  s = s.replace(/\s+\d{1,3}$/g, ' ');                         // trailing short refs
  return s.split(/\s+/).map(t => t.replace(/^[-.:,]+|[-.:,]+$/g, '')).filter(t => t && !NOISE_WORDS.has(t));
}

function isStrong(t) {
  return t.length >= 3 && /[A-Z]/.test(t);
}

/** The memory key: the first two real words of the merchant. "MJS
 *  ELECTRICALSUPPLIES FAIRFIELD" → "MJS ELECTRICALSUPPLIES", "TRANSFER FROM
 *  MARDINI C KATOOMBA MO" → "MARDINI KATOOMBA", "ACCOUNT SERVICING FEE" →
 *  "ACCOUNT SERVICING". Two words so that "AGL SALES" and "AGL RETAIL" can be
 *  told apart; first-word matches are still offered, as suggestions. */
export function counterpartyKey(description) {
  const tokens = counterpartyTokens(description);
  const strong = tokens.filter(isStrong);
  if (strong.length >= 2) return strong.slice(0, 2).join(' ');
  if (strong.length === 1) return strong[0];
  return tokens.slice(0, 2).join(' ');
}

/** First real word, used for the looser "same merchant?" comparison. */
export function counterpartyHead(description) {
  const tokens = counterpartyTokens(description);
  const strong = tokens.find(isStrong);
  return strong || tokens[0] || '';
}

// ── Platforms ─────────────────────────────────────────────────────────────────

const PLATFORM_PATTERNS = [
  [/PAYONEER|AIRBNB|AIR\s?BNB/, 'airbnb'],
  [/BOOKING\.?\s?COM|BOOKINGCOM/, 'booking_com'],
  [/STAYZ/, 'stayz'],
  [/VRBO|EXPEDIA|HOMEAWAY/, 'vrbo'],
];

export function detectPlatform(description) {
  const s = String(description || '').toUpperCase();
  for (const [re, platform] of PLATFORM_PATTERNS) if (re.test(s)) return platform;
  return null;
}

const INTEREST_RE = /\bINTEREST\b/;
const BANK_FEE_RE = /ACCOUNT\s+SERVICING\s+FEE|SERVICE\s+FEE|MONTHLY\s+FEE|ACCOUNT\s+FEE|BANK\s+FEE|DISHONOUR|OVERDRAWN|HONOUR\s+FEE|INTEREST\s+CHARGED/;
const REFUND_SIGNAL_RE = /VISA\s+DEBIT\s+(DEPOSIT|REFUND|RETURN|REVERSAL)|EFTPOS\s+(DEPOSIT|REFUND)|\bREFUND\b|\bREVERSAL\b|\bRETURN\b|CREDIT\s+ADJ/;

// ── Memory ────────────────────────────────────────────────────────────────────

/** Memory is a Map of memoryKey(direction, key) → {kind, category, propertyId,
 *  platform, timesUsed}. Exact key → certain; same first word → suggestion. */
export function memoryKey(direction, key) {
  return `${direction === 'credit' ? 'credit' : 'debit'}|${key}`;
}

export function matchMemory(description, direction, memory) {
  if (!memory || !memory.size) return null;
  const key = counterpartyKey(description);
  if (!key) return null;
  const exact = memory.get(memoryKey(direction, key));
  if (exact) return { entry: exact, exact: true, key };
  const head = counterpartyHead(description);
  if (!head || !isStrong(head)) return null;
  const prefix = memoryKey(direction, head) + ' ';
  const headOnly = memoryKey(direction, head);
  let best = null;
  for (const [k, e] of memory) {
    if (k === headOnly || k.startsWith(prefix)) {
      if (!best || (e.timesUsed || 0) > (best.timesUsed || 0)) best = e;
    }
  }
  return best ? { entry: best, exact: false, key } : null;
}

// ── Evidence ──────────────────────────────────────────────────────────────────

function dayDiff(a, b) {
  const da = new Date(String(a).slice(0, 10) + 'T00:00:00Z');
  const db = new Date(String(b).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return Infinity;
  return (da - db) / 86400000;
}

function nameTokens(name) {
  return String(name || '').toUpperCase().split(/[^A-Z]+/).filter(t => t.length >= 4);
}

function expenseWords(e) {
  return counterpartyTokens([e.merchant, e.vendor, e.description].filter(Boolean).join(' '));
}

function sharesHead(line, e) {
  const head = counterpartyHead(line.description);
  if (!head) return false;
  return expenseWords(e).includes(head);
}

/** The unlinked expense a DEBIT settles: same amount, within 10 days. Unique →
 *  certain. Several → the one sharing the merchant name, else a suggestion. */
function findExpenseForDebit(line, expenses, claimed) {
  const cents = Math.abs(toCents(line.amount));
  const hits = expenses.filter(e =>
    e && !claimed.has(String(e.id))
    && !e.bankTransactionId
    && String(e.status || 'active') !== 'deleted'
    && Number(e.amount) > 0
    && Math.abs(toCents(e.amount)) === cents
    && Math.abs(dayDiff(e.date, line.date)) <= 10);
  if (!hits.length) return null;
  if (hits.length === 1) return { expense: hits[0], certain: true };
  const named = hits.filter(e => sharesHead(line, e));
  if (named.length === 1) return { expense: named[0], certain: true };
  hits.sort((a, b) => Math.abs(dayDiff(a.date, line.date)) - Math.abs(dayDiff(b.date, line.date)));
  return { expense: hits[0], certain: false };
}

/** The purchase a CREDIT refunds: same merchant, within 180 days before, for at
 *  least this amount. Closest amount wins. */
function findExpenseForRefund(line, expenses) {
  const cents = Math.abs(toCents(line.amount));
  const hits = expenses.filter(e =>
    e && String(e.status || 'active') !== 'deleted'
    && Number(e.amount) > 0
    && !e.refundOfExpenseId
    && Math.abs(toCents(e.amount)) >= cents
    && (() => { const d = dayDiff(line.date, e.date); return d >= -1 && d <= 180; })()
    && sharesHead(line, e));
  if (!hits.length) return null;
  // An exact amount is the purchase itself. Otherwise a part-refund almost
  // always comes off the MOST RECENT purchase, not the one whose price is
  // numerically nearest: a $134.75 Bunnings refund six days after a $448.77
  // Bunnings run is off that run, not off a $199 one five months earlier.
  hits.sort((a, b) => {
    const ea = Math.abs(toCents(a.amount)) === cents ? 0 : 1;
    const eb = Math.abs(toCents(b.amount)) === cents ? 0 : 1;
    if (ea !== eb) return ea - eb;
    return String(b.date).localeCompare(String(a.date));
  });
  return hits[0];
}

/** A booking paid directly: host payout equals the deposit, dated near the stay. */
function findBookingForCredit(line, bookings) {
  const cents = Math.abs(toCents(line.amount));
  if (!cents) return null;
  const hits = (bookings || []).filter(b =>
    b && String(b.status || 'confirmed') !== 'cancelled'
    && Math.abs(toCents(b.hostPayout)) === cents
    && dayDiff(line.date, b.checkin) >= -45
    && dayDiff(line.date, b.checkout) <= 21);
  return hits.length === 1 ? hits[0] : null;
}

function ownerNameHit(line, names) {
  const tokens = new Set(counterpartyTokens(line.description));
  for (const n of names || []) {
    for (const t of nameTokens(n)) if (tokens.has(t)) return n;
  }
  return null;
}

// ── The engine ────────────────────────────────────────────────────────────────

function result(kind, source, confidence, needsReview, extra = {}) {
  return {
    kind: kind || null,
    source: source || null,
    confidence: Number(confidence) || 0,
    needsReview: !!needsReview,
    category: null,
    propertyId: null,
    platform: null,
    expenseId: null,
    payoutId: null,
    bookingId: null,
    reason: '',
    ...extra,
  };
}

function fromMemory(entry, exact, direction) {
  const kind = entry.kind;
  if (!isValidKind(kind, direction)) return null;
  return result(kind, 'memory', exact ? 0.95 : 0.7, !exact, {
    category: entry.category || null,
    propertyId: entry.propertyId || null,
    platform: entry.platform || null,
    reason: exact ? 'You chose this for ' + (entry.label || 'this merchant') + ' before'
                  : 'Looks like ' + (entry.label || 'a merchant you have seen before'),
  });
}

/**
 * Explain ONE line. `claimed` tracks expenses already taken by an earlier line
 * in the same batch so two payments never settle the same invoice.
 *
 * @param {object} line  { id, date, amount, description, direction, existingExpenseId? }
 * @param {object} ctx   { memory: Map, ownerNames: string[], expenses: [], bookings: [] }
 */
export function explainLine(line, ctx = {}, claimed = new Set()) {
  const direction = line.direction === 'credit' ? 'credit' : 'debit';
  const desc = String(line.description || '').toUpperCase();
  const memory = ctx.memory instanceof Map ? ctx.memory : new Map();
  const expenses = Array.isArray(ctx.expenses) ? ctx.expenses : [];

  // 1. Memory, exact.
  const mem = matchMemory(line.description, direction, memory);
  if (mem && mem.exact) {
    const r = fromMemory(mem.entry, true, direction);
    if (r) {
      // A remembered "expense" still looks for the invoice it pays, so a
      // recurring cleaner payment links to the cleaner's recorded expense.
      if (r.kind === 'expense') {
        const found = findExpenseForDebit(line, expenses, claimed);
        if (found && found.certain) { r.expenseId = found.expense.id; r.source = 'match'; claimed.add(String(found.expense.id)); }
      }
      return r;
    }
  }

  // 2. Rules.
  if (direction === 'credit') {
    const platform = detectPlatform(desc);
    if (platform) {
      return result('platform_payout', 'rule', 0.95, false, { platform, reason: 'Platform payout (' + platform.replace('_', '.') + ')' });
    }
    if (INTEREST_RE.test(desc) && !/CHARGED/.test(desc)) {
      return result('interest', 'rule', 0.95, false, { reason: 'Bank interest' });
    }
    if (/CHARGED|ADJ/.test(desc) && INTEREST_RE.test(desc)) {
      return result('interest', 'rule', 0.9, false, { reason: 'Bank adjustment' });
    }
  } else {
    if (BANK_FEE_RE.test(desc)) {
      return result('expense', 'rule', 0.95, false, { category: BANK_FEES_CATEGORY, reason: 'Bank fee' });
    }
  }

  // 3. Evidence.
  if (direction === 'debit') {
    if (line.existingExpenseId && !claimed.has(String(line.existingExpenseId))) {
      claimed.add(String(line.existingExpenseId));
      return result('expense', 'match', 0.95, false, { expenseId: line.existingExpenseId, reason: 'Pays an expense you already recorded' });
    }
    const found = findExpenseForDebit(line, expenses, claimed);
    if (found && found.certain) {
      claimed.add(String(found.expense.id));
      return result('expense', 'match', 0.9, false, {
        expenseId: found.expense.id,
        category: found.expense.category || null,
        propertyId: found.expense.propertyId || null,
        reason: 'Same amount as ' + (found.expense.merchant || found.expense.vendor || 'a recorded expense') + ' on ' + (found.expense.date || '?'),
      });
    }
    // Fall through: memory-by-first-word, owner, default — but keep the
    // ambiguous candidate as a suggestion if nothing better turns up.
    const memSuggest = mem && !mem.exact ? fromMemory(mem.entry, false, direction) : null;
    if (memSuggest) return memSuggest;
    const owner = ownerNameHit(line, ctx.ownerNames);
    if (owner) return result('owner_funds', 'rule', 0.7, true, { reason: 'Paid to ' + owner });
    if (found) {
      return result('expense', 'match', 0.6, true, {
        expenseId: found.expense.id,
        category: found.expense.category || null,
        propertyId: found.expense.propertyId || null,
        reason: 'Might pay ' + (found.expense.merchant || found.expense.vendor || 'a recorded expense') + ' — more than one matches',
      });
    }
    return result('expense', 'default', 0.4, true, { reason: 'Every payment is an expense — check the category' });
  }

  // credit. The refund search is gated on the bank saying "deposit/refund":
  // without the gate an owner's transfer in would "refund" the mortgage
  // payment that carries the same surname in its vendor field.
  const refundOf = REFUND_SIGNAL_RE.test(desc) ? findExpenseForRefund(line, expenses) : null;
  if (refundOf) {
    return result('expense_refund', 'match', 0.9, false, {
      expenseId: refundOf.id,
      category: refundOf.category || null,
      propertyId: refundOf.propertyId || null,
      reason: 'Refunds ' + (refundOf.merchant || refundOf.vendor || 'a purchase') + ' of $' + Math.abs(Number(refundOf.amount) || 0).toFixed(2) + ' on ' + (refundOf.date || '?'),
    });
  }
  const memSuggest = mem && !mem.exact ? fromMemory(mem.entry, false, direction) : null;
  if (memSuggest) return memSuggest;
  const owner = ownerNameHit(line, ctx.ownerNames);
  if (owner) return result('owner_funds', 'rule', 0.7, true, { reason: 'From ' + owner });
  if (REFUND_SIGNAL_RE.test(desc)) {
    // No purchase on record: the credit note stands alone. Borrow the category
    // the host uses for this merchant's purchases, if any.
    const debitMem = matchMemory(line.description, 'debit', memory);
    return result('expense_refund', 'rule', 0.6, true, {
      category: debitMem && debitMem.entry.category ? debitMem.entry.category : null,
      propertyId: debitMem && debitMem.entry.propertyId ? debitMem.entry.propertyId : null,
      reason: 'Card refund — no matching purchase recorded',
    });
  }
  const booking = findBookingForCredit(line, ctx.bookings);
  if (booking) {
    return result('direct_booking', 'match', 0.6, true, { bookingId: booking.id, reason: 'Same amount as ' + (booking.guestName || 'a booking') + '\'s payout' });
  }
  return result(null, null, 0, true, { reason: 'Nothing on record explains this deposit' });
}

/**
 * Explain a batch. Payout links are decided over the WHOLE batch with
 * planPayoutAutoMatch, which refuses anything ambiguous, so a deposit is never
 * guessed onto the wrong statement.
 *
 * @returns {Map<string, object>} line id → result
 */
export function explainLines(lines, ctx = {}) {
  const out = new Map();
  const claimed = new Set();
  const ordered = [...(lines || [])].filter(Boolean)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  for (const line of ordered) out.set(String(line.id), explainLine(line, ctx, claimed));

  const payoutCredits = ordered.filter(l => l.direction === 'credit' && out.get(String(l.id)).kind === 'platform_payout');
  const payouts = (ctx.payouts || []).filter(p => p && !p.bankTransactionId && String(p.status || 'active') !== 'deleted');
  if (payoutCredits.length && payouts.length) {
    const plan = planPayoutAutoMatch({
      payouts,
      creditTxns: payoutCredits.map(l => ({ id: l.id, date: l.date, amount: l.amount, isPersonal: false, skipped: false })),
    });
    for (const { payout, credit } of plan.links) {
      const r = out.get(String(credit.id));
      if (r) {
        r.payoutId = payout._cloudId || payout.id;
        r.platform = payout.platform || r.platform;
        r.reason = 'Settles the ' + (payout.platform || 'platform').replace('_', '.') + ' statement of ' + (payout.payoutDate || '?');
      }
    }
  }
  return out;
}

/** Headline counts the Bank screen's tiles show. */
export function summariseLines(lines = []) {
  const s = { toDecide: 0, toDecideCents: 0, inCents: 0, outCents: 0, explainedIn: 0, explainedOut: 0 };
  for (const l of lines) {
    if (!l) continue;
    const cents = Math.abs(toCents(l.amount));
    const credit = l.direction === 'credit';
    if (credit) s.inCents += cents; else s.outCents += cents;
    if (!l.kind || l.needsReview) { s.toDecide += 1; s.toDecideCents += cents; }
    else if (credit) s.explainedIn += 1; else s.explainedOut += 1;
  }
  return s;
}
