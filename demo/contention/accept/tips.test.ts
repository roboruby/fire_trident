import { test } from "node:test";
import assert from "node:assert/strict";
import { money, roundUp } from "../../src/core/money.ts";
import { TIP_PERCENTS, roundedTotal, suggestTips } from "../../src/tip.ts";

test("tips: roundUp to a step", () => {
  assert.deepEqual(roundUp(money(1234), 100), money(1300));
  assert.deepEqual(roundUp(money(1300), 100), money(1300));
  assert.deepEqual(roundUp(money(1), 25), money(25));
  assert.throws(() => roundUp(money(1), 0), RangeError);
  assert.throws(() => roundUp(money(1), 2.5), RangeError);
});

test("tips: 15, 18 and 20 percent", () => {
  assert.deepEqual([...TIP_PERCENTS], [15, 18, 20]);
  const tips = suggestTips(money(5000));
  assert.deepEqual(tips.map((t) => t.percent), [15, 18, 20]);
  assert.deepEqual(tips.map((t) => t.tip), [money(750), money(900), money(1000)]);
  assert.deepEqual(tips.map((t) => t.withTip), [money(5750), money(5900), money(6000)]);
  assert.deepEqual(suggestTips(money(4321)).map((t) => t.tip.cents), [648, 778, 864]);
});

test("tips: the total with a tip, rounded up to a whole unit", () => {
  assert.deepEqual(roundedTotal(money(4321), 18), money(5100));
  assert.deepEqual(roundedTotal(money(5000), 20), money(6000));
});
