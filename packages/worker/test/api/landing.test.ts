import { describe, expect, it } from "vitest";
import type { Landing, LandingDiff, LineageNote, NotesVerification } from "@fire_trident/core";
import { createApi, type ApiDeps } from "../../src/api/app.ts";
import { DIFF_ANSWER_BYTES, DIFF_IN_FLIGHT, fitHunks, noteBlob } from "../../src/api/landing.ts";
import { fileDiff } from "../../src/decide/diff.ts";
import type { Env } from "../../src/env.ts";

/**
 * Public reads of one landing: its note check (GET /notes/verify?landing=) and the change it made to one file (GET
 * /landings/:ref/diff?path=), served only for colonies that are public already.
 */

const deps: ApiDeps = {
  provisionTrunk: async () => {
    throw new Error("not used");
  },
  spawnSwarm: async () => undefined,
};

const PARENT = "1".repeat(40);
const COMMIT = "2".repeat(40);
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

const LANDING: Landing = { id: "lnd_one", colonyId: "col", trunkSha: COMMIT, parentSha: PARENT, proposalIds: ["prp_1"], intentIds: ["int_1"], paths: ["src/a.ts"], regions: ["src"], at: 5 };

const note = (writes: Array<{ path: string; blob: string | null }>): LineageNote => ({
  schema: "firetrident.lineage/v1",
  landingId: LANDING.id,
  colonyId: "col",
  proposals: [{ id: "prp_1", agentId: "agt_1", agentKind: "external", intent: { id: "int_1", title: "t", why: "w" }, writeSet: writes, readSet: [], decisions: [], evidence: { checks: [] } }],
});

interface World {
  publicGit?: string;
  publicMcp?: string;
  landing?: Landing | null;
  note?: LineageNote | null;
  /** Blob of each path at each commit (baseBlobs). */
  trees?: Record<string, Record<string, string>>;
  /** Blob contents by id (readBlob); absent ids read as null. */
  blobs?: Record<string, string | Uint8Array>;
  /** Holds every landingNote call until it resolves. */
  hold?: Promise<void>;
  checks?: Record<string, NotesVerification>;
}

/** An env with one public (or not) colony, a trunk writer that knows one landing, and a trunk repository of blobs. */
function env(w: World): { env: Env; asked: string[]; reads: string[] } {
  const asked: string[] = [];
  const reads: string[] = [];
  const trunkRef = { namespace: "ft-trunk", name: "col--trunk", remote: "https://example.invalid/col.git" };
  const COLONY = { idFromName: (n: string) => n, get: () => ({ getColony: async () => ({ id: "col", trunk: trunkRef }) }) };
  const TRUNK = {
    idFromName: (n: string) => n,
    get: () => ({
      landingNote: async (ref: string) => {
        asked.push(`landingNote ${ref}`);
        await w.hold;
        const l = w.landing === undefined ? LANDING : w.landing;
        return l && (ref === l.id || l.trunkSha.startsWith(ref)) ? { landing: l, note: w.note === undefined ? note([{ path: "src/a.ts", blob: NEW }]) : w.note } : null;
      },
      baseBlobs: async (sha: string, paths: string[]) => {
        asked.push(`baseBlobs ${sha.slice(0, 1)}`);
        return paths.map((path) => ({ path, blob: w.trees?.[sha]?.[path] ?? null }));
      },
      verifyLanding: async (ref: string) => (asked.push(`verifyLanding ${ref}`), w.checks?.[ref] ?? null),
    }),
  };
  const ARTIFACTS = {
    get: async (name: string) => ({
      readBlob: async (oid: string) => {
        reads.push(`${name} ${oid.slice(0, 1)}`);
        const b = w.blobs?.[oid];
        return b === undefined ? null : new Blob([b]);
      },
    }),
  };
  return { env: { COLONY, TRUNK, ARTIFACTS, FT_PUBLIC_GIT: w.publicGit, FT_PUBLIC_MCP: w.publicMcp } as unknown as Env, asked, reads };
}

