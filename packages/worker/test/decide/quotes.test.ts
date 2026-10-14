import { describe, expect, it } from "vitest";
import type { Intent, NoteAcceptance } from "@fire_trident/core";
import { fileDiff } from "../../src/decide/diff.ts";
import {
  ACCEPTANCE_LIMITS,
  acceptanceDetail,
  acceptanceGate,
  acceptanceLines,
  checkAcceptance,
  checkQuote,
  isAbsence,
  keepSource,
  noteAcceptance,
  parseAcceptance,
  type AcceptanceLine,
} from "../../src/decide/quotes.ts";
import { secondOpinionDiff } from "../../src/decide/reflex.ts";

/** The second opinion's view of one changed file. */
function shown(path: string, before: string | null, after: string | null) {
  return secondOpinionDiff([fileDiff(path, before, after, { maxChars: 24_000 })]).shown;
}

const BEFORE = ["export function slugify(text: string): string {", "  return text.trim();", "}", ""].join("\n");
const AFTER = ["export function slugify(text: string): string {", "  const lower = text.toLowerCase();", '  return lower.replace(/ +/g, "-");', "}", ""].join("\n");
const VIEW = shown("src/slug.ts", BEFORE, AFTER);

describe("checkQuote: a quote counts only when it is in the added or unchanged lines the model was shown", () => {
  it("finds a quote copied from an added line", () => {
    expect(checkQuote("src/slug.ts", "const lower = text.toLowerCase();", VIEW)).toEqual({ ok: true, path: "src/slug.ts", quote: "const lower = text.toLowerCase();" });
  });

  it("rejects a fabricated quote", () => {
    expect(checkQuote("src/slug.ts", "return text.normalize('NFKD').toLowerCase();", VIEW)).toEqual({ ok: false, problem: "its quote is not in the added or unchanged lines of src/slug.ts it was shown" });
  });

  it("does not count a quote from a removed line", () => {
    expect(checkQuote("src/slug.ts", "return text.trim();", VIEW)).toEqual({ ok: false, problem: "its quote is from a line the change removes from src/slug.ts" });
  });

  it("collapses whitespace on both sides, and finds a quote spanning consecutive lines", () => {
    expect(checkQuote("src/slug.ts", "const   lower =\ttext.toLowerCase();", VIEW)).toMatchObject({ ok: true, quote: "const lower = text.toLowerCase();" });
    expect(checkQuote("src/slug.ts", 'const lower = text.toLowerCase();\n  return lower.replace(/ +/g, "-");', VIEW)).toMatchObject({ ok: true });
    // An unchanged line shown as context counts too.
    expect(checkQuote("src/slug.ts", "export function slugify(text: string): string {", VIEW)).toMatchObject({ ok: true });
  });

  it("rejects quotes shorter than 8 characters, and answers without a file or a quote", () => {
    expect(checkQuote("src/slug.ts", "lower", VIEW)).toEqual({ ok: false, problem: `its quote is shorter than ${ACCEPTANCE_LIMITS.minQuote} characters` });
    expect(checkQuote("src/slug.ts", "  }  \n", VIEW)).toMatchObject({ ok: false });
    expect(checkQuote(undefined, "const lower = text.toLowerCase();", VIEW)).toEqual({ ok: false, problem: "it named no file" });
    expect(checkQuote("src/slug.ts", "", VIEW)).toEqual({ ok: false, problem: "it quoted no line" });
  });

  it("reads the file as models write it, but never a file it was not shown", () => {
    for (const path of ["./src/slug.ts", "`src/slug.ts`", "/src/slug.ts", "src/slug.ts (modified, +2 -1)"]) expect(checkQuote(path, "const lower = text.toLowerCase();", VIEW)).toMatchObject({ ok: true, path: "src/slug.ts" });
    expect(checkQuote("src/other.ts", "const lower = text.toLowerCase();", VIEW)).toEqual({ ok: false, problem: "src/other.ts is not a file of the diff it was shown" });
  });

  it("takes a quote with the diff's + markers copied, but never strips a removed line's marker", () => {
    expect(checkQuote("src/slug.ts", "+  const lower = text.toLowerCase();", VIEW)).toMatchObject({ ok: true, quote: "const lower = text.toLowerCase();" });
    expect(checkQuote("src/slug.ts", "-  return text.trim();", VIEW)).toMatchObject({ ok: false });
  });

  it("does not count a quote from a part of the diff the model was not shown", () => {
    const big = Array.from({ length: 4_000 }, (_, i) => `export const value${i} = ${i};`).join("\n");
    const view = secondOpinionDiff([fileDiff("src/big.ts", null, `${big}\n`, { maxChars: 200_000 })]).shown;
    expect(checkQuote("src/big.ts", "export const value10 = 10;", view)).toMatchObject({ ok: true });
    expect(checkQuote("src/big.ts", "export const value3999 = 3999;", view)).toMatchObject({ ok: false });
  });
});

