// Netlify/functions/monthly-revenue-summary.js
//
// StayOps — monthly revenue/expense summary push (pg_cron, e.g. 1st of month).
// CommonJS. Uses ./utils/push-helper.js

const { createClient } = require('@supabase/supabase-js');
const { sendPushToHost, hasRecentNotification } = require('./utils/push-helper');
const { captureError, flush } = require('./utils/sentry');

const SYDNEY_TZ = 'Australia/Sydney';

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const want = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === want) return String(headers[k] || '');
  }
  return '';
}

/** Previous calendar month in Australia/Sydney (for "today"), as YYYY-MM-DD bounds + labels. */
function previousMonthRangeSydney(referenceDate) {
  const d = referenceDate instanceof Date ? referenceDate : new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SYDNEY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parseInt(parts.find(p => p.type === 'year').value, 10);
  const m = parseInt(parts.find(p => p.type === 'month').value, 10);

  let py = y;
  let pm = m - 1;
  if (pm < 1) {
    pm = 12;
    py = y - 1;
  }

  const yyyymm = py + '-' + String(pm).padStart(2, '0');
  const firstDay = yyyymm + '-01';
  const lastDate = new Date(py, pm, 0);
  const lastD = lastDate.getDate();
  const lastDay = yyyymm + '-' + String(lastD).padStart(2, '0');

  const monthName = new Date(py, pm - 1, 15).toLocaleString('en-AU', {
    month: 'long',
    timeZone: SYDNEY_TZ,
  });

  return { firstDay, lastDay, yyyymm, monthName, year: py, month: pm };
}

function fmtDollar(n) {
  const x = Number(n) || 0;
  return (
    '$' +
    x.toLocaleString('en-AU', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })
  );
}

async function sumBookingsForProperty(supabaseAdmin, propertyId, firstDay, lastDay) {
  // Use host_payout (what the host actually receives) instead of total_price
  // (which includes platform fees). Frontend dashboards use host_payout, so the
  // monthly email number must match — otherwise hosts see inflated numbers.
  const { data, error } = await supabaseAdmin
    .from('bookings')
    .select('host_payout,status,cancellation_billable')
    .eq('property_id', propertyId)
    .gte('checkin', firstDay)
    .lte('checkin', lastDay);

  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  let gross = 0;
  for (const r of rows) {
    if (String(r.status || '').toLowerCase() === 'cancelled' && r.cancellation_billable !== true) continue;
    gross += Number(r.host_payout) || 0;
  }
  return {
    gross,
    bookingCount: rows.filter(r => String(r.status || '').toLowerCase() !== 'cancelled' || r.cancellation_billable === true).length,
  };
}

async function sumExpensesForProperty(supabaseAdmin, propertyId, firstDay, lastDay) {
  const { data, error } = await supabaseAdmin
    .from('expenses')
    .select('amount')
    .eq('property_id', propertyId)
    .gte('date', firstDay)
    .lte('date', lastDay);

  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  let total = 0;
  for (const r of rows) {
    total += Number(r.amount) || 0;
  }
  return total;
}

