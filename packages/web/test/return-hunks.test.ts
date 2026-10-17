import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ContestedRegion, MovedBy } from "@fire_trident/core";
import { MovedByList } from "../src/components/MovedBy.tsx";
import { cleanContested, cleanMoved } from "../src/moved.ts";

/**
 * Return hunks (FT_RETURN_HUNKS) on the review card: under what beat the intent's last change, each landing's quoted
 * diff of the files it moved, and the contested regions of its text merge, shown as text (repository content).
 */

const DIFF = "@@ -1,2 +1,2 @@\n-export const a = 1;\n+export const a = <b>2</b>;";
const MOVED: MovedBy[] = [{ landingId: "lnd_a", paths: ["src/values.ts"], title: "Cache lookups", hunks: [{ path: "src/values.ts", diff: DIFF, truncated: true }] }];
const CONTESTED: ContestedRegion[] = [{ path: "src/values.ts", line: 4, base: ["const z = 1;"], trunk: ["const z = 2;"], own: ["const zed = 1;"] }];

describe("return hunks on the review card", () => {
  it("keeps the quotes it can use, and drops the rest", () => {
    expect(cleanMoved(MOVED)).toEqual(MOVED);
    expect(cleanMoved([{ ...MOVED[0], hunks: [{ path: "", diff: "x" }, { path: "a", diff: 7 }] }])).toEqual([{ landingId: "lnd_a", paths: ["src/values.ts"], title: "Cache lookups" }]);
    expect(cleanContested(CONTESTED)).toEqual(CONTESTED);
    expect(cleanContested([{ path: "a", line: 0, base: [], trunk: [], own: [] }])).toBeUndefined();
  });

  it("shows each landing's diff under its line and the contested regions after, as text", () => {
    const html = renderToStaticMarkup(createElement(MovedByList, { moved: MOVED, contested: CONTESTED }));
    expect(html).toContain('<pre class="moved-hunk"');
    expect(html).toContain("src/values.ts (cut short)\n@@ -1,2 +1,2 @@\n-export const a = 1;\n+export const a = &lt;b&gt;2&lt;/b&gt;;");
    expect(html).toContain("src/values.ts, from line 4 of its base\nbase:\nconst z = 1;\ntrunk:\nconst z = 2;\nthe change:\nconst zed = 1;");
    // Only contested regions (no landing the colony knew of): the list still shows.
    expect(renderToStaticMarkup(createElement(MovedByList, { moved: [], contested: CONTESTED }))).toContain("from line 4 of its base");
    // Without quotes, as before.
    expect(renderToStaticMarkup(createElement(MovedByList, { moved: [{ landingId: "lnd_a", paths: ["src/values.ts"] }] }))).not.toContain("moved-hunk");
  });
});
