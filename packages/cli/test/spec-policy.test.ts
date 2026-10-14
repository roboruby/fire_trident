import { describe, expect, it } from "vitest";
import { helpText } from "../src/args.ts";
import { main } from "../src/run.ts";
import type { Io } from "../src/run.ts";
import { extractSpec, planNew, validateSpec } from "../src/spec.ts";
import { DEFAULT_POLICY, globProblem, mergePolicy, policyProblems } from "../../worker/src/decide/policy.ts";

const minimal = {
  firetrident: "spec/v1",
  name: "tiny",
  goal: { title: "Tiny", why: "Because" },
  rules: [{ kind: "forbid-pattern", description: "No eval", spec: { pattern: "\\beval\\(", hint: "Do not eval" } }],
  intents: [
    { title: "Admin route", why: "It is needed", footprint: ["src/admin.ts"] },
    { title: "Entry", why: "It is needed", footprint: ["src/index.ts"], uses: ["src/admin.ts"] },
  ],
};

const governed = { ...minimal, policy: { protectedPaths: ["./src/auth/", "src/auth", "db/migrations/**"], commentProof: false } };

/** A spec whose policy protects these globs. */
const withGlobs = (protectedPaths: unknown) => ({ ...minimal, policy: { protectedPaths } });

/** The error validateSpec throws for this spec, or null when it is valid. */
function problem(raw: unknown): string | null {
  try {
    validateSpec(raw);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** A Markdown spec around this machine-readable block. */
function markdown(block: object): string {
  return ["# Tiny", "", "## Contracts", "The admin route lives in src/admin.ts.", "", "## Machine", "```json firetrident", JSON.stringify(block, null, 2), "```", ""].join("\n");
}

describe("a spec's policy", () => {
  it("keeps globs as the server keeps them (normalized, each once) and the comment-only switch", () => {
    expect(validateSpec(governed).policy).toEqual({ protectedPaths: ["src/auth", "db/migrations/**"], commentProof: false });
    expect(extractSpec(markdown(governed)).policy).toEqual({ protectedPaths: ["src/auth", "db/migrations/**"], commentProof: false });
  });

  it("takes either field alone, and a block that sets nothing is no policy", () => {
    expect(validateSpec({ ...minimal, policy: { commentProof: true } }).policy).toEqual({ commentProof: true });
    expect(validateSpec({ ...minimal, policy: { protectedPaths: [] } }).policy).toEqual({ protectedPaths: [] });
    expect(validateSpec({ ...minimal, policy: {} })).not.toHaveProperty("policy");
    expect(validateSpec(minimal)).not.toHaveProperty("policy");
  });

  it("names the field and the glob that is wrong", () => {
    const object = "spec: policy must be an object with protectedPaths and/or commentProof";
    expect(problem({ ...minimal, policy: [] })).toBe(object);
    expect(problem({ ...minimal, policy: null })).toBe(object);
    expect(problem({ ...minimal, policy: "src/**" })).toBe(object);
    // A misspelled or unsupported field is refused, not dropped: it would leave paths unprotected.
    expect(problem({ ...minimal, policy: { protectedPath: ["src/**"] } })).toBe("spec: policy.protectedPath is not a policy field (protectedPaths, commentProof)");
    expect(problem({ ...minimal, policy: { enabled: false } })).toBe("spec: policy.enabled is not a policy field (protectedPaths, commentProof)");
    expect(problem(withGlobs("src/**"))).toBe("spec: policy.protectedPaths must be an array of globs");
    expect(problem(withGlobs(["src/**", 3]))).toBe("spec: policy.protectedPaths[1] must be a string");
    expect(problem(withGlobs(["src/**", " ./ "]))).toBe("spec: policy.protectedPaths[1]: a protected path cannot be empty");
    expect(problem(withGlobs(["a".repeat(301)]))).toBe("spec: policy.protectedPaths[0]: a protected path has at most 300 characters");
    expect(problem(withGlobs(["src/\nauth"]))).toBe("spec: policy.protectedPaths[0]: a protected path is one line of text");
    expect(problem(withGlobs(["{a,b}".repeat(9)]))).toBe("spec: policy.protectedPaths[0]: a protected path with this many {a,b} alternatives would match nothing");
    expect(problem(withGlobs(Array.from({ length: 51 }, (_, i) => `d${i}`)))).toBe("spec: policy.protectedPaths has 51 globs; a colony keeps at most 50");
    expect(problem(withGlobs(Array.from({ length: 50 }, (_, i) => `d${i}`)))).toBeNull();
    expect(problem({ ...minimal, policy: { commentProof: "off" } })).toBe("spec: policy.commentProof must be true or false");
    expect(() => extractSpec(markdown(withGlobs(["ok/**", ""])))).toThrow(/^spec: policy\.protectedPaths\[1\]: a protected path cannot be empty$/);
  });
});

/** Deterministic pseudo-random numbers in [0, 1). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 2 ** 32;
  };
}

describe("the policy check matches the server's", () => {
  /** Assert the spec check refuses `glob` exactly when the policy route would, for the same reason. */
  const same = (glob: string) => {
    const server = globProblem(glob);
    expect(policyProblems({ protectedPaths: [glob] }), glob).toEqual(server === null ? [] : [`protectedPaths.0: ${server}`]);
    expect(problem(withGlobs([glob])), glob).toBe(server === null ? null : `spec: policy.protectedPaths[0]: ${server}`);
    // What the spec sends is exactly what the server keeps, so ft new can check the answer.
    if (server === null) expect(validateSpec(withGlobs([glob])).policy?.protectedPaths, glob).toEqual(mergePolicy(DEFAULT_POLICY, { protectedPaths: [glob] }).protectedPaths);
    return server === null;
  };

  it("on globs at the edges of what the server accepts", () => {
    const accepted = [
      "src/auth/**",
      "{src,lib}/{auth,admin}/**/*.{ts,js}",
      "{x}",
      "./src/auth/",
      "**",
      "a//b",
      "a{/,b}",
      "x".repeat(300),
      "{a,b}".repeat(8),
      "{a,b,c,d}".repeat(4),
      "{/**/a,b}",
      "{/a,*/a}",
    ];
    const refused = ["", " ./ ", "a".repeat(301), "src/\nauth", "a\u007f", "{a,b}".repeat(9), "{a,b,c,d}".repeat(4) + "{a,b}", "{,src}/auth", "{/a,b}", "{./a,b}"];
    for (const g of accepted) expect(same(g), g).toBe(true);
    for (const g of refused) expect(same(g), g).toBe(false);
  });

  it("on 3,000 random globs", () => {
    const next = random(20261014);
    const tokens = ["a", "b", "/", ".", "./", "*", "**", "?", "{", "}", ",", " ", "\t", "\n", "{a,b}", "{a,b,c,d}", "{,/}", "{/,./}", "{**,a}/"];
    let accepted = 0;
    let refused = 0;
    for (let n = 0; n < 3000; n++) {
      let glob = "";
      const length = 1 + Math.floor(next() * 14);
      for (let k = 0; k < length; k++) glob += tokens[Math.floor(next() * tokens.length)];
      if (same(glob)) accepted++;
      else refused++;
    }
    // Both outcomes are exercised, so agreement is not vacuous.
    expect(accepted).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(300);
  });

  it("on the comment-only switch and the number of globs", () => {
    for (const commentProof of [true, false, "on", 0, null]) {
      expect(problem({ ...minimal, policy: { commentProof } }) === null, String(commentProof)).toBe(policyProblems({ commentProof }).length === 0);
    }
    for (const count of [0, 1, 50, 51, 500]) {
      const globs = Array.from({ length: count }, (_, i) => `d${i % 7}/**`);
      expect(problem(withGlobs(globs)) === null, String(count)).toBe(policyProblems({ protectedPaths: globs }).length === 0);
    }
  });
});

