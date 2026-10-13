import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, FileVersion, Intent, Path, Proposal, Sha, WorkspaceLease } from "@fire_trident/core";
import { INLINE_LIMITS, blobId, changesetId } from "@fire_trident/core";
import type { ProposeInput, TakeResult } from "../../src/agents/rpc.ts";
import { FireTridentTools, inlinePathProblem } from "../../src/mcp/tools.ts";
import type { McpColonyRpc, RepoReader, Session, ToolContext } from "../../src/mcp/tools.ts";
import { INLINE_STEP, SERVER_INSTRUCTIONS, serverInstructions } from "../../src/mcp/instructions.ts";

/** MCP propose with `files`: an inline change, built against the lease base with no git at all. */

const BASE = "b".repeat(40);
const UTIL = "export const helper = 1;\n";
const README = "# readme\n";
const OLD = "export const old = true;\n";
const TRUNK_FILES: Record<Path, string> = { "src/lib/util.ts": UTIL, "README.md": README, "src/old.ts": OLD };

const colonyInfo: Colony = { id: "col", name: "Colony", trunk: { namespace: "ft-trunk", name: "col--trunk", remote: "https://trunk.invalid/col--trunk.git" }, trunkSha: BASE, createdAt: 0, regionDepth: 1 };
const lease: WorkspaceLease = {
  repo: { namespace: "ft-ws-2", name: "col--ws-2", remote: "https://ws.invalid/col--ws-2.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Date.UTC(2030, 0, 1),
  baseSha: BASE,
  leasedAt: 0,
  trunk: { remote: colonyInfo.trunk.remote, token: "fixture-trunk", sha: BASE },
};
const intent: Intent = { id: "int_1", colonyId: "col", title: "Rename helper", why: "Clarity", source: "human", footprint: ["src/**"], priority: 1, status: "claimed", createdAt: 0, createdBy: "t" };

/** The colony as the tools see it: one agent, one intent, and the proposals it receives. */
class FakeColony {
  proposals: ProposeInput[] = [];
  agents: AgentInfo[] = [];
  async getColony(): Promise<Colony | null> {
    return colonyInfo;
  }
  async getAgent(id: string): Promise<AgentInfo | null> {
    return this.agents.find((a) => a.id === id) ?? null;
  }
  async registerAgent(a: { kind: AgentInfo["kind"]; name: string }): Promise<AgentInfo> {
    const info: AgentInfo = { id: `agt_${this.agents.length + 1}`, colonyId: "col", kind: a.kind, name: a.name, thresholds: {}, state: "idle", lastSeen: 0 };
    this.agents.push(info);
    return info;
  }
  async heartbeat(): Promise<void> {}
  async take(): Promise<TakeResult> {
    return { intent, lease };
  }
  async propose(p: ProposeInput): Promise<Proposal> {
    this.proposals.push(p);
    return { ...p, id: "prp_1", status: "checking", createdAt: 0, evidence: { checks: [], residual: [], notVerified: "n" } };
  }
}

/** The trunk at BASE through the binding: one tree per directory, blobs by id (what the read tool reads). */
function trunkReader(): RepoReader {
  const blobs = new Map(Object.values(TRUNK_FILES).map((t) => [blobId(t), t]));
  const trees = new Map<string, Array<{ name: string; mode: string; hash: string; type: "blob" | "tree" }>>([
    ["1".repeat(40), [
      { name: "README.md", mode: "100644", hash: blobId(README), type: "blob" },
      { name: "src", mode: "40000", hash: "2".repeat(40), type: "tree" },
    ]],
    ["2".repeat(40), [
      { name: "lib", mode: "40000", hash: "3".repeat(40), type: "tree" },
      { name: "old.ts", mode: "100644", hash: blobId(OLD), type: "blob" },
    ]],
    ["3".repeat(40), [{ name: "util.ts", mode: "100644", hash: blobId(UTIL), type: "blob" }]],
  ]);
  return {
    readCommit: async (h) => (h === BASE ? { hash: BASE, treeHash: "1".repeat(40), parents: [] } : null),
    readTree: async (h) => trees.get(h) ?? null,
    readBlob: async (h) => {
      const b = blobs.get(h);
      return b === undefined ? null : { arrayBuffer: async () => new TextEncoder().encode(b).buffer as ArrayBuffer };
    },
    release() {},
  };
}

/** A joined session holding the intent, on a colony that takes inline changes unless `inline` is false. */
async function setup(opts: { inline?: boolean; baseBlobs?: boolean } = {}) {
  const colony = new FakeColony();
  let session: Session = { reads: {}, proposals: [] };
  const opened: string[] = [];
  const baseCalls: Array<{ baseSha: Sha; paths: Path[] }> = [];
  const ctx: ToolContext = {
    colony: () => colony as unknown as McpColonyRpc,
    region: () => {
      throw new Error("no field reads here");
    },
    trunk: () => ({
      why: async () => [],
      ...(opts.baseBlobs === false
        ? {}
        : {
            baseBlobs: async (baseSha: Sha, paths: Path[]): Promise<FileVersion[]> => {
              baseCalls.push({ baseSha, paths });
              return paths.map((path) => ({ path, blob: baseSha === BASE && TRUNK_FILES[path] !== undefined ? blobId(TRUNK_FILES[path]!) : null }));
            },
          }),
    }),
    repo: async (ref) => {
      opened.push(`${ref.namespace}/${ref.name}`);
      if (ref.namespace !== "ft-trunk") throw new Error(`workspace ${ref.name} opened`);
      return trunkReader();
    },
    inline: () => opts.inline !== false,
    load: async () => structuredClone(session),
    save: async (s) => {
      session = structuredClone(s);
    },
    now: () => 1_000_000,
    sleep: async () => undefined,
  };
  const tools = new FireTridentTools(ctx);
  await tools.join({ colony: "col" });
  await tools.take();
  return { tools, colony, opened, baseCalls, session: () => session };
}

describe("MCP propose with files (an inline change)", () => {
  it("computes the write set against the lease base: a change, a new file, a deletion, and an unchanged file dropped", async () => {
    const { tools, colony, opened, baseCalls, session } = await setup();
    await tools.read({ path: "src/lib/util.ts" });
    const util = "export const helper = 2;\n";
    const fresh = "export function fresh(): number {\n  return 3;\n}\n";
    const out = (await tools.propose({
      files: [
        { path: "src/lib/util.ts", content: util },
        { path: "README.md", content: README },
        { path: "src/new.ts", content: fresh },
        { path: "src/old.ts", content: null },
      ],
      summary: "rename",
      notVerified: "the tests",
    })) as Record<string, unknown>;
    const writeSet: FileVersion[] = [
      { path: "src/lib/util.ts", blob: blobId(util) },
      { path: "src/new.ts", blob: blobId(fresh) },
      { path: "src/old.ts", blob: null },
    ];
    expect(out.writeSet).toEqual(writeSet);
    expect(out.unchanged).toEqual(["README.md"]);
    expect(baseCalls).toEqual([{ baseSha: BASE, paths: ["src/lib/util.ts", "README.md", "src/new.ts", "src/old.ts"] }]);
    const sent = colony.proposals[0]!;
    expect(sent).toMatchObject({
      colonyId: "col",
      intentId: "int_1",
      workspace: lease.repo,
      baseSha: BASE,
      headSha: changesetId(BASE, writeSet),
      writeSet,
      readSet: [{ path: "src/lib/util.ts", blob: blobId(UTIL) }],
      contents: { [blobId(util)]: util, [blobId(fresh)]: fresh },
      declared: { footprint: ["src/**"], summary: "rename" },
      evidence: { notVerified: "Not verified: the tests" },
    });
    // No git: the workspace was never opened (the trunk only, for the read).
    expect(opened).toEqual(["ft-trunk/col--trunk"]);
    // The session moves on as after any proposal.
    expect(session().intent).toBeUndefined();
    expect(session().proposals.map((p) => p.headSha)).toEqual([changesetId(BASE, writeSet)]);
  });

  it("refuses to delete a file the lease base does not have, and a change that changes nothing", async () => {
    const { tools, colony } = await setup();
    await expect(tools.propose({ files: [{ path: "src/ghost.ts", content: null }] })).rejects.toThrow(/^\[ft:400\] src\/ghost\.ts does not exist at your lease base, so it cannot be deleted$/);
    await expect(tools.propose({ files: [{ path: "README.md", content: README }] })).rejects.toThrow(/^\[ft:400\] every file you sent is unchanged from your lease base/);
    expect(colony.proposals).toEqual([]);
  });

  it("refuses paths that are not relative, climb out, touch .git or repeat", async () => {
    const { tools, colony } = await setup();
    const bad: Array<[string, RegExp]> = [
      ["/etc/passwd", /is not a relative path/],
      ["C:/x.ts", /is not a relative path/],
      ["src\\a.ts", /is not a relative path/],
      ["../x.ts", /empty, "\." or "\.\." segment/],
      ["src/../../x.ts", /empty, "\." or "\.\." segment/],
      ["src//a.ts", /empty, "\." or "\.\." segment/],
      ["src/a.ts/", /empty, "\." or "\.\." segment/],
      ["./src/a.ts", /empty, "\." or "\.\." segment/],
      [".git/config", /is inside \.git/],
      ["src/.GIT/hooks/pre-commit", /is inside \.git/],
      ["", /a file has no path/],
      [" src/a.ts", /starts or ends with a space/],
      ["src/a.ts\n", /starts or ends with a space/],
      [`src/${"x".repeat(1_100)}.ts`, /is over 1024 characters/],
    ];
    for (const [path, why] of bad) {
      expect(inlinePathProblem(path)).toMatch(why);
      await expect(tools.propose({ files: [{ path, content: "x\n" }] })).rejects.toThrow(/^\[ft:400\]/);
    }
    await expect(tools.propose({ files: [{ path: "src/a.ts", content: "a\n" }, { path: "src/a.ts", content: "b\n" }] })).rejects.toThrow(/src\/a\.ts is sent twice/);
    expect(inlinePathProblem("src/lib/util.ts")).toBeNull();
    expect(colony.proposals).toEqual([]);
  });

  it("takes exactly one of headSha and files", async () => {
    const { tools } = await setup();
    await expect(tools.propose({ headSha: "c".repeat(40), files: [{ path: "src/a.ts", content: "a\n" }] })).rejects.toThrow(/^\[ft:400\] pass exactly one of headSha/);
    await expect(tools.propose({})).rejects.toThrow(/^\[ft:400\] pass exactly one of headSha/);
    await expect(tools.propose({ headSha: "  " })).rejects.toThrow(/^\[ft:400\] pass exactly one of headSha/);
    await expect(tools.propose({ files: [] })).rejects.toThrow(/^\[ft:400\] files is empty/);
  });

  it("stays within the limits of an inline change", async () => {
    const { tools, colony } = await setup();
    const many = Array.from({ length: INLINE_LIMITS.files + 1 }, (_, i) => ({ path: `src/f${i}.ts`, content: `export const f${i} = ${i};\n` }));
    await expect(tools.propose({ files: many })).rejects.toThrow(/^\[ft:400\] an inline change sends at most 64 files/);
    await expect(tools.propose({ files: [{ path: "src/big.txt", content: "x".repeat(INLINE_LIMITS.fileBytes + 1) }] })).rejects.toThrow(/^\[ft:400\] src\/big\.txt is 262145 bytes, over the 262144-byte limit/);
    await expect(tools.propose({ files: [{ path: "src/bin.dat", content: "a\0b" }] })).rejects.toThrow(/is not text/);
    await expect(tools.propose({ files: [{ path: "src/a.ts", content: 7 as unknown as string }] })).rejects.toThrow(/must be its text, or null/);
    expect(colony.proposals).toEqual([]);
  });

  it("is refused where the colony does not take inline changes, and where the trunk writer cannot read the base", async () => {
    const off = await setup({ inline: false });
    await expect(off.tools.propose({ files: [{ path: "src/a.ts", content: "a\n" }] })).rejects.toThrow(/^\[ft:409\] inline changes are off for this colony/);
    const old = await setup({ baseBlobs: false });
    await expect(old.tools.propose({ files: [{ path: "src/a.ts", content: "a\n" }] })).rejects.toThrow(/^\[ft:503\]/);
    expect(off.colony.proposals).toEqual([]);
    expect(old.colony.proposals).toEqual([]);
  });
});

describe("MCP instructions for inline changes", () => {
  it("tell agents they may skip git within the limits, only where inline changes are on", () => {
    expect(serverInstructions(false)).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS).not.toContain("files:");
    const on = serverInstructions(true);
    expect(on).toContain(INLINE_STEP);
    expect(INLINE_STEP).toContain("needs no clone, no commit, no push and no workspace token");
    expect(INLINE_STEP).toContain("at most 64 text files (256 KB a file, 512 KB in all)");
    expect(INLINE_STEP).toContain("Use the git steps for larger changes and for binary files.");
    // It comes right after the git way to propose, and every other step is unchanged.
    const lines = on.split("\n");
    expect(lines[lines.indexOf(INLINE_STEP) - 1]).toMatch(/^6\. propose with the head commit id/);
    expect(lines.filter((l) => l !== INLINE_STEP).join("\n")).toBe(SERVER_INSTRUCTIONS);
  });
});
