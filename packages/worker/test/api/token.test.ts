import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type ApiEnv, hideRemotes, requireAdmin, requireAdminStrict } from "../../src/api/app.ts";
import { bearerMatches, configuredToken, tokensEqual } from "../../src/api/token.ts";
import { decideApi } from "../../src/api/vaccinate.ts";
import type { Env } from "../../src/env.ts";
import { mcpRefusal } from "../../src/mcp/gate.ts";

/**
 * A deployment secret put with its trailing line break (FT_ADMIN_TOKEN, FT_MCP_TOKEN) still matches the token a client
 * sends: the configured side drops CR and LF at its ends (api/token.ts), the presented side is compared as sent, and a
 * secret that is only line breaks matches nothing.
 */

const env = (vars: Partial<Env>) => vars as Env;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const ENDINGS = ["\n", "\r\n"];

function admin() {
  const a = new Hono<ApiEnv>();
  a.post("/write", requireAdmin, (c) => c.json({ ok: true }));
  a.delete("/erase", requireAdminStrict, (c) => c.json({ ok: true }));
  a.use("/snap", hideRemotes);
  a.get("/snap", (c) => c.json({ remote: "https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/ft-trunk/x--trunk.git" }));
  return a;
}

describe("bearerMatches", () => {
  it("drops CR and LF at the ends of the configured secret only", async () => {
    expect(configuredToken("s3cret\n")).toBe("s3cret");
    expect(configuredToken("s3cret\r\n")).toBe("s3cret");
    expect(configuredToken("\r\ns3cret\n\n")).toBe("s3cret");
    expect(configuredToken("s3c ret\t")).toBe("s3c ret\t");
    for (const end of ENDINGS) {
      expect(await bearerMatches("s3cret", `s3cret${end}`)).toBe(true);
      // The presented side is compared as sent.
      expect(await bearerMatches(`s3cret${end}`, "s3cret")).toBe(false);
      expect(await bearerMatches(`s3cret${end}`, `s3cret${end}`)).toBe(false);
      expect(await bearerMatches("s3cre", `s3cret${end}`)).toBe(false);
    }
    // A line break inside the secret is kept: nothing a header carries matches it.
    expect(await bearerMatches("s3cret", "s3c\nret")).toBe(false);
  });

  it("matches nothing when the configured secret is empty or only line breaks", async () => {
    for (const configured of ["", "\n", "\r\n", "\n\n"]) expect(await bearerMatches("", configured)).toBe(false);
    // The plain compare is unchanged: two empty strings are equal there, which is why bearer checks never call it alone.
    expect(await tokensEqual("", "")).toBe(true);
  });
});

describe("FT_ADMIN_TOKEN with a trailing line break", () => {
  it("lets the admin token through writes, destructive routes and the operator's reads, and nothing else", async () => {
    for (const end of ENDINGS) {
      const configured = env({ FT_ADMIN_TOKEN: `s3cret${end}` });
      expect((await admin().request("/write", { method: "POST", headers: bearer("s3cret") }, configured)).status).toBe(200);
      expect((await admin().request("/erase", { method: "DELETE", headers: bearer("s3cret") }, configured)).status).toBe(200);
      expect((await admin().request("/write", { method: "POST", headers: bearer("wrong") }, configured)).status).toBe(401);
      expect((await admin().request("/write", { method: "POST" }, configured)).status).toBe(401);
      // isAdminRequest: the operator sees Artifacts remotes as they are, the public without the account id.
      expect(await (await admin().request("/snap", { headers: bearer("s3cret") }, configured)).json()).toEqual({ remote: expect.stringContaining(".artifacts.cloudflare.net") });
      expect(await (await admin().request("/snap", { headers: bearer("wrong") }, configured)).json()).toEqual({ remote: "artifacts://ft-trunk/x--trunk.git" });
    }
  });

  it("is checked the same way on the vaccination routes", async () => {
    for (const end of ENDINGS) {
      const configured = env({ FT_ADMIN_TOKEN: `s3cret${end}` });
      // Past the token check, an id that is not a colony id answers 404 before any colony is reached.
      const past = await decideApi.request("/colonies/Not_A_Colony/vaccinate", { method: "POST", headers: bearer("s3cret") }, configured);
      expect(past.status).toBe(404);
      expect((await decideApi.request("/colonies/Not_A_Colony/vaccinate", { method: "POST", headers: bearer("wrong") }, configured)).status).toBe(401);
    }
  });

  it("fails closed when the secret is only a line break", async () => {
    for (const end of ENDINGS) {
      const configured = env({ FT_ADMIN_TOKEN: end, FT_OPEN_WRITES: "1" });
      expect((await admin().request("/write", { method: "POST", headers: bearer("anything") }, configured)).status).toBe(401);
      expect((await admin().request("/write", { method: "POST" }, configured)).status).toBe(401);
      expect((await decideApi.request("/colonies/Not_A_Colony/vaccinate", { method: "POST", headers: bearer("anything") }, configured)).status).toBe(401);
    }
  });
});

describe("FT_MCP_TOKEN with a trailing line break", () => {
  const req = (headers: Record<string, string> = {}) => new Request("https://ft.test/mcp", { method: "POST", headers });

  it("lets the MCP token through, and refuses a wrong or missing one", async () => {
    for (const end of ENDINGS) {
      const configured = env({ FT_MCP_TOKEN: `mcp-s3cret${end}` });
      expect(await mcpRefusal(req({ authorization: "Bearer mcp-s3cret" }), configured)).toBeNull();
      expect((await mcpRefusal(req({ authorization: "Bearer mcp-s3cre" }), configured))?.status).toBe(401);
      expect((await mcpRefusal(req(), configured))?.status).toBe(401);
    }
  });

  it("fails closed when the secret is only a line break, whatever FT_OPEN_WRITES says", async () => {
    for (const end of ENDINGS) {
      expect((await mcpRefusal(req({ authorization: "Bearer anything" }), env({ FT_MCP_TOKEN: end, FT_OPEN_WRITES: "1" })))?.status).toBe(401);
    }
  });
});
