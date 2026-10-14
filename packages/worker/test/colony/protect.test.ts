import { describe, expect, it } from "vitest";
import type { Landing, Proposal } from "@fire_trident/core";
import {
  humanApproval,
  isProtectStop,
  newerProtect,
  nextProtectRecord,
  parseProtectRecord,
  protectChanged,
  protectHits,
  protectLandedText,
  protectReason,
  splitByProtection,
  type ProtectHost,
  type ProtectRecord,
} from "../../src/colony/protect.ts";
import type { FenceAnswer } from "../../src/trunk/direction.ts";

/** Protected paths reach changes already decided (colony/protect.ts): the record, the rule, and the colony's side of a change of globs. */

const AUTH: ProtectRecord = { version: 2, globs: [{ glob: ".github/**", at: 0 }, { glob: "src/auth/**", at: 5_000 }] };

/** A change writing these paths (null deletes). */
function change(id: string, paths: Record<string, string | null>, intentId = `int_${id}`): Proposal {
  return {
    id,
    colonyId: "col",
    intentId,
    agentId: "agt_a",
    workspace: { namespace: "ft-ws-0", name: "col--ws-1", remote: "https://artifacts.invalid/ws.git" },
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    writeSet: Object.entries(paths).map(([path, blob]) => ({ path, blob })),
    readSet: [],
    declared: { footprint: Object.keys(paths), summary: id },
    evidence: { checks: [] },
    status: "ready",
    createdAt: 1,
  };
}

describe("the record", () => {
  it("reads a stored record, dropping malformed globs, and refuses what is not one", () => {
    expect(parseProtectRecord(JSON.stringify(AUTH))).toEqual(AUTH);
    expect(parseProtectRecord({ version: 3, globs: [{ glob: "a/**", at: 1 }, { glob: "a/**", at: 2 }, { glob: "", at: 1 }, { glob: "b", at: -1 }, null, "c"] })).toEqual({ version: 3, globs: [{ glob: "a/**", at: 1 }] });
    for (const bad of [null, "nope", "{", [], { version: 0, globs: [] }, { version: 1.5, globs: [] }, { version: 1 }]) expect(parseProtectRecord(bad)).toBeUndefined();
  });

  it("only moves forward: the higher version wins, the first on a tie", () => {
    const v3 = { version: 3, globs: [] };
    expect(newerProtect(AUTH, v3)).toBe(v3);
    expect(newerProtect(v3, AUTH)).toBe(v3);
    expect(newerProtect(AUTH, { ...AUTH })).toBe(AUTH);
    expect(newerProtect(undefined, AUTH)).toBe(AUTH);
    expect(newerProtect(AUTH, undefined)).toBe(AUTH);
  });

  it("moves when the globs change: a known glob keeps its time, one protected before any record counts from the start, a new one from now", () => {
    expect(nextProtectRecord(undefined, ["a/**"], ["a/**"], 9_000)).toBeNull();
    expect(nextProtectRecord(AUTH, ["src/auth/**", ".github/**"], [".github/**", "src/auth/**"], 9_000)).toBeNull();
    // The first record: what was protected before it counts from time 0.
    expect(nextProtectRecord(undefined, [".github/**"], [".github/**", "src/auth/**"], 5_000)).toEqual({ ...AUTH, version: 1 });
    expect(nextProtectRecord(AUTH, [".github/**", "src/auth/**"], ["src/auth/**", "docs/**"], 9_000)).toEqual({
      version: 3,
      globs: [
        { glob: "src/auth/**", at: 5_000 },
        { glob: "docs/**", at: 9_000 },
      ],
    });
    // A removal moves the version too; the trunk writer then forgets the glob.
    expect(nextProtectRecord(AUTH, [".github/**", "src/auth/**"], [".github/**"], 9_000)).toEqual({ version: 3, globs: [{ glob: ".github/**", at: 0 }] });
  });
});

