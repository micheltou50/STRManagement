import { expenseAllocations } from './utils.js';
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
