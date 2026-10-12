import { describe, expect, it } from "vitest";
import type { Rule } from "@fire_trident/core";
import {
  TreeIndex,
  applySpecifierEdits,
  candidateFiles,
  contextDirs,
  parseSpecifierEdits,
  relativeSpecifier,
  resolveRelative,
  specifierFacts,
} from "../../src/agents/context.ts";
import { buildSpecifierMessages, extractUsage } from "../../src/agents/prompt.ts";
import { assignModels } from "../../src/agents/swarm.ts";
import { modelOptions, throttleError } from "../../src/agents/llm.ts";

const RULE: Rule = {
  id: "rul_ext",
  colonyId: "col",
  kind: "forbid-import",
  spec: { from: ["src/**/*.ts", "src/**/*.tsx"], module: "^\\.\\.?(?:/.*)?(?<!\\.ts|\\.tsx|\\.json)$", hint: "Name the file." },
  description: "Relative imports name their file",
  approvedBy: "t",
  createdAt: 0,
};

const TREE = new TreeIndex([
  "src/index.ts",
  "src/hono.ts",
  "src/request.ts",
  "src/request/constants.ts",
  "src/client/index.ts",
  "src/client/client.ts",
  "src/jsx/index.ts",
  "src/jsx/dom/render.tsx",
  "src/middleware/jwt/index.ts",
  "src/middleware/jwt/jwt.ts",
  "package.json",
]);

const FILE = [
  "import { Hono } from './hono'",
  "import type { HonoRequest } from './request'",
  "export type { ClientRequestOptions } from './client'",
  'import { jsx } from "./jsx"',
  "import './hono.ts'",
  "",
].join("\n");

describe("tree context", () => {
  it("resolves relative specifiers and refuses to climb above the root", () => {
    expect(resolveRelative("src/middleware/jwt/index.ts", "../..")).toBe("src");
    expect(resolveRelative("src/middleware/jwt/index.ts", "./jwt")).toBe("src/middleware/jwt/jwt");
    expect(resolveRelative("src/index.ts", "../../x")).toBeNull();
    expect(resolveRelative("src/index.ts", "hono")).toBeNull();
    expect(relativeSpecifier("src/middleware/jwt/index.ts", "src/index.ts")).toBe("../../index.ts");
    expect(relativeSpecifier("src/index.ts", "src/client/index.ts")).toBe("./client/index.ts");
  });

  it("lists the files a specifier can name: the file first, then the directory index", () => {
    expect(candidateFiles("src/hono", TREE)).toEqual(["src/hono.ts"]);
    expect(candidateFiles("src/client", TREE)).toEqual(["src/client/index.ts"]);
    expect(candidateFiles("src/request", TREE)).toEqual(["src/request.ts"]);
    expect(TREE.isDir("src/request")).toBe(true);
    expect(TREE.list("src")).toEqual(["client/", "hono.ts", "index.ts", "jsx/", "middleware/", "request.ts", "request/"]);
  });

  it("collects one fact per flagged specifier with relative candidates", () => {
    const facts = specifierFacts(RULE, "src/index.ts", FILE, TREE);
    expect(facts.map((f) => f.resolution)).toEqual(["file", "file-beside-directory", "index", "index"]);
    expect(facts.map((f) => [f.line, f.specifier, f.directory, f.candidates])).toEqual([
      [1, "./hono", false, ["./hono.ts"]],
      [2, "./request", true, ["./request.ts"]],
      [3, "./client", true, ["./client/index.ts"]],
      [4, "./jsx", true, ["./jsx/index.ts"]],
    ]);
    expect(contextDirs("src/index.ts", facts, TREE)).toEqual(["src", "src/request", "src/client", "src/jsx"]);
  });

  it("builds a prompt with the flagged lines fenced, the facts and the listings", () => {
    const facts = specifierFacts(RULE, "src/index.ts", FILE, TREE);
    const [system, user] = buildSpecifierMessages({ intent: { id: "i", title: "Fix imports", why: "" }, rule: RULE, path: "src/index.ts", content: FILE, facts, tree: TREE, nonce: "abc123" });
    expect(system!.content).toContain("<edits>");
    expect(user!.content).toContain(`- line 3: "./client" resolves to "./client/index.ts" (src/client is a directory, so the import names its index file)`);
    expect(user!.content).toContain(`- line 2: "./request" resolves to "./request.ts" (a file; a directory src/request/ also exists, but the file wins)`);
    expect(user!.content).toContain(`- line 1: "./hono" resolves to "./hono.ts" (a file)`);
    expect(user!.content).toContain("src/client/: client.ts index.ts");
    expect(user!.content).toContain("<<<FILE abc123>>>\n1: import { Hono } from './hono'");
    expect(user!.content).not.toContain("import './hono.ts'"); // unflagged lines stay out
  });
});

