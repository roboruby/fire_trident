import { test } from "node:test";
import assert from "node:assert/strict";
import { money, range } from "../../src/core/money.ts";
import { parseCatalog } from "../../src/catalog.ts";
import { priceRange, priceRangeText } from "../../src/pricerange.ts";

test("price-range: range", () => {
  assert.deepEqual(range([money(450), money(2999), money(1200)]), { low: money(450), high: money(2999) });
  assert.deepEqual(range([money(7)]), { low: money(7), high: money(7) });
  assert.throws(() => range([]), RangeError);
  assert.throws(() => range([money(1), money(1, "EUR")]), TypeError);
});

test("price-range: the storefront's range text", () => {
  const catalog = parseCatalog("TEA,Green tea,4.50\nMUG,Mug,12\nPOT,Teapot,29.99");
  assert.deepEqual(priceRange(catalog), { low: money(450), high: money(2999) });
  assert.equal(priceRangeText(catalog), "from $4.50 to $29.99");
  assert.equal(priceRangeText(parseCatalog("TEA,Green tea,4.50\nCUP,Cup,4.50")), "$4.50");
  assert.throws(() => priceRange(new Map()), RangeError);
});
