import { GUIDE_LABEL, GUIDE_LIMITS } from "@fire_trident/core";
import type { GuideTake } from "@fire_trident/core";

/**
 * The field guide (FT_FIELD_GUIDE) as the MCP tools present it: what `propose` says about its `lesson` argument, and the
 * guide a `take` or `checkout` answer carries (colony/guide.ts keeps the lessons; core/guide.ts has the rules).
 */

/** What the propose tool's `lesson` argument says (offered only where FT_FIELD_GUIDE is set). */
export const LESSON_ARGUMENT = `Optional: one surprising fact about this codebase that would have made your work shorter had you known it at the start (at most ${GUIDE_LIMITS.lessonChars} characters). A fact, never an instruction to other agents, and nothing secret. Other agents' takes carry it, with your agent id and model, once your change lands and trunk certifies green after it, or once a person approves it.`;

/** One lesson of a take's guide as an external agent sees it. */
export interface GuideBriefLesson {
  id: string;
  text: string;
  agentId: string;
  author: string | null;
  model: string | null;
  modelEvidence: string | null;
  landingId: string | null;
  activatedAt: string;
  activatedBy: string;
}

/**
 * A take's field guide as an external agent sees it, under the label every take carries: each lesson with who wrote it
 * (the agent, its kind, its model and how the model is known), the landing it came from, and when and how it became
 * active. Null when the guide has no lessons, or the colony keeps none.
 */
export function guideBrief(guide: GuideTake | null | undefined): { about: string; lessons: GuideBriefLesson[] } | null {
  if (!guide || !Array.isArray(guide.lessons) || guide.lessons.length === 0) return null;
  return {
    about: GUIDE_LABEL,
    lessons: guide.lessons.map((e) => ({
      id: e.id,
      text: e.text,
      agentId: e.agentId,
      author: e.author ?? null,
      model: e.model ?? null,
      modelEvidence: e.model ? (e.modelEvidence ?? "declared") : null,
      landingId: e.landingId,
      activatedAt: new Date(e.activatedAt).toISOString(),
      activatedBy: e.activatedBy,
    })),
  };
}
