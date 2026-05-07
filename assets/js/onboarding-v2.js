/**
 * StayOps — v2 Onboarding wizard (15-screen flow).
 * Self-contained overlay; dynamically creates and manages its own DOM.
 */
import { escHtml } from './utils.js';

let _obStep = 0;
let _obData = {};
let _obOverlay = null;
const _OB_TOTAL_STEPS = 15;

function _el(id) { return document.getElementById(id); }

function _ensureOverlay() {
  if (_obOverlay && document.body.contains(_obOverlay)) return _obOverlay;
  _obOverlay = document.createElement('div');
  _obOverlay.id = 'onboarding-v2-overlay';
  _obOverlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;overflow-y:auto;transition:opacity 0.3s';
  document.body.appendChild(_obOverlay);
  return _obOverlay;
}

function _show(html) {
  const ov = _ensureOverlay();
  ov.innerHTML = html;
  ov.style.display = 'flex';
}

function _hide() {
  if (_obOverlay) { _obOverlay.style.display = 'none'; _obOverlay.innerHTML = ''; }
}

function _back() {
  if (_obStep > 0) { _obStep--; _render(); }
}

function _next() {
  _obStep++;
  _render();
}

function _skipToDashboard() {
  _hide();
  if (typeof globalThis.renderAll === 'function') globalThis.renderAll();
}

