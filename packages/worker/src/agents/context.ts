import { checkFile, importsOf } from "@fire_trident/core";
import type { Path, Rule } from "@fire_trident/core";

/**
 * Read context for import rules: what the trunk tree holds next to each flagged
 * specifier, and the minimal edit protocol a model answers with (rewrite only
 * the flagged specifiers, never the rest of the file).
 *
 * The model sees the sibling paths from the base commit's tree, so it never has
 * to guess whether `./x` is a file or a directory. Its answer is a list of
 * specifier rewrites that the agent applies itself, which keeps formatting and
 * every other byte of the file intact.
 */

/** Extensions a TypeScript-style resolver tries, in order. */
const RESOLVE_EXTS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
/** Directories listed in one prompt at most, and entries per directory. */
const MAX_DIRS = 10;
const MAX_ENTRIES = 80;

/** The file and directory names of one commit's tree, for "what is here" questions. */
export class TreeIndex {
  readonly files: Set<Path>;
  private readonly children = new Map<Path, Set<string>>();

  constructor(paths: Iterable<Path>) {
    this.files = new Set(paths);
    for (const p of this.files) {
      const parts = p.split("/");
      for (let i = 0; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        const name = i === parts.length - 1 ? parts[i]! : `${parts[i]}/`;
        let set = this.children.get(dir);
        if (!set) {
          set = new Set();
          this.children.set(dir, set);
        }
        set.add(name);
      }
    }
  }

  /** Is `p` a file in the tree? */
  isFile(p: Path): boolean {
    return this.files.has(p);
  }

  /** Is `p` a directory in the tree ("" is the root)? */
  isDir(p: Path): boolean {
    return this.children.has(p);
  }

  /** Entries of a directory, sorted: files by name, subdirectories with a trailing "/". */
  list(dir: Path): string[] {
    return [...(this.children.get(dir) ?? [])].sort();
  }
}

