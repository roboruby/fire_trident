import { afterEach, describe, expect, it, vi } from "vitest";
import { blobId, changesetId } from "@fire_trident/core";
import type { ColonyEvent, MergeConflict, Proposal, Sha } from "@fire_trident/core";
import type { ModelReply } from "../../src/agents/loop.ts";
import type { ChatMessage } from "../../src/agents/prompt.ts";
import type { SqlRunner } from "../../src/colony/inline.ts";
import {
  RESOLVES_AT_ONCE,
  RESOLVES_PER_HOUR,
  Resolver,
  failedText,
  landedText,
  migrateResolver,
  startText,
  type ResolveInput,
  type ResolverHost,
  type ResolverIntent,
  type ResolverJob,
} from "../../src/colony/resolver.ts";
import { RETRY_CHECK, malformedReply } from "../../src/colony/resolver-retry.ts";
import { CallLimiter } from "../../src/decide/limiter.ts";
import { MODEL_USAGE_CHECK, noteProvenance } from "../../src/trunk/provenance.ts";

/**
 * The conflict resolver against a fake colony (colony/resolver.ts): what triggers it, the merge it proposes and how,
 * the validation that keeps both changes, the limits, and the fallback to the original return.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const F = "src/values.ts";
const OTHER = "src/other.ts";

/** Eight numbered lines, some replaced. */
function file(changes: Record<number, string> = {}): string {
  return Array.from({ length: 8 }, (_, i) => `${changes[i + 1] ?? `export const v${i + 1} = ${i + 1};`}\n`).join("");
}

const BASE = file();
// What landed first renamed v6 and changed v2; the change that came back set v6 to 66 and changed v8.
const OURS = file({ 2: "export const v2 = 20;", 6: "export const six = 6;" });
const THEIRS = file({ 6: "export const v6 = 66;", 8: "export const v8 = 80;" });
const BOTH = file({ 2: "export const v2 = 20;", 6: "export const six = 66;", 8: "export const v8 = 80;" });
const OTHER_BASE = "export const other = 1;\n";
const OTHER_TEXT = "export const other = 2;\n";
const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const DEP = "d".repeat(40);
const RESOLVER_ID = "agt_resolver";
const CONFLICT: MergeConflict = { path: F, base: blobId(BASE), trunk: blobId(OURS), theirs: blobId(THEIRS), lines: [6] };

/** The change that came back with overlapping hunks (as the lane's patch leaves it on the colony). */
function returned(over: Partial<Proposal> = {}): Proposal {
  const writeSet = [
    { path: F, blob: blobId(THEIRS) },
    { path: OTHER, blob: blobId(OTHER_TEXT) },
  ];
  return {
    id: "prp_b",
    colonyId: "col",
    intentId: "int_b",
    agentId: "agt_b",
    workspace: { namespace: "ft-ws-0", name: "col--ws-1", remote: "https://artifacts.invalid/ws.git" },
    baseSha: BASE_SHA,
    headSha: changesetId(BASE_SHA, writeSet),
    writeSet,
    readSet: [
      { path: F, blob: blobId(BASE) },
      { path: "src/dep.ts", blob: DEP },
    ],
    declared: { footprint: [F, OTHER], summary: "v6 = 66" },
    evidence: { checks: [] },
    status: "returned",
    createdAt: 1,
    reason: "stale: src/values.ts (...); text merge of src/values.ts: 1 conflicting hunk, at line 6 of its base",
    intentRevision: 1,
    mergeConflicts: [CONFLICT],
    ...over,
  };
}

/** The model's answer with this text as file 1. */
const answer = (text: string): ModelReply => ({ text: `<file n="1">\n${text}</file>`, usage: { input: 120, output: 30, cached: 0, neurons: 0 }, model: "test-model" });

