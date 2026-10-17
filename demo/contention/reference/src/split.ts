import type { Money } from "./core/money.ts";
import { allocate } from "./core/money.ts";
import type { Invoice } from "./invoice.ts";

/** The invoice total in `people` equal shares that add up to it. Throws a RangeError for fewer than 1 or a fraction. */
export function splitBill(invoice: Invoice, people: number): Money[] {
  if (!Number.isSafeInteger(people) || people < 1) throw new RangeError(`split: ${people} is not a number of people`);
  return allocate(invoice.total, Array.from({ length: people }, () => 1));
}
