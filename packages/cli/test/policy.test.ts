import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { colors, formatPolicy, policyRows } from "../src/format.ts";
import { main, type Io } from "../src/run.ts";

const c = colors(false);

function command(argv: string[]) {
  const p = parseCommand(argv);
  if (!p.ok) throw new Error(p.error);
  return p.command;
}

describe("ft policy: parsing and planning", () => {
  it("reads globs (normalized, each once) and the comment-only switch", () => {
    expect(command(["policy", "web"])).toEqual({ name: "policy", colony: "web", protect: [], unprotect: [] });
    expect(command(["policy", "web", "--protect", "./src/auth/", "--protect", "src/auth", "--unprotect", "db/**", "--comment-proof", "off"])).toEqual({
      name: "policy",
      colony: "web",
      protect: ["src/auth"],
      unprotect: ["db/**"],
      commentProof: false,
    });
  });

  it("refuses unclear requests before calling the server", () => {
    const error = (argv: string[]) => {
      const p = parseCommand(argv);
      return p.ok ? "" : p.error;
    };
    expect(error(["policy", "web", "--comment-proof", "maybe"])).toBe('--comment-proof must be on or off, got "maybe"');
    expect(error(["policy", "web", "--protect", " "])).toBe('--protect needs a glob, such as "src/auth/**"');
    expect(error(["policy", "web", "--protect", "a/**", "--unprotect", "./a/**"])).toBe('"a/**" is given to both --protect and --unprotect');
    expect(error(["policy"])).toContain("missing <colony>");
    expect(error(["policy", "web", "extra"])).toContain('unexpected argument "extra"');
  });

  it("plans one call to show or to switch the proof, and none it can plan alone for globs", () => {
    expect(planRequest(command(["policy", "web"]), "me")).toEqual({ method: "GET", path: "/api/colonies/web/decide/policy" });
    expect(planRequest(command(["policy", "web", "--comment-proof", "on"]), "me")).toEqual({ method: "POST", path: "/api/colonies/web/decide/policy", body: { commentProof: true } });
    expect(planRequest(command(["policy", "web", "--protect", "src/auth/**"]), "me")).toBeNull();
  });

  it("prints the policy, and the rows ft status adds", () => {
    const p = { enabled: true, deterministic: true, commentProof: true, protectedPaths: ["src/auth/**", "db/migrations"] };
    expect(formatPolicy("web", p, c)).toBe(
      [
        "web decide policy",
        "review     on",
        "proofs     import rewrites, rule replacements, comment-only changes",
        "protected  src/auth/**, db/migrations (a person decides every change to them)",
      ].join("\n"),
    );
    expect(formatPolicy("web", { ...p, commentProof: false, protectedPaths: [] }, c)).toContain("proofs     import rewrites, rule replacements, comment-only proof off\nprotected  none");
    expect(formatPolicy("web", { enabled: false, deterministic: false }, c)).toContain("review     off: changes go to their lanes without review\nproofs     off: every change needs a model or a person");
    expect(policyRows(p, c)).toEqual(["protected  src/auth/**, db/migrations (a person decides every change to them)"]);
    expect(policyRows({ commentProof: false, protectedPaths: [] }, c)).toEqual(["proofs     comment-only proof off"]);
    expect(policyRows(undefined, c)).toEqual([]);
  });
});

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** An Io whose fetch answers from `route` and records every call (no network). */
function io(route: (call: Call) => { status: number; body: unknown }): Io & { out: string[]; err: string[]; calls: Call[] } {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", path: new URL(String(input)).pathname };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body);
    calls.push(call);
    const answer = route(call);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return {
    env: { FT_URL: "https://ft.test", FT_TOKEN: "tok", FT_USER: "tester", NO_COLOR: "1" },
    stdout: (l) => void out.push(l),
    stderr: (l) => void err.push(l),
    isTTY: false,
    fetch,
    readFile: async () => "",
    sleep: async () => {},
    now: () => 0,
    WebSocket: globalThis.WebSocket,
    onInterrupt: () => {},
    out,
    err,
    calls,
  };
}

