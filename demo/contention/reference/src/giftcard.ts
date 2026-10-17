import type { Money } from "./core/money.ts";
import { subtract, takeUpTo } from "./core/money.ts";

/** A gift card and what is left on it. */
export interface GiftCard {
  readonly code: string;
  readonly balance: Money;
}

/** Pay as much of `due` as the card covers: the card with its new balance, what it paid, and what is still due. */
export function redeem(card: GiftCard, due: Money): { card: GiftCard; paid: Money; due: Money } {
  const { taken, left } = takeUpTo(card.balance, due);
  return { card: { code: card.code, balance: left }, paid: taken, due: subtract(due, taken) };
}