const LINES: AcceptanceLine[] = [
  { kind: "intent", text: "slugify lowercases its input" },
  { kind: "intent", text: "slugify replaces each run of spaces with one hyphen" },
];

describe("checkAcceptance: what counts for each line", () => {
  it("counts met with a found quote, keeps not met, and makes a fabricated quote unclear with the model's answer kept", () => {
    const checked = checkAcceptance(
      LINES,
      [
        { line: 1, verdict: "met", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" },
        { line: 2, verdict: "met", path: "src/slug.ts", quote: 'return text.replaceAll(" ", "-");' },
      ],
      VIEW,
    );
    expect(checked).toEqual([
      { kind: "intent", line: LINES[0]!.text, verdict: "met", basis: "quote", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" },
      { kind: "intent", line: LINES[1]!.text, verdict: "unclear", said: "met", path: "src/slug.ts", quote: 'return text.replaceAll(" ", "-");', problem: "its quote is not in the added or unchanged lines of src/slug.ts it was shown" },
    ]);
    expect(checkAcceptance(LINES, [{ line: 2, verdict: "not met" }], VIEW).map((l) => [l.verdict, l.problem])).toEqual([
      ["unclear", "the second opinion did not answer this line"],
      ["not met", undefined],
    ]);
  });

  it("reads no answers as every line unclear, and only a line's first answer", () => {
    expect(checkAcceptance(LINES, undefined, VIEW).every((l) => l.verdict === "unclear")).toBe(true);
    const twice = checkAcceptance(LINES.slice(0, 1), [{ line: 1, verdict: "not met" }, { line: 1, verdict: "met", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" }], VIEW);
    expect(twice[0]!.verdict).toBe("not met");
  });

  it("counts lines past the cap as unclear: they were never asked", () => {
    const many: AcceptanceLine[] = Array.from({ length: ACCEPTANCE_LIMITS.intentLines + 2 }, (_, i) => ({ kind: "intent", text: `criterion ${i + 1}` }));
    const checked = checkAcceptance(many, [], VIEW);
    expect(checked.at(-1)).toMatchObject({ verdict: "unclear", problem: expect.stringContaining("not asked") });
  });
});

describe("acceptanceLines: which intents are asked", () => {
  const intent = (over: Partial<Intent>): Pick<Intent, "acceptance" | "source"> => ({ source: "human", acceptance: ["a"], ...over });

  it("asks only intents with an acceptance list that a person, a rule or an agent wrote", () => {
    expect(acceptanceLines(intent({ acceptance: undefined }))).toBeNull();
    expect(acceptanceLines(intent({ acceptance: ["  ", ""] }))).toBeNull();
    expect(acceptanceLines(intent({ source: "certify" }))).toBeNull();
    expect(acceptanceLines(intent({ source: "system" }))).toBeNull();
    expect(acceptanceLines(intent({ source: "agent", acceptance: [" Exports  slugify ", 7 as unknown as string] }))).toEqual([{ kind: "intent", text: "Exports slugify" }]);
    // Old or odd stored data asks nothing.
    expect(acceptanceLines(intent({ acceptance: "not a list" as unknown as string[] }))).toBeNull();
  });

  it("adds keep lines after the intent's own, never from a repair or the colony's own intents", () => {
    const keep = { landingId: "lnd_1", intentId: "int_9", acceptance: ["Returns 404 for an unknown slug"], source: "human" as const };
    expect(acceptanceLines(intent({}), keep)).toEqual([
      { kind: "intent", text: "a" },
      { kind: "keep", text: "Returns 404 for an unknown slug", landingId: "lnd_1" },
    ]);
    expect(acceptanceLines(intent({}), { ...keep, source: "certify" })).toEqual([{ kind: "intent", text: "a" }]);
    // Keep lines alone never make an intent without its own list subject to the rule.
    expect(acceptanceLines(intent({ acceptance: [] }), keep)).toBeNull();
  });

  it("keepSource takes the newest landing by another intent, and only that one", () => {
    const intents: Record<string, Pick<Intent, "acceptance" | "source">> = { int_own: { source: "human", acceptance: ["x"] }, int_b: { source: "agent" }, int_c: { source: "human", acceptance: ["older"] } };
    const landed = [{ landingId: "lnd_3", intentId: "int_own" }, { landingId: "lnd_2" }, { landingId: "lnd_1", intentId: "int_b" }, { landingId: "lnd_0", intentId: "int_c" }];
    expect(keepSource(landed, "int_own", (id) => intents[id] ?? null)).toEqual({ landingId: "lnd_1", intentId: "int_b", source: "agent" });
    expect(keepSource([], "int_own", () => null)).toBeNull();
    expect(keepSource(undefined, "int_own", () => null)).toBeNull();
  });
});

describe("acceptanceGate: what the gate reads", () => {
  const met = (line: string): NoteAcceptance => ({ kind: "intent", line, verdict: "met", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" });

  it("says every line is met only when each is", () => {
    expect(acceptanceGate([met("a"), met("b")])).toEqual({ met: "every acceptance line is met, each with a quote found in the diff (2 lines)" });
    expect(acceptanceGate(undefined)).toBeNull();
    expect(acceptanceGate([])).toBeNull();
  });

  it("names a line not met, of the intent or kept from another landing", () => {
    const g = acceptanceGate([met("a"), { kind: "intent", line: "slugify replaces spaces", verdict: "not met" }, { kind: "keep", line: "Returns 404", verdict: "not met", landingId: "lnd_7" }]);
    expect(g?.notMet).toBe(
      'acceptance not met: line 2 "slugify replaces spaces"; change it so it meets that line, or escalate if the intent cannot be met as written; it breaks what a recent landing by another intent met: keep line 1 "Returns 404" (from landing lnd_7); keep what that landing did unless your intent says otherwise, and escalate if both cannot hold',
    );
  });

  it("names unclear lines of the intent with why, and ignores unclear keep lines", () => {
    const g = acceptanceGate([met("a"), { kind: "intent", line: "b", verdict: "unclear", said: "met", problem: "its quote is from a line the change removes from src/slug.ts" }, { kind: "keep", line: "k", verdict: "unclear" }]);
    expect(g).toEqual({ unclear: 'acceptance not shown met: line 2 "b" (its quote is from a line the change removes from src/slug.ts); the second opinion\'s approval does not count, so a person decides' });
    expect(acceptanceGate([met("a"), { kind: "keep", line: "k", verdict: "unclear" }])).toEqual({ met: "every acceptance line is met, each with a quote found in the diff (1 line)" });
  });

  it("writes the evidence line", () => {
    expect(acceptanceDetail([met("a"), { kind: "intent", line: "b", verdict: "unclear", said: "met", problem: "its quote is not in the added or unchanged lines of src/slug.ts it was shown" }, { kind: "keep", line: "k", verdict: "not met" }])).toBe(
      'line 1 met: src/slug.ts "const lower = text.toLowerCase();"; line 2 unclear: answered met but its quote is not in the added or unchanged lines of src/slug.ts it was shown; keep line 1 not met',
    );
  });
});

describe("reading what models and stores give", () => {
  it("parseAcceptance reads numbers, digits, places and verdict spellings", () => {
    expect(
      parseAcceptance([
        { line: 1, verdict: "met", path: " src/a.ts ", quote: "const a = 1;" },
        { line: "2", verdict: "Not_Met", path: "", quote: "" },
        { verdict: "UNCLEAR" },
        { line: 0, verdict: "met" },
        "junk",
        { line: 5, verdict: "maybe" },
      ]),
    ).toEqual([
      { line: 1, verdict: "met", path: "src/a.ts", quote: "const a = 1;" },
      { line: 2, verdict: "not met" },
      { line: 3, verdict: "unclear" },
      { line: 5, verdict: "unclear" },
    ]);
    expect(parseAcceptance(undefined)).toBeUndefined();
    expect(parseAcceptance({ line: 1 })).toBeUndefined();
    // A reply numbering from 0 still lines up with the prompt's numbers.
    expect(parseAcceptance([{ line: 0, verdict: "met" }, { line: 1, verdict: "not met" }])).toEqual([
      { line: 1, verdict: "met" },
      { line: 2, verdict: "not met" },
    ]);
  });

  it("noteAcceptance keeps well-formed entries, capped, and drops the rest", () => {
    const long = "x".repeat(2_000);
    const out = noteAcceptance([
      { kind: "intent", line: "a", verdict: "met", path: "src/a.ts", quote: `const   a = ${long};` },
      { kind: "keep", line: "k", verdict: "not met", landingId: "lnd_1", extra: "dropped" },
      { kind: "other", line: "x", verdict: "met" },
      { kind: "intent", line: "y", verdict: "perhaps" },
      null,
    ]);
    expect(out).toHaveLength(2);
    expect(out![0]!.quote!.length).toBe(ACCEPTANCE_LIMITS.quoteChars);
    expect(out![0]!.quote!.startsWith("const a = xxx")).toBe(true);
    expect(out![1]).toEqual({ kind: "keep", line: "k", verdict: "not met", landingId: "lnd_1" });
    expect(noteAcceptance("nope")).toBeUndefined();
    expect(noteAcceptance([{ kind: "intent" }])).toBeUndefined();
  });
});

describe("isAbsence: a line that says what must not be there", () => {
  it("reads an absence from no, not, never, nothing, none, without, only, unchanged, untouched, cannot or an n't contraction", () => {
    for (const line of [
      "No other option, file or formatting changes",
      'jsr.json no longer contains the "unstable": ["sloppy-imports"] entry',
      "The token is not logged",
      "Never writes outside src",
      "Nothing else in src changes",
      "None of the tests are deleted",
      "Builds without warnings",
      "Only jsr.json changes",
      "Everything else in jsr.json is unchanged",
      "tests/ is untouched",
      "A request without a slug cannot reach the handler",
      "Doesn't add a dependency",
      "Won’t change the public API",
      "  NO  other   files change ",
    ])
      expect(isAbsence(line), line).toBe(true);
  });

  it("reads every other line as positive, matching whole words only", () => {
    for (const line of [
      "slugify lowercases its input",
      'compilerOptions in tsconfig.base.json contains "rewriteRelativeImportExtensions": true',
      "Returns 404 for an unknown slug",
      "Adds a notice to the README",
      "Exports slugify from src/index.ts",
      "Nonempty input gives a nonempty slug",
      "Notes the change in CHANGELOG.md",
      "",
    ])
      expect(isAbsence(line), line).toBe(false);
  });
});

describe("checkAcceptance: a line stating an absence counts on the model's word", () => {
  const ABSENT: AcceptanceLine[] = [LINES[0]!, { kind: "intent", text: "No console output is added" }];
  const MET_1 = { line: 1, verdict: "met", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" } as const;

  it("answered met with no file or quote: met, basis absence, nothing kept as evidence", () => {
    expect(checkAcceptance(ABSENT, [MET_1, { line: 2, verdict: "met" }], VIEW)).toEqual([
      { kind: "intent", line: LINES[0]!.text, verdict: "met", basis: "quote", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" },
      { kind: "intent", line: "No console output is added", verdict: "met", basis: "absence" },
    ]);
    // A path without a quote is no evidence either.
    expect(checkAcceptance(ABSENT, [MET_1, { line: 2, verdict: "met", path: "src/slug.ts" }], VIEW)[1]).toEqual({ kind: "intent", line: "No console output is added", verdict: "met", basis: "absence" });
  });

  it("a quote the platform finds stays the basis; one it cannot find is dropped and the met rests on the model's word", () => {
    expect(checkAcceptance(ABSENT, [MET_1, { line: 2, verdict: "met", path: "src/slug.ts", quote: 'return lower.replace(/ +/g, "-");' }], VIEW)[1]).toEqual({
      kind: "intent",
      line: "No console output is added",
      verdict: "met",
      basis: "quote",
      path: "src/slug.ts",
      quote: 'return lower.replace(/ +/g, "-");',
    });
    expect(checkAcceptance(ABSENT, [MET_1, { line: 2, verdict: "met", path: "src/slug.ts", quote: "console.log(lower); // nowhere in the diff" }], VIEW)[1]).toEqual({ kind: "intent", line: "No console output is added", verdict: "met", basis: "absence" });
  });

  it("answered not met it still returns the change, naming what the model saw; answered unclear it stays unclear", () => {
    const checked = checkAcceptance(ABSENT, [MET_1, { line: 2, verdict: "not met", path: "src/slug.ts", quote: "console.log(lower);" }], VIEW);
    expect(checked[1]).toEqual({ kind: "intent", line: "No console output is added", verdict: "not met", path: "src/slug.ts", quote: "console.log(lower);" });
    expect(acceptanceGate(checked)).toEqual({
      notMet: 'acceptance not met: line 2 "No console output is added" (it saw src/slug.ts: "console.log(lower);"); change it so it meets that line, or escalate if the intent cannot be met as written',
    });
    expect(checkAcceptance(ABSENT, [MET_1, { line: 2, verdict: "unclear" }], VIEW)[1]).toEqual({ kind: "intent", line: "No console output is added", verdict: "unclear" });
    expect(acceptanceGate(checkAcceptance(ABSENT, [MET_1, { line: 2, verdict: "unclear" }], VIEW))?.unclear).toContain('line 2 "No console output is added" (the second opinion answered unclear)');
  });

  it("a positive line answered met with no quote is still unclear", () => {
    expect(checkAcceptance(ABSENT, [{ line: 1, verdict: "met" }, { line: 2, verdict: "met" }], VIEW)[0]).toEqual({ kind: "intent", line: LINES[0]!.text, verdict: "unclear", said: "met", problem: "it named no file" });
    expect(checkAcceptance(ABSENT, [{ line: 1, verdict: "met", path: "src/slug.ts", quote: "" }, { line: 2, verdict: "met" }], VIEW)[0]).toMatchObject({ verdict: "unclear", said: "met", problem: "it quoted no line" });
  });

  it("the gate's reasons and the evidence line say which lines rest on the model's word", () => {
    const word: NoteAcceptance = { kind: "intent", line: "No console output is added", verdict: "met", basis: "absence" };
    const quoted: NoteAcceptance = { kind: "intent", line: "a", verdict: "met", basis: "quote", path: "src/slug.ts", quote: "const lower = text.toLowerCase();" };
    expect(acceptanceGate([quoted, word])).toEqual({ met: "every acceptance line is met (2 lines): 1 with a quote found in the diff, 1 on the model's word (line 2 states an absence, so there is no changed line to quote)" });
    expect(acceptanceGate([word, { ...word, line: "Never logs the token" }])).toEqual({
      met: "every acceptance line is met (2 lines): 0 with a quote found in the diff, 2 on the model's word (line 1, line 2 state an absence, so there is no changed line to quote)",
    });
    // A keep line on the model's word changes nothing and is not among the intent's lines.
    expect(acceptanceGate([quoted, { ...word, kind: "keep", landingId: "lnd_1" }])).toEqual({ met: "every acceptance line is met, each with a quote found in the diff (1 line)" });
    expect(acceptanceDetail([quoted, word])).toBe('line 1 met: src/slug.ts "const lower = text.toLowerCase();"; line 2 met: on the model\'s word (it states an absence)');
  });

  it("noteAcceptance keeps the basis of a met and drops an odd one", () => {
    expect(
      noteAcceptance([
        { kind: "intent", line: "a", verdict: "met", basis: "absence" },
        { kind: "intent", line: "b", verdict: "met", basis: "quote", path: "src/a.ts", quote: "const a = 1;" },
        { kind: "intent", line: "c", verdict: "met", basis: "guess", path: "src/a.ts", quote: "const a = 1;" },
      ]),
    ).toEqual([
      { kind: "intent", line: "a", verdict: "met", basis: "absence" },
      { kind: "intent", line: "b", verdict: "met", basis: "quote", path: "src/a.ts", quote: "const a = 1;" },
      { kind: "intent", line: "c", verdict: "met", path: "src/a.ts", quote: "const a = 1;" },
    ]);
  });
});
