import { test } from "node:test";
import assert from "node:assert/strict";
import { money } from "../src/core/money.ts";
import { parseCatalog, product } from "../src/catalog.ts";

const TEXT = "# the shop\nTEA,Green tea,4.50\n\nMUG,Mug,12\nPOT, Teapot , 29.99\n";

test("parseCatalog reads SKU,Name,price lines", () => {
  const c = parseCatalog(TEXT);
  assert.equal(c.size, 3);
  assert.deepEqual(product(c, "TEA"), { sku: "TEA", name: "Green tea", price: money(450) });
  assert.deepEqual(product(c, "POT"), { sku: "POT", name: "Teapot", price: money(2999) });
});

test("parseCatalog prices in the catalog's currency", () => {
  const c = parseCatalog("TEA,Green tea,4.50", "EUR");
  assert.deepEqual(product(c, "TEA").price, money(450, "EUR"));
});

test("parseCatalog refuses malformed lines and repeated SKUs", () => {
  assert.throws(() => parseCatalog("TEA,Green tea"), SyntaxError);
  assert.throws(() => parseCatalog("TEA,Green tea,cheap"), SyntaxError);
  assert.throws(() => parseCatalog("TEA,Green tea,1\nTEA,Black tea,2"), /listed twice/);
  assert.throws(() => product(parseCatalog(TEXT), "NOPE"), RangeError);
});
