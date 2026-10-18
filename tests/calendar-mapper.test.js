'use strict';
// calendar-mapper: the outbound header lines must not come back in as notes.
// (Before this, every Google/Outlook round trip grew cleans.notes by one
// "Cleaner: … / Guest: … / Status: …" block.)
const test = require('node:test');
const assert = require('node:assert/strict');
const mapper = require('../Netlify/functions/utils/calendar-mapper.js');

test('clean round trip: event → local gives back exactly the host note', () => {
  const clean = { id: 'c1', clean_date: '2026-10-20', cleaner: 'Megan', guest_name: 'Heidi', cleaner_confirmed: true, notes: 'Spare linen in the hall cupboard' };
  const ev = mapper.cleanToEvent(clean, 'Glenhaven');
  assert.match(ev.description, /^Cleaner: Megan\nGuest: Heidi\nStatus: Confirmed\n\nSpare linen/);
  const patch = mapper.eventToLocal('cleans', ev);
  assert.deepEqual(patch, { clean_date: '2026-10-20', notes: 'Spare linen in the hall cupboard' });
});

test('clean round trip with no note comes back as an empty note, not the header', () => {
  const ev = mapper.cleanToEvent({ id: 'c1', clean_date: '2026-10-20', cleaner: 'Megan', guest_name: 'Heidi', done: true }, 'Glenhaven');
  assert.equal(mapper.eventToLocal('cleans', ev).notes, '');
});

test('an already-polluted description is cleaned, keeping only the real note', () => {
  const block = 'Cleaner: Megan\nGuest: Heidi Heathcote\nStatus: Confirmed';
  const description = [block, block, block, block, block, 'Bins out Tuesday', '[stayops:cleans:c1]'].join('\n\n');
  const patch = mapper.eventToLocal('cleans', { summary: 'Clean — Glenhaven', description, start: { dateTime: '2026-10-20T11:00:00' } });
  assert.equal(patch.notes, 'Bins out Tuesday');
});

test('maintenance strips its own header lines but keeps the description', () => {
  const ev = mapper.maintenanceToEvent({ id: 'm1', date: '2026-10-21', description: 'Fix side gate', contractor: 'Bob', cost: 120, status: 'open' });
  const patch = mapper.eventToLocal('maintenance', ev);
  assert.equal(patch.description, 'Fix side gate');
  assert.equal(patch.notes, '');
});

test('stripGeneratedLines leaves unknown tables alone and tidies blank runs', () => {
  assert.equal(mapper.stripGeneratedLines('Status: x\n\n\n\nkeep', 'inbox'), 'Status: x\n\nkeep');
  assert.equal(mapper.stripGeneratedLines('Guest: A\n\n\n\nkeep me\nStatus: B', 'cleans'), 'keep me');
});
