import { test } from "node:test";
import assert from "node:assert/strict";
import { format, money } from "../../src/core/money.ts";
import { salesReport } from "../../src/report.ts";
import { discounted, small } from "./fixtures.ts";

test("format-options: symbol and grouping", () => {
  assert.equal(format(money(123456789), { grouping: true }), "$1,234,567.89");
  assert.equal(format(money(-123456), { symbol: false, grouping: true }), "-1,234.56");
  assert.equal(format(money(-5), { symbol: false }), "-0.05");
  assert.equal(format(money(123456), { symbol: false }), "1234.56");
  assert.equal(format(money(99, "EUR"), { grouping: true }), "€0.99");
});

test("format-options: the defaults do not change", () => {
  assert.equal(format(money(1234)), "$12.34");
  assert.equal(format(money(1234), {}), "$12.34");
  assert.equal(format(money(-50)), "-$0.50");
  assert.equal(format(money(1234, "CHF")), "12.34 CHF");
  assert.equal(format(money(123456)), "$1234.56");
});

test("format-options: the sales report is unchanged", () => {
  assert.equal(salesReport([small(), discounted()]), "INV-1 OR 14.99\nINV-2 CA 43.62\nTOTAL 58.61");
});
