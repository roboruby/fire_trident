# tally: sixteen intents on one shared module

This is the contention smoke test's workload (`scripts/contention.rb`). The Hono run was lint-rule fixes, one file per
intent, embarrassingly parallel and trivially provable. Here every intent must change the same file,
`src/core/money.ts`, as well as its own, so agents genuinely contend on it, and three intents change a signature in it
that other intents were built on.

## The project

`seed/` is the project as it stands before the run: the money core of a small shop's checkout, 20 files of TypeScript
that Node 24 runs directly with nothing installed. `src/core/money.ts` holds `Money` (integer cents and a currency),
its arithmetic, `percentOf`, `format` and `parse`; the catalog, cart, discount, tax, shipping, invoice and report
modules all import it. Its node:test suite (23 tests in `test/`, one file per module) is green. The script lands the
seed as it is, in path order, before any agent starts, so every run starts from the same trunk.

## Conventions

- Erasable TypeScript only: no `enum`, no `namespace`, no constructor parameter properties. Node strips the types and
  runs the file, with nothing installed and no build step.
- Relative imports name the `.ts` file (`import { add } from "./core/money.ts"`). Import types with `import type`.
- Amounts are `Money` from `src/core/money.ts`: integer cents and a currency. Build them with `money(cents, currency)`
  and do arithmetic with the module's functions, never on floats.
- Tests use `node:test` and `node:assert/strict` and live in `test/<name>.test.ts`; `node --test` runs them all.
  Compare amounts with `assert.deepEqual(actual, money(...))`.
- Every existing test must keep passing. When a function in `src/core/money.ts` changes, every caller and test of it
  must keep working; a function this intent does not mention keeps its signature and behavior.

## The intents

Every intent writes `src/core/money.ts` first, then its own module, then its own test file, and carries acceptance
lines that name the exact exports and expected values. All are declared by a person at once with equal priority.

| Intent | Own files | What it does to `src/core/money.ts` |
| --- | --- | --- |
| split | `src/split.ts` | adds `allocate` |
| free-shipping | `src/shipping.ts` (existing) | adds `max` and `min` |
| refund | `src/refund.ts` | adds `negate` and `isNegative` |
| fx | `src/fx.ts` | adds `convert` |
| format-options | `src/report.ts` (existing) | changes the signature of `format`: a boolean becomes an options object |
| csv | `src/csv.ts` | adds `isZero`; calls `format` without a symbol |
| parse-options | `src/catalog.ts` (existing) | changes the signature of `parse`: a currency string becomes an options object |
| import | `src/import.ts` | adds `isCurrencyCode`; calls `parse` with a currency |
| basis-points | `src/discount.ts`, `src/tax.ts` (existing) | changes the units of `percentOf`: percent becomes basis points |
| tips | `src/tip.ts` | adds `roundUp`; calls `percentOf` with 15, 18 and 20 percent |
| late-fee | `src/latefee.ts` | adds `times`; calls `percentOf` with 2 percent |
| loyalty | `src/loyalty.ts` | adds `wholeUnits` |
| gift-card | `src/giftcard.ts` | adds `takeUpTo` |
| currency-symbols | `src/currencies.ts` | changes `format` to read its symbols from a new table |
| rounding | `src/rounding.ts` | adds a rounding mode parameter to `multiply` |
| price-range | `src/pricerange.ts` | adds `range` |

Three kinds of contention follow. Sixteen changes to one file: whichever lands first moves the file under the other
fifteen. Overlapping edits: format-options and currency-symbols both rewrite the body of `format`. And four designed
semantic-conflict pairs, where a change built on the old signature still reads well against the new one and is
silently wrong:

| First | Second, built on the old signature | The second's call | What it does after the first lands |
| --- | --- | --- | --- |
| format-options | csv | `format(m, false)` | `false` is read as options: the symbol comes back ("$9.00") |
| parse-options | import | `parse(price, currency)` | the string is read as options: every price is in USD |
| basis-points | tips | `percentOf(total, 15)` | 15 basis points: a tip of 0.15% |
| basis-points | late-fee | `percentOf(invoice.total, 2)` | 2 basis points: a fee of 0.02% |

