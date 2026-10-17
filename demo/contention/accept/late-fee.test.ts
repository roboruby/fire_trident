import { test } from "node:test";
import assert from "node:assert/strict";
import { money, times } from "../../src/core/money.ts";
import { LATE_FEE_PERCENT, lateFee } from "../../src/latefee.ts";
import { discounted } from "./fixtures.ts";

test("late-fee: times multiplies by a whole number exactly", () => {
  assert.deepEqual(times(money(250), 3), money(750));
  assert.deepEqual(times(money(-250, "EUR"), 2), money(-500, "EUR"));
  assert.throws(() => times(money(1), 1.5), RangeError);
});

test("late-fee: 2 percent of the total per started 30 days", () => {
  assert.equal(LATE_FEE_PERCENT, 2);
  const inv = { ...discounted(), total: money(10000) };
  assert.deepEqual(lateFee(inv, 1), money(200));
  assert.deepEqual(lateFee(inv, 30), money(200));
  assert.deepEqual(lateFee(inv, 31), money(400));
  assert.deepEqual(lateFee(inv, 0), money(0));
  assert.deepEqual(lateFee(inv, -3), money(0));
  assert.deepEqual(lateFee(discounted(), 45), money(174));
});
