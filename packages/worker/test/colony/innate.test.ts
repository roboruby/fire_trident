import { describe, expect, it } from "vitest";
import type { Colony, FileVersion, Intent, Proposal, Rule, Sha } from "@fire_trident/core";
import { checkFile, importsOf } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { MAX_RULES, hollowFile, ruleViolations, runInnateChecks, type BlobReader } from "../../src/colony/innate.ts";

const COLONY = { id: "c", trunk: { namespace: "ft-trunk", name: "c--trunk", remote: "" } } as unknown as Colony;
const enc = new TextEncoder();
let next = 0;
const sha = (): Sha => (++next).toString(16).padStart(40, "0");

/** A proposal writing `files` (content null deletes) over a base holding `base`, with blobs served by a fake reader. */
function setup(files: Record<string, string | null>, base: Record<string, string> = {}): { p: Proposal; read: BlobReader } {
  const blobs = new Map<Sha, Uint8Array>();
  const writeSet: FileVersion[] = [];
  const readSet: FileVersion[] = [];
  for (const [path, content] of Object.entries(files)) {
    const after = content === null ? null : sha();
    if (after && content !== null) blobs.set(after, enc.encode(content));
    writeSet.push({ path, blob: after });
    const old = base[path];
    if (old !== undefined) {
      const before = sha();
      blobs.set(before, enc.encode(old));
      readSet.push({ path, blob: before });
    } else {
      readSet.push({ path, blob: null });
    }
  }
  const p = {
    id: "prp_1",
    colonyId: "c",
    intentId: "int_1",
    agentId: "agt_1",
    workspace: { namespace: "ft-ws-0", name: "c--ws-0", remote: "" },
    baseSha: "base",
    headSha: "head",
    writeSet,
    readSet,
    declared: { footprint: ["src/**"], summary: "change" },
    evidence: { checks: [], notVerified: "Not verified: the tests" },
    status: "checking",
    createdAt: 0,
  } as Proposal;
  return { p, read: async (_where, ids) => new Map(ids.map((id) => [id, blobs.get(id) ?? null])) };
}

function intent(ruleId?: string): Intent {
  return { id: "int_1", colonyId: "c", title: "Change", why: "test", source: ruleId ? "rule" : "human", ...(ruleId ? { ruleId } : {}), footprint: ["src/**"], priority: 1, status: "claimed", createdAt: 0, createdBy: "t" };
}

function patternRule(id: string, pattern: string, createdAt: number): Rule {
  return { id, colonyId: "c", kind: "forbid-pattern", spec: { pattern, hint: "h" }, description: `no ${pattern}`, approvedBy: "t", createdAt };
}

const ENV = {} as Env;

