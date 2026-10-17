import { test } from "node:test";
import assert from "node:assert/strict";
import { isCurrencyCode, money } from "../../src/core/money.ts";
import { importPrices } from "../../src/import.ts";

test("import: isCurrencyCode", () => {
  assert.equal(isCurrencyCode("EUR"), true);
  assert.equal(isCurrencyCode("eur"), false);
  assert.equal(isCurrencyCode("EU"), false);
  assert.equal(isCurrencyCode("EURO"), false);
  assert.equal(isCurrencyCode("E1R"), false);
});

test("import: each line's price is in its own currency", () => {
  const prices = importPrices("# supplier list\nTEA,Green tea,4.50,EUR\n\nMUG,Mug,12,GBP\nPOT,Teapot,29.99,USD");
  assert.equal(prices.size, 3);
  assert.deepEqual(prices.get("TEA"), { sku: "TEA", name: "Green tea", price: money(450, "EUR") });
  assert.deepEqual(prices.get("MUG"), { sku: "MUG", name: "Mug", price: money(1200, "GBP") });
  assert.deepEqual(prices.get("POT")?.price, money(2999));
});

test("import: malformed lines are refused", () => {
  assert.throws(() => importPrices("TEA,Green tea,4.50"), SyntaxError);
  assert.throws(() => importPrices("TEA,Green tea,4.50,euro"), SyntaxError);
  assert.throws(() => importPrices("TEA,Green tea,cheap,EUR"), SyntaxError);
  assert.throws(() => importPrices("TEA,Green tea,1,EUR\nTEA,Black tea,2,EUR"), Error);
});
