import { test } from "node:test";
import assert from "node:assert/strict";
import { money } from "../src/core/money.ts";
import { taxFor } from "../src/tax.ts";

test("sales tax by region, rounded to cents", () => {
  assert.deepEqual(taxFor(money(10000), "CA"), money(725));
  assert.deepEqual(taxFor(money(1999), "CA"), money(145));
  assert.deepEqual(taxFor(money(1999), "NY"), money(80));
  assert.deepEqual(taxFor(money(1000), "TX"), money(63));
  assert.deepEqual(taxFor(money(5000), "OR"), money(0));
  assert.deepEqual(taxFor(money(1000, "EUR"), "NY"), money(40, "EUR"));
});

test("a region with no rate is refused", () => {
  assert.throws(() => taxFor(money(100), "ZZ"), RangeError);
});
