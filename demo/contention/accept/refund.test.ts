import { test } from "node:test";
import assert from "node:assert/strict";
import { isNegative, money, negate } from "../../src/core/money.ts";
import { creditNote, isCreditNote } from "../../src/refund.ts";
import { discounted } from "./fixtures.ts";

test("refund: negate and isNegative", () => {
  assert.deepEqual(negate(money(250)), money(-250));
  assert.deepEqual(negate(money(-3, "EUR")), money(3, "EUR"));
  assert.ok(Object.is(negate(money(0)).cents, 0), "negate(money(0)) has cents 0, not -0");
  assert.equal(isNegative(money(-1)), true);
  assert.equal(isNegative(money(0)), false);
});

test("refund: a credit note negates every amount", () => {
  const inv = discounted();
  const cn = creditNote(inv, "CN-1");
  assert.equal(cn.number, "CN-1");
  assert.equal(cn.region, inv.region);
  assert.equal(cn.currency, inv.currency);
  assert.deepEqual(cn.lines.map((l) => [l.sku, l.quantity, l.unit.cents, l.total.cents]), [["TEA", 2, -450, -900], ["POT", 1, -2999, -2999]]);
  for (const k of ["subtotal", "discount", "tax", "shipping", "total"] as const) assert.equal(cn[k].cents, -inv[k].cents, k);
  assert.equal(isCreditNote(cn), true);
  assert.equal(isCreditNote(inv), false);
  assert.equal(inv.number, "INV-2");
});
