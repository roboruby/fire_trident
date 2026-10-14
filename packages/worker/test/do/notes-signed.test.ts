import { describe, expect, it } from "vitest";
import git from "isomorphic-git";
import type { Sha } from "@fire_trident/core";
import { resolveLocal, type GitRepo } from "../../src/artifacts/git.ts";
import { sha256Hex, trailerDigest } from "../../src/trunk/digest.ts";
import { addNotes } from "../../src/trunk/notes.ts";
import { checkSignature, publishedKeys } from "../../src/trunk/signature.ts";
import { withPublisher } from "./publisher.ts";
import { landed, withWriter } from "./writer.ts";

/**
 * Signed lineage notes through the real trunk writer: with FT_NOTE_KEY set, each landing commit and each system commit
 * carries its signature just above the FT-Note trailer, and verifyNotes and verifyLanding say whether each commit is
 * signed. Without it, commits are built exactly as before. The trunk repository's notes ref is stood in for by a local ref.
 */

/** The private parts of the writer the test reads or stands in for, and the env it was made with. */
interface Internals {
  repo(): GitRepo;
  sql: SqlStorage;
  remoteNotesTip(): Promise<Sha | null>;
  env: Record<string, unknown>;
}

const REMOTE = "refs/notes/remote-copy";

/** A fresh Ed25519 key as FT_NOTE_KEY holds it (generated here: no private key is part of the repository). */
async function newKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x });
}

async function commitOf(g: GitRepo, sha: Sha): Promise<{ tree: string; parents: string[]; message: string; lines: string[] }> {
  const c = (await git.readCommit({ fs: g.fs, dir: g.dir, oid: sha })).commit;
  return { tree: c.tree, parents: c.parent, message: c.message, lines: c.message.trimEnd().split("\n") };
}

describe("signed lineage notes through the trunk writer", () => {
  it("sign each landing commit once FT_NOTE_KEY holds a key, and the note checks say which commits are signed", async () => {
    await withWriter({ "src/a.ts": "export const a = 1;\n" }, undefined, async (w) => {
      const t = w.trunk as unknown as Internals;
      const g = t.repo();
      let tip: Sha | null = null;
      t.remoteNotesTip = async () => tip;
      const stored = (id: string): string => t.sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", id).one().note;
      const publish = async (...ls: Array<{ id: string; trunkSha: Sha }>): Promise<void> => {
        await addNotes(g, { ref: REMOTE, notes: ls.map((l) => ({ oid: l.trunkSha, note: stored(l.id) })), at: Date.now(), migrate: 0 });
        tip = await resolveLocal(g, REMOTE);
      };

      // No key: the commit is built exactly as before, and the checks say nothing about signatures.
      const before = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 2;\n" })));
      expect((await commitOf(g, before.trunkSha)).lines.slice(-2)).toEqual(["FT-Agent: agt_test", `FT-Note: sha256:${await sha256Hex(stored(before.id))}`]);
      await publish(before);
      expect((await w.trunk.verifyNotes()).notes[0]).not.toHaveProperty("signature");

      // The key set (a deploy with the secret): the next landing is signed.
      const secret = await newKey();
      t.env.FT_NOTE_KEY = secret;
      const [key] = await publishedKeys(secret);
      const after = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 3;\n" })));
      const c = await commitOf(g, after.trunkSha);
      expect(c.lines.at(-3)).toBe("FT-Agent: agt_test");
      expect(c.lines.at(-2)).toMatch(new RegExp(`^FT-Note-Signature: ed25519 ${key!.id} [A-Za-z0-9_-]{86}$`));
      expect(c.lines.at(-1)).toBe(`FT-Note: sha256:${await sha256Hex(stored(after.id))}`);
      expect(trailerDigest(c.message)).toBe(await sha256Hex(stored(after.id)));
      expect(c.parents).toEqual([before.trunkSha]);
      expect(await checkSignature(c, [key!])).toEqual({ status: "signed", keyId: key!.id });

      await publish(after);
      const v = await w.trunk.verifyNotes();
      expect(v.notes.map((n) => [n.landingId, n.status, n.signature])).toEqual([
        [after.id, "intact", { status: "signed", keyId: key!.id }],
        [before.id, "intact", { status: "unsigned" }],
      ]);
      expect((await w.trunk.verifyLanding(after.id))?.notes[0]).toMatchObject({ landingId: after.id, status: "intact", signature: { status: "signed", keyId: key!.id } });

      // The key replaced: what the old key signed no longer checks against the published keys.
      t.env.FT_NOTE_KEY = await newKey();
      expect((await w.trunk.verifyLanding(after.id))?.notes[0]?.signature).toMatchObject({ status: "bad-signature", keyId: key!.id });
    });
  });

  it("sign a system commit the same way", async () => {
    await withPublisher({ "src/a.ts": "a\n" }, { publish: "on" }, async (w) => {
      const secret = await newKey();
      (w.trunk as unknown as Internals).env.FT_NOTE_KEY = secret;
      const [key] = await publishedKeys(secret);
      const sys = await w.systemCommit(".firetrident/antibodies/ab_1.json", '{"id":"ab_1"}\n');
      const text = w.rows<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", sys.id)[0]!.note;
      const c = await commitOf((w.trunk as unknown as Internals).repo(), sys.trunkSha);
      expect(c.lines.slice(-3, -1)).toEqual([`FT-Landing: ${sys.id}`, expect.stringMatching(new RegExp(`^FT-Note-Signature: ed25519 ${key!.id} `))]);
      expect(c.lines.at(-1)).toBe(`FT-Note: sha256:${await sha256Hex(text)}`);
      expect(await checkSignature(c, [key!])).toEqual({ status: "signed", keyId: key!.id });
      await w.settle();
    });
  });
});