describe("planning ft new with a policy", () => {
  it("sets the policy after creating the colony and before the rules and intents", () => {
    const plan = planNew(validateSpec(governed), "c", "me");
    expect(Object.keys(plan)).toEqual(["create", "policy", "rules", "intents"]);
    expect(plan.policy).toEqual({ method: "POST", path: "/api/colonies/c/decide/policy", body: { protectedPaths: ["src/auth", "db/migrations/**"], commentProof: false } });
    expect(plan.rules.map((r) => r.path)).toEqual(["/api/colonies/c/rules"]);
    expect(plan.intents.map((r) => (r.body as { title: string }).title)).toEqual(["Admin route", "Entry"]);
  });

  it("plans a spec without a policy exactly as before, and a policy changes nothing else", () => {
    const plain = planNew(validateSpec(minimal), "c", "me");
    expect(Object.keys(plain)).toEqual(["create", "rules", "intents"]);
    expect(plain).not.toHaveProperty("policy");
    expect(planNew(validateSpec({ ...minimal, policy: {} }), "c", "me")).toStrictEqual(plain);
    const { policy, ...rest } = planNew(validateSpec(governed), "c", "me");
    expect(policy).toBeDefined();
    expect(rest).toStrictEqual(plain);
  });
});

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

type Route = (call: Call) => { status: number; body: unknown };

