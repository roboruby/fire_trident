import { describe, expect, it } from "vitest";
import type { Proposal } from "@fire_trident/core";
import { CARD_FILE_LINES, REVIEW_DATA_NOTE, reviewCard, reviewQueue } from "../../../src/mcp/review/card.ts";
import { NO_NETWORK_CSP, isUiUri, registerUiResource, toolUi } from "../../../src/mcp/apps/protocol.ts";
import { WEB, context, escalated } from "./fixtures.ts";

describe("review card", () => {
  it("draws control characters and bidirectional overrides in agent text as escapes", () => {
    const p = escalated("prp_1", { declared: { footprint: ["src/app/main.ts"], summary: "fine‮ evil\u0007" } });
    const c = reviewCard("hono", p, context(["prp_1"]), WEB);
    expect(c.summary).toBe("fine\\u{202e} evil\\u{7}");
    expect(c.text).toContain("fine\\u{202e} evil\\u{7}");
    expect(c.text).not.toContain("‮");
  });

  it("says when no diff was kept, and still shows who said what", () => {
    const c = reviewCard("hono", escalated("prp_1", { review: undefined }), context(["prp_1"]), WEB);
    expect(c.change).toBeNull();
    expect(c.look.danger).toEqual([]);
    expect(c.checks.length).toBeGreaterThan(0);
    expect(c.text).toContain("No diff was kept with this card");
  });

  it("reads an old or partial item without failing: what it cannot say is left out", () => {
    const old = { id: "prp_old", intentId: "int_x", agentId: "agt_1", status: "escalated", createdAt: 1 } as unknown as Proposal;
    const c = reviewCard("hono", old, null, WEB);
    expect(c).toMatchObject({ title: "int_x", askedBy: "who asked for it is not recorded", agent: { id: "agt_1", kind: "unknown", modelKnown: "unknown" }, wrote: 0, read: 0, change: null, decisions: [], checks: [], notVerified: null, decidable: true });
    expect(c.text).toContain("checks: none recorded");
    const q = reviewQueue("hono", [old], null, WEB);
    expect(q.items[0]).toMatchObject({ proposalId: "prp_old", danger: 0, residual: 0, filesChanged: 0 });
  });

  it("marks an audit item as answered elsewhere, and bounds a long diff", () => {
    const long = Array.from({ length: CARD_FILE_LINES + 50 }, (_, i) => `+line ${i}`).join("\n");
    const audit = escalated("prp_a", {
      status: "landed",
      audit: { kind: "audit", layer: "deterministic", label: "a deterministic proof", rule: "D3", landedBy: "Already landed by D3.", landingId: "lnd_1", landedAt: 1 },
      review: { files: [{ path: "src/big.ts", status: "added", added: CARD_FILE_LINES + 50, removed: 0, hunks: `@@ -0,0 +1,${CARD_FILE_LINES + 50} @@\n${long}`, truncated: false }], filesChanged: 1, danger: [], residual: [] },
    });
    const c = reviewCard("hono", audit, context(["prp_a"]), WEB);
    expect(c.decidable).toBe(false);
    expect(c.audit).toBe("Already landed by D3.");
    expect(c.text).toContain(`This is not decided here: answer it in the web review queue at ${WEB}.`);
    const f = c.change!.files[0]!;
    expect(f.lines).toHaveLength(CARD_FILE_LINES);
    expect(f.more).toBe(51); // the hunk header and 450 lines, 400 of them shown
    expect(c.text).toContain("more lines not printed here");
  });

  it("an empty queue says so", () => {
    const q = reviewQueue("hono", [], null, WEB);
    expect(q).toMatchObject({ waiting: 0, audits: 0, items: [], more: 0, text: `Nothing waits for a person in colony hono. Its web review queue: ${WEB}` });
    expect(reviewQueue("hono", [escalated("prp_1")], null, WEB).text).toContain(REVIEW_DATA_NOTE);
  });
});

describe("MCP Apps protocol pieces", () => {
  it("names a view by a ui:// URI only, with the flat key older hosts read", () => {
    expect(isUiUri("ui://firetrident/review-card")).toBe(true);
    expect(isUiUri("https://ft.test/view")).toBe(false);
    expect(toolUi({ resourceUri: "ui://a/b" })).toEqual({ ui: { resourceUri: "ui://a/b" }, "ui/resourceUri": "ui://a/b" });
    expect(toolUi({ visibility: ["app"] })).toEqual({ ui: { visibility: ["app"] } });
    expect(() => toolUi({ resourceUri: "https://ft.test/view" })).toThrow(/ui:\/\//);
    const server = { registerResource: () => undefined } as never;
    expect(() => registerUiResource(server, { uri: "file:///x.html", name: "x", description: "x", html: "<!doctype html>", meta: {} })).toThrow(/ui:\/\//);
  });

  it("declares no network origin of any kind", () => {
    expect(NO_NETWORK_CSP).toEqual({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] });
    expect(Object.isFrozen(NO_NETWORK_CSP)).toBe(true);
  });
});
