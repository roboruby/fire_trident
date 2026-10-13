import { describe, expect, it } from "vitest";
import type { FileVersion, Id, Intent, Path, Proposal, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { MemoryJournal } from "../../src/agents/journal.ts";
import { tick } from "../../src/agents/loop.ts";
import type { AgentConfig, BaseFile, GitOps, LoopDeps, ModelClient, ModelReply } from "../../src/agents/loop.ts";
import type { ChatMessage, LastReturn } from "../../src/agents/prompt.ts";
import type { ColonyRpc, ProposeInput, TakeResult } from "../../src/agents/rpc.ts";

/**
 * The agent loop and the intent's last return: when the take says why the intent's latest change came
 * back, every prompt of the job shows that reason as fenced data, to address first.
 */

const BASE = "a".repeat(40);
const LEASE: WorkspaceLease = {
  repo: { namespace: "ft-ws-1", name: "col--ws-1", remote: "https://ws.invalid/col--ws-1.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Number.MAX_SAFE_INTEGER,
  baseSha: BASE,
  leasedAt: 0,
  trunk: { remote: "https://trunk.invalid/col--trunk.git", token: "fixture-trunk", sha: BASE },
};
const BACK: LastReturn = { proposalId: "prp_0", status: "returned", at: Date.UTC(2026, 9, 13, 12), reason: "llm: compilation errors: f is called with two arguments", paths: ["src/a.ts"] };
const RULE: Rule = { id: "rul_1", colonyId: "col", kind: "forbid-pattern", spec: { pattern: "console\\.log", hint: "Use logger.info." }, description: "No console.log", approvedBy: "t", createdAt: 0 };

const hash = (s: string): Sha => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0").repeat(5);
};

/** A colony with one intent; take hands it out with whatever `extra` holds (lastReturn as the colony would send it). */
function colonyWith(intent: Intent, extra: Record<string, unknown>, rule?: Rule) {
  const proposals = new Map<Id, Proposal>();
  const colony = {
    async take(agentId: Id): Promise<TakeResult> {
      if (intent.status !== "open" && intent.assignedTo !== agentId) return { wait: true, retryInMs: 5_000, reason: "no open intents" };
      intent.status = "claimed";
      intent.assignedTo = agentId;
      return { intent: { ...intent }, lease: LEASE, ...(rule ? { rule } : {}), ...extra } as TakeResult;
    },
    async heartbeat(): Promise<void> {},
    async snapshot(): Promise<{ rules: Rule[] }> {
      return { rules: rule ? [rule] : [] };
    },
    async propose(p: ProposeInput): Promise<Proposal> {
      const proposal: Proposal = { ...p, id: `prp_${proposals.size + 1}`, status: "ready", createdAt: 0, evidence: { checks: [], notVerified: "" } };
      proposals.set(proposal.id, proposal);
      return proposal;
    },
    async getProposal(id: Id): Promise<Proposal | null> {
      return proposals.get(id) ?? null;
    },
    async inbox(): Promise<Proposal[]> {
      return [];
    },
    async getRule(): Promise<Rule | null> {
      return rule ?? null;
    },
    async abandon(): Promise<void> {},
  };
  return { colony: colony as unknown as ColonyRpc, proposals };
}

class FakeGit implements GitOps {
  constructor(private readonly files: Record<Path, string>) {}
  async ensureBase(p: { baseSha: Sha }): Promise<{ baseSha: Sha; fallback: boolean }> {
    return { baseSha: p.baseSha, fallback: false };
  }
  async listFiles(): Promise<string[]> {
    return Object.keys(this.files);
  }
  async readFile(_base: Sha, path: string): Promise<BaseFile | null> {
    const c = this.files[path];
    return c === undefined ? null : { blob: hash(`blob ${c}`), mode: "100644", bytes: new TextEncoder().encode(c) };
  }
  async commit(p: Parameters<GitOps["commit"]>[0]): Promise<{ headSha: Sha; writeSet: FileVersion[] }> {
    const writeSet = p.changes.map((c) => ({ path: c.path, blob: hash(`blob ${c.content}`) }));
    return { headSha: hash(JSON.stringify([p.baseSha, writeSet])), writeSet };
  }
  async push(): Promise<void> {}
}

class FakeModel implements ModelClient {
  calls: ChatMessage[][] = [];
  constructor(private readonly reply: string) {}
  async complete(p: { messages: ChatMessage[] }): Promise<ModelReply> {
    this.calls.push(p.messages);
    return { text: this.reply };
  }
}

function run(intent: Intent, extra: Record<string, unknown>, files: Record<Path, string>, reply: string, rule?: Rule) {
  const journal = new MemoryJournal();
  const cfg: AgentConfig = { colonyId: "col", agentId: "agt_1", name: "a1", kind: "internal", model: "@cf/test/model", running: true, epoch: 1, startedAt: 0, failures: 0 };
  journal.setConfig(cfg);
  const { colony, proposals } = colonyWith(intent, extra, rule);
  const model = new FakeModel(reply);
  const deps: LoopDeps = { colony, git: new FakeGit(files), model, journal, now: () => 1_000_000, rand: () => 0.5 };
  return { deps, model, proposals, journal };
}

const writeIntent = (): Intent => ({ id: "int_1", colonyId: "col", title: "Make f return 3", why: "Callers need 3.", source: "certify", footprint: ["src/a.ts"], priority: 10, status: "open", createdAt: 0, createdBy: "certify" });
const user = (m: ChatMessage[] | undefined): string => m?.find((x) => x.role === "user")?.content ?? "";

describe("the last return in the agent loop", () => {
  it("writes with the reason the intent's latest change came back, fenced as data, and proposes as usual", async () => {
    const s = run(writeIntent(), { lastReturn: BACK }, { "src/a.ts": "export function f() {\n  return 1;\n}\n" }, "<file>\nexport function f() {\n  return 3;\n}\n</file>");
    await tick(s.deps);
    const prompt = user(s.model.calls[0]);
    expect(prompt).toContain("An earlier change for this intent came back. Address its reason first");
    expect(prompt).toMatch(/<<<RETURN ([0-9a-f]{12})>>>\nproposal prp_0, returned 2026-10-13 12:00; it wrote src\/a\.ts\nreason: llm: compilation errors: f is called with two arguments\n<<<END RETURN \1>>>/);
    expect(s.proposals.size).toBe(1);
  });

  it("shows it in a rule intent's edit prompt too", async () => {
    const intent: Intent = { ...writeIntent(), title: "No console.log in src/a.ts", why: "Logs go through the logger.", source: "rule", ruleId: RULE.id };
    const s = run(intent, { lastReturn: { ...BACK, reason: "reflex: the logger import is missing" } }, { "src/a.ts": "console.log(1);\n" }, "<file>\nlogger.info(1);\n</file>", RULE);
    await tick(s.deps);
    expect(s.model.calls).toHaveLength(1);
    expect(user(s.model.calls[0])).toContain("reason: reflex: the logger import is missing");
  });

  it("has no block when the take carries none, or one it cannot use", async () => {
    for (const extra of [{}, { lastReturn: { proposalId: "prp_0", reason: "no time" } }, { lastReturn: "returned" }]) {
      const s = run(writeIntent(), extra, { "src/a.ts": "export function f() {\n  return 1;\n}\n" }, "<file>\nexport function f() {\n  return 3;\n}\n</file>");
      await tick(s.deps);
      expect(user(s.model.calls[0])).not.toContain("came back");
      expect(s.proposals.size).toBe(1);
    }
  });
});
