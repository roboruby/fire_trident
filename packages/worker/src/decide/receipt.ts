import type { ApproverIdentity, NoteDecision, NoteShown, Sha, ShownView } from "@fire_trident/core";
import { sha256Hex } from "../trunk/digest.ts";
import type { FileDiff } from "./diff.ts";
import { coverageText, secondOpinionDiff, type Coverage } from "./reflex.ts";

/**
 * The review receipt: every decision on a change records the proposal head it was made on and a digest of the exact view
 * of the change the decider was shown, and a person's decision whether its name was verified. The decision row keeps
 * them in its answers (`head`, `shown`, and for a person `identity`), and the lineage note copies them into each of its
 * decisions (colony/direction.ts noteDecision), inside the digested and signed note.
 *
 * What is digested, as "sha256:<64 hex>" of the UTF-8 bytes:
 * - the reflex: the JSON of the `diff` object of the state the reflex model read (decide/reflex.ts reflexState);
 * - the second opinion: the diff text fenced in its prompt (decide/reflex.ts secondOpinionDiff);
 * - a person: the review view their card served (ColonyDO.reviewViews), as JSON with its keys sorted at every depth.
 * A view that left changed lines out is `clipped`, with how much it showed in words; a card that served no view has no
 * digest and is clipped. Pure but for the digest.
 */

/** The longest coverage sentence a receipt keeps. */
const SEEN_CHARS = 300;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VIEWS: ReadonlySet<string> = new Set<ShownView>(["reflex-state", "prompt-diff", "review-card"]);

/** "sha256:<64 hex>" of a text's UTF-8 bytes. */
export async function shownDigest(text: string): Promise<string> {
  return `sha256:${await sha256Hex(text)}`;
}

/** JSON text with object keys sorted at every depth (no indentation), the form a card's view is digested in. */
export function sortedJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined || typeof v === "function" ? "null" : sortedJson(v))).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined && typeof o[k] !== "function")
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${sortedJson(o[k])}`).join(",")}}`;
}

/** A receipt from a view's digest and coverage: clipped (with the coverage in words) when it did not show every changed line. */
function receipt(view: ShownView, digest: string | undefined, coverage: Coverage): NoteShown {
  return { view, ...(digest ? { digest } : {}), ...(coverage.complete ? {} : { clipped: true as const, seen: coverageText(coverage).slice(0, SEEN_CHARS) }) };
}

/** The reflex's receipt: the digest of the diff in the state it read (`state.diff`), clipped as its coverage says. */
export async function reflexShown(state: Record<string, unknown> | null | undefined, coverage: Coverage): Promise<NoteShown> {
  return receipt("reflex-state", await shownDigest(JSON.stringify(state?.diff ?? null)), coverage);
}

/** The second opinion's receipt: the digest of the diff text its prompt fenced, clipped as that text's coverage says. */
export async function promptShown(diffs: readonly FileDiff[]): Promise<NoteShown> {
  const shown = secondOpinionDiff(diffs);
  return receipt("prompt-diff", await shownDigest(shown.text), shown.coverage);
}

/** A file of a card's view that carries no full text: cut for length, or binary or unreadable. */
function cutFile(f: Record<string, unknown>): boolean {
  return f.truncated === true || f.status === "binary" || f.status === "unreadable";
}

/**
 * A person's receipt from the review view their card served (null when it served none): its digest over the view as
 * sorted JSON, clipped when a file was cut or binary, or files were left out of the view.
 */
export async function cardShown(view: Record<string, unknown> | null | undefined): Promise<NoteShown> {
  if (!view || typeof view !== "object" || Array.isArray(view)) return { view: "review-card", clipped: true, seen: "the card served no view of the change" };
  const files = (Array.isArray(view.files) ? view.files : []).filter((f): f is Record<string, unknown> => !!f && typeof f === "object" && !Array.isArray(f));
  const changed = typeof view.filesChanged === "number" && Number.isFinite(view.filesChanged) ? Math.max(Math.floor(view.filesChanged), files.length) : files.length;
  const cut = files.filter(cutFile).map((f) => String(f.path ?? ""));
  const coverage: Coverage = { filesChanged: changed, filesShown: files.length, cut, complete: files.length === changed && cut.length === 0 };
  return receipt("review-card", await shownDigest(sortedJson(view)), coverage);
}

/** How a person's decision names them, as the route worked it out (api/access.ts approverIdentity). */
export interface ApproverWho {
  /** The name the decision records: the verified email, or the stated name. */
  by: string;
  identity: ApproverIdentity;
  /** The name the request stated, when it differs from `by`. */
  stated?: string;
  /** Why the name is not verified, when verification is configured and failed. */
  why?: string;
  /** What verified a verified name: Cloudflare Access (absent means Access), or the owner's GitHub sign-in (accounts/scope.ts). */
  verifiedBy?: "access" | "github";
}

/** The identity fields of a person's decision row: stated unless `who` says verified (no `who` is a stated name). */
export function identityAnswers(who: ApproverWho | null | undefined): Record<string, unknown> {
  if (!who || who.identity !== "verified") return { identity: "stated", ...(who?.why ? { unverified: who.why.slice(0, SEEN_CHARS) } : {}) };
  return { identity: "verified", verifiedBy: who.verifiedBy ?? "access", ...(who.stated && who.stated !== who.by ? { stated: who.stated.slice(0, 200) } : {}) };
}

/** A stored `shown` read back field by field; undefined when it does not read as one (old or damaged rows never throw). */
export function readShown(raw: unknown): NoteShown | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.view !== "string" || !VIEWS.has(o.view)) return undefined;
  const digest = typeof o.digest === "string" && DIGEST.test(o.digest) ? o.digest : undefined;
  const seen = typeof o.seen === "string" ? o.seen.replace(/\s+/g, " ").trim().slice(0, SEEN_CHARS) : "";
  return { view: o.view as ShownView, ...(digest ? { digest } : {}), ...(o.clipped === true ? { clipped: true as const } : {}), ...(seen ? { seen } : {}) };
}

/**
 * The receipt fields a lineage note's decision carries, from its row's answers: the head it was made on, what it was
 * shown and, for a person, verified or stated. Nothing for a row written before receipts.
 */
export function noteReceipt(answers: Record<string, unknown>, layer: string): Pick<NoteDecision, "head" | "shown" | "identity"> {
  const out: Pick<NoteDecision, "head" | "shown" | "identity"> = {};
  if (typeof answers.head === "string" && SHA.test(answers.head)) out.head = answers.head as Sha;
  const shown = readShown(answers.shown);
  if (shown) out.shown = shown;
  if (layer === "human" && (answers.identity === "verified" || answers.identity === "stated")) out.identity = answers.identity;
  return out;
}
