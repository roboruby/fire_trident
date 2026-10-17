import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { landingAnswerable, type Evidence, type Landing, type LineageNote, type NoteCheck } from "@fire_trident/core";
import { AnswerableLine, EvidenceChips, EvidenceList } from "../src/components/SaidBy.tsx";
import { NoteCardView } from "../src/landing/LiveNote.tsx";
import { cardOf, recordedCard } from "../src/landing/note.ts";
import { sealOf } from "../src/verified.ts";

/** Who said each line of a note, and who answers for a landing, as the Why tab, the review card and the note card draw them. */

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const CLEF = "@cf/cloudflare/clef";
const WORDS = "Did not run the tests; I only read the file";

/** An external agent's change, reviewed by the reflex and a second opinion, with the agent's own check and statement. */
const EVIDENCE: Evidence = {
  checks: [
    { name: "write src/a.ts", ok: true, ms: 4, detail: "parses", by: "agent" },
    { name: "innate: blobs", ok: true, ms: 1, detail: "1 file(s) read" },
    { name: "innate: not-verified", ok: true, ms: 0, detail: `Not verified: ${WORDS}` },
    { name: `reflex: ${CLEF}`, ok: true, ms: 30, detail: "needs_human 0.02" },
    { name: `llm: ${GEMMA}`, ok: true, ms: 900, detail: "approve: fine" },
    { name: "gate", ok: true, ms: 0, detail: "L1 innate+llm → land by llm at head ffffffffffff (confirmations: innate + llm): approved" },
  ],
  residual: ["src/b.ts"],
  notVerified: `Not verified: ${WORDS}`,
  notVerifiedBy: "agent",
};

/** Where each label first appears in the markup. */
const at = (html: string, ...labels: string[]): number[] => labels.map((l) => html.indexOf(l));
const increasing = (xs: number[]): boolean => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]!));

