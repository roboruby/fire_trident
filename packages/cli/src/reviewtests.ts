import type { Proposal, ReviewTestFailing, ReviewTestOnTrunk, ReviewTestsRun } from "@fire_trident/core";
import type { Colors } from "./format.ts";
import { visible } from "./review.ts";

/**
 * Tests before approval as `ft review` leads each escalated change with them (worker certify/reviewtests.ts): the colony's
 * tests run on the change at its base while it waits for a person, how many passed, the failing tests with the first line
 * of each error and how each did on trunk, or why they did not run. The server writes the lead sentence; everything is
 * read defensively, and repository text (test names, errors, paths) is printed as text.
 */

const ON_TRUNK: Record<ReviewTestOnTrunk, string> = {
  passes: "passes on trunk",
  fails: "fails on trunk too",
  new: "new with this change",
  unfinished: "did not finish within the run",
  unknown: "no result on trunk to compare with",
};

const text = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const STATUSES: ReadonlySet<string> = new Set(["queued", "running", "ran", "notrun"]);

/** The run a review queue item carries (the queue's `reviewTests`, else the one its evidence records), checked field by field; null when none. */
export function reviewTestsOf(item: Proposal): ReviewTestsRun | null {
  const raw = (item as Proposal & { reviewTests?: unknown }).reviewTests ?? item.evidence?.reviewTests;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.status !== "string" || !STATUSES.has(r.status)) return null;
  const failing = (Array.isArray(r.failing) ? r.failing : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object" && typeof (f as Record<string, unknown>).name === "string")
    .map((f): ReviewTestFailing => {
      const on = typeof f.onTrunk === "string" && f.onTrunk in ON_TRUNK ? (f.onTrunk as ReviewTestOnTrunk) : "unknown";
      return { file: text(f.file), name: text(f.name), ...(text(f.error) ? { error: text(f.error) } : {}), onTrunk: on };
    });
  const trunk = r.trunk && typeof r.trunk === "object" && !Array.isArray(r.trunk) ? (r.trunk as Record<string, unknown>) : null;
  const counted = r.onTrunk && typeof r.onTrunk === "object" && !Array.isArray(r.onTrunk) ? (r.onTrunk as Record<string, unknown>) : {};
  const onTrunk = Object.fromEntries(Object.keys(ON_TRUNK).flatMap((k) => (num(counted[k]) > 0 ? [[k, num(counted[k])]] : [])));
  return {
    id: text(r.id),
    status: r.status as ReviewTestsRun["status"],
    by: text(r.by),
    at: num(r.at),
    ...(text(r.baseSha) ? { baseSha: text(r.baseSha) } : {}),
    tests: num(r.tests),
    passed: num(r.passed),
    failed: num(r.failed),
    ...(num(r.skipped) > 0 ? { skipped: num(r.skipped) } : {}),
    ...(num(r.todo) > 0 ? { todo: num(r.todo) } : {}),
    ...(failing.length > 0 ? { failing } : {}),
    ...(Object.keys(onTrunk).length > 0 ? { onTrunk } : {}),
    ...(trunk && (trunk.status === "green" || trunk.status === "red") ? { trunk: { sha: text(trunk.sha), status: trunk.status, tests: num(trunk.tests), passed: num(trunk.passed), failing: num(trunk.failing) } } : {}),
    ...(text(r.reason) ? { reason: text(r.reason) } : {}),
    ...(text(r.text) ? { text: text(r.text) } : {}),
  };
}

/** The lead sentence: the server's, or one built from the counts when it sent none. */
function lead(r: ReviewTestsRun): string {
  if (r.text) return r.text;
  if (r.status === "queued") return "Tests on this change: waiting to run.";
  if (r.status === "running") return "Tests on this change: running on its base.";
  if (r.status === "notrun") return `Tests on this change: not run: ${r.reason ?? "no reason was recorded"}.`;
  return `Tests on this change: ${r.passed ?? 0}/${r.tests ?? 0} passed${(r.failed ?? 0) > 0 ? `, ${r.failed} failed` : ""}.`;
}

/**
 * The lines that lead one review queue item: the result in a sentence (red when a test failed, green when all passed,
 * yellow otherwise), each listed failing test with how it did on trunk and its error's first line, the base's own
 * certification, and how to run them again. None when the item carries no run (an older server).
 */
export function reviewTestsLines(item: Proposal, c: Pick<Colors, "red" | "green" | "yellow" | "dim" | "bold">, colony: string): string[] {
  const r = reviewTestsOf(item);
  if (!r) return [];
  const failed = Math.max(r.failed ?? 0, r.failing?.length ?? 0);
  const color = r.status === "ran" ? (failed > 0 ? c.red : c.green) : c.yellow;
  const out = [`  ${c.dim("tests   ")} ${color(visible(lead(r)))}`];
  for (const f of r.failing ?? []) {
    const mark = f.onTrunk === "passes" ? c.red(ON_TRUNK.passes) : c.dim(ON_TRUNK[f.onTrunk]);
    out.push(`           ${c.red("✗")} "${visible(f.name)}"  ${c.dim(visible(f.file))}  ${mark}`);
    if (f.error) out.push(`             ${c.dim(visible(f.error))}`);
  }
  if (r.trunk) out.push(`           ${c.dim(`on trunk at ${r.trunk.sha.slice(0, 7)} (certified ${r.trunk.status}): ${r.trunk.passed}/${r.trunk.tests} passed${r.trunk.failing > 0 ? `, ${r.trunk.failing} failing` : ""}`)}`);
  if (r.status === "ran" || r.status === "notrun") out.push(`           ${c.dim(`run them again: ft review ${colony} --retest ${item.id}`)}`);
  return out;
}

/** What `ft review --retest` prints once the run is asked for. */
export function retestText(proposalId: string, colony: string, res: unknown, c: Pick<Colors, "bold" | "dim">): string {
  const run = res && typeof res === "object" ? (res as { run?: unknown }).run : undefined;
  const status = run && typeof run === "object" ? text((run as { status?: unknown }).status) : "";
  return [
    `Running the tests of ${c.bold(proposalId)} again on its base${status === "queued" ? " (waiting for a free test run)" : ""}.`,
    c.dim(`  ft review ${colony} shows the result when they end; it replaces the earlier one.`),
  ].join("\n");
}
