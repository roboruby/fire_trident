import { describe, expect, it } from "vitest";
import { redactDeep, redactEvidence, repairRedactedJson, summarizeColony, trimTranscript } from "../src/evidence.ts";

const FAKE_ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("redactEvidence", () => {
  it("removes tokens but keeps the JSON around them and existing placeholders", () => {
    expect(redactEvidence('{"trunkRead": "art_v2_not-a-real.token", "n": 1}')).toBe('{"trunkRead": "<redacted>", "n": 1}');
    expect(redactEvidence("Authorization: Bearer abc.def-123")).toBe("Authorization: Bearer <redacted>");
    expect(redactEvidence('git -c http.extraHeader="Authorization: Bearer <trunkRead>" clone')).toBe('git -c http.extraHeader="Authorization: Bearer <trunkRead>" clone');
    expect(redactEvidence("GET /mcp?token=abc123&x=1")).toBe("GET /mcp?token=<redacted>&x=1");
    expect(redactEvidence("FT_TOKEN=abc123 FT_MCP_TOKEN='xyz789' MODEL_API_KEY=sk-notarealkey0000000000")).toBe("FT_TOKEN=<redacted> FT_MCP_TOKEN='<redacted>' MODEL_API_KEY=<redacted>");
    expect(redactEvidence("key sk-notarealkey0000000000 here")).toBe("key <redacted> here");
    expect(redactEvidence('{"token":"abc"}')).toBe('{"token":"<redacted>"}');
  });

  it("replaces the account id in Artifacts hostnames, also when truncated", () => {
    expect(redactEvidence(`https://${FAKE_ACCOUNT}.artifacts.cloudflare.net/git/ft-trunk/x--trunk.git`)).toBe("https://ACCOUNT_ID.artifacts.cloudflare.net/git/ft-trunk/x--trunk.git");
    expect(redactEvidence("clone 'https://0123456…")).toBe("clone 'https://ACCOUNT_ID…");
  });

  it("removes emails and local paths, and leaves model ids, commit ids and code paths alone", () => {
    expect(redactEvidence("by someone@example.com")).toBe("by <email>");
    expect(redactEvidence("/Users/someone/work/repo/packages/cli/src/ft.ts", { repoRoot: "/Users/someone/work/repo" })).toBe("packages/cli/src/ft.ts");
    expect(redactEvidence("log: /var/folders/ab/xyz123/T/ft-watch-1.jsonl and /private/var/folders/ab/xyz123/T//ft-agent/a.js")).toBe("log: $TMPDIR/ft-watch-1.jsonl and $TMPDIR/ft-agent/a.js");
    expect(redactEvidence("kept at /private/tmp/claude-1/-proj/0000-session/scratchpad/clone/x")).toBe("kept at <scratch>/clone/x");
    expect(redactEvidence("/private/tmp/other and /Users/someone/.config")).toBe("<tmp>/other and ~/.config");
    const plain = "model @cf/google/gemma-4-26b-a4b-it=4,@cf/moonshotai/kimi-k2.7-code wrote src/middleware/bearer-auth/index.ts at 9a7220a8f2f232d890ca73a7f68cf159b6d936f5";
    expect(redactEvidence(plain)).toBe(plain);
  });

  it("redacts every string of a JSON value, keys included", () => {
    expect(redactDeep({ a: [`https://${FAKE_ACCOUNT}.artifacts.cloudflare.net/r.git`, 3], "x@example.com": { b: "Bearer secret1" } })).toEqual({
      a: ["https://ACCOUNT_ID.artifacts.cloudflare.net/r.git", 3],
      "<email>": { b: "Bearer <redacted>" },
    });
  });
});

describe("repairRedactedJson", () => {
  it("closes strings a capture-time redaction swallowed", () => {
    const broken = '{\n  "tokens": {\n    "trunkRead": "<redacted>    "workspaceWrite": "<redacted>  },\n  "n": 1\n}';
    expect(JSON.parse(repairRedactedJson(broken))).toEqual({ tokens: { trunkRead: "<redacted>", workspaceWrite: "<redacted>" }, n: 1 });
  });
});

