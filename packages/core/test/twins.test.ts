import { describe, expect, it } from "vitest";
import { TWINS, findTwins, footprintsOverlap, stem, titleScore, titleWords, twinEligible } from "../src/twins.ts";
import type { TwinCandidate } from "../src/twins.ts";

const NOW = 10_000_000_000;
const MIN = 60_000;

/** An open intent, or one with the given status (landed `landedAgo` minutes before NOW). */
const c = (id: string, title: string, footprint: string[], status: TwinCandidate["status"] = "open", landedAgo?: number): TwinCandidate => ({
  id,
  title,
  status,
  footprint,
  ...(landedAgo !== undefined ? { landedAt: NOW - landedAgo * MIN } : {}),
});

describe("stem", () => {
  it("lets the forms of a word meet", () => {
    for (const w of ["limiting", "limited", "limits", "limiter", "limit"]) expect(stem(w), w).toBe("limit");
    for (const w of ["validation", "validate", "validating", "validated"]) expect(stem(w), w).toBe("validat");
    for (const w of ["caching", "cache", "cached", "caches"]) expect(stem(w), w).toBe("cach");
    for (const w of ["logging", "logger", "logs", "log"]) expect(stem(w), w).toBe("log");
    for (const w of ["authorization", "authorize", "authorized"]) expect(stem(w), w).toBe("authoriz");
    expect([stem("policies"), stem("applied"), stem("classes"), stem("mapped"), stem("settings")]).toEqual(["policy", "apply", "class", "map", "set"]);
  });

  it("leaves short words, numbers and words that only look inflected", () => {
    for (const w of ["api", "add", "v2", "404", "utf8", "string", "need", "status", "analysis", "process", "user", "order"]) expect(stem(w), w).toBe(w);
    expect(stem("added")).toBe("add");
  });
});

describe("titleWords", () => {
  it("drops case, punctuation, stop words and the verbs that only say do it", () => {
    expect(titleWords("Add rate limiting to /api/links")).toEqual({ words: ["rat", "limit", "api", "link"], removal: false });
    expect(titleWords("Rate-limit the links API")).toEqual({ words: ["rat", "limit", "link", "api"], removal: false });
    expect(titleWords("Implement a new cache for the user's links").words).toEqual(["cach", "user", "link"]);
  });

  it("marks a title that asks to take something away, and leaves the removal word out", () => {
    expect(titleWords("Remove rate limiting from /api/links")).toEqual({ words: ["rat", "limit", "api", "link"], removal: true });
    for (const t of ["Delete the links cache", "Drop the links cache", "Revert the links cache", "Disable the links cache"]) expect(titleWords(t), t).toEqual({ words: ["link", "cach"], removal: true });
  });

  it("has no words for a title of function words only", () => {
    expect(titleWords("To the, of a!")).toEqual({ words: [], removal: false });
  });

  it("reads a title past 500 characters by its start, as declares cap them", () => {
    const long = `Rate-limit the links API ${"word ".repeat(200)}`;
    expect(long.length).toBeGreaterThan(1_000);
    expect(titleWords(`${long} caching`).words).toEqual(["rat", "limit", "link", "api", "word"]);
  });
});

describe("titleScore", () => {
  it("scores titles that ask for the same thing in other words 1", () => {
    expect(titleScore("Add rate limiting to /api/links", "Rate-limit the links API")).toBe(1);
    expect(titleScore("Validate signup form input", "Add input validation to the signup form")).toBe(1);
    expect(titleScore("Cache link lookups", "Add caching for link lookups")).toBe(1);
  });

  it("is the Jaccard of the normalized words, the same both ways", () => {
    // {paginat, link, list} against {paginat, link, list, endpoint}.
    expect(titleScore("Add pagination to the links list", "Paginate the links list endpoint")).toBe(0.75);
    expect(titleScore("Paginate the links list endpoint", "Add pagination to the links list")).toBe(0.75);
    expect(titleScore("Add rate limiting to /api/links", "Add caching to /api/links")).toBe(0.4);
    expect(titleScore("Fix login bug", "Fix logout bug")).toBe(0.5);
  });

  it("is 0 when one title asks to take away what the other adds, or either has no words", () => {
    expect(titleScore("Add rate limiting to /api/links", "Remove rate limiting from /api/links")).toBe(0);
    expect(titleScore("Rate-limit the links API", "Disable rate limiting on links")).toBe(0);
    expect(titleScore("Remove rate limiting from /api/links", "Drop the links API rate limit")).toBe(1);
    expect(titleScore("the", "the")).toBe(0);
    expect(titleScore("", "Rate-limit the links API")).toBe(0);
  });
});

