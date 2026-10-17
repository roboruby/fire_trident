# tally

The money core of a small shop's checkout: a catalog, carts, discounts, sales tax, shipping, invoices and a plain-text
sales report. Every module works on `Money` from `src/core/money.ts`, amounts in integer cents with their currency.

TypeScript that Node 24 runs directly: no dependencies, no build step.

```sh
node --test        # every test in test/
```

| Module | What it does |
| --- | --- |
| `src/core/money.ts` | `Money`, arithmetic, `percentOf`, `format` and `parse` |
| `src/catalog.ts` | products read from `SKU,Name,price` lines |
| `src/cart.ts` | cart lines and the subtotal |
| `src/discount.ts` | fixed and percent discounts |
| `src/tax.ts` | sales tax by region |
| `src/shipping.ts` | flat shipping by region |
| `src/invoice.ts` | an invoice from a cart |
| `src/report.ts` | a plain-text sales report |
