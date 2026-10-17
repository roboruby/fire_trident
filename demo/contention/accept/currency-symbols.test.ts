import { test } from "node:test";
import assert from "node:assert/strict";
import { format, money } from "../../src/core/money.ts";
import { CURRENCIES, currencyName } from "../../src/currencies.ts";

test("currency-symbols: the table", () => {
  assert.deepEqual(Object.keys(CURRENCIES).sort(), ["EUR", "GBP", "INR", "JPY", "USD"]);
  assert.deepEqual(CURRENCIES.JPY, { symbol: "¥", name: "yen" });
  assert.equal(CURRENCIES.INR?.symbol, "₹");
  assert.equal(currencyName("GBP"), "pound sterling");
  assert.equal(currencyName("USD"), "US dollar");
  assert.equal(currencyName("CHF"), "CHF");
});

test("currency-symbols: format writes the new symbols and nothing else changes", () => {
  assert.equal(format(money(1234, "JPY")), "¥12.34");
  assert.equal(format(money(1234, "INR")), "₹12.34");
  assert.equal(format(money(-50, "JPY")), "-¥0.50");
  assert.equal(format(money(1234)), "$12.34");
  assert.equal(format(money(300, "EUR")), "€3.00");
  assert.equal(format(money(7, "GBP")), "£0.07");
  assert.equal(format(money(1234, "CHF")), "12.34 CHF");
});
