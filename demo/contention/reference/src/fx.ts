import type { Money } from "./core/money.ts";
import { convert } from "./core/money.ts";
import type { Invoice } from "./invoice.ts";

/** The invoice in `currency` at `rate`: every amount converted on its own. */
export function convertInvoice(invoice: Invoice, rate: number, currency: string): Invoice {
  const c = (m: Money): Money => convert(m, rate, currency);
  return {
    ...invoice,
    currency,
    lines: invoice.lines.map((l) => ({ ...l, unit: c(l.unit), total: c(l.total) })),
    subtotal: c(invoice.subtotal),
    discount: c(invoice.discount),
    tax: c(invoice.tax),
    shipping: c(invoice.shipping),
    total: c(invoice.total),
  };
}
