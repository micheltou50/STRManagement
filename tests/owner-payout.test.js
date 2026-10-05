const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const load = () => import('../assets/js/owner-payout.js');
const booking = { id: 'local', _cloudId: 'cloud', status: 'confirmed', hostPayout: 1464.90, cleaningFee: 500, mgmtFee: 96.49, mgmtPayout: 96.49, netPayout: 868.41 };
const expense = (amount, status = 'active') => ({ amount, status, bookingId: 'cloud' });

test('Terry replacement overrides stale clean without changing management or guest fee', async () => {
  const { ownerBookingPayout, ownerCleaningCost } = await load();
  const before = JSON.stringify(booking);
  const rows = [expense(250, 'deleted'), expense(250)];
  assert.equal(ownerCleaningCost(booking, rows, [{ bookingId: 'local', cost: 500 }]), 250);
  assert.equal(ownerBookingPayout(booking, rows), 1118.41);
  assert.equal(JSON.stringify(booking), before);
});
test('combined invoice uses each share once, ignoring legacy first-booking mirror', async () => {
  const { ownerCleaningCost } = await load();
  const rows = [{ amount: 500, bookingId: 'cloud', bookingAllocations: [{bookingId:'cloud', amount:250},{bookingId:'other', amount:250}] }];
  assert.equal(ownerCleaningCost(booking, rows), 250);
  assert.equal(ownerCleaningCost({...booking, id:'other', _cloudId:null}, rows), 250);
});
test('seven unequal allocations retain exact invoice total', async () => {
  const { ownerCleaningCost } = await load();
  const values = [100,125,150,175,200,225,250];
  const rows = [{amount:1225, bookingAllocations:values.map((amount,i)=>({bookingId:String(i),amount}))}];
  assert.equal(values.reduce((s,_,i)=>s+ownerCleaningCost({...booking,id:String(i),_cloudId:null},rows),0),1225);
});
test('credit note cancels cost without reverting to cached clean', async () => {
  const { ownerCleaningCost } = await load();
  assert.equal(ownerCleaningCost(booking,[expense(250),expense(-250)],[{bookingId:'local',cost:500}]),0);
});
test('allocation works without a clean row and does not leak to other bookings', async () => {
  const { ownerCleaningCost } = await load();
  assert.equal(ownerCleaningCost(booking,[expense(151.25)]),151.25);
  assert.equal(ownerCleaningCost({...booking,id:'another',_cloudId:null},[expense(151.25)]),0);
});
test('nonbillable cancellations contribute zero', async () => {
  const { ownerBookingPayout } = await load();
  assert.equal(ownerBookingPayout({...booking,status:'cancelled',cancellationBillable:false},[expense(250)]),0);
});
test('owner payout uses Management amount, not legacy gross-based fee', async () => {
  const { ownerBookingPayout } = await load();
  assert.equal(ownerBookingPayout({...booking,hostPayout:1208.75,mgmtFee:120.88,mgmtPayout:104.38},[expense(165)]),939.37);
});
test('actual cleaning save never calls booking save; failed clean write restores memory', async () => {
  const source=fs.readFileSync(require.resolve('../assets/js/bookings.js'),'utf8');
  const start=source.indexOf('async function applyCleanCostAndRecompute(');
  const end=source.indexOf('\nasync function saveCleanCost',start);
  const clean={id:'c',cost:500};
  let fail=false;
  const context={cleans:[clean],bookings:[{...booking}],saveCleanToCloud:async()=>({ok:!fail,error:'test failure'}),saveBookingToCloud:()=>assert.fail('management must not be rewritten')};
  vm.createContext(context);
  vm.runInContext(source.slice(start,end),context);
  assert.equal((await context.applyCleanCostAndRecompute('c','cloud',250)).ok,true);
  assert.equal(clean.cost,250);
  fail=true;
  assert.equal((await context.applyCleanCostAndRecompute('c','cloud',400)).ok,false);
  assert.equal(clean.cost,250);
  assert.equal(context.bookings[0].mgmtPayout,96.49);
});

test('expense deletion waits for cloud success and preserves expense on failure', async () => {
  const source=fs.readFileSync(require.resolve('../assets/js/finance.js'),'utf8');
  const start=source.indexOf('async function deleteExpense(');
  const end=source.indexOf('// ── EXPENSE EDIT',start);
  const { expenseAllocations } = await import('../assets/js/utils.js');
  const rows=[{id:1,...expense(250)}];
  let fail=true;
  let recomputes=0;
  const context={expenses:rows,expenseAllocations,showAppModal:async()=>true,
    deleteExpenseFromCloud:async()=>({ok:!fail}),savePropertyData(){},renderExpenses(){},showBanner(){},
    replaceArrayInPlace:(target,next)=>target.splice(0,target.length,...next),
    _recomputeAllocationTargets:async()=>{assert.equal(rows.length,0);recomputes++;}
  };
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  await context.deleteExpense(1);
  assert.equal(rows.length,1);assert.equal(recomputes,0);
  fail=false;await context.deleteExpense(1);
  assert.equal(rows.length,0);assert.equal(recomputes,1);
  rows.push({id:2,...expense(250)}); // replacement after failed receipt upload
  const { ownerCleaningCost }=await load();
  assert.equal(ownerCleaningCost(booking,rows,[{bookingId:'local',cost:500}]),250);
});

