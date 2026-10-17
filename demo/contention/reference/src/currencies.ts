/** The currencies the shop names, with the symbol format() writes. */
export const CURRENCIES: Readonly<Record<string, { readonly symbol: string; readonly name: string }>> = {
  USD: { symbol: "$", name: "US dollar" },
  EUR: { symbol: "€", name: "euro" },
  GBP: { symbol: "£", name: "pound sterling" },
  JPY: { symbol: "¥", name: "yen" },
  INR: { symbol: "₹", name: "Indian rupee" },
};

/** The currency's name, or the code itself when it is not listed. */
export function currencyName(code: string): string {
  return CURRENCIES[code]?.name ?? code;
}
