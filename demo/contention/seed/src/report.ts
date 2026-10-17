import { format, sum } from "./core/money.ts";
import type { Invoice } from "./invoice.ts";

/**
 * A plain-text sales report: one line per invoice, "<number> <region> <total>", then "TOTAL <sum>", with the amounts
 * written without a currency symbol and the columns separated by single spaces. Throws a TypeError when the invoices
 * are in different currencies.
 */
export function salesReport(invoices: readonly Invoice[]): string {
  const lines = invoices.map((inv) => `${inv.number} ${inv.region} ${format(inv.total, false)}`);
  const total = sum(invoices.map((inv) => inv.total), invoices[0]?.currency);
  return [...lines, `TOTAL ${format(total, false)}`].join("\n");
}
