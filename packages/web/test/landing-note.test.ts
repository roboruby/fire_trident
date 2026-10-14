import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Landing, LineageNote, NoteCheck } from "@fire_trident/core";
import { NoteCardView, serverOrigin } from "../src/landing/LiveNote.tsx";
import { NOTE_COLONIES, cardOf, loadNoteCard, noteColonies, recordedCard, verifyCommands, type GetJson } from "../src/landing/note.ts";
import { sealOf } from "../src/verified.ts";

/** The Remember card of the landing page: the newest sealed landing of a showcase colony, read from the public routes. */

const SEALED = "7ebd0a6f3d6644a85ad40c2a3291ece1992937a3";
const OLDER = "8fbe556265698732c5934903e8f534d123e8220e";

const landing = (id: string, trunkSha: string, paths: string[], at: number): Landing => ({ id, colonyId: "byo-demo", trunkSha, parentSha: "0".repeat(40), proposalIds: ["prp_1"], intentIds: ["int_1"], paths, regions: ["."], at });

/** A note as an external agent's landing writes it: a declared model, recorded decisions and checks, one file read and written. */
const NOTE: LineageNote = {
  schema: "firetrident.lineage/v1",
  landingId: "lnd_sealed",
  colonyId: "byo-demo",
  proposals: [
    {
      id: "prp_1",
      agentId: "agt_ext",
      agentKind: "external",
      model: "model-x",
      intent: { id: "int_1", title: "Document isPlainObject with a JSDoc comment", why: "Document isPlainObject with a JSDoc comment.\nReaders of index.js should see what counts as a plain object." },
      writeSet: [{ path: "index.js", blob: "f2171d1fa81547a0b0e0c0d0e0f0a0b0c0d0e0f0" }],
      readSet: [{ path: "index.js", blob: "9ec755cf0b3217542a91fbe28044bc8edf40e325" }],
      decisions: [{ kind: "triage", layer: "reflex", p: 0.89, action: "land", by: "reflex-model" }],
      evidence: {
        checks: [
          { name: "innate: blobs", ok: true, ms: 1, detail: "1 file(s) read" },
          { name: "deterministic: mechanical proof", ok: false, ms: 0, detail: "inconclusive: the intent has no rule to prove against" },
          { name: "gate", ok: true, ms: 0, detail: "R3 innate+autonomy → land by reflex at head fb0507f75084" },
        ],
        notVerified: "Not verified: Did not run tests or a type check.",
      },
      provenance: { author: "external", auth: "mcp", model: { evidence: "declared", name: "model-x" } },
    },
  ],
};

const check = (landingId: string, trunkSha: string, status: string): NoteCheck => ({ landingId, trunkSha, at: 1, status }) as NoteCheck;

/** The public routes of a few colonies, answered from memory; every other URL fails as an unknown colony would. */
function api(routes: Record<string, unknown>): { get: GetJson; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    get: async (url: string) => {
      asked.push(url);
      if (!(url in routes)) throw new Error("404");
      return routes[url];
    },
  };
}

const BYO = {
  "/api/colonies/byo-demo/notes/verify?limit=5": { notes: [check("lnd_sealed", SEALED, "intact"), check("lnd_old", OLDER, "no-trailer")] },
  "/api/colonies/byo-demo": {
    recentLandings: [landing("lnd_sealed", SEALED, ["index.js"], 1_000), landing("lnd_old", OLDER, ["benchmark.js"], 500)],
    rules: [],
    agents: [],
  },
  "/api/colonies/byo-demo/why?path=index.js": [{ landing: landing("lnd_sealed", SEALED, ["index.js"], 1_000), note: NOTE }],
  "/api/colonies/byo-demo/agents?all=1&journal=0&limit=500": { agents: [{ id: "agt_ext", name: "docs-agent" }] },
};

