import { isNegative, negate } from "./core/money.ts";
import type { Invoice } from "./invoice.ts";

/** A credit note for `invoice`: the same invoice under `number` with every amount negated. */
export function creditNote(invoice: Invoice, number: string): Invoice {
  return {
    ...invoice,
    number,
    lines: invoice.lines.map((l) => ({ ...l, unit: negate(l.unit), total: negate(l.total) })),
    subtotal: negate(invoice.subtotal),
    discount: negate(invoice.discount),
    tax: negate(invoice.tax),
    shipping: negate(invoice.shipping),
    total: negate(invoice.total),
  };
}

/** Is this a credit note (a negative total)? */
export function isCreditNote(invoice: Invoice): boolean {
  return isNegative(invoice.total);
}
