import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, ColonySnapshot, EscalationKind, FileVersion, Id, Intent, IntentEscalation, IntentSource, Proposal, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { MemoryJournal } from "../../src/agents/journal.ts";
import { FIRST_POLL_MS, MAX_FILES, MAX_MODEL_CHARS, throttleWaitMs, throttledSleepMs, tick } from "../../src/agents/loop.ts";
import type { AgentConfig, BaseFile, GitOps, LoopDeps, ModelClient } from "../../src/agents/loop.ts";
import { MODEL_LINE_CHECK } from "../../src/agents/modelline.ts";
import { MAX_REWRITE_CHARS } from "../../src/agents/prompt.ts";
import type { ColonyRpc, ProposeInput, TakeResult } from "../../src/agents/rpc.ts";
import { throttleError } from "../../src/agents/throttle.ts";

/**
 * The agent loop's limits and who chooses its model:
 * - a provider's throttle (Anthropic's 529 and Retry-After too) waits without counting a failed attempt;
 * - a Model line is honored only on an intent a person, a spec or a rule declared, for a model the deployment knows;
 * - a footprint over MAX_FILES files, or a file too large for a model to write back, goes to a person whole, before
 *   any model call, and never lands in part as done.
 */

const BASE = "a".repeat(40);
const OWN = "@cf/small/model";
const LISTED = "@cf/openai/gpt-oss-120b";
const VERSION = 'export const VERSION = "1";\n';

