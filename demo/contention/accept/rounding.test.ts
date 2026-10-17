import { test } from "node:test";
import assert from "node:assert/strict";
import { money, multiply } from "../../src/core/money.ts";
import { round } from "../../src/rounding.ts";

test("rounding: the four modes", () => {
  assert.equal(round(2.5, "half-away"), 3);
  assert.equal(round(-2.5, "half-away"), -3);
  assert.equal(round(2.5, "half-even"), 2);
  assert.equal(round(3.5, "half-even"), 4);
  assert.equal(round(-2.5, "half-even"), -2);
  assert.equal(round(2.6, "half-even"), 3);
  assert.equal(round(2.7, "down"), 2);
  assert.equal(round(-2.7, "down"), -2);
  assert.equal(round(2.1, "up"), 3);
  assert.equal(round(-2.1, "up"), -3);
});

test("rounding: multiply takes the mode and keeps its default", () => {
  assert.deepEqual(multiply(money(5), 0.5, "half-even"), money(2));
  assert.deepEqual(multiply(money(15), 0.5, "half-even"), money(8));
  assert.deepEqual(multiply(money(999), 0.5, "down"), money(499));
  assert.deepEqual(multiply(money(999), 0.5, "up"), money(500));
  assert.deepEqual(multiply(money(5), 0.5), money(3));
  assert.deepEqual(multiply(money(1999), 3), money(5997));
});
