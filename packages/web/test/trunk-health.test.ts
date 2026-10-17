import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ColonySnapshot } from "@fire_trident/core";
import { TargetView } from "../src/components/FirstScreen.tsx";
import { ColonyStore } from "../src/store.ts";
import { targetOf } from "../src/target.ts";
import { readTrunkHealth, trunkHealthOf } from "../src/trunkhealth.ts";

/**
 * Trunk health on the colony page (trunkhealth.ts, components/TrunkHealth.tsx): the server's report read defensively,
 * read only for a live colony, and shown as a second line of the first screen's Certified row with the rest in its title.
 */

const MEASURED = {
  status: "measured",
  text: "red 2 times in 400 landings, 3.4 min to green at p50, 0 landings built on red",
  detail: ["Red for 6.8 min of the 2.0 d measured (0.2%).", 7, ""],
  red: { ms: 408_000, share: 0.0024, toGreen: { episodes: 2, p50Ms: 204_000, p90Ms: 204_000, maxMs: 204_000 } },
};

function respond(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

describe("trunk health: the server's report", () => {
  it("reads a measured report, its sentences, and whether trunk is red now", () => {
    expect(trunkHealthOf(MEASURED)).toEqual({ measured: true, red: false, text: MEASURED.text, detail: ["Red for 6.8 min of the 2.0 d measured (0.2%)."] });
    expect(trunkHealthOf({ ...MEASURED, red: { ...MEASURED.red, since: 5 } })?.red).toBe(true);
  });

  it("reads a report with no numbers as its line and the reason", () => {
    const h = trunkHealthOf({ status: "no-tests", text: "trunk health not measured: certification found no test this platform can run", reason: "no test files (*.test.ts or *.test.js)" });
    expect(h).toEqual({ measured: false, red: false, text: "trunk health not measured: certification found no test this platform can run", detail: ["no test files (*.test.ts or *.test.js)"] });
  });

  it("is nothing for anything else", () => {
    for (const raw of [null, undefined, 5, "red", [], {}, { status: "bad", text: "x" }, { status: "measured" }, { status: "off", text: "  " }]) expect(trunkHealthOf(raw)).toBeNull();
  });

  it("reads GET /metrics for a live colony only, and says why when it cannot", async () => {
    expect(await readTrunkHealth("web", "live", respond({ trunkHealth: MEASURED }))).toMatchObject({ state: "loaded", health: { text: MEASURED.text } });
    expect(await readTrunkHealth("web", "live", respond({ metrics: {} }))).toEqual({ state: "unknown", why: "this server does not report trunk health" });
    expect(await readTrunkHealth("web", "live", respond({ error: "colony not found" }, 404))).toEqual({ state: "unknown", why: "the server answered 404" });
    expect(await readTrunkHealth("web", "live", respond("not json"))).toEqual({ state: "unknown", why: "the server's answer was not JSON" });
    const fail = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await readTrunkHealth("web", "live", fail)).toEqual({ state: "unknown", why: "the colony API could not be reached" });
    let asked = 0;
    const counting = (async () => {
      asked++;
      return new Response("{}");
    }) as typeof fetch;
    expect((await readTrunkHealth("web", "replay", counting)).state).toBe("unknown");
    expect((await readTrunkHealth("web", "mock", counting)).state).toBe("unknown");
    expect(asked).toBe(0);
  });
});

describe("trunk health: the Certified row", () => {
  function target() {
    const s = new ColonyStore("web");
    s.applySnapshot({
      colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: "b".repeat(40), greenSha: "a".repeat(40), createdAt: 0, regionDepth: 1 },
      files: [],
      intents: [],
      rules: [],
      agents: [],
      recentLandings: [],
      violations: { total: 0, byRule: {} },
      funnel: { reflex: 0, llm: 0, human: 0 },
      metrics: {},
    } as unknown as ColonySnapshot);
    return targetOf(s, { state: "loaded", globs: [] });
  }

  it("shows the line under the certification, with the sentences in its title", () => {
    const html = renderToStaticMarkup(createElement(TargetView, { target: target(), health: trunkHealthOf({ ...MEASURED, red: { ...MEASURED.red, since: 5 } }) }));
    expect(html).toContain(`<div class="fs-health is-red" title="Red for 6.8 min of the 2.0 d measured (0.2%).">${MEASURED.text}</div></dd>`);
  });

  it("dims a line with no numbers, and shows nothing without a report", () => {
    const off = trunkHealthOf({ status: "off", text: "trunk health not measured: trunk certification is off for this colony", reason: "trunk certification is off for this colony" });
    expect(renderToStaticMarkup(createElement(TargetView, { target: target(), health: off }))).toContain('<div class="fs-health fs-none" title="trunk certification is off for this colony">trunk health not measured: trunk certification is off for this colony</div>');
    expect(renderToStaticMarkup(createElement(TargetView, { target: target() }))).not.toContain("fs-health");
  });
});
