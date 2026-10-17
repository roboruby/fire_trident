import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LandingTests } from "@fire_trident/core";
import { TestsRow, TestsRowView } from "../src/components/TestsRow.tsx";
import { NoteCardView } from "../src/landing/LiveNote.tsx";
import { recordedCard } from "../src/landing/note.ts";
import { fetchLandingTests, landingTestsOf } from "../src/tests.ts";

/** A landing's test row as the Why tab and the landing page's note card draw it, and how the page reads it. */

const A = "a".repeat(40);
const B = "b".repeat(40);
const proof = { rungs: [{ rung: "deterministic" as const, count: 1 }], text: "deterministic" };
const row = (t: Partial<LandingTests>): LandingTests => {
  const base = { colonyId: "c", landingId: "lnd_1", trunkSha: B, baseSha: A, status: "certified" as const, proof, text: "" };
  return landingTestsOf({ ...base, ...t })!;
};
const html = (t: LandingTests): string => renderToStaticMarkup(createElement(TestsRow, { t }));

const CERTIFIED = row({
  base: { sha: A, status: "red", pass: 433, tests: 434, failing: 1, exact: true },
  certified: { sha: B, status: "green", pass: 434, tests: 434, failing: 0 },
  lost: 0,
  spend: { usd: 0.0003, calls: 2, intents: 1 },
  authors: { inherited: { files: 40, tests: 400 }, agents: { files: 3, tests: 30, by: ["@cf/google/gemma-4-26b-a4b-it"] }, person: { files: 1, tests: 4, by: ["Lee"] } },
  reach: { earlier: 2, own: 1, later: 0, earlierFiles: ["test/a.test.ts", "test/b.test.ts"], ownFiles: ["test/new.test.ts"], checked: 44 },
});

describe("the test row", () => {
  it("reads base against certified, lost, proof and spend, then whose tests and what reaches the change", () => {
    const h = html(CERTIFIED);
    expect(h).toContain("433/434 at base, 434/434 certified, 0 lost · proof: deterministic · $0.0003 (model calls this platform made)");
    expect(h).toContain("checked by FireTrident");
    expect(h).toContain("400 inherited from the repository (40 files) · 30 written or edited by agents (3 files: gemma-4-26b-a4b-it) · 4 in edits a person approved (1 file: Lee).");
    expect(h).toContain("2 earlier test files reach its files (test/a.test.ts, test/b.test.ts), and 1 test file it wrote.");
    expect(h).toContain('class="tests-row is-certified"');
    expect(h).not.toContain("is-warn");
  });

  it("names lost tests and a base that was not certified itself", () => {
    const h = html(row({ base: { sha: A, status: "green", pass: 60, tests: 60, failing: 0, exact: false }, certified: { sha: B, status: "green", pass: 59, tests: 59, failing: 0 }, lost: 1, lostTests: [{ file: "test/a.test.ts", name: "adds" }] }));
    expect(h).toContain("60/60 at aaaaaaa, before base, 59/59 certified, 1 lost · proof: deterministic");
    expect(h).toContain('class="tests-line is-lost is-warn"');
    expect(h).toContain("Passed at base, not at the certified commit: adds (test/a.test.ts).");
  });

  it("warns in amber when no earlier test reaches the change", () => {
    const h = html(row({ base: { sha: A, status: "green", pass: 3, tests: 3, failing: 0, exact: true }, certified: { sha: B, status: "green", pass: 4, tests: 4, failing: 0 }, lost: 0, added: 1, reach: { earlier: 0, own: 1, later: 0, earlierFiles: [], ownFiles: ["test/new.test.ts"], checked: 3 } }));
    expect(h).toContain('class="tests-row is-certified is-warn"');
    expect(h).toContain('<div class="tests-line is-reach is-warn">No earlier test reaches this change: only 1 test file it wrote reaches its files.</div>');
  });

  it("says not certified yet, and that a colony has no test this platform can run", () => {
    expect(html(row({ status: "pending", reason: "trunk is red at bbbbbbb (2 of 60 failing)" }))).toContain("not certified yet: trunk is red at bbbbbbb (2 of 60 failing) · proof: deterministic");
    const none = html(row({ status: "no-tests", reason: "no test file imports node:test (223 test files)" }));
    expect(none).toContain('class="tests-row is-no-tests"');
    expect(none).toContain("no tests this platform can run · proof: deterministic");
  });

  it("shows each state of a row being read", () => {
    const view = (state: Parameters<typeof TestsRowView>[0]["state"]): string => renderToStaticMarkup(createElement(TestsRowView, { state, ask: () => undefined }));
    expect(view({ kind: "idle" })).toContain("Show its tests");
    expect(view({ kind: "loading" })).toContain("Reading its tests at its base and at the certified commit…");
    expect(view({ kind: "failed", message: "The test row could not be read (503): try again in a moment." })).toContain("(503)");
    expect(view({ kind: "loaded", t: CERTIFIED })).toContain("434/434 certified");
  });
});

