import { describe, expect, it } from "vitest";
import { blobId, changesetId, inlineProblem, sha1Hex, utf8Bytes } from "@fire_trident/core";
import type { AgentInfo, Colony, ColonySnapshot, Directive, FileVersion, Id, Intent, Path, Proposal, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { MemoryJournal } from "../../src/agents/journal.ts";
import { FIRST_POLL_MS, TIP_POLL_MS, TIP_WAIT_MS, receiveDirective, tick } from "../../src/agents/loop.ts";
import type { AgentConfig, BaseFile, GitOps, LoopDeps, ModelClient, ModelReply } from "../../src/agents/loop.ts";
import type { ChatMessage } from "../../src/agents/prompt.ts";
import type { ColonyRpc, ProposeInput, TakeResult } from "../../src/agents/rpc.ts";
import { ObjectCache, VirtualReads } from "../../src/agents/virtual.ts";
import { FakeTrunkRepo } from "./trunk-repo.ts";

/**
 * The agent loop with virtual checkouts (FT_VIRTUAL_CHECKOUT): it reads trunk object by object through the binding
 * (a FakeTrunkRepo here), never clones, and proposes its change inline; a change too large or binary for that goes
 * the git way for that change only; restarts resume on the path the job started on; with the flag off nothing
 * changes. The colony's propose is a fake that keeps what it is sent.
 */

const PATTERN: Rule = {
  id: "rul_1",
  colonyId: "col",
  kind: "forbid-pattern",
  spec: { pattern: "console\\.log", hint: "Use logger.info.", replacement: "logger.info" },
  description: "No console.log",
  approvedBy: "t",
  createdAt: 0,
};
const IMPORTS: Rule = {
  id: "rul_2",
  colonyId: "col",
  kind: "forbid-import",
  spec: { from: ["src/**/*.ts"], module: "^\\.\\.?(?:/.*)?(?<!\\.ts|\\.tsx|\\.json)$", hint: "Name the file." },
  description: "Relative imports name their file",
  approvedBy: "t",
  createdAt: 0,
};
const ORIGINAL = "export function f(x: number) {\n  console.log(x);\n  return x;\n}\n";
const FIXED = "export function f(x: number) {\n  logger.info(x);\n  return x;\n}\n";
const FILES: Record<Path, string> = {
  "README.md": "# app\n",
  "docs/guide.md": "guide\n",
  "src/a.ts": ORIGINAL,
  "src/b.ts": "export const b = 1;\n",
  "test/a.test.ts": "import { f } from '../src/a.ts';\n",
};

function intent(over: Partial<Intent> = {}): Intent {
  return { id: "int_1", colonyId: "col", title: "No console.log in src/a.ts", why: "No console.log.", source: "rule", ruleId: PATTERN.id, footprint: ["src/a.ts"], priority: 1, status: "open", createdAt: 0, createdBy: "t", ...over };
}

const lease = (base: Sha): WorkspaceLease => ({
  repo: { namespace: "ft-ws-1", name: "col--ws-1", remote: "https://ws.invalid/col--ws-1.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Number.MAX_SAFE_INTEGER,
  baseSha: base,
  leasedAt: 0,
  trunk: { remote: "https://trunk.invalid/col--trunk.git", token: "fixture-trunk", sha: base },
});

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

class FakeColony implements ColonyRpc {
  intents: Intent[] = [intent()];
  rules: Rule[] = [PATTERN];
  proposals = new Map<Id, Proposal & { contents?: Record<Sha, string> }>();
  proposeCalls = 0;
  abandoned: string[] = [];
  hangAfterPropose = false;
  /** Refuse the next proposal that carries contents, as a colony that will not take the inline form. */
  refuseInline = false;
  constructor(public lease: WorkspaceLease) {}
  async getColony(): Promise<Colony | null> {
    return null;
  }
  async snapshot(): Promise<ColonySnapshot> {
    return { rules: this.rules } as unknown as ColonySnapshot;
  }
  async addIntent(): Promise<Intent> {
    throw new Error("not used");
  }
  async registerAgent(): Promise<AgentInfo> {
    throw new Error("not used");
  }
  async registerAgents(): Promise<AgentInfo[]> {
    throw new Error("not used");
  }
  async getAgent(): Promise<AgentInfo | null> {
    return null;
  }
  async take(agentId: Id): Promise<TakeResult> {
    const i = this.intents.find((x) => x.status === "claimed" && x.assignedTo === agentId) ?? this.intents.find((x) => x.status === "open");
    if (!i) return { wait: true, retryInMs: 5000, reason: "no open intents" };
    i.status = "claimed";
    i.assignedTo = agentId;
    const rule = this.rules.find((r) => r.id === i.ruleId);
    return rule ? { intent: { ...i }, lease: this.lease, rule } : { intent: { ...i }, lease: this.lease };
  }
  async heartbeat(): Promise<void> {}
  async propose(p: ProposeInput): Promise<Proposal> {
    this.proposeCalls++;
    if (this.refuseInline && p.contents) {
      this.refuseInline = false;
      throw new Error("[ft:400] contents: inline changes are not accepted here");
    }
    const id = `prp_${this.proposals.size + 1}`;
    const proposal = { ...p, id, status: "ready" as const, createdAt: 0, evidence: { checks: p.evidence?.checks ?? [], notVerified: p.evidence?.notVerified ?? "" } };
    this.proposals.set(id, proposal);
    if (this.hangAfterPropose) return never();
    return proposal;
  }
  async getProposal(id: Id): Promise<Proposal | null> {
    return this.proposals.get(id) ?? null;
  }
  async inbox(agentId: Id): Promise<Proposal[]> {
    return [...this.proposals.values()].filter((p) => p.agentId === agentId).reverse();
  }
  async getRule(id: Id): Promise<Rule | null> {
    return this.rules.find((r) => r.id === id) ?? null;
  }
  async abandon(_agentId: Id, reason?: string): Promise<void> {
    this.abandoned.push(reason ?? "");
    for (const i of this.intents) if (i.status === "claimed") i.status = "open";
  }
  settle(id: Id, status: Proposal["status"]): void {
    const p = this.proposals.get(id)!;
    p.status = status;
    const i = this.intents.find((x) => x.id === p.intentId);
    if (i) i.status = status === "landed" ? "landed" : "open";
  }
  only(): Proposal & { contents?: Record<Sha, string> } {
    expect(this.proposals.size).toBe(1);
    return [...this.proposals.values()][0]!;
  }
}

/** The agent's clone: every call is recorded, so a test can see that a virtual job never reads through it. */
class CloneGit implements GitOps {
  calls: string[] = [];
  pushes: Sha[] = [];
  constructor(private readonly files: () => Record<Path, string>) {}
  async ensureBase(p: { baseSha: Sha }): Promise<{ baseSha: Sha; fallback: boolean }> {
    this.calls.push(`ensureBase ${p.baseSha.slice(0, 7)}`);
    return { baseSha: p.baseSha, fallback: false };
  }
  async listFiles(): Promise<string[]> {
    this.calls.push("listFiles");
    return Object.keys(this.files());
  }
  async readFile(_base: Sha, path: string): Promise<BaseFile | null> {
    this.calls.push(`readFile ${path}`);
    const c = this.files()[path];
    return c === undefined ? null : { blob: blobId(c), mode: "100644", bytes: utf8Bytes(c) };
  }
  async commit(p: Parameters<GitOps["commit"]>[0]): Promise<{ headSha: Sha; writeSet: FileVersion[] }> {
    this.calls.push("commit");
    const writeSet = p.changes.map((c) => ({ path: c.path, blob: blobId(c.content) }));
    return { headSha: sha1Hex(utf8Bytes(JSON.stringify([p.baseSha, p.message, p.timestamp, writeSet]))), writeSet };
  }
  async push(p: { headSha: Sha }): Promise<void> {
    this.calls.push("push");
    this.pushes.push(p.headSha);
  }
}

class FakeModel implements ModelClient {
  calls: ChatMessage[][] = [];
  gate: Promise<void> | null = null;
  constructor(public replies: string[] = []) {}
  async complete(p: { messages: ChatMessage[] }): Promise<ModelReply> {
    this.calls.push(p.messages);
    if (this.gate) await this.gate;
    return { text: this.replies.shift() ?? `<file>\n${FIXED}</file>` };
  }
}

function setup(o: { kind?: "internal" | "synthetic"; on?: boolean; files?: Record<Path, string>; replies?: string[] } = {}) {
  const repo = new FakeTrunkRepo();
  let files = { ...(o.files ?? FILES) };
  const base = repo.commit(files);
  const journal = new MemoryJournal();
  const colony = new FakeColony(lease(base));
  const git = new CloneGit(() => files);
  const model = new FakeModel(o.replies ?? []);
  const metrics: Array<Record<string, unknown>> = [];
  const trunkAsked: Path[][] = [];
  const trunk = { blobsFor: async (paths: Path[]) => (trunkAsked.push(paths), Object.fromEntries(paths.map((p) => [p, files[p] === undefined ? null : blobId(files[p]!)]))) };
  let t = 1_000_000;
  const cfg: AgentConfig = { colonyId: "col", agentId: "agt_1", name: "a1", kind: o.kind ?? "internal", model: "@cf/test/model", running: true, epoch: 1, startedAt: 0, failures: 0 };
  journal.setConfig(cfg);
  let reads = new VirtualReads(repo, new ObjectCache());
  const deps = (over: Partial<LoopDeps> & { on?: boolean } = {}): LoopDeps => {
    const { on, ...rest } = over;
    return { colony, git, model, journal, trunk, now: () => t, rand: () => 0.5, metric: (r) => metrics.push(r), virtual: { on: on ?? o.on ?? true, reads }, ...rest };
  };
  return {
    repo,
    base,
    journal,
    colony,
    git,
    model,
    metrics,
    trunkAsked,
    deps,
    advance: (ms: number) => (t += ms),
    now: () => t,
    /** A new isolate: the shared object cache starts empty. */
    restart: () => (reads = new VirtualReads(repo, new ObjectCache())),
    /** Land files on trunk: a new commit becomes main (the clone sees them too). */
    land: (changed: Record<Path, string>) => {
      files = { ...files, ...changed };
      return repo.commit(files);
    },
  };
}

const user = (m: ChatMessage[]): string => m.find((x) => x.role === "user")?.content ?? "";
const settleTurns = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("virtual checkouts in the agent loop", () => {
  it("reads through the trunk repo, never clones, and proposes the change inline", async () => {
    const s = setup();
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.git.calls).toEqual([]);
    expect(user(s.model.calls[0]!)).toContain(ORIGINAL);

    const p = s.colony.only();
    const writeSet = [{ path: "src/a.ts", blob: blobId(FIXED) }];
    expect(p).toMatchObject({
      workspace: s.colony.lease.repo,
      baseSha: s.base,
      headSha: changesetId(s.base, writeSet),
      writeSet,
      readSet: [{ path: "src/a.ts", blob: blobId(ORIGINAL) }],
      contents: { [blobId(FIXED)]: FIXED },
    });
    expect(Object.keys(p.contents!)).toEqual([blobId(FIXED)]);
    expect(inlineProblem(p.writeSet, p.contents!)).toBeNull();
    // The commit, then the root and src trees on the way to src/a.ts, then its blob; the produce step's re-read is cached.
    expect(s.repo.takeCalls()).toEqual({ commit: 1, tree: 2, blob: 1, tip: 0 });
    expect(s.repo.treeReads).not.toContain(s.repo.treeAt(s.base, "docs"));
    expect(s.trunkAsked).toEqual([]);

    // Nine asks: the commit (fetch), commit, two trees and the blob (read), the same again (produce): four calls.
    expect(p.evidence.checks.find((c) => c.name === "agent virtual checkout")!.detail).toBe(
      "4 object read(s) from the trunk repo (0.6 KB), 5 from cache; proposed inline (1 file(s), no clone, commit or push)",
    );
    expect(p.evidence.checks.some((c) => c.name === "agent git transfer")).toBe(false);
    expect(s.journal.job()).toMatchObject({ step: "await", checkout: "virtual", inline: true, headSha: p.headSha });
    expect(s.journal.counters().pushed).toBeUndefined();

    s.colony.settle(p.id, "landed");
    await tick(s.deps());
    expect(s.metrics[0]).toMatchObject({ outcome: "landed", checkout: "virtual", inline: true, inlineSkipped: null, objectReads: 4, objectHits: 5, fetchMs: null, pushMs: null });
  });

  it("fixes an import rule, loading only the directories the specifiers point at", async () => {
    const x = "import { a } from './a'\nimport { d } from './d'\n";
    const fixed = "import { a } from './a.ts'\nimport { d } from './d/index.ts'\n";
    const s = setup({
      files: { "src/x.ts": x, "src/a.ts": "", "src/d/index.ts": "", "docs/guide.md": "g\n", "test/x.test.ts": "t\n" },
      replies: ["<edits>\n2: ./d => ./e/index.ts\n</edits>", "<edits>\n1: ./a => ./a.ts\n2: ./d => ./d/index.ts\n</edits>"],
    });
    s.colony.rules = [IMPORTS];
    s.colony.intents = [intent({ title: "Imports in src/x.ts", ruleId: IMPORTS.id, footprint: ["src/x.ts"] })];
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    const prompt = user(s.model.calls[0]!);
    expect(prompt).toContain(`"./d" resolves to "./d/index.ts" (src/d is a directory, so the import names its index file)`);
    expect(prompt).toContain("src/d/: index.ts");
    // A path the tree does not hold goes back to the model, answered from the loaded directories.
    expect(s.model.calls[1]![3]!.content).toContain(`line 2: "./e/index.ts" names no file in the trunk tree (existing: "./d/index.ts")`);
    const p = s.colony.only();
    expect(p.contents).toEqual({ [blobId(fixed)]: fixed });
    expect(p.headSha).toBe(changesetId(s.base, [{ path: "src/x.ts", blob: blobId(fixed) }]));
    expect(s.git.calls).toEqual([]);
    for (const dir of ["docs", "test"]) expect(s.repo.treeReads).not.toContain(s.repo.treeAt(s.base, dir));
  });

  it("writes a spec intent: waits on the trunk repo, reads what it builds on and the modules it imports, by id", async () => {
    const TYPES = "export type Handler = (request: Request) => Promise<Response>;\n";
    const HTTP = "export function error(status: number): Response {\n  return new Response(null, { status });\n}\n";
    const ROUTER = 'import { error } from "./http.ts";\nimport type { Handler } from "./types.ts";\nexport function createRouter(routes: Handler[]): Handler[] {\n  void error;\n  return routes;\n}\n';
    const TEST = 'import { test } from "node:test";\nimport { createRouter } from "../src/router.ts";\ntest("r", () => void createRouter([]));\n';
    const s = setup({ files: { "README.md": "# app\n", "src/types.ts": TYPES }, replies: [`<file>\n${ROUTER}</file>`, `<file>\n${TEST}</file>`] });
    s.colony.rules = [];
    s.colony.intents = [
      intent({ id: "int_r", title: "Router", source: "human", ruleId: undefined, footprint: ["test/router.test.ts", "src/router.ts"], why: "Route requests.\n\nBuilds on: src/types.ts, src/http.ts\nPlanned files: src/router.ts" }),
    ];

    // src/http.ts is not on trunk yet: the job waits, asking the trunk repo (not the trunk writer).
    expect((await tick(s.deps())).sleepMs).toBeGreaterThan(0);
    expect(s.journal.job()).toMatchObject({ step: "deps", checkout: "virtual", depsMissing: ["src/http.ts"] });
    const tip = s.land({ "src/http.ts": HTTP });
    s.advance(5_000);
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.trunkAsked).toEqual([]);
    expect(s.git.calls).toEqual([]);

    const prompt = user(s.model.calls[0]!);
    expect(prompt).toContain("Project tree at your base commit (3 files):\nREADME.md\nsrc/http.ts\nsrc/types.ts");
    expect(prompt).toContain(HTTP.trim());
    const p = s.colony.only();
    expect(p.baseSha).toBe(tip);
    expect(Object.fromEntries(p.readSet.map((f) => [f.path, f.blob]))).toEqual({ "src/router.ts": null, "test/router.test.ts": null, "src/types.ts": blobId(TYPES), "src/http.ts": blobId(HTTP) });
    expect(p.headSha).toBe(changesetId(tip, p.writeSet));
    expect(p.contents).toEqual({ [blobId(ROUTER)]: ROUTER, [blobId(TEST)]: TEST });
    expect(p.evidence.checks.find((c) => c.name === "write src/router.ts")!.detail).toContain("2 relative import(s) resolve, imported names match the modules' exports");
    expect(p.evidence.notVerified).toContain(`Based on trunk ${tip}`);
  });

  it("lists the first files of a large tree in the prompt, and still finds a module past them", async () => {
    const files: Record<Path, string> = { "zz/late.ts": "export const late = 1;\n" };
    for (let i = 0; i < 450; i++) files[`a/f${String(i).padStart(3, "0")}.ts`] = `export const v${i} = ${i};\n`;
    const USE = 'import { late } from "../zz/late.ts";\nexport const x = late;\n';
    const s = setup({ files, replies: [`<file>\n${USE}</file>`] });
    s.colony.rules = [];
    s.colony.intents = [intent({ title: "Use late", source: "human", ruleId: undefined, footprint: ["src/use.ts"], why: "Use it." })];
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    const prompt = user(s.model.calls[0]!);
    expect(prompt).toContain("Project tree at your base commit (more than 400 files; the first 400 in path order):\na/f000.ts\n");
    expect(prompt).toContain("a/f399.ts\n(and more)");
    expect(prompt).not.toContain("a/f400.ts");
    const p = s.colony.only();
    expect(p.evidence.checks.find((c) => c.name === "write src/use.ts")!.detail).toContain("1 relative import(s) resolve, imported names match the modules' exports");
    expect(p.contents).toEqual({ [blobId(USE)]: USE });
  });

  it("commits and pushes a change too large to go inline, for that change only", async () => {
    const big = "console.log(1);\n".repeat(20_000);
    const s = setup({ kind: "synthetic", files: { ...FILES, "src/big.ts": big } });
    s.colony.intents = [intent({ id: "int_big", title: "No console.log in src/big.ts", footprint: ["src/big.ts"] }), intent({ id: "int_small" })];
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.git.calls).toEqual([`ensureBase ${s.base.slice(0, 7)}`, "commit", "push"]);
    const p = s.colony.only();
    expect(p.contents).toBeUndefined();
    expect(p.headSha).toBe(s.git.pushes[0]);
    expect(p.writeSet).toEqual([{ path: "src/big.ts", blob: blobId(big.replaceAll("console.log", "logger.info")) }]);
    expect(p.readSet).toEqual([{ path: "src/big.ts", blob: blobId(big) }]);
    expect(p.evidence.checks.find((c) => c.name === "agent virtual checkout")!.detail).toMatch(/committed and pushed: src\/big\.ts is 320000 bytes, over the 262144-byte limit/);

    // The next change is small: inline again.
    s.colony.settle(p.id, "landed");
    s.git.calls = [];
    await tick(s.deps());
    const next = [...s.colony.proposals.values()][1]!;
    expect(next.contents).toEqual({ [blobId(FIXED)]: FIXED });
    expect(s.git.calls).toEqual([]);
    expect(s.metrics[0]).toMatchObject({ checkout: "virtual", inline: false, inlineSkipped: expect.stringContaining("over the 262144-byte limit") });
  });

  it("commits and pushes a change with binary content", async () => {
    const binary = `${FIXED}// \u0000\n`;
    const s = setup({ replies: [`<file>\n${binary}</file>`] });
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    const p = s.colony.only();
    expect(p.contents).toBeUndefined();
    expect(s.git.calls).toEqual([`ensureBase ${s.base.slice(0, 7)}`, "commit", "push"]);
    expect(p.evidence.checks.find((c) => c.name === "agent virtual checkout")!.detail).toContain("committed and pushed: src/a.ts is not text (it has a NUL byte)");
  });

  it("commits and pushes the change when the colony refuses its inline form", async () => {
    const s = setup();
    s.colony.refuseInline = true;
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.colony.proposeCalls).toBe(2);
    const p = s.colony.only();
    expect(p.contents).toBeUndefined();
    expect(p.headSha).toBe(s.git.pushes[0]);
    expect(p.evidence.checks.find((c) => c.name === "agent virtual checkout")!.detail).toContain("committed and pushed: the colony refused the inline change: contents: inline changes are not accepted here");
  });

  it("restarts on trunk's tip, read from the repo, when a landing changes its files", async () => {
    const OLD = "export function f() {\n  return 1;\n}\n";
    const NEW = "export function f() {\n  return 1;\n}\nexport const g = 2;\n";
    const WRITTEN = "export function f() {\n  return 3;\n}\nexport const g = 2;\n";
    const s = setup({ files: { "src/a.ts": OLD }, replies: [`<file>\n${WRITTEN}</file>`, `<file>\n${WRITTEN}</file>`] });
    s.colony.rules = [];
    s.colony.intents = [intent({ title: "Make f return 3", source: "human", ruleId: undefined, why: "Callers need 3." })];
    let release!: () => void;
    s.model.gate = new Promise<void>((r) => (release = r));
    const running = tick(s.deps());
    await settleTurns();
    expect(s.model.calls).toHaveLength(1);
    const tip = s.land({ "src/a.ts": NEW });
    const notice: Directive = {
      id: "dir_9",
      colonyId: "col",
      agentId: "agt_1",
      kind: "landing",
      intentId: "int_1",
      message: "Landing lnd_9 changed src/a.ts",
      by: "colony",
      at: s.now(),
      landing: { landingId: "lnd_9", trunkSha: tip, paths: [{ path: "src/a.ts", before: blobId(OLD), after: blobId(NEW) }], intentTitle: "Add g", why: "g is needed" },
    };
    expect(receiveDirective(s.journal, notice, undefined, s.now())).toMatchObject({ interrupted: true });
    s.model.gate = null;
    release();
    expect(await running).toEqual({ sleepMs: null });

    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.repo.calls.tip).toBe(1);
    expect(user(s.model.calls[1]!)).toContain("export const g = 2;");
    const p = s.colony.only();
    expect(p.baseSha).toBe(tip);
    expect(p.readSet).toEqual([{ path: "src/a.ts", blob: blobId(NEW) }]);
    expect(p.headSha).toBe(changesetId(tip, [{ path: "src/a.ts", blob: blobId(WRITTEN) }]));
    expect(s.git.calls).toEqual([]);
  });

  // Asynchronous publishing (FT_ASYNC_PUBLISH): a landing notice can arrive before trunk's tip shows the landing.
  const noticeBeforePublish = async (s: ReturnType<typeof setup>, OLD: string, NEW: string): Promise<void> => {
    s.colony.rules = [];
    s.colony.intents = [intent({ title: "Make f return 3", source: "human", ruleId: undefined, why: "Callers need 3." })];
    let release!: () => void;
    s.model.gate = new Promise<void>((r) => (release = r));
    const running = tick(s.deps());
    await settleTurns();
    const notice: Directive = {
      id: "dir_10",
      colonyId: "col",
      agentId: "agt_1",
      kind: "landing",
      intentId: "int_1",
      message: "Landing lnd_10 changed src/a.ts",
      by: "colony",
      at: s.now(),
      landing: { landingId: "lnd_10", trunkSha: "f".repeat(40), paths: [{ path: "src/a.ts", before: blobId(OLD), after: blobId(NEW) }], intentTitle: "Add g", why: "g is needed" },
    };
    expect(receiveDirective(s.journal, notice, undefined, s.now())).toMatchObject({ interrupted: true });
    s.model.gate = null;
    release();
    expect(await running).toEqual({ sleepMs: null });
  };

  it("waits for trunk's tip to show the landing a notice announced, then rebuilds on it", async () => {
    const OLD = "export function f() {\n  return 1;\n}\n";
    const NEW = "export function f() {\n  return 1;\n}\nexport const g = 2;\n";
    const WRITTEN = "export function f() {\n  return 3;\n}\nexport const g = 2;\n";
    const s = setup({ files: { "src/a.ts": OLD }, replies: [`<file>\n${WRITTEN}</file>`, `<file>\n${WRITTEN}</file>`] });
    await noticeBeforePublish(s, OLD, NEW);
    // Not published yet: the tip still has the old blob, so the job waits and asks the model nothing.
    expect(await tick(s.deps())).toEqual({ sleepMs: TIP_POLL_MS });
    expect(s.model.calls).toHaveLength(1);
    s.advance(TIP_POLL_MS);
    const tip = s.land({ "src/a.ts": NEW });
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(user(s.model.calls[1]!)).toContain("export const g = 2;");
    const p = s.colony.only();
    expect(p.baseSha).toBe(tip);
    expect(p.readSet).toEqual([{ path: "src/a.ts", blob: blobId(NEW) }]);
  });

  it("stops waiting for the tip after TIP_WAIT_MS and rebuilds on it as it is", async () => {
    const OLD = "export function f() {\n  return 1;\n}\n";
    const NEW = "export function f() {\n  return 1;\n}\nexport const g = 2;\n";
    const WRITTEN = "export function f() {\n  return 3;\n}\n";
    const s = setup({ files: { "src/a.ts": OLD }, replies: [`<file>\n${WRITTEN}</file>`, `<file>\n${WRITTEN}</file>`] });
    await noticeBeforePublish(s, OLD, NEW);
    expect(await tick(s.deps())).toEqual({ sleepMs: TIP_POLL_MS });
    s.advance(TIP_WAIT_MS);
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    const p = s.colony.only();
    expect(p.baseSha).toBe(s.base);
    expect(p.readSet).toEqual([{ path: "src/a.ts", blob: blobId(OLD) }]);
  });

  it("with the flag off, takes today's clone path and reads nothing through the binding", async () => {
    const s = setup({ on: false });
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.repo.takeCalls()).toEqual({ commit: 0, tree: 0, blob: 0, tip: 0 });
    expect(s.git.calls).toEqual([`ensureBase ${s.base.slice(0, 7)}`, "readFile src/a.ts", "readFile src/a.ts", `ensureBase ${s.base.slice(0, 7)}`, "commit", "push"]);
    const p = s.colony.only();
    expect(p.contents).toBeUndefined();
    expect(p.headSha).toBe(s.git.pushes[0]);
    expect(p.evidence.checks.some((c) => c.name === "agent virtual checkout")).toBe(false);
    expect(s.journal.job()?.checkout).toBeUndefined();
  });
});

