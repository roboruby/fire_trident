import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractSpec, planNew, validateSpec } from "../src/spec.ts";

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
    expect((plan.intents[0]?.body as { why: string }).why).toContain("(Goal: shortlinks");
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
