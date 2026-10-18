import type { CheckResult } from "@fire_trident/core";
import { isMarker } from "./resolver-merge.ts";
import { parseResolveReply } from "./resolver-prompt.ts";

/**
 * The conflict resolver's one retry (colony/resolver.ts): a reply that is malformed is asked for once more, as a
 * second call counted in spend and through the decide limiter like the first. Malformed means the reply is not the
 * answer the prompt asks for at all: it cannot be parsed into the files asked for (no file block and no CANNOT line, a
 * file missing, given twice or not asked for, a block left open or one parseFileReply refuses), or a merged file still
 * holds a conflict marker that none of its three versions had. A CANNOT answer, and a well-formed merge that the checks
 * reject (a dropped or reordered line, a hunk resolved to one side whole, a file that does not parse), are answers: they
 * are not asked again.
 *
 * Where FT_HEDGE covers the colony the first call carries the same test as its validity check (colony/hedge.ts): a
 * malformed first answer sends the hedge copy at once, and the copy is the retry. A second call goes out only when no
 * copy went out.
 */

/** The name of the evidence check that records a retry. */
export const RETRY_CHECK = "resolver: retry";

/** A conflicting file as the reply must merge it: its three versions. */
export interface RetryFile {
  path: string;
  base: string;
  ours: string;
  theirs: string;
}

/** Why a resolver reply is malformed (see the module comment), or null when it is an answer (merged files, or CANNOT). */
export function malformedReply(text: string | null, files: readonly RetryFile[]): string | null {
  const parsed = parseResolveReply(text ?? "", files.map((f) => f.ours));
  if ("cannot" in parsed) return null;
  if ("problem" in parsed) return parsed.problem;
  for (const [i, f] of files.entries()) {
    const had = [f.base, f.ours, f.theirs].some((t) => t.split("\n").some(isMarker));
    if (!had && (parsed.files[i] ?? "").split("\n").some(isMarker)) return `the merge of ${f.path} leaves a conflict marker in it`;
  }
  return null;
}

/** The evidence check that says the resolver asked once more, and why. */
export function retryCheck(model: string, problem: string): CheckResult {
  return {
    name: RETRY_CHECK,
    ok: true,
    ms: 0,
    detail: `the first reply from ${model} was malformed (${problem.replace(/\s+/g, " ").trim().slice(0, 300)}), so the resolver asked once more; this merge is from the second reply, and both calls count in the spend`,
  };
}
