import { test } from "node:test";
import assert from "node:assert/strict";
import { money } from "../src/core/money.ts";
import { addToCart, emptyCart, lineTotal, subtotal } from "../src/cart.ts";

const tea = { sku: "TEA", name: "Green tea", price: money(450) };
const mug = { sku: "MUG", name: "Mug", price: money(1200) };

test("adding merges lines by SKU", () => {
  const cart = addToCart(addToCart(addToCart(emptyCart(), tea, 2), mug), tea);
  assert.equal(cart.lines.length, 2);
  assert.equal(cart.lines[0]?.quantity, 3);
  assert.deepEqual(lineTotal(cart.lines[0]!), money(1350));
  assert.deepEqual(subtotal(cart), money(2550));
});

test("carts are values", () => {
  const empty = emptyCart();
  addToCart(empty, tea);
  assert.equal(empty.lines.length, 0);
  assert.deepEqual(subtotal(empty), money(0));
});

test("bad quantities and currencies are refused", () => {
  assert.throws(() => addToCart(emptyCart(), tea, 0), RangeError);
  assert.throws(() => addToCart(emptyCart(), tea, 1.5), RangeError);
  assert.throws(() => addToCart(emptyCart("EUR"), tea), TypeError);
});
