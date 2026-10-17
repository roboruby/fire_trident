import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RootCommitTag } from "../src/components/RootCommit.tsx";
import { rootOf, rootTitle } from "../src/root.ts";

/** The colony's root commit in the top bar (GET /api/colonies/:id/root), which pins a clone of its history. */

const ROOT = "0123456789abcdef0123456789abcdef01234567";

describe("the root line", () => {
  it("shows the full root commit, with how to pin a clone to it on hover", () => {
    const root = rootOf({ colonyId: "web", rootSha: ROOT, shallow: false, at: 1 });
    expect(root).toEqual({ sha: ROOT, shallow: false });
    const html = renderToStaticMarkup(createElement(RootCommitTag, { root }));
    expect(html).toContain(`root ${ROOT}`);
    expect(html).toContain(`data-root="${ROOT}"`);
    expect(html).toContain('class="signed-by root-commit mono"');
    expect(rootTitle(root!)).toBe(
      `This colony's root commit, ${ROOT}: the first commit of its trunk, first parent from the tip. Pin a clone of the colony to it: node verify_note.mjs --all --colony ${ROOT} (or ft verify --all --colony ${ROOT}) fails on any other history.`,
    );
  });

  it("says when the root is the oldest commit an import kept", () => {
    expect(rootTitle({ sha: ROOT, shallow: true })).toContain("the import kept the newest commits of its source, and this is the first of them");
  });

  it("shows nothing for a server that could not read the root, or an odd answer", () => {
    for (const odd of [null, undefined, "x", [], {}, { rootSha: null, detail: "the binding is down" }, { rootSha: ROOT.toUpperCase() }, { rootSha: `${ROOT}<b>` }]) expect(rootOf(odd)).toBeNull();
    expect(renderToStaticMarkup(createElement(RootCommitTag, { root: null }))).toBe("");
  });
});
