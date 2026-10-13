import { describe, expect, it } from "vitest";
import type { IntentSource } from "@fire_trident/core";
import { addedLines, applyAllowances, dangerLabels, importLines, looksLikeSecret, maskExcerpt, scanDanger, skipOptionLines, triageDanger, whyAuthor } from "../../src/decide/danger.ts";
import type { DangerFile, DangerIntent } from "../../src/decide/danger.ts";
import { antibodyAllows } from "../../src/decide/antibodies.ts";

/** An intent with this title, written by a person unless another source is given. */
function intent(title: string, source: IntentSource = "human"): DangerIntent {
  return { title, why: "", source };
}

/** Hits of one new file. */
function scanNew(path: string, text: string, title = "Add a module", source: IntentSource = "human") {
  return scanDanger([{ path, before: null, after: text }], intent(title, source));
}

/** Hits of one modified file. */
function scanEdit(path: string, before: string, after: string, title = "Edit a module", source: IntentSource = "human") {
  return scanDanger([{ path, before, after }], intent(title, source));
}

const classes = (hits: ReturnType<typeof scanDanger>) => [...new Set(hits.map((h) => h.cls))].sort();

describe("auth", () => {
  const route = [
    'import type { Handler } from "../types.ts";',
    'import { error, json } from "../http.ts";',
    "export const deleteLink: Handler = async (request, params, deps) => {",
    '  if (!deps.adminToken || request.headers.get("authorization") !== `Bearer ${deps.adminToken}`) return error(401, "unauthorized", "Admin token required");',
    "  return new Response(null, { status: 204 });",
    "};",
    "",
  ].join("\n");

  it("flags the admin DELETE route's bearer check, which must reach a human even when the intent asks for it", () => {
    const hits = scanNew("src/routes/links.ts", route, "Routes: GET and DELETE /api/links/:slug. DELETE needs Authorization: Bearer <adminToken>");
    expect(classes(hits)).toEqual(["auth"]);
    expect(hits.map((h) => h.pattern)).toEqual(expect.arrayContaining(["auth:authorization-header", "auth:bearer-scheme", "auth:credential-compare", "auth:unauthorized"]));
    const t = triageDanger(hits);
    expect(t.mustHuman.length).toBe(hits.length);
    expect(dangerLabels(t.mustHuman)).toEqual([expect.stringContaining("auth (authorization-header) at src/routes/links.ts:4")]);
  });

  it("flags admin gates and constant-time credential comparisons", () => {
    expect(classes(scanNew("src/a.ts", "if (user.role === 'admin') allow();\n"))).toEqual(["auth"]);
    expect(classes(scanNew("src/a.ts", "return timingSafeEqual(a, b);\n"))).toEqual(expect.arrayContaining(["auth"]));
    expect(classes(scanNew("src/a.ts", "if (!isAdmin(user)) return deny();\n"))).toEqual(["auth"]);
  });

  it("leaves wiring and type declarations alone", () => {
    expect(scanNew("src/types.ts", "export interface Deps { store: Store; adminToken?: string }\n")).toEqual([]);
    expect(scanNew("src/index.ts", "if (env.ADMIN_TOKEN) deps.adminToken = env.ADMIN_TOKEN;\n")).toEqual([]);
    // Parser tokens are not credentials.
    expect(scanNew("src/router/parse.ts", "if (token === '*') return wildcard;\n")).toEqual([]);
  });

  it("does not gate tests that exercise auth, nor docs that describe it", () => {
    expect(scanNew("test/acceptance.test.ts", "const res = await app.fetch(new Request(url, { method: 'DELETE', headers: { authorization: 'Bearer secret' } }));\n")).toEqual([]);
    expect(scanNew("README.md", "| DELETE | /api/links/:slug | Authorization: Bearer <adminToken> |\n")).toEqual([]);
  });
});

