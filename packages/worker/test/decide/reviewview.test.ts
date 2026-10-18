import { describe, expect, it } from "vitest";
import type { NoteAcceptance } from "@fire_trident/core";
import { fileDiff } from "../../src/decide/diff.ts";
import type { GateVerdict } from "../../src/decide/gate.ts";
import { acceptanceDetail, acceptanceGate, checkQuote, noteAcceptance } from "../../src/decide/quotes.ts";
import { secondOpinionDiff, secondOpinionMessages, type ReflexInput } from "../../src/decide/reflex.ts";
import { VIEW_RULE, reviewViewEnabled, viewReturn, wholeFileDiffs } from "../../src/decide/reviewview.ts";

/** The review view's pieces (decide/reviewview.ts, FT_REVIEW_VIEW): the whole-file view, quotes in the file, the checked basis. */

/** A module of `n` small functions, the one at `changed` (if any) edited. */
function module(n: number, changed = -1, prefix = "f"): string {
  return Array.from({ length: n }, (_, i) => `export function ${prefix}${i}(x: number): number {\n  return x + ${i === changed ? 1000 : i};\n}\n`).join("\n");
}

/** A text file as the innate checks give it. */
function file(path: string, before: string | null, after: string | null) {
  return { path, before, after, binary: false, unreadable: false };
}

describe("wholeFileDiffs", () => {
  it("shows a modified file whole when it fits, with the same coverage", () => {
    const before = module(30);
    const after = module(30, 25);
    const d = fileDiff("src/a.ts", before, after, { maxChars: 24_000 });
    expect(d.hunks).not.toContain("f0(");
    const out = wholeFileDiffs([d], [file("src/a.ts", before, after)]);
    expect(out.whole).toEqual(["src/a.ts"]);
    expect(out.diffs[0]!.hunks).toContain(" export function f0(x: number): number {");
    expect(out.diffs[0]!.hunks).toContain("-  return x + 25;");
    expect(out.diffs[0]!.hunks).toContain("+  return x + 1000;");
    expect(out.diffs[0]!.hunks.startsWith("@@ -1,")).toBe(true);
    expect(secondOpinionDiff(out.diffs).coverage).toEqual(secondOpinionDiff([d]).coverage);
  });

  it("leaves a file over the per-file budget, files past the total budget, added files and a cut view as they are", () => {
    const bigBefore = module(700);
    const bigAfter = module(700, 699);
    expect(bigAfter.length).toBeGreaterThan(24_000);
    const big = fileDiff("src/big.ts", bigBefore, bigAfter, { maxChars: 24_000 });
    const added = fileDiff("src/new.ts", null, module(3), { maxChars: 24_000 });
    const out = wholeFileDiffs([big, added], [file("src/big.ts", bigBefore, bigAfter), file("src/new.ts", null, module(3))]);
    expect(out.whole).toEqual([]);
    expect(out.diffs).toEqual([big, added]);

    // Three files of about 20,000 characters: two fit in 60,000 with the rest, the third stays as hunks.
    const parts = ["a", "b", "c"].map((p) => {
      const b = module(320, -1, p);
      const a = module(320, 300, p);
      return { d: fileDiff(`src/${p}.ts`, b, a, { maxChars: 24_000 }), f: file(`src/${p}.ts`, b, a) };
    });
    expect(parts[0]!.f.after!.length).toBeGreaterThan(19_000);
    expect(parts[0]!.f.after!.length).toBeLessThan(24_000);
    const three = wholeFileDiffs(
      parts.map((x) => x.d),
      parts.map((x) => x.f),
      new Set(["src/c.ts"]),
    );
    // The file a line names goes first.
    expect(three.whole).toEqual(["src/c.ts", "src/a.ts"]);
    expect(secondOpinionDiff(three.diffs).text.length).toBeLessThanOrEqual(60_000);
    expect(secondOpinionDiff(three.diffs).coverage.complete).toBe(true);

    // A view that was already cut stays cut, as it was.
    const many = Array.from({ length: 21 }, (_, i) => fileDiff(`src/m${i}.ts`, "a\n", "b\n"));
    const cut = wholeFileDiffs(many, []);
    expect(cut.diffs).toEqual(many);
    expect(cut.whole).toEqual([]);
  });
});

describe("quotes in the file after the change (checkQuote with files)", () => {
  const before = "export function a(): number {\n  return 1;\n}\n\nexport function b(): number {\n  return 2;\n}\n\nexport function c(): number {\n  return 3;\n}\n";
  const after = before.replace("return 3;", "return 33;");
  const shown = [{ path: "src/a.ts", hunks: fileDiff("src/a.ts", before, after).hunks }];
  const files = new Map([
    ["src/a.ts", after],
    ["src/other.ts", "export const other = 'a line nobody was shown';\n"],
  ]);

  it("without files, exactly as before", () => {
    expect(checkQuote("src/a.ts", "export function a(): number {", shown)).toEqual({ ok: false, problem: "its quote is not in the added or unchanged lines of src/a.ts it was shown" });
    expect(checkQuote("src/other.ts", "a line nobody was shown", shown)).toEqual({ ok: false, problem: "src/other.ts is not a file of the diff it was shown" });
  });

  it("with files, a quote anywhere in the named file after the change counts", () => {
    expect(checkQuote("src/a.ts", "export function a(): number {", shown, files)).toEqual({ ok: true, path: "src/a.ts", quote: "export function a(): number {" });
    expect(checkQuote("./src/other.ts", "a line nobody was shown", shown, files)).toEqual({ ok: true, path: "src/other.ts", quote: "a line nobody was shown" });
    expect(checkQuote("src/a.ts", "return 3;", shown, files)).toEqual({ ok: false, problem: "its quote is from a line the change removes from src/a.ts" });
    expect(checkQuote("src/other.ts", "a line that is not there", shown, files)).toEqual({ ok: false, problem: "its quote is not in src/other.ts after the change" });
    expect(checkQuote("src/missing.ts", "a line that is not there", shown, files)).toEqual({ ok: false, problem: "src/missing.ts is not a file of the diff it was shown" });
  });
});

