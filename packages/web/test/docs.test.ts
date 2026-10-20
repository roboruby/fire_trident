import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO } from "../src/landing/questions.ts";

/**
 * The docs hold together: every relative link in the README, SECURITY.md and docs/ names a file that exists and, with a
 * #anchor, a heading of that page; every link the site and the agent front door make to a heading of a page in this
 * repository names one that exists; and every list of flags in the docs matches packages/worker/wrangler.jsonc, which is
 * what a deployment runs.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every file under a folder, recursively, repository-relative. */
function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const p = join(dir, name);
    return statSync(join(ROOT, p)).isDirectory() ? walk(p) : [p];
  });
}

/** Markdown without its fenced code blocks, where a line starting with # is a comment, not a heading. */
function prose(md: string): string {
  return md.replace(/^\s*```[\s\S]*?^\s*```/gm, "");
}

/** A heading's anchor as the repository host renders it: lowercase, punctuation dropped, spaces as hyphens. */
function anchor(heading: string): string {
  return heading
    .trim()
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** The anchors of a page's headings. */
function anchors(md: string): Set<string> {
  return new Set([...prose(md).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) => anchor(m[1] ?? "")));
}

/** What is wrong with the relative links of one markdown page. */
function linkProblems(page: string): string[] {
  const md = read(page);
  const out: string[] = [];
  for (const m of prose(md).matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [file = "", hash] = target.split("#");
    const abs = file === "" ? join(ROOT, page) : resolve(ROOT, dirname(page), file);
    const rel = relative(ROOT, abs);
    if (!existsSync(abs)) {
      out.push(`${page}: ${target} names no file`);
      continue;
    }
    if (hash !== undefined && rel.endsWith(".md") && !anchors(read(rel)).has(hash)) out.push(`${page}: ${target} names no heading of ${rel}`);
  }
  return out;
}

/** The pages whose links are checked. */
const PAGES = ["README.md", "SECURITY.md", ...walk("docs").filter((p) => p.endsWith(".md"))];

