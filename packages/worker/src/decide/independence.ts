import { modelFamily, secondOpinionCandidates } from "./policy.ts";

/**
 * Second-opinion independence: the model that confirms a change comes from another family than the model that wrote it
 * (policy.ts modelFamily), or no model confirms it at all.
 *
 * - Every configured second-opinion model in the author's family: none is asked, and the change goes to a person (gate
 *   rule NO_INDEPENDENT_RULE, decide/gate.ts) with the reason. Asking the author's own family would be a confirmation
 *   that is not one.
 * - The author's model unknown (an MCP agent need not report its model): the models are asked as before, and the
 *   decision's detail says independence was not checked.
 *
 * The default policy's three families never all match one author, so a default configuration is never refused.
 *
 * The contest judge (decide/contest.ts) follows the same rule for its contestants (judgePick): only models outside every
 * contestant's family judge; with none configured no model judges and the contest's deterministic order decides (its
 * changes were each reviewed already). A contestant with no reported model has no family to leave out, as before; its
 * verdicts say nothing of it, since they become the reasons the other contestants read.
 */

/** The gate rule of a change no independent model could review. */
export const NO_INDEPENDENT_RULE = "L9 no independent reviewer";

/** Which second-opinion models a change may be shown to, and what its decision record says about independence. */
export interface ReviewerPick {
  /** The models to ask, in order; empty when none is independent of the author. */
  models: string[];
  /** Every configured model is in the author's family: the reason the change goes to a person instead. */
  refusal?: string;
  /** The author's model was not reported, so independence was not checked: the sentence the decision's detail carries. */
  unchecked?: string;
}

/** What the decision's detail says when the author reported no model. */
export const AUTHOR_MODEL_UNREPORTED = "the author's model was not reported, so the second opinion's independence from it was not checked";

/** The second-opinion models for a change written by `authorModel`, from the policy's `candidates` (see the module comment). */
export function reviewerPick(authorModel: string | null | undefined, candidates: readonly string[]): ReviewerPick {
  const family = modelFamily(authorModel);
  const models = secondOpinionCandidates(authorModel ?? undefined, candidates);
  if (family === "") return { models, unchecked: AUTHOR_MODEL_UNREPORTED };
  if (models.length > 0 || candidates.length === 0) return { models };
  const listed = [...new Set(candidates)].slice(0, 5).join(", ");
  return {
    models: [],
    refusal: `no reviewer model outside the author's model family (${family}) is configured: every second-opinion model (${listed}) is ${family}'s, so no model can confirm this change and a person decides; add a second-opinion model from another family to the colony's decide policy`,
  };
}

/**
 * The judge models for a contest between changes written by `authors`, from the policy's `candidates`: every candidate
 * from a family none of the authors' models belongs to (an author with no reported model has no family to leave out).
 * None when every candidate is in an author's family: `refusal` then says why no model judges.
 */
export function judgePick(authors: ReadonlyArray<string | null | undefined>, candidates: readonly string[]): ReviewerPick {
  const families = [...new Set(authors.map((a) => modelFamily(a)).filter((f) => f !== ""))];
  const models = [...new Set(candidates.filter((c) => !families.includes(modelFamily(c))))];
  if (models.length > 0 || candidates.length === 0) return { models };
  return {
    models: [],
    refusal: `no judge model outside the contestants' model families (${families.join(", ")}) is configured, so no model judged and the contest's deterministic order decided`,
  };
}

/** What a decision record keeps about independence: the refusal or the unchecked sentence, or nothing when it was checked and held. */
export function independenceNote(pick: ReviewerPick): { independence?: string } {
  const note = pick.refusal ?? pick.unchecked;
  return note ? { independence: note } : {};
}
