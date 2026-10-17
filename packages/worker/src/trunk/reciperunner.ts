import type { Path, Recipe, RecipeOutput, RecipeRefusal } from "@fire_trident/core";
import type { RecipeRunner } from "./recipes.ts";

/**
 * Module recipes (FT_RECIPE_MODULES): a person's own transform, run in a sealed Dynamic Worker as trunk certification
 * runs a colony's tests: no network (globalOutbound null), no bindings, no environment, a CPU limit, and its only effect
 * the texts it answers. The module exports `transform(path, text)`, which returns the new text, the same text or nothing
 * (no change), or `{ reason }` to leave the file as it was. The trunk writer runs every batch twice and compares
 * (trunk/recipes.ts recipeStep), so a module that reads the clock or randomness differently each run never lands. A
 * malformed answer, an error or a time-out fails the whole run (the recipe stops), never half of it.
 */

/** The runner's compatibility date (as certification's runner), its CPU limit per run, and the longest answer it reads. */
const COMPAT_DATE = "2026-08-01";
const CPU_MS = 5_000;
const ANSWER_BYTES = 16 * 1024 * 1024;
const REFUSALS: ReadonlySet<string> = new Set<RecipeRefusal>(["unparsable", "binary", "out-of-language", "name-taken", "unread"]);

/** The harness module the sandbox runs: it hands each file to the recipe's `transform` and answers the outputs as JSON. */
export const RECIPE_HARNESS = `import * as recipe from "./recipe.js";
export default {
  async fetch(request) {
    const { files } = await request.json();
    const out = [];
    for (const f of files) {
      if (f.text === null) { out.push({ ok: false, reason: "binary", detail: "not UTF-8 text" }); continue; }
      try {
        const t = await recipe.transform(f.path, f.text);
        if (typeof t === "string") out.push({ ok: true, text: t });
        else if (t === null || t === undefined) out.push({ ok: true, text: f.text });
        else out.push({ ok: false, reason: "unparsable", detail: String((t && t.reason) || "the module left the file as it was").slice(0, 200) });
      } catch (e) {
        out.push({ ok: false, reason: "unparsable", detail: String((e && e.message) || e).slice(0, 200) });
      }
    }
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
  },
};
`;

/** The Worker Loader surface the runner uses (env.LOADER). */
export interface RecipeLoader {
  load(code: {
    compatibilityDate: string;
    mainModule: string;
    modules: Record<string, string>;
    globalOutbound: null;
    limits?: { cpuMs?: number };
  }): { getEntrypoint(): { fetch(input: string, init?: RequestInit): Promise<Response> } };
}

/** The outputs a sandbox answered, checked: one per file, each a text or a known refusal. Null when malformed. */
export function sandboxOutputs(raw: unknown, files: number): RecipeOutput[] | null {
  if (!Array.isArray(raw) || raw.length !== files) return null;
  const out: RecipeOutput[] = [];
  for (const o of raw as unknown[]) {
    if (!o || typeof o !== "object") return null;
    const x = o as Record<string, unknown>;
    if (x.ok === true && typeof x.text === "string") out.push({ ok: true, text: x.text });
    else if (x.ok === false && typeof x.reason === "string" && REFUSALS.has(x.reason)) out.push({ ok: false, reason: x.reason as RecipeRefusal, detail: String(x.detail ?? "").slice(0, 200) });
    else return null;
  }
  return out;
}

/** A runner for module recipes over the deployment's Worker Loader. */
export function sealedRecipeRunner(loader: RecipeLoader): RecipeRunner {
  return {
    async run(recipe: Recipe, files: ReadonlyArray<{ path: Path; text: string | null }>): Promise<RecipeOutput[]> {
      const worker = loader.load({
        compatibilityDate: COMPAT_DATE,
        mainModule: "harness.js",
        modules: { "harness.js": RECIPE_HARNESS, "recipe.js": String(recipe.args.source ?? "") },
        globalOutbound: null,
        limits: { cpuMs: CPU_MS },
      });
      const res = await worker.getEntrypoint().fetch("https://recipe.invalid/run", { method: "POST", body: JSON.stringify({ files }) });
      if (!res.ok) throw new Error(`the recipe's sandbox answered ${res.status}`);
      const text = await res.text();
      if (text.length > ANSWER_BYTES) throw new Error("the recipe's sandbox answered more than its limit");
      const outputs = sandboxOutputs(JSON.parse(text) as unknown, files.length);
      if (!outputs) throw new Error("the recipe's sandbox answered something other than one output per file");
      return outputs;
    },
  };
}
