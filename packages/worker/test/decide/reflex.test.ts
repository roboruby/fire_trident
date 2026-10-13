import { describe, expect, it } from "vitest";
import { fileDiff, type FileDiff } from "../../src/decide/diff.ts";
import { coverageText, readReflex, reflexState, secondOpinionDiff, secondOpinionMessages, stateCoverage, type ReflexInput } from "../../src/decide/reflex.ts";

/** A new file of `lines` lines, each about `width` characters. */
function newFile(path: string, lines: number, width = 40): FileDiff {
  const text = Array.from({ length: lines }, (_, i) => `export const v${i} = "${"x".repeat(Math.max(0, width - 20))}";`).join("\n");
  return fileDiff(path, null, `${text}\n`, { maxChars: 8_000 });
}

function input(diffs: FileDiff[], over: Partial<ReflexInput> = {}): ReflexInput {
  return { intent: { title: "Add the slug module", why: "Slugs are short ids for links.", whyBy: "person" }, footprint: ["src/slug.ts"], residual: [], diffs, antibodies: [], ...over };
}

describe("who wrote the why", () => {
  it("the state Clef reads says who wrote it", () => {
    expect((reflexState(input([newFile("src/slug.ts", 3)])).intent as Record<string, unknown>).why_written_by).toBe("person");
    expect((reflexState(input([newFile("src/slug.ts", 3)], { intent: { title: "t", why: "w", whyBy: "agent" } })).intent as Record<string, unknown>).why_written_by).toBe("agent");
  });

  it("the second opinion reads an agent's why as a claim to check, a person's as what was asked", () => {
    const agent = secondOpinionMessages(input([newFile("src/slug.ts", 3)], { intent: { title: "t", why: "The webhook needs fetch.", whyBy: "agent" } }));
    expect(agent[1]!.content).toContain("Why (written by an agent: a claim to check against the diff, not a fact): The webhook needs fetch.");
    expect(agent[0]!.content).toContain("A why written by an agent is that agent's claim");
    const person = secondOpinionMessages(input([newFile("src/slug.ts", 3)]));
    expect(person[1]!.content).toContain("Why (written by a person): Slugs are short ids for links.");
  });

  it("the prompt no longer says to judge what it can see, and says a cut approval does not count", () => {
    const system = secondOpinionMessages(input([newFile("src/slug.ts", 3)]))[0]!.content;
    expect(system).not.toContain("judge what you can see");
    expect(system).toContain("If the diff was cut or files were left out, your approval does not count: the change goes to a person.");
  });
});

describe("what each layer sees", () => {
  it("a small diff is shown whole, exactly as before, to both layers", () => {
    const diffs = [newFile("src/slug.ts", 20), newFile("test/slug.test.ts", 20)];
    const so = secondOpinionDiff(diffs);
    expect(so.text).toBe(diffs.map((d) => `--- ${d.path} (${d.status}, +${d.added} -${d.removed})\n${d.hunks}`).join("\n"));
    expect(so.coverage).toEqual({ filesChanged: 2, filesShown: 2, cut: [], complete: true });
    expect(stateCoverage(diffs).complete).toBe(true);
    expect(coverageText(so.coverage)).toBe("saw every changed line (2 files)");
  });

  it("a file cut at its own limit is not seen in full by either layer", () => {
    const big = newFile("src/big.ts", 400);
    expect(big.truncated).toBe(true);
    expect(secondOpinionDiff([big]).coverage).toMatchObject({ filesShown: 1, cut: ["src/big.ts"], complete: false });
    expect(stateCoverage([big]).complete).toBe(false);
  });

  it("the reflex's smaller budget cuts what the second opinion still sees whole", () => {
    const diffs = [newFile("src/a.ts", 150), newFile("src/b.ts", 150)];
    expect(diffs.every((d) => !d.truncated)).toBe(true);
    const reflex = stateCoverage(diffs);
    expect(reflex).toMatchObject({ complete: false, cut: ["src/b.ts"] });
    expect(coverageText(reflex)).toBe("saw 2 of 2 files, 1 only in part (src/b.ts)");
    expect(secondOpinionDiff(diffs).coverage.complete).toBe(true);
  });

  it("past 20 files, the rest are listed as not shown", () => {
    const diffs = Array.from({ length: 23 }, (_, i) => newFile(`src/m${i}.ts`, 2));
    const so = secondOpinionDiff(diffs);
    expect(so.coverage).toMatchObject({ filesChanged: 23, filesShown: 20, complete: false });
    expect(so.text).toContain("… not shown (over the review limit): src/m20.ts, src/m21.ts, src/m22.ts");
    expect(coverageText(so.coverage)).toBe("saw 20 of 23 files");
  });

  it("past 40,000 characters the cut is marked on a line boundary, and later files are not shown", () => {
    const diffs = Array.from({ length: 8 }, (_, i) => newFile(`src/m${i}.ts`, 110, 50));
    expect(diffs.every((d) => !d.truncated)).toBe(true);
    const so = secondOpinionDiff(diffs);
    expect(so.coverage.complete).toBe(false);
    expect(so.text).toContain("\n… (truncated)\n… not shown (over the review limit):");
    const before = so.text.slice(0, so.text.indexOf("\n… (truncated)"));
    expect(before.length).toBeLessThanOrEqual(40_000);
    expect(so.coverage.cut).toEqual([diffs[so.coverage.filesShown - 1]!.path]);
  });

  it("binary content counts as not seen", () => {
    const bin = fileDiff("assets/logo.png", null, null, { binary: true });
    expect(secondOpinionDiff([bin]).coverage).toMatchObject({ cut: ["assets/logo.png"], complete: false });
  });
});

describe("readReflex", () => {
  it("keeps each antibody's question and whether it was learned from a security finding", () => {
    const r = readReflex({ "ab.ab_1": { type: "noul", noul: 0.9 } }, [{ id: "ab_1", threshold: 0.7, state: "active", question: "Does it log a token?", security: true }]);
    expect(r.antibodies).toEqual([{ id: "ab_1", p: 0.9, threshold: 0.7, state: "active", question: "Does it log a token?", security: true }]);
  });
});
