import { describe, expect, it } from "vitest";
import { normalizeType, readModule, readType, sameType, scanSource } from "../../src/decide/tsexports.ts";

/** The review view's TypeScript reader (decide/tsexports.ts): top-level exports as written, read from text alone. */

const MONEY = `/**
 * Money in integer cents. A comment with braces { and an export function fake(): void } is not code.
 */
export interface Money {
  readonly cents: number;
  readonly currency: string;
}

/** The currency an amount gets when none is named. */
export const DEFAULT_CURRENCY = "USD";

const SYMBOLS: Readonly<Record<string, string>> = { USD: "$", EUR: "€", GBP: "£" };

export function money(cents: number, currency: string = DEFAULT_CURRENCY): Money {
  if (!Number.isSafeInteger(cents)) throw new RangeError(\`money: \${cents} is not a whole number of cents\`);
  return { cents: cents === 0 ? 0 : cents, currency };
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new TypeError(\`currency mismatch: \${a.currency} and \${b.currency}\`);
}

export function allocate(m: Money, ratios: readonly number[]): Money[] {
  const total = ratios.reduce((s, r) => s + r, 0);
  if (ratios.length === 0 || total <= 0) throw new RangeError("allocate: ratios must sum above 0 { not a brace }");
  return ratios.map((r) => money(Math.floor((m.cents * r) / total), m.currency));
}

export function format(m: Money, symbol: boolean = true): string {
  const s = SYMBOLS[m.currency];
  return symbol && s ? \`\${s}\${m.cents / 100}\` : \`\${m.cents / 100}\`;
}

export function parse(text: string, currency: string = DEFAULT_CURRENCY): Money {
  const m = /^(-)?(\\d+)(?:\\.(\\d{1,2}))?$/.exec(text.trim());
  if (!m) throw new SyntaxError(\`parse: "\${text}" is not an amount\`);
  return money(Number(m[2]) * 100, currency);
}

export const isZero = (m: Money): boolean => m.cents === 0;

export function range(amounts: readonly Money[]): { low: Money; high: Money } {
  return { low: amounts[0]!, high: amounts[0]! };
}
`;

describe("scanSource", () => {
  it("blanks comments and hides strings, template literals and regular expressions, keeping every offset", () => {
    const { clean, mask, ok } = scanSource(MONEY);
    expect(ok).toBe(true);
    expect(clean.length).toBe(MONEY.length);
    expect(mask.length).toBe(MONEY.length);
    expect(clean).not.toContain("export function fake");
    expect(clean).toContain('"allocate: ratios must sum above 0 { not a brace }"');
    expect(mask).not.toContain("{ not a brace }");
    expect(mask).not.toContain("\\d{1,2}");
  });

  it("is not ok for an open comment, string or brace", () => {
    expect(scanSource("export function a() {\n").ok).toBe(false);
    expect(scanSource("/* open\nexport const a = 1;\n").ok).toBe(false);
    expect(scanSource('export const a = "open;\n').ok).toBe(false);
  });
});

