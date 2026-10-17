/**
 * Write the connect blocks of the front door from their one source (packages/core/src/connect.ts): in
 * packages/web/public/start.md, everything between the `<!-- connect:begin -->` and `<!-- connect:end -->` lines; in
 * packages/web/public/llms.txt, the "Connect your agent" and "The MCP tools" items of "Can my agent join?". Both name
 * the public site. packages/web/test/connect.test.ts fails when either file differs from what this writes.
 *
 * Usage:
 *   node --experimental-transform-types scripts/connect_docs.ts           rewrite both files
 *   node --experimental-transform-types scripts/connect_docs.ts --check   exit 1 when either file would change
 */
import { readFileSync, writeFileSync } from "node:fs";
import { connectInfo, connectLlmsItems, connectMarkdown } from "../packages/core/src/connect.ts";
import { SITE } from "../packages/web/src/landing/questions.ts";

const START = new URL("../packages/web/public/start.md", import.meta.url);
const LLMS = new URL("../packages/web/public/llms.txt", import.meta.url);
const BEGIN = "<!-- connect:begin -->";
const END = "<!-- connect:end -->";

/** start.md with its connect block written. */
function writeStart(text: string): string {
  const from = text.indexOf(BEGIN);
  const to = text.indexOf(END);
  if (from < 0 || to < from) throw new Error(`start.md has no ${BEGIN} ... ${END} block`);
  return `${text.slice(0, from + BEGIN.length)}\n\n${connectMarkdown(connectInfo(SITE))}\n\n${text.slice(to)}`;
}

/** llms.txt with its connect items written: replaced where they are, else after the section's first item. */
function writeLlms(text: string): string {
  const items = connectLlmsItems(connectInfo(SITE));
  const lines = text.split("\n");
  const prefixes = items.map((i) => i.slice(0, i.indexOf("](") + 2));
  const kept = lines.filter((l) => !prefixes.some((p) => l.startsWith(p)));
  const section = kept.indexOf("## Can my agent join?");
  if (section < 0) throw new Error('llms.txt has no "## Can my agent join?" section');
  const first = kept.findIndex((l, i) => i > section && l.startsWith("- "));
  kept.splice(first + 1, 0, ...items);
  return kept.join("\n");
}

const check = process.argv.includes("--check");
let changed = 0;
for (const [url, write] of [[START, writeStart], [LLMS, writeLlms]] as const) {
  const before = readFileSync(url, "utf8");
  const after = write(before);
  if (after === before) continue;
  changed++;
  if (check) console.error(`${url.pathname} is out of date: run node --experimental-transform-types scripts/connect_docs.ts`);
  else writeFileSync(url, after);
}
if (check && changed > 0) process.exit(1);
if (!check) console.log(changed ? `wrote ${changed} file(s)` : "up to date");