/** A server keeping one colony's decide policy, as the policy route does (a POST sets the fields it names). */
function server(start: Record<string, unknown> = { enabled: true, deterministic: true, commentProof: true, protectedPaths: ["src/auth/**"] }) {
  let policy = { ...start };
  return (call: Call): { status: number; body: unknown } => {
    const key = `${call.method} ${call.path}`;
    if (key === "GET /api/colonies/web/decide/policy") return { status: 200, body: policy };
    if (key === "POST /api/colonies/web/decide/policy") {
      policy = { ...policy, ...(call.body as object) };
      return { status: 200, body: policy };
    }
    if (key === "GET /api/colonies/web") return { status: 200, body: { colony: { id: "web", name: "web", trunk: { namespace: "n", name: "web", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 } } };
    return { status: 404, body: { error: `no route for ${key}` } };
  };
}

describe("ft policy against a server", () => {
  it("shows the policy", async () => {
    const t = io(server());
    expect(await main(["policy", "web"], t)).toBe(0);
    expect(t.calls).toEqual([{ method: "GET", path: "/api/colonies/web/decide/policy" }]);
    expect(t.out.join("\n")).toContain("protected  src/auth/** (a person decides every change to them)");
  });

  it("adds and removes protected paths by reading the list and writing it back whole", async () => {
    const route = server();
    const t = io(route);
    expect(await main(["policy", "web", "--protect", "db/migrations/", "--protect", "src/auth/**"], t)).toBe(0);
    expect(t.calls).toEqual([
      { method: "GET", path: "/api/colonies/web/decide/policy" },
      { method: "POST", path: "/api/colonies/web/decide/policy", body: { protectedPaths: ["src/auth/**", "db/migrations"] } },
    ]);
    expect(t.out.join("\n")).toContain("protected  src/auth/**, db/migrations");

    const u = io(route);
    expect(await main(["policy", "web", "--unprotect", "src/auth/**", "--unprotect", "lib/**", "--comment-proof", "off"], u)).toBe(0);
    expect(u.calls[1]).toEqual({ method: "POST", path: "/api/colonies/web/decide/policy", body: { protectedPaths: ["db/migrations"], commentProof: false } });
    expect(u.out.join("\n")).toContain("comment-only proof off");
    expect(u.out.at(-1)).toBe("  lib/** was not protected");
  });

  it("prints the calls on a dry run without sending them", async () => {
    const t = io(server());
    expect(await main(["policy", "web", "--protect", "db/**", "--dry-run"], t)).toBe(0);
    expect(t.calls).toEqual([]);
    expect(JSON.parse(t.out.join("\n"))).toEqual([
      { method: "GET", url: "https://ft.test/api/colonies/web/decide/policy", authorization: "Bearer ***" },
      { method: "POST", url: "https://ft.test/api/colonies/web/decide/policy", authorization: "Bearer ***", body: { protectedPaths: "<the current list, plus db/**>" } },
    ]);
  });

  it("fails loudly against a server that predates protected paths or the comment-only proof", async () => {
    const old = { enabled: true, deterministic: true };
    const t = io(server(old));
    expect(await main(["policy", "web", "--protect", "db/**"], t)).toBe(1);
    expect(t.err).toEqual(["ft: the server does not keep protected paths: it predates them"]);
    expect(t.calls).toHaveLength(1);
    const oldPost = (call: Call) => (call.method === "POST" ? { status: 200, body: old } : server(old)(call));
    const u = io(oldPost);
    expect(await main(["policy", "web", "--comment-proof", "off"], u)).toBe(1);
    expect(u.err).toEqual(["ft: the server did not change the comment-only proof: it predates it"]);
  });

  it("adds the protected paths to ft status, and nothing when the server has none to show", async () => {
    const t = io(server());
    expect(await main(["status", "web"], t)).toBe(0);
    expect(t.calls.map((k) => k.path)).toEqual(["/api/colonies/web", "/api/colonies/web/decide/policy", "/api/about"]);
    expect(t.out.at(-1)).toBe("protected  src/auth/** (a person decides every change to them)");
    const bare = io((call) => (call.path.endsWith("/decide/policy") ? { status: 404, body: { error: "no route" } } : server()(call)));
    expect(await main(["status", "web"], bare)).toBe(0);
    expect(bare.out.join("\n")).not.toContain("protected");
  });
});
