import { describe, expect, it } from "vitest";
import { landingMessage, serializeNote } from "@fire_trident/core";
import type { LineageNote, NoteCertification, Proposal } from "@fire_trident/core";
import { checkNote, digestedText, sealNote, sha256Hex, trailerDigest, withNoteDigest } from "../../src/trunk/digest.ts";

const note: LineageNote = {
  schema: "firetrident.lineage/v1",
  landingId: "lnd_1",
  colonyId: "c",
  proposals: [
    {
      id: "prp_1",
      agentId: "agt_1",
      agentKind: "internal",
      model: "@cf/google/gemma-4-26b-a4b-it",
      intent: { id: "int_1", title: "Café: «quotes» \"and\" \\ back\tslash", why: "Line one\nline two 🐜" },
      writeSet: [{ path: "src/a.ts", blob: "a".repeat(40) }],
      readSet: [],
      decisions: [{ kind: "triage", layer: "reflex", p: 0.125, action: "land" }],
      evidence: { checks: [{ name: "gate", ok: true, ms: 0, detail: "→ land by deterministic" }], residual: [], notVerified: "Not verified: nothing" },
      provenance: { author: "platform", auth: "platform", model: { evidence: "observed", name: "@cf/google/gemma-4-26b-a4b-it", observed: [{ model: "@cf/google/gemma-4-26b-a4b-it", calls: 2, inputTokens: 10, outputTokens: 5 }] } },
    },
  ],
};
const certification: NoteCertification = { status: "green", counts: { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 }, failing: [], finishedAt: 5 } as unknown as NoteCertification;

/** The canonical serializer of the stock-git recipe for the README, word for word: it must write what serializeNote writes. */
const canon = (v: unknown, i = ""): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const n = `${i}  `,
    a = Array.isArray(v);
  const items = a ? (v as unknown[]).map((x) => canon(x, n)) : Object.keys(v).sort().map((k) => `${JSON.stringify(k)}: ${canon((v as Record<string, unknown>)[k], n)}`);
  return items.length ? `${a ? "[" : "{"}\n${n}${items.join(`,\n${n}`)}\n${i}${a ? "]" : "}"}` : a ? "[]" : "{}";
};

describe("note digests", () => {
  it("cover the note as written to git, so a note with no certification hashes as it is", async () => {
    const sealed = await sealNote(note);
    expect(sealed.text).toBe(serializeNote(note));
    // SHA-256 itself, on the standard test vector, then over the note as written.
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sealed.digest).toBe(await sha256Hex(sealed.text));
    expect(await sha256Hex(new TextEncoder().encode(sealed.text))).toBe(sealed.digest);
  });

  it("leave out the certification added after landing", async () => {
    const certified = { ...note, certification };
    expect(digestedText(certified)).toBe(serializeNote(note));
    const sealed = await sealNote(certified);
    expect(sealed.text).toBe(serializeNote(certified));
    expect(sealed.digest).toBe(await sha256Hex(serializeNote(note)));
  });

  it("can be recomputed from git's copy with the README's short Node script", () => {
    const certified = JSON.parse(serializeNote({ ...note, certification, ["10"]: 1, ["2"]: [], ["b"]: {} } as LineageNote)) as Record<string, unknown>;
    expect(`${canon(certified)}\n`).toBe(serializeNote(certified as unknown as LineageNote));
    delete certified.certification;
    expect(`${canon(certified)}\n`).toBe(digestedText(certified as unknown as LineageNote));
  });
});

describe("the FT-Note trailer", () => {
  const D = "0123456789abcdef".repeat(4);

  it("is the commit message's last line", () => {
    const message = withNoteDigest("Land 1 change: x\n\n- x\n\nFT-Landing: lnd_1\nFT-Intent: int_1\n\n", D);
    expect(message).toBe(`Land 1 change: x\n\n- x\n\nFT-Landing: lnd_1\nFT-Intent: int_1\nFT-Note: sha256:${D}`);
    expect(trailerDigest(message)).toBe(D);
    // Commit readers hand the message back with a trailing newline, or without one.
    expect(trailerDigest(`${message}\n`)).toBe(D);
  });

  it("is read only from the last line, in its exact form", () => {
    expect(trailerDigest(`FT-Note: sha256:${D}\n\nFT-Landing: lnd_1`)).toBeNull();
    expect(trailerDigest(`x\n\nFT-Note: sha256:${D.toUpperCase()}`)).toBeNull();
    expect(trailerDigest(`x\n\nFT-Note: sha256:${D.slice(1)}`)).toBeNull();
    expect(trailerDigest(`x\n\nFT-Note: sha1:${D.slice(0, 40)}`)).toBeNull();
    expect(trailerDigest(`x\n\n FT-Note: sha256:${D}`)).toBeNull();
    expect(trailerDigest("")).toBeNull();
    expect(trailerDigest(undefined)).toBeNull();
  });

  it("cannot be forged by an intent title or an id", () => {
    const p = { id: "prp_1", intentId: "int_1", agentId: `agt_1\nFT-Note: sha256:${"f".repeat(64)}` } as Proposal;
    const message = withNoteDigest(landingMessage({ id: "lnd_1", intentIds: ["int_1"] }, [p], { int_1: `x\n\nFT-Note: sha256:${"e".repeat(64)}` }), D);
    expect(trailerDigest(message)).toBe(D);
    expect(message.split("\n").filter((l) => l.startsWith("FT-Note:"))).toEqual([`FT-Note: sha256:${D}`]);
  });
});

describe("checkNote", () => {
  it("passes the note the trunk writer wrote, and the same note after certification was added", async () => {
    const { text, digest } = await sealNote(note);
    expect(await checkNote(new TextEncoder().encode(text), digest)).toEqual({ status: "intact" });
    expect(await checkNote(serializeNote({ ...note, certification }), digest)).toEqual({ status: "intact" });
  });

  it("finds a changed value, with the digest of what it found", async () => {
    const { digest } = await sealNote(note);
    const forged = serializeNote({ ...note, proposals: [{ ...note.proposals[0]!, model: "a-better-model" }] });
    const res = await checkNote(forged, digest);
    expect(res.status).toBe("altered");
    expect(res.found).toBe(await sha256Hex(forged));
    expect(res.detail).toMatch(/^the note hashes to [0-9a-f]{12}, the commit's trailer says [0-9a-f]{12}$/);
  });

  it("finds a note rewritten in another form, even one that reads the same", async () => {
    const { text, digest } = await sealNote(note);
    const variants = [
      JSON.stringify(JSON.parse(text)),
      `${text}\n`,
      `﻿${text}`,
      text.replace('"landingId": "lnd_1"', '"landingId": "lnd_forged",\n  "landingId": "lnd_1"'),
    ];
    for (const v of variants) expect((await checkNote(v, digest)).status).toBe("altered");
    expect((await checkNote(variants[0]!, digest)).detail).toMatch(/not in the form the trunk writer writes/);
  });

  it("finds what is not a note at all", async () => {
    const { digest } = await sealNote(note);
    expect(await checkNote("not json", digest)).toEqual({ status: "altered", detail: "the note is not JSON" });
    expect(await checkNote("[1]\n", digest)).toEqual({ status: "altered", detail: "the note is not a JSON object" });
    expect(await checkNote(new Uint8Array([0x7b, 0xff, 0x7d]), digest)).toEqual({ status: "altered", detail: "the note is not UTF-8 text" });
  });
});