describe("secret", () => {
  it("flags hard-coded credentials, known token formats and private keys, masking them", () => {
    const hits = scanNew("src/config.ts", 'export const API_KEY = "sk-live-4f9a8b7c6d5e4f3a2b1c0d9e";\n');
    expect(classes(hits)).toEqual(["secret"]);
    expect(hits[0]!.excerpt).not.toContain("4f9a8b7c6d5e4f3a2b1c0d9e");
    expect(classes(scanNew("wrangler.jsonc", '  "vars": { "ADMIN_TOKEN": "hunter2-rot13-xyz" }\n'))).toEqual(["secret"]);
    expect(classes(scanNew("fixtures/key.pem", "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n"))).toEqual(["secret"]);
    expect(classes(scanNew("test/a.test.ts", "const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';\n"))).toEqual(["secret"]);
  });

  it("flags secrets written to logs", () => {
    expect(scanNew("src/a.ts", "console.log('[debug] auth', process.env.GITHUB_TOKEN);\n").map((h) => h.pattern)).toContain("secret:logged");
  });

  it("ignores placeholders and type annotations", () => {
    expect(scanNew("src/a.ts", 'const token = "<REPLACE_ME>";\nconst password: string = input;\n')).toEqual([]);
    expect(scanNew("README.md", 'Set `api_key: "your-key-here"` in the config.\n')).toEqual([]);
  });
});

describe("capability", () => {
  it("flags process, network and eval capability the intent does not ask for", () => {
    expect(scanNew("src/a.ts", "execSync('npm publish');\n")[0]).toMatchObject({ cls: "capability", pattern: "capability:process" });
    expect(scanNew("src/a.ts", "await fetch('https://collector.example/u', { method: 'POST' });\n")[0]).toMatchObject({ cls: "capability", pattern: "capability:network" });
    expect(scanNew("src/a.ts", "const f = new Function('x', body);\n")[0]).toMatchObject({ cls: "capability", pattern: "capability:eval" });
    expect(scanNew("src/a.ts", "import { exec } from 'node:child_process';\nexport {};\n").map((h) => h.pattern)).toEqual(["capability:import-process"]);
  });

  it("records capability the intent asks for without counting it", () => {
    const hits = scanNew("src/hook.ts", "await fetch(url, { method: 'POST', body });\n", "Send a webhook when a link is created");
    expect(hits[0]).toMatchObject({ cls: "capability", requested: true });
    expect(triageDanger(hits)).toMatchObject({ mustHuman: [], signals: [], recorded: [hits[0]] });
  });

  it("does not mistake a Worker's fetch handler for a network call", () => {
    const entry = ["export default {", "  async fetch(request: Request, env: Env): Promise<Response> {", "    return app.fetch(request, env);", "  },", "};", ""].join("\n");
    expect(scanNew("src/index.ts", entry)).toEqual([]);
    expect(scanNew("src/index.ts", "export default { fetch(request, env) { return handle(request, env); } };\n")).toEqual([]);
  });
});

describe("crypto, CI, dependencies, weakened tests", () => {
  it("flags security primitives as a signal unless the intent asks for them", () => {
    const line = "const n = crypto.getRandomValues(new Uint32Array(1))[0];\n";
    expect(triageDanger(scanNew("src/index.ts", line)).signals.map((h) => h.cls)).toEqual(["crypto"]);
    expect(triageDanger(scanNew("src/index.ts", line, "random comes from crypto.getRandomValues")).recorded.map((h) => h.cls)).toEqual(["crypto"]);
    expect(scanNew("src/a.ts", "const token = Math.random().toString(36);\n").map((h) => h.pattern)).toContain("crypto:weak-random");
  });

  it("flags CI workflows and dependency manifests by path, as signals", () => {
    const hits = scanDanger(
      [
        { path: ".github/workflows/ci.yml", before: "run: npm test\n", after: "run: npm test || true\n" },
        { path: "package.json", before: null, after: '{ "name": "x" }\n' },
      ],
      intent("Scaffold the project"),
    );
    expect(classes(hits)).toEqual(["ci", "dependency"]);
    expect(triageDanger(hits).mustHuman).toEqual([]);
  });

  it("flags skipped or focused tests, removed assertions, and deleted test files", () => {
    const before = "it('works', () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});\n";
    expect(scanEdit("test/a.test.ts", before, before.replace("it(", "it.skip(")).map((h) => h.pattern)).toEqual(["test-weakening:skip-or-only"]);
    expect(scanEdit("test/a.test.ts", before, before.replace("  expect(b).toBe(2);\n", "")).map((h) => h.pattern)).toEqual(["test-weakening:assertions-removed"]);
    const deleted: DangerFile = { path: "test/a.test.ts", before, after: null, deleted: true };
    expect(scanDanger([deleted], intent("x")).map((h) => h.pattern)).toEqual(["test-weakening:deleted-test-file"]);
  });
});

