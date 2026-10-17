import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import git from "isomorphic-git";
import type { Sha } from "@fire_trident/core";
import { resolveLocal, type GitRepo } from "../../src/artifacts/git.ts";
import { addNotes } from "../../src/trunk/notes.ts";
import { publishedKeys } from "../../src/trunk/signature.ts";
import { gitSignatureGood, splitSigned } from "../trunk/sshsig-check.ts";
import { addAgent, colony, newColony } from "./helpers.ts";
import { withPublisher } from "./publisher.ts";
import { landed, withWriter } from "./writer.ts";

/**
 * The trunk writer's lineage builds through the real TrunkDO: with FT_NOTE_KEY set, each landing and system commit also
 * carries a gpgsig header, an SSH signature by the same key (trunk/gitsig.ts; stock git checks it in
 * test/trunk/gitsig.test.ts); FT_NOTE_KEYS_RETIRED keeps a rotated key's signatures good (trunk/signature.ts); and
 * FT_CREDIT_TRAILERS adds Co-authored-by and Approved-by above the FT trailers (trunk/credits.ts).
 */

/** The private parts of the writer the test reads or stands in for, and the env it was made with. */
interface Internals {
  repo(): GitRepo;
  sql: SqlStorage;
  remoteNotesTip(): Promise<Sha | null>;
  env: Record<string, unknown>;
}

const REMOTE = "refs/notes/remote-copy";

/** A fresh Ed25519 key as FT_NOTE_KEY holds it (generated here: no private key is part of the repository), and its public half. */
async function newKey(): Promise<{ secret: string; x: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { secret: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x }), x: jwk.x! };
}

