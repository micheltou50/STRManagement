/**
 * StayOps — Payout Paste flow (Phase 1c). Split out of finance.js (2026-07-08,
 * see the architecture plan: same function + window.* names, finance.js stays
 * the barrel that imports this module).
 *
 * User pastes a platform earnings statement (Airbnb, Booking.com, etc.),
 * Claude extracts the line items into structured JSON, we auto-match
 * accommodation lines to bookings by confirmation_code, the user reviews,
 * then we persist via savePlatformPayout + insertPayoutLines.
 */
import { bookings } from './state.js';
import { escHtml, localDateStr } from './utils.js';
import { AIService } from './ai-logic.js';
import { isRevenueBearingBooking } from './booking-revenue.js';
import { savePlatformPayout, insertPayoutLines } from './supabase.js';
import { _financeActiveCloudPropertyId } from './finance-shared.js';
import { parseAirbnbTransactionCsv } from './airbnb-csv.js';

let _payoutExtracted = null;     // last AI-parsed payload (state B)
let _payoutMatchOverrides = {};  // user-edited booking matches by line index
let _payoutFileBase64 = null;    // base64 of attached statement file (PDF or image)
let _payoutFileMediaType = null; // 'application/pdf' or 'image/png' / 'image/jpeg' etc.
let _payoutFileName = null;      // for display

function openPayoutPasteModal() {
  document.getElementById('payout-paste-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  resetPayoutPasteModal();
}

function closePayoutPasteModal() {
  document.getElementById('payout-paste-modal').classList.remove('open');
  if (typeof globalThis._checkModalsClosed === 'function') globalThis._checkModalsClosed();
  _payoutExtracted = null;
  _payoutMatchOverrides = {};
  clearPayoutStatementFile();
}

function resetPayoutPasteModal() {
  _payoutExtracted = null;
  _payoutMatchOverrides = {};
  document.getElementById('payout-paste-input-section').style.display = 'block';
  document.getElementById('payout-paste-review-section').style.display = 'none';
  const status = document.getElementById('payout-paste-status');
  status.style.display = 'none';
  status.textContent = '';
}

async function attachPayoutStatementFile(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (file.size > 12 * 1024 * 1024) {
    _payoutPasteStatus('⚠ File is over 12MB — try a smaller PDF, screenshot, or export', 'err');
    input.value = '';
    return;
  }

  const name = (file.name || 'statement').toLowerCase();
  const mime = file.type || '';
  const isNumbers = name.endsWith('.numbers') || mime === 'application/vnd.apple.numbers';
  const isCsvLike = name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')
                 || mime === 'text/csv' || mime === 'text/tab-separated-values' || mime === 'text/plain';
  const isExcel   = name.endsWith('.xlsx') || name.endsWith('.xls')
                 || mime.includes('spreadsheetml') || mime === 'application/vnd.ms-excel';
  const isPdfImg  = mime === 'application/pdf' || mime.startsWith('image/')
                 || name.endsWith('.pdf');

  // Numbers files are a proprietary zip format SheetJS can't open.
  // Apple's Numbers app exports cleanly to CSV or xlsx.
  if (isNumbers) {
    _payoutPasteStatus('⚠ Numbers files aren\'t supported directly. In Numbers: File → Export To → CSV (or Excel), then attach the exported file.', 'err');
    input.value = '';
    return;
  }

  // CSV / TSV / plain text — read as text, drop into the textarea so the
  // user can review/edit before extraction. AI handles structured CSV well.
  if (isCsvLike) {
    try {
      const text = await file.text();
      _appendToPayoutTextarea(file.name, text);
      _clearPayoutFileState();
      _payoutPasteStatus('✓ Loaded ' + file.name + ' as text — click ✨ Extract', 'ok');
    } catch (e) {
      console.warn('[StayOps] CSV read failed', e);
      _payoutPasteStatus('⚠ Could not read that file', 'err');
    }
    input.value = '';
    return;
  }

  // Excel — lazy-load SheetJS from CDN and convert each sheet to CSV text.
  // Only loads the ~700KB library when the user actually uploads xlsx.
  if (isExcel) {
    _payoutPasteStatus('⏳ Reading spreadsheet...');
    try {
      const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      let allText = '';
      for (const sheetName of wb.SheetNames) {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
        if (!csv.trim()) continue;
        allText += (allText ? '\n\n' : '') + `=== Sheet: ${sheetName} ===\n` + csv;
      }
      if (!allText.trim()) {
        _payoutPasteStatus('⚠ Spreadsheet is empty', 'err');
        input.value = '';
        return;
      }
      _appendToPayoutTextarea(file.name, allText);
      _clearPayoutFileState();
      _payoutPasteStatus('✓ Loaded ' + file.name + ' (' + wb.SheetNames.length + ' sheet' + (wb.SheetNames.length === 1 ? '' : 's') + ') — click ✨ Extract', 'ok');
    } catch (e) {
      console.warn('[StayOps] xlsx read failed', e);
      _payoutPasteStatus('⚠ Could not read Excel file — try File → Save As → CSV in Excel and re-upload', 'err');
    }
    input.value = '';
    return;
  }

  // PDF / image — keep the file as a binary blob, send to Claude vision
  // via document/image content block (existing flow).
  if (isPdfImg) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target.result || '';
      const commaIdx = result.indexOf(',');
      _payoutFileBase64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : '';
      _payoutFileMediaType = mime === 'application/pdf' ? 'application/pdf' : (mime || 'image/jpeg');
      _payoutFileName = file.name || 'statement';
      const previewEl = document.getElementById('payout-paste-file-preview');
      const nameEl = document.getElementById('payout-paste-file-name');
      if (nameEl) {
        const sizeKb = (file.size / 1024).toFixed(0);
        nameEl.textContent = `📎 ${_payoutFileName} (${sizeKb} KB)`;
      }
      if (previewEl) previewEl.style.display = 'flex';
    };
    reader.onerror = () => { _payoutPasteStatus('⚠ Could not read that file', 'err'); };
    reader.readAsDataURL(file);
    return;
  }

  _payoutPasteStatus('⚠ Unsupported file type — use PDF, image, CSV, or Excel', 'err');
  input.value = '';
}

