import type { ExternalSource } from "@fire_trident/core";

/**
 * Imported issues on the page (worker colony/issues.ts): an `external` intent names the public GitHub issue it came
 * from. The record arrives in a snapshot or a lineage note, so it is checked field by field before any of it becomes a
 * link: the repository as owner/name, a positive number, and the issue's page exactly as the colony builds it.
 */

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

/** The issue an intent or a note entry names, or null when it names none this page can show safely. */
export function issueOf(x: unknown): ExternalSource | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (r.kind !== "github-issue" || typeof r.repo !== "string" || !REPO.test(r.repo) || r.repo.endsWith("/.") || r.repo.endsWith("/..")) return null;
  if (typeof r.number !== "number" || !Number.isInteger(r.number) || r.number < 1) return null;
  const url = `https://github.com/${r.repo}/issues/${r.number}`;
  if (r.url !== url) return null;
  return { kind: "github-issue", repo: r.repo, number: r.number, url, author: typeof r.author === "string" && LOGIN.test(r.author) ? r.author : "" };
}

/** "owner/repo#12". */
export function issueLabel(e: Pick<ExternalSource, "repo" | "number">): string {
  return `${e.repo}#${e.number}`;
}

/** The hover text of an issue link: where it came from and how review reads it. */
export function issueTitle(e: ExternalSource): string {
  const by = e.author ? ` opened by @${e.author}` : "";
  return `Imported from the public GitHub issue ${issueLabel(e)}${by}. Someone outside the colony wrote its text, so review reads it as it reads an agent's request.`;
}
