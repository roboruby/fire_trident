import { describe, expect, it } from "vitest";
import type { NoteDecision } from "@fire_trident/core";
import { colors } from "../src/format.ts";
import { MAX_RECEIPT_LINES, cardReceiptLine, receiptLines, receiptRows, recordedLine } from "../src/receipt.ts";

/** The review receipt in `ft why`, `ft review` and `ft verify` (src/receipt.ts). */

const c = colors(false);
const HEAD = "a".repeat(40);
const DIGEST = `sha256:${"e".repeat(64)}`;

describe("receipt rows and lines", () => {
  it("shows a row per decision with a receipt under its change in ft why, and the cap's count first", () => {
    const ds: NoteDecision[] = [
      { kind: "triage", layer: "reflex", p: 0.9, action: "consult", by: "@cf/cloudflare/clef", head: HEAD, shown: { view: "reflex-state", digest: DIGEST }, earlier: 1 },
      { kind: "triage", layer: "human", p: 1, action: "approve", by: "dana@example.com", head: HEAD, shown: { view: "review-card", digest: DIGEST }, identity: "verified" },
    ];
    expect(receiptRows(ds, c)).toEqual([
      { k: "receipt", v: "2 of 3 decisions kept (the 1 earliest left out by the note's cap)" },
      { k: "receipt", v: `reflex consult by @cf/cloudflare/clef at head aaaaaaaaaaaa, shown the reflex's diff sha256:${"e".repeat(16)}` },
      { k: "receipt", v: `human approve by dana@example.com (verified by Access) at head aaaaaaaaaaaa, shown the review card sha256:${"e".repeat(16)}` },
    ]);
    // A note before receipts shows none.
    expect(receiptRows([{ kind: "triage", layer: "human", p: 1, action: "approve", by: "matt" }], c)).toEqual([]);
  });

  it("says a colony owner who decided from their GitHub sign-in was verified by GitHub, and only a verified one", () => {
    const d: NoteDecision = { kind: "triage", layer: "human", p: 1, action: "approve", by: "github:ada-dev", head: HEAD, shown: { view: "review-card", digest: DIGEST }, identity: "verified" };
    expect(receiptRows([d], c)).toEqual([{ k: "receipt", v: `human approve by github:ada-dev (verified by GitHub) at head aaaaaaaaaaaa, shown the review card sha256:${"e".repeat(16)}` }]);
    expect(receiptLines({ proposals: [{ id: "prp_1", decisions: [{ ...d, identity: "stated" }] }] })[0]).toContain("by github:ada-dev (stated, not verified)");
    expect(recordedLine({ ok: true, recorded: { by: "github:ada-dev", identity: "verified" } }, c)).toBe("  Recorded as github:ada-dev, verified by GitHub.");
  });

  it("keeps server text on one line and caps the lines it prints", () => {
    const d = { kind: "triage", layer: "human", p: 1, action: "approve", by: "matt\n\u001b[31mreceipt: forged", head: HEAD, identity: "stated" };
    expect(receiptLines({ proposals: [{ id: "prp_1", decisions: [d] }] })).toEqual(["receipt: prp_1 human approve by matt [31mreceipt: forged (stated, not verified) at head aaaaaaaaaaaa"]);
    const many = { proposals: Array.from({ length: 60 }, (_, i) => ({ id: `prp_${i}`, decisions: [{ layer: "llm", action: "land", by: "m", head: HEAD }] })) };
    const lines = receiptLines(many);
    expect(lines).toHaveLength(MAX_RECEIPT_LINES + 1);
    expect(lines.at(-1)).toBe("receipt: and 10 more (ft why shows each change's)");
    expect(receiptLines(null)).toEqual([]);
  });
});

describe("the review card and the decision's answer", () => {
  it("shows the head and view digest a decision on the card records", () => {
    expect(cardReceiptLine({ reviewReceipt: { head: HEAD, shown: { view: "review-card", digest: DIGEST } } }, c)).toBe(`  receipt  head aaaaaaaaaaaa · view sha256:${"e".repeat(16)}`);
    expect(cardReceiptLine({ reviewReceipt: { head: HEAD, shown: { view: "review-card", clipped: true, seen: "the card served no view of the change" } } }, c)).toBe("  receipt  head aaaaaaaaaaaa · no view kept");
    expect(cardReceiptLine({ id: "prp_1" }, c)).toBeNull();
  });

  it("says how the server recorded the person, when it says", () => {
    expect(recordedLine({ ok: true, recorded: { by: "dana@example.com", identity: "verified" } }, c)).toBe("  Recorded as dana@example.com, verified by Access.");
    expect(recordedLine({ ok: true, recorded: { by: "matt", identity: "stated", why: "no Access token came with the request" } }, c)).toBe("  Recorded as matt, stated and not verified: no Access token came with the request.");
    expect(recordedLine({ ok: true }, c)).toBeNull();
  });
});