describe("over-escalations seen on the w1c new-project run", () => {
  it("a presence check on a URL's credentials is not a credential comparison", () => {
    expect(scanNew("src/validate.ts", 'if (url.username !== "" || url.password !== "") {\n  return { ok: false, reason: "credentials" };\n}\n')).toEqual([]);
    expect(scanNew("src/a.ts", "if (token === null) return;\n")).toEqual([]);
  });

  it("an error-code name in a union or a status table is not a denial", () => {
    expect(scanNew("src/http.ts", 'export type ErrorCode =\n  | "bad_request"\n  | "unauthorized"\n  | "not_found";\nconst STATUS = { unauthorized: 401 };\n')).toEqual([]);
    expect(scanNew("src/a.ts", 'return error(401, "unauthorized", "Admin token required");\n').map((h) => h.pattern)).toEqual(["auth:unauthorized"]);
  });
});

describe("no false positives on the rule runs", () => {
  it("Hono: rewriting relative specifiers adds no danger, even next to auth middleware", () => {
    const before = [
      "import { bearerAuth } from '../../middleware/bearer-auth'",
      "import type { BasicAuthOptions } from '../../middleware/basic-auth'",
      "import { HTTPException } from '../../http-exception'",
      "import {",
      "  verifyJwt,",
      "  type JWTPayload,",
      "} from '../../utils/jwt'",
      "export const auth = bearerAuth({ token: 'x' })",
      "",
    ].join("\n");
    const after = before
      .replace("'../../middleware/bearer-auth'", "'../../middleware/bearer-auth/index.ts'")
      .replace("'../../middleware/basic-auth'", "'../../middleware/basic-auth/index.ts'")
      .replace("'../../http-exception'", "'../../http-exception.ts'")
      .replace("'../../utils/jwt'", "'../../utils/jwt/index.ts'");
    expect(addedLines(before, after).length).toBe(4);
    expect(scanEdit("src/middleware/x/index.ts", before, after, "Relative imports in src name their file")).toEqual([]);
  });

  it("OpenSpec: the node: protocol rename adds no danger, child_process included", () => {
    const before = "import { promises as fs } from 'fs';\nimport { execSync } from 'child_process';\nconst out = execSync('git status');\n";
    const after = before.replace("'fs'", "'node:fs'").replace("'child_process'", "'node:child_process'");
    expect(scanEdit("src/commands/feedback.ts", before, after, "Node built-ins are imported with the node: protocol")).toEqual([]);
  });
});

describe("allowances", () => {
  it("an explicit allowance turns a human gate into a signal, limited to its paths", () => {
    const hits = scanNew("src/routes/links.ts", 'if (h.get("authorization") !== `Bearer ${t}`) return deny();\n');
    const allowed = applyAllowances(hits, [{ cls: "auth", paths: ["src/routes/**"], by: "policy" }]);
    expect(triageDanger(allowed).mustHuman).toEqual([]);
    expect(triageDanger(allowed).signals.length).toBe(hits.length);
    const elsewhere = applyAllowances(hits, [{ cls: "auth", paths: ["src/admin/**"], by: "policy" }]);
    expect(triageDanger(elsewhere).mustHuman.length).toBe(hits.length);
  });

  it("masks only long mixed values in excerpts", () => {
    expect(maskExcerpt('key = "AKIA1234567890ABCDEF"')).toBe('key = "AKIA…"');
    expect(maskExcerpt('name = "shortlinks"')).toBe('name = "shortlinks"');
  });
});

