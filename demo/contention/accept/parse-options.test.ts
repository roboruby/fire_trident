import { test } from "node:test";
import assert from "node:assert/strict";
import { money, parse } from "../../src/core/money.ts";
import { parseCatalog, product } from "../../src/catalog.ts";

test("parse-options: a leading symbol names the currency", () => {
  assert.deepEqual(parse("$12.34"), money(1234));
  assert.deepEqual(parse("€3"), money(300, "EUR"));
  assert.deepEqual(parse("-£0.50"), money(-50, "GBP"));
  assert.deepEqual(parse("$1", { currency: "USD" }), money(100));
});

test("parse-options: the currency option", () => {
  assert.deepEqual(parse("12.34", { currency: "EUR" }), money(1234, "EUR"));
  assert.deepEqual(parse("12.34", {}), money(1234));
  assert.deepEqual(parse("12.34"), money(1234));
  assert.throws(() => parse("$1", { currency: "EUR" }), SyntaxError);
  assert.throws(() => parse("12.345"), SyntaxError);
});

test("parse-options: the catalog reads prices with or without a symbol", () => {
  assert.deepEqual(product(parseCatalog("TEA,Green tea,4.50", "EUR"), "TEA").price, money(450, "EUR"));
  assert.deepEqual(product(parseCatalog("TEA,Green tea,$4.50"), "TEA").price, money(450));
  assert.deepEqual(product(parseCatalog("TEA,Green tea,€4.50", "EUR"), "TEA").price, money(450, "EUR"));
  assert.throws(() => parseCatalog("TEA,Green tea,$4.50", "EUR"), SyntaxError);
});
