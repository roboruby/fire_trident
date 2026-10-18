import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NoteCheck } from "@fire_trident/core";
import { NoteSealBadge } from "../src/components/NoteSeal.tsx";
import { sealOf } from "../src/verified.ts";

/** The note badge where the server checks each landing against main and each commit's full-commit signature. */

const KEY = "0123456789abcdef";
const check = (status: string, extra: Partial<NoteCheck> = {}): NoteCheck => ({ landingId: "lnd_1", trunkSha: "a".repeat(40), at: 1, status, ...extra }) as NoteCheck;
const REWRITTEN = `main (at ${"8".repeat(12)}) was rewritten: ${"7".repeat(12)} on main now stands for this landing, with its message changed, and main no longer reaches the commit it landed as`;

describe("the note badge against main", () => {
  it("turns a landing main no longer reaches red, saying whether it was rewritten or dropped", () => {
    const rewritten = sealOf(check("dropped", { detail: REWRITTEN, main: { status: "dropped", replacedBy: "7".repeat(40), detail: REWRITTEN } }));
    expect(rewritten).toEqual({
      state: "altered",
      label: "Rewritten on main",
      detail: `Main (at ${"8".repeat(12)}) was rewritten: ${"7".repeat(12)} on main now stands for this landing, with its message changed, and main no longer reaches the commit it landed as. Someone with write access to the trunk repository changed main's history after this landed.`,
    });
    expect(renderToStaticMarkup(createElement(NoteSealBadge, { seal: rewritten }))).toContain('class="seal is-altered"');
    const dropped = sealOf(check("dropped", { main: { status: "dropped" } }));
    expect(dropped).toMatchObject({ state: "altered", label: "No longer on main" });
    expect(dropped.detail).toBe("Main no longer reaches this landing's commit: it was dropped from main, or main was rewritten. Someone with write access to the trunk repository changed main's history after this landed.");
  });

  it("says the whole commit is signed, turns a bad full-commit signature red, and notes one signed before them", () => {
    const whole = sealOf(check("intact", { signature: { status: "signed", keyId: KEY }, commitSignature: { status: "signed", keyId: KEY } }));
    expect(whole).toMatchObject({ state: "intact", label: "Note intact and signed" });
    expect(whole.detail).toContain(`the whole commit (its message, author and committer too) is signed by FireTrident's key ${KEY}`);
    const bad = sealOf(check("intact", { signature: { status: "signed", keyId: KEY }, commitSignature: { status: "bad-signature", keyId: KEY, detail: "the commit's message, author or committer changed after it was signed" } }));
    expect(bad).toEqual({
      state: "altered",
      label: "Commit signature does not match",
      detail: "The note matches its commit's FT-Note trailer and its note signature checks out, but the commit's full-commit signature does not: the commit's message, author or committer changed after it was signed. Its message, author or committer was changed after it landed, or FireTrident's key changed.",
    });
    const before = sealOf(check("intact", { signature: { status: "signed", keyId: KEY }, commitSignature: { status: "note-only" } }));
    expect(before).toMatchObject({ state: "intact", label: "Note intact and signed" });
    expect(before.detail).toMatch(/and the commit is signed by FireTrident's key .+ It was signed before full-commit signatures, which cover its message, author and committer too\.$/);
  });
});
