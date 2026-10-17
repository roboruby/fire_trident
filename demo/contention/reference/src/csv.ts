import type { Money } from "./core/money.ts";
import { format, isZero } from "./core/money.ts";
import type { Invoice } from "./invoice.ts";

const amount = (m: Money): string => format(m, { symbol: false });

/** The invoice as CSV: a header, one row per line, then the subtotal, discount (when any), tax, shipping and total. */
export function invoiceCsv(invoice: Invoice): string {
  const rows = ["sku,name,quantity,unit,total"];
  for (const l of invoice.lines) rows.push(`${l.sku},${l.name},${l.quantity},${amount(l.unit)},${amount(l.total)}`);
  rows.push(`subtotal,,,,${amount(invoice.subtotal)}`);
  if (!isZero(invoice.discount)) rows.push(`discount,,,,${amount(invoice.discount)}`);
  rows.push(`tax,,,,${amount(invoice.tax)}`, `shipping,,,,${amount(invoice.shipping)}`, `total,,,,${amount(invoice.total)}`);
  return rows.join("\n");
}
