/**
 * StayOps — cleaner PWA (email / Supabase-auth): the cleaner-facing app shown after a
 * cleaner signs in with their email. Renders My Cleans (a day plan: Today / Tomorrow /
 * Upcoming, sorted by turnover deadline) + Calendar + Profile, and handles
 * accept / decline / start / finish / acknowledge, become-a-host, and the team invite
 * button. The legacy link/PIN login path was removed 2026-07-10 (cleaners log in by email).
 *
 * Data comes from loadCleanerDashboard() (supabase.js):
 *   { cleanerRecord, myCleans, host, hosts, hostByUserId }
 * Each clean is a raw `cleans` row (+ `properties` join incl. check_in_info) annotated by
 * annotateCleanerCleans() (utils.js) with _checkoutTime / _nextCheckinDate /
 * _nextCheckinTime / _nextGuests / _sameDayTurnover / _deadlineMinutes / _bookingCancelled.
 * The Today view sorts and labels by those; nothing here re-derives them.
 *
 * "Message host" is deliberately NOT an in-app inbox: it is an sms: link that opens the
 * phone's messaging app with the host's number (host_config.phone via the RPC) and a
 * pre-filled first line naming the property and clean date.
 *
 * render.js re-exports cleanerSignOut for main.js; the window/globalThis self-bridges
 * below are what the inline onclick handlers depend on. Cross-module calls are guarded
 * on globalThis/window except escHtml/localDateStr (utils) + renderHeaderDateBadge (render).
 */
import { escHtml, localDateStr } from './utils.js';
import { renderHeaderDateBadge } from './render.js';

export function cleanerSignOut() {
  const signOutPromise = window._sb ? window._sb.auth.signOut() : Promise.resolve();
  signOutPromise.finally(() => {
    window._cleanerData = null;
    document.body.classList.remove('cleaner-mode');
    const cleanerNav = document.getElementById('cleaner-nav');
    const cleanerContent = document.getElementById('cleaner-content');
    if (cleanerNav) cleanerNav.style.display = 'none';
    if (cleanerContent) cleanerContent.style.display = 'none';
    if (typeof showLoginScreen === 'function') showLoginScreen();
  });
}

// ── formatting ─────────────────────────────────────────────────────────────
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayStart(dateStr) { return new Date(String(dateStr).slice(0, 10) + 'T00:00:00'); }

/** "2026-10-12" -> "Sat, 12 Oct" */
function fmtDay(dateStr) {
  if (!dateStr) return '';
  const d = dayStart(dateStr);
  if (Number.isNaN(d.getTime())) return String(dateStr);
  return DAY_NAMES[d.getDay()] + ', ' + d.getDate() + ' ' + MONTH_NAMES[d.getMonth()];
}

/** "10:00" -> "10am", "15:30" -> "3:30pm" */
function fmtClock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  if (!m) return '';
  const h = Number(m[1]), mi = Number(m[2]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + (mi ? ':' + String(mi).padStart(2, '0') : '') + (h >= 12 ? 'pm' : 'am');
}

/** ISO timestamp -> "10:42am" (device local time) */
function fmtStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return fmtClock(String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'));
}

function addDays(dateStr, n) {
  const d = dayStart(dateStr);
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

const TONE = {
  red:   { bg: '#FCEBEB', fg: '#A32D2D' },
  amber: { bg: '#FAEEDA', fg: '#854F0B' },
  green: { bg: '#E1F5EE', fg: '#0F6E56' },
  blue:  { bg: '#E6F1FB', fg: '#185FA5' },
  grey:  { bg: '#F1EFE8', fg: '#5F5E5A' },
};
function tonePill(label, tone) {
  const t = TONE[tone] || TONE.grey;
  return '<span style="display:inline-block;font-size:11px;font-weight:500;background:' + t.bg + ';color:' + t.fg + ';padding:3px 10px;border-radius:12px;white-space:nowrap">' + label + '</span>';
}

function sectionHeader(label, count, colour, first) {
  return '<div style="display:flex;align-items:center;gap:6px;margin:' + (first ? '0' : '22px') + ' 0 12px">' +
    '<div style="width:8px;height:8px;border-radius:50%;background:' + colour + '"></div>' +
    '<span style="font-size:12px;font-weight:500;color:' + colour + ';text-transform:uppercase;letter-spacing:0.4px">' + escHtml(label) + '</span>' +
    (count != null ? '<span style="font-size:11px;color:#999;margin-left:2px">' + count + '</span>' : '') +
  '</div>';
}

// ── host contact / Message host ────────────────────────────────────────────
function hostForClean(data, c) {
  if (!data) return null;
  const byUid = data.hostByUserId || {};
  return (c && c.user_id && byUid[String(c.user_id)]) || data.host || null;
}

function hostFirstName(host) {
  const n = String((host && host.name) || '').trim();
  return n ? n.split(/\s+/)[0] : '';
}

/**
 * sms: link that opens the phone's messaging app on the host's number with a
 * pre-filled first line. `?&body=` is the cross-platform form (iOS wants `&`,
 * Android `?`) — the same trick the host side uses in notifications.js.
 * Returns '' when the host has no phone number on file.
 */
export function smsHref(phone, body) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  return 'sms:' + digits + '?&body=' + encodeURIComponent(body || '');
}