/** Append extracted text-format file content into the textarea, labeled with
 *  the original filename so the user can tell sources apart. */
function _appendToPayoutTextarea(filename, content) {
  const ta = document.getElementById('payout-paste-raw');
  if (!ta) return;
  const header = `--- ${filename} ---\n`;
  ta.value = (ta.value && ta.value.trim())
    ? ta.value.trim() + '\n\n' + header + content
    : header + content;
}

/** Reset the binary-file state used by the PDF/image vision path. */
function _clearPayoutFileState() {
  _payoutFileBase64 = null;
  _payoutFileMediaType = null;
  _payoutFileName = null;
  const previewEl = document.getElementById('payout-paste-file-preview');
  if (previewEl) previewEl.style.display = 'none';
}

function clearPayoutStatementFile() {
  _payoutFileBase64 = null;
  _payoutFileMediaType = null;
  _payoutFileName = null;
  const input = document.getElementById('payout-paste-file-input');
  if (input) input.value = '';
  const previewEl = document.getElementById('payout-paste-file-preview');
  if (previewEl) previewEl.style.display = 'none';
}

function _payoutPasteStatus(msg, kind) {
  const el = document.getElementById('payout-paste-status');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = msg;
  if (kind === 'err') {
    el.style.background = '#FEE2E2';
    el.style.color = '#991B1B';
  } else if (kind === 'ok') {
    el.style.background = '#DCFCE7';
    el.style.color = '#166534';
  } else {
    el.style.background = 'var(--surface2)';
    el.style.color = 'var(--ink-1)';
  }
}

/** Find a booking whose confirmation code matches the line's code (case-insensitive).
 *  Uses the imported `bookings` array from state.js (ES module live binding —
 *  populated by replaceArrayInPlace during hydration). The in-memory field is
 *  `b.confirmCode` (set by loadBookingsFromCloud), NOT `confirmationCode` or
 *  `confirmation_code` — those are DB / AI shapes. */
function _matchPayoutLineToBooking(confirmationCode) {
  if (!confirmationCode) return null;
  const target = String(confirmationCode).trim().toLowerCase();
  if (!target) return null;
  return bookings.find(b => {
    const code = String(b.confirmCode || '').trim().toLowerCase();
    return code && code === target;
  }) || null;
}