/** An Io that reads `spec` for any file and answers HTTP from `route`, recording every call (no network). */
function io(spec: string, route: Route): Io & { out: string[]; err: string[]; calls: Call[] } {
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
    readFile: async () => spec,
    sleep: async () => {},
    now: () => 0,
    WebSocket: globalThis.WebSocket,
    onInterrupt: () => {},
    out,
    err,
    calls,
  };
}

/** A server that creates colony "tiny" and answers the policy route as the worker does, unless `policy` answers it. */
function server(policy?: Route): Route {
  let n = 0;
  return (call) => {
    const body = (call.body ?? {}) as Record<string, unknown>;
    if (call.path === "/api/colonies") return { status: 201, body: { id: "tiny", name: body.name } };
    if (call.path === "/api/colonies/tiny/decide/policy") {
      if (policy) return policy(call);
      const problems = policyProblems(body);
      return problems.length > 0 ? { status: 400, body: { error: `invalid request: ${problems.join("; ")}` } } : { status: 200, body: mergePolicy(DEFAULT_POLICY, body) };
    }
    if (call.path === "/api/colonies/tiny/rules") return { status: 201, body: { rule: { id: `rul_${++n}` }, violations: 0, intents: 0 } };
    if (call.path === "/api/colonies/tiny/intents") return { status: 201, body: { id: `int_${++n}`, title: body.title } };
    return { status: 404, body: { error: `no route for ${call.method} ${call.path}` } };
  };
}

const where = (calls: Call[]) => calls.map((k) => `${k.method} ${k.path}`);

