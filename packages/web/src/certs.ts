import { fmtInt, shortSha } from "./format.ts";
import type { CertView } from "./store.ts";

/** Trunk certification as the UI words it (the trunk bar, the Why tab, the event log). */

/** Tests that did not run: "2 skipped · 1 todo", or "" when every test ran. */
export function certNotRun(c: Pick<CertView, "counts">): string {
  const k = c.counts;
  if (!k) return "";
  return [k.skipped > 0 ? `${fmtInt(k.skipped)} skipped` : "", k.todo > 0 ? `${fmtInt(k.todo)} todo` : ""].filter(Boolean).join(" · ");
}

/**
 * "60/60 tests", "58/60 tests · 2 skipped" or "5 failing" (skipped and todo tests named whenever
 * there are any). `verb` follows a passing count: "58/60 tests pass · 2 skipped".
 */
export function certCounts(c: Pick<CertView, "counts">, verb = ""): string {
  const k = c.counts;
  if (!k) return "";
  const bad = k.fail + k.cancelled;
  const head = bad === 0 ? `${fmtInt(k.pass)}/${fmtInt(k.tests)} tests${verb ? ` ${verb}` : ""}` : `${fmtInt(bad)} failing`;
  const notRun = certNotRun(c);
  return notRun ? `${head} · ${notRun}` : head;
}

/** The hover text of a certification: what ran and, when red, which tests failed and why. */
export function certTitle(c: CertView): string {
  const k = c.counts;
  const took = typeof c.durationMs === "number" ? `, ${(c.durationMs / 1000).toFixed(1)} s` : "";
  const reused = c.reusedFrom ? `\nSame tested files as ${shortSha(c.reusedFrom)}: its result holds.` : "";
  const notRun = certNotRun(c);
  if (c.status === "running") return `Running the project's own tests on ${shortSha(c.trunkSha)}…`;
  if (c.status === "error") return `The tests could not run on ${shortSha(c.trunkSha)}: ${c.detail ?? "unknown error"}`;
  if (c.status === "skipped") return c.detail ?? "Nothing to certify";
  if (c.status === "green") {
    const passed = notRun ? `${fmtInt(k?.pass ?? 0)} of ${fmtInt(k?.tests ?? 0)} tests pass, ${notRun}` : `all ${fmtInt(k?.pass ?? 0)} tests pass`;
    return `${shortSha(c.trunkSha)}: ${passed} (node:test in a Dynamic Worker${took})${reused}`;
  }
  const lines = (c.failing ?? []).slice(0, 10).map((f) => `• ${f.name}${f.error ? `: ${f.error}` : ""}`);
  const more = k ? k.fail + k.cancelled - lines.length : 0;
  return `${shortSha(c.trunkSha)}: ${fmtInt(k ? k.fail + k.cancelled : lines.length)} of ${fmtInt(k?.tests ?? 0)} tests failing${notRun ? ` (${notRun})` : ""}${took}\n${lines.join("\n")}${more > 0 ? `\n… and ${more} more` : ""}${reused}`;
}
