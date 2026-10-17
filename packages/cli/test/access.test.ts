import { describe, expect, it } from "vitest";
import { ApiError, accessHeaders, send } from "../src/api.ts";

describe("Cloudflare Access service-token headers", () => {
  it("are absent when neither variable is set", () => {
    expect(accessHeaders({})).toBeNull();
    expect(accessHeaders({ CF_ACCESS_CLIENT_ID: " ", CF_ACCESS_CLIENT_SECRET: "" })).toBeNull();
  });

  it("are both headers when both variables are set", () => {
    expect(accessHeaders({ CF_ACCESS_CLIENT_ID: "abc.access", CF_ACCESS_CLIENT_SECRET: "s3cret" })).toEqual({
      "CF-Access-Client-Id": "abc.access",
      "CF-Access-Client-Secret": "s3cret",
    });
  });

  it("refuse one variable without the other, naming both", () => {
    expect(() => accessHeaders({ CF_ACCESS_CLIENT_ID: "abc.access" })).toThrow(ApiError);
    expect(() => accessHeaders({ CF_ACCESS_CLIENT_SECRET: "s3cret" })).toThrow(/CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET/);
  });

  it("travel with every request, beside the token", async () => {
    let seen: Headers | null = null;
    const fake = (async (_url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await send({ baseUrl: "https://staging.example", token: "t0k", headers: { "CF-Access-Client-Id": "abc.access", "CF-Access-Client-Secret": "s3cret" }, fetch: fake }, { method: "GET", path: "/api/about" });
    expect(seen!.get("cf-access-client-id")).toBe("abc.access");
    expect(seen!.get("cf-access-client-secret")).toBe("s3cret");
    expect(seen!.get("authorization")).toBe("Bearer t0k");
    expect(seen!.get("accept")).toBe("application/json");
  });
});
