import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { blobId } from "@fire_trident/core";
import type { Proposal, Sha } from "@fire_trident/core";
import { OUT, sceneJson } from "../../../scripts/gitmerge_scene.mjs";
import { movedReturn, type SqlRunner } from "../../worker/src/colony/movedby.ts";
import { fetchReturnHunks, quoteHunks, quotedSentence } from "../../worker/src/colony/returnhunks.ts";
import { quoteReturns } from "../../worker/src/trunk/quote.ts";
import { GitMergeScene, TryIt } from "../src/landing/TryIt.tsx";
import { GITMERGE, GM_AGENT, GM_INTENT, GM_LANDING, gitMergeScene, twinOf, type TwinId } from "../src/landing/gitmerge.ts";
import { short } from "../src/landing/tryit.ts";

/**
 * "Git would have merged this", the fifth scene of the Try panel: its data is what scripts/gitmerge_scene.mjs computes
 * with stock git (a clean merge and a program that fails, or runs, on the merged trunk), the FireTrident side the page
 * runs agrees with the script's run of the core's read-set validation, and the return it shows is the one the colony's
 * own return code writes for the same facts, naming the file B read and the landing that moved it, with its diff quoted.
 */

/** The part of node:sqlite these tests use. */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

/** Text as React writes it into HTML. */
const html = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

const PRICE = "src/price.ts";
const scene = (id: TwinId) => renderToStaticMarkup(createElement(GitMergeScene, { initial: id }));

/**
 * The colony and trunk writer after A's landing, as the worker's own return-hunk tests build them: the tables movedBy
 * reads (landing lnd_rename wrote A's files for int_rename, by agt_a, at trunk commit `commit`) and a trunk writer that
 * knows each file's text before and after that landing. Then B's return goes through movedReturn, fetchReturnHunks
 * (the trunk writer's quoteReturns) and quoteHunks, as ColonyDO settles it.
 */
async function colonyReturn(reason: string, stalePaths: string[], commit: Sha): Promise<Proposal> {
  const db = new DatabaseSync(":memory:");
  const sql: SqlRunner = { exec: (q, ...b) => ({ toArray: () => db.prepare(q).all(...b) }) };
  const run = (q: string, ...b: unknown[]): void => void db.prepare(q).run(...b);
  run("CREATE TABLE landings (id TEXT PRIMARY KEY, at INTEGER NOT NULL, received_at INTEGER NOT NULL, trunk_sha TEXT NOT NULL, data TEXT NOT NULL)");
  run("CREATE TABLE landing_paths (path TEXT NOT NULL, at INTEGER NOT NULL, landing_id TEXT NOT NULL, intent_id TEXT, PRIMARY KEY (path, at, landing_id))");
  run("CREATE TABLE intents (id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL)");
  run("CREATE TABLE proposals (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, agent_id TEXT NOT NULL, data TEXT NOT NULL)");
  run("CREATE TABLE agents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, model TEXT)");
  run("INSERT INTO intents (id, title, why) VALUES (?, ?, ?)", GM_INTENT, GITMERGE.a.title, "One name for every amount the shop prints.");
  run("INSERT INTO proposals (id, intent_id, agent_id, data) VALUES (?, ?, ?, ?)", "prp_rename", GM_INTENT, GM_AGENT, JSON.stringify({ evidence: { checks: [] } }));
  run("INSERT INTO agents (id, kind, model) VALUES (?, ?, ?)", GM_AGENT, "external", null);
  run("INSERT INTO landings (id, at, received_at, trunk_sha, data) VALUES (?, ?, ?, ?, ?)", GM_LANDING, 2_000, 2_000, commit, JSON.stringify({ id: GM_LANDING, proposalIds: ["prp_rename"] }));
  const texts = new Map<Sha, string>();
  const files = new Map<string, [Sha, Sha]>();
  for (const [path, after] of Object.entries(GITMERGE.a.writes)) {
    const before = GITMERGE.base.files[path] ?? "";
    texts.set(blobId(before), before);
    texts.set(blobId(after), after);
    files.set(path, [blobId(before), blobId(after)]);
    run("INSERT INTO landing_paths (path, at, landing_id, intent_id) VALUES (?, ?, ?, ?)", path, 2_000, GM_LANDING, GM_INTENT);
  }
  const b: Proposal = {
    id: "prp_receipt",
    colonyId: "c",
    intentId: "int_receipt",
    agentId: "agt_b",
    workspace: { namespace: "ft-ws-0", name: "c--ws-1", remote: "https://example.invalid/ws.git" },
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    writeSet: [],
    readSet: [],
    declared: { footprint: [], summary: "receipt" },
    evidence: { checks: [] },
    status: "ready",
    createdAt: 0,
  };
  const stale = stalePaths.map((path) => ({ path }));
  const patch: Partial<Proposal> = { status: "returned", reason };
  const quoted = await fetchReturnHunks(
    {
      sql,
      proposal: (id) => (id === b.id ? b : null),
      quote: (q) =>
        quoteReturns(
          {
            landingPath: (landingId, path) => {
              const f = files.get(path);
              return landingId === GM_LANDING && f ? { trunkSha: commit, before: f[0], after: f[1] } : null;
            },
            read: async (blob) => texts.get(blob) ?? null,
            now: () => Date.now(),
          },
          q,
        ),
    },
    [{ id: b.id, patch, stale }],
  );
  const next: Proposal = { ...b, ...patch };
  const moved = movedReturn(sql, next, stale);
  if (moved) Object.assign(next, moved);
  quoteHunks(next, quoted);
  return next;
}

