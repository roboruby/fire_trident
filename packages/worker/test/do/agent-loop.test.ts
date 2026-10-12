import { describe, expect, it } from "vitest";
import type { ColonySnapshot, FileVersion, Proposal, Rule, Sha } from "@fire_trident/core";
import { MemoryJournal } from "../../src/agents/journal.ts";
import { FIRST_POLL_MS, tick as agentTick } from "../../src/agents/loop.ts";
import type { AgentConfig, BaseFile, GitOps, LoopDeps } from "../../src/agents/loop.ts";
import type { ColonyRpc } from "../../src/agents/rpc.ts";
import { addAgent, api, colony, externalLanding, fakeSha, newColony, tick as laneTick, trunk } from "./helpers.ts";

/**
 * The agent loop (src/agents/loop.ts) against the real ColonyDO and RegionDO.
 * Only git is a stand-in: it serves the harness trunk's files and records
 * commits and pushes, since Artifacts is not available in tests.
 */
class HarnessGit implements GitOps {
  commits: Array<{ message: string; changes: Array<{ path: string; content: string }> }> = [];
  pushes: Sha[] = [];
  constructor(private readonly colonyId: string) {}

  async ensureBase(p: { baseSha: Sha }): Promise<{ baseSha: Sha; fallback: boolean }> {
    const s = await trunk(this.colonyId).state();
    if (!s.commits[p.baseSha]) throw new Error(`unknown base ${p.baseSha}`);
    return { baseSha: p.baseSha, fallback: false };
  }
  async listFiles(): Promise<string[]> {
    return Object.keys((await trunk(this.colonyId).state()).files);
  }
  async readFile(baseSha: Sha, path: string): Promise<BaseFile | null> {
    const s = await trunk(this.colonyId).state();
    const blob = s.commits[baseSha]?.[path];
    const file = s.files[path];
    if (!blob || !file || file.blob !== blob) return null;
    return { blob, mode: "100644", bytes: new TextEncoder().encode(file.content) };
  }
  async commit(p: Parameters<GitOps["commit"]>[0]): Promise<{ headSha: Sha; writeSet: FileVersion[] }> {
    this.commits.push({ message: p.message, changes: p.changes });
    return { headSha: fakeSha(), writeSet: p.changes.map((c) => ({ path: c.path, blob: fakeSha() })) };
  }
  async push(p: { headSha: Sha }): Promise<void> {
    this.pushes.push(p.headSha);
  }
}

const noModel = {
  async complete(): Promise<never> {
    throw new Error("a synthetic agent with a replacement rule must not call a model");
  },
};

async function setup() {
  const c = await newColony();
  const res = await api<{ rule: Rule; violations: number; intents: number }>("POST", `/colonies/${c.id}/rules`, {
    colonyId: c.id,
    kind: "forbid-pattern",
    spec: { pattern: "console\\.log", hint: "use the logger", replacement: "logger.info", include: ["src/**"] },
    description: "No console.log",
    approvedBy: "test",
  });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ violations: 1, intents: 1 });
  const agent = await addAgent(c.id, "synthetic-1");
  const journal = new MemoryJournal();
  const cfg: AgentConfig = { colonyId: c.id, agentId: agent.id, name: agent.name, kind: "synthetic", model: "none", running: true, epoch: 1, startedAt: Date.now(), failures: 0 };
  journal.setConfig(cfg);
  const git = new HarnessGit(c.id);
  const deps: LoopDeps = { colony: colony(c.id) as unknown as ColonyRpc, git, model: noModel, journal, now: () => Date.now() };
  return { c, agent, journal, git, deps, rule: res.body.rule };
}

describe("agent loop against the real ColonyDO", () => {
  it("fixes a rule violation end to end and sees it land", async () => {
    const { c, agent, journal, git, deps } = await setup();

    expect(await agentTick(deps)).toEqual({ sleepMs: FIRST_POLL_MS });
    expect(git.commits).toHaveLength(1);
    expect(git.commits[0]!.changes).toEqual([{ path: "src/app/main.ts", content: 'import { helper } from "../lib/util";\nlogger.info(helper());\n' }]);
    const job = journal.job()!;
    expect(job.step).toBe("await");

    const p = (await colony(c.id).getProposal(job.proposalId!)) as Proposal;
    const base = await trunk(c.id).state();
    expect(p).toMatchObject({ agentId: agent.id, intentId: job.intentId, headSha: git.pushes[0], baseSha: base.head, status: "ready" });
    expect(p.readSet).toEqual([{ path: "src/app/main.ts", blob: base.files["src/app/main.ts"]!.blob }]);
    expect(p.writeSet).toEqual([{ path: "src/app/main.ts", blob: job.writeSet![0]!.blob }]);
    expect(p.evidence.residual).toEqual([]);
    expect(p.evidence.checks[0]).toMatchObject({ name: "recheck src/app/main.ts", ok: true });

    await laneTick(c.id, "src");
    expect(((await colony(c.id).getProposal(p.id)) as Proposal).status).toBe("landed");

    const next = await agentTick(deps);
    expect(next.sleepMs).toBeGreaterThan(0); // nothing left to take: the colony's wait hint
    expect(journal.history(1)[0]).toMatchObject({ outcome: "landed", proposalId: p.id, method: "replacement", llmCalls: 0 });
    const snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(snap.intents.find((i) => i.id === job.intentId)!.status).toBe("landed");
  });

  it("is returned when trunk changes a file it read, and records why", async () => {
    const { c, journal, deps } = await setup();
    await agentTick(deps);
    const job = journal.job()!;
    await externalLanding(c.id, { "src/app/main.ts": "export const changedUnderneath = true;\n" });
    await laneTick(c.id, "src");
    expect(((await colony(c.id).getProposal(job.proposalId!)) as Proposal).status).toBe("returned");

    await agentTick(deps);
    expect(journal.history(1)[0]).toMatchObject({ outcome: "returned", proposalId: job.proposalId });
    expect(journal.history(1)[0]!.reason).toContain("src/app/main.ts");
  });
});