describe("specifier edits", () => {
  const facts = specifierFacts(RULE, "src/index.ts", FILE, TREE);

  it("parses an <edits> block, tolerating quotes, list markers and fences", () => {
    const r = parseSpecifierEdits("<think>hmm</think>\n<edits>\n```\n1: './hono' => './hono.ts'\n- 3: ./client => ./client/index.ts\n```\n</edits>");
    expect(r).toEqual({ ok: true, edits: [{ line: 1, from: "./hono", to: "./hono.ts" }, { line: 3, from: "./client", to: "./client/index.ts" }] });
    expect(parseSpecifierEdits("no block").ok).toBe(false);
    expect(parseSpecifierEdits("<edits>\nchange it all\n</edits>").ok).toBe(false);
  });

  it("rewrites only the quoted specifiers and keeps every other byte", () => {
    const edits = [
      { line: 1, from: "./hono", to: "./hono.ts" },
      { line: 2, from: "./request", to: "./request.ts" },
      { line: 3, from: "./client", to: "./client/index.ts" },
      { line: 4, from: "./jsx", to: "./jsx/index.ts" },
    ];
    const r = applySpecifierEdits(RULE, "src/index.ts", FILE, facts, edits, TREE);
    expect(r.problems).toEqual([]);
    expect(r.changed).toBe(4);
    expect(r.rewrites.filter((x) => x.directory).map((x) => x.from)).toEqual(["./client", "./jsx"]);
    expect(r.content).toBe(FILE.replace("'./hono'", "'./hono.ts'").replace("'./request'", "'./request.ts'").replace("'./client'", "'./client/index.ts'").replace('"./jsx"', '"./jsx/index.ts"'));
  });

  it("keeps CRLF line endings", () => {
    const crlf = FILE.replace(/\n/g, "\r\n");
    const f = specifierFacts(RULE, "src/index.ts", crlf, TREE);
    const r = applySpecifierEdits(RULE, "src/index.ts", crlf, f, f.map((x) => ({ line: x.line, from: x.specifier, to: x.candidates[0]! })), TREE);
    expect(r.problems).toEqual([]);
    expect(r.content.split("\r\n")).toHaveLength(crlf.split("\r\n").length);
  });

  it("reports a path that does not exist and the specifiers still flagged", () => {
    const r = applySpecifierEdits(RULE, "src/index.ts", FILE, facts, [{ line: 3, from: "./client", to: "./client.ts" }], TREE);
    expect(r.problems[0]).toBe(`line 3: "./client.ts" names no file in the trunk tree (existing: "./client/index.ts")`);
    expect(r.problems.at(-1)).toContain(`line 1: "./hono"`);
    expect(r.problems.at(-1)).toContain(`line 4: "./jsx"`);
  });

  it("ignores edits on lines without a flagged specifier", () => {
    const r = applySpecifierEdits(RULE, "src/index.ts", FILE, facts, [{ line: 5, from: "./hono.ts", to: "./x.ts" }], TREE);
    expect(r.problems[0]).toContain("line 5 has no flagged specifier");
    expect(r.content).toBe(FILE);
  });
});

describe("model plumbing", () => {
  it("reads Workers AI usage", () => {
    expect(extractUsage({ usage: { prompt_tokens: 715, completion_tokens: 193, prompt_tokens_details: { cached_tokens: 12 }, neurons: 19.9 } })).toEqual({ input: 715, output: 193, cached: 12, neurons: 19.9 });
    expect(extractUsage({ response: "x" })).toBeNull();
  });

  it("asks reasoning models for low effort and tags throttling as 429", () => {
    expect(modelOptions("@cf/zai-org/glm-5.3-flash")).toEqual({ reasoning_effort: "low" });
    expect(modelOptions("@cf/google/gemma-4-26b-a4b-it")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(modelOptions("@cf/moonshotai/kimi-k2.7-code")).toEqual({});
    expect(throttleError(new Error("AiError: AiError: rate limiting: inference request per min rate reached (x)"), "m").message).toMatch(/^\[ft:429\] model m is throttled/);
    expect(throttleError(new Error("boom"), "m").message).toBe("boom");
  });

  it("spreads a swarm over several models", () => {
    const id = (m: string | undefined): string => m ?? "bulk";
    expect(assignModels(undefined, 3, id)).toEqual(["bulk", "bulk", "bulk"]);
    expect(assignModels("a=2,b,c", 6, id)).toEqual(["a", "b", "c", "a", "b", "c"]);
    expect(assignModels("a=5,b", 3, id)).toEqual(["a", "a", "a"]);
    const mix = assignModels("a=1,b=1", 4, id);
    expect(mix.filter((m) => m === "a")).toHaveLength(2);
  });
});
