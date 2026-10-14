import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildLabel, buildTitle, commitHref, fetchAbout, parseAbout, type About } from "../src/about.ts";
import { BuildTag } from "../src/components/BuildTag.tsx";
import { TopBar } from "../src/components/TopBar.tsx";
import { ColonyStore } from "../src/store.ts";

/** Every page says which build is serving: GET /api/about, read defensively, shown as "build <commit>". */

const ABOUT: About = {
  commit: "f9c7aad",
  versionId: "3f2a1b9c-0d4e-4f6a-9b8c-7d6e5f4a3b2c",
  versionTag: "f9c7aad",
  deployedAt: "2026-10-14T18:02:11.123Z",
  flags: ["FT_INLINE", "FT_TEXT_MERGE"],
};

// The top bar asks for the build through useAbout; here it answers at once. Its store subscription has no server
// rendering, so the test renders the bar once, as it first paints.
vi.mock("../src/about.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/about.ts")>()), useAbout: () => ABOUT }));
vi.mock("../src/useStore.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/useStore.ts")>()), useThrottledVersion: () => 0 }));

describe("GET /api/about, read by the page", () => {
  it("keeps what the server said", () => {
    expect(parseAbout({ service: "firetrident", ...ABOUT })).toEqual(ABOUT);
  });

  it("drops what it cannot use, and answers null for anything but an object", () => {
    expect(parseAbout({ commit: 7, versionId: "", versionTag: "a\nb", deployedAt: "later", flags: ["FT_INLINE", 3, "<b>", "FT_X"] })).toEqual({
      commit: null,
      versionId: null,
      versionTag: null,
      deployedAt: null,
      flags: ["FT_INLINE", "FT_X"],
    });
    expect(parseAbout(null)).toBeNull();
    expect(parseAbout(["f9c7aad"])).toBeNull();
    expect(parseAbout("f9c7aad")).toBeNull();
  });

  it("is null when the server does not answer it: an older deployment, a page instead of JSON, no network", async () => {
    const answer = (res: Response | Error) => (async () => (res instanceof Error ? Promise.reject(res) : res)) as unknown as typeof fetch;
    expect(await fetchAbout(answer(new Response(JSON.stringify(ABOUT), { headers: { "content-type": "application/json" } })))).toEqual(ABOUT);
    expect(await fetchAbout(answer(new Response(JSON.stringify({ error: "no route for GET /api/about" }), { status: 404 })))).toBeNull();
    expect(await fetchAbout(answer(new Response("<!doctype html>", { headers: { "content-type": "text/html" } })))).toBeNull();
    expect(await fetchAbout(answer(new TypeError("Failed to fetch")))).toBeNull();
  });
});

describe("the build tag", () => {
  it("says build <commit>, or the Worker version when the deployment names no commit", () => {
    expect(buildLabel(ABOUT)).toBe("build f9c7aad");
    expect(buildLabel({ ...ABOUT, commit: null })).toBe("version 3f2a1b9c");
    expect(buildLabel({ ...ABOUT, commit: null, versionId: null })).toBeNull();
    expect(buildLabel(null)).toBeNull();
  });

  it("tells the rest on hover: commit, Worker version and tag, deploy time in UTC, flags on", () => {
    expect(buildTitle(ABOUT)).toBe("Commit f9c7aad · Worker version 3f2a1b9c-0d4e-4f6a-9b8c-7d6e5f4a3b2c (tag f9c7aad) · deployed 2026-10-14 18:02 UTC · flags on: FT_INLINE, FT_TEXT_MERGE");
    expect(buildTitle({ commit: null, versionId: null, versionTag: null, deployedAt: null, flags: [] })).toBe("no flags on");
  });

  it("links to the commit when it looks like one", () => {
    expect(commitHref(ABOUT)).toBe("https://github.com/roboruby/fire_trident/commit/f9c7aad");
    expect(commitHref({ ...ABOUT, commit: "f9c7aad-dirty" })).toBe("https://github.com/roboruby/fire_trident/commit/f9c7aad");
    expect(commitHref({ ...ABOUT, commit: "local-build" })).toBeNull();
    expect(commitHref({ ...ABOUT, commit: "f9c7aadz" })).toBeNull();
  });

  it("renders a link, a plain label, or nothing", () => {
    const linked = renderToStaticMarkup(createElement(BuildTag, { about: ABOUT, className: "brand-build" }));
    expect(linked).toContain('<a class="build-tag mono brand-build" href="https://github.com/roboruby/fire_trident/commit/f9c7aad" target="_blank" rel="noreferrer"');
    expect(linked).toContain(">build f9c7aad</a>");
    expect(renderToStaticMarkup(createElement(BuildTag, { about: { ...ABOUT, commit: null } }))).toMatch(/^<span class="build-tag mono" title="Worker version [^"]+">version 3f2a1b9c<\/span>$/);
    expect(renderToStaticMarkup(createElement(BuildTag, { about: null }))).toBe("");
  });

  it("sits after the product name in the colony's top bar, and stays out of director recordings", () => {
    const store = new ColonyStore("web");
    expect(renderToStaticMarkup(createElement(TopBar, { store }))).toMatch(/<div class="brand-name">FireTrident<a class="build-tag mono brand-build"[^>]*>build f9c7aad<\/a><\/div>/);
    expect(renderToStaticMarkup(createElement(TopBar, { store, director: true }))).not.toContain("build f9c7aad");
  });
});
