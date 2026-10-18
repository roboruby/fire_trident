import { describe, expect, it, vi } from "vitest";
import git from "isomorphic-git";
import type { Sha } from "@fire_trident/core";
import { resolveLocal, writeCommitObject, type GitRepo } from "../../src/artifacts/git.ts";
import { addNotes } from "../../src/trunk/notes.ts";
import { noteSigner, publishedKeys } from "../../src/trunk/signature.ts";
import { landed, withWriter, type Writer } from "./writer.ts";

/**
 * The note checks against main through the real trunk writer (trunk/onmain.ts, trunk/commitsig.ts): each landing says
 * whether main, as the trunk repository advertises it, still reaches its commit, so a force-push that rewrote or dropped
 * landings fails the check; each signed commit's full-commit signature is checked; a key that is set and cannot sign is
 * reported; and a signature that fails at landing time holds the cycle instead of landing unsigned. The trunk repository's
 * refs are stood in for (the notes ref by a local ref the test writes, main by a commit the test names).
 */

/** The private parts of the writer the test reads or stands in for. */
interface Internals {
  repo(): GitRepo;
  sql: SqlStorage;
  env: Record<string, unknown>;
  remoteNotesTip(): Promise<Sha | null>;
  remoteMainTip(): Promise<Sha | null>;
}

const REMOTE = "refs/notes/remote-copy";

async function newKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x });
}

/** The trunk repository stood in for: `notes` publishes landings' notes, `main` is where its main points. */
function remote(w: Writer): { t: Internals; g: GitRepo; main: { tip: Sha | null }; publish: (...ls: Array<{ id: string; trunkSha: Sha }>) => Promise<void> } {
  const t = w.trunk as unknown as Internals;
  const g = t.repo();
  let notes: Sha | null = null;
  const main = { tip: null as Sha | null };
  t.remoteNotesTip = async () => notes;
  t.remoteMainTip = async () => main.tip;
  const stored = (id: string): string => t.sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", id).one().note;
  return {
    t,
    g,
    main,
    publish: async (...ls) => {
      await addNotes(g, { ref: REMOTE, notes: ls.map((l) => ({ oid: l.trunkSha, note: stored(l.id) })), at: Date.now(), migrate: 0 });
      notes = await resolveLocal(g, REMOTE);
    },
  };
}

