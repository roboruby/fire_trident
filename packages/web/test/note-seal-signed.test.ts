import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NoteCheck } from "@fire_trident/core";
import { NoteSealBadge } from "../src/components/NoteSeal.tsx";
import { signedSeal } from "../src/signed.ts";
import { sealOf } from "../src/verified.ts";

/** The note badge where the server checks each commit's signature (signed lineage notes). */

const KEY = "0123456789abcdef";
const check = (status: string, extra: Partial<NoteCheck> = {}): NoteCheck => ({ landingId: "lnd_1", trunkSha: "a".repeat(40), at: 1, status, ...extra }) as NoteCheck;

describe("the note badge with signatures", () => {
  it("says an intact note's commit is signed, naming the key and where it is published", () => {
    const seal = sealOf(check("intact", { signature: { status: "signed", keyId: KEY } }));
    expect(seal).toMatchObject({ state: "intact", label: "Note intact and signed" });
    expect(seal.detail).toContain(`signed by FireTrident's key ${KEY}, published at /.well-known/firetrident-keys.json`);
    const html = renderToStaticMarkup(createElement(NoteSealBadge, { seal }));
    expect(html).toContain('class="seal is-intact"');
    expect(html).toContain("Note intact and signed");
  });

  it("turns an intact note with a bad signature red, with why", () => {
    const seal = sealOf(check("intact", { signature: { status: "bad-signature", keyId: KEY, detail: `the signature names key ${KEY}, which this deployment does not publish` } }));
    expect(seal).toEqual({
      state: "altered",
      label: "Signature does not match",
      detail: `The note matches its commit's FT-Note trailer, but the commit's signature does not check out against the key FireTrident publishes: the signature names key ${KEY}, which this deployment does not publish. The history around this note was rewritten, or FireTrident's key changed.`,
    });
  });

  it("reads as before for an unsigned commit, a server that checks no signature, an altered note, and odd answers", () => {
    expect(sealOf(check("intact", { signature: { status: "unsigned" } }))).toMatchObject({ state: "intact", label: "Note intact" });
    expect(sealOf(check("intact"))).toMatchObject({ state: "intact", label: "Note intact" });
    expect(sealOf(check("altered", { signature: { status: "signed", keyId: KEY } }))).toMatchObject({ state: "altered", label: "Note altered" });
    for (const odd of [null, "intact", [], { status: "intact", signature: "signed" }, { status: "intact", signature: { status: "notarized" } }]) expect(signedSeal(odd)).toBeNull();
    // A key id that is not one is left out of the sentence.
    expect(signedSeal(check("intact", { signature: { status: "signed", keyId: "<b>x</b>" } }))?.detail).toContain("signed by FireTrident's key, published at");
  });
});
