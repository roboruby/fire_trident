import { test } from "node:test";
import assert from "node:assert/strict";
import { money, wholeUnits } from "../../src/core/money.ts";
import { pointsFor } from "../../src/loyalty.ts";
import { discounted, small } from "./fixtures.ts";

test("loyalty: wholeUnits rounds toward zero", () => {
  assert.equal(wholeUnits(money(1999)), 19);
  assert.equal(wholeUnits(money(100)), 1);
  assert.equal(wholeUnits(money(-150)), -1);
});

test("loyalty: one point per whole unit of goods after the discount", () => {
  assert.equal(pointsFor(small()), 9);
  assert.equal(pointsFor(discounted()), 35);
  assert.equal(pointsFor({ ...small(), subtotal: money(-900) }), 0);
});
