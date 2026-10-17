import { test } from "node:test";
import assert from "node:assert/strict";
import { money } from "../src/core/money.ts";
import { addToCart, emptyCart } from "../src/cart.ts";
import { buildInvoice } from "../src/invoice.ts";
import { salesReport } from "../src/report.ts";

const tea = { sku: "TEA", name: "Green tea", price: money(450) };

test("one line per invoice, then the total, amounts without a symbol", () => {
  const a = buildInvoice("INV-1", addToCart(emptyCart(), tea, 2), "OR");
  const b = buildInvoice("INV-2", addToCart(emptyCart(), tea, 10), "CA");
  assert.equal(salesReport([a, b]), "INV-1 OR 14.99\nINV-2 CA 54.25\nTOTAL 69.24");
});

test("an empty report is a zero total", () => {
  assert.equal(salesReport([]), "TOTAL 0.00");
});

test("mixed currencies are refused", () => {
  const usd = buildInvoice("INV-1", addToCart(emptyCart(), tea), "OR");
  const eur = buildInvoice("INV-2", addToCart(emptyCart("EUR"), { ...tea, price: money(450, "EUR") }), "OR");
  assert.throws(() => salesReport([usd, eur]), TypeError);
});