async function extractPayoutWithAI() {
  const platform = document.getElementById('payout-platform').value || 'other';
  const rawText = (document.getElementById('payout-paste-raw').value || '').trim();
  const hasFile = !!_payoutFileBase64;

  if (!hasFile && !rawText) {
    _payoutPasteStatus('⚠ Attach a statement file OR paste statement text first', 'err');
    return;
  }
  if (!hasFile && rawText.length < 30) {
    _payoutPasteStatus('⚠ That looks too short — paste the full statement', 'err');
    return;
  }
  // A structured Airbnb export is parsed HERE, exactly — before the AI is even
  // considered. A full financial year returned HTTP 504 because Netlify kills a
  // synchronous function at 10s, and max_tokens 4000 would have truncated the
  // reply anyway. Parsing in the browser is instant, free, offline, and cannot
  // hit either wall. Deliberately ahead of the AIService guard below so this
  // still works when ai-logic.js failed to load.
  if (!hasFile) {
    let parsed = null;
    try {
      parsed = parseAirbnbTransactionCsv(rawText);
    } catch (e) {
      console.warn('[StayOps] Airbnb CSV parse threw — falling back to AI', e);
    }
    if (parsed && parsed.payouts.length) {
      _payoutExtracted = parsed;
      _payoutMatchOverrides = {};
      _renderPayoutPasteReview(parsed);
      return;
    }
    if (parsed && parsed.recognised) {
      // Recognised, but nothing has actually settled. This must NOT fall
      // through to the AI: its prompt says each Reservation is usually paired
      // with its own Payout, so it would fabricate deposits that never reached
      // the bank and inflate reported income.
      const n = parsed.meta.unpaidRows;
      _payoutPasteStatus(
        `This is an Airbnb export, but it has no completed payouts in it`
        + (n ? ` — ${n} reservation${n === 1 ? ' is' : 's are'} booked but not yet paid out.` : '.')
        + ' Export a date range that includes the payouts you want, then paste again.');
      return;
    }
  }

  if (!AIService || typeof AIService.request !== 'function') {
    _payoutPasteStatus('⚠ AI service not available', 'err');
    return;
  }
  _payoutPasteStatus(hasFile ? '⏳ Reading statement file with AI...' : '⏳ Reading statement with AI...');

  const promptInstructions = `You parse short-term-rental platform payout statements into JSON.
Return ONLY valid JSON. No markdown, no commentary, no prose.

PLATFORM (user-selected hint): ${platform}

The statement may describe ONE payout (a single bank deposit covering one or more bookings — common on Booking.com) OR MULTIPLE payouts (e.g. an Airbnb monthly earnings report where each booking is its own deposit on a separate date). You MUST detect which case this is and return a "payouts" ARRAY with one element per actual bank-transfer event.

DETECTION SIGNALS for multiple payouts (return one element per signal):
- Multiple "Payout" rows in a CSV (each Payout row is one bank transfer)
- Multiple "Transfer to <bank>" lines with distinct dates
- Multiple distinct payout dates in a Date column
- A monthly summary listing several separate bank transfers
- Airbnb format: each Reservation is usually paired with its own Payout row → one payout per reservation

When in doubt, prefer ONE payout per distinct payout date / bank-transfer event. NEVER collapse multiple separate deposits into one payout.

Extract this shape:
{
  "payouts": [
    { /* one element per bank deposit */ }
  ]
}

Each payout object:
- platform: "airbnb" / "booking_com" / "vrbo" / "stayz" / "direct" / "other" — the user hint above is authoritative; only choose a different value when the hint is "other". (Branding can mislead: VRBO statements are issued by Expedia Group, Stayz is VRBO's AU brand.)
- payoutReference: platform's own ID (Airbnb "PAY-XXXXXXXX", Booking.com invoice #, or null)
- payoutDate: YYYY-MM-DD — date the platform issued THIS payout (null if not in text)
- expectedArrivalDate: YYYY-MM-DD if a bank arrival ETA is mentioned for THIS payout, else null
- currency: ISO code (default "AUD")
- totalNet: the net deposit amount of THIS payout (number, no commas, no $)
- lines: ordered array of line items for THIS payout only

Each line:
- lineType: "accommodation" / "cleaning_fee" / "host_fee" / "adjustment" / "cancellation" / "resolution" / "tax" / "other"
- description: short human description (e.g. "Kyle Armstrong · 2 nights", "Airbnb host service fee")
- amount: number. POSITIVE for income (accommodation, cleaning_fee). NEGATIVE for fees/deductions (host_fee, tax, cancellation reducing payout, adjustment if it reduces payout). No currency symbols, no commas.
- confirmationCode: the booking/reservation code if visible (e.g. "HMABC123"), else null
- guestName: if visible, else null

RULES
- One bank-transfer event = one payout object in the array
- Inside each payout, sum of lines.amount should approximately equal that payout's totalNet (within ~$1 rounding)
- Host service fees are NEGATIVE
- Cleaning fee charged to guest passing through to host is POSITIVE, lineType "cleaning_fee"
- A guest cancellation refund leaving the host's payout is NEGATIVE
- Resolution Center payouts are POSITIVE, lineType "resolution"
- For Airbnb CSV exports where Gross/Cleaning/Service-fee are columns: emit either (a) one "accommodation" line for gross minus cleaning + one "cleaning_fee" line + one "host_fee" line, OR (b) one "accommodation" line for the full gross + one "host_fee" line. Pick whichever makes the numbers add up cleanest.
- Do not invent values; null fields you cannot read

Return EXACTLY this top-level shape (note the OUTER payouts array):
{"payouts":[{"platform":"...","payoutReference":...,"payoutDate":"YYYY-MM-DD","expectedArrivalDate":...,"currency":"AUD","totalNet":0,"lines":[{"lineType":"accommodation","description":"...","amount":0,"confirmationCode":"...","guestName":"..."}]}]}`;

  // When a file is attached, send it as a vision/document content block.
  // Use Sonnet for vision (Haiku's vision is weaker) and for text-only
  // (multi-line statements need careful parsing). Mirrors receipt-reader.
  let messages;
  if (hasFile) {
    const fileBlock = _payoutFileMediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: _payoutFileBase64 } }
      : { type: 'image',    source: { type: 'base64', media_type: _payoutFileMediaType, data: _payoutFileBase64 } };
    const textBlock = { type: 'text', text: rawText
      ? promptInstructions + '\n\nADDITIONAL CONTEXT (pasted by user):\n"""\n' + rawText + '\n"""'
      : promptInstructions };
    messages = [{ role: 'user', content: [fileBlock, textBlock] }];
  } else {
    messages = [{
      role: 'user',
      content: promptInstructions + '\n\nRAW STATEMENT TEXT:\n"""\n' + rawText + '\n"""'
    }];
  }

  try {
    const { response, data } = await AIService.request({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages
    });
    if (!response.ok) {
      // "AI service returned HTTP 504" tells the host nothing they can act on.
      // A gateway timeout here means one thing: too much text for the 10s
      // Netlify budget. Airbnb CSVs never reach this code — they are parsed
      // in-browser above — so this copy is for the other platforms.
      if (response.status === 504 || response.status === 408 || response.status === 502) {
        throw new Error('That statement was too long to read in one go — the server gives up after 10 seconds. Paste a shorter date range (a month at a time works), or attach the CSV export instead.');
      }
      throw new Error(data?.error?.message || 'AI service returned HTTP ' + response.status);
    }
    // Truncation is the OTHER size wall, and it arrives looking like corrupt
    // JSON rather than an error. Name it before the parse fails confusingly.
    if (data?.stop_reason === 'max_tokens') {
      throw new Error('That statement had more line items than can be read in one pass — the reply was cut off partway. Paste a shorter date range, or attach the CSV export instead.');
    }
    const text = data?.content?.[0]?.text || '';
    if (!text) throw new Error('AI returned an empty response');
    const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (_e) {
      throw new Error('AI did not return valid JSON — try re-uploading or pasting with more context');
    }
    // Normalize: accept either { payouts: [...] } (new shape) or a legacy
    // single-payout object with .lines. Wrap the latter so downstream code
    // only ever sees the array shape.
    if (!Array.isArray(parsed.payouts) && Array.isArray(parsed.lines)) {
      parsed = { payouts: [parsed] };
    }
    if (!Array.isArray(parsed.payouts) || !parsed.payouts.length) {
      throw new Error('AI did not find any payouts — the statement might be incomplete');
    }
    for (const p of parsed.payouts) {
      if (!Array.isArray(p.lines) || !p.lines.length) {
        throw new Error('AI returned a payout with no line items — re-try with the full statement');
      }
    }
    _payoutExtracted = parsed;
    _payoutMatchOverrides = {};
    _renderPayoutPasteReview(parsed);
  } catch (err) {
    console.warn('[StayOps] extractPayoutWithAI failed', err);
    _payoutPasteStatus('⚠ ' + (err.message || 'AI extraction failed'), 'err');
  }
}