exports.handler = async (event) => {
  const method = event.httpMethod || 'GET';
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
  }
  if (method !== 'GET' && method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  // CRON_SECRET is MANDATORY — refuse rather than fail open when it's unset (4.6).
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[StayOps] monthly-revenue-summary: CRON_SECRET not set — refusing request');
    return json(500, { error: 'Server misconfigured' });
  }
  const hdr = getHeader(event.headers, 'x-cron-secret');
  if (hdr !== cronSecret) {
    console.log('[StayOps] monthly-revenue-summary: unauthorized cron request');
    return json(401, { error: 'Unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.log('[StayOps] monthly-revenue-summary: missing Supabase URL or service key');
    return json(500, { error: 'Server misconfigured' });
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseKey);
  const { firstDay, lastDay, yyyymm, monthName } = previousMonthRangeSydney(new Date());

  console.log('[StayOps] monthly-revenue-summary: range', firstDay, '–', lastDay, '(' + yyyymm + ')');

  const perPropertyResults = [];

  try {
    const { data: allProps, error: pErr } = await supabaseAdmin
      .from('properties')
      .select('id, name, user_id')
      .order('created_at', { ascending: true });

    if (pErr) throw new Error('properties query failed: ' + (pErr.message || JSON.stringify(pErr)));

    const props = Array.isArray(allProps) ? allProps : [];
    const byUser = new Map();
    for (const p of props) {
      if (!p || !p.user_id) continue;
      if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
      byUser.get(p.user_id).push(p);
    }

    for (const [userId, userProperties] of byUser) {
      let userTotalGross = 0;
      let userTotalExpenses = 0;
      let userTotalBookings = 0;

      for (const property of userProperties) {
        try {
          const { gross, bookingCount } = await sumBookingsForProperty(
            supabaseAdmin,
            property.id,
            firstDay,
            lastDay
          );
          const expenseSum = await sumExpensesForProperty(supabaseAdmin, property.id, firstDay, lastDay);
          const net = gross - expenseSum;
          userTotalGross += gross;
          userTotalExpenses += expenseSum;
          userTotalBookings += bookingCount;

          perPropertyResults.push({
            property_id: property.id,
            name: property.name,
            gross,
            expenses: expenseSum,
            net,
            bookingCount,
          });

          if (gross > 0 || expenseSum > 0) {
            const refId = property.id + '-' + yyyymm;
            const recent = await hasRecentNotification({
              supabaseAdmin,
              type: 'monthly_summary',
              referenceId: refId,
              withinMinutes: 1440,
            });
            if (!recent) {
              await sendPushToHost({
                supabaseAdmin,
                propertyId: property.id,
                title: '📊 ' + monthName + ' Summary — ' + (property.name || 'Property'),
                body:
                  'Revenue: ' +
                  fmtDollar(gross) +
                  ' · Expenses: ' +
                  fmtDollar(expenseSum) +
                  ' · Net: ' +
                  fmtDollar(net) +
                  ' · ' +
                  bookingCount +
                  ' bookings',
                url: '/finance',
                type: 'monthly_summary',
                referenceId: refId,
              });
            } else {
              console.log('[StayOps] monthly-revenue-summary: skipped duplicate property push', refId);
            }
          }
        } catch (propErr) {
          const msg = propErr && propErr.message ? propErr.message : String(propErr);
          console.log('[StayOps] monthly-revenue-summary: property failed', property.id, msg);
          perPropertyResults.push({
            property_id: property.id,
            name: property.name,
            error: msg,
          });
        }
      }

      if (userProperties.length > 1) {
        const totalNet = userTotalGross - userTotalExpenses;
        if (userTotalGross > 0 || userTotalExpenses > 0) {
          const portfolioRef = 'portfolio-' + userId + '-' + yyyymm;
          try {
            const recentPortfolio = await hasRecentNotification({
              supabaseAdmin,
              type: 'monthly_summary',
              referenceId: portfolioRef,
              withinMinutes: 1440,
            });
            if (!recentPortfolio) {
              const anchorPropertyId = userProperties[0].id;
              await sendPushToHost({
                supabaseAdmin,
                propertyId: anchorPropertyId,
                title: '📊 ' + monthName + ' Portfolio Summary',
                body:
                  'Total Revenue: ' +
                  fmtDollar(userTotalGross) +
                  ' · Expenses: ' +
                  fmtDollar(userTotalExpenses) +
                  ' · Net: ' +
                  fmtDollar(totalNet) +
                  ' · ' +
                  userTotalBookings +
                  ' bookings',
                url: '/finance',
                type: 'monthly_summary',
                referenceId: portfolioRef,
              });
            } else {
              console.log('[StayOps] monthly-revenue-summary: skipped duplicate portfolio push', portfolioRef);
            }
          } catch (portErr) {
            const msg = portErr && portErr.message ? portErr.message : String(portErr);
            console.log('[StayOps] monthly-revenue-summary: portfolio push failed', msg);
          }
        }
      }
    }

    console.log('[StayOps] Monthly revenue summary complete');
    return json(200, {
      // Don't return per-tenant financials in the response body — this is a
      // cron endpoint and the push notifications already deliver each host
      // their own numbers. Return only a processed count (4.6).
      success: true,
      month: yyyymm,
      propertiesProcessed: Array.isArray(perPropertyResults) ? perPropertyResults.length : 0,
    });
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.log('[StayOps] monthly-revenue-summary: fatal', message);
    captureError(e, { tags: { function: 'monthly-revenue-summary' } });
    await flush();
    return json(500, { success: false, error: message });
  }
};
