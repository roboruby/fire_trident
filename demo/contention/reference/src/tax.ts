import type { Money } from "./core/money.ts";
import { percentOf } from "./core/money.ts";

/** Sales tax rates in basis points (725 is 7.25%), by region. */
export const TAX_RATES: Readonly<Record<string, number>> = { CA: 725, NY: 400, TX: 625, OR: 0 };

/** The sales tax on `amount` in `region`. Throws a RangeError for a region with no rate. */
export function taxFor(amount: Money, region: string): Money {
  const rate = TAX_RATES[region];
  if (rate === undefined) throw new RangeError(`tax: no rate for region ${region}`);
  return percentOf(amount, rate);
}
