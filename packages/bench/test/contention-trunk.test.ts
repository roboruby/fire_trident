import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GitTrunk, NOTES_REF } from "../src/contention/trunk.ts";

const root = mkdtempSync(join(tmpdir(), "contention-trunk-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A small trunk made with stock git: three commits on main, lineage notes on the last two. */
function makeTrunk(): { dir: string; shas: string[] } {
  const dir = join(root, "origin");
  const g = (...args: string[]): string => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  const shas: string[] = [];
  for (const [i, text] of ["one\n", "two\n", "three\n"].entries()) {
    writeFileSync(join(dir, "hot.ts"), `export const V = ${JSON.stringify(text)};\n`);
    writeFileSync(join(dir, `m${i}.ts`), `export const M${i} = ${i};\n`);
    g("add", "-A");
    g("commit", "--quiet", "-m", `c${i}`);
    shas.push(g("rev-parse", "HEAD"));
    if (i > 0) g("notes", `--ref=${NOTES_REF}`, "add", "-m", JSON.stringify({ proposals: [{ id: `prp_${i}`, readSet: [], writeSet: [{ path: "hot.ts", blob: null }] }] }), "HEAD");
  }
  return { dir, shas };
}

describe("the stock git trunk reader", () => {
  it("fetches main and the notes from the remote a lease names, and reads files, trees and the noted history", async () => {
    const { dir, shas } = makeTrunk();
    const trunk = new GitTrunk(join(root, "mirror"));
    try {
      expect(await trunk.ensure(shas[2]!, 200)).toBe(false);
      trunk.setAuth({ remote: dir, token: "unused-for-a-local-remote" });
      expect(await trunk.ensure(shas[2]!, 30_000)).toBe(true);
      expect(await trunk.read(shas[0]!, "hot.ts")).toBe('export const V = "one\\n";\n');
      expect(await trunk.read(shas[2]!, "hot.ts")).toBe('export const V = "three\\n";\n');
      expect(await trunk.read(shas[0]!, "m2.ts")).toBeNull();
      expect([...(await trunk.tree(shas[1]!)).keys()].sort()).toEqual(["hot.ts", "m0.ts", "m1.ts"]);
      expect(await trunk.refresh()).toBe(shas[2]);
      const history = await trunk.history();
      expect(history.map((c) => c.sha)).toEqual([...shas].reverse());
      expect(history.map((c) => c.parent)).toEqual([shas[1], shas[0], null]);
      expect(JSON.parse(history[0]!.note!).proposals[0].id).toBe("prp_2");
      expect(history[2]!.note).toBeNull();
      expect(history[0]!.at).toBeGreaterThan(Date.now() - 600_000);
      expect(trunk.fetches.count).toBeGreaterThan(0);
    } finally {
      trunk.close();
    }
  });
});
