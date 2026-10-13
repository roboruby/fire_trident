import { load, type IndexedFile, type Loaded } from "../../src/certify/load.ts";
import { buildPlan, type Plan } from "../../src/certify/plan.ts";

export { nodeStripsTypes, nodeTestCounts, runPlanInNode } from "./node-runner.mjs";

/**
 * Helpers for the certification tests: a project given as file texts becomes a trunk index and a
 * blob store, the plan runs in a real Node process (the harness, the shim and the transpiled
 * modules exactly as the Dynamic Worker gets them; node-runner.mjs), and the same files run under
 * `node --test`.
 */

/** A trunk index and an in-memory blob store for `files` (blob id = "b:" + path); `reads` logs every read. */
export function trunkOf(files: Record<string, string>): { index: IndexedFile[]; read: (blobs: string[]) => Promise<Record<string, string | null>>; reads: string[][] } {
  const index = Object.entries(files).map(([path, text]) => ({ path, blob: `b:${path}`, size: text.length }));
  const reads: string[][] = [];
  const read = async (blobs: string[]) => {
    reads.push(blobs);
    return Object.fromEntries(blobs.map((b) => [b, files[b.slice(2)] ?? null]));
  };
  return { index, read, reads };
}

/** Load and plan `files` the way a certification run does. */
export async function planOf(files: Record<string, string>, config = { testTimeoutMs: 2_000, budgetMs: 20_000 }): Promise<{ loaded: Loaded; plan: Plan }> {
  const t = trunkOf(files);
  const loaded = await load(t.index, t.read);
  return { loaded, plan: buildPlan({ tests: loaded.tests, modules: loaded.modules, config }) };
}