describe("the Why tab's evidence", () => {
  it("labels every line, FireTrident's first, then the models, then the agent's claims", () => {
    const html = renderToStaticMarkup(createElement(EvidenceList, { evidence: EVIDENCE, path: "src/a.ts" }));
    expect(increasing(at(html, "innate: blobs", "gate", "src/b.ts", `reflex: ${CLEF}`, `llm: ${GEMMA}`, "write a.ts", "Not verified"))).toBe(true);
    expect(html.match(/checked by FireTrident/g)).toHaveLength(4);
    expect(html).toContain(`model (${CLEF})`);
    expect(html).toContain(`model (${GEMMA})`);
    expect(html.match(/agent&#x27;s claim/g)).toHaveLength(2);
  });

  it("shows the agent's statement quoted in a row of its own, never inside FireTrident's check", () => {
    const html = renderToStaticMarkup(createElement(EvidenceList, { evidence: EVIDENCE }));
    expect(html.match(new RegExp(WORDS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
    expect(html).toContain(`<span class="said-quote">“${WORDS.replace(/'/g, "&#x27;")}”</span>`);
    expect(html).toContain("the agent stated what it did not verify (its claim, below)");
    expect(html).toContain('class="nv is-quoted"');
  });

  it("labels FireTrident's own statement as FireTrident's, unquoted", () => {
    const html = renderToStaticMarkup(
      createElement(EvidenceList, { evidence: { checks: [], notVerified: "Not verified: external agent over MCP; no check it ran is visible to the platform.", notVerifiedBy: "platform" } }),
    );
    expect(html).toContain("No checks recorded.");
    expect(html).toContain('<span class="said said-platform"');
    expect(html).toContain("external agent over MCP; no check it ran is visible to the platform.");
    expect(html).not.toContain("said-quote");
  });

  it("says unknown for a line an old note cannot place", () => {
    const html = renderToStaticMarkup(createElement(EvidenceList, { evidence: { checks: [{ name: "tests", ok: true, ms: 3, detail: "ran 4" }] } }));
    expect(html).toContain('<span class="said said-unknown"');
    expect(html).toContain("“ran 4”");
  });
});

describe("the review card's evidence", () => {
  it("puts each run of checks under who said it, in order, then the statement", () => {
    const html = renderToStaticMarkup(createElement(EvidenceChips, { evidence: EVIDENCE }));
    expect(increasing(at(html, "checked by FireTrident", "innate: blobs", "gate", `model (${CLEF})`, `model (${GEMMA})`, "agent&#x27;s claim", "write src/a.ts", "Not verified"))).toBe(true);
    expect(html.match(/checked by FireTrident/g)).toHaveLength(1);
  });
});

describe("the answerable line", () => {
  it("names the person, or says no person is answerable and why", () => {
    const note = (intent: Record<string, unknown>, decisions: unknown[] = []): LineageNote =>
      ({
        schema: "firetrident.lineage/v1",
        landingId: "lnd_1",
        colonyId: "c",
        proposals: [{ id: "p", agentId: "a", agentKind: "external", intent: { id: "i", title: "t", why: "", ...intent }, writeSet: [], readSet: [], decisions, evidence: EVIDENCE }],
      }) as unknown as LineageNote;
    const asked = renderToStaticMarkup(createElement(AnswerableLine, { a: landingAnswerable(note({ source: "human", createdBy: "Lee" })) }));
    expect(asked).toContain('class="answerable is-person"');
    expect(asked).toContain(`Lee asked for this intent; model ${GEMMA} approved it.`);
    const none = renderToStaticMarkup(createElement(AnswerableLine, { a: landingAnswerable(note({ source: "agent", createdBy: "agt_9" })) }));
    expect(none).toContain('class="answerable is-none"');
    expect(none).toContain(`No person is answerable for this landing: agent agt_9 declared the intent and model ${GEMMA} approved it.`);
    expect(renderToStaticMarkup(createElement(AnswerableLine, { a: landingAnswerable(note({})) }))).toContain("Unknown: the note was written before notes recorded who asked for each intent.");
  });
});

describe("the landing page's note card", () => {
  const landing: Landing = { id: "lnd_1", colonyId: "byo-demo", trunkSha: "7ebd0a6f3d6644a85ad40c2a3291ece1992937a3", parentSha: "0".repeat(40), proposalIds: ["p"], intentIds: ["i"], paths: ["src/a.ts"], regions: ["."], at: 1 };
  const NOTE = {
    schema: "firetrident.lineage/v1",
    landingId: "lnd_1",
    colonyId: "byo-demo",
    proposals: [
      {
        id: "p",
        agentId: "agt_ext",
        agentKind: "external",
        intent: { id: "i", title: "Document it", why: "", source: "human", createdBy: "Matt" },
        writeSet: [{ path: "src/a.ts", blob: "b".repeat(40) }],
        readSet: [],
        decisions: [{ kind: "triage", layer: "llm", p: 0.9, action: "land", by: GEMMA }],
        evidence: EVIDENCE,
      },
    ],
  } as unknown as LineageNote;

  it("says who answers for the landing, labels its decisions, checks and statement, and quotes the agent", () => {
    const card = cardOf({ colonyId: "byo-demo", landing, note: NOTE, seal: sealOf({ landingId: "lnd_1", trunkSha: landing.trunkSha, at: 1, status: "intact" } as NoteCheck), live: true });
    expect(card.answerable).toEqual({ answer: "person", text: `Matt asked for this intent; model ${GEMMA} approved it.` });
    expect(card.checks.map((c) => [c.name, c.speaker.label])).toEqual([
      ["innate: blobs", "checked by FireTrident"],
      ["innate: not-verified", "checked by FireTrident"],
      ["gate", "checked by FireTrident"],
      [`reflex: ${CLEF}`, `model (${CLEF})`],
      [`llm: ${GEMMA}`, `model (${GEMMA})`],
      ["write src/a.ts", "agent's claim"],
    ]);
    expect(card.notVerifiedBy?.label).toBe("agent's claim");
    const html = renderToStaticMarkup(createElement(NoteCardView, { card, origin: "https://firetrident.com" }));
    expect(increasing(at(html, "Answerable", "Matt asked for this intent", "Intent", "Decisions", `model (${GEMMA})`, "checked by FireTrident", `model (${CLEF})`, "agent&#x27;s claim", "Not verified:"))).toBe(true);
    expect(html).toContain(`<span class="said-quote">“${WORDS.replace(/'/g, "&#x27;")}”</span>`);
  });

  it("reads the recorded stand-in, an old note, with labels derived from it and an unknown answer", () => {
    const card = recordedCard();
    expect(card.answerable.answer).toBe("unknown");
    expect(card.checks.every((c) => c.speaker.kind === "platform")).toBe(true);
    expect(card.notVerifiedBy?.kind).toBe("agent");
    // The innate check's detail no longer repeats the agent's words.
    expect(card.checks.find((c) => c.name === "innate: not-verified")?.detail).toBe("the agent stated what it did not verify (its claim, below)");
    const html = renderToStaticMarkup(createElement(NoteCardView, { card, origin: "https://firetrident.com" }));
    expect(html).toContain("Unknown: the note was written before notes recorded who approved each rule.");
    expect(html).toContain("checked by FireTrident");
  });
});
