import { describe, expect, it } from "vitest";
import type { Path } from "@fire_trident/core";
import { withPublisher } from "./publisher.ts";

/**
 * What the real trunk writer lists for trunk certification (TrunkDO.certifySnapshot): the files a test run may load,
 * .tsx, .jsx, .mts and .cts included so an import of one is found and reported as what the runner cannot compile rather
 * than as a missing file; other files, dependency directories and dot directories are left out.
 */

const FILES: Record<Path, string> = {
  "src/a.ts": "export const a = 1;\n",
  "src/b.js": "export const b = 1;\n",
  "src/c.mjs": "export const c = 1;\n",
  "src/d.json": "{}\n",
  "src/view.tsx": "export const View = () => null;\n",
  "src/old.jsx": "export const Old = () => null;\n",
  "src/esm.mts": "export const esm = 1;\n",
  "src/cjs.cts": "export const cjs = 1;\n",
  "src/style.css": "a {}\n",
  "README.md": "# x\n",
  "node_modules/pkg/index.ts": "export const p = 1;\n",
  ".github/x.ts": "export const g = 1;\n",
};

describe("trunk certification's listing of trunk", () => {
  it("lists the files a test run may load, JSX and module TypeScript included", async () => {
    await withPublisher(FILES, {}, async (w) => {
      const snap = await w.trunk.certifySnapshot();
      expect(snap.files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.js", "src/c.mjs", "src/cjs.cts", "src/d.json", "src/esm.mts", "src/old.jsx", "src/view.tsx"]);
      expect(snap.truncated).toBe(false);
    });
  });
});
