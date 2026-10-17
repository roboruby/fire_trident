import type { Money } from "./core/money.ts";
import { add, percentOf, roundUp } from "./core/money.ts";

/** The tips the checkout suggests, in percent. */
export const TIP_PERCENTS: readonly number[] = [15, 18, 20];

/** One suggestion per tip percent: the tip and the total with it. */
export function suggestTips(total: Money): Array<{ percent: number; tip: Money; withTip: Money }> {
  return TIP_PERCENTS.map((percent) => {
    const tip = percentOf(total, percent * 100);
    return { percent, tip, withTip: add(total, tip) };
  });
}

/** The total with a `percent` tip, rounded up to a whole unit. */
export function roundedTotal(total: Money, percent: number): Money {
  return roundUp(add(total, percentOf(total, percent * 100)), 100);
}