describe("footprintsOverlap", () => {
  it("finds a shared path, and a glob or directory that covers an entry of the other", () => {
    expect(footprintsOverlap(["src/a.ts", "src/b.ts"], ["src/b.ts"])).toBe(true);
    expect(footprintsOverlap(["./src/a.ts"], ["src/a.ts"])).toBe(true);
    expect(footprintsOverlap(["src/links/**"], ["src/links/rate.ts"])).toBe(true);
    expect(footprintsOverlap(["src/links/rate.ts"], ["src/links/**"])).toBe(true);
    expect(footprintsOverlap(["src/links/"], ["src/links/a.ts"])).toBe(true);
    expect(footprintsOverlap(["src/*.ts"], ["src/a.ts"])).toBe(true);
    // Two globs, one covering the other.
    expect(footprintsOverlap(["src/links/**"], ["src/**"])).toBe(true);
    expect(footprintsOverlap(["src/links/**"], ["src/links/**"])).toBe(true);
  });

  it("finds none between disjoint footprints", () => {
    expect(footprintsOverlap(["src/a.ts"], ["src/b.ts"])).toBe(false);
    expect(footprintsOverlap(["src/links/**"], ["src/users/**"])).toBe(false);
    // A path is not a directory without its trailing slash, as everywhere else in the colony.
    expect(footprintsOverlap(["src/links"], ["src/links/a.ts"])).toBe(false);
    expect(footprintsOverlap([], ["src/a.ts"])).toBe(false);
    expect(footprintsOverlap([" ", ""], [""])).toBe(false);
  });

  it("answers no past its budget of glob pairs instead of matching every pair", () => {
    const globs = Array.from({ length: 200 }, (_, i) => `lib${i}/**`);
    const paths = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`);
    // 40,000 pairs, none overlapping until the very last path.
    expect(footprintsOverlap(globs, [...paths, "lib199/x.ts"])).toBe(false);
    expect(footprintsOverlap(globs.slice(0, 50), [...paths, "lib49/x.ts"])).toBe(true);
  });
});

describe("twinEligible", () => {
  it("counts intents open, claimed or proposed, and those landed within half an hour", () => {
    for (const status of ["open", "claimed", "proposed"] as const) expect(twinEligible({ status }, NOW), status).toBe(true);
    expect(twinEligible({ status: "landed", landedAt: NOW - 30 * MIN }, NOW)).toBe(true);
    expect(twinEligible({ status: "landed", landedAt: NOW - 30 * MIN - 1 }, NOW)).toBe(false);
    expect(twinEligible({ status: "landed" }, NOW)).toBe(false);
    for (const status of ["withdrawn", "abandoned"] as const) expect(twinEligible({ status, landedAt: NOW }, NOW), status).toBe(false);
    expect(TWINS.landedMs).toBe(30 * MIN);
  });
});

describe("findTwins", () => {
  const declared = { title: "Rate-limit the links API", footprint: ["src/links/handler.ts"] };

  it("finds the intent whose title and footprint both match, with its score", () => {
    const got = findTwins(declared, [c("int_other", "Add caching to /api/links", ["src/links/**"]), c("int_rate", "Add rate limiting to /api/links", ["src/links/**"])], NOW);
    expect(got).toEqual([{ id: "int_rate", title: "Add rate limiting to /api/links", status: "open", score: 1 }]);
  });

  it("finds nothing on the title alone", () => {
    expect(findTwins(declared, [c("int_rate", "Add rate limiting to /api/links", ["src/users/**", "README.md"])], NOW)).toEqual([]);
  });

  it("finds nothing on the footprint alone", () => {
    expect(findTwins(declared, [c("int_cache", "Add caching to /api/links", ["src/links/handler.ts"])], NOW)).toEqual([]);
    // Below the threshold by one word.
    const near = { title: "Cache link lookups", footprint: ["src/links/handler.ts"] };
    expect(titleScore(near.title, "Cache link lookups in KV")).toBe(0.75);
    expect(findTwins(near, [c("int_kv", "Cache link lookups in KV", ["src/links/handler.ts"])], NOW)).toEqual([]);
  });

  it("counts an intent landed in the last half hour, never one landed earlier or withdrawn", () => {
    const fp = ["src/links/**"];
    expect(findTwins(declared, [c("int_new", "Add rate limiting to /api/links", fp, "landed", 29)], NOW).map((m) => m.id)).toEqual(["int_new"]);
    expect(findTwins(declared, [c("int_old", "Add rate limiting to /api/links", fp, "landed", 31)], NOW)).toEqual([]);
    expect(findTwins(declared, [c("int_gone", "Add rate limiting to /api/links", fp, "withdrawn")], NOW)).toEqual([]);
  });

  it("lists every match best first: score, then live before landed, then the order given; at most maxSimilar", () => {
    const fp = ["src/links/**"];
    const candidates = [
      c("int_handler", "Rate-limit the links API handler", fp),
      c("int_landed", "Rate-limit the links API", fp, "landed", 5),
      c("int_near", "Rate-limit the links API for anonymous callers", fp),
      c("int_claimed", "Add rate limiting to the links API", fp, "claimed"),
      c("int_open", "Rate limit links API", fp),
    ];
    const got = findTwins(declared, candidates, NOW);
    expect(got.map((m) => [m.id, m.score])).toEqual([
      ["int_claimed", 1],
      ["int_open", 1],
      ["int_landed", 1],
      ["int_handler", 0.8],
    ]);
    expect(findTwins(declared, candidates, NOW, { ...TWINS, maxSimilar: 1 }).map((m) => m.id)).toEqual(["int_claimed"]);
    // A looser threshold lets the near one in, its score rounded to two places.
    const loose = findTwins(declared, [c("int_near", "Rate-limit the links API for anonymous callers", fp)], NOW, { ...TWINS, minScore: 0.5 });
    expect(loose).toEqual([{ id: "int_near", title: "Rate-limit the links API for anonymous callers", status: "open", score: 0.67 }]);
  });

  it("finds nothing for a title with no words to compare", () => {
    expect(findTwins({ title: "To the", footprint: ["src/a.ts"] }, [c("int_x", "To the", ["src/a.ts"])], NOW)).toEqual([]);
  });
});
