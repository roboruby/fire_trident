import { test } from "node:test";
import assert from "node:assert/strict";
import { add, compare, equals, format, money, multiply, parse, roundHalfAway, subtract, sum, zero } from "../src/core/money.ts";

test("money keeps whole cents and its currency", () => {
  assert.deepEqual(money(1234), { cents: 1234, currency: "USD" });
  assert.deepEqual(money(5, "EUR"), { cents: 5, currency: "EUR" });
  assert.throws(() => money(1.5), RangeError);
  assert.throws(() => money(Number.NaN), RangeError);
  assert.deepEqual(zero("GBP"), { cents: 0, currency: "GBP" });
});

test("add and subtract stay in one currency", () => {
  assert.deepEqual(add(money(150), money(275)), money(425));
  assert.deepEqual(subtract(money(100), money(250)), money(-150));
  assert.throws(() => add(money(1), money(1, "EUR")), TypeError);
  assert.throws(() => subtract(money(1, "EUR"), money(1)), TypeError);
});

test("multiply rounds halves away from zero", () => {
  assert.deepEqual(multiply(money(1999), 3), money(5997));
  assert.deepEqual(multiply(money(5), 0.5), money(3));
  assert.deepEqual(multiply(money(-5), 0.5), money(-3));
  assert.deepEqual(multiply(money(1000), 0.333), money(333));
  assert.equal(roundHalfAway(2.5), 3);
  assert.equal(roundHalfAway(-2.5), -3);
});

test("sum, compare and equals", () => {
  assert.deepEqual(sum([money(1), money(2), money(3)]), money(6));
  assert.deepEqual(sum([], "EUR"), money(0, "EUR"));
  assert.throws(() => sum([money(1), money(1, "EUR")]), TypeError);
  assert.equal(compare(money(1), money(2)), -1);
  assert.equal(compare(money(2), money(2)), 0);
  assert.equal(compare(money(3), money(2)), 1);
  assert.equal(equals(money(2), money(2)), true);
  assert.equal(equals(money(2), money(2, "EUR")), false);
});

test("format writes two decimals and the symbol", () => {
  assert.equal(format(money(1234)), "$12.34");
  assert.equal(format(money(-50)), "-$0.50");
  assert.equal(format(money(300, "EUR")), "€3.00");
  assert.equal(format(money(7, "GBP")), "£0.07");
  assert.equal(format(money(1234, "CHF")), "12.34 CHF");
});

test("parse reads at most two decimals", () => {
  assert.deepEqual(parse("12.34"), money(1234));
  assert.deepEqual(parse(" 7 "), money(700));
  assert.deepEqual(parse("-0.5"), money(-50));
  assert.deepEqual(parse("0"), money(0));
  assert.throws(() => parse("12.345"), SyntaxError);
  assert.throws(() => parse("abc"), SyntaxError);
});
