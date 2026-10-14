import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LandingDiff, NoteCheck } from "@fire_trident/core";
import type { Backend } from "../src/api.ts";
import { LandingChange, NoteBar, NoteSealBadge, noLinesText } from "../src/components/NoteSeal.tsx";
import { CHECKING_SEAL, ReadError, checkFor, checksOf, fetchLandingDiff, fetchNoteCheck, landingDiffOf, sealOf, uncheckedSeal } from "../src/verified.ts";

/** The integrity badge on every lineage note, and the Why tab's "Show the change" toggle. */

const check = (status: string, extra: Partial<NoteCheck> = {}): NoteCheck => ({ landingId: "lnd_1", trunkSha: "a".repeat(40), at: 1, status, ...extra }) as NoteCheck;

const DIFF: LandingDiff = {
  colonyId: "col",
  landingId: "lnd_1",
  trunkSha: "2".repeat(40),
  parentSha: "1".repeat(40),
  path: "src/a.ts",
  before: "a".repeat(40),
  after: "b".repeat(40),
  status: "modified",
  added: 1,
  removed: 1,
  hunks: "@@ -1,2 +1,2 @@\n export const a = 1;\n-export const b = 2;\n+export const b = 3;",
  truncated: false,
};

describe("the note badge", () => {
  it("reads intact, altered and landed-before-notes-were-sealed from the note check", () => {
    expect(sealOf(check("intact"))).toMatchObject({ state: "intact", label: "Note intact" });
    const altered = sealOf(check("altered", { detail: "the note hashes to 1234, the commit's trailer says 5678", ownCopy: true }));
    expect(altered).toEqual({
      state: "altered",
      label: "Note altered",
      detail: "The note on the trunk repository does not match its commit's FT-Note trailer: the note hashes to 1234, the commit's trailer says 5678. FireTrident's own copy still matches the trailer, so it can be put back.",
    });
    expect(sealOf(check("no-trailer"))).toMatchObject({ state: "unsealed", label: "Landed before notes were sealed" });
  });

  it("says when a note is missing or not pushed yet, and when it could not be checked", () => {
    expect(sealOf(check("missing"))).toMatchObject({ state: "missing", label: "Note missing", detail: "The trunk repository has no note for this commit." });
    expect(sealOf(check("pending"))).toMatchObject({ state: "pending", label: "Note not pushed yet" });
    expect(sealOf(check("unreadable", { detail: "the notes commit x could not be read" }))).toEqual({ state: "unchecked", label: "Note not checked", detail: "The commit or its note could not be read: the notes commit x could not be read." });
    for (const odd of [null, undefined, "intact", [check("intact")], { status: "sealed-with-wax" }]) expect(sealOf(odd).state).toBe("unchecked");
    expect(uncheckedSeal("")).toMatchObject({ detail: "The note could not be checked." });
  });

  it("is drawn with its state, its label and the reason on hover", () => {
    const html = renderToStaticMarkup(createElement(NoteSealBadge, { seal: sealOf(check("intact")) }));
    expect(html).toContain('class="seal is-intact"');
    expect(html).toContain("Note intact");
    expect(html).toContain("hashes to the FT-Note trailer its commit carries");
    expect(renderToStaticMarkup(createElement(NoteSealBadge, { seal: sealOf(check("no-trailer")) }))).toContain('class="seal is-unsealed"');
    expect(renderToStaticMarkup(createElement(NoteSealBadge, { seal: CHECKING_SEAL }))).toContain("Checking the note");
  });
});

