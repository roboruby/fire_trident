import type { Money } from "./core/money.ts";
import { percentOf, times, zero } from "./core/money.ts";
import type { Invoice } from "./invoice.ts";

/** Percent of the total an overdue invoice owes per started 30 days. */
export const LATE_FEE_PERCENT = 2;

/** The late fee on `invoice` after `daysLate` days: LATE_FEE_PERCENT of the total per started 30-day period. */
export function lateFee(invoice: Invoice, daysLate: number): Money {
  if (daysLate <= 0) return zero(invoice.currency);
  return times(percentOf(invoice.total, LATE_FEE_PERCENT * 100), Math.ceil(daysLate / 30));
}
