import { test } from "node:test";
import assert from "node:assert/strict";
import { money } from "../src/core/money.ts";
import { addToCart, emptyCart } from "../src/cart.ts";
import { buildInvoice } from "../src/invoice.ts";

const tea = { sku: "TEA", name: "Green tea", price: money(450) };
const pot = { sku: "POT", name: "Teapot", price: money(2999) };
const cart = addToCart(addToCart(emptyCart(), tea, 2), pot);

test("an invoice adds tax on the subtotal and flat shipping", () => {
  const inv = buildInvoice("INV-1", cart, "CA");
  assert.deepEqual(inv.lines.map((l) => [l.sku, l.quantity, l.total.cents]), [["TEA", 2, 900], ["POT", 1, 2999]]);
  assert.deepEqual(inv.subtotal, money(3899));
  assert.deepEqual(inv.discount, money(0));
  assert.deepEqual(inv.tax, money(283));
  assert.deepEqual(inv.shipping, money(599));
  assert.deepEqual(inv.total, money(4781));
});

test("tax is on the subtotal after the discount", () => {
  const inv = buildInvoice("INV-2", cart, "NY", { kind: "percent", percent: 10 });
  assert.deepEqual(inv.discount, money(390));
  assert.deepEqual(inv.tax, money(140));
  assert.deepEqual(inv.total, money(3509 + 140 + 699));
});

test("an empty cart cannot be invoiced", () => {
  assert.throws(() => buildInvoice("INV-3", emptyCart(), "CA"), RangeError);
});
