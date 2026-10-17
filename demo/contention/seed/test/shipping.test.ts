import { test } from "node:test";
import assert from "node:assert/strict";
import { money } from "../src/core/money.ts";
import { shippingFor } from "../src/shipping.ts";

test("flat shipping by region", () => {
  assert.deepEqual(shippingFor("CA"), money(599));
  assert.deepEqual(shippingFor("NY"), money(699));
  assert.deepEqual(shippingFor("TX", "EUR"), money(649, "EUR"));
  assert.throws(() => shippingFor("ZZ"), RangeError);
});
