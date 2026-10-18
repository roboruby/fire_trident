import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ColonySnapshot } from "@fire_trident/core";
import { IntentsTab } from "../src/components/IntentsTab.tsx";
import { IssueBadge, IssueLine } from "../src/components/IssueLink.tsx";
import { buildTree, treeInput } from "../src/intentTree.ts";
import { issueOf } from "../src/issues.ts";
import { ColonyStore } from "../src/store.ts";

// The tab re-renders on a throttled store subscription; a static render needs none.
vi.mock("../src/useStore.ts", () => ({ useThrottledVersion: () => 0 }));

/**
 * Imported GitHub issues on the page (worker colony/issues.ts): an intent of source `external` names its issue. The
 * Intents tab groups such intents as imported issues and links each to its issue; a landing card's intent says which
 * issue it came from. A record that does not look like one the colony writes links nowhere.
 */

const EXT = { kind: "github-issue", repo: "octo-org/site", number: 12, url: "https://github.com/octo-org/site/issues/12", author: "octocat" };

function loaded(intents: unknown[]): ColonyStore {
  const s = new ColonyStore("web");
  s.now = () => 1_000;
  s.applySnapshot({
    colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 },
    files: [],
    intents,
    rules: [],
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { reflex: 0, llm: 0, human: 0 },
    metrics: {},
  } as unknown as ColonySnapshot);
  return s;
}

const imported = { id: "int_1", colonyId: "web", title: "Fix the footer link (octo-org/site#12)", why: "From the public GitHub issue ...", source: "external", footprint: ["src/footer.ts"], priority: 1, status: "open", createdAt: 0, createdBy: "lee", external: EXT };

describe("an imported issue's record", () => {
  it("is shown only as the colony writes it", () => {
    expect(issueOf(EXT)).toEqual(EXT);
    expect(issueOf({ ...EXT, url: "javascript:alert(1)" })).toBeNull();
    expect(issueOf({ ...EXT, url: "https://github.com/someone-else/repo/issues/12" })).toBeNull();
    expect(issueOf({ ...EXT, repo: "octo-org/.." })).toBeNull();
    expect(issueOf({ ...EXT, number: 1.5 })).toBeNull();
    expect(issueOf({ ...EXT, author: "<img src=x>" })).toEqual({ ...EXT, author: "" });
    expect(issueOf(undefined)).toBeNull();
  });
});

describe("the issue links", () => {
  it("a badge and a landing card line link the issue, and say how review reads it", () => {
    const badge = renderToStaticMarkup(createElement(IssueBadge, { external: EXT }));
    expect(badge).toContain('href="https://github.com/octo-org/site/issues/12"');
    expect(badge).toContain('rel="noopener noreferrer nofollow"');
    expect(badge).toContain("issue octo-org/site#12");
    expect(badge).toContain("review reads it as it reads an agent&#x27;s request");
    const line = renderToStaticMarkup(createElement(IssueLine, { external: EXT }));
    expect(line).toContain("From the public issue <a");
    expect(line).toContain(">octo-org/site#12</a> opened by @octocat: imported text, reviewed as untrusted.");
    expect(renderToStaticMarkup(createElement(IssueBadge, { external: { ...EXT, url: "https://evil.example" } }))).toBe("");
    expect(renderToStaticMarkup(createElement(IssueLine, { external: undefined }))).toBe("");
  });

  it("the Intents tab groups imported issues and links each row to its issue", () => {
    const s = loaded([imported]);
    expect(s.intents.get("int_1")?.external).toEqual(EXT);
    expect(s.learnIntents([imported])).toBe(0);
    expect(s.learnedOrigin("int_1")?.external).toEqual(EXT);
    expect(buildTree(treeInput(s)).groups.map((g) => [g.key, g.origin.label])).toEqual([["external", "Imported issues"]]);
    const html = renderToStaticMarkup(createElement(IntentsTab, { store: s, onPick: () => undefined }));
    expect(html).toContain("Imported issues");
    expect(html).toContain('href="https://github.com/octo-org/site/issues/12"');
  });
});
