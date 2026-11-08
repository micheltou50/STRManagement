const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('cancellation SMS works without email and does not mark a cleaner notified', () => {
  const source = fs.readFileSync('assets/js/notifications.js', 'utf8');
  const section = source.slice(source.indexOf("let notifyPhone ="), source.indexOf('// ── EMAIL TEMPLATES'));
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', style: {}, classList: { add() {}, remove() {} } });
    return elements.get(id);
  };
  const clean = { id: 'clean', _cloudId: 'cloud-clean', bookingId: 'cloud-booking', cleaner: 'Jane Smith', guestName: 'Alex Guest', date: '2026-12-04' };
  const context = {
    cleans: [clean],
    bookings: [{ id: 'local-booking', _cloudId: 'cloud-booking', checkin: '2026-12-01', checkout: '2026-12-04' }],
    loadCleaners: () => [{ name: 'Jane Smith', phone: '0400123456' }],
    fmt: d => d, _normName: s => s, getCurrentPropertyName: () => 'Glenhaven',
    document: { getElementById: element, body: { style: {} }, querySelector: () => null },
    window: { location: {} }, console
  };
  vm.createContext(context);
  vm.runInContext(section.replaceAll('export ', ''), context);
  context.openNotifyModal('cloud-clean', 'cancellation');
  assert.equal(element('notify-modal').style.zIndex, '10000');
  assert.match(element('notify-message').value, /cancelled/);
  assert.match(element('notify-message').value, /Glenhaven/);
  assert.match(element('notify-message').value, /2026-12-04/);
  context.sendSMS();
  assert.match(context.window.location.href, /^sms:0400123456/);
  assert.equal(clean.notified, undefined);
  assert.equal(clean.cleanerCancelNotified, undefined);
  context.loadCleaners = () => [];
  context.openNotifyModal('clean', 'cancellation');
  assert.match(element('notify-number-display').textContent, /No number saved/);
});
