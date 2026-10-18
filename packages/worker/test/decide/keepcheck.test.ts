import { describe, expect, it } from "vitest";
import { checkLine, parseLine, type FileText } from "../../src/decide/keepcheck.ts";

/** Acceptance and keep lines FireTrident checks itself (decide/keepcheck.ts, FT_REVIEW_VIEW). */

/** The money module as an earlier landing left it: allocate and isZero landed, format still takes a boolean. */
const BEFORE = `export interface Money {
  readonly cents: number;
  readonly currency: string;
}

export const DEFAULT_CURRENCY = "USD";

export function money(cents: number, currency: string = DEFAULT_CURRENCY): Money {
  return { cents, currency };
}

/** m split in proportion to the ratios in whole cents. */
export function allocate(m: Money, ratios: readonly number[]): Money[] {
  if (ratios.length === 0) throw new RangeError("allocate: no ratios");
  const total = ratios.reduce((s, r) => s + r, 0);
  return ratios.map((r) => money(Math.floor((m.cents * r) / total), m.currency));
}

export function isZero(m: Money): boolean {
  return m.cents === 0;
}

export function multiply(m: Money, factor: number): Money {
  return money(Math.round(m.cents * factor), m.currency);
}

export function format(m: Money, symbol: boolean = true): string {
  return symbol ? \`$\${m.cents / 100}\` : \`\${m.cents / 100}\`;
}
`;

/** The same module after a format-options change done right. */
const AFTER = BEFORE.replace(
  "export function format(m: Money, symbol: boolean = true): string {\n  return symbol",
  "export interface FormatOptions {\n  symbol?: boolean;\n  grouping?: boolean;\n}\n\nexport function format(m: Money, options: FormatOptions = {}): string {\n  const symbol = options.symbol ?? true;\n  return symbol",
);

/** One line checked against texts after and before the change. */
function check(line: string, kind: "intent" | "keep", after: FileText, before: FileText = after) {
  const parsed = parseLine(line);
  if (!parsed) throw new Error(`not parsed: ${line}`);
  return checkLine(parsed, kind, after, before);
}