/** Links from the site and the front door to a heading of a page in this repository, as [page, anchor]. */
function siteLinks(): Array<{ from: string; page: string; hash: string }> {
  const files = [...walk("packages/web/src"), "packages/web/public/llms.txt", "packages/web/public/start.md", "packages/web/index.html", "packages/core/src/connect.ts"];
  const out: Array<{ from: string; page: string; hash: string }> = [];
  for (const from of files) {
    const text = read(from).replaceAll("${REPO}", REPO);
    for (const m of text.matchAll(/https:\/\/github\.com\/roboruby\/fire_trident(?:\/blob\/main\/([^\s#`"')<>]+))?#([a-z0-9_-]+)/g)) {
      const page = m[1] ?? "README.md";
      const hash = m[2] ?? "";
      // #readme is the host's own anchor for a repository's README.
      if (m[1] === undefined && hash === "readme") continue;
      out.push({ from, page, hash });
    }
  }
  return out;
}

describe("links in the docs", () => {
  it("name files that exist and headings that exist, in the README, SECURITY.md and every page of docs/", () => {
    expect(PAGES).toEqual(expect.arrayContaining(["README.md", "docs/results.md", "docs/mechanisms.md", "docs/try-it.md", "docs/glossary.md", "docs/ARCHITECTURE.md", "docs/agents/README.md"]));
    expect(PAGES.flatMap(linkProblems)).toEqual([]);
  });

  it("from the site and the front door to a heading here name one that exists", () => {
    const links = siteLinks();
    expect(links.map((l) => `${l.page}#${l.hash}`)).toEqual(expect.arrayContaining(["docs/mechanisms.md#what-each-mechanism-buys", "docs/results.md#honest-limits"]));
    const missing = links.filter((l) => !existsSync(join(ROOT, l.page)) || !anchors(read(l.page)).has(l.hash)).map((l) => `${l.from}: ${l.page}#${l.hash}`);
    expect(missing).toEqual([]);
  });

  it("read headings as the host does, and leave out the comments of fenced code", () => {
    expect(anchor("What each mechanism buys")).toBe("what-each-mechanism-buys");
    expect(anchor("Request flow (an in-platform agent)")).toBe("request-flow-an-in-platform-agent");
    expect(anchor("Ask a showcase colony, no token")).toBe("ask-a-showcase-colony-no-token");
    expect([...anchors("## Run it\n\n```sh\n# prints intact\n```\n")]).toEqual(["run-it"]);
  });
});

/** wrangler.jsonc, read as JSON once its comments are dropped. */
function wrangler(): { vars: Record<string, string>; env: { staging: { vars: Record<string, string> } } } {
  const text = read("packages/worker/wrangler.jsonc");
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Config variables that are not flags: the public address, the models and the OAuth client ids accounts use. */
const NOT_FLAGS: ReadonlySet<string> = new Set(["FT_PUBLIC_URL", "FT_DEFAULT_MODEL", "FT_BULK_MODEL", "FT_REFLEX_MODEL", "FT_GITHUB_CLIENT_ID", "FT_CF_CLIENT_ID"]);
/** Variables that take a number or a list rather than on and off: unset when absent. */
const TUNING: ReadonlySet<string> = new Set(["FT_COCHANGE_WEIGHT", "FT_LATERAL_INHIBITION", "FT_IMPORT_WEIGHT", "FT_DEFAULT_SPEND_CAP", "FT_PUBLIC_GIT", "FT_PUBLIC_MCP"]);

/** The flag table of docs/mechanisms.md: flag, stage cell, production cell. */
function flagTable(): Map<string, { stage: string; production: string }> {
  const md = read("docs/mechanisms.md");
  const at = md.indexOf("## Flags");
  const section = md.slice(at, md.indexOf("\n## ", at + 1));
  const rows = new Map<string, { stage: string; production: string }>();
  for (const line of section.split("\n")) {
    const m = /^\| `(FT_[A-Z0-9_]+)` \| [^|]+ \| ([^|]+) \| ([^|]+) \|/.exec(line);
    if (m) rows.set(m[1] ?? "", { stage: (m[2] ?? "").trim(), production: (m[3] ?? "").trim() });
  }
  return rows;
}

/** How the table shows a config value: on, `the value`, or off (unset for a number or a list) when absent. */
function cell(name: string, value: string | undefined): string {
  if (value === undefined) return TUNING.has(name) ? "unset" : "off";
  return value === "on" ? "on" : `\`${value}\``;
}

/** The flags env.ts documents as on, or a list of colony ids. */
function documentedFlags(): string[] {
  const env = read("packages/worker/src/env.ts");
  return [...env.matchAll(/\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*(FT_[A-Z0-9_]+)\?: string;/g)]
    .filter((m) => /"on", or a comma-separated list of colony ids/.test((m[1] ?? "").replace(/\s*\*\s*/g, " ")))
    .map((m) => m[2] ?? "");
}

describe("the flags the docs list", () => {
  const config = wrangler();
  const production = config.vars;
  const stage = config.env.staging.vars;
  const on = (vars: Record<string, string>) => Object.keys(vars).filter((k) => vars[k] === "on").sort();

  it("are every flag the configs set and env.ts documents, each with its value in the stage and production configs", () => {
    const table = flagTable();
    const set = [...new Set([...Object.keys(production), ...Object.keys(stage)])].filter((k) => k.startsWith("FT_") && !NOT_FLAGS.has(k));
    expect(set.filter((k) => !table.has(k))).toEqual([]);
    const documented = documentedFlags();
    expect(documented.length).toBeGreaterThan(20);
    expect(documented.filter((k) => !table.has(k))).toEqual([]);
    const wrong = [...table].flatMap(([name, row]) => [
      ...(row.stage === cell(name, stage[name]) ? [] : [`${name} stage: ${row.stage}, config: ${cell(name, stage[name])}`]),
      ...(row.production === cell(name, production[name]) ? [] : [`${name} production: ${row.production}, config: ${cell(name, production[name])}`]),
    ]);
    expect(wrong).toEqual([]);
  });

  it("match in ARCHITECTURE.md: the production config's flags that are on, and the stage config's", () => {
    const arch = read("docs/ARCHITECTURE.md");
    const m = /The production config \(`packages\/worker\/wrangler\.jsonc`, its top-level `vars`\) turns on ([^;]+); the stage config \(`env\.staging`\) turns on the same (\d+)\./.exec(arch);
    expect(m).not.toBeNull();
    const listed = [...(m?.[1] ?? "").matchAll(/`(FT_[A-Z0-9_]+)`/g)].map((x) => x[1] ?? "").sort();
    expect(listed).toEqual(on(production));
    expect(on(stage)).toEqual(on(production));
    expect(Number(m?.[2])).toBe(on(stage).length);
  });
});
