import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import script from "../src/director/script.json";
import { ROUTED_LABEL, routedLine } from "../src/vaccineRouting.ts";

/**
 * Copy a judge reads cannot drift back to claims the README has retracted. Every UI string under packages/web/src, the
 * static page, start.md, llms.txt, the Worker's front door, the README, SECURITY.md and docs/ are scanned for each
 * retracted phrase; and no tracked file's path or text holds the word the code replaced with "assumption" (what a
 * change assumed about the files it read).
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Each retracted phrase, and why it is wrong. */
const RETRACTED: ReadonlyArray<{ phrase: RegExp; why: string }> = [
  { phrase: /exact delta/i, why: "a stale change goes back naming the landing that beat it and quoting that landing's diff, not an exact delta" },
  { phrase: /the only entry/i, why: "FireTrident claims no uniqueness among entries; it states what it combines" },
  { phrase: /not a lock or a gate/i, why: "a retired uniqueness claim; the copy names the combination instead" },
  { phrase: /not a lock, a queue or a gate/i, why: "a retired uniqueness claim; the copy names the combination instead" },
  { phrase: /built with itself/i, why: "FireTrident's own repository does not land through a colony" },
  { phrase: /vaccine recall/i, why: "the vaccination meter measures routing: returned and sent to a person together" },
];

/** Every file under a directory, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** The copy a judge reads, as repository-relative paths. */
const COPY: readonly string[] = [
  ...walk(join(ROOT, "packages/web/src")),
  ...walk(join(ROOT, "packages/worker/src/front")),
  ...walk(join(ROOT, "docs")),
  join(ROOT, "packages/web/index.html"),
  join(ROOT, "packages/web/public/start.md"),
  join(ROOT, "packages/web/public/llms.txt"),
  join(ROOT, "README.md"),
  join(ROOT, "SECURITY.md"),
].map((p) => p.slice(ROOT.length));

/** The word nothing in the repository may hold, built so this file does not hold it either. */
const BANNED = new RegExp(["pre", "mis"].join(""), "i");

describe("retracted claims", () => {
  it("scan the UI strings, start.md, llms.txt, the front door, the README and the docs", () => {
    for (const p of ["packages/web/src/director/script.json", "packages/web/src/landing/questions.ts", "packages/web/public/start.md", "packages/web/public/llms.txt", "packages/worker/src/front/door.ts", "README.md"]) {
      expect(COPY, p).toContain(p);
    }
  });

  it("appear nowhere in that copy", () => {
    const found: string[] = [];
    for (const path of COPY) {
      const text = readFileSync(join(ROOT, path), "utf8");
      for (const r of RETRACTED) if (r.phrase.test(text)) found.push(`${path}: "${r.phrase.source}" (${r.why})`);
    }
    expect(found).toEqual([]);
  });

  it("are each caught when present", () => {
    for (const r of RETRACTED) expect(r.phrase.test(`A sentence with ${r.phrase.source.replaceAll("\\", "")} in it.`), r.phrase.source).toBe(true);
  });
});

describe("the word the code calls an assumption", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((p) => p !== "");

  it("is in no tracked file's path", () => {
    expect(tracked.length).toBeGreaterThan(100);
    expect(tracked.filter((p) => BANNED.test(p))).toEqual([]);
  });

  it("is in no tracked file's text", () => {
    const hits = tracked.filter((p) => {
      const path = join(ROOT, p);
      return existsSync(path) && statSync(path).isFile() && BANNED.test(readFileSync(path, "utf8"));
    });
    expect(hits).toEqual([]);
  });
});

describe("the captions and the meter say what is measured", () => {
  const scene = (id: string) => script.scenes.find((s) => s.id === id);

  it("a stale read goes back quoting the diff of the landing that beat it", () => {
    expect(scene("land")?.sub).toContain("A stale read goes back quoting the diff of the landing that beat it.");
  });

  it("the vaccination scene says routed, with returned and sent to a person apart", () => {
    expect(scene("vaccine")?.sub).toContain("{routedLine}");
    expect(`${scene("vaccine")?.caption} ${scene("vaccine")?.sub}`).not.toMatch(/recall/i);
    expect(ROUTED_LABEL).toBe("Vaccine routing");
    const v = { recall: 1, seeded: 28, caught: 28, escalated: 21, returned: 7, low: 0.879, high: 1, antibodies: null, hits: null };
    expect(routedLine(v)).toBe("28 of 28 routed away from landing: 7 returned by a model or a check, 21 sent to a person");
    expect(routedLine({ ...v, escalated: null, returned: null })).toBe("28 of 28 routed away from landing");
    expect(routedLine({ ...v, seeded: null, caught: null, escalated: null, returned: null })).toBe("100% routed away from landing");
    expect(routedLine({ ...v, recall: null, seeded: 0, caught: 0, escalated: null, returned: null })).toBe("no seeded change judged yet");
    expect(routedLine(null)).toBe("no seeded change judged yet");
  });
});

describe("the retry contract", () => {
  const contract = "you get the original proposal back as it stands now, even if it";

  it("reads the same in start.md, llms.txt, the agent docs and the propose tool's description", () => {
    for (const p of ["packages/web/public/start.md", "packages/web/public/llms.txt", "docs/agents/README.md", "packages/worker/src/mcp/replay.ts"]) {
      expect(readFileSync(join(ROOT, p), "utf8"), p).toContain(contract);
    }
    // Both registrations of propose (with and without inline changes) end their description with it.
    const server = readFileSync(join(ROOT, "packages/worker/src/mcp/FireTridentMcp.ts"), "utf8");
    expect(server.match(/reviewers see it\. \$\{PROPOSE_RETRY\}`/g)).toHaveLength(2);
  });
});