describe("parseLine", () => {
  // The acceptance lines of the contention workload (demo/contention/spec.md), as FireTrident reads them.
  const lines: Array<[string, null | { path: string; claims: string[]; whole: boolean }]> = [
    ["src/core/money.ts exports isZero(m: Money): boolean", { path: "src/core/money.ts", claims: ["function"], whole: true }],
    [
      "src/core/money.ts exports allocate(m: Money, ratios: readonly number[]): Money[]: m split in proportion to the ratios in whole cents, the parts adding up exactly to m",
      { path: "src/core/money.ts", claims: ["function"], whole: false },
    ],
    ["src/core/money.ts exports max(a: Money, b: Money): Money and min(a: Money, b: Money): Money, each throwing a TypeError for amounts in different currencies", { path: "src/core/money.ts", claims: ["function", "function"], whole: false }],
    ["src/core/money.ts exports negate(m: Money): Money (negate(money(0)) has cents 0, not -0) and isNegative(m: Money): boolean", { path: "src/core/money.ts", claims: ["function", "function"], whole: false }],
    [
      "src/core/money.ts exports interface FormatOptions { symbol?: boolean; grouping?: boolean } and format(m: Money, options: FormatOptions = {}): string; the boolean second parameter is gone",
      { path: "src/core/money.ts", claims: ["interface", "function"], whole: false },
    ],
    ["src/shipping.ts exports FREE_SHIPPING_OVER_CENTS = 7500 and shippingQuote(region: string, subtotal: Money): Money: zero in the subtotal's currency", { path: "src/shipping.ts", claims: ["value", "function"], whole: false }],
    ["src/tip.ts exports TIP_PERCENTS = [15, 18, 20] and suggestTips(total: Money): Array<{ percent: number; tip: Money; withTip: Money }>: one entry per percent", { path: "src/tip.ts", claims: ["value", "function"], whole: false }],
    ["src/rounding.ts exports type Rounding = \"half-away\" | \"half-even\" | \"down\" | \"up\" and round(x: number, mode: Rounding): number", { path: "src/rounding.ts", claims: ["type", "function"], whole: true }],
    ["src/giftcard.ts exports interface GiftCard { readonly code: string; readonly balance: Money } and redeem(card: GiftCard, due: Money): { card: GiftCard; paid: Money; due: Money }", { path: "src/giftcard.ts", claims: ["interface", "function"], whole: true }],
    ["src/currencies.ts exports CURRENCIES: Readonly<Record<string, { readonly symbol: string; readonly name: string }>> with exactly USD ($, US dollar)", { path: "src/currencies.ts", claims: ["typed"], whole: false }],
    ["percentOf(m: Money, basisPoints: number): Money in src/core/money.ts: m.cents times basisPoints over 10000", { path: "src/core/money.ts", claims: ["function"], whole: false }],
    ["multiply(m: Money, factor: number, rounding: Rounding = \"half-away\"): Money in src/core/money.ts rounds with round from src/rounding.ts", { path: "src/core/money.ts", claims: ["function"], whole: false }],
    ["src/fx.ts exists", { path: "src/fx.ts", claims: ["exists"], whole: true }],
    ["test/split.test.ts covers allocate and splitBill", null],
    ["allocate(money(100), [1, 1, 1]) is [money(34), money(33), money(33)]", null],
    ["shippingFor keeps its signature and behavior", null],
    ["src/report.ts calls format(amount, { symbol: false }); the output of salesReport does not change", null],
    ["src/tax.ts: TAX_RATES in basis points, { CA: 725, NY: 400, TX: 625, OR: 0 }", null],
    ["format in src/core/money.ts takes its symbols from CURRENCIES", null],
    ["src/x.ts exports nothing else", null],
  ];
  for (const [line, want] of lines) {
    it(`${want ? (want.whole ? "claims only" : "claims and more") : "no claims"}: ${line.slice(0, 70)}`, () => {
      const got = parseLine(line);
      if (!want) return expect(got).toBeNull();
      expect(got?.path).toBe(want.path);
      expect(got?.claims.map((c) => c.kind)).toEqual(want.claims);
      expect(got?.rest === "").toBe(want.whole);
    });
  }
});

