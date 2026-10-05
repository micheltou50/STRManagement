import { expenseAllocations, unallocatedExpenseAmount } from './utils.js';
import { bookingRevenue, bookingMgmtPayout, isRevenueBearingBooking } from './booking-revenue.js';

const cents = value => Math.round((Number(value) || 0) * 100);
const keysFor = booking => new Set([booking.id, booking._cloudId].filter(v => v != null).map(String));

// Actual costs never change the guest cleaning charge or management fee.
// Allocations take precedence over a potentially stale clean.cost mirror.
export function ownerCleaningCost(booking, expenses = [], cleans = []) {
  if (!booking || !isRevenueBearingBooking(booking)) return 0;
  const keys = keysFor(booking);
  let total = 0;
  let count = 0;
  for (const expense of expenses) {
    if (!expense || expense.status === 'deleted') continue;
    for (const allocation of expenseAllocations(expense)) {
      if (!keys.has(String(allocation.bookingId))) continue;
      total += cents(allocation.amount);
      count++;
    }
  }
  if (count) return total / 100; // includes a fully credited zero cost
  return cleans.filter(c => keys.has(String(c.bookingId)))
    .reduce((sum, c) => sum + cents(c.cost), 0) / 100;
}

export function ownerBookingPayout(booking, expenses = [], cleans = []) {
  if (!booking || !isRevenueBearingBooking(booking)) return 0;
  return (cents(bookingRevenue(booking)) - cents(bookingMgmtPayout(booking))
    - cents(ownerCleaningCost(booking, expenses, cleans))) / 100;
}

/** Where a stay's cleaning cost comes from: a cleaner's invoice allocated to
 *  the stay ('invoice'), the clean record's default cost ('estimate'), or
 *  nothing ('none'). The owner statement labels the figure accordingly. */
export function ownerCleaningCostSource(booking, expenses = [], cleans = []) {
  if (!booking || !isRevenueBearingBooking(booking)) return 'none';
  const keys = keysFor(booking);
  for (const expense of expenses) {
    if (!expense || expense.status === 'deleted') continue;
    for (const allocation of expenseAllocations(expense)) {
      if (keys.has(String(allocation.bookingId))) return 'invoice';
    }
  }
  return cleans.some(c => keys.has(String(c.bookingId)) && cents(c.cost) !== 0) ? 'estimate' : 'none';
}

const _normName = s => String(s || '').toLowerCase()
  .replace(/\b(pty|ltd|limited|inc|co|the)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/** The manager's own invoice to the owner, recorded as an expense when it was
 *  issued or paid. The fee it bills is already on the statement as
 *  "Management fees" for the month it accrued, so deducting the invoice again
 *  charges the owner twice. identity: { company, name } from the host profile. */
export function isOwnInvoiceExpense(expense, identity = {}) {
  if (!expense) return false;
  const company = _normName(identity.company);
  if (!company || company.length < 4) return false;
  const merchant = _normName(expense.merchant);
  const vendor = _normName(expense.vendor);
  const hit = v => !!v && (v === company || v.includes(company) || (company.includes(v) && v.length >= 6));
  return hit(merchant) || hit(vendor);
}

/**
 * Where a stay's money is, by the calendar. The platforms release the payout
 * the day after check-in, so a stay counts as paid once its check-in date is
 * behind us; nothing here waits on the bank. today: 'YYYY-MM-DD'.
 *   paid      check-in has passed, the payout is released
 *   upcoming  check-in is today or later
 */
export function bookingPayoutState(booking, today) {
  if (!booking) return 'upcoming';
  const checkin = String(booking.checkin || booking.checkout || '').slice(0, 10);
  const day = String(today || '').slice(0, 10);
  return checkin && day && checkin < day ? 'paid' : 'upcoming';
}

const _sumCents = (list, pick) => list.reduce((s, x) => s + cents(pick(x)), 0);

/**
 * The monthly owner statement, as numbers. Everything in cents internally.
 *
 * Expected  = every stay attributed to the month, whatever its state.
 * Received  = stays whose payout is released (check-in has passed).
 * Still owed = received, less the fees and cleaning on those stays, less the
 *              month's deductible expenses, less what was already paid to the
 *              owner.
 */
export function summariseOwnerMonth({
  bookings = [], expenses = [], cleans = [], today = '',
  identity = {}, deduct = true, isOwnerPaid = () => false, paidToOwner = 0,
} = {}) {
  const stays = bookings.filter(Boolean).map(b => {
    const gross = bookingRevenue(b);
    const mgmt = bookingMgmtPayout(b);
    const clean = ownerCleaningCost(b, expenses, cleans);
    return {
      booking: b,
      state: bookingPayoutState(b, today),
      gross, mgmt, clean,
      cleanSource: ownerCleaningCostSource(b, expenses, cleans),
      net: (cents(gross) - cents(mgmt) - cents(clean)) / 100,
      payoutUnknown: cents(gross) <= 0,
    };
  });
  const active = expenses.filter(e => e && e.status !== 'deleted');
  const ownInvoices = active.filter(e => isOwnInvoiceExpense(e, identity));
  const rest = active.filter(e => !isOwnInvoiceExpense(e, identity));
  const ownerPaid = rest.filter(e => isOwnerPaid(e));
  const operational = rest.filter(e => !isOwnerPaid(e));
  // Only the part of an expense NOT allocated to a stay is deducted here; the
  // allocated part is already inside that stay's cleaning cost.
  const deductibleExpenses = operational
    .map(e => ({ expense: e, amount: unallocatedExpenseAmount(e) }))
    .filter(x => Math.abs(cents(x.amount)) > 0);
  const deductibleCents = deduct ? _sumCents(deductibleExpenses, x => x.amount) : 0;

  const expectedGross = _sumCents(stays, s => s.gross);
  const expectedMgmt = _sumCents(stays, s => s.mgmt);
  const expectedClean = _sumCents(stays, s => s.clean);
  const projected = expectedGross - expectedMgmt - expectedClean - deductibleCents;

  const paid = stays.filter(s => s.state === 'paid');
  const receivedGross = _sumCents(paid, s => s.gross);
  const receivedNet = _sumCents(paid, s => s.net);
  const paidToOwnerCents = cents(paidToOwner);
  const stillOwed = receivedNet - deductibleCents - paidToOwnerCents;

  return {
    stays,
    counts: {
      total: stays.length,
      paid: paid.length,
      upcoming: stays.filter(s => s.state === 'upcoming').length,
    },
    expectedGross: expectedGross / 100,
    expectedMgmt: expectedMgmt / 100,
    expectedClean: expectedClean / 100,
    deductible: deductibleCents / 100,
    projectedPayout: projected / 100,
    receivedGross: receivedGross / 100,
    receivedNet: receivedNet / 100,
    paidToOwner: paidToOwnerCents / 100,
    stillOwed: stillOwed / 100,
    deductibleExpenses,
    ownInvoices,
    ownerPaidExpenses: ownerPaid,
    operationalExpenses: operational,
    ownerPaidTotal: _sumCents(ownerPaid, e => Math.abs(Number(e.amount) || 0)) / 100,
  };
}

