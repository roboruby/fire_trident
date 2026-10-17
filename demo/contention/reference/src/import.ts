import { isCurrencyCode, parse } from "./core/money.ts";
import type { Product } from "./catalog.ts";

/**
 * Products from lines "SKU,Name,price,CUR", each price in its line's currency. Blank lines and # lines are skipped.
 * Throws a SyntaxError for a line without four fields or with a bad currency or price, and an Error for a repeated SKU.
 */
export function importPrices(text: string): Map<string, Product> {
  const out = new Map<string, Product>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const fields = line.split(",").map((f) => f.trim());
    const [sku, name, price, currency] = fields;
    if (fields.length !== 4 || !sku || !name || !price || !currency) throw new SyntaxError(`import: "${line}" is not SKU,Name,price,CUR`);
    if (!isCurrencyCode(currency)) throw new SyntaxError(`import: ${currency} is not a currency code`);
    if (out.has(sku)) throw new Error(`import: ${sku} is listed twice`);
    out.set(sku, { sku, name, price: parse(price, { currency }) });
  }
  return out;
}