/** Directory part of a repository path ("" for a top-level file). */
export function dirOf(path: Path): Path {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * The repository path a relative specifier ("./x", "../y/z", ".", "..") points at
 * from `fromFile`, normalized. Null when the specifier is not relative or climbs
 * above the repository root.
 */
export function resolveRelative(fromFile: Path, specifier: string): Path | null {
  if (!(specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../"))) return null;
  const parts = dirOf(fromFile).split("/").filter(Boolean);
  for (const seg of specifier.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

/** Express repository path `to` as a relative specifier from the directory of `fromFile`. */
export function relativeSpecifier(fromFile: Path, to: Path): string {
  const from = dirOf(fromFile).split("/").filter(Boolean);
  const target = to.split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < target.length - 1 && from[common] === target[common]) common++;
  const up = from.length - common;
  const rest = target.slice(common).join("/");
  return up === 0 ? `./${rest}` : `${"../".repeat(up)}${rest}`;
}

/** Files a resolver could reach from `target`: the path itself, the path plus an extension, or its index file. */
export function candidateFiles(target: Path, tree: TreeIndex): Path[] {
  const out: Path[] = [];
  if (target !== "" && tree.isFile(target)) out.push(target);
  for (const ext of RESOLVE_EXTS) if (target !== "" && tree.isFile(target + ext)) out.push(target + ext);
  const base = target === "" ? "index" : `${target}/index`;
  for (const ext of RESOLVE_EXTS) if (tree.isFile(base + ext)) out.push(base + ext);
  return out;
}

/** One flagged import specifier and what the trunk tree holds for it. */
export interface SpecifierFact {
  line: number;
  specifier: string;
  /** Repository path the specifier points at (null when not relative). */
  target: Path | null;
  /** True when `target` is a directory in the tree. */
  directory: boolean;
  /** Existing files the specifier can resolve to, as specifiers relative to the importing file (best first). */
  candidates: string[];
  /**
   * What the first candidate is: a plain file, the index file of a directory, or a file that
   * wins over a same-named directory beside it (null when nothing matches).
   */
  resolution: "file" | "index" | "file-beside-directory" | null;
}

function moduleRegex(rule: Rule): RegExp {
  const flags = typeof rule.spec.flags === "string" ? rule.spec.flags.replace(/[gy]/g, "") : "";
  return new RegExp(String(rule.spec.module), flags);
}

/** Does this rule judge import specifiers (and so suit the specifier edit protocol)? */
export function isImportRule(rule: Rule | null | undefined): rule is Rule {
  return !!rule && rule.kind === "forbid-import" && typeof rule.spec?.module === "string";
}

/** Every import specifier of `content` that violates the import rule, with the tree's answer for each. */
export function specifierFacts(rule: Rule, path: Path, content: string, tree: TreeIndex): SpecifierFact[] {
  if (checkFile(rule, path, content).length === 0) return [];
  const re = moduleRegex(rule);
  return importsOf(content)
    .filter((imp) => re.test(imp.specifier))
    .map((imp) => {
      const target = resolveRelative(path, imp.specifier);
      const directory = target !== null && tree.isDir(target);
      const files = target === null ? [] : candidateFiles(target, tree);
      const first = files[0];
      const resolution: SpecifierFact["resolution"] =
        first === undefined ? null : first.startsWith(target === "" ? "index." : `${target}/`) ? "index" : directory ? "file-beside-directory" : "file";
      return { line: imp.line, specifier: imp.specifier, target, directory, candidates: files.map((f) => relativeSpecifier(path, f)), resolution };
    });
}

/** The directories worth listing for these facts: the file's own, each target's parent, and each target directory. */
export function contextDirs(path: Path, facts: SpecifierFact[], tree: TreeIndex): Path[] {
  const dirs: Path[] = [];
  const add = (d: Path): void => {
    if (!dirs.includes(d) && tree.isDir(d) && dirs.length < MAX_DIRS) dirs.push(d);
  };
  add(dirOf(path));
  for (const f of facts) {
    if (f.target === null) continue;
    if (f.directory) add(f.target);
    add(dirOf(f.target));
  }
  return dirs;
}

/** A directory listing line for the prompt: `src/jsx/: base.ts dom/ index.ts ...`. */
export function listingLine(dir: Path, tree: TreeIndex): string {
  const entries = tree.list(dir);
  const shown = entries.slice(0, MAX_ENTRIES).join(" ");
  const more = entries.length > MAX_ENTRIES ? ` (and ${entries.length - MAX_ENTRIES} more)` : "";
  return `${dir === "" ? "(root)" : `${dir}/`}: ${shown}${more}`;
}

/** One rewrite the model asked for: on `line`, specifier `from` becomes `to`. */
export interface SpecifierEdit {
  line: number;
  from: string;
  to: string;
}

const THINK = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
const EDIT_LINE = /^\s*(?:[-*]\s*)?(?:line\s*)?(\d+)\s*[:.)]\s*(.*?)\s*=>\s*(.*?)\s*$/i;

function unquote(s: string): string {
  const t = s.trim();
  const m = /^(['"`])(.*)\1$/.exec(t);
  return m ? m[2]! : t;
}

/** Parse an `<edits>` block. Null (with the reason) when the reply has none. */
export function parseSpecifierEdits(reply: string): { ok: true; edits: SpecifierEdit[] } | { ok: false; reason: string } {
  const text = reply.replace(THINK, "");
  const start = text.lastIndexOf("<edits>");
  const end = text.lastIndexOf("</edits>");
  if (start === -1 || end === -1 || end < start) return { ok: false, reason: "the reply has no <edits>...</edits> block" };
  const edits: SpecifierEdit[] = [];
  for (const raw of text.slice(start + 7, end).split(/\r?\n/)) {
    if (raw.trim() === "" || /^\s*(?:`{3,}|~{3,})/.test(raw)) continue;
    const m = EDIT_LINE.exec(raw);
    if (!m) return { ok: false, reason: `this line in <edits> is not "<line>: <old specifier> => <new specifier>": ${raw.trim().slice(0, 120)}` };
    edits.push({ line: Number(m[1]), from: unquote(m[2]!), to: unquote(m[3]!) });
  }
  if (edits.length === 0) return { ok: false, reason: "the <edits> block is empty" };
  return { ok: true, edits };
}

/** Result of applying specifier edits to a file. */
export interface AppliedEdits {
  content: string;
  /** What went wrong, phrased as feedback for the model; empty when the file is fixed. */
  problems: string[];
  /** Specifiers rewritten. */
  changed: number;
  /** The rewrites made; `directory` marks a specifier that named a directory (now its index file). */
  rewrites: Array<{ line: number; from: string; to: string; directory: boolean; besideDirectory: boolean }>;
}

/**
 * Apply the model's specifier rewrites to `content`, touching only the quoted
 * specifier text on flagged lines (every other byte stays as it was). Then
 * check the result: each new relative specifier must name an existing file, and
 * the rule must report no violation left.
 */
export function applySpecifierEdits(rule: Rule, path: Path, content: string, facts: SpecifierFact[], edits: SpecifierEdit[], tree: TreeIndex): AppliedEdits {
  const parts = content.split(/(\r\n|\r|\n)/);
  const problems: string[] = [];
  const used = new Set<SpecifierFact>();
  let changed = 0;
  const rewrites: AppliedEdits["rewrites"] = [];
  for (const e of edits) {
    const onLine = facts.filter((f) => f.line === e.line && !used.has(f));
    const fact = onLine.find((f) => f.specifier === e.from) ?? (onLine.length === 1 ? onLine[0] : undefined);
    if (!fact) {
      problems.push(`line ${e.line} has no flagged specifier ${JSON.stringify(e.from)}; edit only the flagged specifiers`);
      continue;
    }
    used.add(fact);
    if (e.to === fact.specifier) continue;
    if (e.to === "" || /["'`\r\n\\]/.test(e.to)) {
      problems.push(`line ${e.line}: ${JSON.stringify(e.to)} is not a valid specifier`);
      continue;
    }
    if (fact.target !== null) {
      const resolved = resolveRelative(path, e.to);
      if (resolved === null || !tree.isFile(resolved)) {
        const hint = fact.candidates.length > 0 ? ` (existing: ${fact.candidates.map((c) => JSON.stringify(c)).join(", ")})` : "";
        problems.push(`line ${e.line}: ${JSON.stringify(e.to)} names no file in the trunk tree${hint}`);
        continue;
      }
    }
    const idx = (fact.line - 1) * 2;
    const text = parts[idx];
    if (text === undefined) {
      problems.push(`line ${e.line} does not exist`);
      continue;
    }
    let replaced = false;
    for (const q of ["'", '"', "`"]) {
      const needle = `${q}${fact.specifier}${q}`;
      const at = text.indexOf(needle);
      if (at === -1) continue;
      parts[idx] = `${text.slice(0, at)}${q}${e.to}${q}${text.slice(at + needle.length)}`;
      replaced = true;
      break;
    }
    if (!replaced) {
      problems.push(`line ${e.line}: the specifier ${JSON.stringify(fact.specifier)} is not written literally on that line`);
      continue;
    }
    changed++;
    rewrites.push({ line: fact.line, from: fact.specifier, to: e.to, directory: fact.resolution === "index", besideDirectory: fact.resolution === "file-beside-directory" });
  }
  const updated = parts.join("");
  const left = checkFile(rule, path, updated);
  if (left.length > 0) {
    const remaining = specifierFacts(rule, path, updated, tree);
    const shown = remaining.slice(0, 20).map((f) => `line ${f.line}: ${JSON.stringify(f.specifier)}`);
    problems.push(`these specifiers still violate the rule: ${shown.join("; ")}${remaining.length > 20 ? `; and ${remaining.length - 20} more` : ""}`);
  }
  return { content: updated, problems, changed, rewrites };
}