const bytesOf = (b64url: string): Uint8Array => Uint8Array.from(atob(b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

async function rawCommit(g: GitRepo, sha: Sha): Promise<Uint8Array> {
  return (await git.readObject({ fs: g.fs, dir: g.dir, oid: sha, format: "content" })).object as Uint8Array;
}

async function messageLines(g: GitRepo, sha: Sha): Promise<string[]> {
  return (await git.readCommit({ fs: g.fs, dir: g.dir, oid: sha })).commit.message.trimEnd().split("\n");
}

describe("stock git signatures, the key ring and credit trailers through the trunk writer", () => {
  it("signs each landing commit the git way once FT_NOTE_KEY holds a key, and builds it exactly as before without one", async () => {
    await withWriter({ "src/a.ts": "export const a = 1;\n" }, undefined, async (w) => {
      const t = w.trunk as unknown as Internals;
      const g = t.repo();
      const before = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 2;\n" })));
      expect(new TextDecoder().decode(await rawCommit(g, before.trunkSha))).not.toContain("gpgsig");

      const k = await newKey();
      t.env.FT_NOTE_KEY = k.secret;
      const after = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 3;\n" })));
      const raw = await rawCommit(g, after.trunkSha);
      expect(await gitSignatureGood(raw, bytesOf(k.x))).toBe(true);
      // What the signature covers is the commit object the writer built: tree, parent, author, committer, message.
      const payload = new TextDecoder().decode(splitSigned(raw)!.payload);
      expect(payload).toMatch(new RegExp(`^tree [0-9a-f]{40}\nparent ${before.trunkSha}\nauthor FireTrident <lanes@firetrident.dev> \\d+ \\+0000\ncommitter FireTrident <lanes@firetrident.dev> \\d+ \\+0000\n\nLand 1 change`));
      // A different key does not verify it.
      expect(await gitSignatureGood(raw, bytesOf((await newKey()).x))).toBe(false);
      // The next landing builds on it: trunk's own reads take the signed commit as an ordinary one.
      const third = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 4;\n" })));
      expect((await git.readCommit({ fs: g.fs, dir: g.dir, oid: third.trunkSha })).commit.parent).toEqual([after.trunkSha]);
      expect(await gitSignatureGood(await rawCommit(g, third.trunkSha), bytesOf(k.x))).toBe(true);
    });
  });

  it("signs a system commit the git way too", async () => {
    await withPublisher({ "src/a.ts": "a\n" }, { publish: "on" }, async (w) => {
      const k = await newKey();
      (w.trunk as unknown as Internals).env.FT_NOTE_KEY = k.secret;
      const sys = await w.systemCommit(".firetrident/antibodies/ab_1.json", '{"id":"ab_1"}\n');
      const raw = await rawCommit((w.trunk as unknown as Internals).repo(), sys.trunkSha);
      expect(await gitSignatureGood(raw, bytesOf(k.x))).toBe(true);
      await w.settle();
    });
  });

  it("keeps a rotated key's signatures good while FT_NOTE_KEYS_RETIRED lists it, for the commits made while it signed", async () => {
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
      const old = await newKey();
      t.env.FT_NOTE_KEY = old.secret;
      const [oldKey] = await publishedKeys(old.secret);
      const first = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 2;\n" })));
      await publish(first);

      // The key rotated, the old one listed as retired until a while after the switch: both landings check out.
      const now = await newKey();
      t.env.FT_NOTE_KEY = now.secret;
      t.env.FT_NOTE_KEYS_RETIRED = JSON.stringify([{ x: old.x, until: new Date(Date.now() + 3_600_000).toISOString() }]);
      const [nowKey] = await publishedKeys(now.secret);
      const second = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 3;\n" })));
      await publish(second);
      const v = await w.trunk.verifyNotes();
      expect(v.notes.map((n) => [n.landingId, n.status, n.signature])).toEqual([
        [second.id, "intact", { status: "signed", keyId: nowKey!.id }],
        [first.id, "intact", { status: "signed", keyId: oldKey!.id }],
      ]);
      expect(await gitSignatureGood(await rawCommit(g, second.trunkSha), bytesOf(now.x))).toBe(true);

      // Listed as retired before the first landing was made: that landing falls outside the old key's window.
      t.env.FT_NOTE_KEYS_RETIRED = JSON.stringify([{ x: old.x, until: new Date(first.at - 60_000).toISOString() }]);
      const outside = (await w.trunk.verifyLanding(first.id))?.notes[0]?.signature;
      expect(outside).toMatchObject({ status: "bad-signature", keyId: oldKey!.id });
      expect(outside?.detail).toMatch(new RegExp(`^the signature is by key ${oldKey!.id}, which signed from its first commit until .+; this commit is dated .+, outside that window$`));
    });
  });

  it("adds Co-authored-by and Approved-by above the FT trailers where FT_CREDIT_TRAILERS covers the colony", async () => {
    await withWriter({ "src/a.ts": "export const a = 1;\n" }, undefined, async (w) => {
      const t = w.trunk as unknown as Internals;
      const g = t.repo();
      const colony = t.sql.exec<{ value: string }>("SELECT value FROM ft_meta WHERE key = 'colony_id'").one().value;
      const p = await w.proposal({ "src/a.ts": "export const a = 2;\n" });
      // The land context as the colony sends it with the flag on: the agent's name, and a person's approval of the change.
      const human = [{ kind: "triage" as const, layer: "human" as const, p: 1, action: "approve" as const, by: "Dana Reviewer" }];
      const ctx = (proposalId: string) => ({ agents: { agt_test: { kind: "external" as const, model: "m", name: "scout" } }, decisions: { [proposalId]: human } });
      // Off: the message is as before, whatever the land context says.
      const plain = landed(await w.trunk.land([p], ctx(p.id)));
      expect((await messageLines(g, plain.trunkSha)).filter((l) => /^(Co-authored-by|Approved-by):/.test(l))).toEqual([]);

      t.env.FT_CREDIT_TRAILERS = colony;
      t.env.FT_NOTE_KEY = (await newKey()).secret;
      const q = await w.proposal({ "src/a.ts": "export const a = 3;\n" });
      const credited = landed(await w.trunk.land([q], ctx(q.id)));
      const lines = await messageLines(g, credited.trunkSha);
      const start = lines.indexOf(`Co-authored-by: scout <agt_test@${colony.replace(/_/g, "-")}.noreply.firetrident.dev>`);
      expect(start).toBeGreaterThan(0);
      expect(lines[start - 1]).toBe("");
      expect(lines.slice(start + 1, start + 3)).toEqual(["Approved-by: Dana Reviewer", `FT-Landing: ${credited.id}`]);
      expect(lines.at(-2)).toMatch(/^FT-Note-Signature: ed25519 /);
      expect(lines.at(-1)).toMatch(/^FT-Note: sha256:[0-9a-f]{64}$/);
      // The note itself is unchanged in form: credits live in the commit message only.
      expect(t.sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", credited.id).one().note).not.toContain("Co-authored-by");
    });
  });

  it("has the colony send each agent's name in the land context only where FT_CREDIT_TRAILERS covers it", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "scout");
    type Context = { agents: Record<string, { name?: string }> };
    await runInDurableObject(colony(c.id), async (instance: unknown) => {
      const o = instance as { env: Record<string, unknown>; landContext(i: string[], a: string[], p: string[]): Promise<Context> };
      expect((await o.landContext([], [a.id], [])).agents[a.id]).not.toHaveProperty("name");
      o.env.FT_CREDIT_TRAILERS = `other,${c.id}`;
      expect((await o.landContext([], [a.id], [])).agents[a.id]).toMatchObject({ name: "scout" });
      delete o.env.FT_CREDIT_TRAILERS;
    });
  });
});