/** "Hi Michel, re Seaview clean Sat, 12 Oct: " — context so the host needn't ask. */
function messageHostBody(host, c) {
  const first = hostFirstName(host);
  const prop = c && c.properties && c.properties.name;
  let body = 'Hi' + (first ? ' ' + first : '') + ',';
  if (c && (prop || c.clean_date)) {
    body += ' re ' + (prop ? prop : 'the') + ' clean' + (c.clean_date ? ' ' + fmtDay(c.clean_date) : '') + ':';
  }
  return body + ' ';
}

function messageHostLink(data, c, compact) {
  const host = hostForClean(data, c);
  const href = host ? smsHref(host.phone, messageHostBody(host, c)) : '';
  if (!href) {
    return compact ? '' : '<div style="margin-top:8px;font-size:11px;color:#999;text-align:center">Your host hasn\'t added a phone number yet</div>';
  }
  const style = compact
    ? 'display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#2f5d4e;font-weight:500;text-decoration:none;padding:4px 0'
    : 'display:flex;align-items:center;justify-content:center;gap:6px;width:100%;box-sizing:border-box;padding:10px;background:#f7f9f8;color:#2f5d4e;border:1px solid #d5ded9;border-radius:8px;font-weight:500;font-size:13px;text-decoration:none';
  return '<a href="' + escHtml(href) + '" style="' + style + '">💬 Message host</a>';
}

// ── cards ──────────────────────────────────────────────────────────────────
const BTN_PRIMARY = 'flex:1;padding:11px;background:#2f5d4e;color:white;border:none;border-radius:8px;font-weight:500;font-size:13px;cursor:pointer';
const BTN_GHOST   = 'flex:1;padding:11px;background:transparent;color:#2f5d4e;border:1px solid #ccc;border-radius:8px;font-weight:500;font-size:13px;cursor:pointer';
const BTN_DANGER  = 'flex:1;padding:11px;background:transparent;color:#A32D2D;border:1px solid #F09595;border-radius:8px;font-weight:500;font-size:13px;cursor:pointer';

function actionBtn(action, cleanId, label, style) {
  return '<button type="button" data-action="' + action + '" data-clean-id="' + escHtml(String(cleanId)) + '" style="' + style + '">' + label + '</button>';
}

function propertyBlock(prop) {
  return '<div style="margin-top:10px;padding:10px 12px;background:#f7f7f5;border-radius:6px">' +
    '<div style="font-size:13px;font-weight:500;color:#333">' + escHtml(prop.name || 'Property') + '</div>' +
    (prop.address ? '<div style="font-size:12px;color:#888;margin-top:1px">' + escHtml(prop.address) + '</div>' : '') +
  '</div>';
}

/**
 * The per-property cheat sheet (properties.check_in_info, edited by the host in
 * Property → Access & Rules). On the day of the clean the lockbox row sits above
 * the fold behind a "Show code" tap; before the day the code is withheld.
 */
function cheatSheet(info, isDay) {
  if (!info.lockbox_code && !info.instructions && !info.wifi && !info.cleaner_notes) return '';
  const row = (label, value) =>
    '<div style="display:flex;gap:10px;padding:6px 0;border-top:1px solid #ebebe7"><span style="color:#888;flex:0 0 68px">' + label + '</span><span style="color:#333;white-space:pre-wrap;word-break:break-word">' + escHtml(String(value)) + '</span></div>';

  let lockbox = '';
  if (info.lockbox_code) {
    lockbox = '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0"><span style="color:#888;flex:0 0 68px">Lockbox</span>' +
      (isDay
        ? '<button type="button" data-action="reveal_code" data-code="' + escHtml(String(info.lockbox_code)) + '" style="background:#2f5d4e;color:white;border:none;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:500;cursor:pointer">Show code</button>'
        : '<span style="color:#999;font-size:12px">Code shows on the day</span>') +
    '</div>';
  }
  let rows = '';
  if (info.instructions) rows += row('Getting in', info.instructions);
  if (info.wifi) rows += row('Wi-Fi', info.wifi);
  if (info.cleaner_notes) rows += row('Notes', info.cleaner_notes);

  return '<div style="margin-top:8px;padding:4px 12px 6px;background:#f7f7f5;border-radius:6px;font-size:12px">' +
    lockbox +
    (rows
      ? '<details' + (lockbox ? ' style="border-top:1px solid #ebebe7"' : '') + '>' +
          '<summary style="cursor:pointer;padding:7px 0;font-weight:500;color:#333;list-style:none;display:flex;justify-content:space-between;align-items:center"><span>Property notes</span><span style="color:#999;font-weight:400">▾</span></summary>' +
          rows +
        '</details>'
      : '') +
  '</div>';
}

/**
 * One clean. mode: 'overdue' | 'today' | 'tomorrow' | 'later'.
 *  - header: property name + "Guest out 10am · Guest · 4 guests"
 *  - deadline pill: red "Next guest 3pm" (same-day turnover) / grey "Next guest Thu, 16 Oct" / "No arrival booked"
 *  - status: Awaiting your response / Confirmed / In progress since 10:42am
 *  - on the day: Start clean → Finish clean (or Mark done); before: Accept / Decline only
 *  - Message host everywhere (full button on the day or when awaiting, text link otherwise)
 */
