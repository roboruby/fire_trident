import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LandingTests, WhyHolds, WhyWalk } from "@fire_trident/core";
import type { Backend } from "../src/api.ts";
import { HoldsLine, HoldsView, WalkLines } from "../src/components/WhyHolds.tsx";

/** The Why tab about today: how the walk found a line's landing, and whether each landing card still holds. */

const SHA = "e".repeat(40);
const same: WhyHolds = { wrote: { path: "src/a.ts", state: "same" }, others: { files: 2, changed: 0, list: [] } };
const changed: WhyHolds = { wrote: { path: "src/a.ts", state: "changed", by: "lnd_9", landings: 1 }, others: { files: 1, changed: 1, list: [{ path: "src/b.ts", state: "deleted", by: "lnd_8", landings: 1 }] } };
const html = (el: ReturnType<typeof createElement>): string => renderToStaticMarkup(el);

describe("the Why tab: does it still hold", () => {
  it("draws the walk under a line's heading: who wrote it, the move followed, the formatting-only landings skipped", () => {
    const walk: WhyWalk = { landingId: "lnd_1", path: "src/util.ts", line: 7, skipped: [{ landingId: "lnd_3", path: "src/a.ts" }], moved: [{ landingId: "lnd_2", from: "src/util.ts", to: "src/a.ts", line: 7 }] };
    const h = html(createElement(WalkLines, { walk, path: "src/a.ts", line: 12 }));
    expect(h).toContain('<div class="why-walk-line">line 12 written by lnd_1 at src/util.ts:7</div>');
    expect(h).toContain('<div class="why-walk-line is-moved">moved from src/util.ts:7 by lnd_2</div>');
    expect(h).toContain('<div class="why-walk-line is-skipped">skipped 1 formatting-only landing: lnd_3</div>');
    expect(html(createElement(WalkLines, { walk, path: "src/a.ts", line: null }))).toBe("");
    expect(html(createElement(WalkLines, { walk: undefined, path: "src/a.ts", line: 12 }))).toBe("");
  });

  it("draws a landing's holds line, with the covering tests from its test row's closure data", () => {
    const row = { status: "certified", reach: { earlier: 1, own: 1, later: 0, earlierFiles: ["test/a.test.ts"], ownFiles: ["test/n.test.ts"], checked: 4 } } as unknown as LandingTests;
    const h = html(createElement(HoldsView, { holds: same, row, cert: { trunkSha: SHA, status: "green" }, wrote: ["src/a.ts"] }));
    expect(h).toContain('class="holds-row is-same"');
    expect(h).toContain("src/a.ts as it wrote it · the 2 other files it wrote or read unchanged · covered by 2 test files, green at eeeeeee");
    const red = html(createElement(HoldsView, { holds: changed, row: null, cert: { trunkSha: SHA, status: "red", failing: [{ name: "x", file: "test/z.test.ts" }] }, wrote: ["src/a.ts"] }));
    expect(red).toContain('class="holds-row is-changed"');
    expect(red).toContain("src/a.ts changed since by lnd_9 · 1 of 1 other file it wrote or read changed since: src/b.ts deleted by lnd_8 · trunk tests red at eeeeeee (1 test file failing)");
    expect(html(createElement(HoldsView, { holds: undefined, row: null, cert: null, wrote: [] }))).toBe("");
  });

  it("falls back to the page's latest certification on a backend without test rows (the simulator)", () => {
    const backend = { mode: "mock" } as unknown as Backend;
    const entry = { landing: { id: "lnd_1" }, note: { proposals: [] }, holds: same };
    const h = html(createElement(HoldsLine, { entry, backend, cert: { trunkSha: SHA, status: "green", counts: { tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0, suites: 1 } }, auto: true }));
    expect(h).toContain("src/a.ts as it wrote it · the 2 other files it wrote or read unchanged · trunk tests green at eeeeeee (3/3)");
    expect(html(createElement(HoldsLine, { entry: { landing: { id: "lnd_1" } }, backend, cert: null, auto: true }))).toBe("");
  });
});