// Shared UI fragments
function _topBar(stepLabel, showBack = true, showSkip = false) {
  return `<div style="padding:8px 22px 0;display:flex;align-items:center;justify-content:space-between">
    ${showBack ? `<div onclick="window._obBack()" style="width:38px;height:38px;border-radius:12px;background:#fff;border:1px solid var(--hairline-1);display:flex;align-items:center;justify-content:center;cursor:pointer;touch-action:manipulation">
      <svg width="14" height="14" viewBox="0 0 14 14"><path d="M9 2L3 7l6 5" stroke="var(--ink-2)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>` : '<div style="width:38px"></div>'}
    ${showSkip ? `<div onclick="window._obSkipToDashboard()" style="font-size:13px;font-weight:600;color:var(--muted-2);cursor:pointer;touch-action:manipulation">Skip</div>` : ''}
    ${stepLabel ? `<div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted-2);letter-spacing:0.5px">${stepLabel}</div>` : (showSkip ? '' : '<div></div>')}
  </div>`;
}

function _field(label, id, placeholder, opts = {}) {
  const opt = opts.optional ? ' <span style="font-size:11px;color:var(--muted-2);font-weight:400">(optional)</span>' : '';
  const prefix = opts.prefix || '';
  const type = opts.type || 'text';
  const val = opts.value || '';
  return `<div style="margin-bottom:16px">
    <label style="font-size:13px;font-weight:600;color:var(--ink-2);display:block;margin-bottom:6px">${label}${opt}</label>
    <div style="position:relative">
      ${prefix ? `<span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--muted-2)">${prefix}</span>` : ''}
      <input id="${id}" type="${type}" placeholder="${placeholder || ''}" value="${escHtml(val)}" class="so-input" style="${prefix ? 'padding-left:38px;' : ''}width:100%;box-sizing:border-box">
    </div>
    ${opts.hint ? `<div style="font-size:12px;color:var(--muted-2);margin-top:4px">${opts.hint}</div>` : ''}
  </div>`;
}

function _btn(text, onclick, variant = 'primary') {
  if (variant === 'primary') {
    return `<button onclick="${onclick}" class="so-btn-primary" style="width:100%;margin-bottom:8px">${text}</button>`;
  }
  return `<div onclick="${onclick}" style="width:100%;border:1px solid var(--hairline-1);border-radius:14px;padding:14px;text-align:center;color:var(--ink-2);font-size:14px;font-weight:600;cursor:pointer;box-sizing:border-box;touch-action:manipulation;font-family:'Plus Jakarta Sans',sans-serif;margin-bottom:8px">${text}</div>`;
}

// ── SCREEN RENDERERS ──────────────────────────────────────────────────────

function _renderSplash() {
  _show(`<div style="flex:1;display:flex;flex-direction:column;background:#1f3f35;position:relative;overflow:hidden">
    <svg viewBox="0 0 390 844" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:0.06">
      <circle cx="85" cy="180" r="14" stroke="#fff" stroke-width="2.5" fill="none"/>
      <rect x="83" y="194" width="4" height="28" fill="#fff"/>
      <rect x="87" y="212" width="10" height="3" fill="#fff"/>
      <path d="M290 260 L310 244 L330 260 L330 286 L290 286 Z" stroke="#fff" stroke-width="2" fill="none"/>
      <rect x="295" y="560" width="32" height="28" rx="5" stroke="#fff" stroke-width="2" fill="none"/>
      <line x1="295" y1="570" x2="327" y2="570" stroke="#fff" stroke-width="1.5"/>
    </svg>
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0;z-index:1">
      <svg width="56" height="56" viewBox="0 0 56 56" style="margin-bottom:24px">
        <path d="M8 48 V24 a20 20 0 0 1 40 0 V48" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="3"/>
        <path d="M18 48 V30 a10 10 0 0 1 20 0 V48" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="2"/>
        <circle cx="28" cy="36" r="3" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" fill="none"/>
        <rect x="27" y="39" width="2" height="6" fill="rgba(255,255,255,0.5)"/>
      </svg>
      <div style="font-family:'Newsreader',serif;font-size:42px;font-weight:500;color:#f5f1ea;letter-spacing:-1px;line-height:1">
        Stay<em style="color:#a8c5b5;font-style:italic">Ops</em>
      </div>
      <div style="margin-top:28px;display:flex;gap:8px;align-items:center">
        <div class="ob-dot" style="width:7px;height:7px;border-radius:50%;background:rgba(207,225,217,0.5);animation:so-pulse 1.2s 0s infinite"></div>
        <div class="ob-dot" style="width:7px;height:7px;border-radius:50%;background:rgba(207,225,217,0.5);animation:so-pulse 1.2s 0.25s infinite"></div>
        <div class="ob-dot" style="width:7px;height:7px;border-radius:50%;background:rgba(207,225,217,0.5);animation:so-pulse 1.2s 0.5s infinite"></div>
      </div>
      <div style="margin-top:14px;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:rgba(207,225,217,0.5);letter-spacing:0.6px">Checking your session…</div>
    </div>
    <div style="text-align:center;padding-bottom:24px">
      <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(207,225,217,0.3);letter-spacing:1.5px;text-transform:uppercase">Short-stay property management</div>
    </div>
  </div>`);
  setTimeout(() => { _obStep = 1; _render(); }, 2200);
}

function _renderWelcome() {
  _show(`<div style="flex:1;display:flex;flex-direction:column;background:var(--bg,#f5f1ea)">
    <div style="flex:1;display:flex;flex-direction:column;justify-content:space-between;padding:0 26px">
      <div style="padding-top:20px;display:flex;justify-content:space-between;align-items:center">
        <svg width="26" height="26" viewBox="0 0 56 56"><path d="M8 48 V24 a20 20 0 0 1 40 0 V48" fill="none" stroke="var(--primary)" stroke-width="3"/><circle cx="28" cy="36" r="3" stroke="var(--primary)" stroke-width="1.5" fill="none"/></svg>
        <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted-2);letter-spacing:0.6px">v1.0</div>
      </div>
      <div style="position:relative;height:320px;margin-top:6px">
        <div style="position:absolute;top:18px;right:24px;width:92px;height:92px;border-radius:50%;background:var(--accent-soft)"></div>
        <svg viewBox="0 0 320 320" style="position:absolute;inset:0;width:100%;height:100%">
          <defs><linearGradient id="archG" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#3a6f5d"/><stop offset="1" stop-color="#234538"/></linearGradient></defs>
          <path d="M40 280 V160 a120 120 0 0 1 240 0 V280" fill="url(#archG)"/>
          <path d="M100 280 V190 a60 60 0 0 1 120 0 V280" fill="var(--bg,#f5f1ea)"/>
          <rect x="40" y="280" width="240" height="14" fill="var(--ink-1)"/>
          <circle cx="160" cy="218" r="9" stroke="var(--primary)" stroke-width="3" fill="none"/>
          <rect x="158" y="226" width="4" height="22" fill="var(--primary)"/>
        </svg>
        <div style="position:absolute;top:36px;left:8px;background:#fff;border-radius:14px;padding:10px 14px;box-shadow:var(--shadow-card);display:flex;gap:10px;align-items:center">
          <div style="width:28px;height:28px;border-radius:8px;background:var(--primary-soft);display:flex;align-items:center;justify-content:center">
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 7l3 3 7-7" stroke="var(--primary)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <div>
            <div style="font-size:12px;font-weight:600;color:var(--ink-1)">Cabin Anneke cleaned</div>
            <div style="font-size:10px;color:var(--muted-2);font-family:'JetBrains Mono',monospace">11:42 · Mara</div>
          </div>
        </div>
        <div style="position:absolute;bottom:18px;right:0;background:#fff;border-radius:14px;padding:10px 14px;box-shadow:var(--shadow-card);display:flex;gap:10px;align-items:center">
          <div style="width:28px;height:28px;border-radius:8px;background:var(--accent-soft);display:flex;align-items:center;justify-content:center">
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 5h8M3 8h6M3 11h4" stroke="var(--warn)" stroke-width="1.6" stroke-linecap="round"/></svg>
          </div>
          <div>
            <div style="font-size:12px;font-weight:600;color:var(--ink-1)">2 check-ins tomorrow</div>
            <div style="font-size:10px;color:var(--muted-2);font-family:'JetBrains Mono',monospace">Sat · 27 Jun</div>
          </div>
        </div>
      </div>
      <div style="padding-bottom:10px">
        <div style="font-family:'Newsreader',serif;font-size:38px;line-height:1.06;color:var(--ink-1);font-weight:500;letter-spacing:-0.8px">
          Run your short-stay rental from <em style="color:var(--primary);font-style:italic">one calm</em> dashboard.
        </div>
        <div style="margin-top:14px;font-size:15px;line-height:1.5;color:var(--ink-2)">
          Bookings, cleaners, expenses and check-ins — all in the place you actually look.
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;padding-bottom:24px">
        ${_btn('Get started', 'window._obNext()')}
        ${_btn('I already have an account', 'window._obGoLogin()', 'ghost')}
      </div>
    </div>
  </div>`);
}

function _renderSignUp() {
  _show(`<div style="flex:1;display:flex;flex-direction:column;background:var(--bg,#f5f1ea)">
    ${_topBar('1 / 4')}
    <div style="padding:24px 22px 0">
      <div style="font-family:'Newsreader',serif;font-size:30px;line-height:1.1;color:var(--ink-1);font-weight:500;letter-spacing:-0.5px">Let's get you set up.</div>
      <div style="margin-top:8px;font-size:14px;color:var(--ink-2)">Takes about 2 minutes. We'll start with the basics.</div>
    </div>
    <div style="padding:24px 22px 0;display:flex;flex-direction:column;gap:0;flex:1">
      ${_field('Your name', 'ob2-name', 'Emma de Vries')}
      ${_field('Email', 'ob2-email', 'you@email.com', { type: 'email' })}
      ${_field('Password', 'ob2-password', 'At least 8 characters', { type: 'password', hint: 'At least 8 characters.' })}
    </div>
    <div style="padding:0 22px 24px;display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;align-items:flex-start;gap:10px;font-size:12px;color:var(--ink-2);line-height:1.5">
        <div id="ob2-terms-cb" onclick="this.classList.toggle('on')" class="so-checkbox on" style="flex-shrink:0;margin-top:1px">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5l2 2 4-4" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <span>I agree to the <span style="color:var(--primary);text-decoration:underline">Terms</span> and <span style="color:var(--primary);text-decoration:underline">Privacy</span>.</span>
      </div>
      ${_btn('Create account', 'window._obSignUp()')}
      <div style="text-align:center;font-size:13px;color:var(--ink-2)">Already a host? <span onclick="window._obGoLogin()" style="color:var(--primary);font-weight:600;cursor:pointer">Log in</span></div>
    </div>
  </div>`);
}

function _renderSettingUp() {
  _show(`<div style="flex:1;display:flex;flex-direction:column;background:var(--primary,#2f5d4e);color:#fff;position:relative;overflow:hidden">
    <svg viewBox="0 0 400 400" style="position:absolute;top:40%;left:-20%;width:600px;height:600px;opacity:0.07">
      <path d="M50 350 V200 a150 150 0 0 1 300 0 V350" stroke="#fff" stroke-width="3" fill="none"/>
    </svg>
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:0 32px;position:relative">
      <div style="width:84px;height:84px;border-radius:50%;border:3px solid rgba(255,255,255,0.15);border-top-color:var(--accent);position:relative;margin-bottom:28px;animation:ob-spin 1s linear infinite">
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
          <svg width="32" height="32" viewBox="0 0 56 56"><path d="M8 48 V24 a20 20 0 0 1 40 0 V48" fill="none" stroke="#fff" stroke-width="3"/></svg>
        </div>
      </div>
      <div style="font-family:'Newsreader',serif;font-size:30px;font-weight:500;letter-spacing:-0.5px;text-align:center;line-height:1.1">Setting up your workspace…</div>
      <div style="margin-top:10px;font-size:14px;color:rgba(255,255,255,0.7);text-align:center;max-width:280px">Creating your account, default cleaning rules, and a sample report.</div>
      <div id="ob2-setup-list" style="margin-top:36px;width:100%;display:flex;flex-direction:column;gap:12px;font-family:'JetBrains Mono',monospace;font-size:13px">
        <div class="ob2-setup-row" data-done="false" style="display:flex;align-items:center;gap:12px;color:rgba(255,255,255,0.5)">
          <div style="width:18px;height:18px;border-radius:5px;border:1.5px solid rgba(255,255,255,0.4);display:flex;align-items:center;justify-content:center"></div>
          <span>Account created</span>
        </div>
        <div class="ob2-setup-row" data-done="false" style="display:flex;align-items:center;gap:12px;color:rgba(255,255,255,0.5)">
          <div style="width:18px;height:18px;border-radius:5px;border:1.5px solid rgba(255,255,255,0.4);display:flex;align-items:center;justify-content:center"></div>
          <span>Default tax rules</span>
        </div>
        <div class="ob2-setup-row" data-done="false" style="display:flex;align-items:center;gap:12px;color:rgba(255,255,255,0.5)">
          <div style="width:18px;height:18px;border-radius:5px;border:1.5px solid rgba(255,255,255,0.4);display:flex;align-items:center;justify-content:center"></div>
          <span>Cleaning templates</span>
        </div>
        <div class="ob2-setup-row" data-done="false" style="display:flex;align-items:center;gap:12px;color:rgba(255,255,255,0.5)">
          <div style="width:18px;height:18px;border-radius:5px;border:1.5px solid rgba(255,255,255,0.4);display:flex;align-items:center;justify-content:center"></div>
          <span>Sample monthly report</span>
        </div>
      </div>
    </div>
  </div>`);
  _animateSetupRows();
}

function _animateSetupRows() {
  const rows = document.querySelectorAll('.ob2-setup-row');
  let i = 0;
  const tick = () => {
    if (i >= rows.length) { setTimeout(_next, 600); return; }
    const row = rows[i];
    row.style.color = '#fff';
    const box = row.querySelector('div');
    box.style.background = 'var(--accent)';
    box.style.borderColor = 'var(--accent)';
    box.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5l2 2 4-4" stroke="#1c2620" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    i++;
    setTimeout(tick, 500);
  };
  setTimeout(tick, 600);
}

function _renderVerifyEmail() {
  const email = _obData.email || 'your email';
  _show(`<div style="flex:1;display:flex;flex-direction:column;background:var(--bg,#f5f1ea)">
    ${_topBar('2 / 4')}
    <div style="padding:32px 26px 0">
      <div style="width:64px;height:64px;border-radius:18px;background:var(--primary-soft);display:flex;align-items:center;justify-content:center;margin-bottom:22px">
        <svg width="30" height="30" viewBox="0 0 30 30" fill="none"><rect x="3" y="7" width="24" height="16" rx="3" stroke="var(--primary)" stroke-width="2"/><path d="M3 9l12 8 12-8" stroke="var(--primary)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div style="font-family:'Newsreader',serif;font-size:30px;font-weight:500;color:var(--ink-1);line-height:1.1;letter-spacing:-0.5px">Check your inbox.</div>
      <div style="margin-top:8px;font-size:14px;color:var(--ink-2);line-height:1.5">We sent a 6-digit code to <strong style="color:var(--ink-1)">${escHtml(email)}</strong>. Enter it below to confirm.</div>
    </div>
    <div style="padding:32px 22px 0;flex:1">
      <div style="display:flex;gap:10px">
        ${[0,1,2,3,4,5].map(i => `<input id="ob2-otp-${i}" type="text" maxlength="1" inputmode="numeric" style="flex:1;height:64px;border-radius:14px;background:#fff;border:1px solid var(--hairline-1);text-align:center;font-family:'Newsreader',serif;font-size:26px;font-weight:500;color:var(--ink-1);box-sizing:border-box" oninput="window._obOtpInput(${i})" onkeydown="window._obOtpKey(event,${i})">`).join('')}
      </div>
      <div style="margin-top:22px;text-align:center;font-size:13px;color:var(--ink-2)">Didn't get it? <span style="color:var(--primary);font-weight:600">Resend in 0:42</span></div>
    </div>
    <div style="padding:0 22px 24px">
      ${_btn('Use a different email', 'window._obBack()', 'ghost')}
    </div>
  </div>`);
}

function _renderPropertyType() {
  const types = [
    { k: 'whole', label: 'Whole place', sub: 'House, apartment, cabin', icon: '<path d="M3 11l8-7 8 7v8a1 1 0 01-1 1H4a1 1 0 01-1-1v-8z"/><path d="M9 20v-5h4v5"/>' },
    { k: 'private', label: 'Private room', sub: 'Guests share common areas', icon: '<rect x="6" y="3" width="10" height="17" rx="1"/><circle cx="13" cy="12" r="0.7" fill="currentColor"/>' },
    { k: 'multi', label: 'Multi-unit', sub: 'Building or guesthouse', icon: '<rect x="3" y="6" width="7" height="14"/><rect x="12" y="3" width="7" height="17"/><path d="M5 10h3M5 13h3M14 7h3M14 10h3M14 13h3"/>' },
    { k: 'other', label: 'Something else', sub: 'Boat, tiny home, glamping', icon: '<path d="M11 4l-8 16h16L11 4z"/><path d="M11 4v16"/>' },
  ];
  const sel = _obData.propertyType || '';
  _show(`<div style="flex:1;display:flex;flex-direction:column;background:var(--bg,#f5f1ea)">
    ${_topBar('3 / 4')}
    <div style="padding:24px 22px 0">
      <div style="font-family:'Newsreader',serif;font-size:28px;line-height:1.12;color:var(--ink-1);font-weight:500;letter-spacing:-0.5px">What kind of place are you adding?</div>
      <div style="margin-top:8px;font-size:14px;color:var(--ink-2)">You can change this later. We'll only use it to set sensible defaults.</div>
    </div>
    <div style="padding:22px 22px 0;display:flex;flex-direction:column;gap:10px;flex:1">
      ${types.map(t => {
    const isSel = sel === t.k;
    return `<div onclick="window._obSetPropertyType('${t.k}')" style="display:flex;align-items:center;gap:14px;padding:16px;border-radius:18px;background:${isSel ? '#fff' : 'var(--surface2)'};border:1.5px solid ${isSel ? 'var(--primary)' : 'var(--hairline-1)'};box-shadow:${isSel ? '0 0 0 3px var(--primary-soft)' : 'none'};cursor:pointer;touch-action:manipulation">
          <div style="width:44px;height:44px;border-radius:12px;background:${isSel ? 'var(--primary-soft)' : 'var(--surface2)'};display:flex;align-items:center;justify-content:center">
            <svg viewBox="0 0 22 22" width="22" height="22" fill="none" stroke="${isSel ? 'var(--primary)' : 'var(--ink-2)'}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg>
          </div>
          <div style="flex:1">
            <div style="font-size:15px;font-weight:600;color:var(--ink-1)">${t.label}</div>
            <div style="font-size:12px;color:var(--muted-2);margin-top:2px">${t.sub}</div>
          </div>
          <div style="width:22px;height:22px;border-radius:50%;border:1.5px solid ${isSel ? 'var(--primary)' : 'var(--hairline-1)'};background:${isSel ? 'var(--primary)' : 'transparent'};display:flex;align-items:center;justify-content:center">
            ${isSel ? '<div style="width:8px;height:8px;border-radius:50%;background:#fff"></div>' : ''}
          </div>
        </div>`;
  }).join('')}
    </div>
    <div style="padding:14px 22px 24px">
      ${_btn('Continue', 'window._obNext()')}
    </div>
  </div>`);
}

function _renderAddProperty() {
  const beds = _obData.beds || 2;
  const baths = _obData.baths || 1;
  const guests = _obData.maxGuests || 4;
  _show(`<div style="flex:1;display:flex;flex-direction:column;background:var(--bg,#f5f1ea)">
    ${_topBar('3 / 4')}
    <div style="padding:20px 22px 0">
      <div style="font-family:'Newsreader',serif;font-size:28px;line-height:1.12;color:var(--ink-1);font-weight:500;letter-spacing:-0.5px">Add your first place.</div>
      <div style="margin-top:6px;font-size:13.5px;color:var(--ink-2);line-height:1.5">Just the basics. Pricing rules, integrations and tax can wait.</div>
    </div>
    <div style="padding:20px 22px 0;display:flex;flex-direction:column;gap:0;flex:1;overflow-y:auto">
      ${_field('Property name', 'ob2-prop-name', 'Dune Cottage', { hint: 'Guests and your cleaner will see this.' })}
      ${_field('Address', 'ob2-prop-address', 'Strandweg 14, Zandvoort', { prefix: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1a4.5 4.5 0 014.5 4.5c0 3-4.5 7.5-4.5 7.5S2.5 8.5 2.5 5.5A4.5 4.5 0 017 1z" stroke="var(--muted-2)" stroke-width="1.4"/><circle cx="7" cy="5.5" r="1.5" stroke="var(--muted-2)" stroke-width="1.4"/></svg>' })}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div>
          <label style="font-size:13px;font-weight:600;color:var(--ink-2);display:block;margin-bottom:6px">Bedrooms</label>
          <div class="so-stepper">
            <button type="button" onclick="window._obAdjust('beds',-1)">−</button>
            <span class="val"><span id="ob2-beds-val">${beds}</span></span>
            <button type="button" onclick="window._obAdjust('beds',1)">+</button>
          </div>
        </div>
        <div>
          <label style="font-size:13px;font-weight:600;color:var(--ink-2);display:block;margin-bottom:6px">Bathrooms</label>
          <div class="so-stepper">
            <button type="button" onclick="window._obAdjust('baths',-1)">−</button>
            <span class="val"><span id="ob2-baths-val">${baths}</span></span>
            <button type="button" onclick="window._obAdjust('baths',1)">+</button>
          </div>
        </div>
      </div>
      <div style="margin-bottom:16px">
        <label style="font-size:13px;font-weight:600;color:var(--ink-2);display:block;margin-bottom:6px">Max guests</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${[1,2,3,4,5,6].map(n => `<div onclick="window._obSetGuests(${n})" style="min-width:44px;height:40px;padding:0 14px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;background:${n === guests ? 'var(--primary)' : 'var(--surface2)'};color:${n === guests ? '#fff' : 'var(--ink-2)'};border:1px solid ${n === guests ? 'var(--primary)' : 'var(--hairline-1)'};cursor:pointer;touch-action:manipulation">${n === 6 ? '6+' : n}</div>`).join('')}
        </div>
      </div>
      <div style="margin-top:4px;padding:14px 16px;border-radius:14px;background:var(--primary-soft);display:flex;gap:12px;align-items:flex-start;margin-bottom:16px">
        <svg width="18" height="18" viewBox="0 0 18 18" style="margin-top:1px;flex-shrink:0"><circle cx="9" cy="9" r="8" stroke="var(--primary)" stroke-width="1.5" fill="none"/><path d="M9 5v5M9 12.5v0.5" stroke="var(--primary)" stroke-width="1.8" stroke-linecap="round"/></svg>
        <div style="font-size:12.5px;color:var(--primary-ink,#1f3f35);line-height:1.5">You can add a cleaner, photos, pricing and house rules from <strong>Settings → Property</strong> later.</div>
      </div>
    </div>
    <div style="padding:12px 22px 24px;display:flex;flex-direction:column;gap:0">
      ${_btn('Save property', 'window._obSaveProperty()')}
      ${_btn("I'll add the address later", 'window._obSaveProperty(true)', 'ghost')}
    </div>
  </div>`);
}

function _renderAddCleaner() {
  _show(`<div style="flex:1;display:flex;flex-direction:column;background:var(--bg,#f5f1ea)">
    ${_topBar(null, true, true)}
    <div style="padding:20px 22px 0">
      <span class="so-pill" style="background:var(--accent-soft);color:var(--warn)">Optional</span>
      <div style="margin-top:14px;font-family:'Newsreader',serif;font-size:28px;line-height:1.12;color:var(--ink-1);font-weight:500;letter-spacing:-0.5px">Who keeps ${escHtml(_obData.propertyName || 'your place')} tidy?</div>
      <div style="margin-top:8px;font-size:13.5px;color:var(--ink-2);line-height:1.5">Add your cleaner now and we'll auto-create cleans from your bookings. You can also do this later.</div>
    </div>
    <div style="padding:24px 22px 0;display:flex;flex-direction:column;gap:0;flex:1">
      ${_field("Cleaner's name", 'ob2-cl-name', 'Mara Janssen')}
      ${_field('Phone', 'ob2-cl-phone', '+31 6 1234 5678', { prefix: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 2h3l1 3-2 1a8 8 0 004 4l1-2 3 1v3a1 1 0 01-1 1A11 11 0 012 3a1 1 0 011-1z" stroke="var(--muted-2)" stroke-width="1.4" stroke-linejoin="round"/></svg>' })}
      ${_field('Email', 'ob2-cl-email', 'So we can send them schedules', { optional: true })}
      <div style="margin-top:6px;display:flex;align-items:center;gap:12px;padding:14px;border-radius:14px;background:#fff;border:1px solid var(--hairline-1)">
        <div style="width:36px;height:36px;border-radius:10px;background:var(--accent-soft);display:flex;align-items:center;justify-content:center">
          <svg width="18" height="18" viewBox="0 0 18 18"><path d="M3 8l3 3 9-9" stroke="var(--warn)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div style="flex:1;font-size:13px;color:var(--ink-2);line-height:1.45">Auto-text cleaner when a checkout is booked</div>
        <div id="ob2-autotext-toggle" onclick="this.classList.toggle('on')" class="so-toggle on" style="flex-shrink:0"></div>
      </div>
    </div>
    <div style="padding:12px 22px 24px;display:flex;flex-direction:column;gap:0">
      ${_btn('Add cleaner', 'window._obSaveCleaner()')}
      ${_btn("Skip — I'll add later", 'window._obNext()', 'ghost')}
    </div>
  </div>`);
}

function _renderPropertyCreated() {
  const name = _obData.propertyName || 'Your property';
  const address = _obData.propertyAddress || '';
  const beds = _obData.beds || 2;
  const baths = _obData.baths || 1;
  const guests = _obData.maxGuests || 4;
  _show(`<div style="flex:1;display:flex;flex-direction:column;background:var(--bg,#f5f1ea)">
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 26px">
      <div style="width:88px;height:88px;border-radius:26px;background:var(--primary);display:flex;align-items:center;justify-content:center;position:relative;align-self:flex-start">
        <svg width="44" height="44" viewBox="0 0 44 44"><path d="M10 22l8 8 16-16" stroke="#fff" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <div style="position:absolute;top:-6px;right:-10px;width:8px;height:8px;border-radius:50%;background:var(--accent)"></div>
        <div style="position:absolute;bottom:-10px;left:-6px;width:6px;height:6px;border-radius:50%;background:#e8a0bf"></div>
        <div style="position:absolute;top:20px;right:-20px;width:4px;height:4px;border-radius:50%;background:#b8a9d4"></div>
      </div>
      <div style="margin-top:28px;font-family:'Newsreader',serif;font-size:34px;line-height:1.08;font-weight:500;color:var(--ink-1);letter-spacing:-0.6px">${escHtml(name)} is live.</div>
      <div style="margin-top:12px;font-size:15px;color:var(--ink-2);line-height:1.55;max-width:320px">Your first property is set up. Next, we'll see if you want to plug in any of your existing tools — totally optional.</div>
      <div style="margin-top:28px;background:#fff;border-radius:18px;padding:16px;border:1px solid var(--hairline-1);display:flex;gap:14px;align-items:center">
        <div style="width:52px;height:52px;border-radius:14px;background:repeating-linear-gradient(135deg,var(--primary-soft),var(--primary-soft) 5px,var(--surface2) 5px,var(--surface2) 10px)"></div>
        <div style="flex:1">
          <div style="font-size:15px;font-weight:700;color:var(--ink-1)">${escHtml(name)}</div>
          <div style="font-size:12px;color:var(--muted-2);margin-top:2px">${address ? escHtml(address) + ' · ' : ''}${beds} bd · ${baths} ba · sleeps ${guests}</div>
        </div>
        <span class="so-pill" style="background:var(--primary-soft);color:var(--primary)">Active</span>
      </div>
    </div>
    <div style="padding:0 22px 24px;display:flex;flex-direction:column;gap:0">
      ${_btn('Continue', 'window._obNext()')}
      ${_btn('Skip to dashboard', 'window._obSkipToDashboard()', 'ghost')}
    </div>
  </div>`);
}

function _renderIntegrations() {
  const items = [
    { k: 'airbnb', title: 'Airbnb calendar', sub: 'Pull bookings from your iCal feed', bg: '#fbe1e7', popular: true },
    { k: 'gcal', title: 'Google Calendar', sub: 'Sync stays to your personal calendar', bg: '#dbe6f6' },
    { k: 'sheets', title: 'Google Sheets', sub: 'Import past bookings from a spreadsheet', bg: 'var(--primary-soft)' },
    { k: 'email', title: 'Email parser', sub: "Forward booking emails — we'll read them", bg: 'var(--accent-soft)' },
    { k: 'sms', title: 'Cleaner texts', sub: 'Auto-message your cleaner on checkouts', bg: '#e8d5f0' },
  ];
  _show(`<div style="flex:1;display:flex;flex-direction:column;background:var(--bg,#f5f1ea)">
    ${_topBar('4 / 4')}
    <div style="padding:20px 22px 0">
      <div style="font-family:'Newsreader',serif;font-size:28px;line-height:1.12;color:var(--ink-1);font-weight:500;letter-spacing:-0.5px">Connect what you already use.</div>
      <div style="margin-top:8px;font-size:13.5px;color:var(--ink-2);line-height:1.5">Hook up tools you already have — or skip and add bookings by hand. <strong style="color:var(--ink-1)">Nothing here is required.</strong></div>
    </div>
    <div style="padding:20px 22px 0;display:flex;flex-direction:column;gap:10px;flex:1;overflow-y:auto">
      ${items.map(it => `<div onclick="window._obConnectIntegration('${it.k}')" style="background:#fff;border-radius:16px;padding:14px;border:1px solid var(--hairline-1);display:flex;align-items:center;gap:14px;cursor:pointer;touch-action:manipulation">
        <div style="width:42px;height:42px;border-radius:12px;background:${it.bg};display:flex;align-items:center;justify-content:center">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--ink-1)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            ${it.k === 'airbnb' ? '<path d="M10 2c3 0 6 4 6 9 0 3-2 5-4 5-1 0-1.5-.6-2-1.5C9.5 15.6 9 16 8 16c-2 0-4-2-4-5 0-5 3-9 6-9z"/>' : ''}
            ${it.k === 'gcal' ? '<rect x="3" y="4" width="14" height="13" rx="2"/><path d="M3 8h14M7 2v4M13 2v4"/>' : ''}
            ${it.k === 'sheets' ? '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M3 8h14M3 13h14M8 3v14" stroke-width="1.2"/>' : ''}
            ${it.k === 'email' ? '<rect x="2" y="4" width="16" height="12" rx="2"/><path d="M2 6l8 5 8-5"/>' : ''}
            ${it.k === 'sms' ? '<path d="M3 5a2 2 0 012-2h10a2 2 0 012 2v7a2 2 0 01-2 2H8l-4 3v-3H5a2 2 0 01-2-2V5z"/>' : ''}
          </svg>
        </div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="font-size:14.5px;font-weight:600;color:var(--ink-1)">${it.title}</div>
            ${it.popular ? '<span class="so-pill" style="background:var(--primary-soft);color:var(--primary);font-size:10px;padding:2px 8px">Popular</span>' : ''}
          </div>
          <div style="font-size:12px;color:var(--muted-2);margin-top:2px">${it.sub}</div>
        </div>
        <div style="padding:8px 14px;border-radius:999px;font-size:12.5px;font-weight:600;color:var(--primary-ink,#1f3f35);background:var(--primary-soft)">Connect</div>
      </div>`).join('')}
    </div>
    <div style="padding:12px 22px 24px;display:flex;flex-direction:column;gap:0">
      ${_btn('Continue', 'window._obNext()')}
      ${_btn("Skip — I'll do this later", 'window._obNext()', 'ghost')}
    </div>
  </div>`);
}

function _renderNotifications() {
  _show(`<div style="flex:1;display:flex;flex-direction:column;background:var(--bg,#f5f1ea)">
    <div style="padding:8px 22px 0;display:flex;align-items:center;justify-content:flex-end">
      <div onclick="window._obNext()" style="font-size:13px;color:var(--muted-2);font-weight:600;cursor:pointer;touch-action:manipulation">Skip</div>
    </div>
    <div style="padding:24px 26px 0;flex:1">
      <div style="position:relative;height:200px;display:flex;align-items:center;justify-content:center">
        <div style="width:160px;height:160px;border-radius:50%;background:var(--primary-soft);position:absolute"></div>
        <svg width="92" height="92" viewBox="0 0 92 92" style="position:relative">
          <path d="M22 50a24 24 0 0148 0v14l8 10H14l8-10V50z" fill="var(--primary)"/>
          <path d="M38 78a8 8 0 0016 0" stroke="var(--primary)" stroke-width="3" fill="none" stroke-linecap="round"/>
          <circle cx="62" cy="32" r="9" fill="var(--accent)"/>
        </svg>
        <div style="position:absolute;top:20px;right:4px;background:#fff;border-radius:12px;padding:8px 12px;box-shadow:var(--shadow-card);font-size:11px;color:var(--ink-1);font-weight:600">New booking · $420</div>
        <div style="position:absolute;bottom:20px;left:4px;background:#fff;border-radius:12px;padding:8px 12px;box-shadow:var(--shadow-card);font-size:11px;color:var(--ink-1);font-weight:600">Mara finished cleaning</div>
      </div>
      <div style="margin-top:18px;font-family:'Newsreader',serif;font-size:28px;line-height:1.1;color:var(--ink-1);font-weight:500;letter-spacing:-0.5px">Stay in the loop.</div>
      <div style="margin-top:10px;font-size:14px;color:var(--ink-2);line-height:1.5">We'll only ping you for new bookings, cancellations, and finished cleans. No marketing — promise.</div>
    </div>
    <div style="padding:0 22px 24px;display:flex;flex-direction:column;gap:0">
      ${_btn('Turn on notifications', 'window._obEnableNotifications()')}
      ${_btn('Maybe later', 'window._obNext()', 'ghost')}
    </div>
  </div>`);
}

function _renderQuickStart() {
  const items = [
    { label: 'Add your first property', done: true, time: '1 min' },
    { label: 'Add your cleaner', done: !!_obData.cleanerName, time: '1 min' },
    { label: 'Import or add a booking', done: false, time: '2 min' },
    { label: 'Schedule your first clean', done: false, time: '1 min' },
    { label: 'Connect Airbnb calendar', done: false, time: '2 min', optional: true },
    { label: 'Log an expense or receipt', done: false, time: '1 min', optional: true },
  ];
  const completed = items.filter(i => i.done).length;
  const pct = Math.round(completed / items.length * 100);
  _show(`<div style="flex:1;display:flex;flex-direction:column;background:var(--bg,#f5f1ea)">
    <div style="padding:8px 22px 0;display:flex;align-items:center;justify-content:space-between">
      <svg width="22" height="22" viewBox="0 0 56 56"><path d="M8 48 V24 a20 20 0 0 1 40 0 V48" fill="none" stroke="var(--primary)" stroke-width="3"/><circle cx="28" cy="36" r="3" stroke="var(--primary)" stroke-width="1.5" fill="none"/></svg>
      <div onclick="window._obSkipToDashboard()" style="font-size:13px;color:var(--primary);font-weight:600;cursor:pointer;touch-action:manipulation">Skip</div>
    </div>
    <div style="padding:20px 22px 0">
      <span class="so-pill" style="background:var(--primary-soft);color:var(--primary)">${completed} of ${items.length} done</span>
      <div style="margin-top:14px;font-family:'Newsreader',serif;font-size:30px;line-height:1.1;color:var(--ink-1);font-weight:500;letter-spacing:-0.5px">You're nearly there.</div>
      <div style="margin-top:8px;font-size:13.5px;color:var(--ink-2);line-height:1.5">Finish these whenever — they'll stay on your dashboard until done.</div>
      <div style="margin-top:16px;height:8px;border-radius:999px;background:var(--surface2);overflow:hidden;border:1px solid var(--hairline-1)">
        <div style="width:${pct}%;height:100%;background:var(--primary);border-radius:999px;transition:width 0.3s"></div>
      </div>
    </div>
    <div style="padding:24px 22px 0;display:flex;flex-direction:column;gap:10px;flex:1;overflow-y:auto">
      ${items.map(it => `<div style="display:flex;align-items:center;gap:14px;padding:16px;border-radius:16px;background:${it.done ? 'var(--surface2)' : '#fff'};border:1px solid var(--hairline-1);opacity:${it.done ? '0.85' : '1'}">
        <div style="width:26px;height:26px;border-radius:50%;border:1.5px solid ${it.done ? 'var(--primary)' : 'var(--hairline-1)'};background:${it.done ? 'var(--primary)' : 'transparent'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
          ${it.done ? '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7l3 3 5-6" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
        </div>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="font-size:14.5px;font-weight:600;color:var(--ink-1);text-decoration:${it.done ? 'line-through' : 'none'};text-decoration-color:var(--muted-2)">${it.label}</div>
            ${it.optional ? '<span class="so-pill" style="background:var(--surface2);color:var(--muted-2);font-size:10px;padding:2px 8px">Optional</span>' : ''}
          </div>
          <div style="font-size:11.5px;color:var(--muted-2);margin-top:3px;font-family:'JetBrains Mono',monospace;letter-spacing:0.3px">${it.time}</div>
        </div>
        ${!it.done ? '<svg width="8" height="14" viewBox="0 0 8 14"><path d="M1 1l6 6-6 6" stroke="var(--muted-2)" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
      </div>`).join('')}
    </div>
    <div style="padding:12px 22px 24px">
      ${_btn('Take me to my dashboard', 'window._obSkipToDashboard()')}
    </div>
  </div>`);
}

function _renderLogin() {
  _show(`<div style="flex:1;display:flex;flex-direction:column;background:var(--bg,#f5f1ea)">
    ${_topBar(null)}
    <div style="padding:32px 22px 0;flex:1">
      <svg width="32" height="32" viewBox="0 0 56 56" style="margin-bottom:28px"><path d="M8 48 V24 a20 20 0 0 1 40 0 V48" fill="none" stroke="var(--primary)" stroke-width="3"/><circle cx="28" cy="36" r="3" stroke="var(--primary)" stroke-width="1.5" fill="none"/></svg>
      <div style="font-family:'Newsreader',serif;font-size:32px;line-height:1.1;color:var(--ink-1);font-weight:500;letter-spacing:-0.5px">Welcome back.</div>
      <div style="margin-top:26px;display:flex;flex-direction:column;gap:14px">
        ${_field('Email', 'ob2-login-email', 'you@email.com', { type: 'email' })}
        ${_field('Password', 'ob2-login-password', '••••••••', { type: 'password' })}
      </div>
      <div style="margin-top:14px;text-align:right;font-size:13px;color:var(--primary);font-weight:600">Forgot password?</div>
      <div id="ob2-login-error" style="font-size:12px;color:var(--red,#C0392B);min-height:18px;margin-top:14px"></div>
    </div>
    <div style="padding:0 22px 24px;display:flex;flex-direction:column;gap:0">
      ${_btn('Log in', 'window._obLogin()')}
      ${_btn('Create a new account', 'window._obGoSignUp()', 'ghost')}
    </div>
  </div>`);
}

// ── STEP ROUTER ──────────────────────────────────────────────────────────

function _render() {
  switch (_obStep) {
    case 0: _renderSplash(); break;
    case 1: _renderWelcome(); break;
    case 2: _renderSignUp(); break;
    case 3: _renderSettingUp(); break;
    case 4: _renderVerifyEmail(); break;
    case 5: _renderPropertyType(); break;
    case 6: _renderAddProperty(); break;
    case 7: _renderAddCleaner(); break;
    case 8: _renderPropertyCreated(); break;
    case 9: _renderIntegrations(); break;
    case 10: _renderNotifications(); break;
    case 11: _renderQuickStart(); break;
    // Login is a branch, not in the main sequence
    case 99: _renderLogin(); break;
    default: _skipToDashboard(); break;
  }
}

// ── ACTION HANDLERS ──────────────────────────────────────────────────────

function _obSignUp() {
  const name = (_el('ob2-name')?.value || '').trim();
  const email = (_el('ob2-email')?.value || '').trim();
  const pw = (_el('ob2-password')?.value || '').trim();
  if (!name || !email || !pw) return;
  _obData.name = name;
  _obData.email = email;
  if (typeof globalThis.handleSignUpSubmitFromOnboarding === 'function') {
    globalThis.handleSignUpSubmitFromOnboarding(name, email, pw).then(() => {
      _obStep = 3;
      _render();
    }).catch(() => {});
  } else {
    _obStep = 3;
    _render();
  }
}

function _obLogin() {
  const email = (_el('ob2-login-email')?.value || '').trim();
  const pw = (_el('ob2-login-password')?.value || '').trim();
  if (!email || !pw) return;
  _obData.email = email;
  if (typeof globalThis.handleLoginSubmit === 'function') {
    globalThis.handleLoginSubmit(email, pw);
  }
  _hide();
}

function _obSetPropertyType(k) {
  _obData.propertyType = k;
  _render();
}

function _obAdjust(field, delta) {
  const key = field === 'beds' ? 'beds' : 'baths';
  _obData[key] = Math.max(1, (_obData[key] || (key === 'beds' ? 2 : 1)) + delta);
  const valEl = _el(`ob2-${key}-val`);
  if (valEl) valEl.textContent = _obData[key];
}

function _obSetGuests(n) {
  _obData.maxGuests = n;
  _render();
}

function _obSaveProperty(skipAddress) {
  const name = (_el('ob2-prop-name')?.value || '').trim();
  if (!name) return;
  const address = skipAddress ? '' : (_el('ob2-prop-address')?.value || '').trim();
  _obData.propertyName = name;
  _obData.propertyAddress = address;
  if (typeof globalThis.savePropertyData === 'function') {
    globalThis.savePropertyData({
      name,
      address,
      bedrooms: _obData.beds || 2,
      bathrooms: _obData.baths || 1,
      maxGuests: _obData.maxGuests || 4,
      type: _obData.propertyType || 'whole',
    });
  }
  _next();
}

function _obSaveCleaner() {
  const name = (_el('ob2-cl-name')?.value || '').trim();
  const phone = (_el('ob2-cl-phone')?.value || '').trim();
  const email = (_el('ob2-cl-email')?.value || '').trim();
  if (!name) return;
  _obData.cleanerName = name;
  if (typeof globalThis.addCleanerFromOnboarding === 'function') {
    globalThis.addCleanerFromOnboarding({ name, phone, email });
  }
  _next();
}

function _obEnableNotifications() {
  if (typeof globalThis.subscribeToPush === 'function') {
    globalThis.subscribeToPush();
  }
  _next();
}

function _obConnectIntegration(k) {
  if (k === 'airbnb' && typeof globalThis.showSection === 'function') {
    _hide();
    globalThis.showSection('settings');
  }
}

function _obOtpInput(idx) {
  const el = _el(`ob2-otp-${idx}`);
  if (el && el.value.length === 1 && idx < 5) {
    _el(`ob2-otp-${idx + 1}`)?.focus();
  }
  const code = [0,1,2,3,4,5].map(i => _el(`ob2-otp-${i}`)?.value || '').join('');
  if (code.length === 6) {
    if (typeof globalThis.handleVerifySubmit === 'function') {
      globalThis.handleVerifySubmit(code);
    }
    _obStep = 5;
    _render();
  }
}

function _obOtpKey(e, idx) {
  if (e.key === 'Backspace' && !_el(`ob2-otp-${idx}`)?.value && idx > 0) {
    _el(`ob2-otp-${idx - 1}`)?.focus();
  }
}

function _obGoLogin() { _obStep = 99; _render(); }
function _obGoSignUp() { _obStep = 2; _render(); }

// ── PUBLIC API ──────────────────────────────────────────────────────────

export function runOnboarding() {
  _obStep = 0;
  _obData = {};
  _render();
}

export function hideOnboarding() {
  _hide();
}

// Expose handlers globally for onclick attributes
window._obBack = _back;
window._obNext = _next;
window._obSkipToDashboard = _skipToDashboard;
window._obSignUp = _obSignUp;
window._obLogin = _obLogin;
window._obSetPropertyType = _obSetPropertyType;
window._obAdjust = _obAdjust;
window._obSetGuests = _obSetGuests;
window._obSaveProperty = _obSaveProperty;
window._obSaveCleaner = _obSaveCleaner;
window._obEnableNotifications = _obEnableNotifications;
window._obConnectIntegration = _obConnectIntegration;
window._obOtpInput = _obOtpInput;
window._obOtpKey = _obOtpKey;
window._obGoLogin = _obGoLogin;
window._obGoSignUp = _obGoSignUp;
