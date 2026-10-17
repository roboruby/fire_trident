import type { Money } from "./core/money.ts";
import { multiply, sum } from "./core/money.ts";
import type { Product } from "./catalog.ts";

/** A quantity of one product. */
export interface CartLine {
  readonly product: Product;
  readonly quantity: number;
}

/** What a customer is buying, in one currency. Carts are values: adding returns a new cart. */
export interface Cart {
  readonly currency: string;
  readonly lines: readonly CartLine[];
}

/** An empty cart in `currency`. */
export function emptyCart(currency: string = "USD"): Cart {
  return { currency, lines: [] };
}

/**
 * A cart with `quantity` more of `product`, added to its line when the cart has one. Throws a RangeError for a
 * quantity that is not a positive whole number, and a TypeError for a product priced in another currency.
 */
export function addToCart(cart: Cart, product: Product, quantity: number = 1): Cart {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new RangeError(`cart: quantity ${quantity} is not a positive whole number`);
  if (product.price.currency !== cart.currency) throw new TypeError(`cart: ${product.sku} is priced in ${product.price.currency}, the cart in ${cart.currency}`);
  const i = cart.lines.findIndex((l) => l.product.sku === product.sku);
  if (i === -1) return { ...cart, lines: [...cart.lines, { product, quantity }] };
  const lines = cart.lines.map((l, j) => (j === i ? { product: l.product, quantity: l.quantity + quantity } : l));
  return { ...cart, lines };
}

/** A line's total: its unit price times its quantity. */
export function lineTotal(line: CartLine): Money {
  return multiply(line.product.price, line.quantity);
}

/** The sum of the cart's line totals. */
export function subtotal(cart: Cart): Money {
  return sum(cart.lines.map(lineTotal), cart.currency);
}