describe("ft new with a policy", () => {
  it("prints the policy call between the colony and the rules on a dry run", async () => {
    const t = io(markdown(governed), server());
    expect(await main(["new", "--spec", "spec.md", "--dry-run"], t)).toBe(0);
    expect(t.calls).toEqual([]);
    const shown = JSON.parse(t.out.join("\n")) as Array<{ method: string; url: string; body?: unknown }>;
    expect(shown.map((r) => r.url)).toEqual([
      "https://ft.test/api/colonies",
      "https://ft.test/api/colonies/<colony>/decide/policy",
      "https://ft.test/api/colonies/<colony>/rules",
      "https://ft.test/api/colonies/<colony>/intents",
      "https://ft.test/api/colonies/<colony>/intents",
    ]);
    expect(shown[1]).toEqual({
      method: "POST",
      url: "https://ft.test/api/colonies/<colony>/decide/policy",
      authorization: "Bearer ***",
      body: { protectedPaths: ["src/auth", "db/migrations/**"], commentProof: false },
    });

    const plain = io(markdown(minimal), server());
    expect(await main(["new", "--spec", "spec.md", "--dry-run"], plain)).toBe(0);
    expect(plain.out.join("\n")).not.toContain("decide/policy");
  });

  it("sets the policy before declaring any rule or intent, and says so", async () => {
    const t = io(markdown(governed), server());
    expect(await main(["new", "--spec", "spec.md"], t)).toBe(0);
    expect(where(t.calls)).toEqual([
      "POST /api/colonies",
      "POST /api/colonies/tiny/decide/policy",
      "POST /api/colonies/tiny/rules",
      "POST /api/colonies/tiny/intents",
      "POST /api/colonies/tiny/intents",
    ]);
    expect(t.calls[1]?.body).toEqual({ protectedPaths: ["src/auth", "db/migrations/**"], commentProof: false });
    expect(t.out.slice(0, 3)).toEqual([
      "✓ Colony tiny tiny created from spec.md",
      "  ✓ policy protects src/auth, db/migrations/** (a person decides every change to them) · comment-only proof off",
      "  ✓ rule rul_1 No eval",
    ]);

    const proofOnly = io(markdown({ ...minimal, policy: { commentProof: true } }), server());
    expect(await main(["new", "--spec", "spec.md"], proofOnly)).toBe(0);
    expect(proofOnly.out[1]).toBe("  ✓ policy comment-only proof on");
  });

  it("adds the policy the server keeps to --json, and nothing for a spec without one", async () => {
    const t = io(markdown(governed), server());
    expect(await main(["new", "--spec", "spec.md", "--json"], t)).toBe(0);
    const res = JSON.parse(t.out.join("\n")) as Record<string, { protectedPaths?: string[]; commentProof?: boolean }>;
    expect(Object.keys(res)).toEqual(["colony", "policy", "rules", "intents"]);
    expect(res.policy).toMatchObject({ protectedPaths: ["src/auth", "db/migrations/**"], commentProof: false });

    const plain = io(markdown(minimal), server());
    expect(await main(["new", "--spec", "spec.md", "--json"], plain)).toBe(0);
    expect(Object.keys(JSON.parse(plain.out.join("\n")) as object)).toEqual(["colony", "rules", "intents"]);
    expect(where(plain.calls)).not.toContain("POST /api/colonies/tiny/decide/policy");
  });

  it("stops before any rule or intent when the server does not keep the policy", async () => {
    const left = "Colony tiny was created; its rules and intents were not declared (ft delete tiny --yes removes it)";
    const old = io(markdown(governed), server(() => ({ status: 200, body: { enabled: true, deterministic: true } })));
    expect(await main(["new", "--spec", "spec.md"], old)).toBe(1);
    expect(old.err).toEqual([`ft: the server does not keep protected paths: it predates them. ${left}`]);
    expect(where(old.calls)).toEqual(["POST /api/colonies", "POST /api/colonies/tiny/decide/policy"]);

    const noProof = io(markdown(governed), server(() => ({ status: 200, body: { protectedPaths: ["src/auth", "db/migrations/**"] } })));
    expect(await main(["new", "--spec", "spec.md"], noProof)).toBe(1);
    expect(noProof.err).toEqual([`ft: the server did not set the comment-only proof: it predates it. ${left}`]);

    const partial = io(markdown(governed), server(() => ({ status: 200, body: { protectedPaths: ["src/auth"], commentProof: false } })));
    expect(await main(["new", "--spec", "spec.md"], partial)).toBe(1);
    expect(partial.err).toEqual([`ft: the server did not keep the protected paths db/migrations/**. ${left}`]);

    const refused = io(markdown(governed), server(() => ({ status: 400, body: { error: "invalid request: protectedPaths.0: a protected path cannot be empty" } })));
    expect(await main(["new", "--spec", "spec.md"], refused)).toBe(1);
    expect(refused.err).toHaveLength(1);
    expect(refused.err[0]).toMatch(/^ft: POST \/api\/colonies\/tiny\/decide\/policy failed: 400 /);
    expect(refused.err[0]?.endsWith(`: invalid request: protectedPaths.0: a protected path cannot be empty. ${left}`)).toBe(true);
    expect(where(refused.calls)).toEqual(["POST /api/colonies", "POST /api/colonies/tiny/decide/policy"]);
  });

  it("refuses an invalid policy before calling the server", async () => {
    const t = io(markdown({ ...minimal, policy: { protectedPaths: ["src/**"], commentProof: "off" } }), server());
    expect(await main(["new", "--spec", "spec.md"], t)).toBe(1);
    expect(t.err).toEqual(["ft: spec: policy.commentProof must be true or false"]);
    expect(t.calls).toEqual([]);
  });

  it("documents the policy in ft help new", () => {
    const help = helpText("new");
    expect(help).toContain("sets the spec's policy if it has one, adds each\nrule, then declares each intent, so no agent has work before the policy holds.");
    expect(help).toMatch(/policy\.protectedPaths\n {21}paths only a person may change/);
    expect(help).toMatch(/policy\.commentProof\n {21}false: changes that only edit comments/);
  });
});
