import { describe, expect, it } from "vitest";
import { landingMessage, type LineageNote, type NoteCheck, type Proposal } from "@fire_trident/core";
import { LANDING_IDENTITY } from "../../src/artifacts/git.ts";
import { sealNote, withNoteDigest } from "../../src/trunk/digest.ts";
import { checkCommitSignature, committedAt, flagLateSignatures, splitCommitSignature } from "../../src/trunk/commitsig.ts";
import { signCommit } from "../../src/trunk/gitsig.ts";
import { commitContent } from "../../src/trunk/objects.ts";
import { noteSigner, publishedKeys, withSignature, type NoteSigner } from "../../src/trunk/signature.ts";

/**
 * FireTrident's own check of the full-commit signature (trunk/commitsig.ts): the gpgsig header over the whole commit
 * object, on commits built by the trunk writer's own code (TrunkDO.buildChain's steps), then changed the ways a history
 * rewrite changes them.
 */

async function newKey(extra: Record<string, unknown> = {}): Promise<{ secret: string; signer: NoteSigner }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const secret = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, ...extra });
  return { secret, signer: (await noteSigner(secret))! };
}

const enc = new TextEncoder();
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const PARENT = "2".repeat(40);
const AT = Date.parse("2026-10-17T12:00:00Z");
const proposal = { id: "prp_1", intentId: "int_1", agentId: "agt_1" } as Proposal;
const note: LineageNote = { schema: "firetrident.lineage/v1", landingId: "lnd_1", colonyId: "c", proposals: [] };

/** A landing commit object as the trunk writer builds it, with `edit` applied to its text after signing (a rewrite). */
async function landing(signer: NoteSigner | null, p: { full?: boolean; name?: string; message?: (m: string) => string } = {}): Promise<Uint8Array> {
  const { digest } = await sealNote(note);
  const message = withNoteDigest(await withSignature(landingMessage({ id: "lnd_1", intentIds: ["int_1"] }, [proposal], { int_1: "Add a thing" }), signer, { digest, tree: TREE, parents: [PARENT] }), digest);
  const unsigned = commitContent({ tree: TREE, parents: [PARENT], message, name: LANDING_IDENTITY.name, email: LANDING_IDENTITY.email, timestamp: Math.floor(AT / 1000) });
  return p.full === false ? unsigned : signCommit(unsigned, signer);
}

/** The commit object with its text changed (the gpgsig header copied over as it was). */
function rewrite(raw: Uint8Array, edit: (t: string) => string): Uint8Array {
  return enc.encode(edit(text(raw)));
}

