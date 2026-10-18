import { newId as idFrom } from "@fire_trident/core";
import type { Id } from "@fire_trident/core";

/**
 * Ids for the worker: core's time-sortable id (core/src/ids.ts newId, the same format) with the clock and
 * crypto.getRandomValues, which core, being pure, takes from its caller.
 */

/** A uniform number in [0, 1) from crypto.getRandomValues. */
export function cryptoRandom(): number {
  const word = new Uint32Array(1);
  crypto.getRandomValues(word);
  return word[0]! / 2 ** 32;
}

/** A new time-sortable id with an optional prefix ("int_", "prp_", ...): base36 millis now and a random suffix. */
export function newId(prefix = ""): Id {
  return idFrom(prefix, Date.now(), cryptoRandom);
}