/** A fake colony around one resolver. */
function world(opts: { env?: Record<string, unknown>; reply?: (messages: ChatMessage[]) => Promise<ModelReply>; proposeStatus?: Proposal["status"]; proposeFails?: string; inline?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  const sql: SqlRunner = {
    exec: (q, ...b) => {
      const rows = db.prepare(q).all(...b);
      return { toArray: () => rows };
    },
  };
  migrateResolver(sql);
  migrateResolver(sql); // additive and repeatable
  const env: Record<string, unknown> = { FT_RESOLVER: "on", FT_DEFAULT_MODEL: "test-model", FT_BULK_MODEL: "bulk-model", AI: {}, ...opts.env };
  const intents = new Map<string, ResolverIntent>([
    ["int_b", { title: "Set v6 to 66", why: "Callers need the larger value.", status: "proposed", assignedTo: "agt_b" }],
    ["int_a", { title: "Rename v6 to six", why: "Shorter names read better.", status: "landed", assignedTo: null }],
  ]);
  const proposals = new Map<string, Proposal>([["prp_b", returned()]]);
  const commits: Record<Sha, Record<string, Sha>> = {
    [BASE_SHA]: { [F]: blobId(BASE), [OTHER]: blobId(OTHER_BASE) },
    [HEAD_SHA]: { [F]: blobId(OURS), [OTHER]: blobId(OTHER_BASE) },
  };
  const blobs: Record<Sha, string> = { [blobId(BASE)]: BASE, [blobId(OURS)]: OURS, [blobId(OTHER_BASE)]: OTHER_BASE };
  if (opts.inline === false) Object.assign(blobs, { [blobId(THEIRS)]: THEIRS, [blobId(OTHER_TEXT)]: OTHER_TEXT });
  const proposed: ResolveInput[] = [];
  const notices: Array<{ agentId: string; intentId: string; message: string }> = [];
  const published: ColonyEvent[] = [];
  const counters: Record<string, number> = {};
  const calls: ChatMessage[][] = [];
  const tasks: Array<Promise<unknown>> = [];
  const limiter = new CallLimiter(8, 120);
  let reply = opts.reply ?? (async () => answer(BOTH));
  let n = 0;
  const host: ResolverHost = {
    sql,
    env: () => env as never,
    colonyId: () => "col",
    now: () => Date.now(),
    waitUntil: (p) => void tasks.push(p),
    model: () => ({
      complete: async (req) => {
        calls.push(req.messages);
        return reply(req.messages);
      },
    }),
    limiter: () => limiter,
    agent: (known) => known ?? RESOLVER_ID,
    intent: (id) => intents.get(id) ?? null,
    hold: (intentId, agentId, events) => {
      const i = intents.get(intentId)!;
      i.status = "proposed";
      i.assignedTo = agentId;
      events.push({ t: "agent", at: Date.now(), agentId, kind: "internal", state: "working", intentId });
    },
    release: (intentId, agentId) => {
      const i = intents.get(intentId);
      if (!i) return null;
      if ((i.status !== "proposed" && i.status !== "claimed") || i.assignedTo !== agentId) return i.status;
      i.status = "open";
      i.assignedTo = null;
      return "open";
    },
    proposal: (id) => proposals.get(id) ?? null,
    inlineContents: (id) => (opts.inline === false || id !== "prp_b" ? null : { [blobId(THEIRS)]: THEIRS, [blobId(OTHER_TEXT)]: OTHER_TEXT }),
    trunkSha: () => HEAD_SHA,
    trunk: () => ({
      baseBlobs: async (sha, paths) => paths.map((path) => ({ path, blob: commits[sha]?.[path] ?? null })),
      readBlobs: async (list) => Object.fromEntries(list.map((b) => [b, blobs[b] ?? null])),
    }),
    landedSince: (paths) => (paths.includes(F) ? [{ path: F, landingId: "lnd_a", intentId: "int_a" }] : []),
    propose: async (input) => {
      if (opts.proposeFails) throw new Error(opts.proposeFails);
      proposed.push(input);
      const p: Proposal = { ...(input as Proposal), id: `prp_r${++n}`, status: opts.proposeStatus ?? "ready", createdAt: Date.now(), evidence: { checks: input.evidence?.checks ?? [], notVerified: input.evidence?.notVerified ?? "" }, ...(opts.proposeStatus === "returned" ? { reason: "stale: trunk moved" } : {}) };
      proposals.set(p.id, p);
      return p;
    },
    notice: (agentId, intentId, message) => {
      notices.push({ agentId, intentId, message });
      return { t: "directive", at: Date.now(), directiveId: `dir_${notices.length}`, agentId, intentId, message, by: "resolver", kind: "resolution" };
    },
    publish: (events) => void published.push(...events),
    bump: (name) => void (counters[name] = (counters[name] ?? 0) + 1),
  };
  const resolver = new Resolver(host);
  return {
    host,
    resolver,
    env,
    intents,
    proposals,
    proposed,
    notices,
    published,
    counters,
    calls,
    setReply: (r: (messages: ChatMessage[]) => Promise<ModelReply>) => void (reply = r),
    /** Wait for every background task the resolver started (and the ones those started). */
    async settle(): Promise<void> {
      while (tasks.length > 0) await Promise.all(tasks.splice(0));
    },
    job: (id = "prp_b") => resolver.job(id),
    rows: (q: string, ...b: unknown[]) => db.prepare(q).all(...b) as ResolverJob[],
  };
}

/** Take a return on: the intent as the colony's transition passes it. */
function hold(w: ReturnType<typeof world>, p: Proposal = returned(), intent: { id: string; status: string; assigned_to: string | null; contest?: number | null } = { id: p.intentId, status: "proposed", assigned_to: p.agentId }) {
  const events: ColonyEvent[] = [];
  const took = w.resolver.hold(p, intent, events);
  return { took, events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("what triggers a resolution", () => {
  it("takes on only a change that text merge sent back for overlapping hunks, on a colony the flag covers", async () => {
    const plain = world();
    expect(hold(plain, returned({ mergeConflicts: undefined })).took).toBe(false);
    expect(hold(plain, returned({ mergeConflicts: [] })).took).toBe(false);
    expect(hold(plain, returned({ status: "rejected" })).took).toBe(false);
    expect(plain.job()).toBeNull();
    for (const setting of [undefined, "", "off", "other-colony"]) {
      const w = world({ env: { FT_RESOLVER: setting } });
      expect(hold(w).took).toBe(false);
      expect(w.job()).toBeNull();
      expect(w.intents.get("int_b")).toMatchObject({ status: "proposed", assignedTo: "agt_b" });
      expect(w.notices).toEqual([]);
    }
    const listed = world({ env: { FT_RESOLVER: "other-colony, col" } });
    expect(hold(listed).took).toBe(true);
    await listed.settle();
  });

  it("never takes on its own change, a contest's, one whose intent another agent holds, one tried before, or one it cannot call a model for", async () => {
    const w = world();
    expect(hold(w, returned(), { id: "int_b", status: "proposed", assigned_to: "agt_other" }).took).toBe(false);
    expect(hold(w, returned(), { id: "int_b", status: "open", assigned_to: null }).took).toBe(false);
    expect(hold(w, returned(), { id: "int_b", status: "proposed", assigned_to: "agt_b", contest: 2 }).took).toBe(false);
    expect(hold(w).took).toBe(true);
    await w.settle();
    // One attempt per proposal; and the resolver's own change that comes back is never resolved again.
    expect(hold(w).took).toBe(false);
    expect(hold(w, returned({ id: "prp_r1", agentId: RESOLVER_ID }), { id: "int_b", status: "proposed", assigned_to: RESOLVER_ID }).took).toBe(false);
    expect(hold(world({ env: { AI: undefined } })).took).toBe(false);
    expect(hold(world({ env: { FT_RESOLVER_MODEL: "claude-test" } })).took).toBe(false);
    const many = Array.from({ length: 5 }, (_, i) => ({ ...CONFLICT, path: `src/f${i}.ts` }));
    expect(hold(world(), returned({ mergeConflicts: many })).took).toBe(false);
  });

  it("leaves no job behind when it cannot finish taking a return on (the caller then reopens the intent as usual)", () => {
    const w = world();
    w.host.notice = () => {
      throw new Error("directives table is gone");
    };
    expect(hold(w).took).toBe(false);
    expect(w.job()).toBeNull();
    expect(w.counters).toEqual({});
  });

  it("holds the intent for its agent and tells the change's agent, counting the attempt", async () => {
    const w = world({ reply: () => new Promise<ModelReply>(() => undefined) });
    const { took, events } = hold(w);
    expect(took).toBe(true);
    expect(w.intents.get("int_b")).toMatchObject({ status: "proposed", assignedTo: RESOLVER_ID });
    expect(w.job()).toMatchObject({ state: "resolving", intent_id: "int_b", agent_id: "agt_b", resolver_id: RESOLVER_ID });
    expect(events.map((e) => e.t)).toEqual(["agent", "directive"]);
    expect(w.notices).toEqual([{ agentId: "agt_b", intentId: "int_b", message: startText("prp_b", [CONFLICT]) }]);
    expect(w.notices[0]!.message).toBe(
      "Your change prp_b came back because text merge found overlapping hunks (src/values.ts at line 6). The platform's conflict resolver is merging it with what landed first on those lines, keeping both changes, so you do not need to redo it; how that ends will follow here.",
    );
    expect(w.counters).toEqual({ "resolver.attempted": 1 });
  });
});

describe("a resolution", () => {
  it("proposes the merge keeping both changes as a new inline change for the same intent, by the resolver", async () => {
    const w = world();
    expect(hold(w).took).toBe(true);
    await w.settle();
    expect(w.proposed).toHaveLength(1);
    const input = w.proposed[0]!;
    const writeSet = [
      { path: F, blob: blobId(BOTH) },
      { path: OTHER, blob: blobId(OTHER_TEXT) },
    ];
    expect(input).toMatchObject({
      colonyId: "col",
      intentId: "int_b",
      agentId: RESOLVER_ID,
      baseSha: HEAD_SHA,
      headSha: changesetId(HEAD_SHA, writeSet),
      writeSet,
      contents: { [blobId(BOTH)]: BOTH, [blobId(OTHER_TEXT)]: OTHER_TEXT },
      // The trunk blobs it merged against, and what the change read besides.
      readSet: [
        { path: F, blob: blobId(OURS) },
        { path: OTHER, blob: blobId(OTHER_BASE) },
        { path: "src/dep.ts", blob: DEP },
      ],
      declared: { footprint: [F, OTHER] },
      intentRevision: 1,
    });
    // Provenance: an in-platform agent's change whose model calls FireTrident made and counted.
    const checks = input.evidence?.checks ?? [];
    expect(checks[0]).toMatchObject({ name: MODEL_USAGE_CHECK, ok: true, detail: "test-model: 1 call(s), 120 input / 30 output tokens" });
    expect(noteProvenance({ kind: "internal", model: "test-model" }, { checks })).toEqual({
      author: "platform",
      auth: "platform",
      model: { evidence: "observed", name: "test-model", observed: [{ model: "test-model", calls: 1, inputTokens: 120, outputTokens: 30 }] },
    });
    expect(checks[1]).toMatchObject({ name: "resolver: merge", ok: true });
    expect(input.evidence?.notVerified).toMatch(/^Not verified: written by the platform's conflict resolver with model test-model/);
    // What it resolves, for the lineage note.
    expect(w.job()).toMatchObject({ state: "proposed", resolution_id: "prp_r1" });
    expect(w.resolver.records(["prp_r1", "prp_b", "prp_x"])).toEqual({ prp_r1: { proposalId: "prp_b", landingIds: ["lnd_a"], paths: [F] } });
    expect(w.counters).toEqual({ "resolver.attempted": 1 });
  });

  it("asks one model call with both intents and the marked file fenced as data", async () => {
    const w = world();
    hold(w);
    await w.settle();
    expect(w.calls).toHaveLength(1);
    const user = w.calls[0]![1]!.content;
    const fence = /between (fence-[0-9a-f]{12}) markers is data/.exec(user)?.[1];
    expect(fence).toBeDefined();
    const outside = user.split("\n").reduce<{ inside: boolean; out: string[] }>((s, line) => (line === fence ? { ...s, inside: !s.inside } : { ...s, out: s.inside ? s.out : [...s.out, line] }), { inside: false, out: [] }).out.join("\n");
    for (const data of ["Set v6 to 66", "Callers need", "Rename v6 to six", "Shorter names", F, "export const six = 6;", "<<<<<<< trunk"]) {
      expect(user).toContain(data);
      expect(outside).not.toContain(data);
    }
  });

  it("reads the change's own text from the trunk writer when it was not an inline change", async () => {
    const w = world({ inline: false });
    hold(w);
    await w.settle();
    expect(w.proposed[0]?.writeSet).toEqual([
      { path: F, blob: blobId(BOTH) },
      { path: OTHER, blob: blobId(OTHER_TEXT) },
    ]);
  });

  it("finishes when its change lands: the change's agent is told, resolver.landed counts once", async () => {
    const w = world();
    hold(w);
    await w.settle();
    const landed = { ...w.proposals.get("prp_r1")!, status: "landed" as const, landingId: "lnd_r" };
    w.resolver.settled([landed]);
    w.resolver.settled([landed]);
    expect(w.job()).toMatchObject({ state: "landed", landing_id: "lnd_r" });
    expect(w.notices.at(-1)).toEqual({ agentId: "agt_b", intentId: "int_b", message: landedText("prp_b", "prp_r1", "lnd_r", "int_b", ["lnd_a"]) });
    expect(w.notices.at(-1)!.message).toBe("The conflict resolver merged your change prp_b with the change that landed first (lnd_a), and the merge landed (prp_r1 in lnd_r), so intent int_b is done.");
    expect(w.counters).toEqual({ "resolver.attempted": 1, "resolver.landed": 1 });
  });
});

describe("validation before anything is proposed", () => {
  /** Hold a return whose model answers `text`, and the job after it ran. */
  async function attempt(text: string) {
    const w = world({ reply: async () => answer(text) });
    hold(w);
    await w.settle();
    return w;
  }

  it("refuses a merge that drops a side's change outside the conflicting hunk: the return stands, the intent reopens", async () => {
    const w = await attempt(file({ 6: "export const six = 66;", 8: "export const v8 = 80;" }));
    expect(w.proposed).toEqual([]);
    expect(w.job()).toMatchObject({ state: "failed", reason: "the merge of src/values.ts changes or drops line 2, which is outside the conflicting hunks" });
    expect(w.intents.get("int_b")).toMatchObject({ status: "open", assignedTo: null });
    expect(w.notices.at(-1)!.message).toBe(
      "The conflict resolver could not merge your change prp_b: the merge of src/values.ts changes or drops line 2, which is outside the conflicting hunks. Its return stands, and intent int_b is open again for the next agent.",
    );
    expect(w.published.at(-1)).toMatchObject({ t: "directive", kind: "resolution", agentId: "agt_b" });
    expect(w.counters).toEqual({ "resolver.attempted": 1, "resolver.failed": 1 });
  });

  it("refuses a conflicting hunk resolved to one side's version whole", async () => {
    const w = await attempt(file({ 2: "export const v2 = 20;", 6: "export const v6 = 66;", 8: "export const v8 = 80;" }));
    expect(w.proposed).toEqual([]);
    expect(w.job()?.reason).toBe("the merge of src/values.ts takes the change's version of the conflicting hunk at line 6 of the base whole, which drops the edit that landed first");
  });

  it("refuses a merge that does not parse where both versions did", async () => {
    const w = await attempt(file({ 2: "export const v2 = 20;", 6: "export const six = { 66;", 8: "export const v8 = 80;" }));
    expect(w.proposed).toEqual([]);
    expect(w.job()?.reason).toMatch(/^the merge of src\/values\.ts does not parse: /);
  });

  it("takes the model's CANNOT as the end of it", async () => {
    const w = world({ reply: async () => ({ text: "CANNOT: one says 6, the other 66, and the intents disagree." }) });
    hold(w);
    await w.settle();
    expect(w.job()?.reason).toBe("the model found the two changes cannot both be kept: one says 6, the other 66, and the intents disagree.");
    expect(w.intents.get("int_b")?.status).toBe("open");
  });

  it("refuses a reply that changes a file that was not in conflict, after asking once more", async () => {
    const w = world({ reply: async () => ({ text: `<file n="1">\n${BOTH}</file>\n<file n="2">\n${OTHER_TEXT}</file>` }) });
    hold(w);
    await w.settle();
    // A malformed reply is asked for once more; malformed again, the return stands.
    expect(w.calls).toHaveLength(2);
    expect(w.job()?.reason).toBe("the model's reply was not usable twice: first the reply has a file 2, which was not asked for; then the reply has a file 2, which was not asked for");
  });
});

describe("one retry for a malformed reply", () => {
  /** A world whose model answers these replies in turn (the last one again after). */
  function scripted(replies: ModelReply[]) {
    let i = 0;
    return world({ reply: async () => replies[Math.min(i++, replies.length - 1)]! });
  }
  const garbled: ModelReply = { text: "Here is the merged file: export const six = 66;", usage: { input: 100, output: 10, cached: 0, neurons: 0 }, model: "test-model" };

  it("asks once more when the reply cannot be parsed, proposes the second reply's merge, and records both calls and why", async () => {
    const w = scripted([garbled, answer(BOTH)]);
    hold(w);
    await w.settle();
    expect(w.calls).toHaveLength(2);
    expect(w.calls[1]).toEqual(w.calls[0]);
    expect(w.proposed).toHaveLength(1);
    expect(w.proposed[0]!.contents).toMatchObject({ [blobId(BOTH)]: BOTH });
    const checks = w.proposed[0]!.evidence?.checks ?? [];
    expect(checks.map((c) => c.name)).toEqual([MODEL_USAGE_CHECK, MODEL_USAGE_CHECK, RETRY_CHECK, "resolver: merge"]);
    expect(checks[0]!.detail).toBe("test-model: 1 call(s), 100 input / 10 output tokens");
    expect(checks[1]!.detail).toBe("test-model: 1 call(s), 120 input / 30 output tokens");
    expect(checks[2]!.detail).toBe(
      "the first reply from test-model was malformed (the reply has no <file n=\"N\"> block and no CANNOT line), so the resolver asked once more; this merge is from the second reply, and both calls count in the spend",
    );
    // Provenance counts both calls to the model.
    expect(noteProvenance({ kind: "internal", model: "test-model" }, { checks })?.model?.observed).toEqual([{ model: "test-model", calls: 2, inputTokens: 220, outputTokens: 40 }]);
  });

  it("asks once more when the merge leaves a conflict marker, and only once", async () => {
    const marked = BOTH.replace("export const six = 66;\n", "<<<<<<< trunk\nexport const six = 6;\n=======\nexport const v6 = 66;\n>>>>>>> change\n");
    const w = scripted([answer(marked)]);
    hold(w);
    await w.settle();
    expect(w.calls).toHaveLength(2);
    expect(w.proposed).toEqual([]);
    expect(w.job()?.reason).toBe("the model's reply was not usable twice: first the merge of src/values.ts leaves a conflict marker in it; then the merge of src/values.ts leaves a conflict marker in it");
    expect(w.intents.get("int_b")?.status).toBe("open");
  });

  it("does not ask again for a well-formed merge the checks reject, or for CANNOT", async () => {
    const dropped = scripted([answer(file({ 6: "export const six = 66;", 8: "export const v8 = 80;" })), answer(BOTH)]);
    hold(dropped);
    await dropped.settle();
    expect(dropped.calls).toHaveLength(1);
    expect(dropped.job()?.reason).toBe("the merge of src/values.ts changes or drops line 2, which is outside the conflicting hunks");
    const cannot = scripted([{ text: "CANNOT: the intents disagree." }, answer(BOTH)]);
    hold(cannot);
    await cannot.settle();
    expect(cannot.calls).toHaveLength(1);
    expect(cannot.job()?.state).toBe("failed");
  });

  it("says so when the second call fails", async () => {
    let i = 0;
    const w = world({ reply: async () => (i++ === 0 ? garbled : Promise.reject(new Error("upstream answered 502"))) });
    hold(w);
    await w.settle();
    expect(w.calls).toHaveLength(2);
    expect(w.job()?.reason).toBe(
      "the model's first reply was not usable (the reply has no <file n=\"N\"> block and no CANNOT line), and asking once more failed: the call to test-model failed: upstream answered 502",
    );
  });

  it("asks no more when a hedge copy already answered for it, and passes the same test to the hedge", async () => {
    const seen: Array<boolean | undefined> = [];
    const w = world();
    w.host.model = () => ({
      complete: async (req) => {
        seen.push(req.valid?.(garbled.text));
        seen.push(req.valid?.(answer(BOTH).text));
        // The hedge's copy answered malformed too: the copy was the retry.
        return { ...garbled, hedged: { after_ms: 900, winner: "original", model: "test-model", cause: "invalid" } };
      },
    });
    hold(w);
    await w.settle();
    expect(seen).toEqual([false, true]);
    expect(w.job()?.reason).toBe("the model's reply was not usable: the reply has no <file n=\"N\"> block and no CANNOT line");
  });

  it("tells a malformed reply from an answer", () => {
    const f = [{ path: F, base: BASE, ours: OURS, theirs: THEIRS }];
    expect(malformedReply(answer(BOTH).text, f)).toBeNull();
    expect(malformedReply("CANNOT: no", f)).toBeNull();
    expect(malformedReply(null, f)).toBe('the reply has no <file n="N"> block and no CANNOT line');
    expect(malformedReply(`<file n="1">\n${BOTH}`, f)).toBe("file 1 has no closing </file>");
    // A file that had marker lines of its own may keep them: that is for the merge checks, not a malformed reply.
    const own = [{ path: F, base: `=======\n${BASE}`, ours: `=======\n${OURS}`, theirs: `=======\n${THEIRS}` }];
    expect(malformedReply(answer(`=======\n${BOTH}`).text, own)).toBeNull();
  });
});

describe("fallback to the original return", () => {
  it("stands when the resolver takes longer than 60 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const w = world({ reply: () => new Promise<ModelReply>(() => undefined) });
    hold(w);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(w.job()?.state).toBe("resolving");
    await vi.advanceTimersByTimeAsync(1_001);
    await w.settle();
    expect(w.job()).toMatchObject({ state: "failed", reason: "it took longer than 60 s" });
    expect(w.intents.get("int_b")?.status).toBe("open");
  });

  it("stands when its proposal goes back, and when the colony refuses it", async () => {
    const w = world();
    hold(w);
    await w.settle();
    w.intents.get("int_b")!.status = "open"; // the colony's transition reopened it (the resolver held it)
    w.resolver.settled([{ ...w.proposals.get("prp_r1")!, status: "returned", reason: "stale: src/values.ts changed again" }]);
    expect(w.job()).toMatchObject({ state: "failed", reason: "stale: src/values.ts changed again" });
    expect(w.notices.at(-1)!.message).toBe(failedText("prp_b", "stale: src/values.ts changed again", "int_b", "open", "prp_r1"));
    expect(w.notices.at(-1)!.message).toBe(
      "The conflict resolver's merge of your change prp_b (prp_r1) did not land: stale: src/values.ts changed again. Its return stands, and intent int_b is open again for the next agent.",
    );
    expect(w.counters).toEqual({ "resolver.attempted": 1, "resolver.failed": 1 });

    const refused = world({ proposeFails: "[ft:409] intent int_b was revised" });
    hold(refused);
    await refused.settle();
    expect(refused.job()).toMatchObject({ state: "failed", reason: "the colony refused the merged change: intent int_b was revised" });
    expect(refused.intents.get("int_b")?.status).toBe("open");
  });

  it("finishes at once a proposal that went back before the job knew it", async () => {
    const w = world({ proposeStatus: "returned" });
    hold(w);
    await w.settle();
    expect(w.job()).toMatchObject({ state: "failed", resolution_id: "prp_r1", reason: "stale: trunk moved" });
  });

  it("stands when the intent changed hands while the resolver worked", async () => {
    let answerNow!: (r: ModelReply) => void;
    const w = world({ reply: () => new Promise<ModelReply>((resolve) => (answerNow = resolve)) });
    hold(w);
    await vi.waitFor(() => expect(w.calls).toHaveLength(1));
    w.intents.set("int_b", { ...w.intents.get("int_b")!, status: "withdrawn", assignedTo: null });
    answerNow(answer(BOTH));
    await w.settle();
    expect(w.proposed).toEqual([]);
    expect(w.job()).toMatchObject({ state: "failed", reason: "its intent changed while the resolver worked (withdrawn, amended or taken by another agent)" });
    expect(w.notices.at(-1)!.message).toMatch(/intent int_b is withdrawn\.$/);
  });

  it("stands for a resolution cut off by a restart, and for one whose run was lost", async () => {
    const w = world({ reply: () => new Promise<ModelReply>(() => undefined) });
    hold(w);
    // A new object over the same storage: the old run is gone.
    new Resolver(w.host).resume();
    expect(w.job()).toMatchObject({ state: "failed", reason: "the colony restarted while it worked" });
    expect(w.intents.get("int_b")?.status).toBe("open");

    const lost = world({ reply: () => new Promise<ModelReply>(() => undefined) });
    hold(lost);
    lost.host.sql.exec("UPDATE resolver_jobs SET deadline = ?", Date.now() - 10 * 60_000);
    lost.resolver.sweep();
    expect(lost.job()).toMatchObject({ state: "failed", reason: "it did not finish within 60 s" });
  });
});

describe("limits", () => {
  it(`runs at most ${RESOLVES_AT_ONCE} at once and starts at most ${RESOLVES_PER_HOUR} an hour`, async () => {
    const w = world({ reply: () => new Promise<ModelReply>(() => undefined) });
    for (const i of [1, 2, 3]) w.intents.set(`int_${i}`, { title: `t${i}`, why: "", status: "proposed", assignedTo: `agt_${i}` });
    const p = (i: number) => returned({ id: `prp_${i}`, intentId: `int_${i}`, agentId: `agt_${i}` });
    expect(hold(w, p(1)).took).toBe(true);
    expect(hold(w, p(2)).took).toBe(true);
    expect(hold(w, p(3)).took).toBe(false);
    expect(w.intents.get("int_3")).toMatchObject({ status: "proposed", assignedTo: "agt_3" });

    const busy = world();
    const now = Date.now();
    for (let i = 0; i < RESOLVES_PER_HOUR; i++) {
      busy.host.sql.exec("INSERT INTO resolver_jobs (proposal_id, intent_id, agent_id, resolver_id, state, conflicts, created_at, deadline, finished_at) VALUES (?, 'int_x', 'agt_x', ?, 'failed', '[]', ?, ?, ?)", `prp_old${i}`, RESOLVER_ID, now - 30 * 60_000, now, now);
    }
    expect(hold(busy).took).toBe(false);
    busy.host.sql.exec("UPDATE resolver_jobs SET created_at = ?", now - 61 * 60_000);
    expect(hold(busy).took).toBe(true);
    await busy.settle();
  });
});
