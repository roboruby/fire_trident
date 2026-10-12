import type { Path, Rule, Violation } from "./types.ts";

/** Minimal glob matcher supporting **, *, ?, and {a,b}. */
export function globMatch(glob: string, path: Path): boolean {
  throw new Error("not implemented");
}

/** Does this rule apply to this path at all (include/exclude/from globs)? */
export function ruleApplies(rule: Rule, path: Path): boolean {
  throw new Error("not implemented");
}

/** Extract static import/require/export-from specifiers with their 1-based line numbers (TS/JS). */
export function importsOf(source: string): Array<{ specifier: string; line: number }> {
  throw new Error("not implemented");
}

/** Evaluate one rule against one file's content. */
export function checkFile(rule: Rule, path: Path, content: string): Violation[] {
  throw new Error("not implemented");
}