describe("rule re-check", () => {
  it("counts violations exactly as checkFile does, reading each file's imports once", () => {
    const rules: Rule[] = [
      { id: "a", colonyId: "c", kind: "forbid-import", spec: { module: "^lodash" }, description: "", approvedBy: "t", createdAt: 0 },
      { id: "b", colonyId: "c", kind: "forbid-import", spec: { module: "^LODASH", flags: "gi", from: ["src/**"], exclude: ["src/vendor/**"] }, description: "", approvedBy: "t", createdAt: 0 },
      { id: "c", colonyId: "c", kind: "forbid-import", spec: { module: "\\.\\./", from: "lib/**" }, description: "", approvedBy: "t", createdAt: 0 },
      { id: "d", colonyId: "c", kind: "forbid-pattern", spec: { pattern: "console\\.log", flags: "g" }, description: "", approvedBy: "t", createdAt: 0 },
      { id: "e", colonyId: "c", kind: "forbid-import", spec: { module: "(" }, description: "invalid", approvedBy: "t", createdAt: 0 },
    ];
    const texts = [
      'import _ from "lodash";\nimport { a } from "lodash/fp";\nconst x = require("../util");\nconsole.log(_);\n',
      '// import x from "lodash"\nexport const s = "import y from \\"lodash\\"";\n',
      "",
    ];
    const paths = ["src/a.ts", "src/vendor/b.js", "lib/c.mjs", "README.md", "src/d.json"];
    let reads = 0;
    const counting = (text: string) => {
      reads++;
      return importsOf(text);
    };
    for (const rule of rules) {
      for (const path of paths) {
        for (const text of texts) {
          let expected: number | "throws";
          try {
            expected = checkFile(rule, path, text).length;
          } catch {
            expected = "throws";
          }
          let actual: number | "throws";
          try {
            actual = ruleViolations(rule, path, text, counting);
          } catch {
            actual = "throws";
          }
          expect(actual, `${rule.id} ${path} ${JSON.stringify(text.slice(0, 20))}`).toBe(expected);
        }
      }
    }
    expect(reads).toBeGreaterThan(0);
  });

  it("always checks the intent's own rule and checks up to 200 rules", async () => {
    // 230 rules; the intent's own rule is the newest, beyond the cap.
    const rules = Array.from({ length: 230 }, (_, k) => patternRule(`rul_${String(k).padStart(3, "0")}`, `\\bbanned${k}\\b`, k));
    const own = rules[229]!;
    const { p, read } = setup({ "src/a.ts": "export const a = banned229 + banned150 + banned210;\n" }, { "src/a.ts": "export const a = banned229;\n" });
    const res = await runInnateChecks(p, { env: ENV, colony: COLONY, intent: intent(own.id), rules, read });
    expect(MAX_RULES).toBe(200);
    expect(res.ok).toBe(false);
    // The own rule is checked and still violated in the footprint; rule 150 (inside the cap) gained one.
    expect(res.failures).toEqual([
      `src/a.ts still has 1 violation of rule ${own.id} (no \\bbanned229\\b)`,
      "src/a.ts adds 1 violation of rule rul_150 (no \\bbanned150\\b)",
    ]);
    // 230 rules, 200 checked: the 30 left out are named, so nothing is skipped silently.
    const note = res.checks.find((c) => c.name === "innate: rules");
    expect(note?.ok).toBe(true);
    expect(note?.detail).toMatch(/^re-checked 200 of 230 rules \(the per-proposal cap\); not re-checked: rul_199, rul_200, .* and 20 more$/);
    expect(note?.detail).not.toContain(own.id);
  });

  it("adds no rules note when every rule is checked", async () => {
    const rules = [patternRule("rul_a", "\\bfoo\\b", 0)];
    const { p, read } = setup({ "src/a.ts": "export const a = 1;\n" });
    const res = await runInnateChecks(p, { env: ENV, colony: COLONY, intent: intent("rul_a"), rules, read });
    expect(res.ok).toBe(true);
    expect(res.checks.some((c) => c.name === "innate: rules")).toBe(false);
  });
});

describe("new files must hold code", () => {
  it("returns a change whose new file is empty, only comments, or only placeholder bodies", async () => {
    const { p, read } = setup({
      "src/empty.ts": "\n  \n",
      "src/notes.ts": "// The server goes here.\n/* later */\n",
      "src/server.ts": 'import { Hono } from "hono";\n\nexport function createServer(): Hono {\n  throw new Error("Not implemented");\n}\n',
      "src/store.ts": 'export class FileStore implements Store {\n  get(key: string): string {\n    throw new Error("Method not implemented.");\n  }\n  set(key: string, value: string): void {\n    // TODO: implement\n  }\n}\n',
    });
    const res = await runInnateChecks(p, { env: ENV, colony: COLONY, intent: intent(), rules: [], read });
    expect(res.ok).toBe(false);
    expect(res.failures).toEqual([
      "src/empty.ts is a new file and it is empty: write its content, or leave it out of the change",
      "src/notes.ts is a new file with only comments in it: write its code, or leave it out of the change",
      'src/server.ts is a new file whose only code is placeholder bodies (createServer: a "not implemented" throw or a TODO): implement them, or leave the file out of the change',
      'src/store.ts is a new file whose only code is placeholder bodies (get, set: a "not implemented" throw or a TODO): implement them, or leave the file out of the change',
    ]);
    expect(res.checks.find((c) => c.name === "innate: new files")).toMatchObject({ ok: false, detail: "stubs: src/empty.ts (empty), src/notes.ts (comments), src/server.ts (placeholders), src/store.ts (placeholders)" });
  });

  it("passes legitimate tiny files, edits of existing files, deletions and other file kinds", async () => {
    const { p, read } = setup(
      {
        "src/index.ts": 'export * from "./server.ts";\nexport { FileStore } from "./store.ts";\n',
        "src/types.ts": "export type Id = string;\nexport interface Link {\n  id: Id;\n  url: string;\n}\n",
        "src/env.d.ts": '/// <reference types="vite/client" />\n',
        "src/noop.ts": "export function noop(): void {}\n",
        "src/module.ts": "export {};\n",
        "src/polyfills.ts": 'import "./shim.ts";\n',
        "src/real.ts": 'export function a() {\n  throw new Error("not implemented");\n}\nexport function b(): number {\n  return 1;\n}\n',
        "src/old.ts": "// emptied on purpose\n",
        "src/gone.ts": null,
        ".gitkeep": "",
        "docs/notes.md": "",
        "data/empty.json": "",
      },
      { "src/old.ts": "export const old = 1;\n", "src/gone.ts": "export const gone = 1;\n" },
    );
    const res = await runInnateChecks(p, { env: ENV, colony: COLONY, intent: intent(), rules: [], read });
    expect(res.failures).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.checks.find((c) => c.name === "innate: new files")).toMatchObject({ ok: true, detail: "7 new files with code" });
  });
});

