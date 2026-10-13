import { describe, expect, it } from "vitest";
import type { Proposal } from "@fire_trident/core";
import { colors, formatReview } from "../src/format.ts";
import { lookHereFirst, parseHunks, reviewOf, type ReviewView } from "../src/review.ts";

/** `ft review`: the change kept for the reviewer, code first, and every kept diff with --diff. */

const plain = colors(false);
const AUTH_LINE = 'if (c.req.header("Authorization") !== `Bearer ${c.env.ADMIN_TOKEN}`) return c.text("unauthorized", 401);';

const ROUTE_HUNKS = ["@@ -2,3 +2,7 @@", " const app = new Router();", ' app.get("/:code", get);', '+app.delete("/:code", async (c) => {', `+  ${AUTH_LINE}`, "+  return c.body(null, 204);", "+});", " export default app;"].join("\n");
/** A residual file whose kept diff is longer than "look here first" shows. */
const LONG_HUNKS = ["@@ -1,0 +1,15 @@", ...Array.from({ length: 15 }, (_, i) => `+line ${i + 1}`)].join("\n");

const VIEW: ReviewView = {
  files: [
    { path: "src/routes/links.ts", status: "modified", added: 4, removed: 0, hunks: ROUTE_HUNKS, truncated: false },
    { path: "scripts/seed.ts", status: "added", added: 15, removed: 0, hunks: LONG_HUNKS, truncated: true },
  ],
  filesChanged: 3,
  danger: [
    { path: "src/routes/links.ts", line: 5, cls: "auth", pattern: "auth:authorization-header", label: `auth (authorization-header) at src/routes/links.ts:5: ${AUTH_LINE}` },
    { path: "package.json", line: 0, cls: "dependency", pattern: "dependency:manifest", label: "dependency (manifest) at package.json: changed" },
  ],
  residual: ["scripts/seed.ts"],
};

function proposal(over: Record<string, unknown> = {}): Proposal {
  return {
    id: "prp_1",
    colonyId: "web",
    intentId: "int_1",
    agentId: "agt_1",
    workspace: { namespace: "n", name: "w", remote: "r" },
    baseSha: "a",
    headSha: "b",
    writeSet: [{ path: "src/routes/links.ts", blob: "c" }],
    readSet: [],
    declared: { footprint: ["src/routes/links.ts"], summary: "Add an authenticated DELETE" },
    evidence: { checks: [{ name: "danger patterns", ok: false, ms: 0 }], residual: ["scripts/seed.ts"] },
    status: "escalated",
    createdAt: 0,
    reason: "escalated by deterministic: needs a human: auth (authorization-header)",
    ...over,
  } as Proposal;
}

describe("the review view in the CLI", () => {
  it("reads the view defensively and points at the hit line itself", () => {
    expect(reviewOf(proposal())).toBeNull();
    expect(reviewOf(proposal({ review: "x" }))).toBeNull();
    expect(reviewOf(proposal({ review: VIEW }))).toEqual(VIEW);
    const [auth, dep] = lookHereFirst(VIEW, 0).danger;
    expect(auth).toMatchObject({ path: "src/routes/links.ts", line: 5, severe: true, what: ["auth (authorization-header)"] });
    expect(auth!.lines).toEqual([{ kind: "add", text: `  ${AUTH_LINE}`, new: 5 }]);
    expect(dep).toMatchObject({ severe: false, what: ["dependency (manifest): changed"], lines: [] });
    expect(parseHunks(LONG_HUNKS)).toHaveLength(16);
  });
});

describe("formatReview with the kept change", () => {
  it("prints look here first before the reason and the checks", () => {
    const text = formatReview([proposal({ review: VIEW })], [{ id: "int_1", title: "DELETE a link" } as never], plain, 60_000, { colony: "web" });
    const lines = text.split("\n");
    const at = (s: string) => lines.findIndex((l) => l.includes(s));
    expect(text).toContain("  look here first");
    expect(text).toContain("    src/routes/links.ts:5  auth (authorization-header)");
    expect(text).toContain(`      +    5    ${AUTH_LINE}`);
    expect(text).toContain("    package.json  dependency (manifest): changed");
    expect(text).toContain("    scripts/seed.ts  changed outside the declared footprint  +15 −0  truncated");
    expect(text).toContain("      +    1  line 1");
    expect(text).toContain("      +   11  line 11");
    expect(text).not.toContain("line 12");
    expect(text).toContain("      … 4 more lines: ft review web --diff");
    expect(text).toContain("  diff     3 files, +19 −0");
    expect(text).toContain("Full diffs: ft review web --diff");
    // Code first: the spotlight comes before the reason and the checks, and replaces the residual line.
    expect(at("look here first")).toBeLessThan(at("reason"));
    expect(at("reason")).toBeLessThan(at("checks"));
    expect(text).not.toContain("  residual ");
  });

  it("adds every kept file's diff with --diff, danger lines flagged", () => {
    const text = formatReview([proposal({ review: VIEW })], [], plain, 60_000, { colony: "web", diff: true });
    expect(text).toContain("    src/routes/links.ts  modified  +4 −0");
    expect(text).toContain("      @@ -2,3 +2,7 @@");
    expect(text).toContain(`${" ".repeat(11)}3  app.get("/:code", get);`);
    expect(text).toContain(`      +    5    ${AUTH_LINE}  ← danger`);
    expect(text).toContain("    scripts/seed.ts  added  +15 −0  truncated");
    expect(text).toContain("      +   15  line 15");
    expect(text).toContain("    1 more changed file was not kept");
    expect(text).toContain("      … 4 more lines below");
    expect(text).not.toContain("Full diffs:");
  });

  it("draws terminal control characters in agent code as escapes", () => {
    const view = { files: [{ path: "a.ts", status: "modified", added: 1, removed: 0, hunks: "@@ -1,0 +1,1 @@\n+ok();\u001b[1A\u001b[2Kapprove();", truncated: false }], filesChanged: 1, danger: [], residual: ["a.ts"] };
    const text = formatReview([proposal({ review: view })], [], plain, 60_000, { colony: "web", diff: true });
    expect(text).toContain("ok();\\u{1b}[1A\\u{1b}[2Kapprove();");
    expect(text).not.toContain("\u001b");
  });

  it("keeps the old card for a proposal escalated before views were kept", () => {
    const text = formatReview([proposal()], [], plain, 60_000, { colony: "web" });
    expect(text).toContain("  residual scripts/seed.ts");
    expect(text).toContain("  diff     not kept for this proposal");
    expect(text).not.toContain("look here first");
    expect(text).not.toContain("Full diffs:");
  });
});