describe("the full-commit signature", () => {
  it("verifies on a commit the trunk writer signed, by its key, inside its window", async () => {
    const k = await newKey({ since: "2026-10-14T00:00:00Z" });
    const raw = await landing(k.signer);
    expect(await checkCommitSignature(raw, await publishedKeys(k.secret), true)).toEqual({ status: "signed", keyId: k.signer.key.id });
    expect(committedAt(raw)).toBe(Math.floor(AT / 1000));
    // What it covers is exactly the object without the header.
    const split = splitCommitSignature(raw);
    expect(split && split !== "many" ? text(split.payload) : null).toBe(text(await landing(k.signer, { full: false })));
  });

  it("reports a message, author or trailer changed after signing as such, where the note signature still verifies", async () => {
    const k = await newKey();
    const keys = await publishedKeys(k.secret);
    const raw = await landing(k.signer);
    const tampered = [
      rewrite(raw, (t) => t.replace("Add a thing", "Add a different thing")),
      rewrite(raw, (t) => t.replace(/^author FireTrident <lanes@firetrident\.dev>/m, "author Mallory <m@example.invalid>")),
      rewrite(raw, (t) => t.replace("FT-Landing: lnd_1", "FT-Landing: lnd_1\nApproved-by: Mallory")),
    ];
    for (const t of tampered) {
      expect(await checkCommitSignature(t, keys, true)).toEqual({
        status: "bad-signature",
        keyId: k.signer.key.id,
        detail: `the full-commit signature does not verify with key ${k.signer.key.id}, while the note signature over its tree, parents and note digest does: the commit's message, author or committer changed after it was signed`,
      });
    }
    expect((await checkCommitSignature(tampered[0]!, keys, false)).detail).toBe(`the full-commit signature does not verify with key ${k.signer.key.id}: the commit changed after it was signed`);
  });

  it("refuses a key the deployment does not publish, one outside its window, a second header and an armor it cannot read", async () => {
    const k = await newKey();
    const other = await newKey();
    const raw = await landing(k.signer);
    expect(await checkCommitSignature(raw, await publishedKeys(other.secret), true)).toEqual({ status: "bad-signature", keyId: k.signer.key.id, detail: `the full-commit signature is by key ${k.signer.key.id}, which this deployment does not publish` });
    // Retired an hour before the commit was made.
    const retired = await publishedKeys(other.secret, JSON.stringify([{ x: k.signer.key.publicKey, until: new Date(AT - 3_600_000).toISOString() }]));
    const outside = await checkCommitSignature(raw, retired, true);
    expect(outside).toMatchObject({ status: "bad-signature", keyId: k.signer.key.id });
    expect(outside.detail).toMatch(/^full-commit signature: the signature is by key [0-9a-f]{16}, which signed from its first commit until .+; this commit is dated .+, outside that window$/);
    const twice = rewrite(raw, (t) => t.replace("\ngpgsig ", "\ngpgsig x\ngpgsig "));
    expect(await checkCommitSignature(twice, await publishedKeys(k.secret), true)).toEqual({ status: "bad-signature", detail: "the commit carries more than one gpgsig header, which the trunk writer never writes" });
    const garbled = rewrite(raw, (t) => t.replace("-----END SSH SIGNATURE-----", "-----END OF IT-----"));
    expect((await checkCommitSignature(garbled, await publishedKeys(k.secret), true)).detail).toBe("the full-commit signature is not an Ed25519 SSH signature in the form the trunk writer writes");
  });

  it("reads a commit without one as signed before full-commit signatures, or unsigned", async () => {
    const k = await newKey();
    const keys = await publishedKeys(k.secret);
    expect(await checkCommitSignature(await landing(k.signer, { full: false }), keys, true)).toEqual({ status: "note-only" });
    expect(await checkCommitSignature(await landing(null), keys, false)).toEqual({ status: "unsigned" });
  });
});

describe("flagLateSignatures", () => {
  const check = (id: string, note: string, full?: string): NoteCheck => ({
    landingId: id,
    trunkSha: id.padEnd(40, "0"),
    at: 1,
    status: "intact",
    signature: { status: note as "signed" },
    ...(full ? { commitSignature: { status: full as "signed" } } : {}),
  });

  it("fails a commit without signatures newer than one that has them, where the deployment signs", () => {
    // Newest first: lnd_4 lacks the full-commit signature lnd_3 has; lnd_2 is unsigned though lnd_1 is signed.
    const checks = [check("lnd_5", "signed", "signed"), check("lnd_4", "signed", "note-only"), check("lnd_3", "signed", "signed"), check("lnd_2", "unsigned", "unsigned"), check("lnd_1", "signed", "note-only"), check("lnd_0", "unsigned", "unsigned")];
    const out = flagLateSignatures(checks, true);
    expect(out.map((c) => [c.landingId, c.signature?.status, c.commitSignature?.status])).toEqual([
      ["lnd_5", "signed", "signed"],
      ["lnd_4", "signed", "bad-signature"],
      ["lnd_3", "signed", "signed"],
      ["lnd_2", "bad-signature", "unsigned"],
      ["lnd_1", "signed", "note-only"],
      ["lnd_0", "unsigned", "unsigned"],
    ]);
    expect(out[1]?.commitSignature?.detail).toBe("this commit has no full-commit signature, though lnd_3, an older landing, has one: it was built while signing failed, or replaced");
    expect(out[3]?.signature?.detail).toBe("this commit is unsigned, though lnd_1, an older landing, is signed: it was built while signing failed, or replaced");
    // A deployment that does not sign now: the checks as they are.
    expect(flagLateSignatures(checks, false)).toBe(checks);
  });
});