describe("the rule: a person's approval at or after the path was protected", () => {
  it("finds when a person last approved a change", () => {
    expect(humanApproval(undefined)).toBeNull();
    expect(humanApproval([{ layer: "llm", action: "land", at: 9_000 }, { layer: "human", action: "reject", at: 9_500 }])).toBeNull();
    expect(humanApproval([{ layer: "human", action: "approve", at: 4_000 }, { layer: "human", action: "approve", at: 7_000 }, { layer: "human", action: "approve" }])).toBe(7_000);
  });

  it("stops a change to a path protected after its last approval, naming the path and the glob, deletions included", () => {
    const p = change("prp_a", { "src/auth/x.ts": "b".repeat(40), "src/lib/y.ts": "c".repeat(40) });
    expect(protectHits(p, AUTH, null)).toEqual([{ path: "src/auth/x.ts", glob: "src/auth/**" }]);
    expect(protectHits(p, AUTH, 4_999)).toEqual([{ path: "src/auth/x.ts", glob: "src/auth/**" }]);
    expect(protectHits(p, AUTH, 5_000)).toEqual([]);
    expect(protectHits(change("prp_d", { "src/auth/old.ts": null }), AUTH, null)).toEqual([{ path: "src/auth/old.ts", glob: "src/auth/**" }]);
    expect(protectHits(change("prp_u", { "src/lib/y.ts": "c".repeat(40) }), AUTH, null)).toEqual([]);
    expect(protectHits(p, undefined, null)).toEqual([]);
  });

  it("counts a path from the earliest glob that protects it, and any approval for a glob older than the record", () => {
    const both: ProtectRecord = { version: 4, globs: [{ glob: "src/auth/x.ts", at: 8_000 }, { glob: "src/**", at: 0 }] };
    const p = change("prp_a", { "src/auth/x.ts": "b".repeat(40) });
    expect(protectHits(p, both, 1)).toEqual([]);
    expect(protectHits(p, both, null)).toEqual([{ path: "src/auth/x.ts", glob: "src/**" }]);
  });

  it("says what happened and what a person does next, and the colony and lanes can tell it from other returns", () => {
    const reason = protectReason([{ path: "src/auth/x.ts", glob: "src/auth/**" }]);
    expect(reason).toBe("newly protected: src/auth/x.ts (protected by src/auth/**) became protected after this change was cleared to land, so a person decides it: approve it to land it, or reject it");
    expect(isProtectStop(reason)).toBe(true);
    expect(isProtectStop("protected paths need a person: src/auth/x.ts (protected by src/auth/**)")).toBe(false);
    expect(isProtectStop(undefined)).toBe(false);
    expect(protectReason(["a", "b", "c", "d"].map((x) => ({ path: `src/auth/${x}.ts`, glob: "src/auth/**" })))).toMatch(/^newly protected: src\/auth\/a\.ts \(protected by src\/auth\/\*\*\), src\/auth\/b\.ts .* and 1 more became protected/);
    expect(protectLandedText(reason)).toBe("landed before the protection of src/auth/x.ts (protected by src/auth/**) reached the trunk writer; ft revert undoes it");
  });

  it("splits a lane batch with the record and each change's recorded decisions", () => {
    const a = change("prp_a", { "src/auth/x.ts": "b".repeat(40) });
    const b = change("prp_b", { "src/auth/y.ts": "b".repeat(40) });
    const c = change("prp_c", { "src/lib/z.ts": "b".repeat(40) });
    const out = splitByProtection([a, b, c], AUTH, { prp_b: [{ layer: "human", action: "approve", at: 6_000 }] });
    expect(out.keep.map((p) => p.id)).toEqual(["prp_b", "prp_c"]);
    expect(out.stopped).toEqual([{ p: a, reason: protectReason([{ path: "src/auth/x.ts", glob: "src/auth/**" }]) }]);
    // No record (an older colony object, or one that never changed its globs): everything goes on.
    expect(splitByProtection([a, b, c], undefined, undefined).keep).toHaveLength(3);
  });
});

