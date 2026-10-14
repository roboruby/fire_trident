import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, ColonySnapshot, FileVersion, Id, Intent, Proposal, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { MemoryJournal } from "../../src/agents/journal.ts";
import { FIRST_POLL_MS, tick } from "../../src/agents/loop.ts";
import type { AgentConfig, BaseFile, GitOps, LoopDeps, ModelClient } from "../../src/agents/loop.ts";
import type { ColonyRpc, ProposeInput, TakeResult } from "../../src/agents/rpc.ts";
import { STEPUP_CHECK, stepupHint } from "../../src/colony/stepup.ts";
import { noteProvenance } from "../../src/trunk/provenance.ts";

/**
 * Model step-up in the agent loop (FT_MODEL_STEPUP): when a take asks for the stronger model class after two returns,
 * the agent writes the intent's files with it before the spec's model and its own, and the change's evidence says why,
 * so the lineage note names the stronger model as observed.
 */

const BASE = "a".repeat(40);
const OWN = "@cf/small/model";
const STRONG = "@cf/big/model";
const VERSION = 'export const VERSION = "1";\n';

const LEASE: WorkspaceLease = {
  repo: { namespace: "ft-ws-1", name: "col--ws-1", remote: "https://ws.invalid/col--ws-1.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Number.MAX_SAFE_INTEGER,
  baseSha: BASE,
  leasedAt: 0,
  trunk: { remote: "https://trunk.invalid/col--trunk.git", token: "fixture-trunk", sha: BASE },
};

const INTENT: Intent = { id: "int_v", colonyId: "col", title: "Expose the version", why: "Expose the version.", source: "human", footprint: ["src/version.ts"], priority: 1, status: "open", createdAt: 0, createdBy: "t" };

/** A colony that hands out one intent with whatever model hint the test sets, and keeps the proposals. */
class FakeColony implements ColonyRpc {
  intent: Intent = { ...INTENT };
  hint: unknown = undefined;
  proposals: Proposal[] = [];
  async getColony(): Promise<Colony | null> {
    return null;
  }
  async snapshot(): Promise<ColonySnapshot> {
    return { rules: [] } as unknown as ColonySnapshot;
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
    if (this.intent.status !== "open" && this.intent.assignedTo !== agentId) return { wait: true, retryInMs: 5_000, reason: "no open intents" };
    this.intent = { ...this.intent, status: "claimed", assignedTo: agentId };
    return { intent: { ...this.intent }, lease: LEASE, ...(this.hint !== undefined ? { model: this.hint } : {}) } as TakeResult;
  }
  async heartbeat(): Promise<void> {}
  async propose(p: ProposeInput): Promise<Proposal> {
    const proposal: Proposal = { ...p, id: `prp_${this.proposals.length + 1}`, status: "ready", createdAt: 0, evidence: { checks: p.evidence?.checks ?? [], notVerified: p.evidence?.notVerified ?? "" } };
    this.proposals.push(proposal);
    return proposal;
  }
  async getProposal(id: Id): Promise<Proposal | null> {
    return this.proposals.find((p) => p.id === id) ?? null;
  }
  async inbox(): Promise<Proposal[]> {
    return [];
  }
  async getRule(): Promise<Rule | null> {
    return null;
  }
  async abandon(): Promise<void> {}
}

/** A clone of an empty trunk: the file is new. */
const git: GitOps = {
  ensureBase: async (p) => ({ baseSha: p.baseSha, fallback: false }),
  listFiles: async () => ["README.md"],
  readFile: async (): Promise<BaseFile | null> => null,
  commit: async (p): Promise<{ headSha: Sha; writeSet: FileVersion[] }> => ({ headSha: "b".repeat(40), writeSet: p.changes.map((c) => ({ path: c.path, blob: "c".repeat(40) })) }),
  push: async () => undefined,
};

/** One write of the version file through a model client that resolves "default" to the stronger model, as the real one does. */
async function write(hint: unknown, why = INTENT.why): Promise<{ asked: string[]; proposal: Proposal }> {
  const colony = new FakeColony();
  colony.intent.why = why;
  colony.hint = hint;
  const asked: string[] = [];
  const model: ModelClient = {
    complete: async (p) => {
      asked.push(p.model);
      return { text: `<file>\n${VERSION}</file>`, usage: { input: 70, output: 30, cached: 0, neurons: 0 }, model: p.model === "default" ? STRONG : p.model === "bulk" ? "@cf/bulk/model" : p.model };
    },
  };
  const journal = new MemoryJournal();
  const cfg: AgentConfig = { colonyId: "col", agentId: "agt_1", name: "a1", kind: "internal", model: OWN, running: true, epoch: 1, startedAt: 0, failures: 0 };
  journal.setConfig(cfg);
  const deps: LoopDeps = { colony, git, model, journal, now: () => 1_000_000, rand: () => 0.5 };
  expect(await tick(deps)).toEqual({ sleepMs: FIRST_POLL_MS });
  expect(colony.proposals).toHaveLength(1);
  return { asked, proposal: colony.proposals[0]! };
}

describe("agent loop: model step-up", () => {
  it("writes with the stronger model the take asks for, says why in the evidence, and the note observes that model", async () => {
    const hint = stepupHint(2)!;
    const { asked, proposal } = await write(hint);
    expect(asked).toEqual(["default"]);
    const checks = proposal.evidence.checks;
    expect(checks.find((c) => c.name === STEPUP_CHECK)).toEqual({ name: STEPUP_CHECK, ok: true, ms: 0, detail: `${hint.reason} The change was written with ${STRONG} instead of the agent's own ${OWN}.` });
    expect(checks.find((c) => c.name === "agent model usage")?.detail).toMatch(new RegExp(`^${STRONG.replace(/[/.]/g, "\\$&")}: 1 call\\(s\\)`));
    expect(proposal.evidence.notVerified).toContain(`Written by model ${STRONG}`);
    // The trunk writer's provenance for an in-platform agent: the model its calls went to, observed.
    expect(noteProvenance({ kind: "internal", model: OWN }, proposal.evidence)?.model).toMatchObject({ evidence: "observed", name: STRONG });
  });

  it("puts the take's hint before the model the intent's spec asks for", async () => {
    expect((await write(stepupHint(3), "Expose the version.\n\nModel: bulk")).asked).toEqual(["default"]);
    expect((await write(undefined, "Expose the version.\n\nModel: bulk")).asked).toEqual(["bulk"]);
  });

  it("writes with the agent's own model, and says nothing, without a usable hint", async () => {
    for (const hint of [undefined, { model: "default", returns: 1, reason: "one return" }, { model: "@cf/any/model", returns: 2, reason: "r" }]) {
      const { asked, proposal } = await write(hint);
      expect(asked, JSON.stringify(hint)).toEqual([OWN]);
      expect(proposal.evidence.checks.some((c) => c.name === STEPUP_CHECK)).toBe(false);
      expect(noteProvenance({ kind: "internal", model: OWN }, proposal.evidence)?.model).toMatchObject({ evidence: "observed", name: OWN });
    }
  });
});
