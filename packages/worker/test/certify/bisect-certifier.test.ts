import { describe, expect, it } from "vitest";
import type { Certification, ColonyEvent, Id, Landing, Path, Sha } from "@fire_trident/core";
import { Certifier, type CertifyHost, type CertifyTrunk } from "../../src/certify/certifier.ts";
import { MAIN_MODULE, type Plan } from "../../src/certify/plan.ts";
import type { LandingRange, RangeQuery } from "../../src/certify/range.ts";
import type { RepairIntentInput } from "../../src/certify/repair.ts";
import { runPlanInNode } from "./harness.ts";

/**
 * The first red search (FT_BISECT) end to end in Node: the certifier records a red result, then searches the trunk's
 * landing log in the background, running each plan it loads with the real harness and node:test shim in a Node
 * process. The trunk stand-in keeps every commit's files, a landing per commit with its parent, and a lineage note
 * naming each landing's proposals.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A blob id that follows the content (FNV-1a and the length). */
function blobOf(text: string): Sha {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${h.toString(16).padStart(8, "0")}${text.length.toString(16)}`;
}

/** One proposal of a landing, as its lineage note names it. */
interface NoteProposal {
  id: Id;
  intent: { id: Id; title: string };
  writeSet: Array<{ path: Path; blob: Sha | null }>;
}

/** A trunk of file texts with a landing log: each commit is one landing on the one before, its note naming its proposals. */
class Trunk implements CertifyTrunk {
  sha: Sha = "";
  readonly files = new Map<Path, string>();
  readonly certified: Sha[] = [];
  readonly landings: Landing[] = [];
  readonly notes = new Map<Id, { proposals: NoteProposal[] }>();
  /** Make landingRange throw (an error the search must survive). */
  rangeFails = false;
  /** baseBlobs() calls, to count what the search read. */
  blobCalls = 0;
  private readonly blobs = new Map<Sha, string>();
  private readonly history = new Map<Sha, Map<Path, Sha>>();
  private n = 0;

  /** One commit (a landing) whose proposals each write some of `changes`; null deletes. Returns the landing. */
  commit(changes: Record<Path, string | null>, proposals: Array<{ id: Id; intentId: Id; title: string; paths: Path[] }> = []): Landing {
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) this.files.delete(path);
      else {
        this.files.set(path, text);
        this.blobs.set(blobOf(text), text);
      }
    }
    const parent = this.sha;
    this.sha = (++this.n).toString(16).padStart(40, "0");
    this.history.set(this.sha, new Map([...this.files].map(([path, text]) => [path, blobOf(text)])));
    const landing: Landing = {
      id: `lnd_${this.n}`,
      colonyId: "col",
      trunkSha: this.sha,
      parentSha: parent,
      proposalIds: proposals.map((p) => p.id),
      intentIds: [...new Set(proposals.map((p) => p.intentId))],
      paths: Object.keys(changes).sort(),
      regions: [],
      at: this.n,
    };
    this.landings.push(landing);
    const writeOf = (path: Path) => ({ path, blob: changes[path] === null || changes[path] === undefined ? null : blobOf(changes[path]!) });
    this.notes.set(landing.id, { proposals: proposals.map((p) => ({ id: p.id, intent: { id: p.intentId, title: p.title }, writeSet: p.paths.map(writeOf) })) });
    return landing;
  }

  async baseBlobs(sha: Sha, paths: Path[]): Promise<Array<{ path: Path; blob: Sha | null }>> {
    this.blobCalls++;
    const at = this.history.get(sha);
    return paths.map((path) => ({ path, blob: at?.get(path) ?? null }));
  }

  async certifySnapshot(): Promise<{ trunkSha: Sha; landingId: Id | null; files: Array<{ path: Path; blob: Sha; size: number }>; truncated: boolean }> {
    const files = [...this.files].filter(([path]) => /\.(ts|js|mjs|json)$/.test(path)).map(([path, text]) => ({ path, blob: blobOf(text), size: text.length }));
    return { trunkSha: this.sha, landingId: this.landings.at(-1)?.id ?? null, files, truncated: false };
  }

  async readBlobs(blobs: Sha[]): Promise<Record<Sha, string | null>> {
    return Object.fromEntries(blobs.map((b) => [b, this.blobs.get(b) ?? null]));
  }

  async annotate(): Promise<boolean> {
    return true;
  }

  async markCertified(sha: Sha): Promise<boolean> {
    this.certified.push(sha);
    return true;
  }

  /** The landing log's range, as the trunk writer reads it (certify/range.ts): parent by parent from the red commit. */
  async landingRange(q: RangeQuery): Promise<LandingRange> {
    if (this.rangeFails) throw new Error("the trunk writer is busy");
    const out: Landing[] = [];
    let at = q.to;
    for (let i = this.landings.length - 1; i >= 0 && at !== q.from; i--) {
      const l = this.landings[i]!;
      if (l.trunkSha !== at) continue;
      out.unshift(l);
      at = l.parentSha;
    }
    if (at !== q.from) return { ok: false, reason: "The landing log does not reach the last green commit." };
    return {
      ok: true,
      landings: out.map((l) => {
        const path = l.paths.find((p) => this.history.get(l.trunkSha)?.has(p));
        return { landingId: l.id, trunkSha: l.trunkSha, at: l.at, ...(path ? { witness: { path, blob: this.history.get(l.trunkSha)!.get(path)! } } : {}) };
      }),
    };
  }

  async landingNote(ref: string): Promise<{ landing: Landing; note: never } | null> {
    const landing = this.landings.find((l) => l.id === ref);
    return landing ? { landing, note: (this.notes.get(ref) ?? null) as never } : null;
  }
}

/** A Worker Loader stand-in that runs what it loads in Node and counts the loads. */
function nodeLoader(): WorkerLoader & { loads: WorkerLoaderWorkerCode[] } {
  const loads: WorkerLoaderWorkerCode[] = [];
  const load = (code: WorkerLoaderWorkerCode): WorkerStub => {
    loads.push(code);
    const entrypoint = { fetch: async () => new Response(JSON.stringify(runPlanInNode({ mainModule: code.mainModule, modules: code.modules } as unknown as Plan))) };
    return { getEntrypoint: () => entrypoint } as unknown as WorkerStub;
  };
  return { loads, load } as unknown as WorkerLoader & { loads: WorkerLoaderWorkerCode[] };
}

/** The test files a loaded harness runs (from its FILES table). */
function harnessFiles(code: WorkerLoaderWorkerCode): Path[] {
  const main = code.modules[MAIN_MODULE] as { js: string };
  return [...main.js.matchAll(/\{ path: ("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]!) as Path);
}

interface Colony {
  certifier: Certifier;
  events: ColonyEvent[];
  declared: RepairIntentInput[];
  /** Each declared repair intent's why as the colony holds it (repairWhy rewrites it). */
  whys: Map<Id, string>;
}

/** A certifier over `trunk` with the first red search on (unless `bisect` is false), repairs on, runs at once. */
function setup(trunk: Trunk, loader: WorkerLoader, bisect = true): Colony {
  let green: Sha | null = null;
  const events: ColonyEvent[] = [];
  const declared: RepairIntentInput[] = [];
  const whys = new Map<Id, string>();
  const host: CertifyHost = {
    sql: sqlStorage(),
    enabled: () => true,
    loader: () => loader,
    trunk: () => trunk,
    publish: (e) => void events.push(...(Array.isArray(e) ? e : [e])),
    exists: () => true,
    greenSha: () => green,
    setGreen: (sha) => {
      green = sha;
    },
    repairs: () => declared.map((_, i) => ({ id: `int_r${i + 1}`, status: "open" as const, createdAt: Date.now() })),
    declare: async (input) => {
      declared.push(input);
      const id = `int_r${declared.length}`;
      whys.set(id, input.why);
      return id;
    },
    satisfy: async () => undefined,
    specFor: () => null,
    ...(bisect ? { bisect: () => true } : {}),
    repairWhy: (id, edit) => {
      const before = whys.get(id);
      const next = before === undefined ? null : edit(before);
      if (next === null || next === before) return false;
      whys.set(id, next);
      return true;
    },
  };
  const certifier = new Certifier(host);
  const set = certifier.setPolicy({ minIntervalMs: 0, repair: true });
  if ("error" in set) throw new Error(set.error);
  return { certifier, events, declared, whys };
}

/** Report the head as landed and wait for its certification. */
async function land(c: Certifier, trunk: Trunk): Promise<Certification> {
  c.landed({ trunkSha: trunk.sha, at: Date.now(), paths: [...trunk.files.keys()] });
  const until = Date.now() + 30_000;
  for (;;) {
    const found = c.get(trunk.sha);
    const state = c.state();
    if (found && found.status !== "running" && !state.running && !state.pending) return found;
    if (Date.now() > until) throw new Error(`no certification of ${trunk.sha} yet`);
    await sleep(20);
  }
}

/** Wait until the result of `sha` carries firstRed. */
async function firstRedOf(c: Certifier, sha: Sha): Promise<Certification> {
  const until = Date.now() + 30_000;
  for (;;) {
    const found = c.get(sha);
    if (found?.firstRed) return found;
    if (Date.now() > until) throw new Error(`no first red for ${sha}: ${JSON.stringify(found)}`);
    await sleep(20);
  }
}

const MATH_OK = "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_BUG = "export function sub(a: number, b: number): number {\n  return a + b;\n}\n";
const MATH_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';
const OTHER_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { name } from "../src/other.ts";\ntest("names", () => {\n  assert.equal(typeof name, "string");\n});\n';

/** The first commit: two source files and their tests, all passing. */
function seed(trunk: Trunk): void {
  trunk.commit({ "src/math.ts": MATH_OK, "test/math.test.ts": MATH_TEST, "src/other.ts": 'export const name = "a";\n', "test/other.test.ts": OTHER_TEST });
}

describe("the first red search (FT_BISECT) in the certifier", () => {
  it("names the landing whose proposal broke the failing tests, on the result, in an event and in the repair intent", async () => {
    const trunk = new Trunk();
    seed(trunk);
    const loader = nodeLoader();
    const colony = setup(trunk, loader);
    const green = await land(colony.certifier, trunk);
    expect(green.status).toBe("green");

    for (let i = 1; i <= 3; i++) trunk.commit({ [`docs/n${i}.md`]: `# ${i}\n`, "src/other.ts": `export const name = "${i}";\n` }, [{ id: `prp_g${i}`, intentId: `int_g${i}`, title: `Good change ${i}`, paths: [`docs/n${i}.md`, "src/other.ts"] }]);
    const broke = trunk.commit({ "src/math.ts": MATH_BUG, "docs/math.md": "# sub\n" }, [
      { id: "prp_docs", intentId: "int_docs", title: "Document subtraction", paths: ["docs/math.md"] },
      { id: "prp_bad", intentId: "int_bad", title: "Speed up subtraction", paths: ["src/math.ts"] },
    ]);
    for (let i = 4; i <= 5; i++) trunk.commit({ [`docs/n${i}.md`]: `# ${i}\n` }, [{ id: `prp_g${i}`, intentId: `int_g${i}`, title: `Good change ${i}`, paths: [`docs/n${i}.md`] }]);

    const loadsBefore = loader.loads.length;
    const red = await land(colony.certifier, trunk);
    expect(red).toMatchObject({ status: "red", greenSha: green.trunkSha, repairIntentId: "int_r1" });

    const done = await firstRedOf(colony.certifier, trunk.sha);
    expect(done.firstRed).toEqual({
      status: "found",
      trunkSha: broke.trunkSha,
      landingId: broke.id,
      intents: [
        { id: "int_docs", title: "Document subtraction" },
        { id: "int_bad", title: "Speed up subtraction" },
      ],
      proposals: [{ id: "prp_bad", intentId: "int_bad", title: "Speed up subtraction", paths: ["src/math.ts"] }],
      files: ["test/math.test.ts"],
      probes: expect.any(Number),
      ms: expect.any(Number),
      landings: 6,
      greenSha: green.trunkSha,
    });
    // Six landings: the red commit, then at most three halvings, each running only the failing test file.
    expect(done.firstRed!.probes).toBeLessThanOrEqual(4);
    const probeLoads = loader.loads.slice(loadsBefore + 1);
    expect(probeLoads.length).toBeLessThanOrEqual(done.firstRed!.probes);
    for (const code of probeLoads) {
      expect(harnessFiles(code)).toEqual(["test/math.test.ts"]);
      expect(code.globalOutbound).toBeNull();
    }
    // Everything else about the result is as it was.
    const { firstRed: _found, ...rest } = done;
    expect(rest).toEqual({ ...red, firstRed: undefined });

    // The result was recorded and published first (its event carries no answer); the bisect event came after the search.
    const certifyAt = colony.events.findIndex((e) => e.t === "certify" && e.trunkSha === trunk.sha && e.status === "red");
    const bisectAt = colony.events.findIndex((e) => e.t === "bisect");
    expect(certifyAt).toBeGreaterThanOrEqual(0);
    expect(bisectAt).toBeGreaterThan(certifyAt);
    expect(Object.keys(colony.events[certifyAt]!)).not.toContain("firstRed");
    expect(colony.events[bisectAt]).toEqual({ t: "bisect", at: expect.any(Number), trunkSha: trunk.sha, firstRed: done.firstRed });

    // The repair intent declared by the red result names it, fenced as data.
    const why = colony.whys.get("int_r1")!;
    expect(why).toContain(`First failing commit: the failing tests first failed at commit ${broke.trunkSha.slice(0, 7)} (landing ${broke.id})`);
    expect(why).toMatch(/\n<<<FIRST RED ([0-9a-f]{12})>>>\n- proposal prp_bad for intent int_bad "Speed up subtraction" changed src\/math\.ts\n<<<END FIRST RED \1>>>\nBuilds on: /);

    // A later red result with the same failing tests since the same green commit takes the answer: nothing runs (the
    // certification reuses its per-file results too, as nothing the tests load changed).
    trunk.commit({ "docs/n6.md": "# 6\n" }, [{ id: "prp_g6", intentId: "int_g6", title: "Good change 6", paths: ["docs/n6.md"] }]);
    const loads = loader.loads.length;
    const again = await land(colony.certifier, trunk);
    expect(again.status).toBe("red");
    const reused = await firstRedOf(colony.certifier, trunk.sha);
    expect(reused.firstRed).toEqual({ ...done.firstRed, reusedFrom: red.trunkSha });
    expect(loader.loads.length).toBe(loads);
  }, 60_000);

  it("is off unless the colony's switch says so: the result never gains firstRed", async () => {
    const trunk = new Trunk();
    seed(trunk);
    const loader = nodeLoader();
    const colony = setup(trunk, loader, false);
    expect((await land(colony.certifier, trunk)).status).toBe("green");
    trunk.commit({ "src/math.ts": MATH_BUG }, [{ id: "prp_bad", intentId: "int_bad", title: "Speed up subtraction", paths: ["src/math.ts"] }]);
    const red = await land(colony.certifier, trunk);
    expect(red.status).toBe("red");
    await sleep(300);
    expect(colony.certifier.get(trunk.sha)?.firstRed).toBeUndefined();
    expect(colony.events.some((e) => e.t === "bisect")).toBe(false);
    expect(loader.loads).toHaveLength(2);
    expect(colony.whys.get("int_r1")).not.toContain("First failing commit");
  }, 60_000);

  it("is inconclusive when the failing tests pass alone on the red commit: a test that fails only after another file ran", async () => {
    const trunk = new Trunk();
    const quiet = 'import { test } from "node:test";\ntest("quiet", () => {});\n';
    const leakFree = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("no leak", () => {\n  assert.equal(typeof (globalThis as { leaked?: unknown }).leaked, "undefined");\n});\n';
    trunk.commit({ "test/a.test.ts": quiet, "test/b.test.ts": leakFree });
    const colony = setup(trunk, nodeLoader());
    expect((await land(colony.certifier, trunk)).status).toBe("green");
    // a now leaks a global that b checks for; both change, so both run in one Worker, a first.
    trunk.commit({ "test/a.test.ts": `${quiet}(globalThis as { leaked?: unknown }).leaked = 1;\n`, "test/b.test.ts": `${leakFree}// touched\n` }, [
      { id: "prp_leak", intentId: "int_leak", title: "Leak", paths: ["test/a.test.ts", "test/b.test.ts"] },
    ]);
    const red = await land(colony.certifier, trunk);
    expect(red.failing?.map((f) => f.name)).toEqual(["no leak"]);
    const done = await firstRedOf(colony.certifier, trunk.sha);
    expect(done.firstRed).toEqual({
      status: "inconclusive",
      reason: `The failing tests passed when run alone on the red commit ${trunk.sha.slice(0, 7)}: they may be flaky or depend on other test files.`,
      probes: 1,
      ms: expect.any(Number),
      landings: 1,
      greenSha: red.greenSha,
    });
    // An inconclusive answer leaves the repair intent as it was.
    expect(colony.whys.get("int_r1")).not.toContain("First failing commit");
  }, 60_000);

  it("fails open: an error, or no green commit to start from, leaves the result as it was with an inconclusive firstRed", async () => {
    const trunk = new Trunk();
    trunk.commit({ "src/math.ts": MATH_BUG, "test/math.test.ts": MATH_TEST });
    const colony = setup(trunk, nodeLoader());
    const never = await land(colony.certifier, trunk);
    expect(never.status).toBe("red");
    expect((await firstRedOf(colony.certifier, trunk.sha)).firstRed).toMatchObject({ status: "inconclusive", reason: "Trunk has not been certified green yet, so there is no commit to search from.", probes: 0 });

    trunk.commit({ "src/math.ts": MATH_OK }, [{ id: "prp_fix", intentId: "int_fix", title: "Fix", paths: ["src/math.ts"] }]);
    expect((await land(colony.certifier, trunk)).status).toBe("green");
    trunk.commit({ "src/math.ts": MATH_BUG }, [{ id: "prp_bad", intentId: "int_bad", title: "Break", paths: ["src/math.ts"] }]);
    trunk.rangeFails = true;
    const red = await land(colony.certifier, trunk);
    const done = await firstRedOf(colony.certifier, trunk.sha);
    expect(done.firstRed).toMatchObject({ status: "inconclusive", reason: "The landing log could not be read: the trunk writer is busy", probes: 0 });
    expect(done).toEqual({ ...red, firstRed: done.firstRed });
  }, 60_000);
});
