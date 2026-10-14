import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, Landing, LineageNote, NoteProvenance, Path } from "@fire_trident/core";
import { FireTridentTools } from "../../src/mcp/tools.ts";
import type { McpColonyRpc, Session, ToolContext } from "../../src/mcp/tools.ts";

/** MCP why answers each proposal with how its author and model are known, and reads notes written before that was kept. */

const sha = (c: string): string => c.repeat(40);
const colonyInfo: Colony = { id: "col", name: "Colony", trunk: { namespace: "ft-trunk", name: "col--trunk", remote: "https://trunk.invalid/col--trunk.git" }, trunkSha: sha("b"), createdAt: 0, regionDepth: 1 };
type Entry = { landing: Landing; note: LineageNote };

function setup(entries: Entry[]): FireTridentTools {
  const agents: AgentInfo[] = [];
  const colony = {
    getColony: async () => colonyInfo,
    getAgent: async (id: string) => agents.find((a) => a.id === id) ?? null,
    registerAgent: async (a: { kind: AgentInfo["kind"]; name: string }) => {
      const info: AgentInfo = { id: `agt_${agents.length + 1}`, colonyId: "col", kind: a.kind, name: a.name, thresholds: {}, state: "idle", lastSeen: 0 };
      agents.push(info);
      return info;
    },
    heartbeat: async () => undefined,
  };
  let session: Session = { reads: {}, proposals: [] };
  const ctx: ToolContext = {
    colony: () => colony as unknown as McpColonyRpc,
    region: () => {
      throw new Error("not used");
    },
    trunk: () => ({ why: async () => entries }),
    repo: async () => {
      throw new Error("not used");
    },
    load: async () => structuredClone(session),
    save: async (s) => {
      session = structuredClone(s);
    },
    now: () => 1_000_000,
  };
  return new FireTridentTools(ctx);
}

function entry(id: string, provenance?: unknown): Entry {
  const p = {
    id: `prp_${id}`,
    agentId: "agt_9",
    agentKind: "external" as const,
    model: "claude-sonnet-5-5",
    intent: { id: `int_${id}`, title: "t", why: "w" },
    writeSet: [{ path: "src/a.ts" as Path, blob: sha("c") }],
    readSet: [],
    decisions: [],
    evidence: { checks: [] },
    ...(provenance !== undefined ? { provenance: provenance as NoteProvenance } : {}),
  };
  return {
    landing: { id, colonyId: "col", trunkSha: sha("e"), parentSha: sha("f"), proposalIds: [p.id], intentIds: [p.intent.id], paths: ["src/a.ts"], regions: ["src"], at: 1 },
    note: { schema: "firetrident.lineage/v1", landingId: id, colonyId: "col", proposals: [p] },
  };
}

describe("MCP why: provenance", () => {
  it("passes each proposal's provenance on as the trunk writer recorded it, and reads older notes and unknown values", async () => {
    const declared: NoteProvenance = { author: "external", auth: "mcp", model: { evidence: "declared", name: "claude-sonnet-5-5" } };
    const tools = setup([entry("lnd_new", declared), entry("lnd_old"), entry("lnd_odd", { author: "someone", model: { evidence: "guessed" } })]);
    await tools.join({ colony: "col" });
    const res = (await tools.why({ path: "src/a.ts" })) as { entries: Entry[] };
    expect(res.entries.map((e) => e.note.proposals[0]?.provenance)).toEqual([declared, undefined, { author: "someone", model: { evidence: "guessed" } }]);
  });
});