function _renderPayoutPasteReview(extracted) {
  document.getElementById('payout-paste-input-section').style.display = 'none';
  document.getElementById('payout-paste-review-section').style.display = 'block';
  const status = document.getElementById('payout-paste-status');
  status.style.display = 'none';

  const fmtMoney = (n) => (n < 0 ? '−$' : '$') + Math.abs(Number(n) || 0).toFixed(2);
  const payouts = Array.isArray(extracted.payouts) ? extracted.payouts : [extracted];

  // Build a stable list of selectable bookings once (re-used for every line).
  // Uses imported `bookings` (state.js ES module binding). In-memory field
  // for confirmation code is b.confirmCode.
  const bookingOptions = bookings
    .filter(b => b && isRevenueBearingBooking(b) && b._cloudId)
    .sort((a, b) => String(b.checkin || '').localeCompare(String(a.checkin || '')))
    .map(b => {
      const code = b.confirmCode || '';
      const label = `${b.name || 'Guest'} · ${b.checkin || '?'} → ${b.checkout || '?'}${code ? ' · ' + code : ''}`;
      return { id: b._cloudId, label };
    });

  // Overall summary in the header band: count + total net across all payouts.
  const grandTotalNet = payouts.reduce((s, p) => {
    const sumLines = (p.lines || []).reduce((ss, l) => ss + (Number(l.amount) || 0), 0);
    return s + sumLines; // lines are source of truth
  }, 0);
  const platformsSet = Array.from(new Set(payouts.map(p => p.platform || 'platform')));
  const payoutCount = payouts.length;

  // Every row the parser did NOT turn into a payout has to be visible here.
  // Counting them into an object nobody renders is how an import shows a
  // confident green total while quietly dropping hundreds of rows.
  const meta = extracted.meta || null;
  const notes = [];
  if (meta) {
    if (meta.unpaidRows) notes.push(`${meta.unpaidRows} reservation${meta.unpaidRows === 1 ? '' : 's'} booked but not yet paid out — not imported`);
    if (meta.zeroPayoutRows) notes.push(`${meta.zeroPayoutRows} $0.00 transfer row${meta.zeroPayoutRows === 1 ? '' : 's'} ignored`);
    if (meta.skipped && meta.skipped.length) {
      const why = Array.from(new Set(meta.skipped.map(s => s.reason))).slice(0, 3).join('; ');
      notes.push(`${meta.skipped.length} row${meta.skipped.length === 1 ? '' : 's'} could not be read (${why})`);
    }
    if (meta.listings && meta.listings.length > 1) {
      notes.push(`⚠ This export covers ${meta.listings.length} listings — every payout will be filed under the property currently selected`);
    }
  }
  const notesHtml = notes.length
    ? `<div style="margin-top:8px;padding:8px 10px;background:#FFF8E1;border:1px solid #FFE082;border-radius:8px;font-size:11.5px;color:#5D4037;font-family:'Plus Jakarta Sans',sans-serif">
         ${notes.map(n => `<div style="margin-bottom:2px">${escHtml(n)}</div>`).join('')}
       </div>` : '';

  document.getElementById('payout-paste-header').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;font-family:'Plus Jakarta Sans',sans-serif">
      <div style="min-width:0">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--muted-2)">${escHtml(platformsSet.join(' / '))}</div>
        <div style="font-size:15px;font-weight:600;color:var(--ink-1);margin-top:2px">${payoutCount} payout${payoutCount === 1 ? '' : 's'} detected</div>
        <div style="font-size:12px;color:var(--muted-2);margin-top:2px">Review each one below — each becomes its own row in the payouts table.</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:11px;color:var(--muted-2);text-transform:uppercase;letter-spacing:0.4px">Grand Net</div>
        <div style="font-size:18px;font-weight:600;color:var(--ink-1)">${fmtMoney(grandTotalNet)}</div>
      </div>
    </div>
    ${notesHtml}`;

  // Build one card per payout, each with its own header band and line items.
  const cardsHtml = payouts.map((payout, pIdx) => {
    const lines = Array.isArray(payout.lines) ? payout.lines : [];
    const linesSum = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const totalNet = Number(payout.totalNet) || 0;
    const variance = Math.abs(linesSum - totalNet);
    // The CSV parser appends a balancing line so net always equals the real
    // deposit — which would make the variance test below mathematically
    // unreachable and silently retire the only mismatch alarm in this flow.
    // The flag it sets is what keeps the warning alive.
    const unallocated = Number(payout._unallocatedCents) || 0;
    const varianceWarn = (totalNet && variance > 1)
      ? `<div style="margin-top:6px;font-size:11px;color:#A32D2D;font-family:'Plus Jakarta Sans',sans-serif">⚠ Lines sum (${fmtMoney(linesSum)}) doesn't match stated total (${fmtMoney(totalNet)})</div>`
      : (unallocated
        ? `<div style="margin-top:6px;font-size:11px;color:#A32D2D;font-family:'Plus Jakarta Sans',sans-serif">⚠ ${fmtMoney(unallocated / 100)} of this deposit could not be attributed to a reservation — check it against the statement</div>`
        : '');

    const linesHtml = lines.map((line, lIdx) => {
      const matched = _matchPayoutLineToBooking(line.confirmationCode);
      const matchedId = matched ? matched._cloudId : null;
      const matchedLabel = matched ? `${matched.name || 'Guest'} · ${matched.checkin || '?'}` : null;
      const showsBookingPicker = ['accommodation', 'cleaning_fee', 'cancellation', 'resolution'].includes(line.lineType);
      const amtColor = (Number(line.amount) || 0) < 0 ? '#A32D2D' : '#1D9E75';
      const selectKey = `${pIdx}.${lIdx}`;
      // Only the auto-matched option is rendered up front; the full booking list
      // is filled in on first focus (see the focus handler below). A financial
      // year is ~40 payouts and ~100 line items, and eagerly stamping every
      // booking into every picker built a six-figure options list in one
      // innerHTML string — enough to lock the browser on the screen whose whole
      // purpose is reviewing a large import.
      const sel = showsBookingPicker
        ? `<select data-payout-line-match="${escHtml(selectKey)}" style="width:100%;font-size:12px;padding:6px 8px;border-radius:6px;border:1px solid var(--hairline-1);background:#fff;font-family:'Plus Jakarta Sans',sans-serif;margin-top:4px">
            <option value="">— No booking link —</option>
            ${matchedId ? `<option value="${escHtml(matchedId)}" selected>${escHtml(matchedLabel)}</option>` : ''}
          </select>`
        : '';
      const matchBadge = matched
        ? `<div style="font-size:11px;color:#1D9E75;margin-top:2px;font-family:'Plus Jakarta Sans',sans-serif">✓ Auto-matched: ${escHtml(matchedLabel)}</div>`
        : (line.confirmationCode && showsBookingPicker
          ? `<div style="font-size:11px;color:#A32D2D;margin-top:2px;font-family:'Plus Jakarta Sans',sans-serif">No booking with code ${escHtml(line.confirmationCode)}</div>`
          : '');
      return `<div style="background:#fff;border:1px solid var(--hairline-1);border-radius:8px;padding:10px 12px;margin-bottom:6px;font-family:'Plus Jakarta Sans',sans-serif">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div style="flex:1;min-width:0">
            <div style="font-size:11px;font-weight:600;color:var(--muted-2);text-transform:uppercase;letter-spacing:0.4px">${escHtml(line.lineType || 'other')}</div>
            <div style="font-size:14px;color:var(--ink-1);font-weight:500;margin-top:2px">${escHtml(line.description || '(no description)')}</div>
            ${line.confirmationCode ? `<div style="font-size:11px;color:var(--muted-2);margin-top:2px">Code: ${escHtml(line.confirmationCode)}</div>` : ''}
            ${matchBadge}
          </div>
          <div style="font-size:14px;font-weight:600;color:${amtColor};flex-shrink:0">${fmtMoney(line.amount)}</div>
        </div>
        ${sel}
      </div>`;
    }).join('');

    return `<div style="background:var(--surface2);border:1px solid var(--hairline-1);border-radius:12px;padding:12px;margin-bottom:14px;font-family:'Plus Jakarta Sans',sans-serif">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px">
        <div style="min-width:0">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--muted-2)">Payout ${pIdx + 1} of ${payoutCount} · ${escHtml(payout.platform || 'platform')}</div>
          <div style="font-size:14px;font-weight:600;color:var(--ink-1);margin-top:2px">${escHtml(payout.payoutReference || '(no reference)')}</div>
          <div style="font-size:11px;color:var(--muted-2);margin-top:2px">Date: ${escHtml(payout.payoutDate || '?')}${payout.expectedArrivalDate ? ' · arrives ' + escHtml(payout.expectedArrivalDate) : ''}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:10px;color:var(--muted-2);text-transform:uppercase;letter-spacing:0.4px">Net</div>
          <div style="font-size:16px;font-weight:600;color:var(--ink-1)">${fmtMoney(totalNet)}</div>
        </div>
      </div>
      ${varianceWarn}
      ${linesHtml}
    </div>`;
  }).join('');

  document.getElementById('payout-paste-lines').innerHTML = cardsHtml;

  // Track manual booking overrides keyed by "<payoutIdx>.<lineIdx>".
  document.querySelectorAll('[data-payout-line-match]').forEach(sel => {
    // Populate the full booking list only when the host actually opens this
    // picker, keeping the initial render proportional to the number of lines
    // rather than lines × bookings.
    sel.addEventListener('focus', () => {
      if (sel.dataset.filled) return;
      sel.dataset.filled = '1';
      const current = sel.value;
      sel.innerHTML = '<option value="">— No booking link —</option>'
        + bookingOptions.map(b => `<option value="${escHtml(b.id)}">${escHtml(b.label)}</option>`).join('');
      sel.value = current;
    });
    sel.addEventListener('change', (ev) => {
      const key = ev.target.getAttribute('data-payout-line-match');
      _payoutMatchOverrides[key] = ev.target.value || null;
    });
  });
}

