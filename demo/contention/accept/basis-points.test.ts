import { test } from "node:test";
import assert from "node:assert/strict";
import { money, percentOf } from "../../src/core/money.ts";
import { TAX_RATES, taxFor } from "../../src/tax.ts";
import { applyDiscount, discountAmount } from "../../src/discount.ts";
import { discounted } from "./fixtures.ts";

test("basis-points: percentOf takes hundredths of a percent", () => {
  assert.deepEqual(percentOf(money(10000), 725), money(725));
  assert.deepEqual(percentOf(money(2000), 1500), money(300));
  assert.deepEqual(percentOf(money(10000), 10000), money(10000));
  assert.deepEqual(percentOf(money(1999), 725), money(145));
  assert.deepEqual(percentOf(money(-1999), 725), money(-145));
});

test("basis-points: tax rates are basis points and taxes do not change", () => {
  assert.deepEqual({ ...TAX_RATES }, { CA: 725, NY: 400, TX: 625, OR: 0 });
  assert.deepEqual(taxFor(money(10000), "CA"), money(725));
  assert.deepEqual(taxFor(money(1999), "NY"), money(80));
  assert.deepEqual(taxFor(money(1000), "TX"), money(63));
});

test("basis-points: percent discounts keep whole percents", () => {
  assert.deepEqual(discountAmount(money(2000), { kind: "percent", percent: 15 }), money(300));
  assert.deepEqual(applyDiscount(money(2000), { kind: "percent", percent: 25 }), money(1500));
  assert.deepEqual(discounted().total, money(4362));
});
