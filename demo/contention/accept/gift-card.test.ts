import { test } from "node:test";
import assert from "node:assert/strict";
import { money, takeUpTo } from "../../src/core/money.ts";
import { redeem } from "../../src/giftcard.ts";

test("gift-card: takeUpTo", () => {
  assert.deepEqual(takeUpTo(money(2500), money(4000)), { taken: money(2500), left: money(0) });
  assert.deepEqual(takeUpTo(money(2500), money(1000)), { taken: money(1000), left: money(1500) });
  assert.throws(() => takeUpTo(money(1), money(1, "EUR")), TypeError);
});

test("gift-card: redeem pays what the balance covers", () => {
  assert.deepEqual(redeem({ code: "G1", balance: money(2500) }, money(4000)), { card: { code: "G1", balance: money(0) }, paid: money(2500), due: money(1500) });
  assert.deepEqual(redeem({ code: "G1", balance: money(2500) }, money(1000)), { card: { code: "G1", balance: money(1500) }, paid: money(1000), due: money(0) });
});
