import { describe, expect, it } from "vitest";
import type { LandingNotice } from "@fire_trident/core";
import { WHY_CHARS, cleanContext, coveringFootprints, footprintIndex, indexRange, isLiteralEntry, noticeEntry, pickLanded, shortWhy, withLanded } from "../../src/agents/landed.ts";
import type { LandedRow } from "../../src/agents/landed.ts";

/** Why-context at take and landing notices: the pure helpers the colony and the agents share. */

const sha = (c: string): string => c.repeat(40);

describe("the landing path index", () => {
  it("searches an exact path by lookup, and a directory or glob by its literal head", () => {
    expect(indexRange("src/a.ts")).toEqual({ eq: "src/a.ts" });
    expect(indexRange("./src/a.ts")).toEqual({ eq: "src/a.ts" });
    expect(indexRange("src/lib/")).toEqual({ from: "src/lib/", to: "src/lib/\u{10FFFF}" });
    expect(indexRange("src/**/*.ts")).toEqual({ from: "src/", to: "src/\u{10FFFF}" });
    expect(indexRange("src/a*.ts")).toEqual({ from: "src/", to: "src/\u{10FFFF}" });
    // Nothing literal in front: too broad to search.
    expect(indexRange("**/*.ts")).toBeNull();
    expect(indexRange("")).toBeNull();
    expect(isLiteralEntry("src/{a,b}.ts")).toBe(false);
    expect(isLiteralEntry("src/")).toBe(false);
  });

  it("finds the held footprints a landing covers, exact entries by lookup and the rest by pattern", () => {
    const index = footprintIndex([
      { footprint: ["src/a.ts", "docs/none.md"], ref: "int_1" },
      { footprint: ["src/lib/", "docs/*.md"], ref: "int_2" },
      { footprint: ["./src/a.ts", "./src/a.ts"], ref: "int_3" },
      { footprint: ["test/x.ts", ""], ref: "int_4" },
    ]);
    expect(index.exact.get("src/a.ts")).toEqual(["int_1", "int_3"]);
    expect(index.patterns.map((p) => p.entry)).toEqual(["src/lib/", "docs/*.md"]);
    expect(coveringFootprints(index, ["src/a.ts", "src/lib/b.ts", "docs/c.md"])).toEqual([
      { ref: "int_1", paths: ["src/a.ts"] },
      { ref: "int_3", paths: ["src/a.ts"] },
      { ref: "int_2", paths: ["docs/c.md", "src/lib/b.ts"] },
    ]);
    expect(coveringFootprints(index, ["README.md"])).toEqual([]);
  });

  it("picks the newest landings on the footprint, one per landing and intent, with the paths each changed", () => {
    const rows: LandedRow[] = [
      { path: "src/a.ts", at: 10, landingId: "lnd_1", intentId: "int_1" },
      { path: "src/a.ts", at: 30, landingId: "lnd_3", intentId: "int_3" },
      { path: "src/b.ts", at: 30, landingId: "lnd_3", intentId: "int_3" },
      // A group commit: one landing, two intents on the footprint.
      { path: "src/a.ts", at: 20, landingId: "lnd_2", intentId: "int_2" },
      { path: "src/c.ts", at: 20, landingId: "lnd_2", intentId: "int_9" },
      // A range read brings rows the footprint does not cover: dropped.
      { path: "src/zzz.ts", at: 99, landingId: "lnd_9", intentId: "int_9" },
      { path: "src/b.ts", at: 5, landingId: "lnd_0", intentId: null },
    ];
    const footprint = ["src/a.ts", "src/b.ts", "src/c.ts"];
    expect(pickLanded(rows, footprint, 3)).toEqual([
      { landingId: "lnd_3", at: 30, intentId: "int_3", paths: ["src/a.ts", "src/b.ts"] },
      { landingId: "lnd_2", at: 20, intentId: "int_2", paths: ["src/a.ts"] },
      { landingId: "lnd_2", at: 20, intentId: "int_9", paths: ["src/c.ts"] },
    ]);
    // A commit made outside an intent has no intent id.
    expect(pickLanded(rows, ["src/b.ts"], 5).at(-1)).toEqual({ landingId: "lnd_0", at: 5, paths: ["src/b.ts"] });
    expect(pickLanded(rows, ["docs/"], 3)).toEqual([]);
  });

  it("shows an intent's own why on one line, cut to about 300 characters", () => {
    const why = ["Return 404 for unknown slugs.", "", "Builds on: src/http.ts", "Model: default", "", "Spec context (spec.md):", "## Long contracts"].join("\n");
    expect(shortWhy(why)).toBe("Return 404 for unknown slugs.");
    const long = shortWhy("x ".repeat(400));
    expect(long.length).toBe(WHY_CHARS);
    expect(long.endsWith("…")).toBe(true);
    expect(shortWhy(undefined)).toBe("");
  });
});

describe("why-context received over RPC", () => {
  it("keeps the usable entries, checked and capped", () => {
    const good = { landingId: "lnd_1", at: 5, trunkSha: sha("a"), intentId: "int_1", title: "  Fix\nthe router ", why: "because", paths: ["src/a.ts", 3, ""] };
    expect(cleanContext([good, { landingId: "lnd_2" }, null, { landingId: "lnd_3", at: 1, paths: [] }])).toEqual([
      { landingId: "lnd_1", at: 5, trunkSha: sha("a"), intentId: "int_1", title: "Fix the router", why: "because", paths: ["src/a.ts"] },
    ]);
    // A bad commit id is dropped, not trusted; a colony on the previous version sends nothing.
    expect(cleanContext([{ ...good, trunkSha: "HEAD" }])?.[0]).not.toHaveProperty("trunkSha");
    expect(cleanContext(undefined)).toBeUndefined();
    expect(cleanContext([])).toBeUndefined();
    expect(cleanContext([good, good, good, good])).toHaveLength(3);
  });

  it("turns a landing notice into the newest entry of a job's why-context", () => {
    const notice: LandingNotice = { landingId: "lnd_7", trunkSha: sha("b"), paths: [{ path: "src/a.ts", before: sha("1"), after: sha("2") }], intentTitle: "Rename helper", why: "clarity" };
    const entry = noticeEntry(notice, 99);
    expect(entry).toEqual({ landingId: "lnd_7", at: 99, trunkSha: sha("b"), title: "Rename helper", why: "clarity", paths: ["src/a.ts"] });
    const old = [1, 2, 3].map((n) => ({ landingId: `lnd_${n}`, at: n, title: "t", why: "", paths: ["src/a.ts"] }));
    expect(withLanded(old, entry).map((e) => e.landingId)).toEqual(["lnd_7", "lnd_1", "lnd_2"]);
    expect(withLanded([entry], entry)).toHaveLength(1);
  });
});
