import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LineTrace, blobId, findGoalConflict, findTwins, mergeText, removedLines, titleScore, validateProposal } from "@fire_trident/core";
import type { IntentFacts, RemovedOwner } from "@fire_trident/core";
import { TryIt } from "../src/landing/TryIt.tsx";
import {
  GOAL_INTENTS,
  GOAL_LANDED_AT,
  GOAL_LANDING,
  GOAL_NOW,
  GOAL_PATH,
  GOAL_VERSIONS,
  MERGE_PATH,
  MERGE_PRESETS,
  READ_PATH,
  READ_SEEN,
  READ_TRUNK,
  TWIN_FIRST,
  TWIN_SECOND,
  goalScene,
  mergeScene,
  readScene,
  short,
  twinScene,
  type GoalIntentId,
  type MergePreset,
} from "../src/landing/tryit.ts";

/**
 * The "try the rules" panel of the landing page: each scene's default inputs go through the same core function the
 * worker calls, and the sentence the page shows says what that function decided; the panel runs with no server, and
 * sits right after the with-and-without panel.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** Text as React writes it into HTML. */
const html = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

/** The panel as first drawn: every scene on its default inputs. */
const page = renderToStaticMarkup(createElement(TryIt));

const preset = (id: MergePreset["id"]) => MERGE_PRESETS.find((p) => p.id === id)!.inputs;

describe("scene 1: two agents edit one file from the same trunk", () => {
  it("lands the default edits (different lines) as a line-by-line merge, with the text core mergeText gives", () => {
    const i = preset("lines");
    const r = mergeText(i.base, i.trunk, i.change, undefined, { insertions: true });
    expect(r.clean).toBe(true);
    if (!r.clean) return;
    expect(r.rule).toBeUndefined();
    expect(r.text).toContain("maxLinks = 200");
    expect(r.text).toContain("count <= maxLinks");
    const out = mergeScene(i);
    expect(out).toEqual({
      kind: "merged",
      rule: null,
      text: r.text,
      sentence: `Lands as a line-by-line merge: trunk moved ${MERGE_PATH} (expected ${short(blobId(i.base))}, trunk has ${short(blobId(i.trunk))}), and the two edits touch different lines of the base, so the trunk writer lands the text below and records the merge in the landing and its lineage note.`,
    });
    expect(page).toContain(html(out.sentence));
    expect(page).toContain(`<pre class="mono">${html(r.text)}</pre>`);
  });

  it("lands two insertions at one place by the insertion rule, trunk's lines first", () => {
    const i = preset("insert");
    const r = mergeText(i.base, i.trunk, i.change, undefined, { insertions: true });
    expect(r).toMatchObject({ clean: true, rule: "insertions" });
    const out = mergeScene(i);
    expect(out.kind).toBe("merged");
    if (out.kind !== "merged") return;
    expect(out.rule).toBe("insertions");
    expect(out.text).toBe(r.clean ? r.text : "");
    expect(out.text.indexOf("maxTags")).toBeGreaterThan(0);
    expect(out.text.indexOf("maxNotes")).toBeGreaterThan(out.text.indexOf("maxTags"));
    expect(out.sentence).toBe(
      `Lands by the insertion rule: trunk moved ${MERGE_PATH} (expected ${short(blobId(i.base))}, trunk has ${short(blobId(i.trunk))}), and both agents only inserted lines at the same place of the base, so their union lands, trunk's lines first; the lineage note records the merge with rule "insertions".`,
    );
    // Without the rule, git's rules call the same two insertions a conflict.
    expect(mergeText(i.base, i.trunk, i.change)).toEqual({ clean: false, conflicts: 1, lines: [4] });
  });

  it("sends two edits of the same line back, naming the hunk as the trunk writer's reason does", () => {
    const i = preset("same");
    expect(mergeText(i.base, i.trunk, i.change, undefined, { insertions: true })).toEqual({ clean: false, conflicts: 1, lines: [2] });
    const out = mergeScene(i);
    expect(out).toEqual({
      kind: "back",
      sentence: `Goes back to its agent: stale: ${MERGE_PATH} (expected ${short(blobId(i.base))}, trunk has ${short(blobId(i.trunk))}); text merge of ${MERGE_PATH}: 1 conflicting hunk, at line 2 of its base.`,
    });
  });

  it("lands the change as it is when trunk did not move, and names every hunk when two conflict", () => {
    const i = preset("lines");
    expect(mergeScene({ ...i, trunk: i.base })).toEqual({ kind: "lands", sentence: `Lands as it is: trunk still holds the version the change started from (${MERGE_PATH} is blob ${short(blobId(i.base))}), so there is nothing to merge.` });
    const two = mergeScene({ base: i.base, trunk: i.base.replace("maxLinks = 100", "maxLinks = 200").replace("count < maxLinks", "count > maxLinks"), change: i.base.replace("maxLinks = 100", "maxLinks = 500").replace("count < maxLinks", "count <= maxLinks") });
    expect(two.sentence).toContain("2 conflicting hunks, at lines 2 and 6 of its base.");
  });
});

