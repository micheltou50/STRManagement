/**
 * StayOps — cleaner PWA (email / Supabase-auth): the cleaner-facing app shown after a
 * cleaner signs in with their email. Renders My Cleans / Calendar / Profile, handles
 * accept / decline / done / acknowledge, become-a-host, and the team invite button.
 * The legacy link/PIN login path was removed 2026-07-10 (cleaners log in by email now).
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

function renderNewCleanerView(data) {
  if (!data) return;
  const { cleanerRecord, myCleans } = data;

  // Hide FAB — cleaners don't need the quick-add button
  const fab = document.querySelector('.fab');
  if (fab) fab.style.display = 'none';
  const qaFab = document.getElementById('quick-add-fab');
  if (qaFab) qaFab.style.display = 'none';

  // Set header date badge (normally only set during host init)
  renderHeaderDateBadge();

  const greeting = document.getElementById('cleaner-greeting');
  if (greeting) greeting.textContent = 'Welcome, ' + (cleanerRecord.name || 'Cleaner');

  // Update header subtitle — show property name instead of location
  const headerSub = document.querySelector('.cleaner-header .header-sub-name');
  if (headerSub) {
    const propName = window._cleanerData && window._cleanerData.property && window._cleanerData.property.name;
    headerSub.textContent = propName || '';
  }

  const container = document.getElementById('cleaner-section-cleans');
  if (!container) return;

  const today = new Date();
  const todayStr = localDateStr(today);

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()];
  }

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T00:00:00');
    const diff = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
    return diff;
  }

  function urgencyPill(days) {
    if (days === null) return '';
    let bg, color, label;
    if (days < 0) {
      bg = '#F1EFE8'; color = '#5F5E5A'; label = 'Past';
    } else if (days === 0) {
      bg = '#FCEBEB'; color = '#A32D2D'; label = 'Today';
    } else if (days === 1) {
      bg = '#FCEBEB'; color = '#A32D2D'; label = 'Tomorrow';
    } else if (days <= 7) {
      bg = '#FCEBEB'; color = '#A32D2D'; label = 'In ' + days + ' days';
    } else if (days <= 30) {
      bg = '#FAEEDA'; color = '#854F0B'; label = 'In ' + days + ' days';
    } else {
      bg = '#E1F5EE'; color = '#0F6E56'; label = 'In ' + days + ' days';
    }
    return '<div style="font-size:11px;font-weight:500;background:' + bg + ';color:' + color + ';padding:3px 10px;border-radius:12px;white-space:nowrap">' + label + '</div>';
  }

  const cancelled = myCleans.filter(c => c._bookingCancelled && !c.done);
  const nonCancelled = myCleans.filter(c => !c._bookingCancelled);
  const actionNeeded = nonCancelled.filter(c => !c.done && !c.cleaner_confirmed && !c.cleaner_declined);
  const upcoming = nonCancelled.filter(c => !c.done && c.cleaner_confirmed && c.clean_date >= todayStr);
  const completed = nonCancelled.filter(c => c.done);

  let html = '';

  // Cancelled bookings
  if (cancelled.length) {
    html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px">';
    html += '<div style="width:8px;height:8px;border-radius:50%;background:#C0392B"></div>';
    html += '<span style="font-size:12px;font-weight:500;color:#C0392B;text-transform:uppercase;letter-spacing:0.4px">Cancelled</span>';
    html += '<span style="font-size:11px;color:#999;margin-left:2px">' + cancelled.length + '</span>';
    html += '</div>';

    cancelled.forEach(c => {
      const prop = c.properties || {};
      const guestLine = escHtml(c.guest_name || 'Guest');
      const acked = c.cleaner_cancel_acknowledged;

      html += '<div style="background:white;border:0.5px solid #eee;border-left:3px solid #C0392B;border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:10px">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start">';
      html += '<div>';
      html += '<div style="font-size:17px;font-weight:500;color:var(--ink-1);text-decoration:line-through">' + formatDate(c.clean_date) + '</div>';
      html += '<div style="font-size:13px;color:#888;margin-top:2px;text-decoration:line-through">' + guestLine + '</div>';
      html += '</div>';
      html += '<div style="font-size:11px;font-weight:500;background:#FCEBEB;color:#A32D2D;padding:3px 10px;border-radius:12px;white-space:nowrap">Booking cancelled</div>';
      html += '</div>';
      html += '<div style="margin-top:10px;padding:10px 12px;background:#f7f7f5;border-radius:6px">';
      html += '<div style="font-size:13px;font-weight:500;color:#333">' + escHtml(prop.name || 'Property') + '</div>';
      html += '<div style="font-size:12px;color:#888;margin-top:1px">' + escHtml(prop.address || '') + '</div>';
      html += '</div>';
      if (acked) {
        html += '<div style="margin-top:10px;font-size:12px;color:#0F6E56;font-weight:500">✓ Acknowledged</div>';
      } else {
        html += '<button type="button" data-action="acknowledge_cancel" data-clean-id="' + String(c.id) + '" style="width:100%;margin-top:10px;padding:10px;background:#2f5d4e;color:white;border:none;border-radius:8px;font-weight:500;font-size:13px;cursor:pointer">Acknowledge Cancellation</button>';
      }
      html += '</div>';
    });
  }

  // Action needed
  if (actionNeeded.length) {
    html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px">';
    html += '<div style="width:8px;height:8px;border-radius:50%;background:#E24B4A"></div>';
    html += '<span style="font-size:12px;font-weight:500;color:#A32D2D;text-transform:uppercase;letter-spacing:0.4px">Action needed</span>';
    html += '<span style="font-size:11px;color:#999;margin-left:2px">' + actionNeeded.length + '</span>';
    html += '</div>';

    actionNeeded.forEach(c => {
      const prop = c.properties || {};
      const days = daysUntil(c.clean_date);
      const guests = c.guests || '';
      const guestLine = escHtml(c.guest_name || 'Guest') + (guests ? ' · ' + escHtml(String(guests)) + ' guests' : '');

      html += '<div style="background:white;border:0.5px solid #eee;border-left:3px solid #E24B4A;border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:10px">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start">';
      html += '<div>';
      html += '<div style="font-size:17px;font-weight:500;color:var(--ink-1)">' + formatDate(c.clean_date) + '</div>';
      html += '<div style="font-size:13px;color:#888;margin-top:2px">' + guestLine + '</div>';
      html += '</div>';
      html += urgencyPill(days);
      html += '</div>';
      html += '<div style="margin-top:10px;padding:10px 12px;background:#f7f7f5;border-radius:6px">';
      html += '<div style="font-size:13px;font-weight:500;color:#333">' + escHtml(prop.name || 'Property') + '</div>';
      html += '<div style="font-size:12px;color:#888;margin-top:1px">' + escHtml(prop.address || '') + '</div>';
      html += '</div>';
      html += '<div style="display:flex;gap:8px;margin-top:12px">';
      html += '<button type="button" data-action="accept" data-clean-id="' + String(c.id) + '" style="flex:1;padding:10px;background:#2f5d4e;color:white;border:none;border-radius:8px;font-weight:500;font-size:13px;cursor:pointer">Accept</button>';
      html += '<button type="button" data-action="decline" data-clean-id="' + String(c.id) + '" style="flex:1;padding:10px;background:transparent;color:#A32D2D;border:1px solid #F09595;border-radius:8px;font-weight:500;font-size:13px;cursor:pointer">Decline</button>';
      html += '</div></div>';
    });
  }

  // Upcoming confirmed
  if (upcoming.length) {
    html += '<div style="display:flex;align-items:center;gap:6px;margin:20px 0 12px">';
    html += '<div style="width:8px;height:8px;border-radius:50%;background:#1D9E75"></div>';
    html += '<span style="font-size:12px;font-weight:500;color:#0F6E56;text-transform:uppercase;letter-spacing:0.4px">Confirmed</span>';
    html += '<span style="font-size:11px;color:#999;margin-left:2px">' + upcoming.length + '</span>';
    html += '</div>';

    upcoming.forEach(c => {
      const prop = c.properties || {};
      const days = daysUntil(c.clean_date);
      const checkInInfo = prop.check_in_info || {};
      const guests = c.guests || '';
      const guestLine = escHtml(c.guest_name || 'Guest') + (guests ? ' · ' + escHtml(String(guests)) + ' guests' : '');

      html += '<div style="background:white;border:0.5px solid #eee;border-left:3px solid #1D9E75;border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:10px">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start">';
      html += '<div>';
      html += '<div style="font-size:17px;font-weight:500;color:var(--ink-1)">' + formatDate(c.clean_date) + '</div>';
      html += '<div style="font-size:13px;color:#888;margin-top:2px">' + guestLine + '</div>';
      html += '</div>';
      html += urgencyPill(days);
      html += '</div>';
      html += '<div style="margin-top:10px;padding:10px 12px;background:#f7f7f5;border-radius:6px">';
      html += '<div style="font-size:13px;font-weight:500;color:#333">' + escHtml(prop.name || 'Property') + '</div>';
      html += '<div style="font-size:12px;color:#888;margin-top:1px">' + escHtml(prop.address || '') + '</div>';
      html += '</div>';

      if (checkInInfo.lockbox_code || checkInInfo.instructions) {
        html += '<div style="margin-top:8px;padding:10px 12px;background:#f7f7f5;border-radius:6px;font-size:12px;color:#666">';
        html += '<div style="font-weight:500;margin-bottom:2px;color:#333">Access info</div>';
        let accessParts = [];
        if (checkInInfo.lockbox_code) accessParts.push('Lockbox: ' + escHtml(checkInInfo.lockbox_code));
        if (checkInInfo.instructions) accessParts.push(escHtml(checkInInfo.instructions));
        html += accessParts.join(' · ');
        html += '</div>';
      }

      const cleanDateObj = new Date(c.clean_date + 'T00:00:00');
      const isToday = c.clean_date === todayStr;
      const isPast = cleanDateObj < today;
      if (isToday || isPast) {
        html += '<button type="button" data-action="done" data-clean-id="' + String(c.id) + '" style="width:100%;margin-top:10px;padding:10px;background:transparent;color:#2f5d4e;border:1px solid #ccc;border-radius:8px;font-weight:500;font-size:13px;cursor:pointer">Mark as done</button>';
      }
      html += '</div>';
    });
  }

  // Completed
  if (completed.length) {
    html += '<div style="display:flex;align-items:center;gap:6px;margin:20px 0 12px">';
    html += '<div style="width:8px;height:8px;border-radius:50%;background:#999"></div>';
    html += '<span style="font-size:12px;font-weight:500;color:#999;text-transform:uppercase;letter-spacing:0.4px">Completed</span>';
    html += '</div>';

    completed.slice(0, 10).forEach(c => {
      const prop = c.properties || {};
      html += '<div style="background:#f9f9f7;border:0.5px solid #eee;border-radius:8px;padding:12px 16px;margin-bottom:8px;opacity:0.7">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center">';
      html += '<div>';
      html += '<div style="font-size:14px;font-weight:500;color:#555">' + formatDate(c.clean_date) + '</div>';
      html += '<div style="font-size:12px;color:#999;margin-top:1px">' + escHtml(c.guest_name || '') + ' · ' + escHtml(prop.name || '') + '</div>';
      html += '</div>';
      html += '<div style="font-size:11px;color:#999">Done</div>';
      html += '</div></div>';
    });
  }

  if (!html) {
    html = '<div style="text-align:center;padding:40px 20px;color:#999"><div style="font-size:40px;margin-bottom:12px">✨</div><div style="font-size:15px;font-weight:500">No cleans assigned yet</div><div style="font-size:13px;margin-top:6px">Your host will assign cleans to you here.</div></div>';
  }

  container.innerHTML = html;

  if (!container._cleanerDelegated) {
    container.addEventListener('click', async function (e) {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      const action = btn.getAttribute('data-action');
      const cleanId = btn.getAttribute('data-clean-id');
      if (!cleanId) return;
      const labels = { accept: 'Accepting…', decline: 'Declining…', done: 'Completing…', acknowledge_cancel: 'Acknowledging…' };
      await globalThis.withButtonLoading(btn, async () => {
        if (action === 'accept') await cleanerAcceptClean(cleanId);
        else if (action === 'decline') await cleanerDeclineClean(cleanId);
        else if (action === 'done') await cleanerMarkDone(cleanId);
        else if (action === 'acknowledge_cancel') await cleanerAcknowledgeCancel(cleanId);
      }, labels[action] || 'Working…');
    }, true);
    container._cleanerDelegated = true;
  }
}
window.renderNewCleanerView = renderNewCleanerView;

async function cleanerAcceptClean(cleanId) {
  if (!window._sb) return;
  const { error } = await window._sb
    .from('cleans')
    .update({ cleaner_confirmed: true, confirmed_at: new Date().toISOString() })
    .eq('id', cleanId);
  if (error) { globalThis.showBanner('Failed to accept: ' + error.message, 'error'); return; }
  const data = typeof globalThis.loadCleanerDashboard === 'function'
    ? await globalThis.loadCleanerDashboard()
    : null;
  if (data) {
    try {
      const cleanData = data.myCleans?.find((c) => String(c.id) === String(cleanId));
      const guestName = cleanData?.guest_name || cleanData?.guestName || 'guest';
      const cleanDate = cleanData?.clean_date || cleanData?.date || '';
      const cleanerName = data.cleanerRecord?.name || 'Cleaner';
      const uid = cleanData?.user_id;
      if (uid) {
        await (typeof globalThis.authFetch === 'function' ? globalThis.authFetch : fetch)('/.netlify/functions/send-push', {
          method: 'POST',
          body: JSON.stringify({
            user_id: uid,
            title: '✅ Clean Confirmed',
            body: cleanerName + ' accepted the clean for ' + guestName + (cleanDate ? ' on ' + cleanDate : ''),
            url: '/',
            tag: 'accept-' + cleanId
          })
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
}
window.cleanerAcceptClean = cleanerAcceptClean;

async function cleanerDeclineClean(cleanId) {
  if (!window._sb) return;
  const { error } = await window._sb
    .from('cleans')
    .update({ cleaner_declined: true })
    .eq('id', cleanId);
  if (error) { globalThis.showBanner('Failed to decline: ' + error.message, 'error'); return; }
  const data = typeof globalThis.loadCleanerDashboard === 'function'
    ? await globalThis.loadCleanerDashboard()
    : null;
  if (data) {
    try {
      const cleanData = data.myCleans?.find((c) => String(c.id) === String(cleanId));
      const guestName = cleanData?.guest_name || cleanData?.guestName || 'guest';
      const cleanDate = cleanData?.clean_date || cleanData?.date || '';
      const cleanerName = data.cleanerRecord?.name || 'Cleaner';
      const uid = cleanData?.user_id;
      if (uid) {
        await (typeof globalThis.authFetch === 'function' ? globalThis.authFetch : fetch)('/.netlify/functions/send-push', {
          method: 'POST',
          body: JSON.stringify({
            user_id: uid,
            title: '❌ Clean Declined',
            body: cleanerName + ' cannot do the clean for ' + guestName + (cleanDate ? ' on ' + cleanDate : '') + '. Reassign needed.',
            url: '/',
            tag: 'decline-' + cleanId
          })
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
}
window.cleanerDeclineClean = cleanerDeclineClean;

async function cleanerMarkDone(cleanId) {
  if (!window._sb) return;
  const { error } = await window._sb
    .from('cleans')
    .update({ done: true, completed_at: new Date().toISOString() })
    .eq('id', cleanId);
  if (error) { globalThis.showBanner('Failed to mark done: ' + error.message, 'error'); return; }
  const data = typeof globalThis.loadCleanerDashboard === 'function'
    ? await globalThis.loadCleanerDashboard()
    : null;
  if (data) {
    try {
      const cleanData = data.myCleans?.find((c) => String(c.id) === String(cleanId));
      const guestName = cleanData?.guest_name || cleanData?.guestName || 'guest';
      const cleanDate = cleanData?.clean_date || cleanData?.date || '';
      const cleanerName = data.cleanerRecord?.name || 'Cleaner';
      const uid = cleanData?.user_id;
      if (uid) {
        await (typeof globalThis.authFetch === 'function' ? globalThis.authFetch : fetch)('/.netlify/functions/send-push', {
          method: 'POST',
          body: JSON.stringify({
            user_id: uid,
            title: '🏡 Clean Complete!',
            body: cleanerName + ' has finished the clean for ' + guestName + (cleanDate ? ' on ' + cleanDate : '') + ' — review cleaning cost',
            url: '/',
            tag: 'done-' + cleanId
          })
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
}
window.cleanerMarkDone = cleanerMarkDone;

async function cleanerAcknowledgeCancel(cleanId) {
  if (!window._sb) return;
  const { error } = await window._sb
    .from('cleans')
    .update({ cleaner_cancel_acknowledged: true, cleaner_cancel_acknowledged_at: new Date().toISOString() })
    .eq('id', cleanId);
  if (error) { globalThis.showBanner('Failed to acknowledge: ' + error.message, 'error'); return; }
  const data = typeof globalThis.loadCleanerDashboard === 'function'
    ? await globalThis.loadCleanerDashboard()
    : null;
  if (data) {
    try {
      const cleanData = data.myCleans?.find((c) => String(c.id) === String(cleanId));
      const cleanerName = data.cleanerRecord?.name || 'Cleaner';
      const uid = cleanData?.user_id;
      if (uid) {
        await (typeof globalThis.authFetch === 'function' ? globalThis.authFetch : fetch)('/.netlify/functions/send-push', {
          method: 'POST',
          body: JSON.stringify({
            user_id: uid,
            title: '✓ Cancellation acknowledged',
            body: cleanerName + ' acknowledged the booking cancellation',
            url: '/',
            tag: 'ack-cancel-' + cleanId
          })
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
}
window.cleanerAcknowledgeCancel = cleanerAcknowledgeCancel;

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

  let html = '<div style="margin-top:12px;padding-top:12px;border-top:1px solid #eee">';
  html += '<div style="font-weight:700;font-size:13px;color:var(--primary);margin-bottom:8px">' + dateStr + '</div>';

  cleans.forEach((c) => {
    const prop = c.properties || {};
    const status = c.done ? 'Done' : c.cleaner_confirmed ? 'Confirmed' : c.cleaner_declined ? 'Declined' : 'Pending';
    const statusColor = c.done ? '#999' : c.cleaner_confirmed ? '#3B6D11' : c.cleaner_declined ? '#C0392B' : '#F5A623';
    html += '<div style="background:white;border-radius:10px;padding:12px;margin-bottom:6px;box-shadow:0 1px 3px rgba(0,0,0,0.05)">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center">';
    html += '<div style="font-weight:600;font-size:14px">' + (prop.name || 'Property') + '</div>';
    html += '<span style="font-size:11px;font-weight:700;color:' + statusColor + ';background:' + statusColor + '15;padding:3px 8px;border-radius:6px">' + status + '</span>';
    html += '</div>';
    html += '<div style="font-size:12px;color:#666;margin-top:3px">' + (c.guest_name || '') + '</div>';
    html += '</div>';
  });

  html += '</div>';
  container.innerHTML = html;
}
window.showCleanerDayDetail = showCleanerDayDetail;

function renderCleanerProfile() {
  const container = document.getElementById('cleaner-section-profile');
  if (!container || !window._cleanerData) return;

  const cr = window._cleanerData.cleanerRecord;

  // Update header subtitle — show property name instead of location
  const headerSub = document.querySelector('.cleaner-header .header-sub-name');
  if (headerSub) {
    const propName = window._cleanerData.property && window._cleanerData.property.name;
    headerSub.textContent = propName || '';
  }

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
  html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #f5f5f3">';
  html += '<span style="font-size:13px;color:#999">Notifications</span>';
  html += '<span id="cleaner-profile-notif-status" style="font-size:13px;font-weight:600;color:#999"></span>';
  html += '</div>';

  const cleans = window._cleanerData.myCleans || [];
  const completed = cleans.filter((c) => c.done).length;
  const upcoming = cleans.filter((c) => !c.done && c.cleaner_confirmed).length;

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
