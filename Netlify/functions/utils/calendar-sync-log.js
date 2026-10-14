/**
 * StayOps — calendar sync audit log.
 *
 * Writes one row per meaningful sync decision to public.calendar_sync_log so
 * that "why did this booking change?" can be answered from the app's own
 * data instead of raw request logs. The table has existed since the calendar
 * sync migration but nothing wrote to it before the Annie Parker incident
 * (a booking silently cancelled because its Google event was deleted).
 *
 * Best-effort: never throws, never blocks the caller.
 *
 *   direction: 'to_provider' (app → calendar) | 'to_local' (calendar → app)
 *   op:        short verb — 'insert','update','delete','cancel','restore',
 *              'relink','skip','error'
 */

const { sbHeaders } = require('./calendar-token');

async function logSync({ userId, provider, direction, localTable, localId, providerEventId, op, message }) {
  try {
    if (!process.env.SUPABASE_URL || !userId) return;
    const row = {
      user_id: userId,
      provider: provider || null,
      direction: direction === 'to_provider' ? 'to_provider' : 'to_local',
      local_table: localTable || null,
      local_id: localId != null ? String(localId) : null,
      provider_event_id: providerEventId != null ? String(providerEventId) : null,
      op: op || null,
      message: message != null ? String(message).slice(0, 500) : null,
    };
    await fetch(process.env.SUPABASE_URL + '/rest/v1/calendar_sync_log', {
      method: 'POST',
      headers: { ...sbHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
  } catch (e) {
    console.warn('[calendar-sync-log] write failed:', e && e.message);
  }
}

module.exports = { logSync };
