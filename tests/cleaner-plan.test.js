'use strict';
// Cleaner PWA day plan buckets (assets/js/utils.js bucketCleanerCleans) and the
// host-is-also-a-cleaner match behind the Host / Cleaner switch
// (findOwnCleanerRecord). Frontend modules are ESM, so dynamic-import from CJS.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const utilsUrl = pathToFileURL(path.join(__dirname, '..', 'assets', 'js', 'utils.js')).href;
const importUtils = () => import(utilsUrl);

const TODAY = '2026-10-19';
const clean = (id, clean_date, extra = {}) => ({ id, clean_date, done: false, cleaner_declined: false, _bookingCancelled: false, properties: { name: 'P' }, ...extra });

test('bucketCleanerCleans: open cleans older than the 3-day window are left out, not shown as overdue', async () => {
  const { bucketCleanerCleans } = await importUtils();
  const all = [
    clean('ancient', '2026-04-12'),           // never marked done, 6 months ago → stale
    clean('lastweek', '2026-10-12'),          // 7 days ago → stale
    clean('edge-out', '2026-10-15'),          // 4 days ago → stale
    clean('edge-in', '2026-10-16'),           // 3 days ago → overdue
    clean('yesterday', '2026-10-18'),         // overdue
    clean('today', TODAY),
    clean('tomorrow', '2026-10-20'),
    clean('later', '2026-10-25'),
  ];
  const b = bucketCleanerCleans(all, TODAY);
  assert.deepEqual(b.stale.map(c => c.id), ['ancient', 'lastweek', 'edge-out']);
  assert.deepEqual(b.overdue.map(c => c.id), ['edge-in', 'yesterday']);
  assert.deepEqual(b.today.map(c => c.id), ['today']);
  assert.deepEqual(b.tomorrow.map(c => c.id), ['tomorrow']);
  assert.deepEqual(b.later.map(c => c.id), ['later']);
  assert.equal(b.tomorrowStr, '2026-10-20');
  assert.deepEqual(b.open.map(c => c.id), ['edge-in', 'yesterday', 'today', 'tomorrow', 'later'], 'open (week strip, accept-all) excludes stale');
});

test('bucketCleanerCleans: cancellations stay while unacknowledged, then drop off after 14 days', async () => {
  const { bucketCleanerCleans } = await importUtils();
  const all = [
    clean('old-ack', '2026-06-06', { _bookingCancelled: true, cleaner_cancel_acknowledged: true }),
    clean('old-unack', '2026-09-20', { _bookingCancelled: true, cleaner_cancel_acknowledged: false }),
    clean('recent-ack', '2026-10-10', { _bookingCancelled: true, cleaner_cancel_acknowledged: true }),
    clean('cancelled-done', '2026-10-10', { _bookingCancelled: true, done: true }),
  ];
  const b = bucketCleanerCleans(all, TODAY);
  assert.deepEqual(b.cancelled.map(c => c.id), ['old-unack', 'recent-ack']);
  assert.equal(b.overdue.length, 0);
});

test('bucketCleanerCleans: within a day, same-day turnovers first by deadline; completed newest first; declined hidden', async () => {
  const { bucketCleanerCleans } = await importUtils();
  const all = [
    clean('b', TODAY, { _deadlineMinutes: 15 * 60, properties: { name: 'Hilltop' } }),
    clean('a', TODAY, { _deadlineMinutes: 13 * 60, properties: { name: 'Seaview' } }),
    clean('c', TODAY, { properties: { name: 'Riverbend' } }),            // no deadline → last
    clean('declined', TODAY, { cleaner_declined: true }),
    clean('done-old', '2026-10-01', { done: true, completed_at: '2026-10-01T12:00:00' }),
    clean('done-new', '2026-10-17', { done: true, completed_at: '2026-10-17T13:00:00' }),
  ];
  const b = bucketCleanerCleans(all, TODAY);
  assert.deepEqual(b.today.map(c => c.id), ['a', 'b', 'c']);
  assert.deepEqual(b.completed.map(c => c.id), ['done-new', 'done-old']);
  assert.ok(!b.open.some(c => c.id === 'declined'));
});

test('findOwnCleanerRecord: auth id wins, email is the fallback (case-insensitive), nothing else matches', async () => {
  const { findOwnCleanerRecord } = await importUtils();
  const cleaners = [
    { id: 1, name: 'Laura', email: '', auth_user_id: null },
    { id: 2, name: 'Megan', email: 'host@example.com', auth_user_id: 'auth-host' },
    { id: 3, name: 'Michel', email: 'HOST@example.com', auth_user_id: null },
  ];
  assert.equal(findOwnCleanerRecord({ id: 'auth-host', email: 'other@example.com' }, cleaners).name, 'Megan', 'by auth id');
  assert.equal(findOwnCleanerRecord({ id: 'auth-x', email: ' Host@Example.com ' }, cleaners).name, 'Megan', 'by email, first match');
  assert.equal(findOwnCleanerRecord({ id: 'auth-x', email: 'nobody@example.com' }, cleaners), null);
  assert.equal(findOwnCleanerRecord(null, cleaners), null);
  assert.equal(findOwnCleanerRecord({ id: 'auth-host' }, []), null);
});
