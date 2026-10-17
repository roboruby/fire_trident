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

/** The symbols format() writes before an amount; any other currency is written with its code after the amount. */
const SYMBOLS: Readonly<Record<string, string>> = { USD: "$", EUR: "€", GBP: "£" };

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

/** x rounded to a whole number, halves away from zero (2.5 is 3, -2.5 is -3). */
export function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** m times `factor`, rounded to whole cents (halves away from zero). */
export function multiply(m: Money, factor: number): Money {
  return money(roundHalfAway(m.cents * factor), m.currency);
}

/** `percent` percent of m (15 is 15%, 7.25 is 7.25%), rounded to whole cents (halves away from zero). */
export function percentOf(m: Money, percent: number): Money {
  return money(roundHalfAway((m.cents * percent) / 100), m.currency);
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

/** Do a and b hold the same amount in the same currency? */
export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.cents === b.cents;
}

/**
 * The amount with two decimals and its symbol: "$12.34", "-$0.50", "€3.00", or "12.34 CHF" for a currency with no
 * symbol. With `symbol` false, the number alone: "12.34", "-0.50".
 */
export function format(m: Money, symbol: boolean = true): string {
  const sign = m.cents < 0 ? "-" : "";
  const abs = Math.abs(m.cents);
  const number = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  if (!symbol) return `${sign}${number}`;
  const s = SYMBOLS[m.currency];
  return s === undefined ? `${sign}${number} ${m.currency}` : `${sign}${s}${number}`;
}

/** Parse "12.34", "-0.5" or "7" (at most two decimals) as an amount in `currency`. Throws a SyntaxError otherwise. */
export function parse(text: string, currency: string = DEFAULT_CURRENCY): Money {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) throw new SyntaxError(`parse: "${text}" is not an amount`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return money(m[1] ? -cents : cents, currency);
}
