import { describe, expect, it } from "vitest";
import type { FileVersion, Path, Proposal, Sha, WorkspaceLease } from "@fire_trident/core";
import { blobId, changesetId } from "@fire_trident/core";
import { replayAnswer, replayedProposal, PROPOSE_REPLAY_NOTE } from "../../src/mcp/replay.ts";
import type { McpColonyRpc, McpTrunkRpc, Session } from "../../src/mcp/tools.ts";

/** Which earlier proposal a propose replays (mcp/replay.ts): only the session's newest, only the same change. */

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const OLD = "export const helper = 1;\n";
const NEW = "export const helper = 2;\n";

function prop(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "prp_1",
    colonyId: "col",
    intentId: "int_1",
    agentId: "agt_1",
    workspace: { namespace: "ws", name: "col--ws-1", remote: "https://ws.invalid/x.git" },
    baseSha: BASE,
    headSha: HEAD,
    writeSet: [{ path: "src/a.ts", blob: blobId(NEW) }],
    readSet: [],
    declared: { footprint: ["src/**"], summary: "s" },
    evidence: { checks: [], residual: [], notVerified: "n" },
    status: "ready",
    createdAt: 0,
    ...over,
  };
}

function setup(p: Proposal) {
  const reads: string[] = [];
  const ctx = {
    colony: () => ({ getProposal: async (id: string) => (reads.push(id), id === p.id ? p : null) }) as unknown as McpColonyRpc,
    trunk: () => ({ baseBlobs: async (_b: Sha, paths: Path[]): Promise<FileVersion[]> => paths.map((path) => ({ path, blob: path === "src/a.ts" || path === "src/same.ts" ? blobId(OLD) : null })) }) as unknown as McpTrunkRpc,
  };
  const session = (over: Partial<Session> = {}): Session => ({ colonyId: "col", agentId: "agt_1", reads: {}, proposals: [{ id: p.id, intentId: p.intentId, headSha: p.headSha, at: 1 }], ...over });
  return { ctx, session, reads };
}

describe("replayedProposal", () => {
  it("replays the newest proposal for the same head commit, whatever its case and spaces", async () => {
    const p = prop();
    const { ctx, session } = setup(p);
    expect(await replayedProposal(session(), { headSha: ` ${HEAD.toUpperCase()} ` }, ctx)).toEqual(p);
    expect(await replayedProposal(session(), { headSha: "d".repeat(40) }, ctx)).toBeNull();
  });

  it("replays the same inline change, files in any order and an unchanged one sent along", async () => {
    const writeSet = [{ path: "src/a.ts", blob: blobId(NEW) }, { path: "src/gone.ts", blob: null }];
    const p = prop({ headSha: changesetId(BASE, writeSet), writeSet });
    const { ctx, session } = setup({ ...p, writeSet });
    const files = [{ path: "src/gone.ts", content: null }, { path: "src/same.ts", content: OLD }, { path: "src/a.ts", content: NEW }];
    expect((await replayedProposal(session(), { files }, ctx))?.id).toBe(p.id);
    expect(await replayedProposal(session(), { files: [{ path: "src/a.ts", content: NEW }] }, ctx)).toBeNull();
    expect(await replayedProposal(session(), { files: [{ path: "src/a.ts", content: "export const helper = 3;\n" }, { path: "src/gone.ts", content: null }] }, ctx)).toBeNull();
  });

  it("leaves a session that holds an intent, has not joined or proposed nothing to the usual path, reading nothing", async () => {
    const p = prop();
    const { ctx, session, reads } = setup(p);
    const lease = { baseSha: BASE } as WorkspaceLease;
    expect(await replayedProposal(session({ lease }), { headSha: HEAD }, ctx)).toBeNull();
    expect(await replayedProposal(session({ agentId: undefined }), { headSha: HEAD }, ctx)).toBeNull();
    expect(await replayedProposal(session({ proposals: [] }), { headSha: HEAD }, ctx)).toBeNull();
    expect(reads).toEqual([]);
  });

  it("never replays another agent's proposal, or arguments that name no single change", async () => {
    const { ctx, session } = setup(prop({ agentId: "agt_2" }));
    expect(await replayedProposal(session(), { headSha: HEAD }, ctx)).toBeNull();
    const mine = setup(prop());
    expect(await replayedProposal(mine.session(), {}, mine.ctx)).toBeNull();
    expect(await replayedProposal(mine.session(), { headSha: HEAD, files: [] }, mine.ctx)).toBeNull();
  });

  it("answers as the first propose did, marked replayed", () => {
    expect(replayAnswer(prop({ status: "returned", reason: "stale" }))).toEqual({
      proposal: { id: "prp_1", status: "returned", reason: "stale", residual: [] },
      writeSet: [{ path: "src/a.ts", blob: blobId(NEW) }],
      readSet: 0,
      replayed: true,
      note: PROPOSE_REPLAY_NOTE,
    });
  });
});
