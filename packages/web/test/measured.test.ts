import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every number the README and docs/results.md quote as a measurement is in a committed results file.
 *
 * The rule, as the docs follow it:
 * - A page is read in units: a table row, a list item or a paragraph. A unit that links a results source (a folder or
 *   file under packages/bench/results, or spike/RESULTS.md) quotes measurements, and every number in it must appear in
 *   one of the files it links (a folder means every file under it). A number matches when a number in the file rounds to
 *   it at its shown precision ("62" matches 61.8 and "$0.065" matches 0.0652), commas aside ("1,821" matches 1821); a
 *   percentage also matches the fraction ("45%" matches 0.45), and seconds the milliseconds ("9.6 s" matches 9622). A
 *   table's header row may link the source for every row under it.
 * - A section that starts with `<!-- measured -->` (up to the next heading) holds only measurements: each of its units
 *   that has a number must link its source, or say "no log committed" (the reader is told the number has no committed log)
 *   or "computed from" (a difference or ratio of the numbers it names, which the reader can redo). In a unit that does link
 *   a source, only the clause saying so is left unchecked (a clause ends at a semicolon, a table cell or a sentence).
 * - These are not measurements and are never checked: anything in code (spans and fenced blocks, so the agent counts and
 *   flags of a command), link targets, dates and times, version numbers, issue numbers, line numbers ("lines 2 and 11"),
 *   and numbers that are part of a name (SHA-256, Ed25519, p50, R3, round 7, Gemma 4, Node 24, gpt-oss-120b, a commit
 *   id). A number outside a measured section in a unit that links no source is not checked either: design constants ("up
 *   to 200 changes a cycle") and prerequisites are not measurements.
 *
 * The check is that the number is in the file, not that it means what the sentence says: it catches a figure that
 * drifted from its run or was never in it, and a reader still follows the link to see what was measured.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The pages checked, repository-relative. */
const PAGES = ["README.md", "docs/results.md"] as const;

/** The marker that opens a section of measurements. */
const MEASURED = "<!-- measured -->";

/** The words that mark a number with no committed log, or one computed from others. */
const UNSOURCED = /no log committed|computed from/i;

/** One block of a page. */
interface Unit {
  /** 1-based line the unit starts on. */
  line: number;
  text: string;
  /** Whether it sits in a measured section. */
  measured: boolean;
  /** For a table row, its table's header row, whose links name sources for the whole table. */
  header?: string;
}

/** A page's units: table rows (headers and separators left out), list items and paragraphs, outside fenced code and headings. */
function units(md: string): Unit[] {
  const lines = md.split("\n");
  const out: Unit[] = [];
  let fence = false;
  let measured = false;
  let cur: Unit | null = null;
  let header: string | undefined;
  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  const separator = (l: string | undefined) => l !== undefined && /^\|[\s|:-]+\|\s*$/.test(l);
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      flush();
      fence = !fence;
      return;
    }
    if (fence) return;
    if (/^#{1,6}\s/.test(line)) {
      flush();
      measured = false;
      return;
    }
    if (line.trim() === MEASURED) {
      flush();
      measured = true;
      return;
    }
    if (line.trim() === "" || /^<!--.*-->$/.test(line.trim())) {
      flush();
      return;
    }
    if (line.startsWith("|")) {
      flush();
      if (separator(lines[i + 1])) header = line;
      else if (!separator(line)) out.push({ line: i + 1, text: line, measured, ...(header === undefined ? {} : { header }) });
      return;
    }
    header = undefined;
    if (/^[-*] /.test(line)) {
      flush();
      cur = { line: i + 1, text: line, measured };
      return;
    }
    if (cur) cur.text += ` ${line.trim()}`;
    else cur = { line: i + 1, text: line, measured };
  });
  flush();
  return out;
}

/** Numbers that are part of a name, a date, a time, a version or an issue: removed before numbers are read. */
const NOT_MEASUREMENTS: readonly RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  /\bv?\d+\.\d+\.\d+\b/g,
  /#\d+/g,
  /\blines? \d+(?: and \d+)?\b/g,
  /\b(?:Gemma|GLM|Node|Sonnet|Opus|Kimi K|Fig\.|[Rr]ound|[Rr]ounds)[ -]?\d+(?:\.\d+)?(?:\s(?:to|and)\s\d+(?:\.\d+)?)?/g,
  /\b[A-Za-z_]+[-_]?\d+(?:[.-]\d+)*[A-Za-z_]*\b/g,
  /\b\d+[A-Za-z_]\w*\b/g,
];

