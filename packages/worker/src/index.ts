import { Hono } from "hono";
import type { Env } from "./env.ts";
import { api } from "./api/routes.ts";
import { FireTridentMcp } from "./mcp/FireTridentMcp.ts";

export { ColonyDO } from "./colony/ColonyDO.ts";
export { RegionDO } from "./region/RegionDO.ts";
export { TrunkDO } from "./trunk/TrunkDO.ts";
export { PoolDO } from "./pool/PoolDO.ts";
export { AgentDO } from "./agents/AgentDO.ts";
export { FireTridentMcp } from "./mcp/FireTridentMcp.ts";
export { IngestWorkflow } from "./workflows/IngestWorkflow.ts";
export { VerifyWorkflow } from "./workflows/VerifyWorkflow.ts";

const app = new Hono<{ Bindings: Env }>();
app.route("/api", api);
app.get("/healthz", (c) => c.json({ ok: true, service: "firetrident" }));
// MCP for external agents: Streamable HTTP at /mcp, legacy SSE at /sse (one Durable Object per session, binding MCP).
const mcpHttp = FireTridentMcp.serve("/mcp", { binding: "MCP" });
const mcpSse = FireTridentMcp.serveSSE("/sse", { binding: "MCP" });

/** When FT_MCP_TOKEN is set, MCP clients must send it as a Bearer header or a `token` query parameter. */
function mcpAuthorized(req: Request, env: Env): boolean {
  const expected = env.FT_MCP_TOKEN;
  if (!expected) return true;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const query = new URL(req.url).searchParams.get("token") ?? "";
  return bearer === expected || query === expected;
}

const mcpGate = (handler: typeof mcpHttp) => (c: { req: { raw: Request }; env: Env; executionCtx: unknown }) =>
  mcpAuthorized(c.req.raw, c.env)
    ? handler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext)
    : new Response(JSON.stringify({ error: "unauthorized: send the FireTrident MCP token" }), { status: 401, headers: { "content-type": "application/json" } });

app.all("/mcp", mcpGate(mcpHttp));
app.all("/mcp/*", mcpGate(mcpHttp));
app.all("/sse", mcpGate(mcpSse));
app.all("/sse/*", mcpGate(mcpSse));
// Static UI falls through to ASSETS.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
