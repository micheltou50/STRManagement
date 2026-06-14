/**
 * StayOps — Cleaner PWA v2 sub-views (Home, Offer, Active, Done).
 * Renders into #cleaner-v2-overlay inside #cleaner-app.
 */
import { escHtml, fmt, localDateStr } from './utils.js';
import { cleans, bookings } from './state.js';

const CL = {
  bg: '#eef2f1', primary: '#1c5a55', primarySoft: '#cfe1de',
  ink: '#0f1f1d', ink2: '#36504c', muted: '#7c8d8a',
  accent: '#e08d3a', surface: '#fff', hairline: '#dde3e1',
};

let _cleanTimerInterval = null;
let _cleanTimerStart = null;

function _getCleanerName() {
  const rec = window._cleanerRecord;
  return (rec && rec.name) ? rec.name.split(' ')[0] : 'Cleaner';
}

function _getCleanerInitial() {
  return _getCleanerName().charAt(0).toUpperCase();
}

function _getCleanerCleans() {
  const rec = window._cleanerRecord;
  if (!rec) return [];
  return (window._cleanerCleans || cleans || []).filter(c => {
    if (c.done) return false;
    const id = String(rec.id);
    return (c.cleanerId && String(c.cleanerId) === id) || (c.cleaner_uuid && String(c.cleaner_uuid) === id);
  });
}

function _getNextClean() {
  const today = localDateStr();
  const upcoming = _getCleanerCleans()
    .filter(c => c.date >= today && c.cleanerConfirmed)
    .sort((a, b) => a.date.localeCompare(b.date));
  return upcoming[0] || null;
}

function _getNewOffers() {
  return _getCleanerCleans().filter(c => !c.cleanerConfirmed && !c.cleanerDeclined);
}

