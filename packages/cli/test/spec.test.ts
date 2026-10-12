import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/run.ts";
import type { Io } from "../src/run.ts";
import { WHY_MAX, dependencyPlan, extractSpec, intentWhy, planNew, specContext, specSections, validateSpec, whySummary } from "../src/spec.ts";
import { parseIntentSpec } from "../../worker/src/agents/create.ts";

const demoSpec = readFileSync(fileURLToPath(new URL("../../../demo/new-project-spec.md", import.meta.url)), "utf8");

const minimal = {
  firetrident: "spec/v1",
  name: "tiny",
  goal: { title: "Tiny", why: "Because" },
  rules: [{ kind: "forbid-pattern", description: "No eval", spec: { pattern: "\\beval\\(", hint: "Do not eval" } }],
  intents: [{ title: "Write a.ts", why: "It is needed", footprint: ["src/a.ts"] }],
};

describe("the demo spec", () => {
  const spec = extractSpec(demoSpec);

  it("parses and validates", () => {
    expect(spec.name).toBe("shortlinks");
    expect(spec.regionDepth).toBe(2);
    expect(spec.rules).toHaveLength(5);
    expect(spec.intents).toHaveLength(13);
  });

  it("gives every intent a footprint, and no two intents the same file", () => {
    const all = spec.intents.flatMap((i) => i.footprint);
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps rule regexes honest on sample imports and lines", () => {
    const [relTs, noNode, routesNoStore] = spec.rules.map((r) => new RegExp(String(r.spec.module ?? r.spec.pattern)));
    expect(relTs?.test("../types")).toBe(true);
    expect(relTs?.test("./http.ts")).toBe(false);
    expect(relTs?.test("node:test")).toBe(false);
    expect(noNode?.test("node:crypto")).toBe(true);
    expect(noNode?.test("crypto")).toBe(true);
    expect(noNode?.test("./crypto.ts")).toBe(false);
    expect(routesNoStore?.test("../store/kv.ts")).toBe(true);
    expect(routesNoStore?.test("../types.ts")).toBe(false);
    const responses = new RegExp(String(spec.rules[3]?.spec.pattern));
    expect(responses.test("return new Response(JSON.stringify(x))")).toBe(true);
    expect(responses.test("return new Response(null, { status: 204 })")).toBe(false);
    const injected = new RegExp(String(spec.rules[4]?.spec.pattern));
    expect(injected.test("const n = Math.random();")).toBe(true);
    expect(injected.test("createdAt: deps.now(),")).toBe(false);
  });

  it("plans a colony, its rules, then its intents", () => {
    const plan = planNew(spec, "col_1", "matt");
    expect(plan.create).toEqual({ method: "POST", path: "/api/colonies", body: { name: "shortlinks", regionDepth: 2 } });
    expect(plan.rules).toHaveLength(5);
    expect(plan.rules[0]).toMatchObject({ method: "POST", path: "/api/colonies/col_1/rules", body: { colonyId: "col_1", kind: "forbid-import", approvedBy: "matt" } });
    expect(plan.intents).toHaveLength(13);
    expect(plan.intents[0]).toMatchObject({
      method: "POST",
      path: "/api/colonies/col_1/intents",
      body: { colonyId: "col_1", source: "human", priority: 5, createdBy: "matt", footprint: ["package.json", "tsconfig.json", "wrangler.jsonc", "README.md", ".gitignore"] },
    });
    expect((plan.intents[0]?.body as { why: string }).why).toContain('\n\nScope: this intent writes package.json, tsconfig.json, wrangler.jsonc, README.md, .gitignore. It is one of 13 intents that build "shortlinks:');
  });
});