function cleanCard(data, c, mode) {
  const isDay = mode === 'today' || mode === 'overdue';
  const prop = c.properties || {};
  const info = (prop.check_in_info && typeof prop.check_in_info === 'object') ? prop.check_in_info : {};
  const awaiting = !c.cleaner_confirmed && !c.cleaner_declined;
  const started = !!c.started_at && !c.done;
  const sameDay = !!c._sameDayTurnover;

  const border = mode === 'overdue' ? '#A32D2D'
    : (sameDay && isDay) ? '#E24B4A'
    : started ? '#185FA5'
    : awaiting ? '#EF9F27'
    : mode === 'later' ? '#D8D6CE'
    : '#1D9E75';

  let deadline;
  if (mode === 'overdue') deadline = tonePill('Overdue', 'red');
  else if (sameDay) deadline = tonePill('Next guest ' + fmtClock(c._nextCheckinTime) + (isDay ? '' : ' same day'), isDay ? 'red' : 'amber');
  else if (c._nextCheckinDate) deadline = tonePill('Next guest ' + fmtDay(c._nextCheckinDate), 'grey');
  else deadline = tonePill('No arrival booked', 'grey');

  let status = '';
  if (started) status = tonePill('In progress · since ' + fmtStamp(c.started_at), 'blue');
  else if (awaiting) status = tonePill('Awaiting your response', 'amber');
  else if (c.cleaner_confirmed) status = tonePill('Confirmed', 'green');

  const guests = c._booking && c._booking.guests != null ? Number(c._booking.guests) : null;
  const guestLine = [
    'Guest out ' + fmtClock(c._checkoutTime || '10:00'),
    escHtml(c.guest_name || 'Guest'),
    guests ? guests + (guests === 1 ? ' guest' : ' guests') : '',
  ].filter(Boolean).join(' · ');

  let html = '<div style="background:white;border:0.5px solid #eee;border-left:3px solid ' + border + ';border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:10px">';
  html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">';
  html += '<div style="min-width:0">';
  if (!isDay) html += '<div style="font-size:11px;font-weight:500;color:#888;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:2px">' + fmtDay(c.clean_date) + '</div>';
  html += '<div style="font-size:17px;font-weight:500;color:var(--ink-1);line-height:1.25">' + escHtml(prop.name || 'Property') + '</div>';
  html += '<div style="font-size:13px;color:#888;margin-top:3px">' + guestLine + '</div>';
  if (prop.address) html += '<div style="font-size:12px;color:#aaa;margin-top:2px">' + escHtml(prop.address) + '</div>';
  html += '</div>';
  html += '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">' + deadline + status + '</div>';
  html += '</div>';

  if (c.notes) {
    html += '<div style="margin-top:10px;padding:9px 12px;background:#FFF8E6;border-radius:6px;font-size:12px;color:#5a4a1a;white-space:pre-wrap"><span style="font-weight:500">Note from host:</span> ' + escHtml(c.notes) + '</div>';
  }

  html += cheatSheet(info, isDay);

  if (awaiting) {
    html += '<div style="display:flex;gap:8px;margin-top:12px">' + actionBtn('accept', c.id, 'Accept', BTN_PRIMARY) + actionBtn('decline', c.id, 'Decline', BTN_DANGER) + '</div>';
  } else if (isDay) {
    html += '<div style="display:flex;gap:8px;margin-top:12px">';
    if (started) html += actionBtn('done', c.id, 'Finish clean', BTN_PRIMARY);
    else html += actionBtn('start', c.id, 'Start clean', BTN_PRIMARY) + actionBtn('done', c.id, 'Mark done', BTN_GHOST);
    html += '</div>';
  }

  const compact = !isDay && !awaiting;
  const msg = messageHostLink(data, c, compact);
  if (msg) html += '<div style="margin-top:8px' + (compact ? ';text-align:right' : '') + '">' + msg + '</div>';

  html += '</div>';
  return html;
}

function cancelledCard(c) {
  const prop = c.properties || {};
  let html = '<div style="background:white;border:0.5px solid #eee;border-left:3px solid #C0392B;border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:10px">';
  html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">';
  html += '<div>';
  html += '<div style="font-size:17px;font-weight:500;color:var(--ink-1);text-decoration:line-through">' + fmtDay(c.clean_date) + '</div>';
  html += '<div style="font-size:13px;color:#888;margin-top:2px;text-decoration:line-through">' + escHtml(c.guest_name || 'Guest') + '</div>';
  html += '</div>';
  html += tonePill('Booking cancelled', 'red');
  html += '</div>';
  html += propertyBlock(prop);
  if (c.cleaner_cancel_acknowledged) {
    html += '<div style="margin-top:10px;font-size:12px;color:#0F6E56;font-weight:500">✓ Acknowledged</div>';
  } else {
    html += '<div style="display:flex;margin-top:10px">' + actionBtn('acknowledge_cancel', c.id, 'Acknowledge cancellation', BTN_PRIMARY.replace('flex:1', 'width:100%')) + '</div>';
  }
  html += '</div>';
  return html;
}

function completedCard(c) {
  const prop = c.properties || {};
  return '<div style="background:#f9f9f7;border:0.5px solid #eee;border-radius:8px;padding:12px 16px;margin-bottom:8px;opacity:0.7">' +
    '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<div>' +
        '<div style="font-size:14px;font-weight:500;color:#555">' + fmtDay(c.clean_date) + '</div>' +
        '<div style="font-size:12px;color:#999;margin-top:1px">' + escHtml(c.guest_name || '') + (prop.name ? ' · ' + escHtml(prop.name) : '') + '</div>' +
      '</div>' +
      '<div style="font-size:11px;color:#999">Done' + (c.completed_at ? ' ' + fmtStamp(c.completed_at) : '') + '</div>' +
    '</div></div>';
}

