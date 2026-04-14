const { createClient } = require('@supabase/supabase-js');
const { sendPushToHost } = require('./utils/push-helper.js');
const { captureError, flush } = require('./utils/sentry');

const ALLOWED_CATEGORIES = new Set([
  'cleaning',
  'maintenance',
  'supplies',
  'utilities',
  'insurance',
  'council_rates',
  'strata',
  'mortgage',
  'advertising',
  'other',
]);

exports.handler = async (event) => {
  const CRON_SECRET = process.env.CRON_SECRET;
  const headerSecret = event.headers && (event.headers['x-cron-secret'] || event.headers['X-Cron-Secret']);
  if (CRON_SECRET && headerSecret !== CRON_SECRET) {
    return json(401, { error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !ANTHROPIC_KEY) {
    return json(500, { error: 'Server misconfigured' });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const summary = { success: true, processed: 0, skipped: 0, errors: [] };

  try {
    const { data: appConfigs, error: cfgErr } = await supabaseAdmin
      .from('app_config')
      .select('user_id,gmail_email,gmail_refresh_token')
      .not('gmail_refresh_token', 'is', null);
    if (cfgErr) throw new Error('app_config query failed: ' + (cfgErr.message || JSON.stringify(cfgErr)));

    const users = Array.isArray(appConfigs) ? appConfigs : [];
    for (const cfg of users) {
      try {
        const userId = cfg.user_id;
        if (!userId) continue;

        const accessToken = await getGmailAccessToken({
          gmailRefreshToken: cfg.gmail_refresh_token,
          googleClientId: GOOGLE_CLIENT_ID,
          googleClientSecret: GOOGLE_CLIENT_SECRET,
        });
        if (!accessToken) {
          summary.errors.push('[StayOps] Token refresh failed for user ' + userId);
          continue;
        }

        const labels = await gmailGet('https://www.googleapis.com/gmail/v1/users/me/labels', accessToken);
        const allLabels = (labels && labels.labels) || [];
        const processedLabel = allLabels.find((l) => normalize(l.name) === 'stayops/processed');
        const processedLabelId = processedLabel && processedLabel.id;

        const propertyLabels = allLabels.filter((l) => {
          const n = normalize(l.name);
          if (!n.startsWith('stayops')) return false;
          if (n === 'stayops') return false;
          if (n === 'stayops/processed') return false;
          return n.startsWith('stayops/');
        });

        const labelToProperty = new Map();
        propertyLabels.forEach((l) => {
          const parts = String(l.name || '').split('/');
          const propertyName = String(parts.slice(1).join('/')).trim();
          if (l.id && propertyName) labelToProperty.set(l.id, propertyName);
        });

        for (const [propertyLabelId, propertyName] of labelToProperty.entries()) {
          let listData = null;
          try {
            listData = await gmailGet(
              'https://www.googleapis.com/gmail/v1/users/me/messages?labelIds=' +
                encodeURIComponent(propertyLabelId) +
                '&maxResults=10',
              accessToken
            );
          } catch (e) {
            summary.errors.push('[StayOps] Message list failed for user ' + userId + ': ' + (e.message || e));
            continue;
          }

          const messages = (listData && listData.messages) || [];
          for (const msg of messages) {
            const messageId = msg && msg.id;
            if (!messageId) {
              summary.skipped++;
              continue;
            }

            try {
              const { data: existingLog, error: logCheckErr } = await supabaseAdmin
                .from('expense_email_log')
                .select('id')
                .eq('gmail_message_id', messageId)
                .limit(1);
              if (logCheckErr) throw new Error('expense_email_log check failed: ' + (logCheckErr.message || JSON.stringify(logCheckErr)));
              if (Array.isArray(existingLog) && existingLog.length) {
                summary.skipped++;
                continue;
              }

              const fullMessage = await gmailGet(
                'https://www.googleapis.com/gmail/v1/users/me/messages/' + encodeURIComponent(messageId) + '?format=full',
                accessToken
              );
              const extracted = await extractMessagePayload(fullMessage, accessToken, messageId);

              const parsed = await parseExpenseWithHaiku({
                apiKey: ANTHROPIC_KEY,
                subject: extracted.subject,
                from: extracted.from,
                dateHeader: extracted.dateHeader,
                bodyText: extracted.bodyText,
                attachmentText: extracted.attachmentText,
              });
              if (!isValidParsedExpense(parsed)) {
                console.warn('[StayOps] Invalid parsed expense for message', messageId, parsed);
                summary.skipped++;
                continue;
              }

              const { data: property, error: propertyErr } = await supabaseAdmin
                .from('properties')
                .select('id,name')
                .eq('name', propertyName)
                .eq('user_id', userId)
                .maybeSingle();
              if (propertyErr) throw new Error('property lookup failed: ' + (propertyErr.message || JSON.stringify(propertyErr)));
              if (!property || !property.id) {
                console.warn('[StayOps] Property not found for label', propertyName, 'user', userId);
                summary.skipped++;
                continue;
              }

              const expensePayload = {
                user_id: userId,
                property_id: property.id,
                amount: Number(parsed.amount),
                gst: parsed.gst == null ? null : Number(parsed.gst),
                category: parsed.category,
                date: parsed.date,
                description: parsed.description,
                vendor: parsed.vendor,
                local_id: 'gmail-expense-' + messageId,
                receipt_url: null,
                updated_at: new Date().toISOString(),
              };

              const { data: insertedExpense, error: insertErr } = await supabaseAdmin
                .from('expenses')
                .insert(expensePayload)
                .select('id')
                .single();
              if (insertErr) throw new Error('expense insert failed: ' + (insertErr.message || JSON.stringify(insertErr)));

              const { error: logInsertErr } = await supabaseAdmin
                .from('expense_email_log')
                .insert({
                  gmail_message_id: messageId,
                  user_id: userId,
                  property_id: property.id,
                  expense_id: insertedExpense.id,
                  vendor: parsed.vendor,
                  amount: Number(parsed.amount),
                });
              if (logInsertErr) throw new Error('expense_email_log insert failed: ' + (logInsertErr.message || JSON.stringify(logInsertErr)));

              try {
                await sendPushToHost({
                  supabaseAdmin,
                  propertyId: property.id,
                  title: '🧾 Invoice Imported — ' + propertyName,
                  body: parsed.vendor + ' · $' + Number(parsed.amount).toFixed(2) + ' · ' + parsed.category,
                  url: '/finance',
                  type: 'expense_imported',
                  referenceId: insertedExpense.id,
                });
              } catch (pushErr) {
                console.warn('[StayOps] Expense import push failed:', pushErr && pushErr.message ? pushErr.message : pushErr);
              }

              if (processedLabelId) {
                await gmailPost(
                  'https://www.googleapis.com/gmail/v1/users/me/messages/' + encodeURIComponent(messageId) + '/modify',
                  accessToken,
                  {
                    addLabelIds: [processedLabelId],
                    removeLabelIds: [propertyLabelId],
                  }
                );
              }

              summary.processed++;
            } catch (emailErr) {
              console.error('[StayOps] Error processing message', messageId, emailErr);
              summary.skipped++;
              summary.errors.push('[StayOps] Message ' + messageId + ': ' + (emailErr && emailErr.message ? emailErr.message : String(emailErr)));
            }
          }
        }
      } catch (userErr) {
        console.error('[StayOps] Error processing user', cfg && cfg.user_id, userErr);
        summary.errors.push('[StayOps] User ' + (cfg && cfg.user_id ? cfg.user_id : 'unknown') + ': ' + (userErr && userErr.message ? userErr.message : String(userErr)));
      }
    }

    return json(200, summary);
  } catch (err) {
    console.error('[StayOps] gmail-scan-expenses fatal error:', err);
    captureError(err, { tags: { function: 'gmail-scan-expenses' } });
    await flush();
    return json(500, {
      success: false,
      processed: summary.processed,
      skipped: summary.skipped,
      errors: summary.errors.concat('[StayOps] Fatal: ' + (err && err.message ? err.message : String(err))),
    });
  }
};

async function getGmailAccessToken({ gmailRefreshToken, googleClientId, googleClientSecret }) {
  const refreshToken = gmailRefreshToken || null;
  if (!refreshToken) return null;

  // Keep this refresh pattern aligned with gmail-scan-bookings.js.
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: googleClientId,
      client_secret: googleClientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    console.error('[StayOps] Token refresh failed:', tokenData);
    return null;
  }
  return tokenData.access_token;
}

async function gmailGet(url, accessToken) {
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error('Gmail GET failed (' + res.status + '): ' + JSON.stringify(data));
  }
  return data;
}

async function gmailPost(url, accessToken, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error('Gmail POST failed (' + res.status + '): ' + text);
  }
  return text ? JSON.parse(text) : {};
}

