import { describe, expect, it } from "vitest";
import { fileDiff, type FileDiff } from "../../src/decide/diff.ts";
import { cardShown, identityAnswers, noteReceipt, promptShown, readShown, reflexShown, shownDigest, sortedJson } from "../../src/decide/receipt.ts";
import { reflexState, secondOpinionDiff, secondOpinionMessages, stateCoverage, type ReflexInput } from "../../src/decide/reflex.ts";
import { buildReviewView } from "../../src/decide/review.ts";
import { sha256Hex } from "../../src/trunk/digest.ts";
import { maskStrings } from "../../src/trunk/mask.ts";

/** The review receipt: what each decider was shown, digested exactly as it was shown (decide/receipt.ts). */

const sha = async (text: string): Promise<string> => `sha256:${await sha256Hex(text)}`;

/** A new file of `lines` lines. */
function newFile(path: string, lines: number, width = 40): FileDiff {
  const text = Array.from({ length: lines }, (_, i) => `export const v${i} = "${"x".repeat(Math.max(0, width - 20))}";`).join("\n");
  return fileDiff(path, null, `${text}\n`, { maxChars: 200_000 });
}

function input(diffs: FileDiff[]): ReflexInput {
  return { intent: { title: "Add the slug module", why: "Slugs are short ids for links.", whyBy: "person" }, footprint: ["src/slug.ts"], residual: [], diffs, antibodies: [] };
}

const HEAD = "a".repeat(40);

describe("the review receipt of a model", () => {
  it("digests the diff the reflex read, exactly as its state carries it", async () => {
    const x = input([newFile("src/slug.ts", 3)]);
    const state = reflexState(x);
    const shown = await reflexShown(state, stateCoverage(x.diffs));
    expect(shown).toEqual({ view: "reflex-state", digest: await sha(JSON.stringify(state.diff)) });
    // Any change to what the reflex read changes the digest.
    const y = input([newFile("src/slug.ts", 4)]);
    expect((await reflexShown(reflexState(y), stateCoverage(y.diffs))).digest).not.toBe(shown.digest);
  });

  it("says when the reflex saw a clipped view, and how much it saw", async () => {
    const x = input([newFile("src/big.ts", 600)]);
    const shown = await reflexShown(reflexState(x), stateCoverage(x.diffs));
    expect(shown.clipped).toBe(true);
    expect(shown.seen).toBe("saw 1 of 1 file, 1 only in part (src/big.ts)");
  });

  it("digests the diff text the second opinion's prompt fenced, and says when it was cut", async () => {
    const x = input([newFile("src/slug.ts", 3), newFile("src/b.ts", 2)]);
    const shown = await promptShown(x.diffs);
    const text = secondOpinionDiff(x.diffs).text;
    expect(shown).toEqual({ view: "prompt-diff", digest: await sha(text) });
    // The digested text is the diff the model was given, as is.
    expect(secondOpinionMessages(x)[1]!.content).toContain(`\n${text}\n`);
    const many = Array.from({ length: 22 }, (_, i) => newFile(`src/f${i}.ts`, 2));
    const cut = await promptShown(many);
    expect(cut).toMatchObject({ view: "prompt-diff", clipped: true, seen: "saw 20 of 22 files" });
  });
});

describe("the review receipt of a person", () => {
  const view = buildReviewView({ files: [{ path: "src/a.ts", before: "a\n", after: "b\n" }], danger: [], residual: [] });

  it("digests the view the card served as JSON with sorted keys, so the same view in any key order digests the same", async () => {
    const card = view as unknown as Record<string, unknown>;
    const shown = await cardShown(card);
    expect(shown).toEqual({ view: "review-card", digest: await sha(sortedJson(card)) });
    const reordered = Object.fromEntries(Object.entries(card).reverse());
    expect((await cardShown(reordered)).digest).toBe(shown.digest);
    expect(sortedJson({ b: 1, a: [{ d: 2, c: null }], u: undefined })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
  });

  it("is clipped when a file was cut or binary, or files were left out, and has no digest when the card served no view", async () => {
    const cut = { ...view, files: [{ ...view.files[0]!, truncated: true }] };
    expect(await cardShown(cut as unknown as Record<string, unknown>)).toMatchObject({ clipped: true, seen: "saw 1 of 1 file, 1 only in part (src/a.ts)" });
    const fewer = { ...view, filesChanged: 3 };
    expect(await cardShown(fewer as unknown as Record<string, unknown>)).toMatchObject({ clipped: true, seen: "saw 1 of 3 files" });
    expect(await cardShown(undefined)).toEqual({ view: "review-card", clipped: true, seen: "the card served no view of the change" });
  });

  it("records a person as stated unless the route verified them", () => {
    expect(identityAnswers(undefined)).toEqual({ identity: "stated" });
    expect(identityAnswers({ by: "matt", identity: "stated", why: "no Access token came with the request" })).toEqual({ identity: "stated", unverified: "no Access token came with the request" });
    expect(identityAnswers({ by: "dana@example.com", identity: "verified", stated: "dana" })).toEqual({ identity: "verified", verifiedBy: "access", stated: "dana" });
  });
});

describe("the receipt a lineage note carries", () => {
  it("copies the head, what was shown and a person's identity from the decision's answers", async () => {
    const shown = await shownDigest("x");
    expect(noteReceipt({ head: HEAD, shown: { view: "review-card", digest: shown }, identity: "verified" }, "human")).toEqual({ head: HEAD, shown: { view: "review-card", digest: shown }, identity: "verified" });
    // A model's row has no identity; a row before receipts gives only its head.
    expect(noteReceipt({ head: HEAD, shown: { view: "prompt-diff", digest: shown, clipped: true, seen: "saw 20 of 22 files" }, identity: "verified" }, "llm")).toEqual({
      head: HEAD,
      shown: { view: "prompt-diff", digest: shown, clipped: true, seen: "saw 20 of 22 files" },
    });
    expect(noteReceipt({ head: HEAD, decision: "approve", by: "matt" }, "human")).toEqual({ head: HEAD });
  });

  it("drops what does not read as a receipt", () => {
    expect(noteReceipt({ head: "not a sha", shown: "x", identity: "trusted" }, "human")).toEqual({});
    expect(readShown({ view: "screenshot", digest: "sha256:00" })).toBeUndefined();
    expect(readShown({ view: "review-card", digest: "sha256:00", clipped: "yes", seen: "  a\nb " })).toEqual({ view: "review-card", seen: "a b" });
  });

  it("survives the note's masking: digests and heads are not mistaken for secrets", async () => {
    const d = { kind: "triage", layer: "llm", p: 1, action: "land", head: HEAD, shown: { view: "prompt-diff", digest: await shownDigest("diff text") } };
    expect(maskStrings([d])).toEqual([d]);
  });
});
