import { describe, expect, it } from "vitest";
import { addedLines, applyAllowances, dangerLabels, maskExcerpt, scanDanger, triageDanger } from "../../src/decide/danger.ts";
import type { DangerFile } from "../../src/decide/danger.ts";
import { antibodyAllows } from "../../src/decide/antibodies.ts";

/** Hits of one new file. */
function scanNew(path: string, text: string, intent = "Add a module") {
  return scanDanger([{ path, before: null, after: text }], intent);
}

/** Hits of one modified file. */
function scanEdit(path: string, before: string, after: string, intent = "Edit a module") {
  return scanDanger([{ path, before, after }], intent);
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
      "Scaffold the project",
    );
    expect(classes(hits)).toEqual(["ci", "dependency"]);
    expect(triageDanger(hits).mustHuman).toEqual([]);
  });

  it("flags skipped or focused tests, removed assertions, and deleted test files", () => {
    const before = "it('works', () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});\n";
    expect(scanEdit("test/a.test.ts", before, before.replace("it(", "it.skip(")).map((h) => h.pattern)).toEqual(["test-weakening:skip-or-only"]);
    expect(scanEdit("test/a.test.ts", before, before.replace("  expect(b).toBe(2);\n", "")).map((h) => h.pattern)).toEqual(["test-weakening:assertions-removed"]);
    const deleted: DangerFile = { path: "test/a.test.ts", before, after: null, deleted: true };
    expect(scanDanger([deleted], "x").map((h) => h.pattern)).toEqual(["test-weakening:deleted-test-file"]);
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
    expect(governance(scanDanger([deleted], "Clean up old files")).map((h) => h.excerpt)).toEqual(["deleted"]);
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
