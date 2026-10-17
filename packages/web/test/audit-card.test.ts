import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { decidesOf, type DecidesReport, type Proposal } from "@fire_trident/core";
import type { Backend } from "../src/api.ts";
import { auditDoneText, auditOf, canaryOf, splitQueue } from "../src/audit.ts";
import { AuditCard } from "../src/components/AuditCard.tsx";
import { DecidesCard } from "../src/components/Decides.tsx";
import { ColonyStore } from "../src/store.ts";

/** The audit sample and blind canaries on the review tab, and the audit's line on the decides card. */

function item(id: string, audit?: Record<string, unknown>): Proposal {
  return {
    id,
    colonyId: "web",
    intentId: `int_${id}`,
    agentId: "agt_1",
    workspace: { namespace: "ft-sessions", name: "ws", remote: "" },
    baseSha: "0".repeat(40),
    headSha: "1".repeat(40),
    writeSet: [{ path: "src/app.ts", blob: "2".repeat(40) }],
    readSet: [],
    declared: { footprint: ["src/app.ts"], summary: "Rename the helper" },
    evidence: { checks: [] },
    status: audit ? "landed" : "escalated",
    createdAt: 1,
    ...(audit ? { audit } : {}),
  } as Proposal;
}

const MARK = { kind: "audit", layer: "deterministic", label: "a deterministic proof", rule: "D3 innate+proof", landedBy: "Already landed by D3 innate+proof (a deterministic proof).", landingId: "lnd_1", landedAt: 5, queuedAt: 6 };

describe("reading the queue", () => {
  it("tells audit items from escalations, in the queue's order", () => {
    const q = [item("e1"), item("a1", MARK), item("e2")];
    expect(splitQueue(q)).toEqual({ escalations: [q[0], q[2]], audits: [q[1]] });
    expect(auditOf(q[1]!)).toEqual({ layer: "deterministic", label: "a deterministic proof", rule: "D3 innate+proof", landedBy: MARK.landedBy, landingId: "lnd_1", landedAt: 5 });
    expect(auditOf(q[0]!)).toBeNull();
    expect(auditOf(item("x", { kind: "other", layer: "model" }))).toBeNull();
  });

  it("reads a canary's reveal from a decision's answer, and nothing from an ordinary one", () => {
    expect(canaryOf({ ok: true, canary: { outcome: "approved", sentence: "This was a canary, not a real change." } })).toEqual({ outcome: "approved", sentence: "This was a canary, not a real change." });
    expect(canaryOf({ ok: true })).toBeNull();
    expect(canaryOf(null)).toBeNull();
    expect(canaryOf({ canary: { outcome: "maybe", sentence: "x" } })).toBeNull();
  });

  it("says back what an answer did", () => {
    expect(auditDoneText({ sentence: "Recorded as fine: prp_1 landed by D3 innate+proof (a deterministic proof) and should have." }, "fine")).toMatch(/^Recorded as fine: prp_1/);
    expect(auditDoneText(null, "should-not-have-landed")).toBe("Recorded: it should not have landed. Revert it with ft revert if it is still on trunk.");
  });
});

describe("the audit card", () => {
  const live = { mode: "live", auditAnswer: async () => ({}) } as unknown as Backend;
  const replay = { mode: "replay" } as unknown as Backend;
  const render = (backend: Backend) => renderToStaticMarkup(createElement(AuditCard, { p: item("prp_a1", MARK), view: null, store: new ColonyStore("web"), backend, onDone: () => {} }));

  it("looks like a review card, plus what already landed it", () => {
    const html = render(live);
    expect(html).toContain("Audit · landed");
    expect(html).toContain("Already landed by D3 innate+proof (a deterministic proof).");
    expect(html).toContain("Rename the helper");
    expect(html).toContain(">Fine</button>");
    expect(html).toContain("Should not have landed");
    expect(html).toContain("and revert it now");
  });

  it("is read-only where no answer can be sent", () => {
    const html = render(replay);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Fine<\/button>/);
  });

  it("renders nothing for an escalation", () => {
    expect(renderToStaticMarkup(createElement(AuditCard, { p: item("e1"), view: null, store: new ColonyStore("web"), backend: live, onDone: () => {} }))).toBe("");
  });
});

describe("the decides card", () => {
  const raw = (audit?: Record<string, unknown>) => ({
    colonyId: "web",
    preset: "central-development",
    nearest: "central-development",
    differs: [],
    settings: [],
    lets: "A proof lands a change without a person.",
    reviewing: true,
    protectedPaths: 0,
    dangerAllow: 0,
    always: "Whatever the preset, a person decides a change with a danger pattern.",
    presets: [],
    split: { days: 30, since: 0, total: 400, counts: { deterministic: 300, model: 100, autonomy: 0, person: 0, unreviewed: 0 } },
    at: 1,
    ...(audit ? { audit } : {}),
  });
  const card = (r: DecidesReport) => renderToStaticMarkup(createElement(DecidesCard, { d: { state: "loaded", report: r }, colonyId: "web" }));

  it("shows the audit's line, and the canaries' when they are on", () => {
    const r = decidesOf(raw({ line: "audited 12 of 400 landings without a person: 0 should not have landed (0–24%)", rate: 0.03, landed: 400, audited: 12, wrong: 0, lo: 0, hi: 0.242, pending: 1, canaries: "canaries: 4 of 5 caught (80%, 38–96%), 1 approved" }))!;
    expect(r.audit).toMatchObject({ audited: 12, landed: 400, hi: 0.242 });
    const html = card(r);
    expect(html).toContain("audited 12 of 400 landings without a person: 0 should not have landed (0–24%)");
    expect(html).toContain("canaries: 4 of 5 caught (80%, 38–96%), 1 approved");
    expect(card(decidesOf(raw({ line: "audit sample off", canaries: "canaries off" }))!)).not.toContain("canaries off");
  });

  it("shows no line from a server that predates the audit", () => {
    const r = decidesOf(raw())!;
    expect(r.audit).toBeUndefined();
    expect(card(r)).not.toContain("dc-audit");
  });
});