describe("readModule", () => {
  const mod = readModule(MONEY);

  it("reads every export with its signature, and keeps local declarations apart", () => {
    expect(mod.complete).toBe(true);
    expect([...mod.exported.keys()].sort()).toEqual(["DEFAULT_CURRENCY", "Money", "allocate", "format", "isZero", "money", "parse", "range"]);
    expect(mod.exported.has("sameCurrency")).toBe(false);
    expect(mod.local.get("sameCurrency")?.[0]?.kind).toBe("function");
    expect(mod.local.get("SYMBOLS")?.[0]?.type).toBe("Readonly<Record<string, string>>");
    const allocate = mod.exported.get("allocate")![0]!;
    expect(allocate.signatures).toEqual([
      {
        typeParams: "",
        params: [
          { text: "m: Money", rest: false, optional: false, type: "Money" },
          { text: "ratios: readonly number[]", rest: false, optional: false, type: "readonly number[]" },
        ],
        returns: "Money[]",
        text: "allocate(m: Money, ratios: readonly number[]): Money[]",
      },
    ]);
    expect(mod.exported.get("format")![0]!.signatures[0]!.params[1]).toEqual({ text: "symbol: boolean = true", rest: false, optional: true, type: "boolean" });
    expect(mod.exported.get("range")![0]!.signatures[0]!.returns).toBe("{ low: Money; high: Money }");
    expect(mod.exported.get("isZero")![0]).toMatchObject({ kind: "const", signatures: [{ returns: "boolean", text: "isZero(m: Money): boolean" }] });
    expect(mod.exported.get("DEFAULT_CURRENCY")![0]).toMatchObject({ kind: "const", value: '"USD"' });
    expect(mod.exported.get("Money")![0]!.members).toEqual([
      { name: "cents", optional: false, type: "number" },
      { name: "currency", optional: false, type: "string" },
    ]);
  });

  it("reads overloads as one function, export lists, aliases and type aliases", () => {
    const m = readModule(
      [
        "export function pick(a: string): string;",
        "export function pick(a: number): number;",
        "export function pick(a: string | number): string | number {",
        "  return a;",
        "}",
        "function inner(x: number): number { return x; }",
        "const helper = (s: string): string => s.trim();",
        "export { inner as outer, helper };",
        "export { thing } from './other.ts';",
        'export type Rounding = "half-away" | "down";',
        "export type Options = { symbol?: boolean, grouping?: boolean };",
        "export interface Child extends Money { extra: string }",
        "export const LIMITS = [1, 2, 3] as const, MAX = 10;",
        "export enum Color { Red }",
        "export class Box { open(): void {} }",
      ].join("\n"),
    );
    expect(m.complete).toBe(true);
    expect(m.exported.get("pick")![0]!.signatures.map((s) => s.text)).toEqual(["pick(a: string): string", "pick(a: number): number", "pick(a: string | number): string | number"]);
    expect(m.exported.get("outer")![0]!.signatures[0]!.text).toBe("inner(x: number): number");
    expect(m.exported.get("helper")![0]!.signatures[0]!.returns).toBe("string");
    expect(m.exported.get("thing")![0]!.kind).toBe("reexport");
    expect(m.exported.get("Rounding")![0]).toMatchObject({ kind: "type", type: '"half-away" | "down"' });
    expect(m.exported.get("Options")![0]!.members).toEqual([
      { name: "symbol", optional: true, type: "boolean" },
      { name: "grouping", optional: true, type: "boolean" },
    ]);
    expect(m.exported.get("Child")![0]).toMatchObject({ kind: "interface", inherits: true });
    expect(m.exported.get("LIMITS")![0]!.value).toBe("[1, 2, 3] as const");
    expect(m.exported.get("MAX")![0]!.value).toBe("10");
    expect(m.exported.get("Color")![0]!.kind).toBe("enum");
    expect(m.exported.get("Box")![0]!.kind).toBe("class");
  });

  it("says it is incomplete when some export cannot be enumerated", () => {
    expect(readModule("export * from './all.ts';\nexport const a = 1;\n").complete).toBe(false);
    expect(readModule("export const { a, b } = make();\n").complete).toBe(false);
    expect(readModule("module.exports = { a: 1 };\n").complete).toBe(false);
    expect(readModule("export function a() {\n").complete).toBe(false);
    // Re-exporting a whole module under a name is one known name.
    const ns = readModule("export * as money from './money.ts';\n");
    expect(ns.complete).toBe(true);
    expect(ns.exported.get("money")![0]!.kind).toBe("reexport");
  });

  it("finds a statement after one without a semicolon, and generic commas do not split a declarator", () => {
    const m = readModule("export const cache = new Map<string, number>()\nexport function f(x: number): number {\n  return x\n}\n");
    expect([...m.exported.keys()]).toEqual(["cache", "f"]);
    expect(m.exported.get("cache")![0]!.value).toBe("new Map<string, number>()");
  });
});

describe("types as text", () => {
  it("reads a type to its end and no further", () => {
    const s = "Money[]: m split in proportion";
    expect(s.slice(0, readType(s, 0))).toBe("Money[]");
    const t = "{ low: Money; high: Money } over the catalog's prices";
    expect(t.slice(0, readType(t, 0))).toBe("{ low: Money; high: Money }");
    const u = '"half-away" | "half-even" | "down" and round(x: number)';
    expect(u.slice(0, readType(u, 0))).toBe('"half-away" | "half-even" | "down"');
    const v = "Array<{ percent: number; tip: Money }>: one entry";
    expect(v.slice(0, readType(v, 0))).toBe("Array<{ percent: number; tip: Money }>");
    const w = "(a: number) => string, then";
    expect(w.slice(0, readType(w, 0))).toBe("(a: number) => string");
  });

  it("normalizes spacing, quotes, member separators, arrays and union order", () => {
    expect(normalizeType("readonly  number [ ]")).toBe("readonly number[]");
    expect(normalizeType("ReadonlyArray<number>")).toBe("readonly number[]");
    expect(normalizeType("Array<Money>")).toBe("Money[]");
    expect(normalizeType("{ low: Money, high: Money, }")).toBe("{low:Money;high:Money}");
    expect(normalizeType("{ low: Money; high: Money; }")).toBe("{low:Money;high:Money}");
    expect(normalizeType("'b' | \"a\"")).toBe('"a"|"b"');
    expect(normalizeType("Map<string, Money>")).toBe("Map<string,Money>");
    expect(normalizeType("true | false | null")).toBe("boolean|null");
  });

  it("compares as the same, different only when sure, and unknown otherwise", () => {
    const mod = readModule("export interface Money { cents: number }\nexport interface FormatOptions { symbol?: boolean }\ntype Ratios = readonly number[];\nimport type { Invoice } from './invoice.ts';\n");
    expect(sameType("readonly number[]", "ReadonlyArray<number>", mod)).toBe("same");
    expect(sameType("Ratios", "readonly number[]", mod)).toBe("same");
    expect(sameType("boolean", "FormatOptions", mod)).toBe("differs");
    expect(sameType("Money[]", "readonly Money[]", mod)).toBe("differs");
    expect(sameType("string", "number", mod)).toBe("differs");
    // A name the module only imports could be anything: not sure. One it neither declares nor imports cannot be boolean there.
    expect(sameType("Invoice", "Money", mod)).toBe("unknown");
    expect(sameType("ParseOptions", "string", mod)).toBe("differs");
    expect(mod.imported).toEqual(new Set(["Invoice"]));
    expect(readModule("import money, { add as plus, type Money } from './m.ts';\nimport * as fx from './fx.ts';\nimport './side.ts';\n").imported).toEqual(new Set(["plus", "Money", "money", "fx"]));
    expect(sameType("{ a: number }", "{ a: string }", mod)).toBe("unknown");
  });
});