// ── My Cleans (day plan) ───────────────────────────────────────────────────
function renderNewCleanerView(data) {
  if (!data) return;
  const cleanerRecord = data.cleanerRecord || {};
  const all = Array.isArray(data.myCleans) ? data.myCleans : [];

  // Hide FAB — cleaners don't need the quick-add button
  const fab = document.querySelector('.fab');
  if (fab) fab.style.display = 'none';
  const qaFab = document.getElementById('quick-add-fab');
  if (qaFab) qaFab.style.display = 'none';

  // Set header date badge (normally only set during host init)
  renderHeaderDateBadge();

  const container = document.getElementById('cleaner-section-cleans');
  if (!container) return;

  const todayStr = localDateStr(new Date());
  const tomorrowStr = addDays(todayStr, 1);

  const cancelled = all.filter(c => c._bookingCancelled && !c.done);
  const active = all.filter(c => !c._bookingCancelled && !c.cleaner_declined);
  const open = active.filter(c => !c.done);
  const overdue  = open.filter(c => c.clean_date && c.clean_date < todayStr);
  const today    = open.filter(c => c.clean_date === todayStr);
  const tomorrow = open.filter(c => c.clean_date === tomorrowStr);
  const later    = open.filter(c => c.clean_date && c.clean_date > tomorrowStr);
  const completed = active.filter(c => c.done)
    .sort((a, b) => String(b.completed_at || b.clean_date || '').localeCompare(String(a.completed_at || a.clean_date || '')));

  // Order within a day by the binding deadline (annotateCleanerCleans): same-day
  // turnovers first by the next guest's arrival, then by checkout, the longest
  // vacancy last. Ties fall back to property name so the order is stable.
  const propName = c => (c.properties && c.properties.name) || '';
  const key = c => (Number.isFinite(c._deadlineMinutes) ? c._deadlineMinutes : Number.MAX_SAFE_INTEGER);
  const byDeadline = (a, b) => (key(a) - key(b)) || propName(a).localeCompare(propName(b));
  const byDateThenDeadline = (a, b) => String(a.clean_date).localeCompare(String(b.clean_date)) || byDeadline(a, b);
  overdue.sort(byDateThenDeadline);
  today.sort(byDeadline);
  tomorrow.sort(byDeadline);
  later.sort(byDateThenDeadline);

  const greeting = document.getElementById('cleaner-greeting');
  if (greeting) {
    const n = today.length;
    const turnovers = today.filter(c => c._sameDayTurnover).length;
    let line = 'Hi ' + (cleanerRecord.name || 'there');
    if (n) line += ' · ' + n + ' clean' + (n === 1 ? '' : 's') + ' today' + (turnovers ? ', ' + turnovers + ' same-day turnover' + (turnovers === 1 ? '' : 's') : '');
    else if (all.length) line += ' · nothing on today';
    greeting.textContent = line;
  }

  let html = '';
  if (!all.length) {
    html = '<div style="text-align:center;padding:40px 20px;color:#999"><div style="font-size:40px;margin-bottom:12px">✨</div><div style="font-size:15px;font-weight:500">No cleans assigned yet</div><div style="font-size:13px;margin-top:6px">Your host will assign cleans to you here.</div></div>';
  } else {
    if (cancelled.length) {
      html += sectionHeader('Cancelled', cancelled.length, '#C0392B', !html);
      html += cancelled.map(cancelledCard).join('');
    }
    if (overdue.length) {
      html += sectionHeader('Overdue', overdue.length, '#A32D2D', !html);
      html += overdue.map(c => cleanCard(data, c, 'overdue')).join('');
    }
    html += sectionHeader('Today · ' + fmtDay(todayStr), today.length, today.length ? '#2f5d4e' : '#999', !html);
    html += today.length
      ? today.map(c => cleanCard(data, c, 'today')).join('')
      : '<div style="padding:16px;background:#f7f7f5;border-radius:8px;color:#888;font-size:13px;text-align:center">Nothing on today</div>';
    if (tomorrow.length) {
      html += sectionHeader('Tomorrow · ' + fmtDay(tomorrowStr), tomorrow.length, '#854F0B', false);
      html += tomorrow.map(c => cleanCard(data, c, 'tomorrow')).join('');
    }
    if (later.length) {
      html += sectionHeader('Upcoming', later.length, '#5F5E5A', false);
      html += later.map(c => cleanCard(data, c, 'later')).join('');
    }
    if (completed.length) {
      html += sectionHeader('Completed', completed.length, '#999', false);
      html += completed.slice(0, 10).map(completedCard).join('');
    }
  }

  container.innerHTML = html;

  if (!container._cleanerDelegated) {
    container.addEventListener('click', async function (e) {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      const action = btn.getAttribute('data-action');

      if (action === 'reveal_code') {
        const code = document.createElement('span');
        code.style.cssText = 'font-family:\'JetBrains Mono\',monospace;font-weight:600;font-size:16px;color:#1c2620;letter-spacing:1px';
        code.textContent = btn.getAttribute('data-code') || '';
        btn.replaceWith(code);
        return;
      }

      const cleanId = btn.getAttribute('data-clean-id');
      if (!cleanId) return;
      const labels = { accept: 'Accepting…', decline: 'Declining…', start: 'Starting…', done: 'Finishing…', acknowledge_cancel: 'Acknowledging…' };
      await globalThis.withButtonLoading(btn, async () => {
        if (action === 'accept') await cleanerAcceptClean(cleanId);
        else if (action === 'decline') await cleanerDeclineClean(cleanId);
        else if (action === 'start') await cleanerStartClean(cleanId);
        else if (action === 'done') await cleanerMarkDone(cleanId);
        else if (action === 'acknowledge_cancel') await cleanerAcknowledgeCancel(cleanId);
      }, labels[action] || 'Working…');
    }, true);
    container._cleanerDelegated = true;
  }
}
window.renderNewCleanerView = renderNewCleanerView;