describe("virtual checkouts across restarts", () => {
  it("resumes a job killed mid-produce in a new isolate: it reads again through the binding and proposes the same change", async () => {
    const s = setup();
    s.model.gate = never();
    void tick(s.deps()); // dies waiting on the model
    await settleTurns();
    expect(s.journal.job()).toMatchObject({ step: "produce", checkout: "virtual" });
    s.restart();
    s.repo.takeCalls();
    const model2 = new FakeModel();
    expect(await tick(s.deps({ model: model2 }))).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.repo.takeCalls()).toEqual({ commit: 1, tree: 2, blob: 1, tip: 0 }); // nothing cached in the new isolate
    expect(s.colony.only()).toMatchObject({ headSha: changesetId(s.base, [{ path: "src/a.ts", blob: blobId(FIXED) }]), contents: { [blobId(FIXED)]: FIXED } });
    expect(s.git.calls).toEqual([]);
  });

  it("does not propose twice when killed after the colony stored the inline change", async () => {
    const s = setup();
    s.colony.hangAfterPropose = true;
    void tick(s.deps());
    await settleTurns();
    expect(s.journal.job()).toMatchObject({ step: "propose", attempts: 1, inline: true });
    s.colony.hangAfterPropose = false;
    s.restart();
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.colony.proposeCalls).toBe(1);
    expect(s.journal.job()).toMatchObject({ step: "await", proposalId: "prp_1" });
    expect(s.colony.only().contents).toEqual({ [blobId(FIXED)]: FIXED });
  });

  it("keeps a job taken on the clone path on it after the flag turns on", async () => {
    const s = setup({ on: false });
    s.model.gate = never();
    void tick(s.deps());
    await settleTurns();
    expect(s.journal.job()).toMatchObject({ step: "produce" });
    expect(s.journal.job()?.checkout).toBeUndefined();
    expect(await tick(s.deps({ on: true, model: new FakeModel() }))).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.repo.takeCalls()).toEqual({ commit: 0, tree: 0, blob: 0, tip: 0 });
    expect(s.colony.only().contents).toBeUndefined();
    expect(s.git.calls.at(-1)).toBe("push");
  });

  it("keeps a virtual job reading through the binding after the flag turns off, and commits and pushes its change", async () => {
    const s = setup();
    s.model.gate = never();
    void tick(s.deps());
    await settleTurns();
    expect(s.journal.job()).toMatchObject({ step: "produce", checkout: "virtual" });
    s.restart();
    s.repo.takeCalls();
    expect(await tick(s.deps({ on: false, model: new FakeModel() }))).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.repo.takeCalls().blob).toBe(1); // the produce step read src/a.ts through the binding again
    expect(s.git.calls).toEqual([`ensureBase ${s.base.slice(0, 7)}`, "commit", "push"]);
    const p = s.colony.only();
    expect(p.contents).toBeUndefined();
    expect(p.evidence.checks.find((c) => c.name === "agent virtual checkout")!.detail).toContain("committed and pushed: virtual checkouts are off for this colony now");
  });
});