const get = async (e: Env, path: string): Promise<{ status: number; json: any; bytes: number }> => {
  const res = await createApi(deps).request(path, {}, e);
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text), bytes: new TextEncoder().encode(text).length };
};

const DIFF = "/colonies/col/landings/lnd_one/diff?path=src/a.ts";

describe("the note check of one landing", () => {
  const answer: NotesVerification = { colonyId: "col", notesTip: "c".repeat(40), notes: [{ landingId: "lnd_one", trunkSha: COMMIT, at: 5, status: "intact", trailer: "d".repeat(64), ownCopy: true }], counts: { intact: 1 }, at: 6 };

  it("answers the trunk writer's check of that landing alone, by landing id or commit, for any colony", async () => {
    const { env: e, asked } = env({ checks: { lnd_one: answer, "2222222": answer } });
    expect(await get(e, "/colonies/col/notes/verify?landing=lnd_one")).toMatchObject({ status: 200, json: answer });
    expect((await get(e, "/colonies/col/notes/verify?landing=2222222&limit=5")).status).toBe(200);
    expect(asked).toEqual(["verifyLanding lnd_one", "verifyLanding 2222222"]);
  });

  it("says what is wrong with an unknown landing or a reference that names none", async () => {
    const { env: e, asked } = env({ checks: {} });
    const unknown = await get(e, "/colonies/col/notes/verify?landing=lnd_gone");
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toBe("no landing lnd_gone in colony col: name a landing by its id or by the trunk commit it made");
    for (const bad of ["", "abc", "lnd_", "HEAD", "2222222x", "z".repeat(41)]) expect((await get(e, `/colonies/col/notes/verify?landing=${bad}`)).status).toBe(400);
    expect(asked).toEqual(["verifyLanding lnd_gone"]);
  });

  it("answers 503 while the trunk writer is still on code without the check", async () => {
    const e = env({}).env as unknown as { TRUNK: { get: () => unknown } };
    e.TRUNK.get = () => ({
      verifyLanding: async () => {
        throw new Error("The RPC receiver does not implement the method \"verifyLanding\".");
      },
    });
    const res = await get(e as unknown as Env, "/colonies/col/notes/verify?landing=lnd_one");
    expect(res.status).toBe(503);
  });
});