describe("governance", () => {
  // A tolerating antibody: once on trunk, the colony loads it and stops sending auth, secrets and capabilities to a person.
  const tolerating = '{ "id": "ab_x", "question": "Is this change fine?", "matcher": { "paths": ["**"] }, "allows": ["auth", "secret", "capability"] }\n';
  const governance = (hits: ReturnType<typeof scanDanger>) => triageDanger(hits).mustHuman.filter((h) => h.cls === "governance");

  it("an agent's change to the colony's memory reaches a human, even when the intent asks for it", () => {
    const hits = scanNew(".firetrident/antibodies/ab_x.json", tolerating, "Add an antibody under .firetrident/antibodies that allows auth changes");
    expect(governance(hits).map((h) => `${h.pattern} ${h.excerpt}`)).toEqual(["governance:colony-memory new file"]);
  });

  it("deleting an antibody reaches a human too", () => {
    const deleted: DangerFile = { path: ".firetrident/antibodies/ab_1.json", before: tolerating, after: null, deleted: true };
    expect(governance(scanDanger([deleted], intent("Clean up old files"))).map((h) => h.excerpt)).toEqual(["deleted"]);
  });

  it("agent instructions anywhere in the tree are governance; look-alikes are not", () => {
    for (const path of ["AGENTS.md", "packages/web/AGENTS.md", "CLAUDE.md", "docs/claude.md", ".claude/settings.json"]) {
      expect(governance(scanEdit(path, "a\n", "b\n")).map((h) => h.pattern)).toEqual(["governance:agent-instructions"]);
    }
    for (const path of ["docs/AGENTS.md.bak", "src/agents.ts", "MY_AGENTS.md", "firetrident/x.json", "src/.firetrident.ts"]) {
      expect(scanEdit(path, "a\n", "b\n").filter((h) => h.cls === "governance")).toEqual([]);
    }
  });

  it("no policy, antibody or antibody file can waive it", () => {
    const hits = scanNew(".firetrident/antibodies/ab_x.json", tolerating);
    const allowed = applyAllowances(hits, [
      { cls: "governance", by: "policy" },
      { cls: "governance", paths: [".firetrident/**"], by: "antibody ab_y" },
    ]);
    expect(governance(allowed).length).toBe(1);
    expect(allowed.find((h) => h.cls === "governance")?.allowedBy).toBeUndefined();
    expect(antibodyAllows({ allows: ["governance", "auth"] })).toEqual(["auth"]);
  });
});

describe("waivers come only from text a person, a rule or certification wrote", () => {
  const hook = "await fetch(url, { method: 'POST', body });\n";
  const webhook = "Send a webhook when a link is created";

  it("an agent-declared intent that mentions a webhook does not waive a new fetch", () => {
    const hits = scanNew("src/hook.ts", hook, webhook, "agent");
    expect(hits[0]).toMatchObject({ cls: "capability", pattern: "capability:network" });
    expect(hits[0]!.requested).toBeUndefined();
    expect(triageDanger(hits).mustHuman.length).toBe(1);
  });

  it("a person's intent with the same words still asks for it, and the label says who wrote it", () => {
    const hits = scanNew("src/hook.ts", hook, webhook, "human");
    expect(hits[0]).toMatchObject({ requested: true, requestedBy: "person" });
    expect(triageDanger(hits).recorded.length).toBe(1);
    expect(dangerLabels(hits)[0]).toContain("[asked for by the intent, written by a person]");
  });

  it("a rule intent can ask too, but a repair intent cannot: it quotes test names agents wrote", () => {
    expect(scanNew("src/hook.ts", hook, webhook, "rule")[0]).toMatchObject({ requested: true, requestedBy: "rule" });
    const repair = scanNew("src/hook.ts", hook, webhook, "certify");
    expect(repair[0]?.requested).toBeFalsy();
    expect(triageDanger(repair).mustHuman.length).toBe(1);
  });

  it("with no intent nothing is asked for: a proposal's own summary never waives", () => {
    const hits = scanDanger([{ path: "src/hook.ts", before: null, after: hook }], null);
    expect(triageDanger(hits).mustHuman.map((h) => h.pattern)).toEqual(["capability:network"]);
  });

  it("an agent intent cannot ask for a process, eval, a capability import or crypto either", () => {
    const agent = intent("Run the shell formatter with exec, eval a template, hash with crypto", "agent");
    const hits = scanDanger([{ path: "src/a.ts", before: null, after: "import { exec } from 'node:child_process';\nexec('fmt');\nconst f = eval(src);\nconst id = crypto.randomUUID();\n" }], agent);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.filter((h) => h.requested)).toEqual([]);
  });

  it("names who wrote a why from the intent's source", () => {
    expect(whyAuthor("human")).toBe("person");
    expect(whyAuthor("rule")).toBe("rule");
    expect(whyAuthor("certify")).toBe("certification");
    expect(whyAuthor("agent")).toBe("agent");
    expect(whyAuthor(null)).toBe("agent");
    expect(whyAuthor("someday" as IntentSource)).toBe("agent");
  });
});