describe("scene 2: a change read a file that moved", () => {
  it("goes back stale on the default inputs, as validateProposal decides, and qualifies for import-name revalidation", () => {
    const occ = validateProposal({ readSet: [{ path: READ_PATH, blob: blobId(READ_SEEN) }], writeSet: [] }, (p) => (p === READ_PATH ? blobId(READ_TRUNK) : null), []);
    expect(occ).toEqual({ eligible: false, stale: [{ path: READ_PATH, expected: blobId(READ_SEEN), actual: blobId(READ_TRUNK) }] });
    const out = readScene({ seen: READ_SEEN, trunk: READ_TRUNK, deleted: false });
    expect(out.kind).toBe("back");
    expect(out.sentence).toBe(`Goes back to its agent: stale: ${READ_PATH} (expected ${short(blobId(READ_SEEN))}, trunk has ${short(blobId(READ_TRUNK))}).`);
    expect(out.lane).toContain("With import-name revalidation on, the trunk writer looks again");
    expect(out.lane).toContain("it imports maxLinks from it");
    expect(out.lane).toContain("That growth check reads the file's statements in the worker, so it is not run here.");
    expect(page).toContain(html(out.sentence));
    expect(page).toContain(html(out.lane ?? ""));
  });

  it("lands when trunk still holds the version the change read", () => {
    const out = readScene({ seen: READ_SEEN, trunk: READ_SEEN, deleted: false });
    expect(out).toEqual({ kind: "lands", sentence: `Lands: ${READ_PATH} is still the version the change read (blob ${short(blobId(READ_SEEN))}), so its read set holds and the change goes on.`, lane: null });
  });

  it("goes back as usual when trunk deleted the file: revalidation does not apply", () => {
    const out = readScene({ seen: READ_SEEN, trunk: READ_TRUNK, deleted: true });
    expect(out.kind).toBe("back");
    expect(out.sentence).toBe(`Goes back to its agent: stale: ${READ_PATH} (expected ${short(blobId(READ_SEEN))}, trunk has absent).`);
    expect(out.lane).toBe("Import-name revalidation does not apply: the file it read is gone from trunk, so the change goes back as usual.");
  });
});

describe("scene 3: goal conflict", () => {
  /** The trunk writer's trace for the scene: one landing, which created the file. */
  function owners(landed: string, proposed: string): RemovedOwner[] {
    const trace = new LineTrace(landed, removedLines(landed, proposed));
    trace.step(null);
    return trace.owners().map((o) => ({ landingId: GOAL_LANDING, at: GOAL_LANDED_AT, rank: 0, path: GOAL_PATH, removed: o.removed, lines: o.lines, intentId: "int_rust", proposalId: "prp_rust" }));
  }
  const intent = (id: string): IntentFacts | null => (Object.hasOwn(GOAL_INTENTS, id) ? GOAL_INTENTS[id as GoalIntentId] : null);

  it("holds the Go and TypeScript versions, each naming the Rust landing it would undo, as findGoalConflict words it", () => {
    for (const id of ["int_go", "int_ts"] as const) {
      const traced = owners(GOAL_VERSIONS.int_rust, GOAL_VERSIONS[id]);
      expect(traced).toEqual([expect.objectContaining({ removed: 5, lines: 7 })]);
      const conflict = findGoalConflict({ intentId: id, owners: traced, intent, now: GOAL_NOW });
      expect(conflict?.reason).toBe(
        `would undo 5 lines in ${GOAL_PATH} that landing ${GOAL_LANDING} wrote 3 minutes ago for intent "${GOAL_INTENTS.int_rust.title}" (${GOAL_INTENTS.int_rust.why}), a different intent; a person decides which goal stands`,
      );
      const out = goalScene(GOAL_VERSIONS.int_rust, GOAL_VERSIONS[id], id);
      expect(out).toEqual({ kind: "waits", sentence: `Waits for a person: ${conflict?.reason}.` });
      expect(page).toContain(html(out.sentence));
    }
  });

  it("lets a change that touches one line go on, saying how few lines it removes, and one that removes nothing", () => {
    const one = GOAL_VERSIONS.int_rust.replace("Rust 1.80", "Rust 1.81");
    expect(findGoalConflict({ intentId: "int_go", owners: owners(GOAL_VERSIONS.int_rust, one), intent, now: GOAL_NOW })).toBeNull();
    expect(goalScene(GOAL_VERSIONS.int_rust, one, "int_go")).toEqual({
      kind: "goes-on",
      sentence: `Goes on to review: no recent landing of another intent undone, 1 file and 1 removed line traced: it removes 1 of the 7 lines landing ${GOAL_LANDING} wrote, fewer than 3 or less than half.`,
    });
    expect(goalScene(GOAL_VERSIONS.int_rust, GOAL_VERSIONS.int_rust, "int_go")).toEqual({ kind: "goes-on", sentence: "Goes on to review: no line of an existing text file removed." });
    // Re-indenting a line does not remove it.
    expect(goalScene(GOAL_VERSIONS.int_rust, GOAL_VERSIONS.int_rust.replace("export const routes", "  export const routes"), "int_go").kind).toBe("goes-on");
  });
});

