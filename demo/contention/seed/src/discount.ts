import type { Money } from "./core/money.ts";
import { compare, percentOf, subtract } from "./core/money.ts";

/** A fixed amount off, or a percentage off (15 is 15%). */
export type Discount = { readonly kind: "fixed"; readonly amount: Money } | { readonly kind: "percent"; readonly percent: number };

/** What `discount` takes off `subtotal`: never more than the subtotal. */
export function discountAmount(subtotal: Money, discount: Discount): Money {
  const off = discount.kind === "fixed" ? discount.amount : percentOf(subtotal, discount.percent);
  return compare(off, subtotal) > 0 ? subtotal : off;
}

/** The subtotal after the discount. */
export function applyDiscount(subtotal: Money, discount: Discount): Money {
  return subtract(subtotal, discountAmount(subtotal, discount));
}
