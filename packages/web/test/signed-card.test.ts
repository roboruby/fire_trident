import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseAbout } from "../src/about.ts";
import { SignedByTag } from "../src/components/SignedBy.tsx";
import { showcaseFrom } from "../src/landing/Results.tsx";
import { SIGNED_NOTES_LIMIT, SIGNED_ORIGIN, loadSignedCard, signedCard, type GetJson } from "../src/landing/showcase.ts";
import { KEYS_PATH, signedKeyOf } from "../src/signed.ts";

/** The signed card of the results strip, and the top bar's indicator: lineage notes signed by the trunk writer's published key. */

const KEY = "7980151ea697807b";
const OTHER = "0123456789abcdef";
const NEWEST = "6687a2205e845de64e9792032b338f1b8150177e";
const OLDER = "1a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d";
const ORIGIN = "https://firetrident.com";
const KEYS_URL = `${ORIGIN}${KEYS_PATH}`;

/** GET /.well-known/firetrident-keys.json: the keys listed. */
const keys = (...list: object[]) => ({ keys: list });
const key = { id: KEY, alg: "Ed25519", publicKey: "A".repeat(43), since: "2026-10-14T15:59:51.000Z" };
/** GET /notes/verify: one check, and the whole answer (newest first). */
const note = (landingId: string, trunkSha: string, status: string, signature?: object) => ({ landingId, trunkSha, at: 1, status, ...(signature ? { signature } : {}) });
const signed = (landingId: string, trunkSha: string, keyId = KEY) => note(landingId, trunkSha, "intact", { status: "signed", keyId });
const verify = (...notes: object[]) => ({ colonyId: "signed-notes", notesTip: "b".repeat(40), notes, counts: {}, at: 2 });
const on = { colonyId: "signed-notes", origin: ORIGIN };

describe("signed card", () => {
  it("names the key and since when it signs, the newest landing's badge, and the stock-git check", () => {
    expect(signedCard(verify(signed("lnd_1", NEWEST)), keys(key), on)).toEqual({
      headline: `Signed by ${KEY}`,
      lede: "every landing's note is sealed by its digest and signed by the trunk writer's key, published for any git client to check",
      details: [
        `key ${KEY} (Ed25519), signing since 2026-10-14 15:59 UTC, published at /.well-known/firetrident-keys.json`,
        "newest landing 6687a22: note intact and signed",
        `from a stock clone (git clone https://firetrident.com/git/signed-notes.git, fetch refs/notes/firetrident), node scripts/verify_note.mjs HEAD --keys ${KEYS_URL} prints “intact, signed by ${KEY}”`,
      ],
      origin: SIGNED_ORIGIN,
    });
    // A key that does not say since when it signs.
    expect(signedCard(verify(signed("lnd_1", NEWEST)), keys({ ...key, since: null }), on)?.details[0]).toBe(`key ${KEY} (Ed25519), published at /.well-known/firetrident-keys.json`);
  });

  it("counts the notes before the newest, and says N of M when some landed before signing or are not pushed yet", () => {
    const all = signedCard(verify(signed("lnd_3", NEWEST), signed("lnd_2", OLDER), signed("lnd_1", OLDER)), keys(key), on);
    expect(all?.headline).toBe(`Signed by ${KEY}`);
    expect(all?.details[1]).toBe("newest landing 6687a22: note intact and signed, as are the two before it");

    const some = signedCard(verify(signed("lnd_3", NEWEST), note("lnd_2", OLDER, "intact", { status: "unsigned" }), note("lnd_1", OLDER, "no-trailer")), keys(key), on);
    expect(some?.headline).toBe("1 of 3 notes signed");
    expect(some?.lede).toBe("the newest landings' notes are sealed by their digests; one of three is signed by the trunk writer's key, published for any git client to check");
    expect(some?.details[1]).toBe("newest landing 6687a22: note intact and signed");
    expect(some?.details[2]).toContain("node scripts/verify_note.mjs HEAD --keys");

    // The newest landing's note is not pushed yet: the check names the newest signed commit instead of HEAD.
    const pending = signedCard(verify(note("lnd_4", OLDER, "pending"), signed("lnd_3", NEWEST)), keys(key), on);
    expect(pending?.headline).toBe("1 of 2 notes signed");
    expect(pending?.details[1]).toBe("newest landing 1a2b3c4: note not pushed yet");
    expect(pending?.details[2]).toContain(`node scripts/verify_note.mjs ${NEWEST.slice(0, 12)} --keys`);
    expect(signedCard(verify(note("lnd_4", OLDER, "intact", { status: "unsigned" }), signed("lnd_3", NEWEST)), keys(key), on)?.details[1]).toBe("newest landing 1a2b3c4: note intact, landed before signing");
  });

  it("shows nothing without a published key or a signed note", () => {
    const one = verify(signed("lnd_1", NEWEST));
    expect(signedCard(one, keys(), on)).toBeNull();
    expect(signedCard(one, null, on)).toBeNull();
    expect(signedCard(one, { keys: "odd" }, on)).toBeNull();
    expect(signedCard(one, keys({ ...key, id: "<b>x</b>" }), on)).toBeNull();
    // A signature naming a key the deployment does not publish is not a signature by its key.
    expect(signedCard(verify(signed("lnd_1", NEWEST, OTHER)), keys(key), on)).toBeNull();
    expect(signedCard(verify(note("lnd_1", NEWEST, "intact", { status: "unsigned" })), keys(key), on)).toBeNull();
    expect(signedCard(verify(note("lnd_1", NEWEST, "intact", { status: "bad-signature", keyId: KEY })), keys(key), on)).toBeNull();
    expect(signedCard(verify(note("lnd_1", NEWEST, "intact")), keys(key), on)).toBeNull();
    expect(signedCard(verify(note("lnd_1", NEWEST, "altered", { status: "signed", keyId: KEY })), keys(key), on)).toBeNull();
    expect(signedCard(verify(), keys(key), on)).toBeNull();
    expect(signedCard(null, keys(key), on)).toBeNull();
    expect(signedCard({ notes: "odd" }, keys(key), on)).toBeNull();
  });

  it("reads the newest note checks and the published keys, and shows nothing for a colony that does not exist", async () => {
    const asked: string[] = [];
    const answers: Record<string, unknown> = {
      [`/api/colonies/signed-notes/notes/verify?limit=${SIGNED_NOTES_LIMIT}`]: verify(signed("lnd_1", NEWEST)),
      [KEYS_PATH]: keys(key),
    };
    const get: GetJson = async (url) => {
      asked.push(url);
      if (!(url in answers)) throw new Error(`404 ${url}`);
      return answers[url];
    };
    const card = await loadSignedCard("signed-notes", get, ORIGIN);
    expect(card?.headline).toBe(`Signed by ${KEY}`);
    expect(asked.sort()).toEqual([KEYS_PATH, "/api/colonies/signed-notes/notes/verify?limit=20"]);
    expect(await loadSignedCard("nowhere", get, ORIGIN)).toBeNull();
    // A deployment that publishes no key shows nothing, whatever the notes say; one whose keys route fails too.
    expect(await loadSignedCard("signed-notes", async (url) => (url === KEYS_PATH ? keys() : answers[url]), ORIGIN)).toBeNull();
    expect(await loadSignedCard("signed-notes", async (url) => (url === KEYS_PATH ? Promise.reject(new Error("404")) : answers[url]), ORIGIN)).toBeNull();
  });
});