describe("scene 4: twin intents", () => {
  const defaults = { firstTitle: TWIN_FIRST.title, firstFootprint: TWIN_FIRST.footprint, title: TWIN_SECOND.title, footprint: TWIN_SECOND.footprint };

  it("catches the default pair, as findTwins does: the titles score 1 and the footprints overlap", () => {
    expect(titleScore(TWIN_SECOND.title, TWIN_FIRST.title)).toBe(1);
    const matches = findTwins({ title: TWIN_SECOND.title, footprint: [TWIN_SECOND.footprint] }, [{ id: TWIN_FIRST.id, title: TWIN_FIRST.title, status: "open", footprint: [TWIN_FIRST.footprint] }], GOAL_NOW);
    expect(matches).toEqual([{ id: TWIN_FIRST.id, title: TWIN_FIRST.title, status: "open", score: 1 }]);
    const out = twinScene(defaults);
    expect(out).toEqual({
      kind: "caught",
      score: 1,
      overlap: true,
      sentence: `Caught: the titles score 1.00 (at least 0.8) and the footprints overlap, so nothing is created. This looks like ${TWIN_FIRST.id} "${TWIN_FIRST.title}" (open): take that one, or declare again with force: true if yours is different work.`,
    });
    expect(page).toContain(html(out.sentence));
  });

  it("declares as new when the footprints do not overlap, the titles differ enough, or one asks to take something away", () => {
    expect(twinScene({ ...defaults, footprint: "src/auth/handler.ts" })).toMatchObject({ kind: "new", score: 1, overlap: false, sentence: "Declared as new: the titles score 1.00, but the footprints do not overlap, so the colony creates the intent." });
    const lower = twinScene({ ...defaults, title: "Rate-limit the links API and log bursts" });
    expect(lower.kind).toBe("new");
    expect(lower.score).toBe(Math.round(titleScore("Rate-limit the links API and log bursts", TWIN_FIRST.title) * 100) / 100);
    expect(lower.sentence).toBe(`Declared as new: the titles score ${lower.score.toFixed(2)}, below 0.8, so the colony creates the intent.`);
    expect(twinScene({ ...defaults, title: "Remove rate limiting from /api/links" }).sentence).toBe("Declared as new: the titles score 0, since one asks to take something away and the other does not, so the colony creates the intent.");
    expect(twinScene({ ...defaults, title: "the" }).sentence).toBe("Declared as new: the title has no words left to compare once function words are dropped, so the colony creates the intent.");
  });
});

describe("the section", () => {
  it("has the five scenes, each with a caption naming the core module that decides it", () => {
    for (const id of ["merge", "read", "goals", "twins", "gitmerge"]) expect(page).toContain(`id="try-${id}"`);
    for (const mod of ["core/textmerge.ts", "core/insertions.ts", "core/occ.ts", "core/goalconflict.ts", "core/twins.ts"]) expect(page).toContain(`<code>${mod}</code>`);
    expect(page.match(/<p class="tr-cap">/g)).toHaveLength(5);
    expect(page.match(/<textarea /g)).toHaveLength(8);
    expect(page.match(/<input type="text"/g)).toHaveLength(4);
  });

  it("is titled plainly and sits right after the with-and-without panel, before the questions", () => {
    expect(page).toContain('<section class="l-section" id="try">');
    expect(page).toContain('<h2 class="l-h2">Try the rules.</h2>');
    const landing = read("../src/landing/Landing.tsx");
    const compared = landing.indexOf("<Compared />");
    const tryIt = landing.indexOf("<TryIt />");
    expect(compared).toBeGreaterThan(0);
    expect(landing.slice(compared + "<Compared />".length, tryIt).trim()).toBe("");
    expect(landing.indexOf("<Questions />")).toBeGreaterThan(tryIt);
    expect(landing).toContain('<a href="#try">Try it</a>');
  });

  it("runs with no server: the scenes import only the core package, React, each other and the fifth scene's data, and never fetch", () => {
    for (const file of ["../src/landing/tryit.ts", "../src/landing/TryIt.tsx", "../src/landing/gitmerge.ts"]) {
      const src = read(file);
      expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|localStorage/);
      // Import statements only (one line, or the closing line of a multi-line one): a sample text may quote an import too.
      const from = [...src.matchAll(/^(?:import[^"\n]*|\})\s*from "([^"]+)"(?: with \{[^}\n]*\})?;$/gm)].map((m) => m[1]);
      expect(from.length, file).toBeGreaterThan(0);
      for (const f of from) expect(["@fire_trident/core", "react", "./tryit.ts", "./gitmerge.ts", "./gitmerge.json"], file).toContain(f);
    }
  });
});