async function extractMessagePayload(message, accessToken, messageId) {
  const payload = (message && message.payload) || {};
  const headers = payload.headers || [];
  const subject = getHeader(headers, 'Subject');
  const from = getHeader(headers, 'From');
  const dateHeader = getHeader(headers, 'Date');

  let plain = '';
  let html = '';
  const attachmentTexts = [];
  const parts = [];

  function walk(part) {
    if (!part) return;
    parts.push(part);
    if (part.parts && Array.isArray(part.parts)) part.parts.forEach(walk);
  }
  walk(payload);

  for (const p of parts) {
    if (p.mimeType === 'text/plain' && p.body && p.body.data) plain += decodeBase64Url(p.body.data) + '\n';
    if (p.mimeType === 'text/html' && p.body && p.body.data) html += decodeBase64Url(p.body.data) + '\n';
  }

  const bodyText = plain.trim() ? plain.trim() : stripHtml(html).trim();

  for (const p of parts) {
    const filename = String(p.filename || '').toLowerCase();
    const attachmentId = p.body && p.body.attachmentId;
    if (!attachmentId) continue;
    if (!filename.endsWith('.pdf') && p.mimeType !== 'application/pdf') continue;
    try {
      const att = await gmailGet(
        'https://www.googleapis.com/gmail/v1/users/me/messages/' +
          encodeURIComponent(messageId) +
          '/attachments/' +
          encodeURIComponent(attachmentId),
        accessToken
      );
      const raw = att && att.data ? decodeBase64Url(att.data, true) : Buffer.alloc(0);
      const text = extractLikelyPdfText(raw);
      if (text) attachmentTexts.push(text);
    } catch (e) {
      console.warn('[StayOps] PDF attachment fetch failed for', messageId, e.message || e);
    }
  }

  return {
    subject: subject || '',
    from: from || '',
    dateHeader: dateHeader || '',
    bodyText: (bodyText || '').slice(0, 15000),
    attachmentText: attachmentTexts.join('\n\n').slice(0, 15000),
  };
}