describe("protectChanged: the colony's side of a change of globs", () => {
  /** A host over a record, the changes cleared to land, and a trunk writer whose answer the test gives. */
  function host(opts: { record?: ProtectRecord; cleared?: Array<{ p: Proposal; approved: number | null }>; answer?: (ids: string[]) => FenceAnswer | Promise<FenceAnswer>; now?: number } = {}) {
    const log: string[] = [];
    const h = {
      kept: opts.record as ProtectRecord | undefined,
      escalated: [] as Array<{ id: string; reason: string }>,
      settled: [] as string[],
      fenced: [] as Array<{ record: ProtectRecord; ids: string[] }>,
      log,
    };
    const api: ProtectHost = {
      record: () => h.kept,
      keep: (r) => void (h.kept = r),
      now: () => opts.now ?? 9_000,
      cleared: () => opts.cleared ?? [],
      fence: async (record, ids) => {
        log.push("fence");
        h.fenced.push({ record, ids });
        return (opts.answer ?? (() => ({ landed: [], landings: [], undetermined: [] })))(ids);
      },
      escalate: async (items) => {
        log.push("escalate");
        h.escalated.push(...items);
      },
      settle: async (l) => void h.settled.push(l.id),
    };
    return { h, api };
  }

  const landing = (id: string, proposalIds: string[]): Landing => ({ id, colonyId: "col", trunkSha: "3".repeat(40), parentSha: "1".repeat(40), proposalIds, intentIds: [], paths: [], regions: [], at: 8_000 });

  it("does nothing when the globs did not change", async () => {
    const { h, api } = host({ record: AUTH });
    expect(await protectChanged(api, [".github/**", "src/auth/**"], ["src/auth/**", ".github/**"])).toBeNull();
    expect(h.fenced).toEqual([]);
  });

  it("stops the changes cleared to land that a new glob covers, records at the trunk writer before the lanes are told, and says which", async () => {
    const a = change("prp_a", { "src/auth/x.ts": "b".repeat(40) }, "int_a");
    const approved = change("prp_b", { "src/auth/y.ts": "b".repeat(40) });
    const other = change("prp_c", { "src/lib/z.ts": "b".repeat(40) });
    const { h, api } = host({
      record: { version: 1, globs: [{ glob: ".github/**", at: 0 }] },
      cleared: [
        { p: a, approved: null },
        { p: approved, approved: 9_500 },
        { p: other, approved: null },
      ],
    });
    const out = await protectChanged(api, [".github/**"], [".github/**", "src/auth/**"]);
    expect(out).toEqual({ added: ["src/auth/**"], stopped: [{ proposalId: "prp_a", intentId: "int_a", path: "src/auth/x.ts", glob: "src/auth/**" }], landed: [], confirmed: true });
    expect(h.kept).toEqual({ version: 2, globs: [{ glob: ".github/**", at: 0 }, { glob: "src/auth/**", at: 9_000 }] });
    expect(h.fenced).toEqual([{ record: h.kept, ids: ["prp_a"] }]);
    expect(h.log).toEqual(["fence", "escalate"]);
    expect(h.escalated).toEqual([{ id: "prp_a", reason: protectReason([{ path: "src/auth/x.ts", glob: "src/auth/**" }]) }]);
  });

  it("names a change a trunk writer's cycle had already landed, settles its landing, and leaves out what it cannot vouch for", async () => {
    const a = change("prp_a", { "src/auth/x.ts": "b".repeat(40) }, "int_a");
    const b = change("prp_b", { "src/auth/y.ts": "b".repeat(40) }, "int_b");
    const c = change("prp_c", { "src/auth/z.ts": "b".repeat(40) }, "int_c");
    const l = landing("lnd_1", ["prp_a"]);
    const { h, api } = host({
      cleared: [a, b, c].map((p) => ({ p, approved: null })),
      answer: () => ({ landed: [{ proposalId: "prp_a", landingId: "lnd_1", trunkSha: l.trunkSha }], landings: [l], undetermined: ["prp_c"] }),
    });
    const out = await protectChanged(api, [], ["src/auth/**"]);
    expect(out).toEqual({
      added: ["src/auth/**"],
      stopped: [{ proposalId: "prp_b", intentId: "int_b", path: "src/auth/y.ts", glob: "src/auth/**" }],
      landed: [{ proposalId: "prp_a", landingId: "lnd_1", trunkSha: l.trunkSha, intentId: "int_a", path: "src/auth/x.ts", glob: "src/auth/**" }],
      confirmed: false,
      unconfirmed: ["prp_c"],
    });
    expect(h.settled).toEqual(["lnd_1"]);
  });

  it("says unconfirmed when the trunk writer does not answer, the colony's own stop standing", async () => {
    const a = change("prp_a", { "src/auth/x.ts": "b".repeat(40) });
    const { h, api } = host({
      cleared: [{ p: a, approved: null }],
      answer: () => {
        throw new Error("simulated");
      },
    });
    const error = console.error;
    console.error = () => undefined;
    try {
      expect(await protectChanged(api, [], ["src/auth/**"])).toEqual({ added: ["src/auth/**"], stopped: [], landed: [], confirmed: false, unconfirmed: ["prp_a"] });
    } finally {
      console.error = error;
    }
    expect(h.escalated.map((e) => e.id)).toEqual(["prp_a"]);
  });

  it("records a removal with the trunk writer but has nothing to say about it", async () => {
    const { h, api } = host({ record: AUTH });
    expect(await protectChanged(api, [".github/**", "src/auth/**"], [".github/**"])).toBeNull();
    expect(h.fenced).toEqual([{ record: { version: 3, globs: [{ glob: ".github/**", at: 0 }] }, ids: [] }]);
    expect(h.escalated).toEqual([]);
  });
});
