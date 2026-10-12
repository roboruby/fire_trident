import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, ColonySnapshot, FileVersion, Id, Intent, Path, Proposal, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { MemoryJournal } from "../../src/agents/journal.ts";
import { DEPS_MAX_WAIT_MS, FIRST_POLL_MS, tick, writeStatement } from "../../src/agents/loop.ts";
import type { AgentConfig, BaseFile, GitOps, LoopDeps, ModelClient, ModelReply } from "../../src/agents/loop.ts";
import type { ChatMessage } from "../../src/agents/prompt.ts";
import type { ColonyRpc, ProposeInput, TakeResult } from "../../src/agents/rpc.ts";

/**
 * The write path of the agent loop: a spec-declared intent (the new-project flow) waits for
 * the files it builds on, reads them, writes each file of its footprint with a model, checks
 * every file before proposing, and proposes a read set that names the new files with blob null.
 */

const LEASE_BASE = "a".repeat(40);
const TIP = "c".repeat(40);
const sha1 = (s: string): Sha => {
  let out = "";
  for (let k = 0; k < 5; k++) {
    let h = (0x811c9dc5 ^ Math.imul(k + 1, 0x9e3779b9)) >>> 0;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out;
};

const RELATIVE_TS: Rule = {
  id: "rul_1",
  colonyId: "col",
  kind: "forbid-import",
  description: "Relative imports name the .ts file",
  spec: { from: ["src/**", "test/**"], module: "^\\.\\.?/(?!.*\\.ts$)", hint: 'Write relative imports with the .ts extension, e.g. import { json } from "./http.ts".' },
  approvedBy: "t",
  createdAt: 0,
};

const WHY = [
  "A tiny dependency-free router keeps the Worker small. (Goal: shortlinks)",
  "",
  "Builds on: src/types.ts, src/http.ts",
  "Planned files: src/types.ts, src/http.ts, src/router.ts, test/router.test.ts, src/slug.ts",
  "",
  "Spec context (demo/new-project-spec.md):",
  "## Module contracts",
  "export function createRouter(routes: Route[]): (request: Request, deps: Deps) => Promise<Response>;",
].join("\n");

const TYPES = "export type Handler = (request: Request) => Promise<Response>;\n";
const HTTP = "export function error(status: number, code: string, message: string): Response {\n  return new Response(null, { status });\n}\n";
const ROUTER_BAD = 'import { error } from "./http";\nimport type { Handler } from "./types.ts";\nexport const createRouter = (routes: Handler[]) => routes;\n';
const ROUTER = 'import { error } from "./http.ts";\nimport type { Handler } from "./types.ts";\nexport function createRouter(routes: Handler[]): Handler[] {\n  void error;\n  return routes;\n}\n';
const ROUTER_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { createRouter } from "../src/router.ts";\n\ntest("router", () => {\n  assert.deepEqual(createRouter([]), []);\n});\n';

function intent(over: Partial<Intent> = {}): Intent {
  return {
    id: "int_router",
    colonyId: "col",
    title: "Router with params, 404, and 405",
    why: WHY,
    source: "human",
    footprint: ["test/router.test.ts", "src/router.ts"],
    acceptance: ["node --test test/router.test.ts passes"],
    priority: 4,
    status: "open",
    createdAt: 0,
    createdBy: "t",
    ...over,
  };
}

const LEASE: WorkspaceLease = {
  repo: { namespace: "ft-ws-1", name: "col--ws-1", remote: "https://ws.invalid/col--ws-1.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Number.MAX_SAFE_INTEGER,
  baseSha: LEASE_BASE,
  leasedAt: 0,
  trunk: { remote: "https://trunk.invalid/col--trunk.git", token: "fixture-trunk", sha: LEASE_BASE },
};

class FakeColony implements ColonyRpc {
  intents: Intent[] = [intent()];
  proposals = new Map<Id, Proposal>();
  abandoned: string[] = [];
  snapshots = 0;
  async getColony(): Promise<Colony | null> {
    return null;
  }
  async snapshot(): Promise<ColonySnapshot> {
    this.snapshots++;
    return { rules: [RELATIVE_TS] } as unknown as ColonySnapshot;
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
    const held = this.intents.find((i) => i.status === "claimed" && i.assignedTo === agentId);
    const i = held ?? this.intents.find((x) => x.status === "open");
    if (!i) return { wait: true, retryInMs: 5000, reason: "no open intents" };
    i.status = "claimed";
    i.assignedTo = agentId;
    return { intent: { ...i }, lease: LEASE };
  }
  async heartbeat(): Promise<void> {}
  async propose(p: ProposeInput): Promise<Proposal> {
    const id = `prp_${this.proposals.size + 1}`;
    const proposal: Proposal = { ...p, id, status: "ready", createdAt: 0, evidence: { checks: p.evidence?.checks ?? [], notVerified: p.evidence?.notVerified ?? "" } };
    this.proposals.set(id, proposal);
    return proposal;
  }
  async getProposal(id: Id): Promise<Proposal | null> {
    return this.proposals.get(id) ?? null;
  }
  async inbox(): Promise<Proposal[]> {
    return [];
  }
  async getRule(): Promise<Rule | null> {
    return null;
  }
  async abandon(_agentId: Id, reason?: string): Promise<void> {
    this.abandoned.push(reason ?? "");
    for (const i of this.intents) if (i.status === "claimed") i.status = "open";
  }
}

/** Trunk as one map: the agent's clone sees it at the tip, TrunkDO.blobsFor answers from it. */
class FakeTrunk {
  files: Record<Path, string> = { "README.md": "# shortlinks\n", "src/types.ts": TYPES };
  async blobsFor(paths: Path[]): Promise<Record<Path, Sha | null>> {
    return Object.fromEntries(paths.map((p) => [p, this.files[p] === undefined ? null : sha1(`blob ${this.files[p]}`)]));
  }
}

class FakeGit implements GitOps {
  tips = 0;
  commits: Array<{ baseSha: Sha; changes: Array<{ path: string; content: string }> }> = [];
  constructor(private readonly trunk: FakeTrunk) {}
  async ensureBase(p: { baseSha: Sha }): Promise<{ baseSha: Sha; fallback: boolean }> {
    return { baseSha: p.baseSha, fallback: false };
  }
  async fetchTip(): Promise<Sha | null> {
    this.tips++;
    return TIP;
  }
  async listFiles(): Promise<string[]> {
    return Object.keys(this.trunk.files);
  }
  async readFile(_base: Sha, path: string): Promise<BaseFile | null> {
    const c = this.trunk.files[path];
    return c === undefined ? null : { blob: sha1(`blob ${c}`), mode: "100644", bytes: new TextEncoder().encode(c) };
  }
  async commit(p: Parameters<GitOps["commit"]>[0]): Promise<{ headSha: Sha; writeSet: FileVersion[] }> {
    this.commits.push({ baseSha: p.baseSha, changes: p.changes });
    const writeSet = p.changes.map((c) => ({ path: c.path, blob: sha1(`blob ${c.content}`) }));
    return { headSha: sha1(JSON.stringify([p.baseSha, writeSet])), writeSet };
  }
  async push(): Promise<void> {}
}

class FakeModel implements ModelClient {
  calls: ChatMessage[][] = [];
  constructor(public replies: string[]) {}
  async complete(p: { messages: ChatMessage[] }): Promise<ModelReply> {
    this.calls.push(p.messages);
    return { text: this.replies.shift() ?? "", usage: { input: 100, output: 50, cached: 0, neurons: 0 } };
  }
}

function setup(replies: string[]) {
  const journal = new MemoryJournal();
  const colony = new FakeColony();
  const trunk = new FakeTrunk();
  const git = new FakeGit(trunk);
  const model = new FakeModel(replies);
  let t = 1_000_000;
  const cfg: AgentConfig = { colonyId: "col", agentId: "agt_1", name: "a1", kind: "internal", model: "@cf/test/model", running: true, epoch: 1, startedAt: 0, failures: 0 };
  journal.setConfig(cfg);
  const deps = (): LoopDeps => ({ colony, git, model, journal, trunk, now: () => t, rand: () => 0.5 });
  return { journal, colony, trunk, git, model, deps, advance: (ms: number) => (t += ms) };
}

const user = (m: ChatMessage[]): string => m.find((x) => x.role === "user")?.content ?? "";

describe("agent loop: writing files from a spec", () => {
  it("waits for the files it builds on, writes each file with context, retries on problems, and proposes", async () => {
    const s = setup([`<file>\n${ROUTER_BAD}</file>`, `<file>\n${ROUTER}</file>`, `<file>\n${ROUTER_TEST}</file>`]);

    // src/http.ts has not landed: the job holds its claim and polls trunk.
    const first = await tick(s.deps());
    expect(first.sleepMs).toBeGreaterThan(0);
    expect(s.journal.job()).toMatchObject({ step: "deps", buildsOn: ["src/types.ts", "src/http.ts"], depsMissing: ["src/http.ts"], attempts: 0 });
    expect(s.model.calls).toHaveLength(0);
    s.advance(20_000);
    await tick(s.deps());
    expect(s.journal.job()).toMatchObject({ step: "deps", depsMissing: ["src/http.ts"] });

    // It lands; the job builds on the trunk tip, not the older lease base.
    s.trunk.files["src/http.ts"] = HTTP;
    s.advance(5_000);
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.git.tips).toBe(1);
    expect(s.colony.snapshots).toBe(1);

    // Sources before tests; the first reply breaks the colony's import rule and goes back with the problem.
    expect(s.model.calls).toHaveLength(3);
    const prompt = user(s.model.calls[0]!);
    expect(prompt).toContain("Path: src/router.ts (a new file: write all of it)");
    expect(prompt).toContain("This change also writes: test/router.test.ts");
    expect(prompt).toContain("Rules src/router.ts must follow");
    expect(prompt).toContain("Spec context (from demo/new-project-spec.md):\n## Module contracts");
    expect(prompt).toContain("Files src/router.ts builds on, as they are on trunk");
    expect(prompt).toContain(TYPES.trim());
    expect(prompt).toContain(HTTP.trim());
    expect(prompt).not.toContain("Builds on:");
    const retry = s.model.calls[1]!;
    expect(retry.at(-1)!.content).toContain('breaks the rule "Relative imports name the .ts file"');
    const testPrompt = user(s.model.calls[2]!);
    expect(testPrompt).toContain("Path: test/router.test.ts");
    expect(testPrompt).toContain("Written earlier in this change");
    expect(testPrompt).toContain(ROUTER.trim());

    expect(s.git.commits).toHaveLength(1);
    expect(s.git.commits[0]!.baseSha).toBe(TIP);
    const p = [...s.colony.proposals.values()][0]!;
    expect(p.baseSha).toBe(TIP);
    expect(p.writeSet.map((w) => w.path).sort()).toEqual(["src/router.ts", "test/router.test.ts"]);
    const reads = Object.fromEntries(p.readSet.map((f) => [f.path, f.blob]));
    expect(reads).toEqual({ "src/router.ts": null, "test/router.test.ts": null, "src/types.ts": sha1(`blob ${TYPES}`), "src/http.ts": sha1(`blob ${HTTP}`) });
    const write = p.evidence.checks.find((c) => c.name === "write src/router.ts")!;
    expect(write).toMatchObject({ ok: true });
    expect(write.detail).toContain("attempt 2");
    expect(write.detail).toContain("2 relative import(s) resolve, imported names match the modules' exports");
    expect(p.evidence.notVerified).toContain("Written by model @cf/test/model");
    expect(p.evidence.notVerified).toContain("Built on the landed src/types.ts, src/http.ts.");
    expect(p.evidence.notVerified).toContain(`Based on trunk ${TIP}`);
    expect(p.declared.summary).toContain("written with a model and checked");
  });

  it("gives the intent back when the files it builds on never land", async () => {
    const s = setup([]);
    await tick(s.deps());
    expect(s.journal.job()).toMatchObject({ step: "deps" });
    s.advance(DEPS_MAX_WAIT_MS + 1);
    await tick(s.deps());
    expect(s.journal.job()).toBeNull();
    expect(s.colony.abandoned[0]).toMatch(/waited 15 min for src\/http\.ts to land/);
    expect(s.model.calls).toHaveLength(0);
  });

  it("sends a type imported as a value back to the model, with the module's exports checked", async () => {
    const valueImport = ROUTER.replace('import type { Handler } from "./types.ts";', 'import { Handler } from "./types.ts";');
    const s = setup([`<file>\n${valueImport}</file>`, `<file>\n${ROUTER}</file>`, `<file>\n${ROUTER_TEST}</file>`]);
    s.trunk.files["src/http.ts"] = HTTP;
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.model.calls).toHaveLength(3);
    expect(s.model.calls[1]!.at(-1)!.content).toContain('imports the type "Handler" from "./types.ts" as a value');
    expect(s.colony.proposals.size).toBe(1);
  });

  it("writes with the model the intent asks for, and counts its tokens under that model", async () => {
    const s = setup([]);
    s.colony.intents = [intent({ why: "Expose the version.\n\nScope: this intent writes src/version.ts.\nModel: default", footprint: ["src/version.ts"] })];
    const asked: string[] = [];
    const model: ModelClient = {
      complete: async (p) => {
        asked.push(p.model);
        return { text: `<file>\nexport const VERSION = "1";\n</file>`, usage: { input: 70, output: 30, cached: 0, neurons: 0 }, model: "@cf/big/model" };
      },
    };
    expect(await tick({ ...s.deps(), model })).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(asked).toEqual(["default"]);
    const p = [...s.colony.proposals.values()][0]!;
    expect(p.evidence.checks.find((c) => c.name === "write src/version.ts")!.detail).toContain("(model @cf/big/model, attempt 1)");
    expect(p.evidence.notVerified).toContain("Written by model @cf/big/model from the intent");
    expect(s.journal.counters()).toMatchObject({ tokensIn: 70, tokensOut: 30, "tokensIn:@cf/big/model": 70, "tokensOut:@cf/big/model": 30, "llmCalls:@cf/big/model": 1 });
  });

  it("gives up a file the model cannot get right in three attempts", async () => {
    const s = setup([`<file>\n${ROUTER_BAD}</file>`, "no file here", `<file>\n${ROUTER_BAD}</file>`]);
    s.trunk.files["src/http.ts"] = HTTP;
    await tick(s.deps());
    expect(s.model.calls).toHaveLength(3);
    expect(s.colony.proposals.size).toBe(0);
    expect(s.colony.abandoned[0]).toMatch(/the model did not write a valid src\/router\.ts/);
  });

  it("writes a new file of an intent with no spec layout, with no waiting", async () => {
    const s = setup([`<file>\nexport const VERSION = "1";\n</file>`]);
    s.colony.intents = [intent({ why: "Expose the version.", footprint: ["src/version.ts"] })];
    expect(await tick(s.deps())).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(s.git.tips).toBe(0);
    const p = [...s.colony.proposals.values()][0]!;
    expect(p.readSet).toEqual([{ path: "src/version.ts", blob: null }]);
    expect(p.baseSha).toBe(LEASE_BASE);
    expect(user(s.model.calls[0]!)).toContain("Project tree at your base commit (2 files):\nREADME.md\nsrc/types.ts");
  });
});

describe("writeStatement", () => {
  it("states what was checked and read, facts first", () => {
    const text = writeStatement(
      { model: "m" },
      {
        rules: [RELATIVE_TS],
        context: [{ path: "src/types.ts", blob: "b", mode: "100644", size: 1, text: true }],
        depsMissing: ["src/slug.ts"],
        buildsOn: ["src/types.ts"],
        baseSha: TIP,
        lease: LEASE,
        checks: [{ name: "write src/a.ts", ok: true, ms: 1, detail: "syntax ok, erasable TypeScript" }],
      },
    );
    // Reviewers keep 400 characters: the completeness claim and the gaps come first.
    expect(text.startsWith('Complete files (each parses); a diff ending in "… (truncated)" is a display limit, not the file.')).toBe(true);
    expect(text.slice(0, 400)).toContain("No tests, type checks or builds were run.");
    expect(text).toContain("the colony's 1 rule(s) hold, the TypeScript is erasable");
    expect(text).toContain("Written by model m from the intent and its spec context.");
    expect(text).toContain("Not in trunk when written (built against the spec's contracts): src/slug.ts.");
  });
});