describe("the scene's data", () => {
  it("is what scripts/gitmerge_scene.mjs computes now, with stock git and the core", { timeout: 60_000 }, () => {
    expect(readFileSync(OUT, "utf8"), "packages/web/src/landing/gitmerge.json is stale: run node scripts/gitmerge_scene.mjs").toBe(sceneJson());
  });

  it("starts both agents from one trunk: A rewrites price.ts and its two callers, B adds receipt.ts and touches no file A does", () => {
    expect(Object.keys(GITMERGE.a.writes)).toEqual([PRICE, "src/cart.ts", "src/invoice.ts"]);
    expect(GITMERGE.a.writes[PRICE]).toContain("export function formatAmount(");
    for (const t of GITMERGE.twins) {
      expect(t.git.a).toEqual(["src/cart.ts", "src/invoice.ts", PRICE]);
      expect(t.git.b).toEqual(["src/main.ts", "src/receipt.ts"]);
      expect(t.git.both).toEqual([]);
    }
    expect(twinOf("catch").b.writes["src/receipt.ts"]).toContain('import { formatPrice } from "./price.ts";');
    expect(twinOf("catch").b.read).toContain(PRICE);
    expect(twinOf("control").b.writes["src/receipt.ts"]).toContain('import { formatDate } from "./date.ts";');
    expect(twinOf("control").b.read).not.toContain(PRICE);
  });
});

describe("the catch: B calls the function A renamed", () => {
  const t = twinOf("catch");
  const out = gitMergeScene("catch");
  const was = blobId(GITMERGE.base.files[PRICE]!);
  const now = blobId(GITMERGE.a.writes[PRICE]!);

  it("merges cleanly in stock git, and the merged program fails because formatPrice no longer exists", () => {
    expect(t.git).toMatchObject({ clean: true, conflicts: [] });
    expect(t.git.run).toEqual({ command: "node src/main.ts", ok: false, exit: 1, stdout: "", error: "SyntaxError: The requested module './price.ts' does not provide an export named 'formatPrice'", at: "src/receipt.ts:1" });
    expect(out.git.merge).toEqual({ kind: "lands", sentence: "After A, git merge agent-b merges with no conflict: A changed src/cart.ts, src/invoice.ts and src/price.ts, B changed src/main.ts and src/receipt.ts, and no file is in both." });
    expect(out.git.run).toEqual({ kind: "fails", sentence: "node src/main.ts on the merged trunk fails before printing anything, at src/receipt.ts:1:", output: t.git.run!.error });
  });

  it("lands A and sends B back stale on src/price.ts, the file it read, as the script's run of validateProposal did", () => {
    expect(out.a.kind).toBe("lands");
    expect(out.a.occ).toEqual({ eligible: true, stale: [] });
    expect(out.a.sentence).toBe(`A lands first: the files it read (src/cart.ts, src/invoice.ts and src/price.ts) are still the versions it read, so its read set holds; landing ${GM_LANDING} makes trunk commit ${t.fireTrident.a.commit!.slice(0, 7)}.`);
    expect(out.b.kind).toBe("back");
    // The page's blob ids, computed from the texts, are git's: the script's run used git's own.
    expect(out.b.occ).toEqual({ eligible: false, stale: [{ path: PRICE, expected: was, actual: now }] });
    expect(t.fireTrident.b).toEqual({ eligible: false, stale: out.b.occ.stale, textMerge: false, commit: null });
    expect(t.fireTrident.a).toMatchObject({ eligible: true, stale: [], textMerge: null });
  });

  it("names the landing that moved it and quotes that landing's diff, exactly as the colony's return code writes it", async () => {
    // The script found the landing with git log over the file B read: A's.
    expect(t.fireTrident.moved).toEqual([{ commit: t.fireTrident.a.commit, change: "a", paths: [PRICE] }]);
    const reason = `stale: ${PRICE} (expected ${short(was)}, trunk has ${short(now)})`;
    const colony = await colonyReturn(reason, [PRICE], t.fireTrident.a.commit!);
    expect(out.b.sentence).toBe(`B goes back to its agent: ${colony.reason}`);
    expect(colony.reason).toBe(
      `${reason}. Landing ${GM_LANDING} (commit ${t.fireTrident.a.commit!.slice(0, 7)}, intent ${GM_INTENT}, agent ${GM_AGENT}) moved it. Keep what that landing did unless your intent says otherwise, and escalate if both cannot hold. ${quotedSentence(true, false)}`,
    );
    // The quote the page shows is the trunk writer's (quoteReturns: diffed, cut and masked), on the same landing and file.
    const strip = (m: NonNullable<Proposal["movedBy"]>[number]) => ({ landingId: m.landingId, paths: m.paths, trunkSha: m.trunkSha, intentId: m.intentId, agentId: m.agentId, hunks: m.hunks });
    expect(out.moved.map(strip)).toEqual(colony.movedBy!.map(strip));
    expect(out.moved[0]!.hunks).toEqual([{ path: PRICE, trunkSha: t.fireTrident.a.commit, diff: t.fireTrident.quoted[0]!.diff, truncated: false }]);
    expect(t.fireTrident.quoted[0]!.diff).toContain("-export function formatPrice(cents: number): string {\n+export function formatAmount(cents: number): string {");
  });

  it("leaves a trunk the program runs on", () => {
    expect(t.fireTrident.run).toMatchObject({ ok: true, stdout: "Tea: $4.50\nTotal due: $12.50\n", error: null });
    expect(out.run).toEqual({ kind: "lands", sentence: "node src/main.ts on trunk, with A landed and B back with its agent, runs and prints:", output: "Tea: $4.50\nTotal due: $12.50" });
  });
});