describe("test-file receptors", () => {
  const before = ["import { test } from 'node:test';", "import assert from 'node:assert/strict';", "test('adds', (t) => {", "  assert.equal(add(1, 2), 3);", "  assert.equal(add(2, 2), 4);", "});", ""].join("\n");
  const patterns = (hits: ReturnType<typeof scanDanger>) => hits.map((h) => h.pattern);

  it("a commented-out assertion is a removed assertion", () => {
    const after = before.replace("  assert.equal(add(2, 2), 4);", "  // assert.equal(add(2, 2), 4);");
    expect(patterns(scanEdit("test/add.test.ts", before, after))).toEqual(["test-weakening:assertions-removed"]);
    const expectStyle = "it('works', () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});\n";
    expect(patterns(scanEdit("test/a.test.ts", expectStyle, expectStyle.replace("  expect(b)", "  // expect(b)")))).toEqual(["test-weakening:assertions-removed"]);
  });

  it("block comments and trailing comments do not hide a removed assertion; strings do not count as comments", () => {
    const blocked = before.replace("  assert.equal(add(2, 2), 4);", "  /*\n  assert.equal(add(2, 2), 4);\n  */");
    expect(patterns(scanEdit("test/add.test.ts", before, blocked))).toEqual(["test-weakening:assertions-removed"]);
    const trailing = before.replace("  assert.equal(add(2, 2), 4);", "  check(); // assert.equal(add(2, 2), 4);");
    expect(patterns(scanEdit("test/add.test.ts", before, trailing))).toEqual(["test-weakening:assertions-removed"]);
    const url = before.replace("  assert.equal(add(2, 2), 4);", '  assert.equal(link("https://x.example//a"), 4);');
    expect(scanEdit("test/add.test.ts", before, url)).toEqual([]);
  });

  it("flags every skip and todo method form node:test and the usual runners honor", () => {
    const forms = ["test.skip('adds', () => {});", "it.skip('adds', () => {});", "describe.skip('math', () => {});", "suite.skip('math', () => {});", "test.todo('adds');", "it.todo('adds');"];
    for (const line of forms) {
      expect(patterns(scanEdit("test/add.test.ts", before, `${before}${line}\n`)), line).toEqual(["test-weakening:skip-or-only"]);
    }
  });

  it("flags a test context skipping or marking its own test: t.skip() and t.todo()", () => {
    for (const call of ["t.skip();", "t.skip('flaky on CI');", "t.todo();", 't.todo("later");', "ctx.skip();", "this.skip();"]) {
      const after = before.replace("  assert.equal(add(1, 2), 3);", `  ${call}\n  assert.equal(add(1, 2), 3);`);
      expect(patterns(scanEdit("test/add.test.ts", before, after)), call).toEqual(["test-weakening:context-skip"]);
    }
    // Only in test files, and only with no argument or a message: a cursor skipping rows is not a test.
    expect(scanNew("src/db.ts", "export const next = () => cursor.skip();\n")).toEqual([]);
    expect(scanEdit("test/db.test.ts", before, before.replace("  assert.equal(add(1, 2), 3);", "  rows.skip(10);\n  assert.equal(add(1, 2), 3);"))).toEqual([]);
  });

  it("flags options objects that turn skip or todo on, on one line or several", () => {
    const one = before.replace("test('adds', (t) => {", "test('adds', { skip: true }, (t) => {");
    expect(scanEdit("test/add.test.ts", before, one).map((h) => [h.pattern, h.line])).toEqual([["test-weakening:skip-option", 3]]);
    const todo = before.replace("test('adds', (t) => {", 'test("adds", { todo: "later" }, (t) => {');
    expect(patterns(scanEdit("test/add.test.ts", before, todo))).toEqual(["test-weakening:skip-option"]);
    const several = before.replace("test('adds', (t) => {", "test(\n  'adds',\n  {\n    timeout: 500,\n    skip: process.platform === 'win32',\n  },\n  (t) => {");
    expect(scanEdit("test/add.test.ts", before, several).map((h) => [h.pattern, h.line])).toEqual([["test-weakening:skip-option", 7]]);
    const nameless = `${before}describe({ todo: true }, () => {});\n`;
    expect(patterns(scanEdit("test/add.test.ts", before, nameless))).toEqual(["test-weakening:skip-option"]);
    expect(skipOptionLines("t.test('sub', { skip: 'not on this platform' }, () => {});\n")).toEqual([1]);
  });

  it("does not flag options left off, data that only looks like options, or a commented-out option", () => {
    const off = before.replace("test('adds', (t) => {", "test('adds', { skip: false, todo: undefined, timeout: 100 }, (t) => {");
    expect(scanEdit("test/add.test.ts", before, off)).toEqual([]);
    const data = `${before}const item = { id: 1, todo: "buy milk", done: false };\nconst page = { skip: 10, take: 5 };\n`;
    expect(scanEdit("test/todos.test.ts", before, data)).toEqual([]);
    const commented = `${before}// test('later', { skip: true }, () => {});\n`;
    expect(scanEdit("test/add.test.ts", before, commented)).toEqual([]);
    // A regex test with a string is not a test call with options.
    expect(skipOptionLines("expect(/a/.test('x')).toBe(true);\nexpect(re.test(name)).toBe(false);\n")).toEqual([]);
  });

  it("unchanged skips already on trunk do not fire when the file is edited elsewhere", () => {
    const skipped = before
      .replace("test('adds', (t) => {", "test('adds', { skip: 'flaky' }, (t) => {\n  t.todo('cover overflow');")
      .concat("test.skip('subtracts', () => {});\n");
    const edited = skipped.replace("assert.equal(add(1, 2), 3);", "assert.equal(add(1, 2), 3, 'one and two');");
    expect(scanEdit("test/add.test.ts", skipped, edited)).toEqual([]);
  });
});

