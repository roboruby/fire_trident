import { CURRENCIES } from "../currencies.ts";
import type { Rounding } from "../rounding.ts";
import { round } from "../rounding.ts";

/**
 * Money in integer minor units (cents), so sums never pick up floating point error. Every amount carries its
 * currency, and arithmetic on two amounts in different currencies throws.
 */
export interface Money {
  readonly cents: number;
  readonly currency: string;
}

/** The currency an amount gets when none is named. */
export const DEFAULT_CURRENCY = "USD";

/** An amount of `cents` minor units in `currency`. Throws a RangeError for a fractional or non-finite amount. */
export function money(cents: number, currency: string = DEFAULT_CURRENCY): Money {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`money: ${cents} is not a whole number of cents`);
  return { cents: cents === 0 ? 0 : cents, currency };
}

/** Zero in `currency`. */
export function zero(currency: string = DEFAULT_CURRENCY): Money {
  return money(0, currency);
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new TypeError(`currency mismatch: ${a.currency} and ${b.currency}`);
}

/** a + b. */
export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.cents + b.cents, a.currency);
}

/** a - b, which may be negative. */
export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.cents - b.cents, a.currency);
}

/** -m. */
export function negate(m: Money): Money {
  return money(-m.cents, m.currency);
}

/** Is m below zero? */
export function isNegative(m: Money): boolean {
  return m.cents < 0;
}

/** Is m zero? */
export function isZero(m: Money): boolean {
  return m.cents === 0;
}

/** x rounded to a whole number, halves away from zero (2.5 is 3, -2.5 is -3). */
export function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** m times `factor`, rounded to whole cents with `rounding` (halves away from zero by default). */
export function multiply(m: Money, factor: number, rounding: Rounding = "half-away"): Money {
  return money(round(m.cents * factor, rounding), m.currency);
}

/** m times a whole number `n`, exactly. Throws a RangeError for any other n. */
export function times(m: Money, n: number): Money {
  if (!Number.isSafeInteger(n)) throw new RangeError(`times: ${n} is not a whole number`);
  return money(m.cents * n, m.currency);
}

/** `basisPoints` hundredths of a percent of m (725 is 7.25%, 10000 is 100%), rounded to whole cents (halves away from zero). */
export function percentOf(m: Money, basisPoints: number): Money {
  return money(roundHalfAway((m.cents * basisPoints) / 10000), m.currency);
}

/** m in `currency` at `rate`, rounded to whole cents (halves away from zero). Throws a RangeError for a rate that is not above 0. */
export function convert(m: Money, rate: number, currency: string): Money {
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError(`convert: ${rate} is not a rate`);
  return money(roundHalfAway(m.cents * rate), currency);
}

/** The smallest multiple of `step` cents at or above m. Throws a RangeError for a step that is not a whole number of at least 1. */
export function roundUp(m: Money, step: number): Money {
  if (!Number.isSafeInteger(step) || step < 1) throw new RangeError(`roundUp: ${step} is not a step`);
  return money(Math.ceil(m.cents / step) * step, m.currency);
}

/** Whole units of the currency, toward zero (1999 cents is 19). */
export function wholeUnits(m: Money): number {
  return Math.trunc(m.cents / 100);
}

/**
 * m split in proportion to `ratios`, in whole cents that add up to m exactly: each part gets the whole cents of its
 * share, and each leftover cent goes to the part with the largest remainder (ties to the earlier part). Throws a
 * RangeError for an empty list, a negative ratio, or ratios that sum to 0.
 */
export function allocate(m: Money, ratios: readonly number[]): Money[] {
  const total = ratios.reduce((s, r) => s + r, 0);
  if (ratios.length === 0 || ratios.some((r) => !(r >= 0)) || !(total > 0)) throw new RangeError("allocate: ratios must be non-negative and sum to more than 0");
  const exact = ratios.map((r) => (m.cents * r) / total);
  const parts = exact.map((x) => Math.floor(x));
  let left = m.cents - parts.reduce((s, p) => s + p, 0);
  const order = exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k]!.i]! += 1;
  return parts.map((c) => money(c, m.currency));
}

