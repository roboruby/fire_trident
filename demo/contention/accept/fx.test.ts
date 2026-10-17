import { test } from "node:test";
import assert from "node:assert/strict";
import { convert, money } from "../../src/core/money.ts";
import { convertInvoice } from "../../src/fx.ts";
import { discounted } from "./fixtures.ts";

test("fx: convert rounds halves away from zero into the new currency", () => {
  assert.deepEqual(convert(money(1000), 0.9, "EUR"), money(900, "EUR"));
  assert.deepEqual(convert(money(1), 0.5, "EUR"), money(1, "EUR"));
  assert.deepEqual(convert(money(-1), 0.5, "EUR"), money(-1, "EUR"));
  assert.throws(() => convert(money(1), 0, "EUR"), RangeError);
  assert.throws(() => convert(money(1), -2, "EUR"), RangeError);
  assert.throws(() => convert(money(1), Number.POSITIVE_INFINITY, "EUR"), RangeError);
});

test("fx: every amount of an invoice is converted on its own", () => {
  const inv = discounted();
  const eur = convertInvoice(inv, 0.5, "EUR");
  assert.equal(eur.currency, "EUR");
  assert.equal(eur.number, inv.number);
  assert.deepEqual(eur.lines.map((l) => [l.unit.cents, l.total.cents, l.unit.currency]), [[225, 450, "EUR"], [1500, 1500, "EUR"]]);
  assert.deepEqual(eur.subtotal, money(1950, "EUR"));
  assert.deepEqual(eur.discount, money(195, "EUR"));
  assert.deepEqual(eur.tax, money(127, "EUR"));
  assert.deepEqual(eur.shipping, money(300, "EUR"));
  assert.deepEqual(eur.total, money(2181, "EUR"));
});