describe("the control: B calls a function nobody touched", () => {
  const t = twinOf("control");
  const out = gitMergeScene("control");

  it("merges in stock git and runs", () => {
    expect(t.git).toMatchObject({ clean: true, conflicts: [] });
    expect(t.git.run).toMatchObject({ ok: true, stdout: "Tea: $4.50\nTotal due: $12.50\nReceipt: Tea, 2026-10-21\n", error: null });
    expect(out.git.run?.kind).toBe("lands");
  });

  it("lands both in FireTrident, with no return, and the program runs on that trunk as it does on git's", () => {
    expect(out.a.kind).toBe("lands");
    expect(out.b).toMatchObject({ kind: "lands", occ: { eligible: true, stale: [] } });
    expect(out.b.sentence).toBe(
      `B lands next: the files it read (src/date.ts and src/main.ts) are still the versions it read, since landing ${GM_LANDING} moved none of them, so its read set holds; landing lnd_receipt makes trunk commit ${t.fireTrident.b.commit!.slice(0, 7)}.`,
    );
    expect(out.moved).toEqual([]);
    expect(t.fireTrident).toMatchObject({ b: { eligible: true, stale: [], commit: expect.stringMatching(/^[0-9a-f]{40}$/) }, moved: [], quoted: [] });
    expect(t.fireTrident.run).toEqual(t.git.run);
    expect(out.run.sentence).toBe("node src/main.ts on trunk, with A landed and B landed, runs and prints:");
  });
});

describe("the panel", () => {
  const page = renderToStaticMarkup(createElement(TryIt));

  it("shows the fifth scene after the other four, on the catch, git and FireTrident side by side", () => {
    const at = (id: string) => page.indexOf(`id="try-${id}"`);
    expect(at("gitmerge")).toBeGreaterThan(at("twins"));
    expect(at("twins")).toBeGreaterThan(0);
    expect(page).toContain('<h3 class="tr-name">Git would have merged this</h3>');
    expect(page).toContain("<code>scripts/gitmerge_scene.mjs</code>");
    const out = gitMergeScene("catch");
    const fifth = page.slice(at("gitmerge"));
    expect(fifth.indexOf("Stock git")).toBeGreaterThan(0);
    expect(fifth.indexOf("FireTrident")).toBeGreaterThan(fifth.indexOf("Stock git"));
    for (const s of [out.git.merge.sentence, out.git.run!.sentence, out.git.run!.output, out.a.sentence, out.b.sentence, out.run.sentence]) expect(fifth).toContain(html(s));
    expect(fifth).toContain(`Quoted with the return: what landing ${GM_LANDING} changed in ${PRICE}`);
    expect(fifth).toContain(`<span class="tr-del">${html("-export function formatPrice(cents: number): string {")}`);
    expect(fifth).toContain(`<span class="tr-add">${html("+export function formatAmount(cents: number): string {")}`);
    expect(fifth).toContain('class="tr-result is-failed"');
    expect(fifth).toContain('aria-pressed="true">B calls the renamed function</button>');
    expect(fifth).toContain(html("src/receipt.ts (new file)"));
    // The file each change turns on is open; the rest fold.
    expect(fifth).toContain("<summary>2 more files: src/cart.ts, src/invoice.ts</summary>");
    expect(fifth).toContain("<summary>1 more file: src/main.ts</summary>");
  });

  it("shows the control twin with both landed and no quote", () => {
    const control = scene("control");
    const out = gitMergeScene("control");
    expect(control).toContain('aria-pressed="true">B calls an untouched function</button>');
    expect(control).toContain(html(out.b.sentence));
    expect(control).not.toContain("Quoted with the return");
    expect(control).not.toContain("is-failed");
    expect(control).not.toContain("is-held");
    expect(control).toContain(html("Receipt: Tea, 2026-10-21"));
  });
});
