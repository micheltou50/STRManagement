// Netlify/functions/utils/email-templates.js
// Shared email template builder for all StayOps transactional emails.
// Table-based HTML, inline CSS, Outlook-safe. Matches app sage/cream design system.

const C = {
  sage: '#2f5d4e', sageDark: '#1f3f35', sageSoft: '#dde8e1',
  ink: '#1c2620', muted: '#8a958f',
  accent: '#d8a657', accentSoft: '#f4e7cf',
  warn: '#b56a3a', good: '#3f7a5e',
};

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shell({ headerColor, headerKicker, headerTitle, body, footer }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:'Plus Jakarta Sans','Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06)">
  <tr><td style="background:${headerColor || C.sage};padding:24px 32px">
    <p style="margin:0;font-size:12px;font-weight:600;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:1px;font-family:'JetBrains Mono','Courier New',monospace">StayOps &middot; ${esc(headerKicker)}</p>
    <h1 style="margin:8px 0 0;font-size:24px;font-weight:700;color:#fff;font-family:'Newsreader',Georgia,serif;letter-spacing:-0.3px">${esc(headerTitle)}</h1>
  </td></tr>
  <tr><td style="padding:28px 32px">
    ${body}
  </td></tr>
  <tr><td style="padding:16px 32px 24px;border-top:1px solid #f0f0f0">
    <p style="margin:0;font-size:11px;color:#aaa;text-align:center;font-family:'JetBrains Mono','Courier New',monospace;line-height:1.6">${footer || 'Sent automatically by StayOps'}</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function detailCard(rows) {
  const trs = rows.map(([k, v], i) =>
    `<tr>
      <td style="font-size:11px;color:${C.muted};font-weight:600;text-transform:uppercase;letter-spacing:0.6px;width:40%;padding:6px 4px;font-family:'JetBrains Mono','Courier New',monospace;${i ? 'border-top:1px solid #eee' : ''}">${esc(k)}</td>
      <td style="font-size:14px;color:${C.ink};font-weight:600;padding:6px 4px;font-family:'Plus Jakarta Sans',Arial,sans-serif;${i ? 'border-top:1px solid #eee' : ''}">${esc(v)}</td>
    </tr>`
  ).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa;border-radius:10px;margin-bottom:24px;border-collapse:collapse">
  <tr><td style="padding:16px 20px">
    <table width="100%" cellpadding="4" cellspacing="0" style="border-collapse:collapse">${trs}</table>
  </td></tr></table>`;
}

function p(text, style) {
  return `<p style="margin:0 0 16px;font-size:15px;color:#333;line-height:1.6;font-family:'Plus Jakarta Sans',Arial,sans-serif;${style || ''}">${text}</p>`;
}

function cta(label, href, color) {
  return `<table cellpadding="0" cellspacing="0" style="margin:0 auto"><tr><td style="background:${color || C.sage};border-radius:10px;padding:13px 28px">
    <a href="${href || 'https://app.stayops.com.au'}" style="color:#fff;text-decoration:none;font-size:15px;font-weight:600;font-family:'Plus Jakarta Sans',Arial,sans-serif">${esc(label)}</a>
  </td></tr></table>`;
}

function ctaRow(items) {
  const btns = items.map(btn => {
    const c = btn.color || C.sage;
    if (btn.primary) {
      return `<a href="${btn.href || '#'}" style="display:inline-block;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:600;font-family:'Plus Jakarta Sans',Arial,sans-serif;margin:0 6px;background:${c};color:#fff">${esc(btn.label)}</a>`;
    }
    return `<a href="${btn.href || '#'}" style="display:inline-block;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:600;font-family:'Plus Jakarta Sans',Arial,sans-serif;margin:0 6px;background:transparent;color:${c};border:2px solid ${c}">${esc(btn.label)}</a>`;
  }).join('');
  return `<p style="margin:0 0 8px;text-align:center">${btns}</p>`;
}

function mapLink(address) {
  const encoded = encodeURIComponent(address);
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr>
    <td style="padding:12px 16px;background:${C.sageSoft};border-radius:8px">
      <span style="font-size:18px;vertical-align:middle">&#x1F4CD;</span>&nbsp;
      <span style="font-size:13px;font-weight:600;color:${C.sageDark}">${esc(address)}</span><br>
      <a href="https://maps.google.com/?q=${encoded}" style="font-size:11px;color:${C.sage};font-family:'JetBrains Mono','Courier New',monospace;text-decoration:none">Open in Maps &rarr;</a>
    </td>
  </tr></table>`;
}

function infoPanel(text, color) {
  const bg = color === C.warn ? '#fdf3eb' : C.sageSoft;
  const textColor = color === C.warn ? '#7d4f1c' : C.sageDark;
  const border = color || C.sage;
  return `<div style="padding:14px 18px;background:${bg};border-radius:8px;margin-bottom:20px;border-left:4px solid ${border}">
    <p style="margin:0;font-size:13px;color:${textColor};line-height:1.5;font-family:'Plus Jakarta Sans',Arial,sans-serif">${text}</p>
  </div>`;
}

// ─── 1 · Clean Assignment ──────────────────────────────────────────────
function cleanAssignment(d) {
  const startTime = d.checkout_time || d.clean_time || '';
  const rows = [
    ['Property', d.property_name],
    ['Address', d.property_address],
    ['Guest', d.guest_name + (d.guest_count ? ' · ' + d.guest_count + ' guests' : '')],
    ['Check-out', d.checkout_date],
    ['Clean date', d.clean_date],
    ['Available from', startTime ? startTime + ' (after checkout)' : 'After checkout'],
  ];
  if (d.checkin_time) rows.push(['Ready by', d.checkin_time + ' (next check-in)']);
  if (d.est_hours) rows.push(['Est. time', '~' + d.est_hours + ' hours']);
  if (d.clean_pay) rows.push(['Pay', d.clean_pay]);

  let body = p(`Hi <strong>${esc(d.cleaner_name)}</strong>,`);
  body += p(`${esc(d.host_name || 'Your host')} has assigned you a clean at <strong>${esc(d.property_name)}</strong>. Here are the details:`);
  body += detailCard(rows);
  if (d.property_address) body += mapLink(d.property_address);
  body += ctaRow([
    { label: 'Accept clean', primary: true, href: d.accept_link },
    { label: 'Decline', primary: false, href: d.decline_link },
  ]);
  body += p('Please respond within 24 hours so ' + esc(d.host_name || 'the host') + ' can plan ahead.', 'font-size:12px;color:' + C.muted + ';text-align:center;margin-top:16px');

  return shell({
    headerColor: C.sage,
    headerKicker: 'Clean assigned',
    headerTitle: "You've got a new clean",
    body,
    footer: 'Sent automatically by StayOps when a clean is assigned to you',
  });
}

// ─── 2 · Clean Reminder ───────────────────────────────────────────────
function cleanReminder(d) {
  const rows = [
    ['Property', d.property_name],
    ['Guest', d.guest_name],
    ['Clean date', d.clean_date],
  ];
  if (d.checkout_time || d.clean_time) rows.push(['Start time', d.checkout_time || d.clean_time]);
  if (d.checkin_time) rows.push(['Ready by', d.checkin_time]);

  let body = p(`Hi <strong>${esc(d.cleaner_name)}</strong>,`);
  body += p(`Just a reminder &mdash; you have a clean <strong>tomorrow</strong> at <strong>${esc(d.property_name)}</strong>.`);
  body += detailCard(rows);
  if (d.property_address) body += mapLink(d.property_address);
  body += cta('Open StayOps →', d.app_link);

  return shell({
    headerColor: C.accent,
    headerKicker: 'Cleaning reminder',
    headerTitle: 'Clean tomorrow',
    body,
    footer: 'Sent automatically by StayOps · 24h before your scheduled clean',
  });
}

// ─── 3 · Cancellation ─────────────────────────────────────────────────
function cancellation(d) {
  let body = p(`Hi <strong>${esc(d.cleaner_name)}</strong>,`);
  body += p(`The booking at <strong>${esc(d.property_name)}</strong> has been cancelled, so your clean on <strong>${esc(d.clean_date)}</strong> is no longer needed.`);
  body += detailCard([
    ['Property', d.property_name],
    ['Was for', d.guest_name + (d.guest_count ? ' · ' + d.guest_count + ' guests' : '')],
    ['Original clean date', d.clean_date + (d.clean_time ? ' · ' + d.clean_time : '')],
    ['Reason', d.cancel_reason || 'Booking cancelled'],
  ]);
  body += infoPanel(
    `<strong>No action needed.</strong> This clean has been removed from your schedule. If you've already started prep, please message ${esc(d.host_name || 'the host')}.`,
    C.warn
  );
  body += cta('View schedule', d.schedule_link);

  return shell({
    headerColor: C.warn,
    headerKicker: 'Cancellation',
    headerTitle: 'Clean cancelled',
    body,
    footer: 'Sent automatically by StayOps when a booking is cancelled',
  });
}

// ─── 4 · Booking Confirmation (to host) ───────────────────────────────
function bookingConfirmation(d) {
  const rows = [
    ['Guest', d.guest_name + (d.guest_count ? ' · ' + d.guest_count + ' guests' : '')],
    ['Check-in', d.checkin_date + (d.checkin_time ? ' · ' + d.checkin_time : '')],
    ['Check-out', d.checkout_date + (d.checkout_time ? ' · ' + d.checkout_time : '')],
    ['Nights', String(d.nights || '')],
    ['Source', d.source || 'Direct booking'],
  ];
  if (d.host_payout) rows.push(['Host payout', d.host_payout]);
  if (d.cleaning_fee) rows.push(['Cleaning fee', d.cleaning_fee]);

  let body = p(`Hi <strong>${esc(d.host_name)}</strong>,`);
  body += p(`Great news &mdash; you have a new booking at <strong>${esc(d.property_name)}</strong>.`);
  body += detailCard(rows);
  if (d.cleaner_name && d.clean_date) {
    body += infoPanel(
      `<strong>Auto-clean scheduled:</strong> ${esc(d.clean_date)}${d.clean_time ? ', ' + esc(d.clean_time) : ''} &mdash; ${esc(d.cleaner_name)} has been notified and will confirm shortly.`
    );
  }
  body += cta('View booking →', d.booking_link);

  return shell({
    headerColor: C.sageDark,
    headerKicker: 'New booking',
    headerTitle: 'Booking confirmed',
    body,
    footer: 'Sent automatically by StayOps when a new booking is confirmed',
  });
}

// ─── 5 · Cleaner Invite ───────────────────────────────────────────────
function cleanerInvite(d) {
  const features = [
    ['\u{1F4CB}', 'See your schedule', 'All upcoming cleans in one place'],
    ['✅', 'Accept or decline', 'Respond to new assignments instantly'],
    ['\u{1F4F8}', 'Photo checklist', 'Mark tasks done and upload completion photos'],
    ['\u{1F4B0}', 'Track earnings', "See what you've earned and when you're paid"],
  ];
  const featureRows = features.map(([icon, title, sub]) =>
    `<tr>
      <td style="padding:8px 12px 8px 0;font-size:22px;vertical-align:top;width:36px">${icon}</td>
      <td style="padding:8px 0">
        <div style="font-size:14px;font-weight:700;color:${C.ink};font-family:'Plus Jakarta Sans',sans-serif">${esc(title)}</div>
        <div style="font-size:12px;color:${C.muted};margin-top:2px;font-family:'Plus Jakarta Sans',sans-serif">${esc(sub)}</div>
      </td>
    </tr>`
  ).join('');

  const rows = [['Invited by', d.host_name]];
  if (d.property_names) rows.push(['Properties', d.property_names]);
  rows.push(['Your role', 'Cleaner']);
  if (d.pay_range) rows.push(['Pay', d.pay_range]);

  let body = p(`Hi <strong>${esc(d.cleaner_name)}</strong>,`);
  body += p(`<strong>${esc(d.host_name)}</strong> has invited you to join StayOps as a cleaner for their properties. StayOps will send you clean assignments, reminders, and let you accept or decline jobs from your phone.`);
  body += detailCard(rows);
  body += p("Here's what you can do once you're set up:");
  body += `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px"><tbody>${featureRows}</tbody></table>`;
  body += cta('Accept invite & set up →', d.invite_link);
  body += p('This invite expires in 7 days. If you didn\'t expect this, you can safely ignore it.', 'font-size:12px;color:' + C.muted + ';text-align:center;margin-top:16px');

  return shell({
    headerColor: C.sage,
    headerKicker: 'Team invite',
    headerTitle: "You've been invited to StayOps",
    body,
    footer: 'Sent by StayOps on behalf of ' + esc(d.host_name),
  });
}

// ─── 6 · Monthly Report ──────────────────────────────────────────────
function monthlyReport(d) {
  const vsSign = (d.vs_last_month || '').startsWith('-') ? '' : '↑ ';
  const vsColor = (d.vs_last_month || '').startsWith('-') ? C.warn : C.good;

  const breakdownRows = [];
  if (d.booking_count) breakdownRows.push(['Bookings (' + d.booking_count + ')', d.gross_revenue]);
  if (d.cleaning_fees_collected) breakdownRows.push(['Cleaning fees collected', d.cleaning_fees_collected]);
  if (d.platform_fees) breakdownRows.push(['Platform fees', d.platform_fees]);
  if (d.cleaner_pay) breakdownRows.push(['Cleaner pay' + (d.clean_count ? ' (' + d.clean_count + ' cleans)' : ''), d.cleaner_pay]);
  if (d.expenses) breakdownRows.push(['Expenses' + (d.expense_count ? ' (' + d.expense_count + ')' : ''), d.expenses]);
  if (d.vat) breakdownRows.push(['VAT', d.vat]);

  const stats = [];
  if (d.occupancy_pct) stats.push({ l: 'Occupancy', v: d.occupancy_pct, s: '' });
  if (d.avg_nightly) stats.push({ l: 'Avg nightly', v: d.avg_nightly, s: '' });
  if (d.clean_count) stats.push({ l: 'Cleans', v: String(d.clean_count), s: '' });

  const statCols = stats.map((s, i) => {
    const radius = i === 0 ? '8px 0 0 8px' : i === stats.length - 1 ? '0 8px 8px 0' : '0';
    return `<td style="text-align:center;padding:14px 8px;background:#f8f9fa;border-radius:${radius}">
      <div style="font-size:10px;font-family:'JetBrains Mono','Courier New',monospace;color:${C.muted};text-transform:uppercase;letter-spacing:0.6px">${esc(s.l)}</div>
      <div style="font-size:24px;font-weight:600;color:${C.ink};font-family:'Newsreader',Georgia,serif;margin-top:4px">${esc(s.v)}</div>
    </td>`;
  }).join('');

  let payoutsHtml = '';
  if (d.payouts && d.payouts.length) {
    const payoutRows = d.payouts.map((po, i) => {
      const badge = po.settled
        ? `<span style="padding:3px 8px;border-radius:999px;background:${C.sageSoft};color:${C.sageDark};font-weight:600;font-family:'JetBrains Mono','Courier New',monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.4px">Settled</span>`
        : `<span style="padding:3px 8px;border-radius:999px;background:${C.accentSoft};color:#7d4f1c;font-weight:600;font-family:'JetBrains Mono','Courier New',monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.4px">Pending</span>`;
      return `<tr>
        <td style="padding:10px 14px;${i ? 'border-top:1px solid #eee;' : ''}font-size:12px;color:${C.muted};font-family:'JetBrains Mono','Courier New',monospace">${esc(po.date)}</td>
        <td style="padding:10px 0;${i ? 'border-top:1px solid #eee;' : ''}font-size:13px;color:${C.ink};font-weight:600">${esc(po.source)}</td>
        <td style="padding:10px 14px;${i ? 'border-top:1px solid #eee;' : ''}font-size:13px;font-weight:600;color:${C.ink};text-align:right;font-family:'JetBrains Mono','Courier New',monospace">${esc(po.amount)}</td>
        <td style="padding:10px 14px;${i ? 'border-top:1px solid #eee;' : ''}font-size:10px;text-align:right">${badge}</td>
      </tr>`;
    }).join('');
    payoutsHtml = `<div style="margin-bottom:20px">
      <div style="font-size:11px;font-family:'JetBrains Mono','Courier New',monospace;color:${C.muted};text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px">Payouts</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa;border-radius:8px"><tbody>${payoutRows}</tbody></table>
    </div>`;
  }

  let body = p(`Hi <strong>${esc(d.host_name)}</strong>,`);
  body += p(`Here's your monthly summary for <strong>${esc(d.property_name)}</strong> &mdash; ${esc(d.month)} ${esc(d.year)}.`);

  body += `<div style="text-align:center;padding:20px 0 24px">
    <div style="font-size:11px;font-family:'JetBrains Mono','Courier New',monospace;color:${C.muted};text-transform:uppercase;letter-spacing:1px">Net earnings</div>
    <div style="font-size:44px;font-weight:600;color:${C.sage};font-family:'Newsreader',Georgia,serif;letter-spacing:-1px;margin-top:4px">${esc(d.net_earnings)}</div>
    ${d.vs_last_month ? `<div style="font-size:13px;color:${vsColor};font-weight:600;margin-top:4px">${vsSign}${esc(d.vs_last_month)}</div>` : ''}
  </div>`;

  if (breakdownRows.length) body += detailCard(breakdownRows);
  if (stats.length) body += `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px"><tbody><tr>${statCols}</tr></tbody></table>`;
  body += payoutsHtml;
  body += cta('View full report →', d.report_link);
  body += p('Download as PDF from Settings → Finance → Reports', 'font-size:12px;color:' + C.muted + ';text-align:center;margin-top:12px');

  return shell({
    headerColor: C.sageDark,
    headerKicker: 'Monthly report',
    headerTitle: (d.month || '') + ' ' + (d.year || ''),
    body,
    footer: 'Sent on the 1st of each month · Manage in Settings → Reports',
  });
}

// ─── Generic notification (push-alongside emails) ─────────────────────
function notification(title, body) {
  let content = '';
  if (title) content += `<div style="font-size:18px;font-weight:600;color:#1A1A1A;margin-bottom:8px;font-family:'Plus Jakarta Sans',Arial,sans-serif">${esc(title)}</div>`;
  if (body) content += `<div style="font-size:14px;color:#6B6B6B;line-height:1.6;font-family:'Plus Jakarta Sans',Arial,sans-serif">${esc(body)}</div>`;

  return shell({
    headerColor: C.sageDark,
    headerKicker: 'Notification',
    headerTitle: esc(title || 'StayOps'),
    body: content + `<div style="margin-top:20px">${cta('Open StayOps', 'https://app.stayops.com.au')}</div>`,
    footer: 'Sent by StayOps · You received this because a notification was triggered in your account.',
  });
}

module.exports = {
  cleanAssignment,
  cleanReminder,
  cancellation,
  bookingConfirmation,
  cleanerInvite,
  monthlyReport,
  notification,
  C,
};