describe("extractSpec", () => {
  it("finds the tagged block among other fences", () => {
    const md = ["# x", "```json", "{}", "```", "```json firetrident", JSON.stringify(minimal), "```", ""].join("\n");
    expect(extractSpec(md).name).toBe("tiny");
  });

  it("explains what is wrong", () => {
    expect(() => extractSpec("# nothing here")).toThrow(/no ```json firetrident block/);
    expect(() => extractSpec("```json firetrident\n{oops\n```")).toThrow(/not valid JSON/);
    const twice = `\`\`\`json firetrident\n${JSON.stringify(minimal)}\n\`\`\`\n\`\`\`json firetrident\n${JSON.stringify(minimal)}\n\`\`\``;
    expect(() => extractSpec(twice)).toThrow(/more than one/);
  });
});

describe("validateSpec", () => {
  const variant = (patch: Record<string, unknown>) => ({ ...minimal, ...patch });

  it("accepts a minimal spec and defaults priority to 1", () => {
    const plan = planNew(validateSpec(minimal), "c", "me");
    expect(plan.create.body).toEqual({ name: "tiny" });
    expect(plan.intents[0]?.body).toMatchObject({ priority: 1 });
  });

  it("rejects malformed fields with their location", () => {
    expect(() => validateSpec(variant({ firetrident: "spec/v2" }))).toThrow(/spec\/v1/);
    expect(() => validateSpec(variant({ name: "" }))).toThrow(/name must be a non-empty string/);
    expect(() => validateSpec(variant({ regionDepth: 0 }))).toThrow(/regionDepth/);
    expect(() => validateSpec(variant({ rules: [{ kind: "forbid-magic", description: "d", spec: { hint: "h" } }] }))).toThrow(/rules\[0\]\.kind/);
    expect(() => validateSpec(variant({ rules: [{ kind: "forbid-pattern", description: "d", spec: { pattern: "(", hint: "h" } }] }))).toThrow(/rules\[0\]\.spec\.pattern is not a valid RegExp/);
    expect(() => validateSpec(variant({ rules: [{ kind: "forbid-import", description: "d", spec: { from: [], module: "x", hint: "h" } }] }))).toThrow(/rules\[0\]\.spec\.from/);
    expect(() => validateSpec(variant({ intents: [] }))).toThrow(/intents must be a non-empty array/);
    expect(() => validateSpec(variant({ intents: [{ title: "t", why: "w", footprint: [] }] }))).toThrow(/intents\[0\]\.footprint/);
    expect(() => validateSpec(variant({ intents: [{ title: "t", why: "w", footprint: ["a"], priority: "high" }] }))).toThrow(/intents\[0\]\.priority/);
  });
});

describe("dependency planning", () => {
  const spec = extractSpec(demoSpec);
  const title = (i: number | undefined) => (i === undefined ? undefined : spec.intents[i]?.title);

  it("keeps the demo's order, priorities, and names the latest-wave dependency as parent", () => {
    const plan = dependencyPlan(spec.intents);
    expect(plan.order).toEqual(spec.intents.map((_, i) => i));
    expect(plan.priority).toEqual(spec.intents.map((i) => i.priority));
    const parentOf = (t: string) => title(plan.parent[spec.intents.findIndex((i) => i.title.startsWith(t))]);
    expect(parentOf("Router")).toBe("HTTP helpers: json, error, readJson");
    expect(parentOf("KV store")).toBe("Shared types: Link, Store, KVLike, Env, Deps, Handler");
    expect(parentOf("Route: POST")).toBe("HTTP helpers: json, error, readJson");
    expect(parentOf("Worker entry")).toBe("Route: POST /api/links creates a short link");
    expect(parentOf("Acceptance suite")).toBe("Worker entry: routes, error boundary, store selection");
    expect(parentOf("Scaffold")).toBeUndefined();
  });

  it("orders dependencies first and derives missing priorities from what uses them", () => {
    const intents = [
      { title: "C", why: "w", footprint: ["c.ts"], uses: ["b.ts"] },
      { title: "B", why: "w", footprint: ["b.ts"], uses: ["a.ts"], priority: 3 },
      { title: "A", why: "w", footprint: ["a.ts"] },
    ];
    const plan = dependencyPlan(intents);
    expect(plan.order).toEqual([2, 1, 0]);
    expect(plan.priority).toEqual([1, 3, 4]);
    expect(plan.parent).toEqual([1, 2, undefined]);
    const planned = planNew(validateSpec({ ...minimal, rules: [], intents }), "c", "me");
    expect(planned.intents.map((r) => (r.body as { title: string }).title)).toEqual(["A", "B", "C"]);
    expect(planned.intents.map((r) => r.parentIndex)).toEqual([undefined, 0, 1]);
  });

  it("rejects uses that cannot be satisfied", () => {
    const base = (intents: unknown[]) => () => validateSpec({ ...minimal, intents });
    expect(base([{ title: "A", why: "w", footprint: ["a.ts"], uses: ["nope.ts"] }])).toThrow(/intents\[0\]\.uses names nope\.ts, which no other intent's footprint creates/);
    expect(base([{ title: "A", why: "w", footprint: ["a.ts"], uses: ["./a.ts"] }])).toThrow(/in its own footprint/);
    expect(base([{ title: "A", why: "w", footprint: ["a.ts"], uses: ["b.ts"] }, { title: "B", why: "w", footprint: ["b.ts"], uses: ["a.ts"] }])).toThrow(/cycle: intents\[0\] "A", intents\[1\] "B"/);
    expect(base([{ title: "A", why: "w", footprint: ["a.ts"], priority: 1 }, { title: "B", why: "w", footprint: ["b.ts"], uses: ["a.ts"], priority: 2 }])).toThrow(/"B" has priority 2 but builds on intents\[0\] "A" at priority 1/);
    expect(base([{ title: "A", why: "w", footprint: ["a.ts"], uses: "a.ts" }])).toThrow(/uses must be an array of paths/);
  });
});

describe("spec context", () => {
  const md = [
    "# Title",
    "intro",
    "## Run it",
    "```sh",
    "## not a heading inside code",
    "```",
    "## Contracts",
    "shared rules",
    "### `src/a.ts`",
    "export const a = 1;",
    "### `src/b.ts`",
    "export const b = 2;",
    "## Machine",
    "```json firetrident",
    "{}",
    "```",
  ].join("\n");

  it("splits ## and ### chunks, ignoring headings in code and marking the machine block", () => {
    const s = specSections(md);
    expect(s.map((x) => [x.h2, x.heading, x.level, x.machine])).toEqual([
      ["", "", 2, false],
      ["Run it", "Run it", 2, false],
      ["Contracts", "Contracts", 2, false],
      ["Contracts", "`src/a.ts`", 3, false],
      ["Contracts", "`src/b.ts`", 3, false],
      ["Machine", "Machine", 2, true],
    ]);
    expect(s[1]!.text).toContain("## not a heading inside code");
  });

  it("takes the named sections, or every section but the machine block", () => {
    expect(specContext(md, { context: ["Contracts"] }, { footprint: ["src/a.ts"] }, 10_000)).toBe("## Contracts\nshared rules\n\n### `src/a.ts`\nexport const a = 1;\n\n### `src/b.ts`\nexport const b = 2;");
    const all = specContext(md, {}, { footprint: ["src/a.ts"] }, 10_000);
    expect(all.startsWith("## Run it")).toBe(true);
    expect(all).not.toContain("json firetrident");
    expect(all).not.toContain("intro");
  });

  it("puts the intent's own files first when the context is over budget", () => {
    const tight = specContext(md, { context: ["Contracts"] }, { footprint: ["src/b.ts"] }, 45);
    expect(tight).toBe("### `src/b.ts`\nexport const b = 2;");
  });

  it("writes the layout agents parse, capped for the server", () => {
    const spec = extractSpec(demoSpec);
    const create = spec.intents.find((i) => i.title.startsWith("Route: POST"))!;
    const why = intentWhy(spec, create, { markdown: demoSpec, source: "demo/new-project-spec.md" });
    expect(why.length).toBeLessThanOrEqual(WHY_MAX);
    expect(why).toMatch(/^The core feature: turn a URL into a slug\.\n\nScope: this intent writes src\/routes\/create\.ts\. It is one of 13 intents that build "shortlinks: /);
    expect(why).toContain("other intents' work.\nBuilds on: src/types.ts, src/http.ts, src/slug.ts, src/validate.ts\nModel: default\n\nSpec context (demo/new-project-spec.md):\n## What it is");
    expect(why).toContain("\n\nSpec context (demo/new-project-spec.md):\n## What it is");
    expect(why).toContain("### `src/router.ts`");
    expect(why).toContain("| A7 | Every error response above |");
    expect(why).not.toContain("## Run it");
    expect(why).not.toContain('"firetrident": "spec/v1"');
    expect(whySummary(why)).toBe("The core feature: turn a URL into a slug.");

    // What the in-platform agent reads back (packages/worker/src/agents/create.ts).
    const back = parseIntentSpec(why);
    expect(back.buildsOn).toEqual(["src/types.ts", "src/http.ts", "src/slug.ts", "src/validate.ts"]);
    expect(back.planned).toEqual([]);
    expect(back.model).toBe("default");
    expect(back.why).not.toContain("Model:");
    expect(back.source).toBe("demo/new-project-spec.md");
    expect(back.spec).toMatch(/^## What it is/);
    expect(back.why).toMatch(/^The core feature: turn a URL into a slug\.\n\nScope: this intent writes src\/routes\/create\.ts\. /);
  });

  it("checks that context names sections of the Markdown", () => {
    const md2 = ["## A", "text", "```json firetrident", JSON.stringify({ ...minimal, context: ["B"] }), "```"].join("\n");
    expect(() => extractSpec(md2)).toThrow(/context\[0\] names no "## B" section/);
  });
});

describe("ft new", () => {
  it("declares rules, then intents in dependency order with their parents, carrying the spec context", async () => {
    const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    let n = 0;
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ method: init?.method ?? "GET", path, body });
      const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
      if (path === "/api/colonies") return reply(201, { id: "shortlinks", name: body.name });
      if (path.endsWith("/rules")) return reply(201, { rule: { id: `rul_${++n}` }, violations: 0, intents: 0 });
      if (path.endsWith("/intents")) return reply(201, { id: `int_${++n}`, title: body.title });
      return reply(404, { error: "no route" });
    }) as typeof globalThis.fetch;
    const out: string[] = [];
    const io: Io = {
      env: { FT_URL: "https://ft.invalid", FT_TOKEN: "tok", FT_USER: "tester", NO_COLOR: "1" },
      stdout: (l) => void out.push(l),
      stderr: (l) => void out.push(l),
      isTTY: false,
      fetch,
      readFile: async () => demoSpec,
      sleep: async () => {},
      now: () => 0,
      WebSocket: globalThis.WebSocket,
      onInterrupt: () => {},
    };
    expect(await main(["new", "--spec", "demo/new-project-spec.md"], io)).toBe(0);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/colonies", body: { name: "shortlinks", regionDepth: 2 } });
    expect(calls.slice(1, 6).every((c) => c.path === "/api/colonies/shortlinks/rules")).toBe(true);
    const intents = calls.slice(6);
    expect(intents).toHaveLength(13);
    const id = (t: string) => `int_${6 + intents.findIndex((c) => String(c.body.title).startsWith(t))}`;
    const parentOf = (t: string) => intents.find((c) => String(c.body.title).startsWith(t))!.body.parentId;
    expect(intents[0]!.body.parentId).toBeUndefined();
    expect(parentOf("Router")).toBe(id("HTTP helpers"));
    expect(parentOf("Acceptance suite")).toBe(id("Worker entry"));
    expect(String(intents[0]!.body.why)).toContain("Spec context (demo/new-project-spec.md):");
    const text = out.join("\n");
    expect(text).toContain(`✓ intent ${id("Router")} p4 Router with params, 404, and 405 ← builds on "HTTP helpers: json, error, readJson"`);
    expect(text).toContain("5 rules and 13 intents painted into the field, in 5 waves (priority 5 to 1).");
    expect(text).toContain("Next: ft swarm shortlinks --agents 6");
  });
});

describe("intent models", () => {
  it("validates a model and writes it into the why for agents", () => {
    const spec = validateSpec({ ...minimal, intents: [{ title: "A", why: "w", footprint: ["a.ts"], model: "default" }, { title: "B", why: "w", footprint: ["b.ts"] }] });
    expect(spec.intents[0]?.model).toBe("default");
    expect(intentWhy(spec, spec.intents[0]!)).toContain("\nModel: default");
    expect(intentWhy(spec, spec.intents[1]!)).not.toContain("Model:");
    expect(() => validateSpec({ ...minimal, intents: [{ title: "A", why: "w", footprint: ["a.ts"], model: "two words" }] })).toThrow(/intents\[0\]\.model must be a model id/);
    const demo = extractSpec(demoSpec);
    expect(demo.intents.filter((i) => i.model === "default").map((i) => i.title.split(" ")[0])).toEqual(["Router", "Route:", "Worker", "Acceptance"]);
  });
});
