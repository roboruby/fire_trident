import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ColonyEvent, ColonySnapshot, RecordedEvent } from "@fire_trident/core";
import { recordColony } from "../../../scripts/record_colony.ts";
import { PictureView } from "../src/components/Picture.tsx";
import { PICTURE_FILE, fetchPicture, hasPicture, parsePicture, pictureCommits, pictureLanding, picturePath } from "../src/picture.ts";
import { keyOf, recordingFetch, type Recording } from "../src/playback/recording.ts";
import { FieldSynth, ReplayEngine, Timeline, startingPoint } from "../src/replay.ts";
import { ColonyStore } from "../src/store.ts";

/**
 * The picture panel of a replay: mosaic.json's grid at the replay's newest landing of it, read through the preview route
 * live and from the recording offline, drawn from a fixture, and kept by the recorder for every landing of the file.
 */

const T = 1_791_797_000_000;
const sha = (c: string) => c.repeat(40);
/** The seed project's grid, as demo/mosaic holds it: 100 tiles, every one empty, one line each. */
const SEED = readFileSync(new URL("../../../demo/mosaic/mosaic.json", import.meta.url), "utf8");

/** The seed's grid with the given tiles filled. */
function filled(tiles: Array<[number, number, string]>): string {
  let text = SEED;
  for (const [r, c, color] of tiles) text = text.replace(`{"r": ${r}, "c": ${c}, "color": null}`, `{"r": ${r}, "c": ${c}, "color": "${color}"}`);
  return text;
}

/** A finished mosaic run: the seed lands mosaic.json, then two tile changes land, and one landing touches another file only. */
function run(): RecordedEvent[] {
  const list: ColonyEvent[] = [
    { t: "intent", at: T + 1_000, intentId: "i0", status: "claimed", title: "Create the mosaic project", footprint: ["index.html", PICTURE_FILE, "roll-call.md"] },
    { t: "landing", at: T + 2_000, landingId: "l1", trunkSha: sha("1"), proposalIds: ["p0"], paths: ["index.html", PICTURE_FILE, "roll-call.md"] },
    { t: "intent", at: T + 3_000, intentId: "i1", status: "claimed", title: "Fill tile (0, 1) with ember", footprint: [PICTURE_FILE] },
    { t: "landing", at: T + 4_000, landingId: "l2", trunkSha: sha("2"), proposalIds: ["p1"], paths: [PICTURE_FILE] },
    { t: "landing", at: T + 5_000, landingId: "l3", trunkSha: sha("3"), proposalIds: ["p2"], paths: ["index.html"] },
    { t: "landing", at: T + 6_000, landingId: "l4", trunkSha: sha("4"), proposalIds: ["p3"], paths: [PICTURE_FILE, "roll-call.md"] },
  ];
  return list.map((e, i) => ({ ...e, seq: i + 1 }));
}

const SNAPSHOT: ColonySnapshot = {
  colony: { id: "mosaic", name: "mosaic", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: sha("4"), createdAt: T, regionDepth: 1 },
  files: [
    { path: "index.html", size: 1_126 },
    { path: PICTURE_FILE, size: 4_100 },
    { path: "roll-call.md", size: 120 },
  ],
  intents: [],
  rules: [],
  agents: [],
  recentLandings: [],
  violations: { total: 0, byRule: {} },
  funnel: { proof: 0, reflex: 0, llm: 0, human: 0 },
  metrics: {},
};

/** mosaic.json at each commit of the run. */
const AT: Record<string, string> = {
  [sha("1")]: SEED,
  [sha("2")]: filled([[0, 1, "#e63946"]]),
  [sha("4")]: filled([
    [0, 1, "#e63946"],
    [3, 4, "#F3A712"],
  ]),
};

