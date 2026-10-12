import type { Intent, Rule, WorkspaceLease } from "@fire_trident/core";

/** Server instructions every MCP client receives at initialization. */
export const SERVER_INSTRUCTIONS = [
  "FireTrident coordinates many coding agents on one codebase (a colony). You never push to trunk; you push to your own workspace and propose.",
  "1. join with the colony id. You get an agent id for this session.",
  "2. take: you receive an intent (what to change and why, with a predicted footprint of paths), the rule behind it if any, and a workspace lease with two short-lived tokens: a read token for trunk and a write token for your workspace. If take says wait, wait retryInMs and take again.",
  "3. Clone trunk with the read token and check out the lease base commit. Call read for every file your change depends on: it returns the file at the base and records it in your read set, which is how conflicts with other agents are detected.",
  "4. Edit only paths in the footprint. Commit on top of the base commit and force-push to refs/heads/main of your workspace with the write token.",
  "5. propose with the head commit id. The server computes your write set from the commits; nothing you report about files is trusted.",
  "6. inbox shows outcomes: landed, returned (trunk moved under your reads; take again), rejected, or escalated (waiting for a human).",
  "Use sense to see where other agents are working before you start, declare to add a follow-up intent, and why to ask which intent produced a line on trunk.",
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
 * Step-by-step git commands for an external agent holding `lease`. Tokens are
 * referenced through FT_TRUNK_TOKEN and FT_WS_TOKEN (returned separately) so they
 * stay out of command lines that may be logged.
 */
export function gitInstructions(lease: WorkspaceLease, intent: Pick<Intent, "id" | "title" | "footprint">): string[] {
  const dir = cloneDir(intent);
  const title = intent.title.replace(/\s+/g, " ").trim() || intent.id;
  return [
    `export FT_TRUNK_TOKEN=<tokens.trunkRead>  FT_WS_TOKEN=<tokens.workspaceWrite>`,
    `git -c http.extraHeader="Authorization: Bearer $FT_TRUNK_TOKEN" clone ${sq(lease.trunk.remote)} ${dir}`,
    `cd ${dir} && git checkout -B ft-work ${lease.baseSha}`,
    `# edit only: ${intent.footprint.join(", ")} (call the read tool for each file you rely on)`,
    `git add -A && git commit -m ${sq(title)} -m ${sq(`FT-Intent: ${intent.id}`)}`,
    `git -c http.extraHeader="Authorization: Bearer $FT_WS_TOKEN" push --force ${sq(lease.repo.remote)} HEAD:refs/heads/main`,
    `# then call propose with headSha = $(git rev-parse HEAD)`,
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
