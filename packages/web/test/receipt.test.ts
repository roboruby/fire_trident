import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NoteDecision } from "@fire_trident/core";
import { CardReceipt, DecisionReceipt, EarlierDecisions } from "../src/components/Receipt.tsx";
import { cardReceipt, decisionReceipt, earlierText, receiptText, recordedText } from "../src/receipt.ts";

/** The review receipt in the web app (src/receipt.ts): the review card, the Why tab's decisions and the decision's toast. */

const HEAD = "a".repeat(40);
const DIGEST = `sha256:${"e".repeat(64)}`;

describe("the review receipt on the page", () => {
  it("says what a recorded decision was shown, with the head, and whether a person was verified", () => {
    const d: NoteDecision = { kind: "triage", layer: "human", p: 1, action: "approve", by: "dana@example.com", head: HEAD, shown: { view: "review-card", digest: DIGEST }, identity: "verified" };
    expect(receiptText(decisionReceipt(d)!)).toBe(`verified by Access · at head aaaaaaaaaaaa · shown the review card sha256:${"e".repeat(16)}`);
    const llm: NoteDecision = { kind: "triage", layer: "llm", p: 0.6, action: "escalate", head: HEAD, shown: { view: "prompt-diff", digest: DIGEST, clipped: true, seen: "saw 20 of 22 files" }, identity: "verified" };
    expect(receiptText(decisionReceipt(llm)!)).toBe(`at head aaaaaaaaaaaa · shown the prompt's diff sha256:${"e".repeat(16)} · clipped: saw 20 of 22 files`);
    expect(decisionReceipt({ kind: "triage", layer: "human", p: 1, action: "approve", by: "matt" })).toBeNull();
    const html = renderToStaticMarkup(createElement(DecisionReceipt, { d }));
    expect(html).toContain("receipt · verified by Access");
    expect(html).toContain(DIGEST);
  });

  it("says how many decisions the note's cap left out", () => {
    const ds = [{ kind: "triage", layer: "llm", p: 1, action: "land", earlier: 4 }, { kind: "triage", layer: "llm", p: 1, action: "land" }];
    expect(earlierText(ds)).toBe("2 of 6 decisions kept (the 4 earliest left out by the note's cap)");
    expect(earlierText(ds.slice(1))).toBeNull();
    expect(renderToStaticMarkup(createElement(EarlierDecisions, { decisions: ds }))).toContain("2 of 6 decisions kept");
  });

  it("shows on the review card the head and view digest its decision records", () => {
    const item = { id: "prp_1", reviewReceipt: { head: HEAD, shown: { view: "review-card", digest: DIGEST } } };
    expect(cardReceipt(item)).toMatchObject({ head: "aaaaaaaaaaaa", digest: `sha256:${"e".repeat(16)}`, digestFull: DIGEST, clipped: false });
    const html = renderToStaticMarkup(createElement(CardReceipt, { item }));
    expect(html).toContain("Reviewing at head aaaaaaaaaaaa · shown the review card sha256:");
    expect(renderToStaticMarkup(createElement(CardReceipt, { item: { id: "prp_2" } }))).toBe("");
  });

  it("says in the toast how the server recorded the person", () => {
    expect(recordedText({ ok: true, recorded: { by: "dana@example.com", identity: "verified" } })).toBe("Recorded as dana@example.com, verified by Access.");
    expect(recordedText({ ok: true, recorded: { by: "matt", identity: "stated", why: "no Access token came with the request" } })).toBe("Recorded as matt, stated and not verified: no Access token came with the request.");
    expect(recordedText({ ok: true })).toBeNull();
    expect(recordedText(undefined)).toBeNull();
  });
});