None of them fails to load, and nothing type-checks on the way in, so only tests can catch them: the second intent's
own test when certification runs it after the landing, and the hidden tests below. (A type check would catch the first
two, a boolean or a string where an options object is expected, but not the two units changes.)

## The tests a person wrote

Each intent has an acceptance test a person wrote, in `accept/<intent>.test.ts` (with `accept/fixtures.ts`). Agents
never see them: they are not in the seed, not in any intent, and not in the colony while agents work. Agents get the
acceptance lines, which name every export and expected value the hidden test checks, and write their own test file.
During the run, certification runs the seed's tests and the agents' tests on trunk after landings. After the run, with
the agents stopped, the script lands the hidden tests as `test/accept/` in one change (review off for that change only)
and reads which of them the colony's certification passes: that is the grade.

`reference/` is one person's solution to all sixteen intents together, never shown to agents. The script's tests check
that the seed's suite passes, that every hidden test file fails on the bare seed, that the seed with the reference
passes all 62 tests, and that each designed pair is real: the reference's second file with the old call fails its
hidden test with an assertion, not a load error.

## Machine-readable spec

`scripts/contention.rb` reads this block. `context` names the sections every intent carries in its why as spec context.

```json firetrident-contention
{
  "name": "tally",
  "shared": "src/core/money.ts",
  "priority": 3,
  "context": ["Conventions"],
  "rules": [
    {
      "kind": "forbid-import",
      "description": "Relative imports name the .ts file",
      "spec": {
        "from": ["src/**", "test/**"],
        "module": "^\\.\\.?/(?!.*\\.ts$)",
        "hint": "Write relative imports with the .ts extension, e.g. import { add } from \"./core/money.ts\". Node runs these files directly and does not guess extensions."
      }
    }
  ],
  "intents": [
    {
      "id": "split",
      "title": "Split a bill evenly between people",
      "why": "Groups paying together want the total split so that the shares add up to the cent.",
      "footprint": ["src/core/money.ts", "src/split.ts", "test/split.test.ts"],
      "uses": ["src/invoice.ts"],
      "acceptance": [
        "src/core/money.ts exports allocate(m: Money, ratios: readonly number[]): Money[]: m split in proportion to the ratios in whole cents, the parts adding up exactly to m; each part gets the whole cents of its share, and each leftover cent goes to the part with the largest remainder (ties to the earlier part)",
        "allocate(money(100), [1, 1, 1]) is [money(34), money(33), money(33)]; allocate(money(1000), [70, 30]) is [money(700), money(300)]; allocate(money(5), [1, 1]) is [money(3), money(2)]",
        "allocate throws a RangeError for an empty list, a negative ratio, or ratios that sum to 0",
        "src/split.ts exports splitBill(invoice: Invoice, people: number): Money[]: the invoice total in equal shares with allocate; a RangeError when people is not a whole number of at least 1",
        "test/split.test.ts covers allocate and splitBill"
      ]
    },
    {
      "id": "free-shipping",
      "title": "Free shipping on orders of $75 or more",
      "why": "Orders of 75.00 or more ship free, to lift the average order.",
      "footprint": ["src/core/money.ts", "src/shipping.ts", "test/free-shipping.test.ts"],
      "acceptance": [
        "src/core/money.ts exports max(a: Money, b: Money): Money and min(a: Money, b: Money): Money, each throwing a TypeError for amounts in different currencies",
        "src/shipping.ts exports FREE_SHIPPING_OVER_CENTS = 7500 and shippingQuote(region: string, subtotal: Money): Money: zero in the subtotal's currency when the subtotal is at least 75.00, otherwise shippingFor(region, subtotal.currency); a RangeError for a region the shop does not ship to, whatever the subtotal",
        "shippingQuote(\"CA\", money(7500)) is money(0); shippingQuote(\"CA\", money(7499)) is money(599); shippingQuote(\"NY\", money(9000, \"EUR\")) is money(0, \"EUR\")",
        "shippingFor keeps its signature and behavior",
        "test/free-shipping.test.ts covers max, min and shippingQuote"
      ]
    },
    {
      "id": "refund",
      "title": "Credit notes for refunds",
      "why": "A refund is issued as a credit note: the invoice with every amount negated.",
      "footprint": ["src/core/money.ts", "src/refund.ts", "test/refund.test.ts"],
      "uses": ["src/invoice.ts"],
      "acceptance": [
        "src/core/money.ts exports negate(m: Money): Money (negate(money(0)) has cents 0, not -0) and isNegative(m: Money): boolean",
        "src/refund.ts exports creditNote(invoice: Invoice, number: string): Invoice: the same invoice under the new number with every amount negated (each line's unit and total, subtotal, discount, tax, shipping and total); quantities, region and currency stay as they are, and the invoice passed in is not changed",
        "src/refund.ts exports isCreditNote(invoice: Invoice): boolean, true when the total is negative",
        "test/refund.test.ts covers negate, isNegative, creditNote and isCreditNote"
      ]
    },
    {
      "id": "fx",
      "title": "Invoices in another currency",
      "why": "Customers abroad want their invoice in their own currency at a quoted rate.",
      "footprint": ["src/core/money.ts", "src/fx.ts", "test/fx.test.ts"],
      "uses": ["src/invoice.ts"],
      "acceptance": [
        "src/core/money.ts exports convert(m: Money, rate: number, currency: string): Money: m.cents times rate, rounded to whole cents with halves away from zero, in currency; a RangeError for a rate that is not a finite number above 0",
        "convert(money(1000), 0.9, \"EUR\") is money(900, \"EUR\"); convert(money(1), 0.5, \"EUR\") is money(1, \"EUR\"); convert(money(-1), 0.5, \"EUR\") is money(-1, \"EUR\")",
        "src/fx.ts exports convertInvoice(invoice: Invoice, rate: number, currency: string): Invoice: every amount (each line's unit and total, subtotal, discount, tax, shipping, total) converted on its own with convert, and the invoice's currency set to currency",
        "test/fx.test.ts covers convert and convertInvoice"
      ]
    },
    {
      "id": "format-options",
      "title": "format takes an options object",
      "why": "Reports need thousands separators, and a bare boolean argument does not say what it means: format(m, false) becomes format(m, { symbol: false }).",
      "footprint": ["src/core/money.ts", "src/report.ts", "test/format-options.test.ts"],
      "change": "signature",
      "acceptance": [
        "src/core/money.ts exports interface FormatOptions { symbol?: boolean; grouping?: boolean } and format(m: Money, options: FormatOptions = {}): string; the boolean second parameter is gone",
        "symbol (default true) writes the symbol as before; grouping (default false) puts a comma between thousands: format(money(123456789), { grouping: true }) is \"$1,234,567.89\" and format(money(-123456), { symbol: false, grouping: true }) is \"-1,234.56\"",
        "format(money(1234)) is still \"$12.34\", format(money(-5), { symbol: false }) is \"-0.05\", and format(money(1234, \"CHF\")) is still \"12.34 CHF\"",
        "src/report.ts calls format(amount, { symbol: false }); the output of salesReport does not change",
        "test/format-options.test.ts covers both options"
      ]
    },
    {
      "id": "csv",
      "title": "CSV export of an invoice",
      "why": "Accounting imports invoices as CSV.",
      "footprint": ["src/core/money.ts", "src/csv.ts", "test/csv.test.ts"],
      "uses": ["src/invoice.ts"],
      "acceptance": [
        "src/core/money.ts exports isZero(m: Money): boolean",
        "src/csv.ts exports invoiceCsv(invoice: Invoice): string: the header sku,name,quantity,unit,total, one row per invoice line, then the rows subtotal, discount (left out when the discount is zero, checked with isZero), tax, shipping and total, each written label,,,,amount",
        "every amount is written with format from src/core/money.ts without the currency symbol (9.00, not $9.00); rows are joined with \\n with no trailing newline; names are written as they are",
        "for an invoice of 2 TEA (name Green tea, 4.50 each) shipped to OR the CSV is sku,name,quantity,unit,total / TEA,Green tea,2,4.50,9.00 / subtotal,,,,9.00 / tax,,,,0.00 / shipping,,,,5.99 / total,,,,14.99 (the slashes stand for \\n)",
        "test/csv.test.ts covers invoiceCsv with and without a discount"
      ]
    },
    {
      "id": "parse-options",
      "title": "parse takes an options object and reads currency symbols",
      "why": "Price lists arrive as \"$12.99\" or \"€4\", and a bare string argument does not say what it means: parse(text, currency) becomes parse(text, { currency }).",
      "footprint": ["src/core/money.ts", "src/catalog.ts", "test/parse-options.test.ts"],
      "change": "signature",
      "acceptance": [
        "src/core/money.ts exports interface ParseOptions { currency?: string } and parse(text: string, options: ParseOptions = {}): Money; the string second parameter is gone",
        "a $, € or £ written before the digits (after a minus sign, if any) names the currency USD, EUR or GBP: parse(\"$12.34\") is money(1234), parse(\"€3\") is money(300, \"EUR\"), parse(\"-£0.50\") is money(-50, \"GBP\")",
        "options.currency is the currency of an amount written without a symbol (USD when absent): parse(\"12.34\", { currency: \"EUR\" }) is money(1234, \"EUR\"); a symbol that names another currency than options.currency is a SyntaxError, as in parse(\"$1\", { currency: \"EUR\" })",
        "src/catalog.ts calls parse(price, { currency }); parseCatalog keeps its signature, and its prices may now carry a symbol",
        "test/parse-options.test.ts covers symbols and the currency option"
      ]
    },
    {
      "id": "import",
      "title": "Price list import with a currency per line",
      "why": "Suppliers send price lists with a currency column.",
      "footprint": ["src/core/money.ts", "src/import.ts", "test/import.test.ts"],
      "uses": ["src/catalog.ts"],
      "acceptance": [
        "src/core/money.ts exports isCurrencyCode(code: string): boolean: true for exactly three upper-case letters A to Z",
        "src/import.ts exports importPrices(text: string): Map<string, Product>: lines SKU,Name,price,CUR (blank lines and lines starting with # skipped), each price read with parse from src/core/money.ts in that line's currency",
        "importPrices throws a SyntaxError for a line without four fields, a currency that fails isCurrencyCode or a price that does not parse, and an Error for a SKU listed twice",
        "importPrices(\"TEA,Green tea,4.50,EUR\\nMUG,Mug,12,GBP\") maps TEA to { sku: \"TEA\", name: \"Green tea\", price: money(450, \"EUR\") } and MUG to a price of money(1200, \"GBP\")",
        "test/import.test.ts covers importPrices and isCurrencyCode"
      ]
    },
    {
      "id": "basis-points",
      "title": "Rates in basis points",
      "why": "Rates read from configuration should be whole numbers: percentOf takes basis points (hundredths of a percent) instead of percent, so 7.25% is 725.",
      "footprint": ["src/core/money.ts", "src/discount.ts", "src/tax.ts", "test/basis-points.test.ts"],
      "change": "signature",
      "acceptance": [
        "percentOf(m: Money, basisPoints: number): Money in src/core/money.ts: m.cents times basisPoints over 10000, rounded to whole cents with halves away from zero (10000 is 100%): percentOf(money(10000), 725) is money(725), percentOf(money(2000), 1500) is money(300)",
        "src/tax.ts: TAX_RATES in basis points, { CA: 725, NY: 400, TX: 625, OR: 0 }; taxFor gives the same results as before",
        "src/discount.ts: a percent discount keeps percent in whole percents (15 is 15%) and passes percent * 100 to percentOf; discountAmount and applyDiscount give the same results as before",
        "test/basis-points.test.ts covers percentOf in basis points"
      ]
    },
    {
      "id": "tips",
      "title": "Tip suggestions",
      "why": "The checkout suggests a tip of 15, 18 or 20 percent.",
      "footprint": ["src/core/money.ts", "src/tip.ts", "test/tip.test.ts"],
      "acceptance": [
        "src/core/money.ts exports roundUp(m: Money, step: number): Money: the smallest multiple of step cents at or above m; a RangeError when step is not a whole number of at least 1: roundUp(money(1234), 100) is money(1300), roundUp(money(1300), 100) is money(1300)",
        "src/tip.ts exports TIP_PERCENTS = [15, 18, 20] and suggestTips(total: Money): Array<{ percent: number; tip: Money; withTip: Money }>: one entry per percent in that order, the tip computed with percentOf from src/core/money.ts",
        "suggestTips(money(5000)) has the tips money(750), money(900) and money(1000), and withTip money(5750), money(5900) and money(6000)",
        "src/tip.ts exports roundedTotal(total: Money, percent: number): Money: the total plus its tip, rounded up to a whole unit with roundUp(..., 100): roundedTotal(money(4321), 18) is money(5100)",
        "test/tip.test.ts covers roundUp, suggestTips and roundedTotal"
      ]
    },
    {
      "id": "late-fee",
      "title": "Late fees on overdue invoices",
      "why": "An overdue invoice owes 2 percent of its total for every started 30 days late.",
      "footprint": ["src/core/money.ts", "src/latefee.ts", "test/latefee.test.ts"],
      "uses": ["src/invoice.ts"],
      "acceptance": [
        "src/core/money.ts exports times(m: Money, n: number): Money: m times a whole number n, exactly; a RangeError when n is not a whole number",
        "src/latefee.ts exports LATE_FEE_PERCENT = 2 and lateFee(invoice: Invoice, daysLate: number): Money: LATE_FEE_PERCENT percent of the invoice total (with percentOf from src/core/money.ts) times the started 30-day periods (with times), and zero in the invoice's currency when daysLate is 0 or less",
        "for an invoice total of money(10000): 1 day late is money(200), 30 days money(200), 31 days money(400), 0 days money(0)",
        "test/latefee.test.ts covers times and lateFee"
      ]
    },
    {
      "id": "loyalty",
      "title": "Loyalty points",
      "why": "Customers earn one point per whole unit of currency spent on goods.",
      "footprint": ["src/core/money.ts", "src/loyalty.ts", "test/loyalty.test.ts"],
      "uses": ["src/invoice.ts"],
      "acceptance": [
        "src/core/money.ts exports wholeUnits(m: Money): number: the whole units of currency, toward zero: wholeUnits(money(1999)) is 19, wholeUnits(money(-150)) is -1",
        "src/loyalty.ts exports pointsFor(invoice: Invoice): number: wholeUnits of the subtotal minus the discount (tax and shipping earn nothing), and 0 when that is negative",
        "test/loyalty.test.ts covers wholeUnits and pointsFor"
      ]
    },
    {
      "id": "gift-card",
      "title": "Gift card payments",
      "why": "A gift card pays as much of an order as its balance covers.",
      "footprint": ["src/core/money.ts", "src/giftcard.ts", "test/giftcard.test.ts"],
      "acceptance": [
        "src/core/money.ts exports takeUpTo(balance: Money, amount: Money): { taken: Money; left: Money }: taken is the smaller of the two, left is balance minus taken; a TypeError for different currencies",
        "src/giftcard.ts exports interface GiftCard { readonly code: string; readonly balance: Money } and redeem(card: GiftCard, due: Money): { card: GiftCard; paid: Money; due: Money }: the card pays with takeUpTo; the returned card keeps its code with the balance left, and due is what remains to pay",
        "redeem({ code: \"G1\", balance: money(2500) }, money(4000)) pays money(2500), leaves the card at money(0) and money(1500) due; with money(1000) due it pays money(1000), leaves money(1500) and money(0) due",
        "test/giftcard.test.ts covers takeUpTo and redeem"
      ]
    },
    {
      "id": "currency-symbols",
      "title": "Symbols for more currencies",
      "why": "The shop sells in yen and rupees; format should know every symbol from one table.",
      "footprint": ["src/core/money.ts", "src/currencies.ts", "test/currencies.test.ts"],
      "change": "behavior",
      "acceptance": [
        "src/currencies.ts exports CURRENCIES: Readonly<Record<string, { readonly symbol: string; readonly name: string }>> with exactly USD ($, US dollar), EUR (€, euro), GBP (£, pound sterling), JPY (¥, yen) and INR (₹, Indian rupee), and currencyName(code: string): string, the name or the code itself when it is not listed",
        "format in src/core/money.ts takes its symbols from CURRENCIES (its own symbol table goes): format(money(1234, \"JPY\")) is \"¥12.34\" and format(money(1234, \"INR\")) is \"₹12.34\"; a currency not listed is still written \"12.34 CHF\", and every other output of format stays the same",
        "test/currencies.test.ts covers CURRENCIES, currencyName and the new symbols"
      ]
    },
    {
      "id": "rounding",
      "title": "Rounding modes for multiply",
      "why": "Some prices round halves to even (banker's rounding) or always down; multiply should take the mode.",
      "footprint": ["src/core/money.ts", "src/rounding.ts", "test/rounding.test.ts"],
      "change": "behavior",
      "acceptance": [
        "src/rounding.ts exports type Rounding = \"half-away\" | \"half-even\" | \"down\" | \"up\" and round(x: number, mode: Rounding): number: half-away rounds halves away from zero, half-even rounds halves to the even neighbor, down rounds toward zero, up rounds away from zero",
        "round(2.5, \"half-even\") is 2, round(3.5, \"half-even\") is 4, round(-2.5, \"half-even\") is -2, round(2.7, \"down\") is 2, round(-2.7, \"down\") is -2, round(2.1, \"up\") is 3, round(-2.1, \"up\") is -3",
        "multiply(m: Money, factor: number, rounding: Rounding = \"half-away\"): Money in src/core/money.ts rounds with round from src/rounding.ts: multiply(money(5), 0.5, \"half-even\") is money(2), multiply(money(15), 0.5, \"half-even\") is money(8); without a mode multiply gives the same results as before",
        "test/rounding.test.ts covers round and the modes of multiply"
      ]
    },
    {
      "id": "price-range",
      "title": "Price range of the catalog",
      "why": "The storefront shows \"from $4.50 to $29.99\".",
      "footprint": ["src/core/money.ts", "src/pricerange.ts", "test/pricerange.test.ts"],
      "uses": ["src/catalog.ts"],
      "acceptance": [
        "src/core/money.ts exports range(amounts: readonly Money[]): { low: Money; high: Money }: the smallest and the largest amount; a RangeError for an empty list and a TypeError for mixed currencies",
        "src/pricerange.ts exports priceRange(catalog: ReadonlyMap<string, Product>): { low: Money; high: Money } over the catalog's prices (a RangeError for an empty catalog) and priceRangeText(catalog: ReadonlyMap<string, Product>): string: \"from $4.50 to $29.99\" with format from src/core/money.ts, or just \"$4.50\" when every price is the same",
        "test/pricerange.test.ts covers range, priceRange and priceRangeText"
      ]
    }
  ],
  "pairs": [
    { "first": "format-options", "second": "csv", "file": "src/csv.ts", "new": "format(m, { symbol: false })", "old": "format(m, false)" },
    { "first": "parse-options", "second": "import", "file": "src/import.ts", "new": "parse(price, { currency })", "old": "parse(price, currency)" },
    { "first": "basis-points", "second": "tips", "file": "src/tip.ts", "new": "percentOf(total, percent * 100)", "old": "percentOf(total, percent)" },
    { "first": "basis-points", "second": "late-fee", "file": "src/latefee.ts", "new": "percentOf(invoice.total, LATE_FEE_PERCENT * 100)", "old": "percentOf(invoice.total, LATE_FEE_PERCENT)" }
  ]
}
```
