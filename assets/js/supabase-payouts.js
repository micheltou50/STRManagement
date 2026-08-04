/**
 * StayOps — platform payouts: Airbnb / Booking.com payout statements and their
 * line items (platform_payouts + payout_lines tables). Split out of supabase.js
 * 2026-07-08 as the first slice of the by-entity data-layer split. supabase.js
 * stays the barrel and re-exports this module via `export *`, so every existing
 * `import { … } from './supabase.js'` resolves unchanged.
 *
 * The Supabase client is the global window._sb (referenced verbatim, no import).
 * getCurrentSupabaseUser is imported from the barrel and used only at call-time
 * (safe cycle — it is a hoisted export). showBanner is reached via globalThis.
 */
import { getCurrentSupabaseUser } from './supabase.js';

// ── PLATFORM PAYOUTS ──────────────────────────────────────────────────────────
//
// Models platform reality: what Airbnb / Booking.com / VRBO / Stayz say they
// paid, separate from bookings.host_payout (the promise at confirmation time)
// and from bank_transactions (the actual deposit, Phase 2).
//
// A platform_payouts row groups N platform_payout_lines. One Airbnb deposit
// can cover multiple bookings + adjustments + a host fee.

/** Map a cloud payout row to the camelCase shape consumers use in JS. */
function _payoutRowToJs(row) {
  if (!row) return null;
  return {
    _cloudId:             row.id,
    propertyId:           row.property_id || null,
    platform:             row.platform || 'other',
    payoutReference:      row.payout_reference || '',
    payoutDate:           row.payout_date || null,
    expectedArrivalDate:  row.expected_arrival_date || null,
    gross:                Number(row.gross_amount) || 0,
    platformFee:          Number(row.platform_fee) || 0,
    adjustments:          Number(row.adjustments) || 0,
    net:                  Number(row.net_amount) || 0,
    currency:             row.currency || 'AUD',
    source:               row.source || 'manual',
    rawSourceText:        row.raw_source_text || '',
    bankTransactionId:    row.bank_transaction_id || null,
    // Needed by payoutSettlementState — without it every payout loaded through
    // loadPlatformPayouts looked 'outstanding' even when the host had marked it
    // received. loadPayoutLinesForBooking already carried this field.
    receivedAt:           row.received_at || null,
    status:               row.status || 'active',
    notes:                row.notes || '',
    createdAt:            row.created_at || null,
    updatedAt:            row.updated_at || null,
  };
}

/** Map a cloud line row to camelCase JS shape. */
function _lineRowToJs(row) {
  if (!row) return null;
  return {
    _cloudId:           row.id,
    payoutId:           row.payout_id,
    bookingId:          row.booking_id || null,
    lineType:           row.line_type || 'other',
    description:        row.description || '',
    amount:             Number(row.amount) || 0,
    confirmationCode:   row.confirmation_code || null,
    confidence:         row.confidence || 'low',
    matchedBy:          row.matched_by || null,
    createdAt:          row.created_at || null,
    updatedAt:          row.updated_at || null,
  };
}

/**
 * Load platform payouts for the current user.
 * Soft-deleted rows (status='deleted') are filtered out by default.
 *
 * opts: { propertyId?, fromDate?, toDate?, includeDeleted? }
 */
export async function loadPlatformPayouts(opts = {}) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return [];
    let query = window._sb.from('platform_payouts').select('*').eq('user_id', user.id);
    if (opts.propertyId) query = query.eq('property_id', opts.propertyId);
    if (opts.fromDate)   query = query.gte('payout_date', opts.fromDate);
    if (opts.toDate)     query = query.lte('payout_date', opts.toDate);
    if (!opts.includeDeleted) {
      // NULL-tolerant in case a legacy row sneaks in without status
      query = query.or('status.is.null,status.neq.deleted');
    }
    const { data, error } = await query.order('payout_date', { ascending: false });
    if (error) { console.warn('[StayOps] loadPlatformPayouts error', error); return []; }
    return (data || []).map(_payoutRowToJs);
  } catch (e) {
    console.warn('[StayOps] loadPlatformPayouts failed', e);
    return [];
  }
}

/** Load all line items for a given payout (by cloud id). */
export async function loadPayoutLines(payoutCloudId) {
  try {
    if (!payoutCloudId) return [];
    const { data, error } = await window._sb
      .from('platform_payout_lines')
      .select('*')
      .eq('payout_id', payoutCloudId)
      .order('created_at', { ascending: true });
    if (error) { console.warn('[StayOps] loadPayoutLines error', error); return []; }
    return (data || []).map(_lineRowToJs);
  } catch (e) {
    console.warn('[StayOps] loadPayoutLines failed', e);
    return [];
  }
}