async function parseExpenseWithHaiku({ apiKey, subject, from, dateHeader, bodyText, attachmentText }) {
  const system = 'You are an invoice/receipt parser for a property management app. Extract the following from this email/invoice. Respond ONLY in JSON, no markdown:\n' +
    '{\n' +
    '  "vendor": "string (company/person name)",\n' +
    '  "amount": "number (total amount in AUD, excluding GST if GST is listed separately)",\n' +
    '  "gst": "number or null (GST amount if listed, null if not)",\n' +
    '  "date": "string (invoice date in YYYY-MM-DD format)",\n' +
    '  "category": "one of: cleaning, maintenance, supplies, utilities, insurance, council_rates, strata, mortgage, advertising, other",\n' +
    '  "description": "brief 1-line description of what was purchased/serviced"\n' +
    '}';

  const userContent =
    'Subject: ' + (subject || '') + '\n' +
    'From: ' + (from || '') + '\n' +
    'Date header: ' + (dateHeader || '') + '\n\n' +
    'Email body:\n' + (bodyText || '') + '\n\n' +
    'Attachment text (if any):\n' + (attachmentText || '');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      system,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Claude API failed: ' + JSON.stringify(data));
  const text = data && data.content && data.content[0] && data.content[0].text ? data.content[0].text.trim() : '';
  if (!text) throw new Error('Claude returned empty response');
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

function isValidParsedExpense(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  const amount = Number(parsed.amount);
  if (!(amount > 0)) return false;
  const dateStr = String(parsed.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  if (Number.isNaN(new Date(dateStr + 'T00:00:00Z').getTime())) return false;
  const category = String(parsed.category || '').toLowerCase().trim();
  if (!ALLOWED_CATEGORIES.has(category)) return false;
  return true;
}

function getHeader(headers, name) {
  if (!Array.isArray(headers)) return '';
  const h = headers.find((x) => x && String(x.name || '').toLowerCase() === String(name).toLowerCase());
  return h ? String(h.value || '') : '';
}

function decodeBase64Url(data, asBuffer) {
  const safe = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = safe + '='.repeat((4 - (safe.length % 4)) % 4);
  const buf = Buffer.from(pad, 'base64');
  return asBuffer ? buf : buf.toString('utf-8');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLikelyPdfText(buffer) {
  if (!buffer || !buffer.length) return '';
  const text = buffer.toString('latin1');
  const matches = text.match(/\(([^()]{4,400})\)/g) || [];
  const joined = matches
    .map((m) => m.slice(1, -1))
    .join(' ')
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\//g, '/')
    .replace(/\s+/g, ' ')
    .trim();
  return joined.slice(0, 12000);
}

function normalize(v) {
  return String(v || '').trim().toLowerCase();
}

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
