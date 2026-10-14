import { describe, expect, it } from "vitest";
import { ABOUT_REQUEST, buildRow } from "../src/about.ts";
import { colors } from "../src/format.ts";
import { main, type Io } from "../src/run.ts";

/** `ft status` ends with the build the server runs, from GET /api/about. */

const c = colors(false);
const NOW = Date.parse("2026-10-14T20:02:11Z");
const ABOUT = { service: "firetrident", commit: "f9c7aad", versionId: "3f2a1b9c-0d4e-4f6a-9b8c-7d6e5f4a3b2c", versionTag: "f9c7aad", deployedAt: "2026-10-14T18:02:11.123Z", flags: ["FT_INLINE"] };

describe("the build row", () => {
  it("names the commit, the server and when it was deployed", () => {
    expect(buildRow(ABOUT, "https://firetrident.com", c, NOW)).toBe("build      f9c7aad · firetrident.com · deployed 2h ago");
  });

  it("names the Worker version when the server names no commit, and leaves out what it does not know", () => {
    expect(buildRow({ ...ABOUT, commit: null }, "http://127.0.0.1:8787", c, NOW)).toBe("build      version 3f2a1b9c · 127.0.0.1:8787 · deployed 2h ago");
    expect(buildRow({ commit: "abc1234" }, "https://ft.test", c, NOW)).toBe("build      abc1234 · ft.test");
  });

  it("is nothing when the server says neither, or says something odd", () => {
    expect(buildRow(undefined, "https://ft.test", c, NOW)).toBeNull();
    expect(buildRow({}, "https://ft.test", c, NOW)).toBeNull();
    expect(buildRow({ commit: "f9c7aad\u001b[2J", versionId: "a b" }, "https://ft.test", c, NOW)).toBeNull();
    expect(buildRow("f9c7aad" as never, "https://ft.test", c, NOW)).toBeNull();
  });
});

/** An Io whose fetch answers from `routes` by path and records each path asked for (no network). */
function io(routes: Record<string, unknown>): Io & { out: string[]; paths: string[] } {
  const out: string[] = [];
  const paths: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    const body = routes[path];
    return body === undefined ? new Response(JSON.stringify({ error: `no route for GET ${path}` }), { status: 404 }) : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return {
    env: { FT_URL: "https://firetrident.com", FT_USER: "tester", NO_COLOR: "1" },
    stdout: (l) => void out.push(l),
    stderr: () => {},
    isTTY: false,
    fetch,
    readFile: async () => "",
    sleep: async () => {},
    now: () => NOW,
    WebSocket: globalThis.WebSocket,
    onInterrupt: () => {},
    out,
    paths,
  };
}

const snapshot = { colony: { id: "web", name: "web", trunk: { namespace: "n", name: "web--trunk", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 } };

describe("ft status", () => {
  it("ends with the build the server runs, read after the summary", async () => {
    const t = io({ "/api/colonies/web": snapshot, "/api/about": ABOUT });
    expect(await main(["status", "web"], t)).toBe(0);
    expect(t.out.at(-1)).toBe("build      f9c7aad · firetrident.com · deployed 2h ago");
    expect(t.paths[0]).toBe("/api/colonies/web");
    expect(t.paths.at(-1)).toBe(ABOUT_REQUEST.path);
  });

  it("shows no build row for a server that predates GET /api/about, and none in --json", async () => {
    const old = io({ "/api/colonies/web": snapshot });
    expect(await main(["status", "web"], old)).toBe(0);
    expect(old.out.join("\n")).not.toContain("build ");
    const json = io({ "/api/colonies/web": snapshot, "/api/about": ABOUT });
    expect(await main(["status", "web", "--json"], json)).toBe(0);
    expect(JSON.parse(json.out.join("\n"))).toEqual(snapshot);
    expect(json.paths).toEqual(["/api/colonies/web"]);
  });
});