/**
 * Load all payout lines that link to a specific booking — for the
 * per-booking "expected vs received" view. Returns lines from non-deleted
 * payouts only.
 */
export async function loadPayoutLinesForBooking(bookingCloudId) {
  try {
    if (!bookingCloudId) return [];
    // Single round-trip: join via the FK, RLS already restricts to user's data
    const { data, error } = await window._sb
      .from('platform_payout_lines')
      .select('*, platform_payouts!inner(id,platform,payout_date,payout_reference,status,bank_transaction_id,received_at)')
      .eq('booking_id', bookingCloudId);
    if (error) { console.warn('[StayOps] loadPayoutLinesForBooking error', error); return []; }
    return (data || [])
      .filter(row => (row.platform_payouts?.status || 'active') !== 'deleted')
      .map(row => Object.assign(_lineRowToJs(row), {
        _payout: {
          cloudId:           row.platform_payouts?.id,
          platform:          row.platform_payouts?.platform,
          payoutDate:        row.platform_payouts?.payout_date,
          payoutReference:   row.platform_payouts?.payout_reference,
          bankTransactionId: row.platform_payouts?.bank_transaction_id,
          receivedAt:        row.platform_payouts?.received_at,
        }
      }));
  } catch (e) {
    console.warn('[StayOps] loadPayoutLinesForBooking failed', e);
    return [];
  }
}

/**
 * Insert or update a platform_payouts row.
 * Pass payout._cloudId to update an existing row, omit to create a new one.
 * Returns the saved camelCase payout object (with _cloudId set), or null on error.
 */
/** Find an already-saved payout matching this one.
 *
 *  A platform reference is authoritative when present — the same reference for
 *  the same user IS the same payout. Otherwise fall back to the natural key
 *  (platform + date + net), which is what a pasted statement gives us. Net is
 *  compared with a 1c tolerance because the totals are rolled up from lines and
 *  can differ in the last cent between extractions of the same statement. */
async function findExistingPayout(userId, payload) {
  try {
    const ref = (payload.payout_reference || '').trim();
    if (ref) {
      const { data } = await window._sb.from('platform_payouts')
        .select('*').eq('user_id', userId).eq('payout_reference', ref)
        .neq('status', 'deleted').limit(1);
      if (data && data.length) return data[0];
    }
    if (!payload.payout_date) return null;
    const net = Number(payload.net_amount) || 0;
    const { data } = await window._sb.from('platform_payouts')
      .select('*').eq('user_id', userId)
      .eq('platform', payload.platform)
      .eq('payout_date', payload.payout_date)
      .neq('status', 'deleted')
      .gte('net_amount', net - 0.01)
      .lte('net_amount', net + 0.01)
      .limit(1);
    return (data && data.length) ? data[0] : null;
  } catch (e) {
    // Never block a save because the duplicate check itself failed.
    console.warn('[StayOps] findExistingPayout failed (allowing save)', e);
    return null;
  }
}

export async function savePlatformPayout(payout) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !payout) return null;
    const payload = {
      user_id:              user.id,
      property_id:          payout.propertyId || null,
      platform:             payout.platform || 'other',
      payout_reference:     payout.payoutReference || null,
      payout_date:          payout.payoutDate || null,
      expected_arrival_date: payout.expectedArrivalDate || null,
      gross_amount:         Number(payout.gross) || 0,
      platform_fee:         Number(payout.platformFee) || 0,
      adjustments:          Number(payout.adjustments) || 0,
      net_amount:           Number(payout.net) || 0,
      currency:             payout.currency || 'AUD',
      source:               payout.source || 'manual',
      raw_source_text:      payout.rawSourceText || null,
      bank_transaction_id:  payout.bankTransactionId || null,
      notes:                payout.notes || null,
      updated_at:           new Date().toISOString(),
    };
    // Re-pasting a statement used to insert a second copy of every payout in
    // it — there was no key of any kind. Duplicates are not cosmetic here: they
    // inflate "expected", produce two identical candidates in the match sheet,
    // and manufacture a phantom out-of-balance in the period reconcile.
    //
    // Enforced here rather than with a unique constraint on purpose: two
    // genuinely distinct payouts can share (platform, date, amount), and a hard
    // constraint would fail a legitimate save with a 23505 the host cannot act
    // on. This can say "already imported" instead.
    if (!payout._cloudId && !payout.allowDuplicate) {
      const existing = await findExistingPayout(user.id, payload);
      if (existing) {
        console.log('[StayOps] savePlatformPayout: duplicate skipped', existing.id);
        return Object.assign(_payoutRowToJs(existing), { _duplicate: true });
      }
    }
    let query;
    if (payout._cloudId) {
      query = window._sb.from('platform_payouts')
        .update(payload).eq('id', payout._cloudId).select().single();
    } else {
      query = window._sb.from('platform_payouts')
        .insert(payload).select().single();
    }
    const { data, error } = await query;
    if (error) {
      console.warn('[StayOps] savePlatformPayout error', error);
      if (typeof globalThis.showBanner === 'function') {
        globalThis.showBanner('⚠ Payout save failed — see console', 'warn');
      }
      return null;
    }
    return _payoutRowToJs(data);
  } catch (e) {
    console.warn('[StayOps] savePlatformPayout failed', e);
    return null;
  }
}

