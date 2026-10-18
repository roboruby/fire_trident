import { describe, expect, it } from "vitest";
import type { Env } from "../../../src/env.ts";
import { reviewMcpRefusal } from "../../../src/mcp/review/gate.ts";

const env = (vars: Partial<Env>) => vars as Env;
const configured = env({ FT_ADMIN_TOKEN: "admin-s3cret", FT_MCP_TOKEN: "mcp-s3cret" });

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", headers });
}

async function refusal(r: Request, e: Env): Promise<{ status: number; error: string } | null> {
  const res = await reviewMcpRefusal(r, e);
  return res ? { status: res.status, error: ((await res.json()) as { error: string }).error } : null;
}

describe("the review endpoint's gate", () => {
  it("lets the admin token through as an Authorization: Bearer header", async () => {
    expect(await refusal(req("https://ft.test/mcp/review", { authorization: "Bearer admin-s3cret" }), configured)).toBeNull();
    expect(await refusal(req("https://ft.test/mcp/review", { Authorization: "bearer admin-s3cret" }), configured)).toBeNull();
    // A configured secret that kept the line break it was put with still matches (api/token.ts).
    expect(await refusal(req("https://ft.test/mcp/review", { authorization: "Bearer admin-s3cret" }), env({ FT_ADMIN_TOKEN: "admin-s3cret\r\n" }))).toBeNull();
  });

  it("refuses the agents' MCP token", async () => {
    const r = await refusal(req("https://ft.test/mcp/review", { authorization: "Bearer mcp-s3cret" }), configured);
    expect(r?.status).toBe(401);
    expect(r?.error).toContain("the agents' MCP token does not open it");
  });

  it("refuses the admin token when FT_MCP_TOKEN holds the same value: an agent's token never opens it", async () => {
    const same = env({ FT_ADMIN_TOKEN: "one-s3cret", FT_MCP_TOKEN: "one-s3cret\n" });
    const r = await refusal(req("https://ft.test/mcp/review", { authorization: "Bearer one-s3cret" }), same);
    expect(r?.status).toBe(403);
    expect(r?.error).toContain("set them to different values");
  });

  it("refuses a wrong, missing or malformed token, and a token in the URL", async () => {
    for (const authorization of ["Bearer admin-s3cre", "Bearer admin-s3cret-and-more", "admin-s3cret", "Basic admin-s3cret", ""]) {
      expect((await refusal(req("https://ft.test/mcp/review", { authorization }), configured))?.status, authorization).toBe(401);
    }
    const inUrl = await refusal(req("https://ft.test/mcp/review?token=admin-s3cret", { authorization: "Bearer admin-s3cret" }), configured);
    expect(inUrl?.status).toBe(401);
    expect(inUrl?.error).toContain("never in the URL");
  });

  it("fails closed without FT_ADMIN_TOKEN: FT_OPEN_WRITES does not open it, nor does the MCP token", async () => {
    for (const e of [env({}), env({ FT_OPEN_WRITES: "1" }), env({ FT_MCP_TOKEN: "mcp-s3cret", FT_OPEN_WRITES: "1" }), env({ FT_ADMIN_TOKEN: "\r\n" })]) {
      const r = await refusal(req("https://ft.test/mcp/review", { authorization: "Bearer mcp-s3cret" }), e);
      expect(r?.status).toBe(403);
      expect(r?.error).toMatch(/FT_ADMIN_TOKEN/);
    }
  });
});