const LEASE: WorkspaceLease = {
  repo: { namespace: "ft-ws-1", name: "col--ws-1", remote: "https://ws.invalid/col--ws-1.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Number.MAX_SAFE_INTEGER,
  baseSha: BASE,
  leasedAt: 0,
  trunk: { remote: "https://trunk.invalid/col--trunk.git", token: "fixture-trunk", sha: BASE },
};

function intentOf(p: Partial<Intent> = {}): Intent {
  return { id: "int_v", colonyId: "col", title: "Expose the version", why: "Expose the version.", source: "human", footprint: ["src/version.ts"], priority: 1, status: "open", createdAt: 0, createdBy: "t", ...p };
}

/** A colony that hands out one intent, keeps proposals and reports, and records give-ups. */
class FakeColony implements ColonyRpc {
  proposals: Proposal[] = [];
  escalations: Array<{ kind: EscalationKind; report: string }> = [];
  abandoned: string[] = [];
  constructor(public intent: Intent) {}
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
    return { intent: { ...this.intent }, lease: LEASE } as TakeResult;
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
  async abandon(_agentId: Id, reason?: string): Promise<void> {
    this.abandoned.push(reason ?? "");
  }
  async escalate(_agentId: Id, p: { intentId?: Id; kind: EscalationKind; report: string }): Promise<{ intent: Intent; escalation: IntentEscalation }> {
    this.escalations.push({ kind: p.kind, report: p.report });
    this.intent = { ...this.intent, status: "open" };
    return { intent: this.intent, escalation: { kind: p.kind, report: p.report, by: "agt_1", at: 0 } };
  }
}

/** A clone whose trunk holds `files` (path -> text); every other path is new. */
function gitWith(files: Record<string, string> = {}): GitOps {
  return {
    ensureBase: async (p) => ({ baseSha: p.baseSha, fallback: false }),
    listFiles: async () => ["README.md", ...Object.keys(files)],
    readFile: async (_sha, path): Promise<BaseFile | null> => (path in files ? { blob: "d".repeat(40), mode: "100644", bytes: new TextEncoder().encode(files[path]!) } : null),
    commit: async (p): Promise<{ headSha: Sha; writeSet: FileVersion[] }> => ({ headSha: "b".repeat(40), writeSet: p.changes.map((c) => ({ path: c.path, blob: "c".repeat(40) })) }),
    push: async () => undefined,
  };
}

interface Run {
  colony: FakeColony;
  journal: MemoryJournal;
  asked: string[];
  sleepMs: number | null;
}

/** Ticks the agent until it proposes, escalates, gives up or sleeps on something else. */
async function run(intent: Intent, opts: { files?: Record<string, string>; model?: ModelClient["complete"] } = {}): Promise<Run> {
  const colony = new FakeColony(intent);
  const asked: string[] = [];
  const model: ModelClient = {
    complete:
      opts.model ??
      (async (p) => {
        asked.push(p.model);
        return { text: `<file>\n${VERSION}</file>`, usage: { input: 70, output: 30, cached: 0, neurons: 0 }, model: p.model };
      }),
  };
  const journal = new MemoryJournal();
  const cfg: AgentConfig = { colonyId: "col", agentId: "agt_1", name: "a1", kind: "internal", model: OWN, running: true, epoch: 1, startedAt: 0, failures: 0 };
  journal.setConfig(cfg);
  const deps: LoopDeps = { colony, git: gitWith(opts.files), model, journal, now: () => 1_000_000, rand: () => 0.5, models: { default: "@cf/deploy/default", bulk: "@cf/deploy/bulk" } };
  const { sleepMs } = await tick(deps);
  return { colony, journal, asked, sleepMs };
}

describe("agent loop: who chooses the model (Model lines)", () => {
  const why = (model: string): string => `Expose the version.\n\nScope: this intent writes src/version.ts.\nModel: ${model}`;

  it("writes with the model a person's, a spec's or a rule's intent asks for when the deployment knows it", async () => {
    for (const [source, model] of [
      ["human", "default"],
      ["human", "bulk"],
      ["human", LISTED],
      ["rule", "@cf/deploy/bulk"],
      ["human", "@cf/deploy/default"],
      ["certify", "default"],
    ] as Array<[IntentSource, string]>) {
      const r = await run(intentOf({ source, why: why(model) }));
      expect(r.sleepMs, `${source} ${model}`).toBe(FIRST_POLL_MS);
      expect(r.asked, `${source} ${model}`).toEqual([model]);
      expect(r.colony.proposals[0]!.evidence.checks.some((c) => c.name === MODEL_LINE_CHECK)).toBe(false);
    }
  });

  it("ignores the line on an intent an agent declared or an issue brought, writes with its own model and says why", async () => {
    for (const [source, words] of [
      ["agent", "an agent declared it"],
      ["external", "it was imported from a public GitHub issue"],
      ["system", "the platform declared it"],
    ] as Array<[IntentSource, string]>) {
      const r = await run(intentOf({ source, why: why(LISTED) }));
      expect(r.asked, source).toEqual([OWN]);
      const check = r.colony.proposals[0]!.evidence.checks.find((c) => c.name === MODEL_LINE_CHECK);
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain(`"Model: ${LISTED}" line was ignored: ${words}`);
      expect(check?.detail).toContain(`the agent wrote with its own model, ${OWN}`);
      // The take's journal line says it too.
      expect(r.journal.steps(50).find((s) => s.step === "take")?.detail).toContain("line was ignored");
    }
  });

  it("ignores a model the deployment does not know, even on a person's intent", async () => {
    const r = await run(intentOf({ source: "human", why: why("claude-very-expensive-9") }));
    expect(r.asked).toEqual([OWN]);
    expect(r.colony.proposals[0]!.evidence.checks.find((c) => c.name === MODEL_LINE_CHECK)?.detail).toMatch(/names no model this deployment knows/);
  });

  it("honors only the default class on a repair intent from trunk certification", async () => {
    const r = await run(intentOf({ source: "certify", why: why(LISTED) }));
    expect(r.asked).toEqual([OWN]);
    expect(r.colony.proposals[0]!.evidence.checks.find((c) => c.name === MODEL_LINE_CHECK)?.detail).toMatch(/trunk certification only asks for the default model class/);
  });
});

describe("agent loop: limits are checked before any model call", () => {
  it("sends a footprint over the file limit to a person whole, with no model call and nothing proposed", async () => {
    const footprint = Array.from({ length: MAX_FILES + 5 }, (_, i) => `src/f${i}.ts`);
    const r = await run(intentOf({ footprint }));
    expect(r.asked).toEqual([]);
    expect(r.colony.proposals).toEqual([]);
    expect(r.colony.escalations).toHaveLength(1);
    expect(r.colony.escalations[0]!.kind).toBe("other");
    expect(r.colony.escalations[0]!.report).toMatch(/^Too large for one agent: this intent's footprint covers 25 files, and one agent writes at most 20 in one change/);
    expect(r.journal.history(1)[0]).toMatchObject({ outcome: "escalated" });
  });

  it("says 'at least' when a glob matched more files than were listed", async () => {
    const files = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`src/g${i}.ts`, "export {};\n"]));
    const r = await run(intentOf({ footprint: ["src/**"] }), { files });
    expect(r.asked).toEqual([]);
    expect(r.colony.escalations[0]!.report).toContain("covers at least 80 files");
  });

  it("still writes a footprint of exactly the limit", async () => {
    const footprint = Array.from({ length: MAX_FILES }, (_, i) => `src/f${i}.ts`);
    const r = await run(intentOf({ footprint }));
    expect(r.colony.escalations).toEqual([]);
    expect(r.asked).toHaveLength(MAX_FILES);
    expect(r.colony.proposals).toHaveLength(1);
  });

  it("sends a file a model could not write back in one reply to a person, with no model call", async () => {
    expect(MAX_MODEL_CHARS).toBe(MAX_REWRITE_CHARS);
    expect(MAX_REWRITE_CHARS).toBe(86_016);
    const big = "x".repeat(MAX_MODEL_CHARS + 1);
    const r = await run(intentOf({ footprint: ["src/a.ts", "src/big.ts"] }), { files: { "src/big.ts": big, "src/a.ts": "export const a = 1;\n" } });
    expect(r.asked).toEqual([]);
    expect(r.colony.proposals).toEqual([]);
    expect(r.colony.escalations).toEqual([
      {
        kind: "other",
        report:
          "Too large for one agent: src/big.ts has 86,017 characters, and a model can write back at most 86,016 in one reply, so the agent made no model call. Split the file into smaller ones, or leave it out of this intent's footprint and change it another way.",
      },
    ]);
  });

  it("counts characters, not bytes, and writes a file at the limit", async () => {
    // Two-byte characters: over the limit in bytes, at it in characters.
    const file = "é".repeat(MAX_MODEL_CHARS);
    const r = await run(intentOf({ footprint: ["src/version.ts"] }), { files: { "src/version.ts": file } });
    expect(r.colony.escalations).toEqual([]);
    expect(r.asked[0]).toBe(OWN);
  });

  it("goes back with the reason when the colony cannot take the report", async () => {
    const colony = new FakeColony(intentOf({ footprint: Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`) }));
    (colony as { escalate?: unknown }).escalate = undefined;
    const journal = new MemoryJournal();
    journal.setConfig({ colonyId: "col", agentId: "agt_1", name: "a1", kind: "internal", model: OWN, running: true, epoch: 1, startedAt: 0, failures: 0 });
    let calls = 0;
    const model: ModelClient = { complete: async () => (calls++, { text: "" }) };
    await tick({ colony, git: gitWith(), model, journal, now: () => 1_000_000, rand: () => 0.5 });
    expect(calls).toBe(0);
    expect(colony.abandoned[0]).toMatch(/^could not report it to a person, so the intent goes back: escalated \(other\): Too large for one agent/);
  });
});

describe("agent loop: a throttled provider", () => {
  it("waits at least the provider's Retry-After, without counting a failed attempt", async () => {
    const overloaded = Object.assign(new Error("Overloaded"), { statusCode: 529, responseHeaders: { "retry-after": "40" } });
    let n = 0;
    const r = await run(intentOf(), {
      model: async () => {
        n++;
        throw throttleError(overloaded, "claude-x");
      },
    });
    expect(n).toBe(1);
    // throttledSleepMs(1, 40 s, rand 0.5): 40 s and an eighth more, beyond the 4 s backoff of a first throttle.
    expect(r.sleepMs).toBe(45_000);
    const job = r.journal.job();
    expect(job?.attempts).toBe(0);
    expect(job?.throttled).toBe(1);
    expect(job?.lastError).toMatch(/model claude-x is throttled \(HTTP 529\) \(the provider asks to wait 40 s\): Overloaded/);
    expect(r.journal.counters()).toMatchObject({ throttled: 1 });
  });

  it("falls back to the throttle backoff when the provider names no wait", () => {
    expect(throttledSleepMs(3, null, () => 0.5)).toBe(throttleWaitMs(3, () => 0.5));
    expect(throttledSleepMs(5, 1_000, () => 0.5)).toBe(throttleWaitMs(5, () => 0.5));
    expect(throttledSleepMs(1, 120_000, () => 0)).toBe(120_000);
  });
});