describe("reading the note check and the change", () => {
  it("picks one landing's check out of an answer, and lists the checks of an answer defensively", () => {
    const answer = { notes: [check("intact", { landingId: "lnd_2" }), check("altered"), { landingId: "lnd_3" }, null] };
    expect(checkFor(answer, "lnd_1")?.status).toBe("altered");
    expect(checkFor(answer, "lnd_3")).toBeNull();
    expect(checkFor({ notes: "x" }, "lnd_1")).toBeNull();
    expect(checksOf(answer).map((c) => c.landingId)).toEqual(["lnd_2", "lnd_1"]);
    expect(checksOf(null)).toEqual([]);
  });

  it("reads the diff route's answer defensively", () => {
    expect(landingDiffOf(DIFF)).toEqual(DIFF);
    expect(landingDiffOf({ ...DIFF, added: -3, before: "", detail: "  ", truncated: "yes" })).toEqual({ ...DIFF, added: 0, before: null, truncated: false });
    expect(landingDiffOf({ ...DIFF, status: "exploded" })).toBeNull();
    expect(landingDiffOf([DIFF])).toBeNull();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the colony once per settled check, again for a note not pushed yet, and at most four at once", async () => {
    let inFlight = 0;
    let most = 0;
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        const landing = new URL(url, "http://x").searchParams.get("landing") ?? "";
        return new Response(JSON.stringify({ notes: [check(landing.startsWith("lnd_p") ? "pending" : "intact", { landingId: landing })] }), { status: 200 });
      }),
    );
    const ids = Array.from({ length: 10 }, (_, i) => `lnd_s${i}`);
    const first = await Promise.all(ids.map((id) => fetchNoteCheck("seal-col", id)));
    expect(first.every((c) => c?.status === "intact")).toBe(true);
    expect(most).toBeLessThanOrEqual(4);
    expect(urls[0]).toBe("/api/colonies/seal-col/notes/verify?landing=lnd_s0");
    await fetchNoteCheck("seal-col", "lnd_s3");
    expect(urls).toHaveLength(10);
    await fetchNoteCheck("seal-col", "lnd_p1");
    await fetchNoteCheck("seal-col", "lnd_p1");
    expect(urls).toHaveLength(12);
  });

  it("gives the server's sentence when the change cannot be shown, and keeps a change once read", async () => {
    const reply = vi.fn(async (url: string) =>
      url.includes("private")
        ? new Response(JSON.stringify({ error: "colony private does not show file contents here: only colonies listed in FT_PUBLIC_GIT or FT_PUBLIC_MCP do" }), { status: 404 })
        : new Response(JSON.stringify(DIFF), { status: 200 }),
    );
    vi.stubGlobal("fetch", reply);
    const failed = await fetchLandingDiff("private", "lnd_1", "src/a.ts").catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ReadError);
    expect((failed as ReadError).status).toBe(404);
    expect((failed as ReadError).message).toBe("Colony private does not show file contents here: only colonies listed in FT_PUBLIC_GIT or FT_PUBLIC_MCP do.");
    expect(await fetchLandingDiff("diff-col", "lnd_1", "src/a b.ts")).toEqual(DIFF);
    expect(await fetchLandingDiff("diff-col", "lnd_1", "src/a b.ts")).toEqual(DIFF);
    expect(reply.mock.calls.map((c) => c[0])).toEqual(["/api/colonies/private/landings/lnd_1/diff?path=src%2Fa.ts", "/api/colonies/diff-col/landings/lnd_1/diff?path=src%2Fa%20b.ts"]);
  });
});

describe("the Show the change toggle", () => {
  const live = { verifyNote: async () => check("intact"), landingDiff: async () => DIFF } as unknown as Backend;

  it("starts closed under a badge that is being checked, on a backend that can read notes", () => {
    const html = renderToStaticMarkup(createElement(NoteBar, { backend: live, landingId: "lnd_1", path: "src/a.ts" }));
    expect(html).toContain('class="lin-note"');
    expect(html).toContain("Checking the note");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Show the change");
    expect(html).not.toContain('class="diff"');
  });

  it("is left out where notes are not in a repository (the simulator), and the badge alone where only checks are", () => {
    expect(renderToStaticMarkup(createElement(NoteBar, { backend: {} as Backend, landingId: "lnd_1", path: "a" }))).toBe("");
    const checksOnly = renderToStaticMarkup(createElement(NoteBar, { backend: { verifyNote: live.verifyNote } as Backend, landingId: "lnd_1", path: "a" }));
    expect(checksOnly).toContain("Checking the note");
    expect(checksOnly).not.toContain("Show the change");
  });

  it("opens onto the review card's diff view with the counts and the blobs", () => {
    const html = renderToStaticMarkup(createElement(LandingChange, { state: { kind: "loaded", diff: DIFF } }));
    expect(html).toContain('class="diff"');
    expect(html).toContain('class="dl dl-del"');
    expect(html).toContain('class="dl dl-add"');
    expect(html).toContain("export const b = 3;");
    expect(html).toContain("+1");
    expect(html).toContain("−1");
    expect(html).toContain("aaaaaaa → bbbbbbb");
    const cut = renderToStaticMarkup(createElement(LandingChange, { state: { kind: "loaded", diff: { ...DIFF, truncated: true, added: 3000, removed: 3000 } } }));
    expect(cut).toContain("The change is longer than this shows (6,000 lines in all)");
  });

  it("says why there are no lines, while it reads, and when the read failed", () => {
    expect(renderToStaticMarkup(createElement(LandingChange, { state: { kind: "loading" } }))).toContain("Reading the change from the trunk repository");
    expect(renderToStaticMarkup(createElement(LandingChange, { state: { kind: "failed", message: "Colony x does not show file contents here." } }))).toContain("Colony x does not show file contents here.");
    const binary = { ...DIFF, status: "binary" as const, added: 0, removed: 0, hunks: "", detail: "The file is binary, so there are no lines to show." };
    const html = renderToStaticMarkup(createElement(LandingChange, { state: { kind: "loaded", diff: binary } }));
    expect(html).toContain("The file is binary, so there are no lines to show.");
    expect(html).not.toContain('class="diff"');
    expect(noLinesText({ ...DIFF, status: "unchanged", hunks: "" })).toBe("This landing left the file as its parent commit had it.");
  });
});
