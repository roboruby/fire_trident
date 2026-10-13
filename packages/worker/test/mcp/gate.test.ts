import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.ts";
import { mcpRefusal } from "../../src/mcp/gate.ts";

const env = (vars: Partial<Env>) => vars as Env;
const configured = env({ FT_MCP_TOKEN: "mcp-s3cret" });

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", headers });
}

async function refusal(r: Request, e: Env): Promise<{ status: number; error: string } | null> {
  const res = await mcpRefusal(r, e);
  return res ? { status: res.status, error: ((await res.json()) as { error: string }).error } : null;
}

describe("the MCP gate", () => {
  it("lets the token through as an Authorization: Bearer header", async () => {
    expect(await refusal(req("https://ft.test/mcp", { authorization: "Bearer mcp-s3cret" }), configured)).toBeNull();
    expect(await refusal(req("https://ft.test/sse/message?sessionId=abc", { Authorization: "bearer mcp-s3cret" }), configured)).toBeNull();
  });

  it("refuses the token in the URL, and says to send it as a header", async () => {
    const r = await refusal(req("https://ft.test/mcp?token=mcp-s3cret"), configured);
    expect(r?.status).toBe(401);
    expect(r?.error).toContain("Authorization: Bearer <token>");
    // Even next to a good header: a token in a URL leaks into logs whatever else the request carries.
    expect((await refusal(req("https://ft.test/mcp?token=mcp-s3cret", { authorization: "Bearer mcp-s3cret" }), configured))?.status).toBe(401);
    expect((await refusal(req("https://ft.test/sse?token="), configured))?.status).toBe(401);
  });

  it("refuses a wrong, missing or malformed token", async () => {
    expect((await refusal(req("https://ft.test/mcp", { authorization: "Bearer mcp-s3cre" }), configured))?.status).toBe(401);
    expect((await refusal(req("https://ft.test/mcp", { authorization: "Bearer mcp-s3cret-and-more" }), configured))?.status).toBe(401);
    expect((await refusal(req("https://ft.test/mcp"), configured))?.status).toBe(401);
    expect((await refusal(req("https://ft.test/mcp", { authorization: "mcp-s3cret" }), configured))?.status).toBe(401);
    expect((await refusal(req("https://ft.test/mcp", { authorization: "Basic mcp-s3cret" }), configured))?.status).toBe(401);
  });

  it("fails closed without the secret, unless FT_OPEN_WRITES is 1 (local development)", async () => {
    const closed = await refusal(req("https://ft.test/mcp", { authorization: "Bearer anything" }), env({}));
    expect(closed?.status).toBe(403);
    expect(closed?.error).toMatch(/FT_MCP_TOKEN/);
    expect((await refusal(req("https://ft.test/mcp"), env({ FT_OPEN_WRITES: "true" })))?.status).toBe(403);
    expect(await refusal(req("https://ft.test/mcp"), env({ FT_OPEN_WRITES: "1" }))).toBeNull();
    // With the secret configured, FT_OPEN_WRITES changes nothing.
    expect((await refusal(req("https://ft.test/mcp"), env({ FT_MCP_TOKEN: "mcp-s3cret", FT_OPEN_WRITES: "1" })))?.status).toBe(401);
  });
});
