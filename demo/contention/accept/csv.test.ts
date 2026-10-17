import { test } from "node:test";
import assert from "node:assert/strict";
import { isZero, money } from "../../src/core/money.ts";
import { invoiceCsv } from "../../src/csv.ts";
import { discounted, small } from "./fixtures.ts";

test("csv: isZero", () => {
  assert.equal(isZero(money(0)), true);
  assert.equal(isZero(money(0, "EUR")), true);
  assert.equal(isZero(money(1)), false);
  assert.equal(isZero(money(-1)), false);
});

test("csv: an invoice without a discount", () => {
  assert.equal(invoiceCsv(small()), "sku,name,quantity,unit,total\nTEA,Green tea,2,4.50,9.00\nsubtotal,,,,9.00\ntax,,,,0.00\nshipping,,,,5.99\ntotal,,,,14.99");
});

test("csv: an invoice with a discount", () => {
  assert.equal(
    invoiceCsv(discounted()),
    "sku,name,quantity,unit,total\nTEA,Green tea,2,4.50,9.00\nPOT,Teapot,1,29.99,29.99\nsubtotal,,,,38.99\ndiscount,,,,3.90\ntax,,,,2.54\nshipping,,,,5.99\ntotal,,,,43.62",
  );
});