describe("lines FireTrident checked (basis checked)", () => {
  const lines: NoteAcceptance[] = [
    { kind: "intent", line: "src/a.ts exports a(): number", verdict: "met", basis: "checked", path: "src/a.ts", quote: "a(): number" },
    { kind: "intent", line: "a returns one", verdict: "met", basis: "quote", path: "src/a.ts", quote: "return 1;" },
    { kind: "keep", line: "src/a.ts exports b(): number", verdict: "not met", basis: "checked", path: "src/a.ts", problem: "src/a.ts does not export b, though it held before this change", landingId: "lnd_1" },
    { kind: "keep", line: "src/a.ts exports z(): number", verdict: "unclear", basis: "checked", path: "src/a.ts", problem: "it did not hold before this change either: src/a.ts does not export z" },
  ];

  it("says so in the gate's reasons and the evidence", () => {
    expect(acceptanceGate(lines.slice(0, 2))?.met).toBe("every acceptance line is met (2 lines): 1 with a quote found in the diff, 1 checked by FireTrident in the files after the change (line 1)");
    expect(acceptanceGate(lines)?.notMet).toBe(
      'it breaks what a recent landing by another intent met: keep line 1 "src/a.ts exports b(): number" (from landing lnd_1) (checked by FireTrident: src/a.ts does not export b, though it held before this change); keep what that landing did unless your intent says otherwise, and escalate if both cannot hold',
    );
    expect(acceptanceDetail(lines)).toBe(
      'line 1 met: checked by FireTrident: src/a.ts a(): number; line 2 met: src/a.ts "return 1;"; keep line 1 not met: checked by FireTrident: src/a.ts does not export b, though it held before this change; keep line 2 unclear: checked by FireTrident: it did not hold before this change either: src/a.ts does not export z',
    );
  });

  it("the lineage note keeps the basis, and lines without it read as before", () => {
    expect(noteAcceptance(JSON.parse(JSON.stringify(lines)))).toEqual(lines);
    expect(acceptanceGate([lines[1]!])?.met).toBe("every acceptance line is met, each with a quote found in the diff (1 line)");
  });
});

describe("the second opinion's prompt", () => {
  const input: ReflexInput = { intent: { title: "Tips", why: "Diners want tips." }, footprint: ["src/a.ts"], residual: [], diffs: [fileDiff("src/a.ts", "a\n", "b\n")], antibodies: [] };

  it("carries the view's own sentences, and asks keep lines alone when FireTrident checked every line of the intent", () => {
    const [system, user] = secondOpinionMessages({ ...input, acceptance: [{ kind: "keep", text: "allocate throws a RangeError", landingId: "lnd_1" }], viewNote: "Files that fit are shown whole." });
    expect(system!.content).toContain('The intent carries numbered acceptance lines. Answer every numbered line in "acceptance"');
    expect(system!.content.endsWith("\nFiles that fit are shown whole.")).toBe(true);
    expect(user!.content).toContain("1. allocate throws a RangeError");
    expect(user!.content).toContain("acceptance: one entry for each numbered line");
  });

  it("without the view, exactly as before", () => {
    const plain = secondOpinionMessages(input);
    expect(plain[0]!.content).not.toContain("acceptance");
    const asked = secondOpinionMessages({ ...input, acceptance: [{ kind: "intent", text: "a is b" }] });
    expect(asked[0]!.content.split("\n").length).toBe(plain[0]!.content.split("\n").length + 4);
  });
});

describe("the flag and the rule", () => {
  it("covers a colony as FT_REVALIDATE does", () => {
    expect(reviewViewEnabled(undefined, "c1")).toBe(false);
    expect(reviewViewEnabled("off", "c1")).toBe(false);
    expect(reviewViewEnabled("on", "c1")).toBe(true);
    expect(reviewViewEnabled("c2, c1", "c1")).toBe(true);
    expect(reviewViewEnabled("c2", "c1")).toBe(false);
  });

  it("returns a change deterministically, keeping what the stage found", () => {
    const was: GateVerdict = { action: "screen", layer: "deterministic", p: 0.5, rule: "D4 screen", reasons: [], detectors: [], damage: ["off-intent"], confirmations: [], confidence: 0.7, risk: 1 };
    expect(viewReturn("acceptance not met: line 1", was)).toEqual({ action: "return", layer: "deterministic", p: 1, rule: VIEW_RULE, reasons: ["acceptance not met: line 1"], detectors: ["acceptance:not-met"], damage: ["off-intent"], confirmations: [], confidence: 0.7, risk: 1 });
  });
});
