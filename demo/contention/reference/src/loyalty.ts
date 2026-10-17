import { subtract, wholeUnits } from "./core/money.ts";
import type { Invoice } from "./invoice.ts";

/** Loyalty points for an invoice: one per whole unit of goods after the discount, never below 0. */
export function pointsFor(invoice: Invoice): number {
  return Math.max(0, wholeUnits(subtract(invoice.subtotal, invoice.discount)));
}
