import { describe, expect, it } from "vitest";
import { SCOPE_LIMITS, cleanGuideTake, guideLine, movedNote, takeLessons, type GuideEntry, type LessonMove } from "../src/guide.ts";

/**
 * Lesson scopes in the field guide's rules: what a take carries ranks the lessons on its intent's footprint first, a
 * lesson written before files of its scope changed says so in its prompt line, and both survive the check a received
 * take goes through.
 */

function entry(id: string, activatedAt: number, extra: Partial<GuideEntry> = {}): GuideEntry {
  return { id, text: `A fact recorded as ${id}.`, agentId: "agt_1", landingId: "lnd_1", activatedAt, activatedBy: "certification", ...extra };
}

const move = (path: string, landingId: string, at: number, extra: Partial<LessonMove> = {}): LessonMove => ({ path, landingId, at, ...extra });

describe("ranking", () => {
  it("puts the lessons on the take's footprint first, then the newest, and keeps the cap", () => {
    const list = [entry("les_old_on", 1_000, { onFootprint: true }), entry("les_new_off", 3_000), entry("les_mid_on", 2_000, { onFootprint: true }), entry("les_mid_off", 2_000)];
    expect(takeLessons(list).map((e) => e.id)).toEqual(["les_mid_on", "les_old_on", "les_new_off", "les_mid_off"]);
    const two = guideLine(list[0]!).length + 1 + guideLine(list[2]!).length + 1;
    expect(takeLessons(list, two).map((e) => e.id)).toEqual(["les_mid_on", "les_old_on"]);
    // Without footprint marks (an older colony), newest first as before.
    expect(takeLessons([entry("les_a", 1_000), entry("les_b", 2_000)]).map((e) => e.id)).toEqual(["les_b", "les_a"]);
  });
});

describe("the line of a lesson written before files changed", () => {
  it("names the files and the landing and intent that changed them, after its provenance", () => {
    const e = entry("les_a", Date.UTC(2026, 9, 14, 3, 12), {
      text: "Routes register in src/routes/index.ts.",
      movedSince: [move("src/routes/index.ts", "lnd_8", 3_000, { intentId: "int_8", title: "Move the routes" }), move("src/app.ts", "lnd_8", 3_000, { intentId: "int_8", title: "Move the routes" }), move("src/b.ts", "lnd_9", 2_000)],
    });
    expect(guideLine(e)).toBe(
      '- Routes register in src/routes/index.ts. (agent agt_1, an agent; landing lnd_1; active since 2026-10-14 03:12, by a green certification) Written before these files changed: src/routes/index.ts, src/app.ts (landing lnd_8, "Move the routes"); src/b.ts (landing lnd_9).',
    );
    expect(guideLine(entry("les_b", 0))).not.toContain("Written before");
    expect(guideLine(entry("les_c", 0, { movedSince: [] }))).not.toContain("Written before");
  });

  it("names at most SCOPE_LIMITS.shown files, then how many more", () => {
    const moved = Array.from({ length: SCOPE_LIMITS.shown + 3 }, (_, i) => move(`src/f${i}.ts`, "lnd_2", 100));
    const note = movedNote(moved);
    expect(note).toBe(`Written before these files changed: ${moved.slice(0, SCOPE_LIMITS.shown).map((m) => m.path).join(", ")} (landing lnd_2); and 3 more.`);
  });
});

describe("a received take", () => {
  it("keeps the footprint mark and the moved files, checked field by field, and ranks again", () => {
    const got = cleanGuideTake({
      lessons: [
        entry("les_new", 2_000),
        {
          ...entry("les_old", 1_000),
          onFootprint: true,
          movedSince: [
            { path: "src/a.ts", landingId: "lnd_2", at: 1_500, intentId: "int_2", title: "  Rename\nthe helper " },
            { path: "src/‮b.ts", landingId: "lnd_2", at: 1_500 },
            { path: "src/c.ts", landingId: "bad id!", at: 1_500 },
            { path: "src/d.ts", landingId: "lnd_3", at: "later" },
            { path: "src/e.ts", landingId: "lnd_3", at: 1_400, intentId: 7, title: 9 },
            "a string",
          ],
        },
        { ...entry("les_odd", 500), onFootprint: "yes", movedSince: "src/a.ts" },
      ],
    });
    expect(got?.lessons.map((e) => e.id)).toEqual(["les_old", "les_new", "les_odd"]);
    expect(got?.lessons[0]!.movedSince).toEqual([
      { path: "src/a.ts", landingId: "lnd_2", at: 1_500, intentId: "int_2", title: "Rename the helper" },
      { path: "src/e.ts", landingId: "lnd_3", at: 1_400 },
    ]);
    expect(got?.lessons[2]).not.toHaveProperty("onFootprint");
    expect(got?.lessons[2]).not.toHaveProperty("movedSince");
    // At most the files a scope keeps.
    const many = cleanGuideTake({ lessons: [{ ...entry("les_m", 1), movedSince: Array.from({ length: 40 }, (_, i) => move(`f${i}`, "lnd_1", 1)) }] });
    expect(many?.lessons[0]!.movedSince).toHaveLength(SCOPE_LIMITS.paths);
  });
});