// ── actions ────────────────────────────────────────────────────────────────
/**
 * Shared write path for every cleaner action: PATCH the clean (RLS policy
 * cleaner_update_own_cleans scopes it to this cleaner), reload the dashboard,
 * push-notify the host (non-fatal), re-render. `pushFor(clean, cleanerRecord)`
 * returns { title, body, tag } or null to skip the push.
 */
async function _cleanerUpdate(cleanId, patch, failLabel, pushFor) {
  if (!window._sb) return;
  const { error } = await window._sb.from('cleans').update(patch).eq('id', cleanId);
  if (error) { globalThis.showBanner(failLabel + ': ' + error.message, 'error'); return; }

  const data = typeof globalThis.loadCleanerDashboard === 'function'
    ? await globalThis.loadCleanerDashboard()
    : null;
  if (!data) return;

  try {
    const c = (data.myCleans || []).find(x => String(x.id) === String(cleanId));
    const uid = c && c.user_id;
    const push = (c && typeof pushFor === 'function') ? pushFor(c, data.cleanerRecord || {}) : null;
    if (uid && push) {
      await (typeof globalThis.authFetch === 'function' ? globalThis.authFetch : fetch)('/.netlify/functions/send-push', {
        method: 'POST',
        body: JSON.stringify({ user_id: uid, title: push.title, body: push.body, url: push.url || '/', tag: push.tag }),
      });
    }
  } catch (e) {
    console.warn('[StayOps] Push notify failed:', e);
  }

  window._cleanerData = data;
  renderNewCleanerView(data);
  renderCleanerCalendar();
  renderCleanerProfile();
}

const _guestOn = c => (c.guest_name || 'guest') + (c.clean_date ? ' on ' + c.clean_date : '');
const _propName = c => (c.properties && c.properties.name) || 'the property';

async function cleanerAcceptClean(cleanId) {
  await _cleanerUpdate(cleanId,
    { cleaner_confirmed: true, cleaner_declined: false, confirmed_at: new Date().toISOString() },
    'Failed to accept',
    (c, cr) => ({ title: '✅ Clean Confirmed', body: (cr.name || 'Cleaner') + ' accepted the clean for ' + _guestOn(c), tag: 'accept-' + cleanId }));
}
window.cleanerAcceptClean = cleanerAcceptClean;

async function cleanerDeclineClean(cleanId) {
  await _cleanerUpdate(cleanId,
    { cleaner_declined: true },
    'Failed to decline',
    (c, cr) => ({ title: '❌ Clean Declined', body: (cr.name || 'Cleaner') + ' cannot do the clean for ' + _guestOn(c) + '. Reassign needed.', tag: 'decline-' + cleanId }));
}
window.cleanerDeclineClean = cleanerDeclineClean;

/** "Start clean" — stamps started_at so the host sees the clean in progress live. */
async function cleanerStartClean(cleanId) {
  await _cleanerUpdate(cleanId,
    { started_at: new Date().toISOString() },
    'Failed to start',
    (c, cr) => ({ title: '🧹 Clean started', body: (cr.name || 'Cleaner') + ' is on site at ' + _propName(c) + (c.guest_name ? ' (' + c.guest_name + ')' : ''), tag: 'start-' + cleanId }));
}
window.cleanerStartClean = cleanerStartClean;

async function cleanerMarkDone(cleanId) {
  await _cleanerUpdate(cleanId,
    { done: true, cleaner_confirmed: true, cleaner_declined: false, completed_at: new Date().toISOString() },
    'Failed to mark done',
    (c, cr) => ({ title: '🏡 Clean Complete!', body: (cr.name || 'Cleaner') + ' has finished the clean for ' + _guestOn(c) + ' — review cleaning cost', tag: 'done-' + cleanId }));
}
window.cleanerMarkDone = cleanerMarkDone;

async function cleanerAcknowledgeCancel(cleanId) {
  await _cleanerUpdate(cleanId,
    { cleaner_cancel_acknowledged: true, cleaner_cancel_acknowledged_at: new Date().toISOString() },
    'Failed to acknowledge',
    (c, cr) => ({ title: '✓ Cancellation acknowledged', body: (cr.name || 'Cleaner') + ' acknowledged the booking cancellation', tag: 'ack-cancel-' + cleanId }));
}
window.cleanerAcknowledgeCancel = cleanerAcknowledgeCancel;