describe("the ?results= kinds", () => {
  it("knows the signed kind, lists signed-notes by default, and drops a kind it does not know", () => {
    expect(showcaseFrom("?results=signed-notes:signed,hono:rule")).toEqual([
      { id: "signed-notes", kind: "signed" },
      { id: "hono", kind: "rule" },
    ]);
    expect(showcaseFrom("?results=signed-notes:notarized,:signed,hono")).toEqual([]);
    expect(showcaseFrom("")).toContainEqual({ id: "signed-notes", kind: "signed" });
    expect(showcaseFrom("?results=")).toContainEqual({ id: "signed-notes", kind: "signed" });
  });
});

describe("the top bar's signing indicator", () => {
  it("reads the key id GET /api/about names", () => {
    expect(parseAbout({ noteKey: KEY })?.noteKey).toBe(KEY);
    expect(parseAbout({ noteKey: "short" })?.noteKey).toBeNull();
    expect(parseAbout({})?.noteKey).toBeNull();
  });

  it("names the key an intact note's commit is signed by, and nothing else", () => {
    expect(signedKeyOf({ status: "intact", signature: { status: "signed", keyId: KEY } })).toBe(KEY);
    expect(signedKeyOf({ status: "intact", signature: { status: "unsigned" } })).toBeNull();
    expect(signedKeyOf({ status: "intact", signature: { status: "bad-signature", keyId: KEY } })).toBeNull();
    expect(signedKeyOf({ status: "altered", signature: { status: "signed", keyId: KEY } })).toBeNull();
    expect(signedKeyOf({ status: "intact", signature: { status: "signed", keyId: "<b>x</b>" } })).toBeNull();
    expect(signedKeyOf({ status: "intact" })).toBeNull();
    expect(signedKeyOf(null)).toBeNull();
  });

  it("says notes signed by <key id>, linking to the published keys, or nothing", () => {
    const html = renderToStaticMarkup(createElement(SignedByTag, { keyId: KEY }));
    expect(html).toContain(`>notes signed by ${KEY}</a>`);
    expect(html).toContain(`<a class="signed-by mono" href="${KEYS_PATH}" target="_blank" rel="noreferrer"`);
    expect(html).toContain("this colony&#x27;s newest note checks intact and signed by it");
    expect(renderToStaticMarkup(createElement(SignedByTag, { keyId: null }))).toBe("");
  });
});
