import { fmtInt, shortSha } from "./format.ts";
import type { CertView } from "./store.ts";

/** Trunk certification as the UI words it (the trunk bar, the Why tab, the event log), with a red result's suspects and its first failing commit. */

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

/** One suspect as the certification card shows it: the change to look at first, and the command that undoes it. */
export interface SuspectView {
  key: string;
  /** The proposal the undo command names (the landing, when the colony knew no single proposal). */
  ref: string;
  title: string;
  /** The files it changed under the failing tests, and the failing test files it is a suspect for. */
  paths: string;
  files: string;
  /** Its trunk commit, short ("" when unknown). */
  commit: string;
  undo: string;
}

/** Names joined with ", ", the ones past `max` counted ("a, b +2"). */
function names(list: string[], max: number): string {
  return list.length > max ? `${list.slice(0, max).join(", ")} +${list.length - max}` : list.join(", ");
}

/**
 * A red result's suspects (culprit finding) for the card, newest first, at most `max`, each with its
 * undo command (`ft revert <colony> <prp>`). Malformed entries (older or odd data) are left out.
 */
export function certSuspects(c: Pick<CertView, "suspects">, colonyId: string, max = 3): SuspectView[] {
  const list: unknown[] = Array.isArray(c.suspects) ? c.suspects : [];
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((p): p is string => typeof p === "string" && p !== "") : []);
  const out: SuspectView[] = [];
  for (const raw of list) {
    if (out.length >= max) break;
    const s = (raw ?? {}) as Record<string, unknown>;
    if (typeof s.landingId !== "string" || s.landingId === "") continue;
    const ref = typeof s.proposalId === "string" && s.proposalId ? s.proposalId : s.landingId;
    out.push({
      key: `${s.landingId}:${ref}`,
      ref,
      title: typeof s.title === "string" ? s.title : "",
      paths: names(strings(s.paths), 3),
      files: names(strings(s.files), 2),
      commit: typeof s.trunkSha === "string" ? shortSha(s.trunkSha) : "",
      undo: `ft revert ${colonyId || "<colony>"} ${ref}`,
    });
  }
  return out;
}

/** A red result's first failing commit (FT_BISECT) as the card words it: one sentence, and the commands that undo the proposals it names. */
export interface FirstRedView {
  text: string;
  /** `ft revert <colony> <prp>` for the proposals that changed what the failing tests load (at most two). */
  undo: string[];
}

/**
 * The first red search's answer in plain words: "The failing tests first failed at commit 1a2b3c4 (landing lnd_4,
 * intent “Speed up subtraction”), found in 3 test runs; its change to src/math.ts is the likely cause." When it named
 * no commit, why. Null without an answer; malformed entries (older or odd data) are left out.
 */
export function certFirstRed(c: Pick<CertView, "firstRed">, colonyId: string): FirstRedView | null {
  const f = c.firstRed as Partial<NonNullable<CertView["firstRed"]>> | undefined;
  if (!f || typeof f !== "object") return null;
  const runs = typeof f.probes === "number" ? `${fmtInt(f.probes)} test run${f.probes === 1 ? "" : "s"}` : "";
  if (f.status !== "found" || typeof f.trunkSha !== "string") {
    const reason = typeof f.reason === "string" && f.reason ? ` ${f.reason}` : "";
    return f.status === "inconclusive" ? { text: `The search for the first failing commit was inconclusive.${reason}`, undo: [] } : null;
  }
  const intents = (Array.isArray(f.intents) ? f.intents : []).filter((i) => i && typeof i.id === "string");
  const proposals = (Array.isArray(f.proposals) ? f.proposals : []).filter((p) => p && typeof p.id === "string" && Array.isArray(p.paths));
  const titled = intents.map((i) => (typeof i.title === "string" && i.title ? `“${i.title}”` : i.id));
  const who =
    titled.length === 0 ? "a commit FireTrident made itself" : titled.length === 1 ? `intent ${titled[0]}` : titled.length === 2 ? `intents ${titled[0]} and ${titled[1]}` : `intents ${titled[0]} and ${fmtInt(titled.length - 1)} more`;
  const where = [typeof f.landingId === "string" && f.landingId ? `landing ${f.landingId}` : "", who].filter(Boolean).join(", ");
  const paths = [...new Set(proposals.flatMap((p) => p.paths.filter((x): x is string => typeof x === "string")))].sort();
  const cause = paths.length > 0 ? `its change to ${names(paths, 3)} is the likely cause.` : "none of its proposals changed a file the failing tests load.";
  return {
    text: `The failing tests first failed at commit ${shortSha(f.trunkSha)} (${where})${runs ? `, found in ${runs}` : ""}; ${cause}`,
    undo: proposals.slice(0, 2).map((p) => `ft revert ${colonyId || "<colony>"} ${p.id}`),
  };
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
  const suspects = certSuspects(c, "");
  const suspected = suspects.length > 0 ? `\nSuspects, newest first:\n${suspects.map((s) => `• ${s.ref}${s.title ? ` “${s.title}”` : ""}${s.paths ? ` changed ${s.paths}` : ""}`).join("\n")}` : "";
  const firstRed = certFirstRed(c, "");
  return `${shortSha(c.trunkSha)}: ${fmtInt(k ? k.fail + k.cancelled : lines.length)} of ${fmtInt(k?.tests ?? 0)} tests failing${notRun ? ` (${notRun})` : ""}${took}\n${lines.join("\n")}${more > 0 ? `\n… and ${more} more` : ""}${suspected}${firstRed ? `\n${firstRed.text}` : ""}${reused}`;
}
