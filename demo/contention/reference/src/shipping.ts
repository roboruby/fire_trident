import type { Money } from "./core/money.ts";
import { compare, money, zero } from "./core/money.ts";

/** Flat shipping by region, in cents. */
export const SHIPPING_CENTS: Readonly<Record<string, number>> = { CA: 599, NY: 699, TX: 649, OR: 599 };

/** Orders at or above this many cents ship free. */
export const FREE_SHIPPING_OVER_CENTS = 7500;

/** Shipping to `region` in `currency`. Throws a RangeError for a region the shop does not ship to. */
export function shippingFor(region: string, currency: string = "USD"): Money {
  const cents = SHIPPING_CENTS[region];
  if (cents === undefined) throw new RangeError(`shipping: no shipping to region ${region}`);
  return money(cents, currency);
}

/** Shipping for an order of `subtotal`: free at 75.00 or more. Throws a RangeError for a region the shop does not ship to. */
export function shippingQuote(region: string, subtotal: Money): Money {
  const flat = shippingFor(region, subtotal.currency);
  return compare(subtotal, money(FREE_SHIPPING_OVER_CENTS, subtotal.currency)) >= 0 ? zero(subtotal.currency) : flat;
}