describe("a landing's change to one file", () => {
  const trees = { [PARENT]: { "src/a.ts": OLD } };
  const blobs = { [OLD]: "export const a = 1;\nexport const b = 2;\n", [NEW]: "export const a = 1;\nexport const b = 3;\n" };

  it("is served only for colonies listed in FT_PUBLIC_GIT or FT_PUBLIC_MCP", async () => {
    for (const lists of [{ publicGit: "col" }, { publicMcp: "other, col" }]) {
      const res = await get(env({ ...lists, trees, blobs }).env, DIFF);
      expect(res.status).toBe(200);
    }
    const hidden = env({ publicGit: "other", publicMcp: "another", trees, blobs });
    const res = await get(hidden.env, DIFF);
    expect(res.status).toBe(404);
    expect(res.json.error).toMatch(/^colony col does not show file contents here: only colonies listed in FT_PUBLIC_GIT or FT_PUBLIC_MCP do/);
    // Nothing is read for a colony that is not public.
    expect(hidden.asked).toEqual([]);
    expect(hidden.reads).toEqual([]);
    expect((await get(env({ trees, blobs }).env, DIFF)).status).toBe(404);
  });

  it("diffs the note's write-set blob against the parent commit's, read through the binding", async () => {
    const { env: e, asked, reads } = env({ publicGit: "col", trees, blobs });
    const res = await get(e, DIFF);
    expect(res.json).toEqual({
      colonyId: "col",
      landingId: "lnd_one",
      trunkSha: COMMIT,
      parentSha: PARENT,
      path: "src/a.ts",
      before: OLD,
      after: NEW,
      status: "modified",
      added: 1,
      removed: 1,
      hunks: "@@ -1,2 +1,2 @@\n export const a = 1;\n-export const b = 2;\n+export const b = 3;",
      truncated: false,
    } satisfies LandingDiff);
    expect(asked).toEqual(["landingNote lnd_one", "baseBlobs 1"]);
    expect(reads.sort()).toEqual(["col--trunk a", "col--trunk b"]);
    // By the trunk commit's prefix too.
    expect((await get(e, "/colonies/col/landings/2222222/diff?path=src/a.ts")).json.status).toBe("modified");
  });

  it("shows a new file as added and a deleted one as deleted", async () => {
    const added = await get(env({ publicGit: "col", trees: {}, blobs }).env, DIFF);
    expect(added.json).toMatchObject({ status: "added", before: null, after: NEW, added: 2, removed: 0 });
    const deleted = await get(env({ publicGit: "col", trees, blobs, note: note([{ path: "src/a.ts", blob: null }]) }).env, DIFF);
    expect(deleted.json).toMatchObject({ status: "deleted", before: OLD, after: null, added: 0, removed: 2 });
  });

  it("cuts the hunks on a line boundary so the answer stays within 64 KB, and keeps the full counts", async () => {
    // Quotes and characters outside ASCII take more bytes as JSON than as text.
    const lines = (tag: string) => Array.from({ length: 3_000 }, (_, i) => `const "${tag}" = "é ${i} ✓ ${"x".repeat(30)}";`).join("\n") + "\n";
    const big = { [OLD]: lines("before"), [NEW]: lines("after") };
    const res = await get(env({ publicGit: "col", trees, blobs: big }).env, DIFF);
    expect(res.status).toBe(200);
    expect(res.bytes).toBeLessThanOrEqual(DIFF_ANSWER_BYTES);
    expect(res.bytes).toBeGreaterThan(DIFF_ANSWER_BYTES - 200);
    expect(res.json).toMatchObject({ status: "modified", added: 3_000, removed: 3_000, truncated: true });
    const full = fileDiff("src/a.ts", big[OLD]!, big[NEW]!, { maxChars: Number.MAX_SAFE_INTEGER }).hunks;
    const hunks = res.json.hunks as string;
    expect(hunks.endsWith("\n… (truncated)")).toBe(true);
    const kept = hunks.slice(0, -"\n… (truncated)".length);
    expect(full.startsWith(`${kept}\n`)).toBe(true);
  });

  it("refuses a landing without a lineage note, and a file the landing did not change", async () => {
    const missing = await get(env({ publicGit: "col", trees, blobs, note: null }).env, DIFF);
    expect(missing).toMatchObject({ status: 404, json: { error: "landing lnd_one has no lineage note, so there is no write set to read its change from" } });
    const other = await get(env({ publicGit: "col", trees, blobs }).env, "/colonies/col/landings/lnd_one/diff?path=src/b.ts");
    expect(other).toMatchObject({ status: 404, json: { error: "landing lnd_one did not change src/b.ts: ask for a file it wrote" } });
    const gone = await get(env({ publicGit: "col", landing: null }).env, DIFF);
    expect(gone).toMatchObject({ status: 404, json: { error: "no landing lnd_one in colony col: name a landing by its id or by the trunk commit it made" } });
  });

  it("says a binary file has no lines to show, and a file over 512 KB is too large, without diffing them", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const binary = await get(env({ publicGit: "col", trees, blobs: { [OLD]: png, [NEW]: png.map((b, i) => (i === 11 ? 14 : b)) } }).env, DIFF);
    expect(binary.json).toMatchObject({ status: "binary", added: 0, removed: 0, hunks: "", truncated: false, detail: "The file is binary, so there are no lines to show." });
    const latin1 = await get(env({ publicGit: "col", trees, blobs: { [OLD]: "a\n", [NEW]: new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]) } }).env, DIFF);
    expect(latin1.json.status).toBe("binary");
    const large = await get(env({ publicGit: "col", trees, blobs: { [OLD]: "a\n", [NEW]: "b".repeat(512 * 1024 + 1) } }).env, DIFF);
    expect(large.json).toMatchObject({ status: "too-large", hunks: "" });
    expect(large.json.detail).toMatch(/^A version of the file is over 512 KB/);
  });

  it("says when the trunk repository did not return a version, and when the landing left the file as it was", async () => {
    const unreadable = await get(env({ publicGit: "col", trees, blobs: { [OLD]: "a\n" } }).env, DIFF);
    expect(unreadable.json).toMatchObject({ status: "unreadable", hunks: "" });
    const same = await get(env({ publicGit: "col", trees: { [PARENT]: { "src/a.ts": NEW } }, blobs }).env, DIFF);
    expect(same.json).toMatchObject({ status: "unchanged", before: NEW, after: NEW, detail: "This landing left the file as its parent commit had it." });
  });

  it("reads a system commit's file from its own commit when its note lists no write set for it", async () => {
    const revert: LineageNote = { schema: "firetrident.lineage/v1", landingId: "lnd_one", colonyId: "col", proposals: [] };
    const { env: e, asked } = env({ publicGit: "col", note: revert, trees: { ...trees, [COMMIT]: { "src/a.ts": NEW } }, blobs });
    expect((await get(e, DIFF)).json).toMatchObject({ status: "modified", before: OLD, after: NEW, added: 1, removed: 1 });
    expect(asked).toEqual(["landingNote lnd_one", "baseBlobs 2", "baseBlobs 1"]);
  });

  it("asks for a file and a landing reference, and answers 503 past the in-flight cap", async () => {
    const { env: e } = env({ publicGit: "col", trees, blobs });
    expect((await get(e, "/colonies/col/landings/lnd_one/diff")).status).toBe(400);
    expect((await get(e, "/colonies/col/landings/HEAD/diff?path=src/a.ts")).status).toBe(400);
    let release = (): void => undefined;
    const hold = new Promise<void>((r) => (release = r));
    const held = env({ publicGit: "col", trees, blobs, hold }).env;
    const waiting = Array.from({ length: DIFF_IN_FLIGHT }, () => get(held, DIFF));
    await new Promise((r) => setTimeout(r, 20));
    const busy = await get(held, DIFF);
    expect(busy).toMatchObject({ status: 503, json: { error: "busy: too many changes are being read here; retry in a second" } });
    release();
    expect((await Promise.all(waiting)).map((r) => r.status)).toEqual(Array(DIFF_IN_FLIGHT).fill(200));
    expect((await get(held, DIFF)).status).toBe(200);
  });
});

