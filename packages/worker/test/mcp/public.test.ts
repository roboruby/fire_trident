import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Colony, ColonySnapshot, FieldReading, Intent, Landing, LineageNote, Path } from "@fire_trident/core";
import type { ErrorEnvelope } from "../../src/agents/rpc.ts";
import type { Env } from "../../src/env.ts";
import { MAX_PUBLIC_BODY, PUBLIC_DATA_NOTE, publicMcp, publicReads, servePublicMcp } from "../../src/mcp/public.ts";
import type { IntentHistory, PublicMcpOptions, PublicReads } from "../../src/mcp/public.ts";
import { RETRY_RULE } from "../../src/mcp/instructions.ts";

const sha = (c: string): string => c.repeat(40).slice(0, 40);
const ACCOUNT_REMOTE = "https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/";
const URL_BASE = "https://ft.test";
const ENDPOINT = `${URL_BASE}/public/mcp`;

const colonyInfo: Colony = {
  id: "hono",
  name: "hono",
  trunk: { namespace: "ft-trunk", name: "hono--trunk", remote: `${ACCOUNT_REMOTE}ft-trunk/hono--trunk.git` },
  trunkSha: sha("a"),
  greenSha: sha("9"),
  source: { url: "https://github.com/honojs/hono", branch: "main" },
  createdAt: Date.UTC(2026, 9, 12),
  regionDepth: 1,
};

const intent = (id: string, title: string, status: Intent["status"]): Intent => ({ id, colonyId: "hono", title, why: `why ${title}`, source: "rule", footprint: ["src/router.ts"], priority: 1, status, createdAt: 0, createdBy: "rule" });

function landing(id: string, at: number, paths: Path[], intentIds: string[]): Landing {
  return { id, colonyId: "hono", trunkSha: sha(id.slice(-1)), parentSha: sha("0"), proposalIds: intentIds.map((i) => `prp_${i}`), intentIds, paths, regions: ["src"], at };
}