describe("hollowFile", () => {
  const stub = (path: string, text: string) => hollowFile(path, text);

  it("recognizes the stub shapes", () => {
    expect(stub("src/a.ts", "")).toEqual({ kind: "empty", names: [] });
    expect(stub("src/a.mjs", "/** TODO */\n// later\n")).toEqual({ kind: "comments", names: [] });
    expect(stub("src/cli.ts", "#!/usr/bin/env node\n")).toEqual({ kind: "comments", names: [] });
    expect(stub("src/a.ts", "export function start() {\n  // TODO: implement\n}\n")).toEqual({ kind: "placeholders", names: ["start"] });
    expect(stub("src/a.ts", "// TODO(matt): the server\nexport async function start(port: number): Promise<void> {}\n")).toEqual({ kind: "placeholders", names: ["start"] });
    expect(stub("src/a.ts", 'export const handler = async (req: Request): Promise<Response> => {\n  throw new Error("TODO");\n};\n')).toEqual({ kind: "placeholders", names: ["handler"] });
    expect(stub("src/a.ts", "export default function () { throw new NotImplementedError(); }\n")).toEqual({ kind: "placeholders", names: ["default"] });
    expect(stub("src/a.tsx", 'export default function App(): JSX.Element { throw new Error("not implemented yet") }\n')).toEqual({ kind: "placeholders", names: ["App"] });
    expect(stub("src/a.js", "throw 'not implemented';\n")).toEqual({ kind: "placeholders", names: ["top level"] });
    expect(stub("src/a.ts", 'export function f<T extends Record<string, Array<T>>>(a: T = {} as T): Map<string, Array<T>> {\n  throw Error("unimplemented");\n}\n')).toEqual({
      kind: "placeholders",
      names: ["f"],
    });
  });

  it("treats everything else as code", () => {
    const code = [
      'export function unsupported() { throw new Error("Not supported in the browser build"); }\n',
      'export function f() { throw new Error(); }\n',
      "export function f(): { a: number } { throw new Error(\"not implemented\"); }\n",
      '"use strict";\nexport function f() { throw new Error("not implemented"); }\n',
      "export class Store {\n  private data = new Map<string, string>();\n  get(k: string): string { throw new Error(\"not implemented\"); }\n}\n",
      'export class Store {\n  constructor(private readonly dir: string) {}\n  get(k: string): string { throw new Error("not implemented"); }\n}\n',
      "export abstract class Shape {\n  abstract area(): number;\n}\n",
      "export enum Color {\n  Red,\n  Green,\n}\n",
      "export const handler = (req: Request) => new Response(\"ok\");\n",
      "// Called by the TODO widget: intentionally empty\nexport function f() {}\n",
      "export function f() { /* TODO widget is a no-op by design */ }\n",
      "const url = `http://${host}/x`;\nexport function f() {}\n",
      "export default { port: 8080 };\n",
      'import data from "./x.json" with { type: "json" };\nexport function f() { throw new Error("not implemented"); }\n',
    ];
    for (const text of code) expect(stub("src/a.ts", text), text).toBeNull();
    expect(stub("README.md", "")).toBeNull();
    expect(stub(".gitkeep", "")).toBeNull();
    expect(stub("src/__init__.py", "")).toBeNull();
  });
});

