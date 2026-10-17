import { test } from "node:test";
import assert from "node:assert/strict";
import { money } from "../src/core/money.ts";
import { applyDiscount, discountAmount } from "../src/discount.ts";

test("a percent discount takes that share, rounded to cents", () => {
  assert.deepEqual(discountAmount(money(2000), { kind: "percent", percent: 15 }), money(300));
  assert.deepEqual(discountAmount(money(999), { kind: "percent", percent: 10 }), money(100));
  assert.deepEqual(applyDiscount(money(2000), { kind: "percent", percent: 25 }), money(1500));
});

test("a fixed discount never takes more than the subtotal", () => {
  assert.deepEqual(discountAmount(money(2000), { kind: "fixed", amount: money(500) }), money(500));
  assert.deepEqual(discountAmount(money(300), { kind: "fixed", amount: money(500) }), money(300));
  assert.deepEqual(applyDiscount(money(300), { kind: "fixed", amount: money(500) }), money(0));
});
