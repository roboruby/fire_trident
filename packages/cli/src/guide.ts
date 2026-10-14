import type { GuideEntry, GuideLesson } from "@fire_trident/core";
import { ago, num, type Colors } from "./format.ts";

/**
 * `ft guide`: a colony's field guide (FT_FIELD_GUIDE), the lessons agents left with their changes, each with who wrote
 * it and the landing it came from; with the operator token, the candidates waiting and the lessons that left lately too.
 * `ft guide <colony> approve|reject <lessonId>` is a person's decision on one lesson.
 */

/** What GET /api/colonies/:id/guide answers (the server's GuideView, or `on: false`). */
export interface GuideViewLike {
  colonyId?: string;
  on?: boolean;
  gate?: "certification" | "person";
  note?: string;
  active?: Array<Partial<GuideEntry>>;
  chars?: number;
  limits?: { activeLessons?: number; activeChars?: number };
  candidates?: Array<Partial<GuideLesson>>;
  ended?: Array<Partial<GuideLesson>>;
}

function line(s: string | undefined, max = 160): string {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Who wrote a lesson, in a few words: the agent, its kind and its model with how the model is known. */
function by(agentId: string | undefined, author: string | undefined, model: string | undefined, evidence: string | undefined): string {
  const kind = author === "platform" ? "in-platform" : author ?? "agent";
  return `${agentId ?? "?"} (${kind}${model ? `, ${model} ${evidence ?? "declared"}` : ""})`;
}

/** The colony's field guide: the active lessons, newest first; for the operator, the candidates and the lessons that left. */
export function formatGuide(colony: string, g: GuideViewLike, c: Colors, now: number): string {
  if (g.on === false) return `${c.yellow("!")} ${g.note ?? `The field guide is off for ${colony} (FT_FIELD_GUIDE).`}`;
  const active = g.active ?? [];
  const max = g.limits?.activeLessons;
  const head = `${c.bold(num(active.length))}${max ? `/${num(max)}` : ""} active lesson${active.length === 1 ? "" : "s"} in ${c.bold(colony)}'s field guide${g.chars !== undefined ? c.dim(` (${num(g.chars)} characters)`) : ""}`;
  const out = [head];
  if (g.note) out.push(c.dim(`  ${g.note}`));
  for (const e of active) {
    out.push("");
    out.push(`${c.bold(e.id ?? "?")} ${line(e.text)}`);
    const how = e.activatedBy === "certification" ? "a green certification" : "a person";
    out.push(c.dim(`  by ${by(e.agentId, e.author, e.model, e.modelEvidence)}, landing ${e.landingId ?? "none"}, active ${typeof e.activatedAt === "number" ? ago(e.activatedAt, now) : "?"} by ${how}`));
  }
  const waiting = g.candidates ?? [];
  if (g.candidates !== undefined) {
    out.push("", `${c.bold(num(waiting.length))} candidate${waiting.length === 1 ? "" : "s"} waiting`);
    for (const l of waiting) {
      const p = l.provenance;
      out.push(`  ${c.bold(l.id ?? "?")} ${line(l.text, 120)}`);
      out.push(c.dim(`    by ${by(l.agentId, p?.author, p?.model, p?.modelEvidence)}, proposal ${l.proposalId ?? "?"}, ${l.landingId ? `landed in ${l.landingId}` : "not landed yet"}, left ${typeof l.createdAt === "number" ? ago(l.createdAt, now) : "?"}`));
    }
  }
  const ended = g.ended ?? [];
  if (ended.length > 0) {
    out.push("", `${c.bold(num(ended.length))} dropped or retired lately`);
    for (const l of ended.slice(0, 10)) out.push(`  ${c.bold(l.id ?? "?")} ${c.dim(`${l.status ?? "?"}: ${line(l.endReason, 120)}`)}`);
  }
  if (g.candidates !== undefined) out.push("", c.dim(`  Decide one: ft guide ${colony} approve|reject <lessonId> [--reason <text>]`));
  return out.join("\n");
}

/** The outcome of `ft guide <colony> approve|reject <lessonId>`. */
export function formatLessonDecision(lessonId: string, action: string, l: Partial<GuideLesson>, c: Colors): string {
  if (action === "approve") return `${c.green("✓")} Approved ${c.bold(lessonId)}: it is ${l.status ?? "active"}, and every take carries it as data with its provenance.`;
  return `${c.green("✓")} Rejected ${c.bold(lessonId)}: ${l.status === "dropped" ? "it left the guide" : `it is ${l.status ?? "dropped"}`}${l.endReason ? c.dim(` (${line(l.endReason, 120)})`) : ""}.`;
}
