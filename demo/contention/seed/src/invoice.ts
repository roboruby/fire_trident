import type { Money } from "./core/money.ts";
import { add, zero } from "./core/money.ts";
import type { Cart } from "./cart.ts";
import { lineTotal, subtotal } from "./cart.ts";
import type { Discount } from "./discount.ts";
import { applyDiscount, discountAmount } from "./discount.ts";
import { taxFor } from "./tax.ts";
import { shippingFor } from "./shipping.ts";

/** One line of an invoice. */
export interface InvoiceLine {
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly unit: Money;
  readonly total: Money;
}

/** An invoice: its lines and every amount that makes its total. */
export interface Invoice {
  readonly number: string;
  readonly region: string;
  readonly currency: string;
  readonly lines: readonly InvoiceLine[];
  readonly subtotal: Money;
  readonly discount: Money;
  readonly tax: Money;
  readonly shipping: Money;
  readonly total: Money;
}

/**
 * Invoice a cart shipped to `region`: the subtotal, the discount when one is given, sales tax on the subtotal after
 * the discount, flat shipping (not taxed), and the total. Throws a RangeError for an empty cart.
 */
export function buildInvoice(number: string, cart: Cart, region: string, discount?: Discount): Invoice {
  if (cart.lines.length === 0) throw new RangeError(`invoice ${number}: the cart is empty`);
  const lines = cart.lines.map((l) => ({ sku: l.product.sku, name: l.product.name, quantity: l.quantity, unit: l.product.price, total: lineTotal(l) }));
  const sub = subtotal(cart);
  const off = discount ? discountAmount(sub, discount) : zero(cart.currency);
  const taxable = discount ? applyDiscount(sub, discount) : sub;
  const tax = taxFor(taxable, region);
  const shipping = shippingFor(region, cart.currency);
  return { number, region, currency: cart.currency, lines, subtotal: sub, discount: off, tax, shipping, total: add(add(taxable, tax), shipping) };
}