const snapshot: ColonySnapshot = {
  colony: {
    ...colonyInfo,
    certification: {
      trunkSha: sha("a"),
      status: "red",
      counts: { tests: 60, pass: 57, fail: 2, cancelled: 1, skipped: 0, todo: 0, suites: 4 },
      failing: [{ name: "router matches params", file: "test/router.test.ts", error: "expected 2" }],
      startedAt: Date.UTC(2026, 9, 13, 10),
      finishedAt: Date.UTC(2026, 9, 13, 10, 0, 1),
      repairIntentId: "int_fix",
      suspects: [{ landingId: "lnd_2", proposalId: "prp_int_2", title: "Rewrite the router", paths: ["src/router.ts"], files: ["test/router.test.ts"], at: 0 }],
    },
  },
  files: [
    { path: "src/router.ts", size: 10 },
    { path: "README.md", size: 5 },
  ],
  intents: [intent("int_1", "Remove console.log from the router", "landed"), intent("int_2", "Rewrite the router", "landed")],
  rules: [{ id: "rul_1", colonyId: "hono", kind: "forbid-pattern", spec: { pattern: "console\\.log" }, description: "No console.log in src", approvedBy: "matt", createdAt: 0 }],
  agents: [],
  recentLandings: [landing("lnd_1", 1_000, ["src/router.ts"], ["int_1"]), landing("lnd_2", 2_000, ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts", "src/g.ts"], ["int_2", "int_gone"])],
  violations: { total: 4, byRule: { rul_1: 3, rul_9: 1 } },
  funnel: { reflex: 2, llm: 1, human: 1, proof: 5 },
  metrics: { intentsOpen: 2, intentsClaimed: 0, intentsLanded: 283, intentsWithdrawn: 1, agentsActive: 3, agentsWorking: 2, proposalsInFlight: 2, reviewQueue: 1, landingsPerMin: 4 },
  stuck: { at: 0, items: [{ key: "returns:int_3", kind: "returns", since: Date.UTC(2026, 9, 13, 9), text: 'Changes for "Fix the matcher" came back 3 times', action: "intent", intentId: "int_3" }], total: 1 },
};

const history: IntentHistory = {
  intent: intent("int_1", "Remove console.log from the router", "landed"),
  revisions: [{ intentId: "int_1", revision: 2, changed: ["why"], before: { why: "a" }, after: { why: "b" }, reason: "clearer", by: "matt", at: 5, substantive: true }],
  directives: [{ id: "dir_1", colonyId: "hono", agentId: "agt_1", kind: "guidance", intentId: "int_1", message: "keep the logger", by: "matt", at: 6 }],
  escalations: [],
};

/** A landing whose note carries one proposal per entry of `wrote`, with an Artifacts remote in a check's detail. */
function whyEntry(id: string, wrote: Path[][]): { landing: Landing; note: LineageNote } {
  const proposals = wrote.map((paths, i) => ({
    id: `prp_${id}_${i}`,
    agentId: `agt_${i}`,
    agentKind: "internal" as const,
    model: "@cf/google/gemma-4-26b-a4b-it",
    intent: { id: `int_${id}_${i}`, title: `change ${i}`, why: "w" },
    writeSet: paths.map((path) => ({ path, blob: sha("c") })),
    readSet: [],
    decisions: [],
    evidence: { checks: [{ name: "fetch", ok: true, ms: 1, detail: `read from ${ACCOUNT_REMOTE}ft-ws-1/hono--ws-1.git` }] },
  }));
  return {
    landing: { id, colonyId: "hono", trunkSha: sha("e"), parentSha: sha("f"), proposalIds: proposals.map((p) => p.id), intentIds: proposals.map((p) => p.intent.id), paths: wrote.flat(), regions: ["src"], at: 1 },
    note: { schema: "firetrident.lineage/v1", landingId: id, colonyId: "hono", proposals },
  };
}

function reading(region: string): FieldReading {
  return {
    region,
    at: 0,
    totals: { claim: 0.123456, need: 1, trail: 0, failure: 0, danger: 0 },
    byPath: { [`${region}/x.ts`]: { claim: 0.5 } },
    agents: [{ agentId: "agt_1", paths: [`${region}/x.ts`] }],
    sigma: 0.25,
    admission: { open: true, landingsPerMin: 0, activeAgents: 1 },
  } as FieldReading;
}

/** Reads over the fixtures that log every call, for the colonies hono (served) and others (which must never be read). */
function fakeReads(over: { snapshot?: () => Promise<ColonySnapshot> } = {}) {
  const calls: string[] = [];
  const reads: PublicReads = {
    colony: (id) => ({
      getColony: async () => {
        calls.push(`getColony ${id}`);
        return id === "hono" ? colonyInfo : null;
      },
      snapshot: async () => {
        calls.push(`snapshot ${id}`);
        return over.snapshot ? over.snapshot() : snapshot;
      },
      intentHistory: async (iid) => {
        calls.push(`intentHistory ${id} ${iid}`);
        return iid === "int_1" ? history : null;
      },
      listRegions: async () => {
        calls.push(`listRegions ${id}`);
        return [".", "src"];
      },
    }),
    region: (id, region) => ({
      reading: async (opts) => {
        calls.push(`reading ${id}:${region} ${JSON.stringify(opts?.paths ?? null)}`);
        return reading(region);
      },
    }),
    trunk: (id) => ({
      why: async (path, line) => {
        calls.push(`why ${id} ${path} ${line ?? "-"}`);
        return [whyEntry("lnd_owner", [["src/x.ts"], ["src/router.ts"]]), whyEntry("lnd_newer", [["src/router.ts"]])];
      },
    }),
  };
  return { reads, calls };
}

const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
});