/** What a unit says: its link targets, and its text split into clauses with code, comments and link targets removed. */
function read(unit: string): { targets: string[]; clauses: string[] } {
  const targets: string[] = [];
  let text = unit.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/\[((?:[^[\]]|\[[^\]]*\])*)\]\(([^)\s]+)\)/g, (_m, label: string, target: string) => {
    targets.push(target);
    return label;
  });
  text = text.replace(/`[^`]*`/g, " ").replace(/\bhttps?:\/\/\S+/g, " ");
  for (const r of NOT_MEASUREMENTS) text = text.replace(r, " ");
  const clauses = text.split(/;|\s\|\s|^\||\|$|(?<=[.!?])\s+(?=[A-Z(])/).filter((c) => c.trim() !== "");
  return { targets, clauses };
}

/** A number as a unit shows it, without its commas, and whether a percent sign or seconds follow. */
interface Shown {
  value: string;
  percent: boolean;
  seconds?: boolean;
}

/** The numbers in a clause. */
function numbersIn(clause: string): Shown[] {
  return [...clause.matchAll(/(?<![\d.])\d[\d,]*(?:\.\d+)?/g)].map((m) => {
    const value = m[0].replace(/,+$/, "").replaceAll(",", "");
    const after = clause.slice((m.index ?? 0) + m[0].length);
    return /^\s?s\b/.test(after) ? { value, percent: false, seconds: true } : { value, percent: /^\s?%/.test(after) };
  });
}

/** Decimal places of a number as shown. */
function places(value: string): number {
  return value.includes(".") ? (value.split(".")[1]?.length ?? 0) : 0;
}

/** A results file's or folder's numbers, rounded on demand to the precision a page shows, plain, as percentages or as seconds. */
class Source {
  private readonly values: number[];
  private readonly rounded = new Map<string, Set<string>>();

  constructor(readonly path: string, text: string) {
    const tokens = new Set([...text.matchAll(/\d[\d,]*(?:\.\d+)?(?:e[-+]?\d+)?/gi)].map((m) => m[0].replace(/,+$/, "").replaceAll(",", "")));
    this.values = [...tokens].map(Number).filter((n) => Number.isFinite(n));
  }

  /** The source's numbers at `d` places, scaled (100 for a percentage, 1/1000 for milliseconds read as seconds). */
  private at(d: number, scale: number): Set<string> {
    const key = `${d}:${scale}`;
    let set = this.rounded.get(key);
    if (set) return set;
    set = new Set();
    const f = 10 ** d;
    for (const v of this.values) {
      const n = v * scale;
      set.add(n.toFixed(d));
      // Rounding half away from zero too, as the files' writers round (toFixed reads 0.125 as 0.12).
      set.add((Math.round(n * f + 1e-9) / f).toFixed(d));
    }
    this.rounded.set(key, set);
    return set;
  }

  /** Whether a number in this source rounds to the shown one. */
  holds(n: Shown): boolean {
    const d = Math.min(places(n.value), 6);
    const v = Number(n.value).toFixed(d);
    return this.at(d, 1).has(v) || (n.percent && this.at(d, 100).has(v)) || (n.seconds === true && this.at(d, 1 / 1000).has(v));
  }
}

/** Every file under a folder, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const sources = new Map<string, Source | null>();

/** The results source a link target names, read once; null when it names none (another page, a site, a script). */
function source(page: string, target: string): Source | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return null;
  const abs = resolve(ROOT, dirname(page), target.split("#")[0] ?? "");
  const rel = relative(ROOT, abs);
  if (!rel.startsWith("packages/bench/results/") && rel !== "packages/bench/results" && !rel.startsWith("spike/")) return null;
  if (sources.has(rel)) return sources.get(rel) ?? null;
  let found: Source | null = null;
  if (existsSync(abs)) {
    const files = statSync(abs).isDirectory() ? walk(abs) : [abs];
    found = new Source(rel, files.map((f) => readFileSync(f, "utf8")).join("\n"));
  }
  sources.set(rel, found);
  return found;
}

/** Whether a link target points under the results or spike folders, whether or not it exists. */
function namesResults(page: string, target: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return false;
  const rel = relative(ROOT, resolve(ROOT, dirname(page), target.split("#")[0] ?? ""));
  return rel.startsWith("packages/bench/results") || rel.startsWith("spike/");
}

/** What is wrong with a page's measurements: a number not in its sources, a measurement with no source, a missing source. */
function problems(page: string, md: string): string[] {
  const out: string[] = [];
  for (const u of units(md)) {
    const { targets: own, clauses } = read(u.text);
    const targets = [...own, ...(u.header === undefined ? [] : read(u.header).targets)];
    const named = targets.filter((t) => namesResults(page, t));
    const linked = named.map((t) => source(page, t));
    for (const [i, s] of linked.entries()) if (s === null) out.push(`${page}:${u.line}: ${named[i]} is not in the repository`);
    const found = linked.filter((s): s is Source => s !== null);
    if (named.length === 0) {
      if (!u.measured || UNSOURCED.test(u.text)) continue;
      const nums = clauses.flatMap(numbersIn);
      if (nums.length > 0) out.push(`${page}:${u.line}: ${nums.map((n) => n.value).join(", ")} measured with no results linked (link the run, or say "no log committed")`);
      continue;
    }
    if (found.length === 0) continue;
    for (const c of clauses) {
      if (UNSOURCED.test(c)) continue;
      for (const n of numbersIn(c)) {
        if (!found.some((s) => s.holds(n))) out.push(`${page}:${u.line}: ${n.value}${n.percent ? "%" : ""} is in none of ${found.map((s) => s.path).join(", ")}`);
      }
    }
  }
  return out;
}

const text = (page: string) => readFileSync(join(ROOT, page), "utf8");

describe("the numbers the README and docs/results.md quote as measurements", () => {
  it("are each in a committed results file the same row, item or paragraph links", () => {
    expect(PAGES.flatMap((p) => problems(p, text(p)))).toEqual([]);
  }, 60_000);

  it("are quoted in measured sections, each linked to its run: the README's headline among them", () => {
    for (const p of PAGES) {
      const measured = units(text(p)).filter((u) => u.measured);
      expect(measured.length, p).toBeGreaterThan(0);
      expect(measured.filter((u) => read(u.text).targets.some((t) => namesResults(p, t))).length, p).toBeGreaterThan(0);
    }
    const readme = text("README.md");
    const headline = readme.indexOf("<!-- headline: replaced by the contended benchmark -->");
    expect(headline).toBeGreaterThan(0);
    expect(readme.indexOf(MEASURED, headline)).toBeGreaterThan(headline);
  });
});

describe("the check itself", () => {
  const page = "docs/sample.md";
  const results = "../packages/bench/results/2026-10-17-contention-8-16-solo/README.md";

  it("finds a number in its source at the shown precision, with or without commas", () => {
    const md = `${MEASURED}\nHidden tests passed for 12 and 11 of 16 intents, at $0.37 and $0.33 ([results](${results})).\n`;
    expect(problems(page, md)).toEqual([]);
  });

  it("catches a number its source does not hold, and a measurement with no source", () => {
    const md = `${MEASURED}\nHidden tests passed for 4.25 of 16 intents ([results](${results})).\n\n958 violations went to 0 in 61.3 s.\n`;
    expect(problems(page, md)).toEqual([
      `${page}:2: 4.25 is in none of packages/bench/results/2026-10-17-contention-8-16-solo/README.md`,
      `${page}:4: 958, 0, 61.3 measured with no results linked (link the run, or say "no log committed")`,
    ]);
  });

  it("leaves out code, dates, versions and names, and the clause that says it has no committed log", () => {
    const md = `${MEASURED}\nOn 2026-10-17, \`ft swarm x --agents 99\` with Gemma 4 and Claude Code 2.1.299 (p50, SHA-256, round 7): 14 of 16 landed; 77 more later (no log committed) ([results](${results})).\n`;
    expect(problems(page, md)).toEqual([]);
    expect(problems(page, `${MEASURED}\nThe call answered in 0.65 s on a preview (no log committed).\n`)).toEqual([]);
  });

  it("reads a percentage as its fraction and seconds as milliseconds, and checks nothing outside a measured section without a source", () => {
    expect(numbersIn("45% of agent work")).toEqual([{ value: "45", percent: true }]);
    expect(numbersIn("time to land 9.6 s")).toEqual([{ value: "9.6", percent: false, seconds: true }]);
    expect(problems(page, "A cycle takes up to 200 changes.\n")).toEqual([]);
    expect(problems(page, `| Run | Result |\n| --- | --- |\n| 1 agent | 6 of 16 ([results](${results})) |\n`)).toEqual([]);
    expect(problems(page, `${MEASURED}\n| Run ([results](${results})) | Result |\n| --- | --- |\n| 1 agent | 6 of 16 |\n| 8 agents | 4.25 of 16 |\n`)).toEqual([
      `${page}:5: 4.25 is in none of packages/bench/results/2026-10-17-contention-8-16-solo/README.md`,
    ]);
  });

  it("names a results link that is not in the repository", () => {
    expect(problems(page, "See [it](../packages/bench/results/1999-01-01/).\n")).toEqual([`${page}:1: ../packages/bench/results/1999-01-01/ is not in the repository`]);
  });
});