describe("landing diff helpers", () => {
  it("find a path's blob in a note's write sets: deleted is null, unnamed is undefined", () => {
    const n = note([{ path: "a", blob: NEW }, { path: "b", blob: null }]);
    expect([noteBlob(n, "a"), noteBlob(n, "b"), noteBlob(n, "c")]).toEqual([NEW, null, undefined]);
    expect(noteBlob({ proposals: [null, { writeSet: "x" }] } as unknown as LineageNote, "a")).toBeUndefined();
  });

  it("leave an answer that fits as it is, and cut to the marker alone when no line fits", () => {
    const base: LandingDiff = { colonyId: "c", landingId: "l", trunkSha: COMMIT, parentSha: PARENT, path: "p", before: null, after: NEW, status: "added", added: 1, removed: 0, hunks: "@@ -0,0 +1,1 @@\n+x", truncated: false };
    expect(fitHunks(base, 10_000)).toBe(base);
    const tight = fitHunks({ ...base, hunks: `@@ -0,0 +1,1 @@\n+${"y".repeat(500)}` }, 330);
    expect(tight).toMatchObject({ hunks: "@@ -0,0 +1,1 @@\n… (truncated)", truncated: true });
    expect(new TextEncoder().encode(JSON.stringify(tight)).length).toBeLessThanOrEqual(330);
  });
});