test('repeated expense removal only marks deleted and never physically deletes', async () => {
  const source=fs.readFileSync(require.resolve('../assets/js/supabase-expenses.js'),'utf8');
  const start=source.indexOf('export async function deleteExpenseFromCloud');
  const updates=[];const filters=[];
  const builder={update:values=>{updates.push(values);return builder;},eq:(key,value)=>{filters.push([key,value]);return builder;},delete:()=>assert.fail('physical delete forbidden')};
  const context={getCurrentSupabaseUser:async()=>({id:'user'}),window:{_sb:{from:()=>builder}},sbWrite:async()=>({ok:true})};
  vm.createContext(context);vm.runInContext(source.slice(start).replace('export async','async'),context);
  await context.deleteExpenseFromCloud({_cloudId:'expense'});
  await context.deleteExpenseFromCloud({_cloudId:'expense',status:'deleted'});
  assert.equal(updates.length,2);
  assert.ok(updates.every(v=>v.status==='deleted'));
  assert.equal(filters.filter(([k,v])=>k==='user_id' && v==='user').length,2);
});

// ── Monthly owner statement: received / expected / still owed ───────────────
const stay = (id, checkout, hostPayout, mgmt, extra = {}) =>
  ({ id, _cloudId: 'c-' + id, status: 'confirmed', checkin: checkout, checkout, hostPayout, mgmtPayout: mgmt, cleaningFee: 0, ...extra });

test('bookingPayoutState(): the calendar decides — paid once check-in has passed', async () => {
  const { bookingPayoutState } = await load();
  const b = { ...stay('a', '2026-10-05', 100, 10), checkin: '2026-10-02' };
  assert.equal(bookingPayoutState(b, '2026-10-03'), 'paid', 'the day after check-in');
  assert.equal(bookingPayoutState(b, '2026-10-02'), 'upcoming', 'check-in day itself is not yet released');
  assert.equal(bookingPayoutState(b, '2026-10-01'), 'upcoming');
  assert.equal(bookingPayoutState(stay('z', '2026-10-25', 100, 10), '2026-10-05'), 'upcoming');
  assert.equal(bookingPayoutState({ checkout: '2026-10-05' }, '2026-10-06'), 'paid', 'falls back to check-out when check-in is missing');
});

test('isOwnInvoiceExpense(): the manager\'s own invoice, by company name, loosely', async () => {
  const { isOwnInvoiceExpense } = await load();
  const me = { company: 'MT Management PTY LTD', name: 'Michel Toubia' };
  assert.equal(isOwnInvoiceExpense({ merchant: 'MT Management PTY LTD' }, me), true);
  assert.equal(isOwnInvoiceExpense({ merchant: 'mt management' }, me), true);
  assert.equal(isOwnInvoiceExpense({ merchant: 'Megan Orme' }, me), false);
  assert.equal(isOwnInvoiceExpense({ merchant: 'MT Management PTY LTD' }, { company: '' }), false);
});

test('summariseOwnerMonth(): the October shape — one stay released, invoice excluded, cleaning once', async () => {
  const { summariseOwnerMonth } = await load();
  const bookings = [
    stay('1', '2026-10-01', 671.89, 42.19),
    { ...stay('2', '2026-10-05', 1750.27, 155.03), checkin: '2026-10-02' },
    stay('3', '2026-10-09', 1759.94, 155.99),
  ];
  const cleans = [{ bookingId: '1', cost: 250 }, { bookingId: '2', cost: 200 }, { bookingId: '3', cost: 200 }];
  const expenses = [
    // The cleaner's invoice, allocated to stay 2: counted under cleaning, not again under expenses.
    { amount: 500, merchant: 'Megan Orme', category: 'Cleaning & Garden', bookingAllocations: [{ bookingId: 'c-2', amount: 500 }] },
    // The manager's own September invoice: never an owner expense.
    { amount: 808.18, merchant: 'MT Management PTY LTD', category: 'Professional Services' },
    // A genuine deductible expense.
    { amount: 60, merchant: 'Bunnings', category: 'Maintenance & Repairs' },
  ];
  const s = summariseOwnerMonth({
    bookings, expenses, cleans, today: '2026-10-05',
    identity: { company: 'MT Management PTY LTD' }, deduct: true, paidToOwner: 0,
  });
  assert.equal(s.counts.total, 3);
  assert.equal(s.counts.paid, 2, 'checked in 1 Oct and 2 Oct: released');
  assert.equal(s.counts.upcoming, 1);
  assert.equal(s.expectedGross, 4182.10);
  assert.equal(s.expectedClean, 950, '250 + 500 (invoice beats the 200 estimate) + 200');
  assert.equal(s.deductible, 60, 'the allocated cleaner invoice and the own invoice are not deducted');
  assert.equal(s.deductibleExpenses.length, 1);
  assert.equal(s.ownInvoices.length, 1);
  assert.equal(s.projectedPayout, 2818.89, '4182.10 − 353.21 − 950 − 60, exact in cents');
  assert.equal(s.receivedGross, 2422.16, '671.89 + 1750.27');
  assert.equal(s.receivedNet, 1474.94, '379.70 + (1750.27 − 155.03 − 500)');
  assert.equal(s.stillOwed, 1414.94, 'released net less the $60 paid on the owner\'s behalf');
  assert.equal(s.stays[1].cleanSource, 'invoice');
  assert.equal(s.stays[0].cleanSource, 'estimate');
});

test('summariseOwnerMonth(): once stays are released, still owed is their net less what was transferred', async () => {
  const { summariseOwnerMonth } = await load();
  const bookings = [stay('1', '2026-10-01', 1000, 100), stay('2', '2026-10-20', 2000, 200)];
  const cleans = [{ bookingId: '1', cost: 250 }, { bookingId: '2', cost: 250 }];
  const s = summariseOwnerMonth({ bookings, expenses: [], cleans, today: '2026-10-05', deduct: true, paidToOwner: 400 });
  assert.equal(s.counts.paid, 1);
  assert.equal(s.receivedGross, 1000);
  assert.equal(s.receivedNet, 650);
  assert.equal(s.stillOwed, 250);
  assert.equal(s.projectedPayout, 3000 - 300 - 500);
});

