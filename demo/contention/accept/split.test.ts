import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, money } from "../../src/core/money.ts";
import { splitBill } from "../../src/split.ts";
import { discounted, small } from "./fixtures.ts";

test("split: allocate keeps every cent and gives leftovers by largest remainder", () => {
  assert.deepEqual(allocate(money(100), [1, 1, 1]), [money(34), money(33), money(33)]);
  assert.deepEqual(allocate(money(1000), [70, 30]), [money(700), money(300)]);
  assert.deepEqual(allocate(money(5), [1, 1]), [money(3), money(2)]);
  assert.deepEqual(allocate(money(10, "EUR"), [1, 2]), [money(3, "EUR"), money(7, "EUR")]);
  assert.throws(() => allocate(money(100), []), RangeError);
  assert.throws(() => allocate(money(100), [1, -1]), RangeError);
  assert.throws(() => allocate(money(100), [0, 0]), RangeError);
});

test("split: splitBill shares the invoice total equally", () => {
  const inv = small();
  assert.deepEqual(splitBill(inv, 2), [money(750), money(749)]);
  assert.deepEqual(splitBill(inv, 1), [money(1499)]);
  const shares = splitBill(discounted(), 3);
  assert.equal(shares.reduce((s, m) => s + m.cents, 0), discounted().total.cents);
  assert.throws(() => splitBill(inv, 0), RangeError);
  assert.throws(() => splitBill(inv, 1.5), RangeError);
});
