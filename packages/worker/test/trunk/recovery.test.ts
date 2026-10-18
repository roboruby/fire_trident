import { describe, expect, it } from "vitest";
import { journalFates, type PushingRow } from "../../src/trunk/recovery.ts";

const P = "a".repeat(40);
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const X = "e".repeat(40);
/** A cycle's chain of two landings on P: C1, then C2 on C1. */
const CHAIN: PushingRow[] = [
  { landingId: "lnd_1", commit: C1, parent: P },
  { landingId: "lnd_2", commit: C2, parent: C1 },
];
const fates = (head: string | null, log: string[] | null) => Object.fromEntries(journalFates(CHAIN, { head, log }));

describe("journal recovery (trunk/recovery.ts)", () => {
  it("records a chain main is at, whatever the binding's log says", () => {
    // The binding still shows the old head: the advertisement answers for the push.
    expect(fates(C2, [P])).toEqual({ lnd_1: "landed", lnd_2: "landed" });
    expect(fates(C2, null)).toEqual({ lnd_1: "landed", lnd_2: "landed" });
  });

  it("drops a chain main never moved to", () => {
    expect(fates(P, [P])).toEqual({ lnd_1: "dropped", lnd_2: "dropped" });
    expect(fates(P, null)).toEqual({ lnd_1: "dropped", lnd_2: "dropped" });
  });

  it("keeps a chain whose outcome is unclear, and settles it once the binding's log catches up", () => {
    // Main elsewhere, and the binding's log behind it: kept.
    expect(fates(X, [P])).toEqual({ lnd_1: "kept", lnd_2: "kept" });
    // The advertisement unread and nothing in the log: kept.
    expect(fates(null, [P])).toEqual({ lnd_1: "kept", lnd_2: "kept" });
    expect(fates(null, null)).toEqual({ lnd_1: "kept", lnd_2: "kept" });
    // The log lists the chain: on main (under a later commit, or while the advertisement could not be read).
    expect(fates(X, [X, C2, C1, P])).toEqual({ lnd_1: "landed", lnd_2: "landed" });
    expect(fates(null, [C2, C1, P])).toEqual({ lnd_1: "landed", lnd_2: "landed" });
    // The log caught up with the advertised head and does not list the chain: it did not land.
    expect(fates(X, [X, P])).toEqual({ lnd_1: "dropped", lnd_2: "dropped" });
  });

  it("never records a commit main is behind, even when the binding's log lists it", () => {
    expect(fates(C1, [C2, C1, P])).toEqual({ lnd_1: "landed", lnd_2: "dropped" });
  });
});