function _getWeekCleans() {
  const now = new Date();
  const weekEnd = localDateStr(new Date(now.getTime() + 7 * 86400000));
  const today = localDateStr(now);
  return _getCleanerCleans()
    .filter(c => c.date >= today && c.date <= weekEnd && c.cleanerConfirmed)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function _bookingForClean(c) {
  if (!c || !c.bookingId) return null;
  return bookings.find(b => String(b.id) === String(c.bookingId) || String(b._cloudId) === String(c.bookingId));
}

function _propNameForClean(c) {
  if (c.properties && c.properties.name) return c.properties.name;
  if (c.propertyName) return c.propertyName;
  return 'Property';
}

function _cleanPay(c) {
  return Number(c.cleanerPay || c.pay || 0);
}

function _ensureOverlay() {
  let el = document.getElementById('cleaner-v2-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cleaner-v2-overlay';
    el.style.cssText = 'display:none;position:fixed;inset:0;z-index:500;overflow-y:auto;-webkit-overflow-scrolling:touch';
    const app = document.getElementById('cleaner-app');
    if (app) app.appendChild(el);
    else document.body.appendChild(el);
  }
  return el;
}

function _showOverlay(html) {
  const el = _ensureOverlay();
  el.innerHTML = html;
  el.style.display = '';
}

function _hideOverlay() {
  const el = document.getElementById('cleaner-v2-overlay');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _stopCleanTimer();
}

// ── HOME ────────────────────────────────────────────────────────────────────
function showCleanerHome() {
  const name = _getCleanerName();
  const initial = _getCleanerInitial();
  const now = new Date();
  const dayLabel = now.toLocaleDateString('en-AU', { weekday: 'long' });
  const weekEarnings = _getWeekCleans().reduce((s, c) => s + _cleanPay(c), 0);
  const next = _getNextClean();
  const offers = _getNewOffers();
  const week = _getWeekCleans();

  let heroHtml = '';
  if (next) {
    const prop = _propNameForClean(next);
    const b = _bookingForClean(next);
    const guests = b ? (b.guests || '?') : '?';
    const pay = _cleanPay(next);
    const dateStr = next.date ? new Date(next.date + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric' }) : '';
    heroHtml = `<div style="background:${CL.primary};color:#fff;border-radius:22px;padding:22px;position:relative;overflow:hidden;margin:0 16px">
      <div style="position:absolute;right:-20px;top:-20px;width:130px;height:130px;border-radius:50%;background:rgba(255,255,255,0.08)"></div>
      <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:rgba(255,255,255,0.7);letter-spacing:0.6px;text-transform:uppercase">NEXT CLEAN</div>
      <div style="margin-top:6px;font-family:'Newsreader',serif;font-size:32px;font-weight:600;letter-spacing:-0.5px">${escHtml(dateStr)}</div>
      <div style="font-size:14px;color:rgba(255,255,255,0.85);margin-top:4px">${escHtml(prop)}</div>
      <div style="margin-top:14px;padding:12px;border-radius:12px;background:rgba(255,255,255,0.12);display:flex;gap:10px;align-items:center">
        <div style="font-size:12px;color:rgba(255,255,255,0.85);flex:1">${guests} guests · est. 2 hrs</div>
        ${pay ? `<div style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;background:${CL.accent};color:#fff">$${pay}</div>` : ''}
      </div>
    </div>`;
  } else {
    heroHtml = `<div style="background:${CL.primary};color:#fff;border-radius:22px;padding:22px;margin:0 16px;text-align:center">
      <div style="font-family:'Newsreader',serif;font-size:22px;font-weight:600">No upcoming cleans</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:6px">You're all caught up!</div>
    </div>`;
  }

  let offersHtml = '';
  if (offers.length) {
    const offerCards = offers.map(c => {
      const prop = _propNameForClean(c);
      const pay = _cleanPay(c);
      const dateStr = c.date ? new Date(c.date + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
      return `<div onclick="showCleanerOffer('${escHtml(String(c._cloudId || c.id))}')" style="background:${CL.surface};border-radius:18px;padding:16px;border:1.5px solid ${CL.accent};display:flex;gap:12px;align-items:center;cursor:pointer">
        <div style="width:44px;height:44px;border-radius:12px;background:#fbeacf;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="20" height="20" viewBox="0 0 20 20"><path d="M10 4v6M10 14v.01" stroke="${CL.accent}" stroke-width="2" stroke-linecap="round"/></svg>
        </div>
        <div style="flex:1">
          <div style="font-size:13.5px;font-weight:700;color:${CL.ink}">New offer · ${escHtml(dateStr)}</div>
          <div style="font-size:12px;color:${CL.muted};margin-top:2px">${escHtml(prop)}${pay ? ' · $' + pay : ''}</div>
        </div>
        <svg width="8" height="14" viewBox="0 0 8 14"><path d="M1 1l6 6-6 6" stroke="${CL.muted}" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>`;
    }).join('');
    offersHtml = `<div style="padding:0 16px;margin-top:18px">
      <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:${CL.muted};letter-spacing:1px;text-transform:uppercase;margin-bottom:10px">NEEDS RESPONSE · ${offers.length}</div>
      <div style="display:flex;flex-direction:column;gap:8px">${offerCards}</div>
    </div>`;
  }

  let weekHtml = '';
  if (week.length) {
    const weekCards = week.map(c => {
      const prop = _propNameForClean(c);
      const pay = _cleanPay(c);
      const d = c.date ? new Date(c.date + 'T12:00:00') : null;
      const dayAbbr = d ? d.toLocaleDateString('en-AU', { weekday: 'short' }).toUpperCase() : '';
      const dayNum = d ? d.getDate() : '';
      return `<div style="background:${CL.surface};border-radius:14px;padding:12px;border:1px solid ${CL.hairline};display:flex;align-items:center;gap:12px">
        <div style="width:50px;padding:6px 0;border-radius:10px;background:${CL.primarySoft};text-align:center;flex-shrink:0">
          <div style="font-size:9px;font-family:'JetBrains Mono',monospace;color:${CL.ink2};letter-spacing:0.4px">${dayAbbr}</div>
          <div style="font-size:16px;font-weight:700;color:${CL.primary};font-family:'Newsreader',serif;line-height:1">${dayNum}</div>
        </div>
        <div style="flex:1">
          <div style="font-size:13.5px;font-weight:700;color:${CL.ink}">${escHtml(prop)}</div>
          <div style="font-size:11.5px;color:${CL.muted};margin-top:2px;font-family:'JetBrains Mono',monospace">${pay ? '$' + pay : ''}</div>
        </div>
        <div style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;background:${CL.primarySoft};color:${CL.primary}">Accepted</div>
      </div>`;
    }).join('');
    weekHtml = `<div style="padding:0 16px;margin-top:18px;padding-bottom:14px">
      <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:${CL.muted};letter-spacing:1px;text-transform:uppercase;margin-bottom:10px">THIS WEEK</div>
      <div style="display:flex;flex-direction:column;gap:8px">${weekCards}</div>
    </div>`;
  }

  _showOverlay(`<div style="background:${CL.bg};min-height:100vh">
    <div style="padding:12px 16px 14px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:${CL.muted};letter-spacing:0.5px;text-transform:uppercase">${escHtml(dayLabel)} · $${weekEarnings} this week</div>
        <div style="font-family:'Newsreader',serif;font-size:26px;font-weight:600;color:${CL.ink};letter-spacing:-0.5px;margin-top:2px">Hi, ${escHtml(name)}</div>
      </div>
      <div style="width:38px;height:38px;border-radius:50%;background:${CL.accent};color:#fff;display:flex;align-items:center;justify-content:center;font-family:'Newsreader',serif;font-weight:700;font-size:14px">${escHtml(initial)}</div>
    </div>
    ${heroHtml}
    ${offersHtml}
    ${weekHtml}
    <div style="padding:16px;text-align:center">
      <button onclick="hideCleanerV2()" style="font-size:13px;color:${CL.muted};background:none;border:none;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;text-decoration:underline">Back to classic view</button>
    </div>
  </div>`);
}

// ── OFFER DETAIL ────────────────────────────────────────────────────────────
function showCleanerOffer(cleanId) {
  const c = _getCleanerCleans().find(x => String(x._cloudId || x.id) === String(cleanId));
  if (!c) { _hideOverlay(); return; }
  const prop = _propNameForClean(c);
  const b = _bookingForClean(c);
  const pay = _cleanPay(c);
  const dateStr = c.date ? new Date(c.date + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const guests = b ? (b.guests || '?') : '?';
  const nights = b ? (b.nights || '?') : '?';
  const guestName = b ? (b.name || 'Guest') : 'Guest';

  const details = [
    ['Property', prop],
    ['After', guestName + ' · ' + nights + ' nights'],
    ['Pay', '$' + pay + ' · paid Mon following'],
  ].map(([k, v]) =>
    `<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:10px 0;border-top:1px solid ${CL.hairline};gap:12px">
      <span style="font-size:12px;color:${CL.muted};font-family:'JetBrains Mono',monospace;letter-spacing:0.3px;text-transform:uppercase">${k}</span>
      <span style="font-size:13.5px;font-weight:600;color:${CL.ink};text-align:right">${escHtml(v)}</span>
    </div>`
  ).join('');

  const note = c.notes ? `<div style="padding:0 16px;margin-top:18px">
    <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:${CL.muted};letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">NOTE FROM HOST</div>
    <div style="background:${CL.surface};border-radius:16px;padding:14px;border:1px solid ${CL.hairline};font-size:13px;color:${CL.ink2};line-height:1.5;font-style:italic">"${escHtml(c.notes)}"</div>
  </div>` : '';

  const cid = escHtml(String(c._cloudId || c.id));
  _showOverlay(`<div style="background:${CL.bg};min-height:100vh">
    <div style="padding:8px 16px 0;display:flex;align-items:center;justify-content:space-between">
      <button onclick="showCleanerHome()" style="background:none;border:none;cursor:pointer;padding:4px">
        <svg width="14" height="14" viewBox="0 0 14 14"><path d="M9 2L3 7l6 5" stroke="${CL.ink2}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;background:#fbeacf;color:${CL.accent};font-family:'JetBrains Mono',monospace">OFFER</div>
    </div>
    <div style="padding:14px 16px 0">
      <div style="font-family:'Newsreader',serif;font-size:26px;font-weight:600;color:${CL.ink};letter-spacing:-0.4px">${escHtml(prop)}</div>
      <div style="font-size:13px;color:${CL.ink2};margin-top:4px">${escHtml(dateStr)}</div>
    </div>
    <div style="padding:0 16px;margin-top:18px">
      <div style="background:${CL.surface};border-radius:20px;padding:18px;border:1px solid ${CL.hairline}">${details}</div>
    </div>
    ${note}
    <div style="padding:22px 16px 14px;display:flex;flex-direction:column;gap:8px">
      <button onclick="cleanerAccept('${cid}');showCleanerHome()" style="height:54px;border-radius:16px;background:${CL.primary};color:#fff;border:none;font-family:'Plus Jakarta Sans',sans-serif;font-size:16px;font-weight:600;cursor:pointer">Accept clean · $${pay}</button>
      <button onclick="cleanerDecline('${cid}');showCleanerHome()" style="height:54px;border-radius:16px;background:transparent;color:${CL.ink2};border:1.5px solid ${CL.hairline};font-family:'Plus Jakarta Sans',sans-serif;font-size:16px;font-weight:600;cursor:pointer">Decline</button>
    </div>
  </div>`);
}

// ── ACTIVE CLEAN (timer + checklist) ────────────────────────────────────────
function showCleanerActive(cleanId) {
  const c = _getCleanerCleans().find(x => String(x._cloudId || x.id) === String(cleanId));
  if (!c) { _hideOverlay(); return; }
  const prop = _propNameForClean(c);
  const dateStr = c.date ? new Date(c.date + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : '';

  const storageKey = 'stayops.clean-timer.' + (c._cloudId || c.id);
  _cleanTimerStart = localStorage.getItem(storageKey);
  if (!_cleanTimerStart) {
    _cleanTimerStart = Date.now().toString();
    localStorage.setItem(storageKey, _cleanTimerStart);
  }

  const checklist = (c.checklist || [
    'Strip & wash linens', 'Make beds', 'Replace towels',
    'Empty fridge of perishables', 'Restock basics', 'Vacuum & mop', 'Final photo',
  ]);
  const doneKey = 'stayops.clean-done.' + (c._cloudId || c.id);
  let doneItems = JSON.parse(localStorage.getItem(doneKey) || '[]');

  function renderActive() {
    const elapsed = Math.floor((Date.now() - Number(_cleanTimerStart)) / 60000);
    const total = checklist.length;
    const completed = doneItems.length;
    const pct = total ? Math.round((completed / total) * 100) : 0;
    const cid = escHtml(String(c._cloudId || c.id));

    const checkHtml = checklist.map((item, i) => {
      const isDone = doneItems.includes(i);
      const isCurrent = !isDone && !doneItems.includes(i) && (i === 0 || doneItems.includes(i - 1));
      return `<div onclick="toggleCleanerCheckItem(${i})" style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-top:${i ? '1px solid ' + CL.hairline : 'none'};background:${isCurrent ? '#fff8ec' : 'transparent'};cursor:pointer">
        <div style="width:24px;height:24px;border-radius:8px;border:1.5px solid ${isDone ? CL.primary : isCurrent ? CL.accent : CL.hairline};background:${isDone ? CL.primary : 'transparent'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
          ${isDone ? '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6l3 3 5-6" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
        </div>
        <div style="flex:1;font-size:13.5px;color:${isDone ? CL.muted : CL.ink};text-decoration:${isDone ? 'line-through' : 'none'};font-weight:${isCurrent ? 700 : 600}">${escHtml(typeof item === 'string' ? item : item.label || item.l || 'Task')}</div>
      </div>`;
    }).join('');

    _showOverlay(`<div style="background:${CL.bg};min-height:100vh">
      <div style="background:${CL.ink};color:#fff;padding:12px 16px 22px;border-bottom-left-radius:28px;border-bottom-right-radius:28px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="width:8px;height:8px;border-radius:50%;background:${CL.accent};animation:so-pulse 1.4s infinite"></div>
            <span style="font-size:11px;font-family:'JetBrains Mono',monospace;color:rgba(255,255,255,0.7);letter-spacing:0.5px;text-transform:uppercase">IN PROGRESS · ${elapsed} MIN</span>
          </div>
          <button onclick="showCleanerHome()" style="font-size:12px;color:rgba(255,255,255,0.6);font-family:'JetBrains Mono',monospace;background:none;border:none;cursor:pointer">Back</button>
        </div>
        <div style="margin-top:14px;font-family:'Newsreader',serif;font-size:26px;font-weight:600;letter-spacing:-0.5px">${escHtml(prop)}</div>
        <div style="font-size:12.5px;color:rgba(255,255,255,0.65);margin-top:2px">${escHtml(dateStr)} · est. 2 hrs</div>
        <div style="margin-top:18px">
          <div style="display:flex;justify-content:space-between;font-size:11px;font-family:'JetBrains Mono',monospace;color:rgba(255,255,255,0.6);letter-spacing:0.4px">
            <span>${completed} of ${total}</span><span>${pct}%</span>
          </div>
          <div style="height:8px;margin-top:6px;border-radius:999px;background:rgba(255,255,255,0.15);overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${CL.accent};transition:width 0.3s"></div>
          </div>
        </div>
      </div>
      <div style="padding:0 16px;margin-top:18px">
        <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:${CL.muted};letter-spacing:1px;text-transform:uppercase;margin-bottom:10px">CHECKLIST</div>
        <div style="background:${CL.surface};border-radius:18px;border:1px solid ${CL.hairline};overflow:hidden">${checkHtml}</div>
      </div>
      <div style="padding:18px 16px 14px">
        <button onclick="completeCleanerClean('${cid}')" style="width:100%;height:54px;border-radius:16px;background:${CL.primary};color:#fff;border:none;font-size:16px;font-weight:600;font-family:'Plus Jakarta Sans',sans-serif;cursor:pointer">Mark complete & notify host</button>
      </div>
    </div>`);
  }

  window.toggleCleanerCheckItem = function(idx) {
    if (doneItems.includes(idx)) {
      doneItems = doneItems.filter(i => i !== idx);
    } else {
      doneItems.push(idx);
    }
    localStorage.setItem(doneKey, JSON.stringify(doneItems));
    renderActive();
  };

  renderActive();
  _cleanTimerInterval = setInterval(renderActive, 60000);
}

function _stopCleanTimer() {
  if (_cleanTimerInterval) { clearInterval(_cleanTimerInterval); _cleanTimerInterval = null; }
}

function completeCleanerClean(cleanId) {
  _stopCleanTimer();
  const storageKey = 'stayops.clean-timer.' + cleanId;
  const start = localStorage.getItem(storageKey);
  const elapsed = start ? Math.floor((Date.now() - Number(start)) / 60000) : 0;
  const hrs = Math.floor(elapsed / 60);
  const mins = elapsed % 60;
  const duration = hrs > 0 ? hrs + 'h ' + mins + 'm' : mins + 'm';
  localStorage.removeItem(storageKey);
  localStorage.removeItem('stayops.clean-done.' + cleanId);

  if (typeof globalThis.cleanerMarkDone === 'function') {
    globalThis.cleanerMarkDone(cleanId);
  }

  const c = _getCleanerCleans().find(x => String(x._cloudId || x.id) === String(cleanId));
  const pay = c ? _cleanPay(c) : 0;

  _showOverlay(`<div style="background:${CL.bg};min-height:100vh">
    <div style="padding:60px 16px 0;text-align:center">
      <div style="width:88px;height:88px;border-radius:28px;background:${CL.primary};margin:0 auto;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(28,90,85,0.3)">
        <svg width="40" height="40" viewBox="0 0 40 40"><path d="M10 21l6 7 14-16" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div style="margin-top:18px;font-family:'Newsreader',serif;font-size:30px;font-weight:600;color:${CL.ink};letter-spacing:-0.5px">Done in ${escHtml(duration)}</div>
      <div style="margin-top:6px;font-size:14px;color:${CL.ink2};line-height:1.5;max-width:280px;margin:6px auto 0">Host has been notified. Photo and notes saved to the booking.</div>
    </div>
    ${pay ? `<div style="padding:0 16px;margin-top:28px">
      <div style="background:${CL.surface};border-radius:20px;padding:18px;border:1px solid ${CL.hairline}">
        <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:${CL.muted};letter-spacing:0.5px;text-transform:uppercase">YOU EARNED</div>
        <div style="margin-top:4px;font-family:'Newsreader',serif;font-size:38px;font-weight:600;color:${CL.primary};letter-spacing:-0.8px">$${pay.toFixed(2)}</div>
      </div>
    </div>` : ''}
    <div style="padding:18px 16px 14px">
      <button onclick="showCleanerHome()" style="width:100%;height:50px;border-radius:14px;background:transparent;color:${CL.primary};border:1.5px solid ${CL.primary};font-size:15px;font-weight:600;font-family:'Plus Jakarta Sans',sans-serif;cursor:pointer">Back to home</button>
    </div>
  </div>`);
}

function hideCleanerV2() {
  _hideOverlay();
}

export {
  showCleanerHome,
  showCleanerOffer,
  showCleanerActive,
  completeCleanerClean,
  hideCleanerV2,
};
