import type { Money } from "./core/money.ts";
import { parse } from "./core/money.ts";

/** One product the shop sells. */
export interface Product {
  readonly sku: string;
  readonly name: string;
  readonly price: Money;
}

/**
 * A catalog read from lines "SKU,Name,12.34", prices in `currency` (a price may carry its symbol). Blank lines and
 * lines starting with # are skipped. Throws a SyntaxError for a line without three fields or with a price that does
 * not parse, and an Error for a SKU listed twice.
 */
export function parseCatalog(text: string, currency: string = "USD"): Map<string, Product> {
  const out = new Map<string, Product>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const fields = line.split(",").map((f) => f.trim());
    const [sku, name, price] = fields;
    if (fields.length !== 3 || !sku || !name || !price) throw new SyntaxError(`catalog: "${line}" is not SKU,Name,price`);
    if (out.has(sku)) throw new Error(`catalog: ${sku} is listed twice`);
    out.set(sku, { sku, name, price: parse(price, { currency }) });
  }
  return out;
}

/** The product with `sku`. Throws a RangeError when the catalog has none. */
export function product(catalog: ReadonlyMap<string, Product>, sku: string): Product {
  const found = catalog.get(sku);
  if (!found) throw new RangeError(`catalog: no product ${sku}`);
  return found;
}