/**
 * Bulk-insert lines for a payout. Used by the paste flow once the AI has
 * extracted line items. Returns the inserted lines (with cloud ids), or
 * [] on error.
 */
export async function insertPayoutLines(payoutCloudId, lines) {
  try {
    if (!payoutCloudId || !Array.isArray(lines) || !lines.length) return [];
    const payload = lines.map(l => ({
      payout_id:          payoutCloudId,
      booking_id:         l.bookingId || null,
      line_type:          l.lineType || 'other',
      description:        l.description || null,
      amount:             Number(l.amount) || 0,
      confirmation_code:  l.confirmationCode || null,
      confidence:         l.confidence || 'low',
      matched_by:         l.matchedBy || null,
    }));
    const { data, error } = await window._sb
      .from('platform_payout_lines')
      .insert(payload)
      .select();
    if (error) { console.warn('[StayOps] insertPayoutLines error', error); return []; }
    return (data || []).map(_lineRowToJs);
  } catch (e) {
    console.warn('[StayOps] insertPayoutLines failed', e);
    return [];
  }
}

/**
 * Update a single payout line — typically to link/unlink a booking after
 * the user confirms a match in the reconciliation UI.
 *
 * updates: any of { bookingId, lineType, description, amount, confirmationCode, confidence, matchedBy }
 */
export async function updatePayoutLine(lineCloudId, updates) {
  try {
    if (!lineCloudId || !updates) return null;
    const payload = { updated_at: new Date().toISOString() };
    if ('bookingId'        in updates) payload.booking_id        = updates.bookingId || null;
    if ('lineType'         in updates) payload.line_type         = updates.lineType;
    if ('description'      in updates) payload.description       = updates.description || null;
    if ('amount'           in updates) payload.amount            = Number(updates.amount) || 0;
    if ('confirmationCode' in updates) payload.confirmation_code = updates.confirmationCode || null;
    if ('confidence'       in updates) payload.confidence        = updates.confidence;
    if ('matchedBy'        in updates) payload.matched_by        = updates.matchedBy || null;
    const { data, error } = await window._sb
      .from('platform_payout_lines')
      .update(payload).eq('id', lineCloudId).select().single();
    if (error) { console.warn('[StayOps] updatePayoutLine error', error); return null; }
    return _lineRowToJs(data);
  } catch (e) {
    console.warn('[StayOps] updatePayoutLine failed', e);
    return null;
  }
}

/**
 * Soft-delete a payout (the trigger flips status='deleted' instead of
 * removing the row). The lines stay in the DB but are filtered out by
 * loadPayoutLinesForBooking via the status check.
 */
export async function deletePlatformPayout(payoutCloudId) {
  try {
    if (!payoutCloudId) return false;
    const { error } = await window._sb
      .from('platform_payouts')
      .delete().eq('id', payoutCloudId);
    if (error) { console.warn('[StayOps] deletePlatformPayout error', error); return false; }
    return true;
  } catch (e) {
    console.warn('[StayOps] deletePlatformPayout failed', e);
    return false;
  }
}

/**
 * Phase 2-lite: mark a payout as received without the full bank-CSV
 * reconciliation flow. Stores a date on platform_payouts.received_at.
 * Pass dateStr=null to clear.
 * @param {string} payoutCloudId
 * @param {string|null} dateStr 'YYYY-MM-DD' or null
 */
export async function markPayoutReceived(payoutCloudId, dateStr) {
  try {
    if (!payoutCloudId) return false;
    const { error } = await window._sb
      .from('platform_payouts')
      .update({
        received_at: dateStr || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', payoutCloudId);
    if (error) { console.warn('[StayOps] markPayoutReceived error', error); return false; }
    return true;
  } catch (e) {
    console.warn('[StayOps] markPayoutReceived failed', e);
    return false;
  }
}