describe("a repair never grades its own exam", () => {
  const test = ["import { test } from 'node:test';", "import assert from 'node:assert/strict';", "import { slug } from '../src/slug.ts';", "", "test('rejects reserved words', () => {", "  assert.equal(slug('api'), null);", "});", ""].join("\n");
  const repair = (files: DangerFile[]) => scanDanger(files, { title: "Make the failing tests pass: rejects reserved words", why: "Trunk fails 1 of its 4 tests.", source: "certify" });
  const changes = (hits: ReturnType<typeof scanDanger>) => hits.filter((h) => h.cls === "test-change");

  it("any edit of a test file beyond its imports needs a person, even an expected value", () => {
    const hits = repair([{ path: "test/slug.test.ts", before: test, after: test.replace("slug('api'), null", "slug('api'), 'api'") }]);
    expect(changes(hits).map((h) => [h.pattern, h.line])).toEqual([["test-change:edited", 6]]);
    expect(changes(hits)[0]!.excerpt).toContain("test file edited during a repair: 2 lines beyond imports");
    expect(triageDanger(hits).mustHuman.map((h) => h.cls)).toEqual(["test-change"]);
  });

  it("no policy or antibody can allow it", () => {
    const hits = repair([{ path: "test/slug.test.ts", before: test, after: test.replace("null);", "null, 'reserved');") }]);
    const allowed = applyAllowances(hits, [
      { cls: "test-change" as never, by: "policy" },
      { cls: "test-weakening", by: "antibody ab_1" },
    ]);
    expect(triageDanger(allowed).mustHuman.map((h) => h.cls)).toEqual(["test-change"]);
  });

  it("import-only edits pass: a rewritten specifier and a multi-line import clause", () => {
    const relative = test.replace("'../src/slug.ts'", "'../src/slug/index.ts'");
    expect(changes(repair([{ path: "test/slug.test.ts", before: test, after: relative }]))).toEqual([]);
    const multi = test.replace("import { slug } from '../src/slug.ts';", "import {\n  slug,\n  type Slug,\n} from '../src/slug.ts';");
    expect(changes(repair([{ path: "test/slug.test.ts", before: test, after: multi }]))).toEqual([]);
    expect([...importLines("test/slug.test.ts", multi)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("a package import added or dropped can take the file out of the run, so it needs a person too", () => {
    const pkg = test.replace("import { slug } from '../src/slug.ts';", "import { slug } from '../src/slug.ts';\nimport 'some-package';");
    expect(changes(repair([{ path: "test/slug.test.ts", before: test, after: pkg }])).map((h) => h.pattern)).toEqual(["test-change:package-imports"]);
    const noRunner = test.replace("import { test } from 'node:test';\n", "");
    expect(changes(repair([{ path: "test/slug.test.ts", before: test, after: noRunner }]))[0]!.excerpt).toContain("-test");
  });

  it("deleting a test file, adding one, or changing a fixture under test/ needs a person", () => {
    expect(changes(repair([{ path: "test/slug.test.ts", before: test, after: null, deleted: true }])).map((h) => h.excerpt)).toEqual(["test file deleted during a repair"]);
    expect(changes(repair([{ path: "test/more.test.ts", before: null, after: test }])).map((h) => h.pattern)).toEqual(["test-change:edited"]);
    expect(changes(repair([{ path: "test/fixtures/words.json", before: '["api"]\n', after: '["app"]\n' }])).length).toBe(1);
  });

  it("fixing the code under test is untouched, and other intents may edit tests as before", () => {
    expect(changes(repair([{ path: "src/slug.ts", before: "export const slug = (s: string) => s;\n", after: "export const slug = (s: string) => (s === 'api' ? null : s);\n" }]))).toEqual([]);
    const edit = { path: "test/slug.test.ts", before: test, after: test.replace("slug('api'), null", "slug('api'), 'api'") };
    expect(changes(scanDanger([edit], intent("Spec: slugs", "human")))).toEqual([]);
    expect(changes(scanDanger([edit], intent("Agent work", "agent")))).toEqual([]);
  });
});

describe("secrets in what is shown", () => {
  it("masks token formats outside quotes in excerpts", () => {
    expect(maskExcerpt("GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB")).toBe("GITHUB_TOKEN=ghp_…");
  });

  it("recognizes lines that may hold a secret", () => {
    expect(looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(looksLikeSecret("const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';")).toBe(true);
    expect(looksLikeSecret('export const API_KEY = "sk-live-4f9a8b7c6d5e4f3a";')).toBe(true);
    expect(looksLikeSecret("api_key: s3cr3tv4lu3x9z")).toBe(true);
    expect(looksLikeSecret("console.log('token', process.env.NPM_TOKEN);")).toBe(true);
    expect(looksLikeSecret("const token = request.headers.get('x-token');")).toBe(false);
    expect(looksLikeSecret("return add(a, b);")).toBe(false);
  });
});
