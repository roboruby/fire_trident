import type { Money } from "./core/money.ts";
import { equals, format, range } from "./core/money.ts";
import type { Product } from "./catalog.ts";

/** The lowest and highest price in the catalog. Throws a RangeError for an empty catalog. */
export function priceRange(catalog: ReadonlyMap<string, Product>): { low: Money; high: Money } {
  return range([...catalog.values()].map((p) => p.price));
}

/** "from $4.50 to $29.99", or "$4.50" when every price is the same. */
export function priceRangeText(catalog: ReadonlyMap<string, Product>): string {
  const { low, high } = priceRange(catalog);
  return equals(low, high) ? format(low) : `from ${format(low)} to ${format(high)}`;
}
