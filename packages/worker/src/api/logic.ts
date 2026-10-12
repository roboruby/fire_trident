import type { AgentListEntry } from "../colony/metrics.ts";

/**
 * Pure helpers for the operations routes (colony registry, agent control,
 * colony deletion). No Cloudflare APIs here, so they test in plain Node.
 */

/** Run `fn` over `items` with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
  const out = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i] as T, i) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  const n = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

/**
 * Does Artifacts repo `name` belong to the colony whose repo prefix is `slug`?
 * Colony repos are `<slug>--trunk`, `<slug>--seed`, `<slug>--ws-<n>`, `<slug>--lane-<region>`.
 * Colony ids never contain "--" (slugs collapse separators), so the prefix ends at the first "--"
 * and `web` never matches `web-app--trunk`.
 */
export function repoBelongsTo(name: string, slug: string): boolean {
  if (!slug || slug.includes("--")) return false;
  return name.startsWith(`${slug}--`) && name.length > slug.length + 2;
}

/** Colony ids named by trunk repos (`<id>--trunk`) in a repo listing. */
export function colonyIdsFromTrunks(names: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const m = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)--trunk$/.exec(name);
    if (m && m[1] && !m[1].includes("--")) out.add(m[1]);
  }
  return [...out].sort();
}

/** Message of anything thrown, never throwing itself. */
export function messageOf(err: unknown): string {
  try {
    const raw = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
    return (raw ?? "").replace(/\[ft:\d{3}\]\s*/, "").trim() || "error";
  } catch {
    return "error";
  }
}

/** True when an RPC failed because the target class has no such method (an object on an older class, or a class without the hook). */
export function isUnsupportedRpc(err: unknown): boolean {
  return /RPC receiver does not implement the method/i.test(messageOf(err));
}

/** Journal fields of an AgentDO status reply, picked defensively (the reply crosses RPC as plain data). */
export function journalFields(status: unknown): Partial<AgentListEntry> {
  if (!status || typeof status !== "object") return {};
  const s = status as Record<string, unknown>;
  const out: Partial<AgentListEntry> = {};
  if (typeof s.running === "boolean") out.running = s.running;
  if (typeof s.step === "string") out.step = s.step;
  if (typeof s.attempts === "number") out.attempts = s.attempts;
  if (typeof s.proposalId === "string") out.proposalId = s.proposalId;
  if (typeof s.lastError === "string") out.lastError = s.lastError;
  if (typeof s.stopReason === "string") out.stopReason = s.stopReason;
  if (typeof s.intentTitle === "string") out.intentTitle = s.intentTitle;
  if (s.counters && typeof s.counters === "object") {
    const counters: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.counters as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) counters[k] = v;
    out.counters = counters;
  }
  return out;
}

/** Truthy query flags: 1, true, yes (case-insensitive). */
export function flag(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|yes)$/i.test(v.trim());
}
