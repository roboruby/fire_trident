import { afterEach, describe, expect, it, vi } from "vitest";
import { landingMessage } from "@fire_trident/core";
import type { LineageNote, Proposal } from "@fire_trident/core";
import { sealNote, trailerDigest, withNoteDigest } from "../../src/trunk/digest.ts";
import { KEYS_PATH, SIGNATURE_TRAILER, checkSignature, keyIdOf, keysResponse, noteKeyId, noteSigner, publishedKeys, signedText, withSignature } from "../../src/trunk/signature.ts";

/** Signed lineage notes: the trunk writer's FT-Note-Signature trailer, its published key, and the check of both. */

/** A fresh Ed25519 key as FT_NOTE_KEY holds it: generated here, so no private key is ever part of the repository. */
async function newKey(extra: Record<string, unknown> = {}): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, ...extra });
}

const bytesOf = (b64url: string): Uint8Array => Uint8Array.from(atob(b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

const note: LineageNote = { schema: "firetrident.lineage/v1", landingId: "lnd_1", colonyId: "c", proposals: [] };
const TREE = "1".repeat(40);
const PARENT = "2".repeat(40);
const proposal = { id: "prp_1", intentId: "int_1", agentId: "agt_1" } as Proposal;

/** A landing commit's message as the trunk writer builds it: the landing message, the signature line, FT-Note last. */
async function landingCommit(secret: string | undefined, over: { tree?: string; parent?: string } = {}): Promise<{ message: string; digest: string; tree: string; parents: string[] }> {
  const { digest } = await sealNote(note);
  const tree = over.tree ?? TREE;
  const parents = [over.parent ?? PARENT];
  const base = landingMessage({ id: "lnd_1", intentIds: ["int_1"] }, [proposal], { int_1: "Add a thing" });
  return { message: withNoteDigest(await withSignature(base, await noteSigner(secret), { digest, tree, parents }), digest), digest, tree, parents };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signing a landing commit", () => {
  it("puts the signature just above FT-Note, which stays the last line, and the published key checks it", async () => {
    const secret = await newKey();
    const signer = await noteSigner(secret);
    expect(signer).not.toBeNull();
    const key = signer!.key;
    expect(key).toMatchObject({ alg: "Ed25519", publicKey: JSON.parse(secret).x, since: null });
    expect(key.id).toMatch(/^[0-9a-f]{16}$/);
    expect(key.id).toBe(await keyIdOf(bytesOf(key.publicKey)));

    const c = await landingCommit(secret);
    const lines = c.message.split("\n");
    expect(lines.at(-1)).toBe(`FT-Note: sha256:${c.digest}`);
    expect(lines.at(-2)).toMatch(new RegExp(`^${SIGNATURE_TRAILER}: ed25519 ${key.id} [A-Za-z0-9_-]{86}$`));
    expect(lines.at(-3)).toBe("FT-Agent: agt_1");
    expect(trailerDigest(c.message)).toBe(c.digest);
    expect(await checkSignature({ tree: c.tree, parents: c.parents, message: c.message }, [key])).toEqual({ status: "signed", keyId: key.id });
    // A commit reader that hands the message back with a final newline reads the same.
    expect((await checkSignature({ tree: c.tree, parents: c.parents, message: `${c.message}\n` }, [key]))?.status).toBe("signed");

    // The signature is plain Ed25519 over the documented text, so any client can check it with the published key alone.
    expect(signedText({ digest: c.digest, tree: TREE, parents: [PARENT] })).toBe(`firetrident-note-signature v1\n${c.digest}\n${TREE}\n${PARENT}\n`);
    const publicKey = await crypto.subtle.importKey("raw", bytesOf(key.publicKey), { name: "Ed25519" }, false, ["verify"]);
    const signature = bytesOf(lines.at(-2)!.split(" ").at(-1)!);
    expect(await crypto.subtle.verify("Ed25519", publicKey, signature, new TextEncoder().encode(signedText({ digest: c.digest, tree: TREE, parents: [PARENT] })))).toBe(true);
  });

  it("finds a tampered note digest, tree, parent, signature or key id", async () => {
    const secret = await newKey();
    const key = (await noteSigner(secret))!.key;
    const c = await landingCommit(secret);
    const check = (message: string, over: { tree?: string; parents?: string[] } = {}) => checkSignature({ tree: over.tree ?? c.tree, parents: over.parents ?? c.parents, message }, [key]);
    // The note rewritten, and its trailer rewritten to match (the digest alone cannot tell): the signature can.
    const { digest: forged } = await sealNote({ ...note, colonyId: "elsewhere" });
    const rewritten = c.message.replace(`FT-Note: sha256:${c.digest}`, `FT-Note: sha256:${forged}`);
    expect(trailerDigest(rewritten)).toBe(forged);
    expect(await check(rewritten)).toEqual({ status: "bad-signature", keyId: key.id, detail: expect.stringMatching(/^the signature does not verify with key [0-9a-f]{16}: the note digest, tree or parent/) });
    // The same message on another tree or another parent.
    expect((await check(c.message, { tree: "3".repeat(40) }))?.status).toBe("bad-signature");
    expect((await check(c.message, { parents: ["4".repeat(40)] }))?.status).toBe("bad-signature");
    expect((await check(c.message, { parents: [] }))?.status).toBe("bad-signature");
    // One character of the signature changed.
    const line = c.message.split("\n").at(-2)!;
    const last = line.at(-2) === "A" ? "B" : "A";
    expect((await check(c.message.replace(line, `${line.slice(0, -2)}${last}${line.at(-1)}`)))?.status).toBe("bad-signature");
    // A key id this deployment does not publish, and a key that is not this commit's.
    expect(await check(c.message.replace(key.id, "f".repeat(16)))).toEqual({ status: "bad-signature", keyId: "f".repeat(16), detail: `the signature names key ${"f".repeat(16)}, which this deployment does not publish` });
    const other = (await noteSigner(await newKey()))!.key;
    expect((await checkSignature({ tree: c.tree, parents: c.parents, message: c.message }, [other]))?.status).toBe("bad-signature");
    // A signature line not in the trunk writer's form.
    expect(await check(c.message.replace(line, `${SIGNATURE_TRAILER}: ed25519 ${key.id}`))).toEqual({ status: "bad-signature", detail: "the FT-Note-Signature trailer is not in the form the trunk writer writes" });
  });

  it("reads a commit with no signature just above a last-line FT-Note as unsigned, and one it cannot place as unknown", async () => {
    const secret = await newKey();
    const key = (await noteSigner(secret))!.key;
    const signed = await landingCommit(secret);
    const sigLine = signed.message.split("\n").at(-2)!;
    const unsigned = await landingCommit(undefined);
    expect(await checkSignature({ tree: TREE, parents: [PARENT], message: unsigned.message }, [key])).toEqual({ status: "unsigned" });
    // Before notes were sealed: no FT-Note trailer at all.
    expect(await checkSignature({ tree: TREE, parents: [PARENT], message: "Land 1 change: x\n\nFT-Landing: lnd_0" }, [key])).toEqual({ status: "unsigned" });
    // A signature line anywhere else (an intent title cannot put one there: titles are one line in the subject) does not count.
    expect(await checkSignature({ tree: TREE, parents: [PARENT], message: `${sigLine}\n\n${unsigned.message}` }, [key])).toEqual({ status: "unsigned" });
    expect(await checkSignature({ tree: TREE, parents: [PARENT], message: `${signed.message}\nFT-Other: x` }, [key])).toEqual({ status: "unsigned" });
    // A source that does not say the commit's parents cannot check it.
    expect(await checkSignature({ tree: TREE, message: signed.message }, [key])).toBeNull();
  });
});

describe("without a usable key", () => {
  it("leaves the commit message exactly as before, unsigned", async () => {
    const { digest } = await sealNote(note);
    const base = landingMessage({ id: "lnd_1", intentIds: ["int_1"] }, [proposal], { int_1: "Add a thing" });
    for (const secret of [undefined, "", "   "]) {
      expect(await noteSigner(secret)).toBeNull();
      expect((await landingCommit(secret)).message).toBe(withNoteDigest(base, digest));
    }
    expect(await withSignature(base, null, { digest, tree: TREE, parents: [PARENT] })).toBe(base);
    expect(await publishedKeys(undefined)).toEqual([]);
    expect(await noteKeyId(undefined)).toBeNull();
  });

  it("ignores a secret that is not an Ed25519 private key with matching halves, says why once, and never prints it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const a = JSON.parse(await newKey()) as Record<string, string>;
    const b = JSON.parse(await newKey()) as Record<string, string>;
    const bad = [
      "not json at all",
      JSON.stringify([a]),
      JSON.stringify({ ...a, crv: "P-256" }),
      JSON.stringify({ ...a, d: undefined }),
      JSON.stringify({ ...a, x: "short" }),
      // Two keys' halves: the published key would not check what it signs.
      JSON.stringify({ ...a, x: b.x }),
    ];
    for (const secret of bad) {
      expect(await noteSigner(secret)).toBeNull();
      expect(await noteSigner(secret)).toBeNull();
    }
    expect(log).toHaveBeenCalledTimes(bad.length);
    const said = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toMatch(/^FT_NOTE_KEY is set but not used, so landings stay unsigned: it is not JSON\. It must be an Ed25519 private key as a JWK/);
    // Mismatched halves: a runtime that checks them refuses the import; one that does not fails the signing probe.
    expect(String(log.mock.calls.at(-1)?.[0])).toMatch(/: (its private half \("d"\) does not match its public half \("x"\)|the runtime refused it as an Ed25519 private key)\./);
    for (const k of [a, b]) expect(said).not.toContain(k.d);
    // A landing with such a secret is built exactly as without one.
    const { digest } = await sealNote(note);
    expect((await landingCommit(bad[5])).message).toBe(withNoteDigest(landingMessage({ id: "lnd_1", intentIds: ["int_1"] }, [proposal], { int_1: "Add a thing" }), digest));
  });

  it("leaves a commit unsigned when signing fails, and says so once", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const signer = (await noteSigner(await newKey()))!;
    const failing = { key: signer.key, sign: async () => Promise.reject(new TypeError("no")) };
    expect(await withSignature("Land 1 change: x", failing, { digest: "0".repeat(64), tree: TREE, parents: [PARENT] })).toBe("Land 1 change: x");
    expect(await withSignature("Land 1 change: x", failing, { digest: "0".repeat(64), tree: TREE, parents: [PARENT] })).toBe("Land 1 change: x");
    expect(log.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("the published keys", () => {
  it("list the key FT_NOTE_KEY holds, with its id, its public half and since when it signs", async () => {
    const secret = await newKey({ since: "2026-10-14" });
    const res = await keysResponse({ FT_NOTE_KEY: secret });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const text = await res.text();
    const id = await noteKeyId(secret);
    expect(JSON.parse(text)).toEqual({ keys: [{ id, alg: "Ed25519", publicKey: JSON.parse(secret).x, since: "2026-10-14T00:00:00.000Z" }] });
    // The private half never leaves the Worker.
    expect(text).not.toContain(JSON.parse(secret).d);
    expect(KEYS_PATH).toBe("/.well-known/firetrident-keys.json");
  });

  it("are served by the Worker before the static assets, whose single-page fallback would answer the path otherwise", async () => {
    // The tests run in Node, where a module knows its own URL (the workers types leave it out).
    const here = (import.meta as ImportMeta & { url: string }).url;
    const FS = "node:fs";
    const { readFileSync } = (await import(FS)) as { readFileSync(path: URL, encoding: "utf8"): string };
    const config = JSON.parse(readFileSync(new URL("../../wrangler.jsonc", here), "utf8")) as { assets: { run_worker_first: string[] } };
    expect(config.assets.run_worker_first).toContain(KEYS_PATH);
    const entry = readFileSync(new URL("../../src/index.ts", here), "utf8");
    const route = entry.indexOf("app.get(KEYS_PATH, (c) => keysResponse(c.env));");
    expect(route).toBeGreaterThan(0);
    expect(route).toBeLessThan(entry.indexOf('app.all("*"'));
  });

  it("are an empty list on a deployment that does not sign", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await (await keysResponse({})).json()).toEqual({ keys: [] });
    expect(await (await keysResponse({ FT_NOTE_KEY: "{}" })).json()).toEqual({ keys: [] });
  });
});