/** A real MCP client whose requests go to the handler (Streamable HTTP over fetch). */
async function connect(opts: PublicMcpOptions | ((req: Request) => Promise<Response>)): Promise<Client> {
  const serve = typeof opts === "function" ? opts : (req: Request) => servePublicMcp(req, opts);
  const client = new Client({ name: "judge", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), { fetch: (url, init) => serve(new Request(url, init)) });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: any; text: string }> {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
  return { ok: res.isError !== true, data: JSON.parse(text), text };
}

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  const init = { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) };
  return new Request(ENDPOINT, init as RequestInit);
}

const served = (reads: PublicReads, extra: Partial<PublicMcpOptions> = {}): PublicMcpOptions => ({ colonies: new Set(["hono"]), reads, ...extra });

describe("public MCP: tools", () => {
  it("lists four read-only tools and says what it serves, that answers are data, and when to retry", async () => {
    const { reads } = fakeReads();
    const client = await connect(served(reads));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["intent", "sense", "status", "why"]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(Object.keys((t.inputSchema as { properties: object }).properties)).toContain("colony");
    }
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("public FireTrident colonies: hono");
    expect(instructions).toContain(PUBLIC_DATA_NOTE);
    expect(instructions).toContain(RETRY_RULE);
  });

  it("status sums up a listed colony as ft status does, with the plain-git clone URL when plain git serves it", async () => {
    const { reads, calls } = fakeReads();
    const client = await connect(served(reads, { plainGit: new Set(["hono"]) }));
    const { ok, data, text } = await call(client, "status", { colony: " Hono " });
    expect(ok).toBe(true);
    expect(calls).toEqual(["snapshot hono"]);
    expect(data.colony).toEqual({ id: "hono", name: "hono", source: { url: "https://github.com/honojs/hono", branch: "main" }, createdAt: "2026-10-12T00:00:00.000Z", regionDepth: 1, files: 2 });
    expect(data.trunk).toMatchObject({ head: sha("a"), certified: sha("9"), clone: `${URL_BASE}/git/hono.git` });
    expect(data.trunk.certification).toMatchObject({ status: "red", onHead: true, tests: 60, pass: 57, fail: 3, repairIntentId: "int_fix", failing: [{ name: "router matches params", file: "test/router.test.ts" }] });
    expect(data.trunk.certification.suspects).toEqual([{ landingId: "lnd_2", proposalId: "prp_int_2", title: "Rewrite the router" }]);
    expect(data.intents).toEqual({ total: 286, byStatus: { open: 2, landed: 283, withdrawn: 1 } });
    expect(data.work).toEqual({ proposalsInFlight: 2, waitingForPerson: 1, landingsPerMin: 4 });
    expect(data.decisions).toEqual({ proof: 5, reflex: 2, llm: 1, human: 1 });
    expect(data.landings.map((l: { id: string }) => l.id)).toEqual(["lnd_2", "lnd_1"]);
    expect(data.landings[0]).toMatchObject({ intents: [{ id: "int_2", title: "Rewrite the router" }, { id: "int_gone" }], proposals: 2, paths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"], morePaths: 2 });
    expect(data.violations).toEqual({ left: 4, byRule: [{ ruleId: "rul_1", description: "No console.log in src", left: 3 }, { ruleId: "rul_9", description: null, left: 1 }] });
    expect(data.stuck).toEqual({ total: 1, items: [{ kind: "returns", since: "2026-10-13T09:00:00.000Z", text: 'Changes for "Fix the matcher" came back 3 times', action: "intent", intentId: "int_3" }] });
    expect(data.about).toBe(PUBLIC_DATA_NOTE);
    // The trunk remote names the account: it is never in the answer.
    expect(text).not.toContain("artifacts.cloudflare.net");
    // Without plain git for the colony, no clone URL.
    const plain = await connect(served(fakeReads().reads));
    expect((await call(plain, "status", { colony: "hono" })).data.trunk).not.toHaveProperty("clone");
  });

  it("why answers a line's lineage trimmed to the proposals that wrote the path, with remotes hidden", async () => {
    const { reads, calls } = fakeReads();
    const client = await connect(served(reads));
    const { ok, data, text } = await call(client, "why", { colony: "hono", path: "./src/router.ts", line: 12 });
    expect(ok).toBe(true);
    expect(calls).toEqual(["getColony hono", "why hono src/router.ts 12"]);
    expect(data).toMatchObject({ colony: "hono", path: "src/router.ts", line: 12, about: PUBLIC_DATA_NOTE });
    expect(data.entries.map((e: { landing: Landing }) => e.landing.id)).toEqual(["lnd_owner", "lnd_newer"]);
    expect(data.entries[0].note.proposals.map((p: { id: string }) => p.id)).toEqual(["prp_lnd_owner_1"]);
    expect(data.entries[0].otherProposals).toBe(1);
    expect(data.entries[0].note.proposals[0].model).toBe("@cf/google/gemma-4-26b-a4b-it");
    expect(text).not.toContain("0123456789abcdef0123456789abcdef");
    expect(text).toContain("artifacts://ft-ws-1/hono--ws-1.git");
    const bad = await call(client, "why", { colony: "hono", path: "../etc/passwd" });
    expect(bad.ok).toBe(false);
    expect(bad.data.error).toMatchObject({ kind: "validation", status: 400 });
  });

  it("intent answers revisions, directives and reports as the public GET route does", async () => {
    const { reads } = fakeReads();
    const client = await connect(served(reads));
    const { ok, data } = await call(client, "intent", { colony: "hono", intentId: "int_1" });
    expect(ok).toBe(true);
    expect(data).toEqual({ colony: "hono", ...history, about: PUBLIC_DATA_NOTE });
    const unknown = await call(client, "intent", { colony: "hono", intentId: "int_404" });
    expect(unknown.data.error).toMatchObject({ kind: "not_found", status: 404, message: "unknown intent int_404 in colony hono" });
    expect((await call(client, "intent", { colony: "hono", intentId: "../x" })).data.error).toMatchObject({ kind: "validation" });
  });

  it("sense reads only the regions the colony has touched and names the others untouched", async () => {
    const { reads, calls } = fakeReads();
    const client = await connect(served(reads));
    const some = await call(client, "sense", { colony: "hono", paths: ["src/router.ts", "docs/guide.md", "README.md"] });
    expect(some.ok).toBe(true);
    expect(some.data).toMatchObject({ colony: "hono", regionDepth: 1, scope: "paths", truncated: false, untouched: ["docs"] });
    expect(some.data.readings.map((r: { region: string }) => r.region)).toEqual(["src", "."]);
    expect(some.data.readings[0].totals.claim).toBe(0.123);
    expect(calls.filter((c) => c.startsWith("reading"))).toEqual(['reading hono:src ["src/router.ts"]', 'reading hono:. ["README.md"]']);
    const all = await call(client, "sense", { colony: "hono" });
    expect(all.data.scope).toBe("colony");
    expect(all.data.readings.map((r: { region: string }) => r.region)).toEqual([".", "src"]);
    expect(calls.some((c) => c.includes(":docs"))).toBe(false);
  });

  it("refuses a colony that is not listed with a plain error, and reads nothing for it", async () => {
    const { reads, calls } = fakeReads();
    const client = await connect({ colonies: new Set(["hono", "shortlinks"]), reads });
    for (const [name, args] of [
      ["status", { colony: "byo-demo" }],
      ["why", { colony: "secret-colony", path: "src/a.ts" }],
      ["intent", { colony: "Byo-Demo", intentId: "int_1" }],
      ["sense", { colony: "../hono" }],
    ] as const) {
      const r = await call(client, name, args);
      expect(r.ok).toBe(false);
      expect(r.data.error).toMatchObject({ kind: "not_found", status: 404, retryable: false });
      expect(r.data.error.message).toMatch(/^no public colony ".+" here: ask about hono, shortlinks$/);
    }
    expect(calls).toEqual([]);
  });

  it("has no write: write-shaped calls find no tool, and the deployment's reads forward read methods only", async () => {
    const called: string[] = [];
    const answers: Record<string, unknown> = {
      "colony.getColony": colonyInfo,
      "colony.snapshot": snapshot,
      "colony.intentHistory": history,
      "colony.listRegions": ["src"],
      "region.reading": reading("src"),
      "trunk.why": [whyEntry("lnd_1", [["src/router.ts"]])],
    };
    // Durable Object stubs answer any method name: these record every call.
    const stub = (kind: string) =>
      new Proxy(
        {},
        {
          get: (_t, prop) => {
            if (typeof prop !== "string" || prop === "then") return undefined;
            return async () => {
              called.push(`${kind}.${prop}`);
              return answers[`${kind}.${prop}`];
            };
          },
        },
      );
    const ns = (kind: string) => ({ idFromName: (n: string) => n, get: () => stub(kind) });
    const env = { COLONY: ns("colony"), REGION: ns("region"), TRUNK: ns("trunk"), FT_PUBLIC_MCP: "hono" } as unknown as Env;
    expect(Object.keys(publicReads(env).colony("hono")).sort()).toEqual(["getColony", "intentHistory", "listRegions", "snapshot"]);
    expect(Object.keys(publicReads(env).region("hono", "src"))).toEqual(["reading"]);
    expect(Object.keys(publicReads(env).trunk("hono"))).toEqual(["why"]);
    const client = await connect((req) => publicMcp(req, env));
    for (const name of ["join", "declare", "propose", "take", "release", "escalate", "read", "checkout", "inbox"]) {
      const r = await call(client, name, { colony: "hono", title: "x", why: "y", footprint: ["src/a.ts"], headSha: sha("1") });
      expect(r.ok).toBe(false);
      expect(r.data.error).toMatchObject({ kind: "not_found", status: 404, retryable: false });
      expect(r.data.error.message).toContain(`Tool ${name} not found`);
    }
    expect(called).toEqual([]);
    for (const [name, args] of [
      ["status", { colony: "hono" }],
      ["why", { colony: "hono", path: "src/router.ts" }],
      ["intent", { colony: "hono", intentId: "int_1" }],
      ["sense", { colony: "hono" }],
      ["sense", { colony: "hono", paths: ["src/router.ts"] }],
    ] as const) {
      expect((await call(client, name, args)).ok).toBe(true);
    }
    expect([...new Set(called)].sort()).toEqual(["colony.getColony", "colony.intentHistory", "colony.listRegions", "colony.snapshot", "region.reading", "trunk.why"]);
  });

  it("a read that does not answer in time fails as unavailable, retryable", async () => {
    const { reads } = fakeReads({ snapshot: () => new Promise<ColonySnapshot>(() => undefined) });
    const client = await connect(served(reads, { deadlineMs: 20 }));
    const r = await call(client, "status", { colony: "hono" });
    expect(r.ok).toBe(false);
    const error = r.data.error as ErrorEnvelope;
    expect(error).toMatchObject({ kind: "unavailable", retryable: true });
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(1_000);
    expect(error.retryAfterMs).toBeLessThanOrEqual(5_000);
  });

  it("a failing read comes back as its envelope, with remotes hidden", async () => {
    const { reads } = fakeReads({
      snapshot: async () => {
        throw new Error(`[ft:503] trunk ${ACCOUNT_REMOTE}ft-trunk/hono--trunk.git is unreachable`);
      },
    });
    const client = await connect(served(reads));
    const r = await call(client, "status", { colony: "hono" });
    expect(r.data.error).toEqual({ kind: "server", message: "trunk artifacts://ft-trunk/hono--trunk.git is unreachable", retryable: false, status: 503 });
  });
});

describe("public MCP: the endpoint", () => {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "0" } } });
  const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });

  it("is off (404) unless FT_PUBLIC_MCP lists colonies, parsed like FT_PUBLIC_GIT", async () => {
    const env = (vars: Partial<Env>) => ({ COLONY: {}, REGION: {}, TRUNK: {}, ...vars }) as unknown as Env;
    expect((await publicMcp(post(list), env({}))).status).toBe(404);
    expect((await publicMcp(post(list), env({ FT_PUBLIC_MCP: " , BAD--name, " }))).status).toBe(404);
    const on = await publicMcp(post(init), env({ FT_PUBLIC_MCP: "hono, BAD--name,shortlinks" }));
    expect(on.status).toBe(200);
    expect(((await on.json()) as { result: { instructions: string } }).result.instructions).toContain("public FireTrident colonies: hono, shortlinks.");
  });

  it("answers one JSON response per POST, with no session", async () => {
    const res = await servePublicMcp(post(list), served(fakeReads().reads));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(4);
  });

  it("refuses an oversize request before parsing it", async () => {
    const opts = served(fakeReads().reads);
    const big = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "sense", arguments: { colony: "hono", paths: ["x".repeat(MAX_PUBLIC_BODY)] } } });
    const streamed = await servePublicMcp(post(big), opts);
    expect(streamed.status).toBe(413);
    expect(((await streamed.json()) as { error: { message: string } }).error.message).toMatch(/too large/);
    // A body that streams in without a length stops at the cap.
    const chunk = new TextEncoder().encode(" ".repeat(16 * 1024));
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        sent++;
        c.enqueue(chunk);
      },
    });
    expect((await servePublicMcp(post(endless), opts)).status).toBe(413);
    expect(sent).toBeLessThan(10);
    // A declared length over the cap is refused without reading.
    expect((await servePublicMcp(post(list, { "content-length": String(MAX_PUBLIC_BODY + 1) }), opts)).status).toBe(413);
  });

  it("validates JSON-RPC before building a server", async () => {
    const opts = served(fakeReads().reads);
    const status = async (body: string) => {
      const res = await servePublicMcp(post(body), opts);
      return { status: res.status, code: ((await res.json()) as { error: { code: number } }).error.code };
    };
    expect(await status("{ not json")).toEqual({ status: 400, code: -32700 });
    expect(await status(JSON.stringify({ id: 1, method: "tools/list" }))).toEqual({ status: 400, code: -32600 });
    expect(await status(JSON.stringify({ jsonrpc: "2.0", id: null, method: "tools/list" }))).toEqual({ status: 400, code: -32600 });
    expect(await status(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }))).toEqual({ status: 400, code: -32600 });
    expect(await status(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { arguments: {} } }))).toEqual({ status: 400, code: -32600 });
    expect(await status(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: ["hono"] } }))).toEqual({ status: 400, code: -32600 });
    expect(await status(JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }))))).toEqual({ status: 400, code: -32600 });
    expect(await status("[]")).toEqual({ status: 400, code: -32600 });
  });

  it("takes only POST of JSON from no browser or the same site, and turns requests away past the in-flight cap", async () => {
    const opts = served(fakeReads().reads);
    const get = await servePublicMcp(new Request(ENDPOINT, { method: "GET", headers: { accept: "text/event-stream" } }), opts);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect((await servePublicMcp(new Request(ENDPOINT, { method: "DELETE" }), opts)).status).toBe(405);
    expect((await servePublicMcp(post(list, { origin: "https://evil.example" }), opts)).status).toBe(403);
    expect((await servePublicMcp(post(list, { origin: "null" }), opts)).status).toBe(403);
    expect((await servePublicMcp(post(list, { origin: URL_BASE }), opts)).status).toBe(200);
    expect((await servePublicMcp(post(list, { "content-type": "text/plain" }), opts)).status).toBe(415);
    const busy = await servePublicMcp(post(list), { ...opts, maxInFlight: 0 });
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("1");
  });
});