async function savePayoutFromPasteModal() {
  if (!_payoutExtracted) {
    _payoutPasteStatus('⚠ Nothing to save — extract first', 'err');
    return;
  }
  const payouts = Array.isArray(_payoutExtracted.payouts) ? _payoutExtracted.payouts : [_payoutExtracted];
  if (!payouts.length) {
    _payoutPasteStatus('⚠ Nothing to save — extract first', 'err');
    return;
  }

  const rawText = (document.getElementById('payout-paste-raw').value || '').trim();
  const platformSel = document.getElementById('payout-platform').value || 'other';

  // Save each payout (and its lines) sequentially so we can stop on the first
  // failure and report a precise message. For a typical monthly Airbnb (3-6
  // payouts) this is plenty fast.
  let savedCount = 0;
  let duplicateCount = 0;
  let totalLinesInserted = 0;
  let totalMatched = 0;
  const failures = [];

  for (let pIdx = 0; pIdx < payouts.length; pIdx++) {
    const payout = payouts[pIdx];
    _payoutPasteStatus(`⏳ Saving payout ${pIdx + 1} of ${payouts.length}...`);
    const lines = Array.isArray(payout.lines) ? payout.lines : [];

    // Roll up totals from lines (source of truth — even if AI's totalNet is off)
    let gross = 0, platformFee = 0, adjustments = 0;
    for (const l of lines) {
      const amt = Number(l.amount) || 0;
      if (['accommodation', 'cleaning_fee'].includes(l.lineType)) gross += amt;
      else if (l.lineType === 'host_fee' || l.lineType === 'tax') platformFee += amt;
      else adjustments += amt;
    }
    const net = gross + platformFee + adjustments;

    const savedPayout = await savePlatformPayout({
      // Scope payouts to the active property so per-property revenue/reconciliation
      // queries can find them. Without this, payouts land with property_id=NULL
      // and silently disappear from property-filtered reports.
      propertyId: _financeActiveCloudPropertyId() || null,
      // An explicit dropdown choice outranks the model. VRBO statements are
      // branded Expedia Group, so the AI read "not obviously VRBO" and returned
      // "other" — overriding a selection the host had deliberately made, and
      // filing the payout under a platform they never picked. "Other" is the
      // one selection that means "you work it out", so only then does AI win.
      platform: (platformSel && platformSel !== 'other') ? platformSel : (payout.platform || 'other'),
      payoutReference: payout.payoutReference || null,
      payoutDate: payout.payoutDate || localDateStr(),
      expectedArrivalDate: payout.expectedArrivalDate || null,
      gross,
      platformFee,
      adjustments,
      net,
      currency: payout.currency || 'AUD',
      source: _payoutExtracted.source || 'paste_ai',
      // Two same-date same-net payouts in one file are legitimate for a
      // single-listing host. findExistingPayout keys on (platform, date, net),
      // so without this the second matches the first just inserted and is
      // silently dropped along with all of its lines.
      allowDuplicate: !!payout.allowDuplicate,
      // Only attach the raw paste text to the FIRST payout to avoid storing
      // 3+ copies of the same monthly statement. Capped because a full-FY CSV
      // now succeeds where it used to time out, and loadPlatformPayouts does a
      // select('*') on every money-in render.
      rawSourceText: pIdx === 0 ? rawText.slice(0, 20000) : null,
    });
    if (!savedPayout) {
      failures.push(`Payout ${pIdx + 1} (${payout.payoutReference || payout.payoutDate || 'no-ref'}) — save failed`);
      continue;
    }
    // Already imported. Skip its lines too — re-inserting them would duplicate
    // every booking match under the payout that already exists.
    if (savedPayout._duplicate) {
      duplicateCount++;
      continue;
    }

    // Resolve booking matches: per-line override beats auto-match.
    // Override keys are "<pIdx>.<lIdx>".
    const linesToInsert = lines.map((l, lIdx) => {
      const overrideKey = `${pIdx}.${lIdx}`;
      let bookingId, matchedBy, confidence;
      if (overrideKey in _payoutMatchOverrides) {
        bookingId = _payoutMatchOverrides[overrideKey] || null;
        matchedBy = bookingId ? 'manual' : null;
        confidence = bookingId ? 'high' : 'low';
      } else {
        const auto = _matchPayoutLineToBooking(l.confirmationCode);
        bookingId = auto ? auto._cloudId : null;
        matchedBy = bookingId ? 'confirmation_code' : null;
        confidence = bookingId ? 'high' : 'low';
      }
      return {
        lineType: l.lineType || 'other',
        description: l.description || null,
        amount: Number(l.amount) || 0,
        confirmationCode: l.confirmationCode || null,
        bookingId,
        matchedBy,
        confidence,
      };
    });

    const insertedLines = await insertPayoutLines(savedPayout._cloudId, linesToInsert);
    savedCount++;
    totalLinesInserted += insertedLines.length;
    totalMatched += linesToInsert.filter(l => l.bookingId).length;
  }

  if (failures.length && savedCount === 0) {
    _payoutPasteStatus('⚠ ' + failures.join('; '), 'err');
    return;
  }

  const refreshReconciliation = () => {
    if (typeof globalThis.refreshFinanceReconciliationSummary === 'function') {
      try { globalThis.refreshFinanceReconciliationSummary(); } catch (_e) { /* non-fatal */ }
    }
  };

  if (failures.length) {
    // Never send the host to the console for this. A partial failure across
    // dozens of payouts is the "0 matched · 0 created · 0 skipped" shape again:
    // a green banner concealing rows that never landed. Keep the review screen
    // open, name the ones that failed, and say that retrying is safe — the
    // dedupe guard skips whatever already saved.
    console.warn('[StayOps] partial payout save failures:', failures);
    _payoutPasteStatus(
      `⚠ ${savedCount} saved, ${failures.length} did not: ${failures.join('; ')}. `
      + 'Press Save again to retry — anything already saved is skipped automatically.',
      'err');
    refreshReconciliation();
    return;
  }

  if (typeof globalThis.showBanner === 'function') {
    const dupes = duplicateCount ? ` · ${duplicateCount} already imported` : '';
    globalThis.showBanner(
      `✓ ${savedCount} payout${savedCount === 1 ? '' : 's'} saved · ${totalLinesInserted} line${totalLinesInserted === 1 ? '' : 's'} · ${totalMatched} matched${dupes}`
      + ' — now open Reconcile → Money in to match them to your bank deposits',
      'ok'
    );
  }

  closePayoutPasteModal();
  refreshReconciliation();
}

// ── Global bridges (inline-onclick API — names must stay stable) ─────────────
window.openPayoutPasteModal = openPayoutPasteModal;
window.closePayoutPasteModal = closePayoutPasteModal;
window.resetPayoutPasteModal = resetPayoutPasteModal;
window.attachPayoutStatementFile = attachPayoutStatementFile;
window.clearPayoutStatementFile = clearPayoutStatementFile;
window.extractPayoutWithAI = extractPayoutWithAI;
window.savePayoutFromPasteModal = savePayoutFromPasteModal;