// ── Calendar ───────────────────────────────────────────────────────────────
function renderCleanerCalendar() {
  const container = document.getElementById('cleaner-section-calendar');
  if (!container || !window._cleanerData) return;

  const cleans = window._cleanerData.myCleans || [];
  const today = new Date();
  let viewMonth = window._cleanerCalMonth || today.getMonth();
  let viewYear = window._cleanerCalYear || today.getFullYear();
  window._cleanerCalMonth = viewMonth;
  window._cleanerCalYear = viewYear;

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const cleanDates = {};
  cleans.forEach((c) => {
    if (c.clean_date) {
      cleanDates[c.clean_date] = cleanDates[c.clean_date] || [];
      cleanDates[c.clean_date].push(c);
    }
  });

  const firstDay = new Date(viewYear, viewMonth, 1);
  const lastDay = new Date(viewYear, viewMonth + 1, 0);
  let startDay = firstDay.getDay() - 1;
  if (startDay < 0) startDay = 6;

  let html = '';
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">';
  html += '<button onclick="cleanerCalNav(-1)" style="background:none;border:none;font-size:20px;cursor:pointer;padding:8px">‹</button>';
  html += '<div style="font-weight:700;font-size:16px;color:var(--primary)">' + monthNames[viewMonth] + ' ' + viewYear + '</div>';
  html += '<button onclick="cleanerCalNav(1)" style="background:none;border:none;font-size:20px;cursor:pointer;padding:8px">›</button>';
  html += '</div>';

  html += '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:12px">';
  dayNames.forEach((d) => {
    html += '<div style="text-align:center;font-size:11px;font-weight:600;color:#999;padding:4px 0">' + d + '</div>';
  });

  for (let i = 0; i < startDay; i++) {
    html += '<div></div>';
  }

  const todayStr = localDateStr(today);

  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dateStr = viewYear + '-' + String(viewMonth + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const hasCleans = cleanDates[dateStr];
    const isToday = dateStr === todayStr;

    html += '<div onclick="showCleanerDayDetail(\'' + dateStr + '\')" style="text-align:center;padding:8px 2px;border-radius:10px;cursor:' + (hasCleans ? 'pointer' : 'default') + ';' + (isToday ? 'background:var(--primary);color:white;font-weight:700;' : '') + '">';
    html += '<div style="font-size:14px">' + d + '</div>';
    if (hasCleans) {
      const dotColor = hasCleans.some((c) => !c.cleaner_confirmed && !c.done) ? '#C0392B' : '#3B6D11';
      html += '<div style="width:6px;height:6px;border-radius:50%;background:' + dotColor + ';margin:3px auto 0"></div>';
    }
    html += '</div>';
  }
  html += '</div>';
  html += '<div id="cleaner-day-detail"></div>';
  container.innerHTML = html;
}
window.renderCleanerCalendar = renderCleanerCalendar;

function cleanerCalNav(dir) {
  window._cleanerCalMonth = (window._cleanerCalMonth || new Date().getMonth()) + dir;
  window._cleanerCalYear = window._cleanerCalYear || new Date().getFullYear();
  if (window._cleanerCalMonth > 11) { window._cleanerCalMonth = 0; window._cleanerCalYear++; }
  if (window._cleanerCalMonth < 0) { window._cleanerCalMonth = 11; window._cleanerCalYear--; }
  renderCleanerCalendar();
}
window.cleanerCalNav = cleanerCalNav;

function showCleanerDayDetail(dateStr) {
  const container = document.getElementById('cleaner-day-detail');
  if (!container || !window._cleanerData) return;

  const cleans = (window._cleanerData.myCleans || []).filter((c) => c.clean_date === dateStr);
  if (!cleans.length) { container.innerHTML = ''; return; }
  cleans.sort((a, b) => (Number.isFinite(a._deadlineMinutes) ? a._deadlineMinutes : 1e9) - (Number.isFinite(b._deadlineMinutes) ? b._deadlineMinutes : 1e9));

  let html = '<div style="margin-top:12px;padding-top:12px;border-top:1px solid #eee">';
  html += '<div style="font-weight:700;font-size:13px;color:var(--primary);margin-bottom:8px">' + fmtDay(dateStr) + '</div>';

  cleans.forEach((c) => {
    const prop = c.properties || {};
    const status = c.done ? 'Done' : c.started_at ? 'On site' : c.cleaner_confirmed ? 'Confirmed' : c.cleaner_declined ? 'Declined' : 'Pending';
    const statusColor = c.done ? '#999' : c.started_at ? '#185FA5' : c.cleaner_confirmed ? '#3B6D11' : c.cleaner_declined ? '#C0392B' : '#F5A623';
    let turnover = '';
    if (c._sameDayTurnover) turnover = ' · <span style="color:#A32D2D;font-weight:500">next guest ' + fmtClock(c._nextCheckinTime) + '</span>';
    else if (c._nextCheckinDate) turnover = ' · next guest ' + fmtDay(c._nextCheckinDate);
    html += '<div style="background:white;border-radius:10px;padding:12px;margin-bottom:6px;box-shadow:0 1px 3px rgba(0,0,0,0.05)">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center">';
    html += '<div style="font-weight:600;font-size:14px">' + escHtml(prop.name || 'Property') + '</div>';
    html += '<span style="font-size:11px;font-weight:700;color:' + statusColor + ';background:' + statusColor + '15;padding:3px 8px;border-radius:6px">' + status + '</span>';
    html += '</div>';
    html += '<div style="font-size:12px;color:#666;margin-top:3px">' + escHtml(c.guest_name || '') + (c._checkoutTime ? ' · out ' + fmtClock(c._checkoutTime) : '') + turnover + '</div>';
    html += '</div>';
  });

  html += '</div>';
  container.innerHTML = html;
}
window.showCleanerDayDetail = showCleanerDayDetail;

