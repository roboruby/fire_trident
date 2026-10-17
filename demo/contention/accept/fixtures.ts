import { money } from "../../src/core/money.ts";
import { addToCart, emptyCart } from "../../src/cart.ts";
import { buildInvoice } from "../../src/invoice.ts";

// The invoices the acceptance tests share, built only from the seed's own modules.
export const tea = { sku: "TEA", name: "Green tea", price: money(450) };
export const pot = { sku: "POT", name: "Teapot", price: money(2999) };

/** 2 TEA shipped to OR: subtotal 9.00, no tax, shipping 5.99, total 14.99. */
export const small = () => buildInvoice("INV-1", addToCart(emptyCart(), tea, 2), "OR");

/** 2 TEA and 1 POT shipped to CA with 10% off: subtotal 38.99, discount 3.90, tax 2.54, shipping 5.99, total 43.62. */
export const discounted = () => buildInvoice("INV-2", addToCart(addToCart(emptyCart(), tea, 2), pot), "CA", { kind: "percent", percent: 10 });
