#!/usr/bin/env node
/**
 * Print the recipe scenes' data as one JSON document (scripts/scene_project.ts sceneData): the project, the recipe, the
 * seed's chunks, every file the recipe rewrites with its output, the agents' edits and the smuggled file. The Ruby scene
 * scripts read it; it is the same on every run.
 *
 *   node scripts/scene_data.ts            the JSON on stdout
 *   node scripts/scene_data.ts --summary  what it holds, in a few lines
 *
 * Needs a Node that runs TypeScript files (type stripping, Node 22.18 or later).
 */
import { sceneData } from "./scene_project.ts";

const data = sceneData();
if (process.argv.includes("--summary")) {
  const lines = (t: string) => t.split("\n").filter((l) => new RegExp(`\\b${data.from}\\b`).test(l)).length;
  console.log(`${Object.keys(data.files).length} files; ${data.users.length} name ${data.from} on ${Object.values(data.files).reduce((n, t) => n + lines(t), 0)} lines`);
  console.log(`seed: ${data.seed.length} inline changes of ${data.seed.map((c) => c.length).join(", ")} files`);
  console.log(`the recipe rewrites ${Object.keys(data.renamed).length} files`);
  console.log(`${data.edits.length} agents hold edits on ${data.edits.reduce((n, e) => n + e.files.length, 0)} files`);
  console.log(`the smuggled line goes in ${data.smuggle.path}`);
} else {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}
