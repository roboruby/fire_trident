import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ColonySnapshot, PauseState } from "@fire_trident/core";
import { PauseBannerView } from "../src/components/PauseBanner.tsx";
import { applyPauseEvent, parsePauses, pauseBanner, pauseEventText } from "../src/pause.ts";
import { ColonyStore } from "../src/store.ts";

/** The pause on the colony page: the banner (who paused and why), the store keeping it current, and the log line. */

const own: PauseState = { scope: "colony", by: "maya", reason: "demo reset", at: 1 };
const deployment: PauseState = { scope: "deployment", by: "ops", reason: "spend check", at: 2 };

function loaded(pauses?: unknown): ColonyStore {
  const s = new ColonyStore("web");
  s.applySnapshot({
    colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 },
    files: [],
    intents: [],
    rules: [],
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { reflex: 0, llm: 0, human: 0 },
    metrics: {},
    ...(pauses !== undefined ? { pauses } : {}),
  } as unknown as ColonySnapshot);
  return s;
}

describe("the pause banner", () => {
  it("says who paused and why, what holds, what still works, and how to resume", () => {
    expect(pauseBanner([own], "web")).toEqual({
      headline: "Agents are paused in this colony by maya: demo reset",
      detail:
        "No agent takes work, proposes or starts, and no agent's change lands: changes already in a lane wait there. Reads and every person's action (approve, reject, amend, withdraw, revert) still work.",
      command: "ft resume web",
    });
    expect(pauseBanner([deployment], "web")).toMatchObject({ headline: "Agents are paused on this whole deployment by ops: spend check", command: "ft resume --deployment" });
    expect(pauseBanner([own, deployment], "web")?.detail).toContain("The whole deployment is paused too, by ops: spend check.");
    expect(pauseBanner([], "web")).toBeNull();
  });

  it("renders the banner with the person's words as text, and nothing while agents may work", () => {
    const html = renderToStaticMarkup(createElement(PauseBannerView, { banner: pauseBanner([{ ...own, reason: "<b>stop</b>" }], "web") }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Agents are paused in this colony by maya: &lt;b&gt;stop&lt;/b&gt;");
    expect(html).toContain("<code class=\"mono\">ft resume web</code>");
    // A replay shows the pause as it stood, with no command.
    expect(renderToStaticMarkup(createElement(PauseBannerView, { banner: pauseBanner([own], "web"), replay: true }))).not.toContain("ft resume");
    expect(renderToStaticMarkup(createElement(PauseBannerView, { banner: null }))).toBe("");
  });
});

describe("the pause in the store", () => {
  it("loads the pauses from the snapshot, defensively", () => {
    expect(loaded([own, deployment]).pauses).toEqual([own, deployment]);
    expect(loaded().pauses).toEqual([]);
    expect(parsePauses([{ scope: "galaxy", by: "x", reason: "y" }, "odd", deployment, own])).toEqual([own, deployment]);
    expect(parsePauses([{ scope: "colony", by: "a\nb", reason: "" }])).toEqual([{ scope: "colony", by: "a b", reason: "no reason given", at: 0 }]);
  });

  it("follows paused and resumed events, live and in replays, and logs each", () => {
    const s = loaded();
    s.applyEvents([{ t: "paused", at: 5, scope: "colony", by: "maya", reason: "demo reset" }]);
    expect(s.pauses).toEqual([{ scope: "colony", by: "maya", reason: "demo reset", at: 5 }]);
    s.applyEvents([{ t: "paused", at: 6, scope: "deployment", by: "ops", reason: "spend check" }]);
    expect(s.pauses.map((p) => p.scope)).toEqual(["colony", "deployment"]);
    s.applyEvents([{ t: "resumed", at: 7, scope: "colony", by: "maya", pausedAt: 5 }]);
    expect(s.pauses).toEqual([{ scope: "deployment", by: "ops", reason: "spend check", at: 6 }]);
    expect(s.typeCounts.get("paused")).toBe(2);
    expect(s.typeCounts.get("resumed")).toBe(1);
    s.reset();
    expect(s.pauses).toEqual([]);
    expect(applyPauseEvent([own], { t: "resumed", at: 8, scope: "deployment", by: "ops" })).toEqual([own]);
  });

  it("writes one line per event", () => {
    expect(pauseEventText({ t: "paused", at: 5, scope: "colony", by: "maya", reason: "demo reset" })).toBe("maya paused the colony's agents: demo reset");
    expect(pauseEventText({ t: "resumed", at: 7, scope: "deployment", by: "ops", reason: "budget raised" })).toBe("ops resumed the deployment's agents: budget raised");
    expect(pauseEventText({ t: "resumed", at: 7, scope: "colony", by: "maya" })).toBe("maya resumed the colony's agents");
  });
});