describe("the note checks against main", () => {
  it("pass landings main reaches, and fail the ones a force-push rewrote or dropped, saying how", async () => {
    await withWriter({ "src/a.ts": "export const a = 1;\n" }, undefined, async (w) => {
      const r = remote(w);
      const l1 = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 2;\n" })));
      const l2 = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 3;\n" })));
      const l3 = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 4;\n" })));
      await r.publish(l1, l2, l3);
      r.main.tip = l3.trunkSha;
      let v = await w.trunk.verifyNotes();
      expect(v.mainTip).toBe(l3.trunkSha);
      expect(v.notes.map((n) => [n.landingId, n.status, n.main])).toEqual([
        [l3.id, "intact", { status: "on-main" }],
        [l2.id, "intact", { status: "on-main" }],
        [l1.id, "intact", { status: "on-main" }],
      ]);

      // The operator force-pushes main: the newest landing's commit again with another message, same files and parent.
      const c3 = (await git.readCommit({ fs: r.g.fs, dir: r.g.dir, oid: l3.trunkSha })).commit;
      const forged = await writeCommitObject(r.g, { tree: c3.tree, parents: c3.parent, message: c3.message.replace("Land 1 change", "Land 1 harmless change"), at: c3.committer.timestamp * 1000 });
      r.main.tip = forged;
      v = await w.trunk.verifyNotes();
      const s = (x: Sha): string => x.slice(0, 12);
      expect(v.notes[0]).toMatchObject({
        landingId: l3.id,
        status: "dropped",
        main: { status: "dropped", replacedBy: forged },
        detail: `main (at ${s(forged)}) was rewritten: ${s(forged)} on main now stands for this landing, with its message changed, and main no longer reaches the commit it landed as`,
      });
      expect(v.notes.slice(1).map((n) => [n.status, n.main?.status])).toEqual([
        ["intact", "on-main"],
        ["intact", "on-main"],
      ]);
      expect(v.counts).toEqual({ dropped: 1, intact: 2 });
      expect((await w.trunk.verifyLanding(l3.id))?.notes[0]).toMatchObject({ status: "dropped", main: { replacedBy: forged } });
      expect((await w.trunk.verifyLanding(l1.id))?.notes[0]).toMatchObject({ status: "intact", main: { status: "on-main" } });

      // Main reset to the first landing: the two newest are dropped, with nothing standing for them.
      r.main.tip = l1.trunkSha;
      v = await w.trunk.verifyNotes();
      expect(v.notes.map((n) => [n.landingId, n.status])).toEqual([
        [l3.id, "dropped"],
        [l2.id, "dropped"],
        [l1.id, "intact"],
      ]);
      expect(v.notes[1]?.detail).toBe(`main (at ${s(l1.trunkSha)}) no longer reaches this landing's commit: it was dropped from main, or main was rewritten`);

      // A landing recorded and not published yet is pending on main, not dropped (its note was pushed ahead here).
      t(r).sql.exec("INSERT INTO ft_journal (landing_id, state, commit_sha, parent_sha, data, created_at, updated_at) VALUES (?, 'recorded', ?, ?, '{}', 0, 0)", l3.id, l3.trunkSha, l2.trunkSha);
      r.main.tip = l2.trunkSha;
      v = await w.trunk.verifyNotes();
      expect(v.notes.map((n) => [n.status, n.main?.status])).toEqual([
        ["intact", "pending"],
        ["intact", "on-main"],
        ["intact", "on-main"],
      ]);
      t(r).sql.exec("DELETE FROM ft_journal");

      // No main at all, and a main that cannot be read (every landing unchecked, nothing failed on it).
      r.main.tip = null;
      expect((await w.trunk.verifyNotes()).notes.map((n) => n.detail)).toEqual(Array(3).fill("the trunk repository has no main branch, so main does not reach this landing's commit"));
      r.t.remoteMainTip = async () => Promise.reject(new Error("connection reset"));
      v = await w.trunk.verifyNotes();
      expect(v.notes.map((n) => [n.status, n.main])).toEqual(Array(3).fill(["intact", { status: "unchecked", detail: "main could not be read from the trunk repository: connection reset" }]));
      expect(v).not.toHaveProperty("mainTip");
    });
  });

  it("check each signed commit's full-commit signature, and report a key that is set and cannot sign", async () => {
    await withWriter({ "src/a.ts": "export const a = 1;\n" }, undefined, async (w) => {
      const r = remote(w);
      const before = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 2;\n" })));
      const secret = await newKey();
      r.t.env.FT_NOTE_KEY = secret;
      const [key] = await publishedKeys(secret);
      const l1 = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 3;\n" })));
      const l2 = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 4;\n" })));
      await r.publish(before, l1, l2);
      r.main.tip = l2.trunkSha;
      let v = await w.trunk.verifyNotes();
      expect(v.notes.map((n) => [n.landingId, n.signature?.status, n.commitSignature])).toEqual([
        [l2.id, "signed", { status: "signed", keyId: key!.id }],
        [l1.id, "signed", { status: "signed", keyId: key!.id }],
        [before.id, "unsigned", { status: "unsigned" }],
      ]);
      expect(v).not.toHaveProperty("signingProblem");

      vi.spyOn(console, "error").mockImplementation(() => undefined);
      r.t.env.FT_NOTE_KEY = "not json";
      v = await w.trunk.verifyNotes();
      expect(v.signingProblem).toMatch(/^FT_NOTE_KEY is set but cannot sign \(it is not JSON\), so landings go out unsigned: set it to an Ed25519 private key as a JWK/);
      vi.restoreAllMocks();
    });
  });

  it("hold a cycle whose signature fails instead of landing it unsigned, and land it signed on the next try", async () => {
    await withWriter({ "src/a.ts": "export const a = 1;\n" }, undefined, async (w) => {
      const r = remote(w);
      const secret = await newKey();
      r.t.env.FT_NOTE_KEY = secret;
      await noteSigner(secret);
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const sign = vi.spyOn(crypto.subtle, "sign").mockRejectedValueOnce(new TypeError("no"));
      const count = (): number => r.t.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ft_landings").one().n;
      const p = await w.proposal({ "src/a.ts": "export const a = 2;\n" });
      await expect(w.land(p)).rejects.toThrow(/^a trunk commit's lineage note was not signed, so it was held: signing failed \(TypeError\); its changes are tried again/);
      expect(count()).toBe(0);
      expect((await w.cycles()).at(-1)?.error).toMatch(/was not signed, so it was held/);
      expect(log.mock.calls.some((c) => String(c[0]).includes("was not signed, so it was held"))).toBe(true);
      sign.mockRestore();
      const l = landed(await w.land(p));
      await r.publish(l);
      r.main.tip = l.trunkSha;
      expect((await w.trunk.verifyNotes()).notes[0]).toMatchObject({ status: "intact", signature: { status: "signed" }, commitSignature: { status: "signed" }, main: { status: "on-main" } });
      vi.restoreAllMocks();
    });
  });
});

function t(r: { t: Internals }): Internals {
  return r.t;
}
