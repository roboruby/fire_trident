import type { Landing, LandingTests, LineageNote, Proposal } from "@fire_trident/core";
import {
  changeLifecycle,
  intentLifecycleOf,
  noteCertified,
  noteLifecycleFacts,
  placeCertified,
  testsCertified,
  type ChangeLifecycle,
  type IntentLifecycle,
  type LifecycleCertified,
  type LifecycleLink,
} from "@fire_trident/core";
import type { ColonyStore } from "./store.ts";

/**
 * The lifecycle strip on the colony page (components/Lifecycle.tsx draws it; core/lifecycle.ts computes it): each landing
 * card in the Why tab builds its change's strip from the lineage note it already holds, the review card from the change
 * waiting for a person, and the Intents tab reads an intent's strip from the colony (GET /intents/:iid/lifecycle, a
 * public read). Each step links to its evidence: the colony's public reads of the intent, the proposal, the landing's
 * note and its test row, and the landing page's take-back commands.
 */

/** An intent's strip as far as this page could read it. */
export type LifecycleState =
  | { state: "loaded"; lifecycle: IntentLifecycle }
  | { state: "loading" }
  /** Not known: the simulator keeps none, a recording did not keep it, the server did not answer (`why` says which). */
  | { state: "unknown"; why: string };

/** Read an intent's strip. The simulator keeps none; a recording answers only what it kept; an older server has no such route. */
export async function readLifecycle(colonyId: string, intentId: string, mode: "live" | "mock" | "replay", fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<LifecycleState> {
  if (mode === "mock") return { state: "unknown", why: "the simulator keeps no lifecycle" };
  let res: Response;
  try {
    res = await fetcher(`/api/colonies/${encodeURIComponent(colonyId)}/intents/${encodeURIComponent(intentId)}/lifecycle`, { headers: { accept: "application/json" } });
  } catch {
    return { state: "unknown", why: "the colony API could not be reached" };
  }
  if (res.headers.get("x-ft-recording") === "miss") return { state: "unknown", why: "this recording did not keep it" };
  if (res.status === 404) return { state: "unknown", why: "this server does not keep intents' lifecycles, or no longer has this intent" };
  if (!res.ok) return { state: "unknown", why: `the server answered ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { state: "unknown", why: "the server's answer was not JSON" };
  }
  const lifecycle = intentLifecycleOf(body);
  return lifecycle ? { state: "loaded", lifecycle } : { state: "unknown", why: "the server's answer was not a lifecycle" };
}

/**
 * Where a step's evidence lives: the intent's public read (who declared it, its reports and closures), the proposal's
 * (its agent, its checks and the gate's rule), the landing's note check, its test row (the certified commit that
 * includes it), and the landing page's take-back commands. The agent's step points at the proposal it wrote, else at the
 * intent. Null in the simulator, which has no API to point at.
 */
export function lifecycleHref(colonyId: string, s: Pick<ChangeLifecycle, "intentId" | "proposalId">, link: LifecycleLink | undefined, mode: "live" | "mock" | "replay"): string | null {
  if (!link) return null;
  if (link.kind === "take-back") return "/#take-back";
  if (mode === "mock") return null;
  const base = `/api/colonies/${encodeURIComponent(colonyId)}`;
  const id = encodeURIComponent(link.id);
  switch (link.kind) {
    case "intent":
      return `${base}/intents/${id}`;
    case "agent":
      return s.proposalId ? `${base}/proposals/${encodeURIComponent(s.proposalId)}` : `${base}/intents/${encodeURIComponent(s.intentId)}`;
    case "proposal":
      return `${base}/proposals/${id}`;
    case "landing":
      return `${base}/notes/verify?landing=${id}`;
    case "certification":
      return `${base}/landings/${id}/tests`;
    default:
      return null;
  }
}

/** Why certification has nothing to run in this colony, from the newest result this page holds; null when it has. */
export function storeNoTests(store: Pick<ColonyStore, "certs" | "lastCertSha">): string | null {
  const last = store.lastCertSha ? store.certs.get(store.lastCertSha) : undefined;
  return last && last.status === "skipped" && /^no test file/.test(last.detail ?? "") ? last.detail! : null;
}

/** Whether a green certification includes a landing: its test row, else its own note, else the page's newest green commit. */
export function whyCertified(store: Pick<ColonyStore, "greenSha" | "landings" | "certs" | "lastCertSha">, landing: Pick<Landing, "trunkSha" | "at">, note: LineageNote | null | undefined, tests: LandingTests | null | undefined): LifecycleCertified {
  return testsCertified(tests) ?? noteCertified(note?.certification, landing.trunkSha) ?? placeCertified(landing, { greenSha: store.greenSha, landings: store.landings, noTests: storeNoTests(store) });
}

/** One landed change's strip on a Why card, from its note entry, with what the page knows beside it. */
export function whyLifecycle(
  store: Pick<ColonyStore, "greenSha" | "landings" | "certs" | "lastCertSha" | "intents" | "agentName">,
  landing: Pick<Landing, "id" | "trunkSha" | "at">,
  entry: LineageNote["proposals"][number],
  note: LineageNote | null | undefined,
  tests: LandingTests | null | undefined,
): ChangeLifecycle {
  const intent = entry?.intent?.id ? store.intents.get(entry.intent.id) : undefined;
  const agentName = entry?.agentId ? store.agentName(entry.agentId) : undefined;
  return changeLifecycle(
    noteLifecycleFacts(landing, entry, {
      ...(intent ? { createdAt: intent.createdAt } : {}),
      ...(agentName && agentName !== entry.agentId ? { agentName } : {}),
      certified: whyCertified(store, landing, note, tests),
    }),
  );
}

/** The strip of a change waiting for a person (the review card), from the queue's item and what the page knows of its intent and agent. */
export function reviewLifecycle(store: Pick<ColonyStore, "intents" | "agents" | "agentName" | "agentKinds">, p: Proposal): ChangeLifecycle {
  const intent = store.intents.get(p.intentId);
  const agent = store.agents.get(p.agentId);
  const kind = agent?.kind ?? store.agentKinds.get(p.agentId);
  const name = store.agentName(p.agentId);
  const decisions = (p as Proposal & { decisions?: unknown }).decisions;
  return changeLifecycle({
    intent: {
      id: p.intentId,
      ...(intent ? { title: intent.title, createdAt: intent.createdAt, status: intent.status } : {}),
      ...(intent?.source ? { source: intent.source } : {}),
      ...(intent?.withdrawnReason ? { withdrawnReason: intent.withdrawnReason } : {}),
    },
    change: {
      id: p.id,
      agentId: p.agentId,
      status: p.status ?? "escalated",
      ...(typeof p.createdAt === "number" ? { createdAt: p.createdAt } : {}),
      ...(p.reason ? { reason: p.reason } : {}),
      ...(p.supersededBy ? { supersededBy: p.supersededBy } : {}),
      evidence: { checks: Array.isArray(p.evidence?.checks) ? p.evidence.checks : [] },
      ...(Array.isArray(decisions) ? { decisions } : {}),
      ...(typeof p.approvedAt === "number" ? { approvedAt: p.approvedAt } : {}),
      ...(Array.isArray(p.mergeHold) && p.mergeHold.length > 0 ? { held: true } : {}),
    },
    agent: { id: p.agentId, ...(name !== p.agentId ? { name } : {}), ...(kind ? { kind } : {}), ...(agent?.model ? { model: agent.model } : {}) },
  });
}
