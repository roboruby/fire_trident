import type { Intent, Rule, WorkspaceLease } from "@fire_trident/core";
import type { ReviewPreview } from "../agents/preview.ts";

/** Server instructions every MCP client receives at initialization. */
export const SERVER_INSTRUCTIONS = [
  "FireTrident coordinates many coding agents on one codebase (a colony). You never push to trunk; you push to your own workspace and propose.",
  "1. join with the colony id. You get an agent id for this session.",
  "2. take: you receive an intent (what to change and why, with a predicted footprint of paths), the rule behind it if any, and a workspace lease with two short-lived tokens: a read token for trunk and a write token for your workspace. If take says wait, call take again with wait (seconds) and the server waits for work.",
  "   When take also returns review, read it before you write: review will ask these questions of your change (review.questions, each learned from a change a person rejected), and it re-checks the colony's rules for these paths (review.rules).",
  "3. Run the git commands take returns: each one stands alone (no cd, no environment variables), so they work in any shell. Replace <trunkRead> and <workspaceWrite> with the two tokens and never print or store the tokens anywhere else.",
  "4. Call read for every file your change depends on: it returns the file at the lease base and records it in your read set, which is how conflicts with other agents are detected.",
  "5. Edit only paths in the footprint, so that every review question is answered no and every listed rule holds. Commit on top of the base commit and force-push to refs/heads/main of your workspace.",
  "6. propose with the head commit id and a notVerified statement (what you did not check). The server computes your write set from the commits; nothing you report about files is trusted.",
  "7. inbox with wait (seconds) blocks until the proposal is decided: landed, returned (trunk moved under your reads or review sent it back: take again), rejected, or escalated (waiting for a human). Repeat it until the proposal is final.",
  "8. inbox also lists directives from humans. Guidance: follow it. A revision of your intent: call checkout for the new text and rebuild your change on it (work built on an older revision is refused). A withdrawal: stop and take other work. Check inbox before you propose.",
  "Any tool call keeps your claim alive; an agent silent for ten minutes loses its intent. Use sense to see where other agents work, declare to add a follow-up intent, release to give back work you cannot finish, and why to ask which intent produced a line on trunk.",
].join("\n");

/** Shell-safe single-quoted string. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

/** Short directory name for a clone. */
function cloneDir(intent: Pick<Intent, "id">): string {
  return `ft-${intent.id.replace(/[^A-Za-z0-9._-]/g, "-").slice(-12)}`;
}

/**
 * Step-by-step git commands for an external agent holding `lease`. Each command stands alone
 * (`git -C <dir>`, no `cd` or environment variables), so it runs in agents whose shell does not
 * keep state between calls and under permission rules that allow only `git`. Tokens appear as the
 * placeholders <trunkRead> and <workspaceWrite> (returned separately), never inline.
 */
export function gitInstructions(lease: WorkspaceLease, intent: Pick<Intent, "id" | "title" | "footprint">): string[] {
  const dir = cloneDir(intent);
  const title = intent.title.replace(/\s+/g, " ").trim() || intent.id;
  return [
    `git -c http.extraHeader="Authorization: Bearer <trunkRead>" clone ${sq(lease.trunk.remote)} ${dir}`,
    `git -C ${dir} checkout -B ft-work ${lease.baseSha}`,
    `# edit only ${intent.footprint.join(", ")} inside ${dir}/ with your file editing tools; call the read tool for each file you rely on`,
    `git -C ${dir} add -A`,
    `git -C ${dir} commit -m ${sq(title)} -m ${sq(`FT-Intent: ${intent.id}`)}`,
    `git -C ${dir} -c http.extraHeader="Authorization: Bearer <workspaceWrite>" push --force ${sq(lease.repo.remote)} HEAD:refs/heads/main`,
    `git -C ${dir} rev-parse HEAD`,
    `# then call propose with that commit id as headSha`,
  ];
}

/** The parts of a rule an external agent needs (no internal ids beyond the rule's own). */
export function ruleBrief(rule: Rule | null | undefined): Record<string, unknown> | null {
  if (!rule) return null;
  const spec = rule.spec ?? {};
  const out: Record<string, unknown> = { id: rule.id, kind: rule.kind, description: rule.description };
  for (const key of ["hint", "pattern", "flags", "module", "include", "exclude", "from", "replacement"]) {
    if (spec[key] !== undefined) out[key] = spec[key];
  }
  return out;
}

/** What review will ask of the held intent's change, as an external agent sees it; null when nothing. */
export function reviewBrief(review: ReviewPreview | null | undefined): { questions: Array<{ id: string; question: string }>; rules: string[] } | null {
  if (!review || (review.antibodies.length === 0 && review.rules.length === 0)) return null;
  return { questions: review.antibodies, rules: review.rules };
}

/** The `next` line of a take or checkout, which points at the review questions and rules when there are any. */
export function leaseNext(review: ReviewPreview | null | undefined): string {
  const steps = "Call read for every file you depend on, edit only the footprint, commit and push with the git commands, then call propose with the head commit id.";
  const parts: string[] = [];
  if (review && review.antibodies.length > 0) {
    parts.push("Review will ask the questions in review.questions of your change. A person rejected changes like this before, so write yours so that every answer is no.");
  }
  if (review && review.rules.length > 0) parts.push("Keep every rule in review.rules: review re-checks them, and a change that adds a violation comes back.");
  return [...parts, steps].join(" ");
}