/** The sum of `amounts`; zero in `currency` for an empty list. Throws on mixed currencies. */
export function sum(amounts: readonly Money[], currency: string = DEFAULT_CURRENCY): Money {
  return amounts.reduce((total, m) => add(total, m), zero(amounts[0]?.currency ?? currency));
}

/** -1, 0 or 1 as a is less than, equal to or greater than b. Throws on mixed currencies. */
export function compare(a: Money, b: Money): number {
  sameCurrency(a, b);
  return Math.sign(a.cents - b.cents);
}

/** The larger of a and b. Throws a TypeError on mixed currencies. */
export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

/** The smaller of a and b. Throws a TypeError on mixed currencies. */
export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

/** The smallest and largest of `amounts`. Throws a RangeError for an empty list and a TypeError on mixed currencies. */
export function range(amounts: readonly Money[]): { low: Money; high: Money } {
  const first = amounts[0];
  if (first === undefined) throw new RangeError("range: no amounts");
  return amounts.reduce((r, m) => ({ low: min(r.low, m), high: max(r.high, m) }), { low: first, high: first });
}

/** What `amount` takes from `balance`: at most the balance, and what is left. Throws a TypeError on mixed currencies. */
export function takeUpTo(balance: Money, amount: Money): { taken: Money; left: Money } {
  const taken = min(balance, amount);
  return { taken, left: subtract(balance, taken) };
}

/** Do a and b hold the same amount in the same currency? */
export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.cents === b.cents;
}

/** Three upper-case letters A to Z, the shape of an ISO currency code. */
export function isCurrencyCode(code: string): boolean {
  return /^[A-Z]{3}$/.test(code);
}

/** How format() writes an amount. */
export interface FormatOptions {
  /** Write the currency's symbol (default true). */
  symbol?: boolean;
  /** Put a comma between thousands (default false). */
  grouping?: boolean;
}

/**
 * The amount with two decimals and its symbol: "$12.34", "-$0.50", "€3.00", or "12.34 CHF" for a currency with no
 * symbol. With `symbol` false, the number alone; with `grouping`, commas between thousands ("$1,234.56").
 */
export function format(m: Money, options: FormatOptions = {}): string {
  const sign = m.cents < 0 ? "-" : "";
  const abs = Math.abs(m.cents);
  const units = String(Math.floor(abs / 100));
  const whole = options.grouping ? units.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : units;
  const number = `${whole}.${String(abs % 100).padStart(2, "0")}`;
  if (options.symbol === false) return `${sign}${number}`;
  const s = CURRENCIES[m.currency]?.symbol;
  return s === undefined ? `${sign}${number} ${m.currency}` : `${sign}${s}${number}`;
}

/** How parse() reads an amount. */
export interface ParseOptions {
  /** The currency of an amount written without a symbol (default USD). */
  currency?: string;
}

const BY_SYMBOL: Readonly<Record<string, string>> = { $: "USD", "€": "EUR", "£": "GBP" };

/**
 * Parse "12.34", "-0.5", "7" or "$12.34" (at most two decimals; a leading $, € or £ names the currency). Throws a
 * SyntaxError for anything else, and for a symbol that disagrees with `options.currency`.
 */
export function parse(text: string, options: ParseOptions = {}): Money {
  const m = /^(-)?([$€£])?(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) throw new SyntaxError(`parse: "${text}" is not an amount`);
  const named = m[2] === undefined ? undefined : BY_SYMBOL[m[2]];
  if (named !== undefined && options.currency !== undefined && options.currency !== named) {
    throw new SyntaxError(`parse: "${text}" is in ${named}, not ${options.currency}`);
  }
  const cents = Number(m[3]) * 100 + Number((m[4] ?? "").padEnd(2, "0"));
  return money(m[1] ? -cents : cents, named ?? options.currency ?? DEFAULT_CURRENCY);
}