// ── Profile ────────────────────────────────────────────────────────────────
function renderCleanerProfile() {
  const container = document.getElementById('cleaner-section-profile');
  if (!container || !window._cleanerData) return;

  const cr = window._cleanerData.cleanerRecord || {};
  const host = window._cleanerData.host || null;

  let html = '';
  html += '<div style="background:white;border-radius:16px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,0.06)">';
  html += '<div style="text-align:center;margin-bottom:20px">';
  html += '<div style="width:64px;height:64px;border-radius:50%;background:var(--primary);color:white;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;margin:0 auto 10px">' + escHtml((cr.name || 'C')[0].toUpperCase()) + '</div>';
  html += '<div style="font-weight:700;font-size:18px;color:var(--primary)">' + escHtml(cr.name || 'Cleaner') + '</div>';
  html += '</div>';
  html += '<div style="border-top:1px solid #f0f0f0;padding-top:16px">';
  html += '<div style="display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f5f5f3">';
  html += '<span style="font-size:13px;color:#999">Email</span>';
  html += '<span style="font-size:13px;font-weight:600;color:#333">' + escHtml(cr.email || '—') + '</span>';
  html += '</div>';
  html += '<div style="display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f5f5f3">';
  html += '<span style="font-size:13px;color:#999">Phone</span>';
  html += '<span style="font-size:13px;font-weight:600;color:#333">' + escHtml(cr.phone || '—') + '</span>';
  html += '</div>';
  if (host) {
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid #f5f5f3">';
    html += '<span style="font-size:13px;color:#999">Host</span>';
    html += '<span style="font-size:13px;font-weight:600;color:#333;text-align:right">' + escHtml(host.name || host.company || '—') +
      (host.name && host.company ? '<div style="font-size:11px;color:#999;font-weight:400">' + escHtml(host.company) + '</div>' : '') +
      (host.phone ? '<div style="font-size:11px;color:#999;font-weight:400">' + escHtml(host.phone) + '</div>' : '') +
    '</span>';
    html += '</div>';
  }
  html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #f5f5f3">';
  html += '<span style="font-size:13px;color:#999">Notifications</span>';
  html += '<span id="cleaner-profile-notif-status" style="font-size:13px;font-weight:600;color:#999"></span>';
  html += '</div>';

  const cleans = window._cleanerData.myCleans || [];
  const completed = cleans.filter((c) => c.done).length;
  const upcoming = cleans.filter((c) => !c.done && c.cleaner_confirmed && !c._bookingCancelled).length;

  html += '<div style="display:flex;gap:12px;margin-top:20px">';
  html += '<div style="flex:1;background:#f5f5f3;border-radius:12px;padding:14px;text-align:center">';
  html += '<div style="font-size:22px;font-weight:700;color:var(--primary)">' + completed + '</div>';
  html += '<div style="font-size:11px;color:#999;margin-top:2px">Completed</div>';
  html += '</div>';
  html += '<div style="flex:1;background:#f5f5f3;border-radius:12px;padding:14px;text-align:center">';
  html += '<div style="font-size:22px;font-weight:700;color:var(--primary)">' + upcoming + '</div>';
  html += '<div style="font-size:11px;color:#999;margin-top:2px">Upcoming</div>';
  html += '</div>';
  html += '</div>';

  const hostHref = host ? smsHref(host.phone, 'Hi' + (hostFirstName(host) ? ' ' + hostFirstName(host) : '') + ', ') : '';
  if (hostHref) {
    html += '<a href="' + escHtml(hostHref) + '" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:16px;padding:12px;background:#f7f9f8;color:#2f5d4e;border:1px solid #d5ded9;border-radius:10px;font-weight:600;font-size:13px;text-decoration:none">💬 Message host</a>';
  }
  html += '</div></div>';

  // "Also a Host?" section — only show if user doesn't already have a host role
  html += '<div id="cleaner-become-host-section" style="margin-top:20px;display:none">';
  html += '<div style="background:white;border-radius:12px;padding:16px;border:1.5px solid #EAF3DE">';
  html += '<div style="font-weight:700;font-size:14px;color:var(--primary);margin-bottom:4px">Also manage your own property?</div>';
  html += '<div style="font-size:12px;color:#888;margin-bottom:12px;line-height:1.4">Add host mode to manage bookings, finances, and cleaning schedules for your own properties.</div>';
  html += '<button onclick="becomeHost()" id="become-host-btn" style="width:100%;padding:12px;background:var(--primary);color:white;border:none;border-radius:10px;font-weight:600;font-size:13px;cursor:pointer;font-family:\'Plus Jakarta Sans\',sans-serif">Enable Host Mode</button>';
  html += '</div></div>';

  html += '<button onclick="cleanerSignOut()" style="width:100%;margin-top:20px;padding:14px;background:white;color:#C0392B;border:1.5px solid #C0392B;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer">Sign Out</button>';

  container.innerHTML = html;

  // Check notification status — use unique ID to avoid conflict with legacy header element
  const notifEl = document.getElementById('cleaner-profile-notif-status');
  if (notifEl) {
    const enableBtn =
      '<button onclick="window._enableCleanerNotifs()" style="background:var(--primary);color:white;border:none;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer">Enable</button>';
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) {
      notifEl.innerHTML = '<span style="color:#C0392B">Not supported</span>';
    } else if (Notification.permission === 'granted') {
      notifEl.innerHTML = '<span style="color:#1D9E75">✓ Enabled</span>';
    } else if (Notification.permission === 'denied') {
      notifEl.innerHTML = '<span style="color:#C0392B">Blocked</span>';
    } else {
      notifEl.innerHTML = enableBtn;
    }
  }

  // Check if "Become a Host" section should be visible
  if (typeof window._checkBecomeHostVisibility === 'function') {
    window._checkBecomeHostVisibility();
  }
}
window.renderCleanerProfile = renderCleanerProfile;

