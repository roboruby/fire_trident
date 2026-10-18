import type { AgentKind, ClosureCause, IntentClosure } from "@fire_trident/core";
import type { ApiRequest } from "./api.ts";
import { ago, type Colors } from "./format.ts";

/**
 * The closure ledger and the silent-agent limit in the CLI (packages/worker/src/colony/closure.ts): `ft intent show`
 * lists why the intent closed or reopened while agents held it, and `ft policy <colony> --silent-ttl <duration>` sets how
 * long an agent outside the platform may be silent before the colony takes its intents back (`default` for ten minutes).
 */

/** The shortest and longest limit the server takes, in seconds (colony/closure.ts MIN_SILENT_TTL_MS, MAX_SILENT_TTL_MS). */
const MIN_S = 60;
const MAX_S = 86_400;

/** What POST /silent-ttl answers. */
export interface SilentTtlView {
  ms?: number;
  seconds?: number;
  default?: boolean;
  inPlatformMs?: number;
  setBy?: string;
  setAt?: number;
  note?: string;
}

/**
 * A limit typed on the command line: seconds ("90", "90s"), minutes ("10m", "10min") or hours ("1h"), or "default" (null);
 * a usage error as a string.
 */
export function parseSilentTtl(raw: string): number | null | string {
  const t = raw.trim().toLowerCase();
  if (t === "default" || t === "off") return null;
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)?$/.exec(t);
  const unit = m?.[2]?.[0] ?? "s";
  const seconds = m ? Math.round(Number(m[1]) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1)) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < MIN_S || seconds > MAX_S) {
    return `--silent-ttl takes a duration from 60s to 24h (such as 90s or 10m), or default for ten minutes; got "${raw}"`;
  }
  return seconds;
}

/** The request that sets the limit. */
export function silentTtlRequest(colony: string, seconds: number | null, by: string, colonyPath: (colony: string, suffix: string) => string): ApiRequest {
  return { method: "POST", path: colonyPath(colony, "/silent-ttl"), body: { seconds, by } };
}

/** "90 s", "10 min", "1 min 37 s", "1 h 5 min". */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** A limit as the server writes it (colony/closure.ts durationText): "90 s", "10 min", "1 h 30 min". */
function limitText(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 120 && s % 60 !== 0 ? `${s} s` : durationText(ms);
}

/** The outcome of `ft policy <colony> --silent-ttl`. */
export function formatSilentTtl(colony: string, v: SilentTtlView, c: Colors): string {
  const ms = typeof v.ms === "number" ? v.ms : null;
  if (ms === null) return `${c.yellow("!")} The server did not answer with a silent-agent limit for ${c.bold(colony)}: it predates the setting.`;
  const head = v.default ? `${c.green("✓")} ${c.bold(colony)}: silent agents lose their intents after ${c.bold(limitText(ms))} (the default)` : `${c.green("✓")} ${c.bold(colony)}: an agent outside the platform silent for ${c.bold(limitText(ms))} loses its intents`;
  const out = [head];
  if (v.note) out.push(c.dim(`  ${v.note}`));
  return out.join("\n");
}

const CAUSE_TEXT: Readonly<Record<ClosureCause, string>> = {
  landed: "landed",
  released: "given back",
  escalated: "reported to a person",
  withdrawn: "withdrawn while held",
  gave_up: "gave up",
  reaped_silent: "reaped",
  returned: "change came back",
  stopped: "agent stopped",
  already_on_trunk: "already on trunk",
};
const KIND_TEXT: Readonly<Record<AgentKind, string>> = { internal: "in-platform", external: "external", synthetic: "synthetic" };

/** One closure as a line of `ft intent show`: the cause, the agent and its kind, how long it had been silent, when, and what the intent became. */
export function closureLine(cl: IntentClosure, c: Colors, now: number): string {
  const cause = CAUSE_TEXT[cl.cause] ?? cl.cause;
  const shown = cl.cause === "landed" || cl.cause === "already_on_trunk" ? c.green(cause) : cl.cause === "reaped_silent" || cl.cause === "stopped" ? c.yellow(cause) : cause;
  const who = cl.agentId ? `${cl.agentId}${cl.agentKind ? ` (${KIND_TEXT[cl.agentKind] ?? cl.agentKind})` : ""}` : "its agent";
  const gap = typeof cl.gapMs === "number" ? (cl.cause === "reaped_silent" ? `, silent ${durationText(cl.gapMs)}` : cl.gapMs >= 60_000 ? `, last seen ${durationText(cl.gapMs)} before` : "") : "";
  const became = cl.status === "open" ? "reopened" : cl.status;
  // Already on trunk: where the content came from (a landing, else the trunk commit it was found on).
  const from = cl.cause === "already_on_trunk" && cl.onTrunk && typeof cl.onTrunk.trunkSha === "string" ? `, from ${cl.onTrunk.landingId ?? `trunk ${cl.onTrunk.trunkSha.slice(0, 7)}`}` : "";
  return `${shown} ${c.dim("·")} ${who}${gap}${from} ${c.dim(`${ago(cl.at, now)} → ${became}`)}`;
}