describe("mosaic.json, read as a picture", () => {
  it("reads the seed project's grid: 10 by 10, one line per tile, every tile empty", () => {
    const p = parsePicture(JSON.parse(SEED));
    expect(p).toMatchObject({ rows: 10, cols: 10, filled: 0 });
    expect(p?.tiles).toHaveLength(100);
    expect(p?.tiles[37]).toEqual({ r: 3, c: 7, color: null });
    // One line per tile, and no two tile lines touch.
    const lines = SEED.split("\n");
    const tileLines = lines.map((l, i) => (l.includes('"color": null') ? i : -1)).filter((i) => i >= 0);
    expect(tileLines).toHaveLength(100);
    expect(tileLines.every((at, k) => k === 0 || at - tileLines[k - 1]! === 2)).toBe(true);
  });

  it("draws only hex colors, keeps tiles inside the grid, and takes its size from the tiles when the file names none", () => {
    const p = parsePicture({ rows: 2, cols: 2, tiles: [{ r: 0, c: 0, color: "#ABC" }, { r: 0, c: 1, color: "red; background: url(x)" }, { r: 1, c: 1, color: "#1d7874" }, { r: 5, c: 0, color: "#ffffff" }, "tile", { r: 1, c: 0, color: 7 }] });
    expect(p).toEqual({
      rows: 2,
      cols: 2,
      filled: 2,
      tiles: [
        { r: 0, c: 0, color: "#abc" },
        { r: 0, c: 1, color: null },
        { r: 1, c: 0, color: null },
        { r: 1, c: 1, color: "#1d7874" },
      ],
    });
    expect(parsePicture({ tiles: [{ r: 2, c: 3, color: "#000" }] })).toMatchObject({ rows: 3, cols: 4, filled: 1 });
    for (const bad of [null, [], "grid", { tiles: "x" }, { tiles: [] }, { rows: 100, cols: 2, tiles: [] }]) expect(parsePicture(bad), JSON.stringify(bad)).toBeNull();
  });

  it("follows the newest landing that changed the file, and names every such commit of a run", () => {
    const landings = run()
      .filter((e): e is RecordedEvent & { t: "landing" } => e.t === "landing")
      .map((e) => ({ id: e.landingId, trunkSha: e.trunkSha, paths: e.paths }));
    expect(pictureLanding(landings)?.id).toBe("l4");
    expect(pictureLanding(landings.slice(0, 3))?.id).toBe("l2");
    expect(pictureLanding([])).toBeNull();
    expect(hasPicture([{ path: "src/mosaic.json" }], [])).toBe(false);
    expect(hasPicture([{ path: PICTURE_FILE }], [])).toBe(true);
    expect(hasPicture([], landings)).toBe(true);
    expect(pictureCommits(run())).toEqual([sha("1"), sha("2"), sha("4")]);
    expect(picturePath("mosaic-1017", sha("2"))).toBe(`/api/colonies/mosaic-1017/preview/${sha("2")}/mosaic.json`);
  });
});

describe("the picture panel", () => {
  it("draws the grid from a fixture: each filled tile in its color, the count, and the commit it was read at", () => {
    const picture = parsePicture(JSON.parse(AT[sha("4")]!))!;
    const html = renderToStaticMarkup(createElement(PictureView, { picture, commit: sha("4") }));
    expect(html).toContain("2 of 100 tiles");
    expect(html.match(/class="picture-tile is-filled"/g)).toHaveLength(2);
    expect(html.match(/class="picture-tile"/g)).toHaveLength(98);
    expect(html).toContain("background-color:#e63946");
    expect(html).toContain("background-color:#f3a712");
    expect(html).toContain('title="tile (3, 4) #f3a712"');
    expect(html).toContain("grid-template-columns:repeat(10, 1fr)");
    expect(html).toContain(`<span class="mono">mosaic.json</span> at <span class="mono">4444444</span>`);
  });

  it("says when the file has not landed yet, and why a read failed, as text", () => {
    expect(renderToStaticMarkup(createElement(PictureView, { picture: null, commit: null, waiting: true }))).toContain("The picture appears when mosaic.json lands.");
    const failed = renderToStaticMarkup(createElement(PictureView, { picture: null, commit: null, error: "<b>no</b> such file." }));
    expect(failed).toContain("The picture could not be read: &lt;b&gt;no&lt;/b&gt; such file.");
  });

  it("is read from a recording with no network, and says what the recording does not hold", async () => {
    const rec: Recording = {
      format: "firetrident-recording",
      version: 1,
      colonyId: "mosaic-rec",
      recordedAt: "",
      record: { source: "recorded", total: 0, first: null, last: null, events: [] },
      reads: { [keyOf(picturePath("mosaic-rec", sha("2")))]: JSON.parse(AT[sha("2")]!) },
      refused: { [keyOf(picturePath("mosaic-rec", sha("3")))]: { status: 404, error: "colony mosaic-rec does not show file contents here" } },
    };
    const network = vi.fn(async () => {
      throw new Error("the network was used");
    });
    const offline = recordingFetch(rec, { fallback: network as unknown as typeof fetch, alias: "stage" });
    // The colony in the address bar may be another name for the recorded one.
    const p = await fetchPicture("stage", sha("2"), offline);
    expect(p).toMatchObject({ rows: 10, cols: 10, filled: 1 });
    expect(p.tiles[1]).toEqual({ r: 0, c: 1, color: "#e63946" });
    await expect(fetchPicture("stage", sha("3"), offline)).rejects.toThrow("colony mosaic-rec does not show file contents here.");
    await expect(fetchPicture("stage", sha("9"), offline)).rejects.toThrow(/^Not in this recording: GET \/api\/colonies\/mosaic-rec\/preview\/9{40}\/mosaic\.json/);
    expect(network).not.toHaveBeenCalled();
  });

  it("follows the replay's position: forward to each landing of the file, and back again on a seek", () => {
    const store = new ColonyStore("mosaic");
    const timeline = new Timeline(run());
    const { snapshot, newFiles } = startingPoint(SNAPSHOT, timeline);
    const engine = new ReplayEngine(store, timeline, snapshot, newFiles, new FieldSynth());
    engine.begin();
    // A colony made from nothing: its files appear as they land, so the panel waits for mosaic.json.
    expect(hasPicture(store.files, store.landings)).toBe(false);
    engine.advanceTo(T + 2_500);
    expect(hasPicture(store.files, store.landings)).toBe(true);
    expect(pictureLanding(store.landings)?.trunkSha).toBe(sha("1"));
    engine.advanceTo(T + 5_500);
    expect(pictureLanding(store.landings)?.trunkSha).toBe(sha("2"));
    engine.advanceTo(T + 7_000);
    expect(pictureLanding(store.landings)?.trunkSha).toBe(sha("4"));
    engine.seek(T + 4_500);
    expect(pictureLanding(store.landings)?.trunkSha).toBe(sha("2"));
  });
});