window._enableCleanerNotifs = async function () {
  const el = document.getElementById('cleaner-profile-notif-status');
  if (el) el.innerHTML = '<span style="color:#999">Enabling…</span>';
  try {
    const cr = window._cleanerData && window._cleanerData.cleanerRecord;
    const cleanerId = cr ? cr.id : null;
    if (typeof globalThis.subscribeToPush === 'function') {
      await globalThis.subscribeToPush('cleaner', cleanerId);
    } else {
      // Fallback: import dynamically
      const { subscribeToPush } = await import('./notifications.js');
      await subscribeToPush('cleaner', cleanerId);
    }
    if (el) el.innerHTML = '<span style="color:#1D9E75">✓ Enabled</span>';
    if (typeof globalThis.showBanner === 'function') {
      globalThis.showBanner('Notifications enabled!', 'success');
    }
  } catch (e) {
    console.warn('[StayOps] Enable notifs failed:', e);
    if (el) el.innerHTML = '<span style="color:#C0392B">Failed — try again</span>';
  }
};

// Check if cleaner already has host role — if not, show "Become a Host" section
window._checkBecomeHostVisibility = async function () {
  const section = document.getElementById('cleaner-become-host-section');
  if (!section || !window._sb) return;
  try {
    const user = window._supabaseUser || (await window._sb.auth.getUser()).data?.user;
    if (!user) return;
    const { data: roles } = await window._sb.from('user_roles').select('role').eq('auth_user_id', user.id);
    const hasHost = roles && roles.some(r => r.role === 'host');
    section.style.display = hasHost ? 'none' : 'block';
  } catch (_) { /* ignore */ }
};

window.becomeHost = async function () {
  const btn = document.getElementById('become-host-btn');
  if (btn) { btn.textContent = 'Setting up…'; btn.disabled = true; }
  try {
    const user = window._supabaseUser || (await window._sb.auth.getUser()).data?.user;
    if (!user || !window._sb) throw new Error('Not signed in');

    // Insert host role
    const { error } = await window._sb.from('user_roles').insert({ auth_user_id: user.id, role: 'host' });
    if (error) throw error;

    if (btn) btn.textContent = 'Host mode enabled!';
    if (typeof globalThis.showBanner === 'function') {
      globalThis.showBanner('Host mode enabled — reload to start setting up your property', 'ok');
    }

    // Hide the section
    const section = document.getElementById('cleaner-become-host-section');
    if (section) section.style.display = 'none';

    // Auto-reload after a short delay so the host boot sequence runs
    setTimeout(() => { window.location.reload(); }, 1500);
  } catch (e) {
    console.warn('[StayOps] becomeHost failed:', e);
    if (btn) { btn.textContent = 'Failed — try again'; btn.disabled = false; }
  }
};

function showCleanerSection(section) {
  ['cleans', 'calendar', 'profile'].forEach((s) => {
    const el = document.getElementById('cleaner-section-' + s);
    if (el) el.style.display = s === section ? '' : 'none';
  });
  document.querySelectorAll('#cleaner-nav .nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.id === 'cnav-' + section);
  });
  const titles = { cleans: 'My Cleans', calendar: 'Calendar', profile: 'Profile' };
  const hdr = document.querySelector('#cleaner-header > div:first-child');
  if (hdr) hdr.textContent = titles[section] || 'My Cleans';

  if (section === 'calendar') renderCleanerCalendar();
  if (section === 'profile') renderCleanerProfile();
}
window.showCleanerSection = showCleanerSection;

function getInviteButtonHtml(cleaner) {
  if (!cleaner.email) {
    return '<span style="font-size:11px;color:#999;font-style:italic">No email - can\'t invite</span>';
  }
  if (cleaner.invitation_status === 'active' || cleaner.auth_user_id) {
    return '<span style="font-size:11px;color:#3B6D11;font-weight:600">✓ Account linked</span>';
  }
  const cloudId = cleaner._cloudId || cleaner.cloud_id;
  if (!cloudId) {
    return '<span style="font-size:11px;color:#999;font-style:italic">Save team to sync cleaner before inviting</span>';
  }
  if (cleaner.invitation_status === 'invited') {
    return '<button id="invite-btn-' + cloudId + '" onclick="inviteCleaner(\'' + (cleaner._cloudId || cleaner.cloud_id) + '\')" style="font-size:12px;padding:6px 12px;background:transparent;color:var(--primary);border:1px solid var(--primary);border-radius:8px;font-weight:600;cursor:pointer">Resend Invite</button>';
  }
  return '<button id="invite-btn-' + cloudId + '" onclick="inviteCleaner(\'' + (cleaner._cloudId || cleaner.cloud_id) + '\')" style="font-size:12px;padding:6px 12px;background:var(--primary);color:white;border:none;border-radius:8px;font-weight:600;cursor:pointer">Invite to App</button>';
}
window.getInviteButtonHtml = getInviteButtonHtml;
