import { describe, expect, it } from "vitest";
import type { Certification, Landing, LineageNote, Path, Sha } from "@fire_trident/core";
import { Certifier, type CertifyHost, type CertifyTrunk } from "../../src/certify/certifier.ts";
import { LandingTestsReader, type LandingTestsTrunk } from "../../src/certify/landingtests.ts";
import type { Plan } from "../../src/certify/plan.ts";
import { runPlanInNode } from "./harness.ts";

/**
 * A landing's test row over results the real certifier recorded: its runs execute in a real Node process (the harness
 * and the node:test shim the Dynamic Worker gets), it stores each test file's results under its key, and the row finds
 * them by computing the same keys from the trees, so every file is compared and none is "not compared".
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A blob id that follows the content, so an unchanged file keeps its id across commits. */
function blobOf(text: string): Sha {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${h.toString(16).padStart(8, "0")}${text.length.toString(16)}`.padEnd(40, "0");
}

/** A trunk of file texts, one commit per change, with the landing log and notes the row reads. */
class Trunk implements CertifyTrunk, LandingTestsTrunk {
  sha: Sha = "";
  readonly files = new Map<Path, string>();
  private readonly blobs = new Map<Sha, string>();
  private readonly history = new Map<Sha, Map<Path, Sha>>();
  private readonly chain: Sha[] = [];
  private readonly landings = new Map<string, { landing: Landing; note: LineageNote }>();

  commit(changes: Record<Path, string | null>, landingId?: string): Sha {
    const parent = this.sha;
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) this.files.delete(path);
      else {
        this.files.set(path, text);
        this.blobs.set(blobOf(text), text);
      }
    }
    this.sha = (this.chain.length + 1).toString(16).padStart(40, "0");
    this.chain.push(this.sha);
    this.history.set(this.sha, new Map([...this.files].map(([path, text]) => [path, blobOf(text)])));
    if (landingId) {
      const writeSet = Object.entries(changes).map(([path, text]) => ({ path, blob: text === null ? null : blobOf(text) }));
      const landing: Landing = { id: landingId, colonyId: "col", trunkSha: this.sha, parentSha: parent, proposalIds: ["prp_1"], intentIds: ["int_1"], paths: Object.keys(changes), regions: [], at: this.chain.length };
      const gate = { name: "gate", ok: true, ms: 0, detail: "L1 innate+llm → land by llm at head 9a7220a8f2f2 (confirmations: innate + llm): approved" };
      const note = {
        schema: "firetrident.lineage/v1",
        landingId,
        colonyId: "col",
        proposals: [{ id: "prp_1", agentId: "agt_1", agentKind: "internal", intent: { id: "int_1", title: "t", why: "w" }, writeSet, readSet: [], decisions: [{ kind: "triage", layer: "llm", p: 0.9, action: "land", by: "@cf/google/gemma-4-26b-a4b-it" }], evidence: { checks: [gate] } }],
      } as unknown as LineageNote;
      this.landings.set(landingId, { landing, note });
    }
    return this.sha;
  }

  async baseBlobs(sha: Sha, paths: Path[]): Promise<Array<{ path: Path; blob: Sha | null }>> {
    const at = this.history.get(sha);
    return paths.map((path) => ({ path, blob: at?.get(path) ?? null }));
  }

  async certifySnapshot(): Promise<{ trunkSha: Sha; landingId: null; files: Array<{ path: Path; blob: Sha; size: number }>; truncated: boolean }> {
    const files = [...this.files].filter(([path]) => /\.(ts|js|mjs|json)$/.test(path)).map(([path, text]) => ({ path, blob: blobOf(text), size: text.length }));
    return { trunkSha: this.sha, landingId: null, files, truncated: false };
  }

  async readBlobs(blobs: Sha[]): Promise<Record<Sha, string | null>> {
    return Object.fromEntries(blobs.map((b) => [b, this.blobs.get(b) ?? null]));
  }

  async annotate(): Promise<boolean> {
    return true;
  }

  async markCertified(): Promise<boolean> {
    return true;
  }

  async landingNote(ref: string): Promise<{ landing: Landing; note: LineageNote | null } | null> {
    return this.landings.get(ref) ?? null;
  }

  async commitOrder(shas: Sha[]): Promise<Record<Sha, number>> {
    return Object.fromEntries(shas.flatMap((s) => (this.chain.includes(s) ? [[s, this.chain.indexOf(s) + 1]] : [])));
  }

  async testLineage(q: { paths: Path[] }): Promise<Record<Path, { changes: []; more: false }>> {
    return Object.fromEntries(q.paths.map((p) => [p, { changes: [], more: false }]));
  }
}

/** Runs what certification loads with the real harness and node:test shim, in a Node process. */
const loader = {
  load: (code: WorkerLoaderWorkerCode) => ({ getEntrypoint: () => ({ fetch: async () => new Response(JSON.stringify(runPlanInNode({ mainModule: code.mainModule, modules: code.modules } as unknown as Plan))) }) }),
} as unknown as WorkerLoader;

function setup(trunk: Trunk): { certifier: Certifier; reader: LandingTestsReader } {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
  let green: Sha | null = null;
  const host: CertifyHost = {
    sql,
    enabled: () => true,
    loader: () => loader,
    trunk: () => trunk,
    publish: () => undefined,
    exists: () => true,
    greenSha: () => green,
    setGreen: (sha) => {
      green = sha;
    },
    repairs: () => [],
    declare: async () => "int_repair",
    satisfy: async () => undefined,
    specFor: () => null,
  };
  const certifier = new Certifier(host);
  const set = certifier.setPolicy({ minIntervalMs: 0, repair: false });
  if ("error" in set) throw new Error(set.error);
  const reader = new LandingTestsReader({
    sql,
    colonyId: () => "col",
    trunk: () => trunk,
    memo: () => certifier.compileMemo(),
    testTimeoutMs: () => certifier.policy().testTimeoutMs,
    off: () => null,
    spend: () => null,
  });
  return { certifier, reader };
}

/** Report the head as landed and wait for its certification. */
async function certify(c: Certifier, trunk: Trunk, paths: Path[]): Promise<Certification> {
  c.landed({ trunkSha: trunk.sha, at: Date.now(), paths });
  const until = Date.now() + 30_000;
  for (;;) {
    const state = c.state();
    const found = c.get(trunk.sha);
    if (found && found.status !== "running" && !state.running && !state.pending) return found;
    if (Date.now() > until) throw new Error(`no certification of ${trunk.sha} yet`);
    await sleep(25);
  }
}

const MATH = "export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_TEST = (names: string[]): string =>
  `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add, sub } from "../src/math.ts";\n${names.map((n) => `test(${JSON.stringify(n)}, () => {\n  assert.equal(add(2, 3) + sub(1, 1), 5);\n});\n`).join("")}`;
const OTHER = 'import { test } from "node:test";\ntest("other", () => {});\n';

describe("a landing's test row over the real certifier's results", () => {
  it("compares every test file by the keys certification stored them under", async () => {
    const trunk = new Trunk();
    trunk.commit({ "src/math.ts": MATH, "test/math.test.ts": MATH_TEST(["adds", "subtracts"]), "test/other.test.ts": OTHER });
    const { certifier, reader } = setup(trunk);
    const c1 = await certify(certifier, trunk, ["src/math.ts", "test/math.test.ts", "test/other.test.ts"]);
    expect(c1).toMatchObject({ status: "green", counts: { tests: 3, pass: 3 } });

    // A landing that changes the code both math tests load, and adds a test: every file is compared, nothing lost.
    trunk.commit({ "src/math.ts": `${MATH}export const zero = 0;\n`, "test/math.test.ts": MATH_TEST(["adds", "subtracts", "multiplies"]) }, "lnd_code");
    const c2 = await certify(certifier, trunk, ["src/math.ts", "test/math.test.ts"]);
    expect(c2).toMatchObject({ status: "green", counts: { tests: 4, pass: 4 } });
    const memo = certifier.compileMemo().size;
    const t = await reader.read("lnd_code");
    // The base tree it read compiled modules of its own: none went into the memo certification runs share.
    expect(certifier.compileMemo().size).toBe(memo);
    expect(t).toMatchObject({ status: "certified", base: { sha: c1.trunkSha, exact: true, pass: 3, tests: 3 }, certified: { sha: c2.trunkSha, pass: 4, tests: 4 }, lost: 0, added: 1 });
    expect(t!.unknownFiles).toBeUndefined();
    expect(t!.reach).toMatchObject({ earlier: 0, own: 1, ownFiles: ["test/math.test.ts"] });
    expect(t!.authors).toEqual({ inherited: { files: 2, tests: 4 }, agents: { files: 0, tests: 0 }, person: { files: 0, tests: 0 } });
    expect(t!.text).toBe("3/3 at base, 4/4 certified, 0 lost, 1 new · proof: model approval (gemma-4-26b-a4b-it)");

    // A landing that drops a test: certification holds it red (lost), so the row is not certified yet.
    trunk.commit({ "test/math.test.ts": MATH_TEST(["adds", "multiplies"]) }, "lnd_drop");
    const c3 = await certify(certifier, trunk, ["test/math.test.ts"]);
    expect(c3.status).toBe("red");
    const dropped = await reader.read("lnd_drop");
    expect(dropped).toMatchObject({ status: "pending", base: { sha: c2.trunkSha, exact: true }, red: { sha: c3.trunkSha } });
    expect(dropped!.text).toMatch(/^not certified yet: trunk is red at [0-9a-f]{7} \(1 of 3 failing\) · proof: model approval/);
  }, 60_000);
});