describe("the Remember card's note", () => {
  it("is the newest sealed landing of the first showcase colony with one, read from the public routes", async () => {
    const { get, asked } = api(BYO);
    const card = await loadNoteCard(NOTE_COLONIES, get);
    expect(card).toMatchObject({
      live: true,
      colonyId: "byo-demo",
      landingId: "lnd_sealed",
      commit: SEALED,
      at: 1_000,
      path: "index.js",
      seal: { state: "intact", label: "Note intact" },
      intent: { title: "Document isPlainObject with a JSDoc comment" },
      rule: null,
      agent: { id: "agt_ext", name: "docs-agent", kind: "external", model: "model-x" },
      provenance: { level: "declared", label: "Model declared by the agent", author: "External agent: the MCP token and its resume key" },
      decisions: [{ layer: "reflex", kind: "triage", action: "land", p: 0.89, by: "reflex-model" }],
      notVerified: "Did not run tests or a type check.",
      reads: [{ path: "index.js", blob: "9ec755cf0b3217542a91fbe28044bc8edf40e325" }],
      writes: [{ path: "index.js", blob: "f2171d1fa81547a0b0e0c0d0e0f0a0b0c0d0e0f0" }],
      others: 0,
    });
    expect(card?.checks.map((c) => [c.name, c.ok])).toEqual([
      ["innate: blobs", true],
      ["deterministic: mechanical proof", false],
      ["gate", true],
    ]);
    // byo-demo answered first: no other colony was asked.
    expect(asked.every((u) => u.startsWith("/api/colonies/byo-demo"))).toBe(true);
  });

  it("goes on to the next showcase colony when one has no sealed note among its newest, or does not answer", async () => {
    const hono = {
      "/api/colonies/hono/notes/verify?limit=5": { notes: [check("lnd_h2", "c".repeat(40), "pending"), check("lnd_h1", "d".repeat(40), "intact")] },
      "/api/colonies/hono": { recentLandings: [landing("lnd_h2", "c".repeat(40), ["src/b.ts"], 20), landing("lnd_h1", "d".repeat(40), ["src/a.ts"], 10)], rules: [{ id: "rul_1", description: "No console calls in src", approvedBy: "matt" }], agents: [{ id: "agt_ext", name: "forager-007" }] },
      "/api/colonies/hono/why?path=src%2Fa.ts": [{ landing: landing("lnd_h1", "d".repeat(40), ["src/a.ts"], 10), note: { ...NOTE, landingId: "lnd_h1", proposals: [{ ...NOTE.proposals[0]!, intent: { id: "int_2", title: "No console calls in src in src/a.ts", why: "", ruleId: "rul_1" } }, NOTE.proposals[0]!] } }],
    };
    const unsealed = { "/api/colonies/byo-demo/notes/verify?limit=5": { notes: [check("lnd_old", OLDER, "no-trailer")] } };
    const { get, asked } = api({ ...unsealed, ...hono });
    const card = await loadNoteCard(NOTE_COLONIES, get);
    expect(card).toMatchObject({ colonyId: "hono", landingId: "lnd_h1", seal: { state: "intact" }, rule: { id: "rul_1", name: "No console calls in src", approvedBy: "matt" }, agent: { name: "forager-007" }, others: 1 });
    expect(asked).not.toContain("/api/colonies/hono/agents?all=1&journal=0&limit=500");
    // byo-demo does not answer at all: hono still.
    expect((await loadNoteCard(NOTE_COLONIES, api(hono).get))?.colonyId).toBe("hono");
  });

  it("shows the first colony's newest note with the badge it earned when no colony has a sealed one, and none when nobody answers", async () => {
    const old = {
      "/api/colonies/byo-demo/notes/verify?limit=5": { notes: [check("lnd_old", OLDER, "no-trailer")] },
      "/api/colonies/byo-demo": { recentLandings: [landing("lnd_old", OLDER, ["benchmark.js"], 500)], rules: [], agents: [] },
      "/api/colonies/byo-demo/why?path=benchmark.js": [{ landing: landing("lnd_old", OLDER, ["benchmark.js"], 500), note: { ...NOTE, landingId: "lnd_old" } }],
    };
    const card = await loadNoteCard(NOTE_COLONIES, api(old).get);
    expect(card).toMatchObject({ colonyId: "byo-demo", landingId: "lnd_old", seal: { state: "unsealed", label: "Landed before notes were sealed" } });
    expect(await loadNoteCard(NOTE_COLONIES, api({}).get)).toBeNull();
  });

  it("stands in with a recorded note, labeled as not checked, when nothing answers", () => {
    const card = recordedCard();
    expect(card).toMatchObject({
      live: false,
      colonyId: "byo-demo",
      commit: OLDER,
      seal: { state: "unchecked", label: "Note not checked" },
      rule: { name: "JavaScript strings use double quotes", approvedBy: "mcp_join" },
      provenance: null,
    });
    expect(card.seal.detail).toMatch(/^No colony answered just now, so this is a note kept in FireTrident's recorded results/);
    expect(card.decisions[0]).toEqual({ layer: "proof", kind: "deterministic", action: "land", p: null, by: null });
  });

  it("reads a preview's own colony first when the address names one", () => {
    expect(noteColonies("?note=preview-notes")).toEqual(["preview-notes", ...NOTE_COLONIES]);
    expect(noteColonies("?note=hono")).toEqual(["hono", "byo-demo", "shortlinks"]);
    for (const bad of ["", "?note=", "?note=Not_A_Colony", "?note=../x"]) expect(noteColonies(bad)).toEqual([...NOTE_COLONIES]);
  });
});

describe("the Remember card", () => {
  it("names the two stock-git commands that check the note again, on this page's own server", () => {
    expect(verifyCommands("https://firetrident.com", "byo-demo", SEALED)).toBe(
      "git clone https://firetrident.com/git/byo-demo.git && cd byo-demo && git fetch origin refs/notes/firetrident:refs/notes/firetrident\nnode ../fire_trident/scripts/verify_note.mjs 7ebd0a6f3d66",
    );
    expect(serverOrigin({ protocol: "https:", hostname: "preview.example.workers.dev", origin: "https://preview.example.workers.dev" })).toBe("https://preview.example.workers.dev");
    expect(serverOrigin({ protocol: "http:", hostname: "localhost", origin: "http://localhost:5173" })).toBe("https://firetrident.com");
  });

  it("draws the note under its badge: intent, rule, agent and model, decisions with their probability, checks, files, commands", () => {
    const card = cardOf({ colonyId: "byo-demo", landing: landing("lnd_sealed", SEALED, ["index.js"], Date.now() - 3_600_000), note: NOTE, seal: sealOf(check("lnd_sealed", SEALED, "intact")), agents: new Map([["agt_ext", "docs-agent"]]), live: true });
    const html = renderToStaticMarkup(createElement(NoteCardView, { card, origin: "https://firetrident.com" }));
    for (const part of [
      'class="seal is-intact"',
      "Note intact",
      'href="/c/byo-demo?path=index.js"',
      "7ebd0a6",
      "refs/notes/firetrident · lnd_sealed",
      "Document isPlainObject with a JSDoc comment",
      "Readers of index.js should see what counts as a plain object.",
      "None: the intent was declared directly, not made from a rule.",
      "docs-agent",
      "Model declared by the agent",
      "External agent: the MCP token and its resume key",
      "p 0.89",
      "✓ innate: blobs",
      "✕ deterministic: mechanical proof",
      "Did not run tests or a type check.",
      "9ec755c",
      "→ f2171d1",
      "git clone https://firetrident.com/git/byo-demo.git",
      "node ../fire_trident/scripts/verify_note.mjs 7ebd0a6f3d66",
      "The newest sealed landing on byo-demo, read from its public API as this page loaded.",
    ]) {
      expect(html).toContain(part);
    }
    // The why's first line repeats the title, so only the rest is shown.
    expect(html.match(/Document isPlainObject with a JSDoc comment/g)).toHaveLength(1);
  });

  it("marks the recorded stand-in as recorded and unchecked", () => {
    const html = renderToStaticMarkup(createElement(NoteCardView, { card: recordedCard(), origin: "https://firetrident.com" }));
    expect(html).toContain('class="nc is-recorded"');
    expect(html).toContain('class="seal is-unchecked"');
    expect(html).toContain("No colony answered just now: this note is from FireTrident&#x27;s recorded results, and this page did not check it.");
    expect(html).toContain("2026-10-12");
    expect(html).toContain("approved by <b class=\"nc-approver\">mcp_join</b>");
    expect(html).toContain("no model");
  });
});