describe("the recorder keeps the picture", () => {
  /** A public mosaic colony's reads, as the deployment answers them. */
  function deployment(events: RecordedEvent[]) {
    const asked: string[] = [];
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const p = url.pathname;
      asked.push(p + url.search);
      if (p === "/api/colonies/mosaic") return json(SNAPSHOT);
      if (p === "/api/colonies/mosaic/events") return json({ colonyId: "mosaic", source: "recorded", events, next: null, total: events.length, first: T, last: T + 6_000 });
      const preview = /^\/api\/colonies\/mosaic\/preview\/([0-9a-f]{40})\/mosaic\.json$/.exec(p);
      if (preview?.[1]) {
        const text = AT[preview[1]];
        return text ? new Response(text, { headers: { "content-type": "application/json; charset=utf-8", "content-security-policy": "sandbox" } }) : json({ error: "no landing" }, 404);
      }
      return json({ error: `no route for GET ${p}` }, 404);
    });
    return { fetcher, asked };
  }

  it("reads mosaic.json at every landing that changed it, through the preview route", async () => {
    const d = deployment(run());
    const result = await recordColony({ base: "https://staging.example.test", colonyId: "mosaic", fetch: d.fetcher as unknown as typeof fetch, retryMs: 0, now: () => new Date(T) });
    const keys = Object.keys(result.recording.reads).filter((k) => k.includes("/preview/"));
    expect(keys).toEqual([sha("1"), sha("2"), sha("4")].map((s) => `/api/colonies/mosaic/preview/${s}/mosaic.json`));
    expect(parsePicture(result.recording.reads[keys[2]!])).toMatchObject({ filled: 2 });
    expect(result.recording.note).toContain("mosaic.json at each landing that changed it");
  });

  it("asks for no picture in a colony without mosaic.json", async () => {
    const plain = run().map((e) => (e.t === "landing" ? { ...e, paths: e.paths.filter((p) => p !== PICTURE_FILE).concat("src/a.ts") } : e)) as RecordedEvent[];
    const d = deployment(plain);
    const result = await recordColony({ base: "https://staging.example.test", colonyId: "mosaic", fetch: d.fetcher as unknown as typeof fetch, retryMs: 0 });
    expect(d.asked.some((a) => a.includes("/preview/"))).toBe(false);
    expect(result.recording.note).not.toContain("mosaic.json");
  });
});
