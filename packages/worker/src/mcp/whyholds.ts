import type { Certification, LandingTests, LineageNote, Path, WhyHolds } from "@fire_trident/core";
import { coverText, holdsText } from "@fire_trident/core";
import { WHY_TESTS_MS } from "./whytests.ts";

/**
 * Both MCP `why` tools (the authenticated one and the public one) end each landing of an answer with its holds line, as
 * `ft why` and the Why tab show it (core/whyholds.ts holdsText): the trunk writer's comparison of the landing with today's
 * trunk (trunk/whywalk.ts), then the current certification of the tests that cover it, from the entry's test row's
 * closure data where it carries one, else the colony's latest certification. That certification is read once, within
 * WHY_TESTS_MS; past it, or without one, the line says what the trunk writer found alone.
 */

/** Reads the colony's newest certifications (ColonyDO.certifications). */
export type ReadCertifications = (limit: number) => Promise<Certification[]>;

/** One entry of a why answer as the holds line reads it. */
type HoldsEntry = { holds?: WhyHolds; tests?: LandingTests | { unavailable: string }; note?: Pick<LineageNote, "proposals"> };

/** The colony's latest certification within `ms`, or null (none yet, too slow, or it failed). Never throws. */
export async function latestCertification(read: ReadCertifications | undefined, ms = WHY_TESTS_MS): Promise<Certification | null> {
  if (!read) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    const list = await Promise.race([read(1), late]);
    return Array.isArray(list) && list[0] && typeof list[0].trunkSha === "string" ? list[0] : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The entries with `holds.text` set on each one that carries holds (core/whyholds.ts); entries without holds stay as they are. */
export function withHoldsText<E extends HoldsEntry>(entries: readonly E[], latest: Certification | null): E[] {
  return entries.map((e) => {
    if (!e.holds) return e;
    const row = e.tests && "status" in e.tests ? e.tests : undefined;
    const wrote: Path[] = [];
    for (const p of Array.isArray(e.note?.proposals) ? e.note.proposals : []) for (const w of Array.isArray(p?.writeSet) ? p.writeSet : []) if (typeof w?.path === "string") wrote.push(w.path);
    const text = holdsText(e.holds, coverText(row, latest, wrote));
    return text ? { ...e, holds: { ...e.holds, text } } : e;
  });
}
