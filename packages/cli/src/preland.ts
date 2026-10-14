import type { Colors } from "./format.ts";

/**
 * Tests before landing (FT_PRELAND) as `ft why` shows them, from a landed change's note (`evidence.preland`): the test
 * files that reach the change, run on its base with it before it landed, and how they went, or why they were not run.
 */

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const text = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "182ms", "2.1s". */
function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

/**
 * One line for a change's tests before landing: "✓ 2 of 2 tests passed in 1 test file on its base 1a2b3c4 (182ms)", what
 * did not pass on trunk either and the test files left to certification; "✗" and the tests that broke for a failed run;
 * "not checked: <why>" otherwise. Null when the note has none (the colony did not ask, or the note predates them).
 */
export function prelandLine(run: unknown, c: Pick<Colors, "green" | "red" | "yellow" | "dim">): string | null {
  if (!run || typeof run !== "object" || Array.isArray(run)) return null;
  const r = run as Record<string, unknown>;
  const took = c.dim(`(${ms(num(r.ms))})`);
  if (r.status === "unchecked") return `${c.yellow("not checked")}: ${text(r.reason) || "no reason recorded"} ${took}`;
  const files = Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === "string") : [];
  const on = typeof r.trunkSha === "string" && r.trunkSha.length >= 7 ? ` on its base ${r.trunkSha.slice(0, 7)}` : "";
  if (r.status === "failed") {
    const broke = (Array.isArray(r.broke) ? r.broke : []).filter((b): b is Record<string, unknown> => !!b && typeof b === "object");
    const names = broke.map((b) => `"${text(b.name)}" (${text(b.file)})${text(b.error) ? `: ${text(b.error)}` : ""}`);
    return `${c.red("✗")} ${names.length > 0 ? names.join("; ") : "a test"} passed on trunk and failed with the change${on} ${took}`;
  }
  if (r.status !== "passed") return `${text(r.status) || "unknown"} ${took}`;
  const parts = [`${c.green("✓")} ${num(r.passed)} of ${plural(num(r.tests), "test")} passed in ${plural(files.length, "test file")}${on} ${took}`];
  if (num(r.known) > 0) parts.push(`${plural(num(r.known), "failing test")} did not pass on trunk either`);
  if (num(r.reached) > files.length) parts.push(`${plural(num(r.reached) - files.length, "more test file")} left to certification`);
  if (text(r.reason)) parts.push(text(r.reason));
  return parts.join(c.dim("; "));
}
