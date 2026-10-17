import type { Certification, LandingTests, Path, WhyHolds, WhySince, WhyWalk } from "./types.ts";

/**
 * The words of a why answer about today (`ft why`, the Why tab, the MCP `why` tools): whether each landing still holds
 * on today's trunk, with the current certification of the tests that cover it, and how the walk for one line found the
 * landing behind it (worker trunk/whywalk.ts). Pure: the trunk writer compares the blobs and walks the line, the colony
 * keeps the certifications and the test rows; this module only says it.
 */

/** The current certification as a why answer reads it (a colony snapshot's `certification`, the store's latest). */
export type CertNow = Pick<Certification, "trunkSha" | "status"> & Partial<Pick<Certification, "counts" | "failing">>;

/** Files named in one clause at most. */
const NAMED = 2;
/** Landings a walk line names at most. */
const NAMED_LANDINGS = 5;

const short = (sha: string): string => (typeof sha === "string" ? sha.slice(0, 7) : "");
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "changed since by lnd_x and 2 more", "deleted since by lnd_x", or the same without a landing when none did it. */
function sinceWords(s: WhySince): string {
  const what = s.state === "deleted" ? "deleted since" : "changed since";
  if (!s.by) return `${what}, not by a later landing`;
  const more = typeof s.landings === "number" && s.landings > 1 ? ` and ${s.landings - 1} more` : "";
  return `${what} by ${s.by}${more}`;
}

/**
 * The trunk half of a holds line: "src/a.ts as it wrote it", "src/a.ts changed since by lnd_x", then the other files its
 * changes wrote or read: "the 3 other files it wrote or read unchanged", or "1 of 3 other files it wrote or read changed
 * since: src/b.ts by lnd_y". Null when there is nothing to say.
 */
export function holdsTrunk(h: WhyHolds | undefined): string | null {
  if (!h || !h.wrote || typeof h.wrote.path !== "string") return null;
  const parts = [h.wrote.state === "same" ? `${h.wrote.path} as it wrote it` : `${h.wrote.path} ${sinceWords(h.wrote)}`];
  const o = h.others;
  if (o && typeof o.files === "number" && o.files > 0) {
    if (!o.changed) parts.push(o.files === 1 ? "the other file it wrote or read unchanged" : `the ${o.files} other files it wrote or read unchanged`);
    else {
      const list = (Array.isArray(o.list) ? o.list : []).slice(0, NAMED).map((s) => `${s.path} ${s.state === "deleted" ? "deleted" : "changed"}${s.by ? ` by ${s.by}` : ""}`);
      const rest = o.changed - list.length;
      parts.push(`${o.changed} of ${plural(o.files, "other file")} it wrote or read changed since: ${list.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`);
    }
  }
  return parts.join(" · ");
}

/**
 * The current certification of the tests that cover a landing: with its test row's closure data (`reach`, the test files
 * whose imports reach a file it wrote), "covered by 3 test files, green at abc1234" or "covered by 3 test files, 1 failing
 * at abc1234: test/a.test.ts"; without it, the latest certification for the files: "trunk tests green at abc1234 (434/434)",
 * or red, naming a failing test file it wrote. Null when no certification is known and the row says nothing.
 */