describe("reading the row", () => {
  it("takes the server's words, writes them from the fields when it sent none, and refuses what is not a row", () => {
    expect(landingTestsOf({ ...CERTIFIED, text: "from the server" })!.text).toBe("from the server");
    expect(landingTestsOf({ ...CERTIFIED, text: undefined })!.text).toBe(CERTIFIED.text);
    expect(landingTestsOf({ landingId: "x", status: "weird" })).toBeNull();
    expect(landingTestsOf("nope")).toBeNull();
  });

  it("keeps a certified row for the page's life, asks a pending one again, and answers null for an unknown landing", async () => {
    const asked: string[] = [];
    const answers: Record<string, () => Response> = {
      lnd_c: () => new Response(JSON.stringify({ ...CERTIFIED, landingId: "lnd_c" })),
      lnd_p: () => new Response(JSON.stringify(row({ landingId: "lnd_p", status: "pending" }))),
      lnd_x: () => new Response(JSON.stringify({ error: "no landing" }), { status: 404 }),
    };
    const fetcher = (async (url: string) => {
      asked.push(url);
      return answers[url.split("/")[5]!]!();
    }) as unknown as typeof fetch;
    expect((await fetchLandingTests("col", "lnd_c", fetcher))?.status).toBe("certified");
    await fetchLandingTests("col", "lnd_c", fetcher);
    expect((await fetchLandingTests("col", "lnd_p", fetcher))?.status).toBe("pending");
    await fetchLandingTests("col", "lnd_p", fetcher);
    expect(await fetchLandingTests("col", "lnd_x", fetcher)).toBeNull();
    expect(asked).toEqual(["/api/colonies/col/landings/lnd_c/tests", "/api/colonies/col/landings/lnd_p/tests", "/api/colonies/col/landings/lnd_p/tests", "/api/colonies/col/landings/lnd_x/tests"]);
  });
});

describe("the note card's test row", () => {
  it("shows the row under Tests, and says when it was not read", () => {
    const live = renderToStaticMarkup(createElement(NoteCardView, { card: { ...recordedCard(), live: true, tests: CERTIFIED }, origin: "https://firetrident.com" }));
    expect(live).toContain('<div class="nc-k">Tests</div>');
    expect(live).toContain("433/434 at base, 434/434 certified, 0 lost · proof: deterministic");
    const recorded = renderToStaticMarkup(createElement(NoteCardView, { card: recordedCard(), origin: "https://firetrident.com" }));
    expect(recorded).toContain("Not read: this note is from FireTrident&#x27;s recorded results.");
  });
});

describe("the note card reads its landing's row", () => {
  it("beside the lineage, and shows the note without it when the row does not come", async () => {
    const { loadNoteCard } = await import("../src/landing/note.ts");
    const note = { schema: "firetrident.lineage/v1", landingId: "lnd_1", colonyId: "byo-demo", proposals: [{ id: "prp_1", agentId: "agt_1", agentKind: "external", intent: { id: "int_1", title: "t", why: "" }, writeSet: [{ path: "index.js", blob: B }], readSet: [], decisions: [], evidence: { checks: [] } }] };
    const landing = { id: "lnd_1", colonyId: "byo-demo", trunkSha: B, parentSha: A, proposalIds: ["prp_1"], intentIds: ["int_1"], paths: ["index.js"], regions: ["."], at: 1 };
    const routes: Record<string, unknown> = {
      "/api/colonies/byo-demo/notes/verify?limit=5": { notes: [{ landingId: "lnd_1", trunkSha: B, at: 1, status: "intact" }] },
      "/api/colonies/byo-demo": { recentLandings: [landing], rules: [], agents: [{ id: "agt_1", name: "a" }] },
      "/api/colonies/byo-demo/why?path=index.js": [{ landing, note }],
      "/api/colonies/byo-demo/landings/lnd_1/tests": { ...CERTIFIED, colonyId: "byo-demo" },
    };
    const get = async (url: string) => {
      if (!(url in routes)) throw new Error("404");
      return routes[url];
    };
    expect((await loadNoteCard(["byo-demo"], get))?.tests?.text).toBe(CERTIFIED.text);
    delete routes["/api/colonies/byo-demo/landings/lnd_1/tests"];
    const without = await loadNoteCard(["byo-demo"], get);
    expect(without).toMatchObject({ landingId: "lnd_1", tests: null });
  });
});
