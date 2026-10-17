import { test } from "node:test";
import assert from "node:assert/strict";
import { max, min, money } from "../../src/core/money.ts";
import { FREE_SHIPPING_OVER_CENTS, shippingFor, shippingQuote } from "../../src/shipping.ts";

test("free-shipping: max and min", () => {
  assert.deepEqual(max(money(1), money(2)), money(2));
  assert.deepEqual(min(money(1), money(2)), money(1));
  assert.deepEqual(max(money(-5, "EUR"), money(-7, "EUR")), money(-5, "EUR"));
  assert.throws(() => max(money(1), money(1, "EUR")), TypeError);
  assert.throws(() => min(money(1), money(1, "EUR")), TypeError);
});

test("free-shipping: orders of 75.00 or more ship free", () => {
  assert.equal(FREE_SHIPPING_OVER_CENTS, 7500);
  assert.deepEqual(shippingQuote("CA", money(7500)), money(0));
  assert.deepEqual(shippingQuote("CA", money(7499)), money(599));
  assert.deepEqual(shippingQuote("NY", money(9000, "EUR")), money(0, "EUR"));
  assert.deepEqual(shippingQuote("TX", money(100, "EUR")), money(649, "EUR"));
  assert.throws(() => shippingQuote("ZZ", money(9000)), RangeError);
  assert.deepEqual(shippingFor("CA"), money(599));
});