export function coverText(row: Pick<LandingTests, "status" | "reason" | "reach"> | null | undefined, now: CertNow | null | undefined, wrote: readonly Path[] = []): string | null {
  if (!now || typeof now.trunkSha !== "string") {
    if (row?.status === "no-tests") return `no tests${row.reason ? `: ${row.reason}` : ""}`;
    return null;
  }
  const at = short(now.trunkSha);
  if (now.status === "running") return `tests running at ${at}`;
  if (now.status !== "green" && now.status !== "red") return `trunk tests ${now.status} at ${at}`;
  const failing = [...new Set((Array.isArray(now.failing) ? now.failing : []).map((f) => f?.file).filter((f): f is Path => typeof f === "string"))];
  const reach = row?.reach;
  if (reach && reach.none === "no-code") return `no test covers it (it wrote no code); trunk ${now.status} at ${at}`;
  if (reach) {
    const total = (reach.earlier ?? 0) + (reach.own ?? 0);
    if (total === 0) return `no test reaches its files; trunk ${now.status} at ${at}`;
    const named = [...new Set([...(reach.earlierFiles ?? []), ...(reach.ownFiles ?? [])])];
    const head = `covered by ${plural(total, "test file")}`;
    if (now.status === "green") return `${head}, green at ${at}`;
    const red = named.filter((f) => failing.includes(f));
    if (red.length > 0) return `${head}, ${red.length} failing at ${at}: ${red.slice(0, NAMED).join(", ")}${red.length > NAMED ? ` and ${red.length - NAMED} more` : ""}`;
    return total > named.length ? `${head}; trunk red at ${at}, none of the ${named.length} named failing` : `${head}, none failing at ${at} (trunk red on other tests)`;
  }
  const c = now.counts;
  if (now.status === "green") return `trunk tests green at ${at}${c ? ` (${c.pass}/${c.tests})` : ""}`;
  const mine = failing.filter((f) => wrote.includes(f));
  if (mine.length > 0) return `trunk tests red at ${at}, failing in a file it wrote: ${mine.slice(0, NAMED).join(", ")}`;
  return `trunk tests red at ${at}${failing.length > 0 ? ` (${plural(failing.length, "test file")} failing)` : ""}`;
}

/** One landing's holds line: the trunk half, then the cover clause (coverText); null when neither says anything. */
export function holdsText(h: WhyHolds | undefined, cover: string | null): string | null {
  const parts = [holdsTrunk(h), cover].filter((p): p is string => typeof p === "string" && p !== "");
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "lnd_a, lnd_b and 3 more". */
function landingList(ids: readonly string[]): string {
  const named = ids.slice(0, NAMED_LANDINGS).join(", ");
  return ids.length > NAMED_LANDINGS ? `${named} and ${ids.length - NAMED_LANDINGS} more` : named;
}

/**
 * The lines a why answer for one line shows under its heading: who wrote the line's meaning (or that it came with the
 * files), the moves the walk followed ("moved from src/b.ts:40 by lnd_x"), the formatting-only landings it skipped
 * ("skipped 2 formatting-only landings: lnd_a, lnd_b"), and why it stopped early.
 */
export function walkLines(walk: WhyWalk | undefined, asked: { path: Path; line: number }): string[] {
  if (!walk || typeof walk.path !== "string") return [];
  const out: string[] = [];
  const elsewhere = walk.path !== asked.path;
  if (walk.landingId) {
    const where = elsewhere ? ` at ${walk.path}:${walk.line}` : walk.line !== asked.line ? ` (as line ${walk.line} then)` : "";
    out.push(walk.bounded ? `line ${asked.line}: the oldest landing found that changed it is ${walk.landingId}${where}` : `line ${asked.line} written by ${walk.landingId}${where}`);
  } else if (!walk.bounded) {
    out.push(`line ${asked.line} came with the files, before any landing${elsewhere ? ` (in ${walk.path})` : ""}`);
  }
  for (const m of Array.isArray(walk.moved) ? walk.moved : []) out.push(`moved from ${m.from}:${m.line} by ${m.landingId}`);
  const skipped = (Array.isArray(walk.skipped) ? walk.skipped : []).map((s) => s.landingId);
  if (skipped.length > 0) out.push(`skipped ${plural(skipped.length, "formatting-only landing")}: ${landingList(skipped)}`);
  if (walk.bounded) out.push(`the walk stopped early: ${walk.bounded}`);
  return out;
}

/**
 * Whether the first entry of a why answer for a line is the landing that wrote it: true or false from the walk the trunk
 * writer sent, null when it sent none (a writer before the walk), so the reader keeps its own guess.
 */
export function walkOwnsFirst(first: { landing?: { id?: string }; walk?: WhyWalk } | undefined): boolean | null {
  if (!first?.walk) return null;
  return !!first.walk.landingId && first.walk.landingId === first.landing?.id;
}

/** The path a why entry's changes wrote the line in: the walk's, for the landing that wrote it in another file; else the path asked about. */
export function entryPath(e: { landing?: { id?: string }; walk?: WhyWalk }, asked: Path): Path {
  return e.walk?.landingId && e.walk.landingId === e.landing?.id ? e.walk.path : asked;
}