describe("checkLine: a line of the change's own intent", () => {
  it("is met when every claim holds and they are the whole line", () => {
    expect(check("src/core/money.ts exports isZero(m: Money): boolean", "intent", AFTER)).toEqual({ state: "met", path: "src/core/money.ts", found: "isZero(m: Money): boolean", held: [] });
    expect(check("src/core/money.ts exports DEFAULT_CURRENCY = 'USD' and money(cents: number, currency?: string): Money", "intent", AFTER).state).toBe("met");
  });

  it("is not met, with the exact mismatch, when a claim does not hold", () => {
    const line = "src/core/money.ts exports interface FormatOptions { symbol?: boolean; grouping?: boolean } and format(m: Money, options: FormatOptions = {}): string; the boolean second parameter is gone";
    expect(check(line, "intent", BEFORE)).toEqual({
      state: "broken",
      path: "src/core/money.ts",
      found: "src/core/money.ts does not export FormatOptions; src/core/money.ts has format(m: Money, symbol: boolean = true): string, not format(m: Money, options: FormatOptions = {}): string",
      held: [],
    });
    expect(check("src/core/money.ts exports isNegative(m: Money): boolean", "intent", BEFORE).found).toBe("src/core/money.ts does not export isNegative");
    expect(check("multiply(m: Money, factor: number, rounding: Rounding = \"half-away\"): Money in src/core/money.ts rounds with round", "intent", BEFORE).found).toBe(
      'src/core/money.ts has multiply(m: Money, factor: number): Money, not multiply(m: Money, factor: number, rounding: Rounding = "half-away"): Money',
    );
    expect(check("src/latefee.ts exports LATE_FEE_PERCENT = 2", "intent", "export const LATE_FEE_PERCENT = 3;\n").found).toBe("LATE_FEE_PERCENT in src/latefee.ts is 3, not 2");
    expect(check('src/rounding.ts exports type Rounding = "half-away" | "down"', "intent", 'export type Rounding = "half-away" | "up";\n').state).toBe("broken");
    expect(check("src/fx.ts exists", "intent", null).found).toBe("src/fx.ts does not exist");
    expect(check("src/core/money.ts exports interface FormatOptions { symbol?: boolean; grouping?: boolean }", "intent", AFTER.replace("grouping?: boolean;", "grouping: boolean;")).found).toBe(
      "FormatOptions in src/core/money.ts has grouping: boolean, not grouping?: boolean",
    );
  });

  it("is open, with the parts that hold, when the line says more than its claims", () => {
    const line = "src/core/money.ts exports allocate(m: Money, ratios: readonly number[]): Money[]: m split in proportion to the ratios in whole cents";
    expect(check(line, "intent", AFTER)).toEqual({ state: "open", path: "src/core/money.ts", found: "", held: ["allocate(m: Money, ratios: readonly number[]): Money[]"] });
  });

  it("is open when a claim cannot be settled: an unannotated return, an imported type, a re-export, an unreadable or incomplete module, a plain word", () => {
    expect(check("src/core/money.ts exports isZero(m: Money): boolean", "intent", "export function isZero(m: Money) {\n  return m.cents === 0;\n}\n").state).toBe("open");
    expect(check("src/split.ts exports splitBill(invoice: Invoice, people: number): Money[]", "intent", "import type { Bill } from './bill.ts';\nexport function splitBill(invoice: Bill, people: number): Money[] {\n  return [];\n}\n").state).toBe("open");
    expect(check("src/core/money.ts exports isZero(m: Money): boolean", "intent", "export { isZero } from './zero.ts';\n").state).toBe("open");
    expect(check("src/core/money.ts exports isZero(m: Money): boolean", "intent", undefined).state).toBe("open");
    expect(check("src/core/money.ts exports isZero(m: Money): boolean", "intent", "export * from './zero.ts';\n").state).toBe("open");
    // A bare lowercase word could be prose: its absence proves nothing.
    expect(check("src/core/money.ts exports helpers", "intent", AFTER).state).toBe("open");
    expect(check("src/core/money.ts exports allocate", "intent", AFTER).state).toBe("met");
  });

  it("reads a parameter's type from its literal default, and ignores parameter names", () => {
    expect(check("src/core/money.ts exports format(m: Money, symbol?: boolean): string", "intent", BEFORE).state).toBe("met");
    expect(check("src/core/money.ts exports allocate(amount: Money, parts: ReadonlyArray<number>): Array<Money>", "intent", BEFORE).state).toBe("met");
  });
});

describe("checkLine: a keep line", () => {
  const keep = "src/core/money.ts exports isZero(m: Money): boolean";

  it("is met when it still holds after the change", () => {
    expect(check(keep, "keep", AFTER, BEFORE).state).toBe("met");
  });

  it("is broken only when it held before the change and does not after it", () => {
    const after = BEFORE.replace(/export function isZero[\s\S]*?\n}\n/, "");
    expect(check(keep, "keep", after, BEFORE)).toEqual({ state: "broken", path: "src/core/money.ts", found: "src/core/money.ts does not export isZero, though it held before this change", held: [] });
  });

  it("is stale, not broken, when it did not hold before the change either", () => {
    const without = BEFORE.replace(/export function isZero[\s\S]*?\n}\n/, "");
    expect(check(keep, "keep", without, without)).toEqual({ state: "stale", path: "src/core/money.ts", found: "src/core/money.ts does not export isZero", held: [] });
  });

  it("is open when what it was before cannot be read", () => {
    const after = BEFORE.replace(/export function isZero[\s\S]*?\n}\n/, "");
    expect(checkLine(parseLine(keep)!, "keep", after, undefined).state).toBe("open");
  });
});