describe("trimTranscript", () => {
  it("keeps the session, tool calls with named results, text, denials and the result; drops the rest", () => {
    const lines = [
      { type: "system", subtype: "init", model: "m-1", claude_code_version: "1.0", permissionMode: "acceptEdits", cwd: "/Users/someone/x", mcp_servers: [{ name: "firetrident", status: "connected", source: "dynamic" }], tools: ["Bash", "mcp__firetrident__join"] },
      { type: "assistant", timestamp: "t1", message: { content: [{ type: "thinking", thinking: "hidden" }, { type: "tool_use", id: "tu_1", name: "mcp__firetrident__join", input: { colony: "c" } }] } },
      { type: "rate_limit_event", rate_limit_info: {} },
      { type: "user", timestamp: "t2", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: '{"agentId":"agt_1"}' }] }] } },
      { type: "system", subtype: "thinking_tokens", estimated_tokens: 5 },
      { type: "assistant", timestamp: "t3", message: { content: [{ type: "text", text: "Done." }] } },
      { type: "system", subtype: "permission_denied", tool_name: "Bash", decision_reason: "changes directory" },
      { type: "user", timestamp: "t4", message: { content: [{ type: "tool_result", tool_use_id: "tu_2", is_error: true, content: "denied" }] } },
      { type: "result", subtype: "success", is_error: false, num_turns: 3, duration_ms: 1200, total_cost_usd: 0.01, result: "ok", usage: { input_tokens: 9 } },
    ].map((x) => JSON.stringify(x));
    expect(trimTranscript([...lines, "not json", ""])).toEqual([
      { type: "session", model: "m-1", version: "1.0", permissionMode: "acceptEdits", mcpServers: [{ name: "firetrident", status: "connected" }], mcpTools: ["mcp__firetrident__join"] },
      { type: "tool_use", at: "t1", name: "mcp__firetrident__join", input: { colony: "c" } },
      { type: "tool_result", at: "t2", name: "mcp__firetrident__join", isError: false, content: '{"agentId":"agt_1"}' },
      { type: "text", at: "t3", text: "Done." },
      { type: "permission_denied", tool: "Bash", reason: "changes directory" },
      { type: "tool_result", at: "t4", name: "", isError: true, content: "denied" },
      { type: "result", subtype: "success", isError: false, turns: 3, durationMs: 1200, costUsd: 0.01, result: "ok" },
    ]);
  });
});

describe("summarizeColony", () => {
  it("summarizes counters, rules, landings, decisions and agents from the read-only endpoints", () => {
    const s = summarizeColony({
      base: "https://ft.example.dev",
      colony: "demo",
      fetchedAt: "2026-10-12T00:00:00.000Z",
      reads: ["GET /api/colonies/demo"],
      snapshot: {
        colony: { id: "demo", trunk: { namespace: "ft-trunk", name: "demo--trunk", remote: "https://r" }, trunkSha: "abc", createdAt: 0, source: { url: "https://github.com/o/r" } },
        files: [{ path: "a" }, { path: "b" }],
        intents: [
          { id: "i1", source: "rule", status: "landed" },
          { id: "i2", source: "human", status: "landed", title: "Follow-up", createdBy: "pat", createdAt: 0 },
        ],
        recentLandings: [{ id: "l1", at: 1000, trunkSha: "s1", parentSha: "s0", proposalIds: ["p1", "p2"], intentIds: ["i1"], paths: ["a"] }],
        rules: [{ id: "r1", kind: "forbid-import", description: "d", approvedBy: "pat", createdAt: 0 }],
        violations: { total: 0, byRule: { r1: 0 } },
      },
      metrics: { metrics: { intents: 3, intentsLanded: 3, landings: 2, proposals: 3, landedProposals: 3, returned: 0, "decide.deterministic.land": 3, "funnel.reflex": 0 }, funnel: { reflex: 0, llm: 0, human: 0 } },
      agents: { agents: [{ kind: "internal", state: "dead", model: "m" }, { kind: "external", state: "dead", model: "m" }] },
      immune: { decisions: [{ layer: "deterministic", action: "land", n: 3 }], antibodies: [], autonomy: [{ earned: true }, { earned: false }] },
      review: [],
      vaccination: { overall: { n: 0 } },
    });
    expect(s.map).toBe("https://ft.example.dev/c/demo");
    expect(s.trunk).toEqual({ repo: "ft-trunk/demo--trunk", remote: "https://r", sha: "abc", files: 2 });
    expect(s.rules).toEqual([{ id: "r1", kind: "forbid-import", description: "d", approvedBy: "pat", createdAt: "1970-01-01T00:00:00.000Z", violationsNow: 0 }]);
    const intents = s.intents as Record<string, unknown>;
    expect(intents.listedNote).toBe("the snapshot lists 2 of 3 intents");
    expect(intents.notFromRules).toEqual([{ id: "i2", title: "Follow-up", source: "human", status: "landed", createdBy: "pat", createdAt: "1970-01-01T00:00:00.000Z" }]);
    const landings = s.landings as { total: number; recent: unknown[] };
    expect(landings.total).toBe(2);
    expect(landings.recent).toEqual([{ id: "l1", at: "1970-01-01T00:00:01.000Z", trunkSha: "s1", parentSha: "s0", proposals: 2, intents: 1, paths: ["a"] }]);
    const decide = s.decide as Record<string, unknown>;
    expect(decide.counters).toEqual({ "decide.deterministic.land": 3, "funnel.reflex": 0 });
    expect(decide.autonomyEarnedRegions).toBe(1);
    expect(decide.vaccination).toEqual({ n: 0, note: "no vaccination batch on this colony" });
    expect(s.agents).toEqual({ total: 2, byKind: { internal: 1, external: 1 }, byState: { dead: 2 }, byModel: { m: 2 } });
    expect(s.lineage).toBeUndefined();
  });
});
