import type { Context, Hono } from "hono";
import type { Id, LandingDiff, LandingTests, LineageNote, NotesVerification, Path, Sha } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { dispose, withArtifactsRetry } from "../artifacts/git.ts";
import { colonyStorage } from "../artifacts/storage.ts";
import { ftError } from "../colony/errors.ts";
import { fileDiff } from "../decide/diff.ts";
import { LANDING_REF } from "../trunk/landing-note.ts";
import type { ApiEnv } from "./app.ts";
import { publicColonies } from "./git-proxy.ts";

/**
 * Public reads of one landing (registered by createApi):
 *   GET /colonies/:id/notes/verify?landing=<ref>   that landing's lineage note against its commit's FT-Note trailer, as
 *                                                  the newest are checked (the badge on every note in the web app); any
 *                                                  colony, like the other lineage reads
 *   GET /colonies/:id/landings/:ref/diff?path=     the change the landing made to one file: the file's blob in the
 *                                                  landing's lineage note write set against its blob in the parent commit,
 *                                                  both read through the Artifacts binding, as unified hunks (decide/diff.ts)
 *                                                  in an answer of at most 64 KB
 *   GET /colonies/:id/landings/:ref/tests          the landing's test row (certify/landingtests.ts): its tests at its base
 *                                                  against the first green certification that includes it, the tests it
 *                                                  lost, whose tests they are, whether an earlier test reaches its files,
 *                                                  what landed it and its intents' model spend; any colony, like the
 *                                                  certification reads (it shows test names and paths, never contents)
 * `ref` is a landing id or the trunk commit the landing made (40 hex, or a unique prefix of 7+). The diff shows file
 * contents, so it is served only for colonies that are public already (listed in FT_PUBLIC_GIT or FT_PUBLIC_MCP, whose
 * trunks anyone can clone or read); every other colony answers 404. A system commit (a revert, an antibody) writes files
 * its note lists in no write set; for those the file's blob comes from the landing's own commit.
 */

/** Largest answer of the diff route, in bytes of JSON: the hunks are cut on a line boundary to fit. */
export const DIFF_ANSWER_BYTES = 64 * 1024;
/** Largest version of a file the diff route reads as text, in bytes; a larger one is not diffed. */
export const DIFF_FILE_BYTES = 512 * 1024;
/** Diffs read and computed at once in one isolate; more answer 503 (each reads up to two blobs and diffs them). */
export const DIFF_IN_FLIGHT = 16;
/** What ends hunks that were cut (decide/diff.ts marks a cut the same way). */
const CUT = "… (truncated)";

/** Diffs in flight in this isolate. */
let inFlight = 0;

/** Register the diff and test-row routes (createApi). */
export function landingRoutes(app: Hono<ApiEnv>): void {
  app.get("/colonies/:id/landings/:ref/diff", async (c) => {
    const id = colonyId(c);
    if (!isPublic(c.env, id)) {
      throw ftError(404, `colony ${id} does not show file contents here: only colonies listed in FT_PUBLIC_GIT or FT_PUBLIC_MCP do; list it there on the deployment to show its changes`);
    }
    const ref = landingRef(c.req.param("ref"));
    const path = (c.req.query("path") ?? "").trim();
    if (path === "" || path.length > 1024) throw ftError(400, "name the file with ?path= (a path in the colony's trunk, at most 1,024 characters)");
    if (inFlight >= DIFF_IN_FLIGHT) return json({ error: "busy: too many changes are being read here; retry in a second" }, 503, { "Retry-After": "1" });
    inFlight++;
    try {
      return json(await landingDiff(c.env, id, ref, path));
    } finally {
      inFlight--;
    }
  });

  app.get("/colonies/:id/landings/:ref/tests", async (c) => json(await landingTests(c.env, colonyId(c), landingRef(c.req.param("ref")))));
}

/** GET /colonies/:id/landings/:ref/tests: one landing's test row (ColonyDO.landingTests); 404 when the colony or the landing is unknown. */
export async function landingTests(env: Env, colonyId: Id, ref: string): Promise<LandingTests> {
  const stub = colony(env, colonyId);
  if (!(await stub.getColony())) throw ftError(404, "colony not found");
  const answer = await stub.landingTests(ref);
  if (!answer) throw ftError(404, `no landing ${ref} in colony ${colonyId}: name a landing by its id or by the trunk commit it made`);
  return answer;
}

/** GET /colonies/:id/notes/verify?landing=<ref> (app.ts): one landing's note check; 404 when the colony or the landing is unknown. */
export async function verifyLanding(env: Env, colonyId: Id, raw: string): Promise<NotesVerification> {
  const ref = landingRef(raw);
  if (!(await colony(env, colonyId).getColony())) throw ftError(404, "colony not found");
  const answer = await trunk(env, colonyId).verifyLanding(ref);
  if (!answer) throw ftError(404, `no landing ${ref} in colony ${colonyId}: name a landing by its id or by the trunk commit it made`);
  return answer;
}

/**
 * The change landing `ref` made to `path` (see the module comment). Throws a 404 for an unknown colony or landing, a
 * landing without a lineage note, and a file the landing did not change.
 */
export async function landingDiff(env: Env, colonyId: Id, ref: string, path: Path): Promise<LandingDiff> {
  const record = await colony(env, colonyId).getColony();
  if (!record) throw ftError(404, "colony not found");
  const writer = trunk(env, colonyId);
  const found = await writer.landingNote(ref);
  if (!found) throw ftError(404, `no landing ${ref} in colony ${colonyId}: name a landing by its id or by the trunk commit it made`);
  const { landing, note } = found;
  if (!note) throw ftError(404, `landing ${landing.id} has no lineage note, so there is no write set to read its change from`);
  let after = noteBlob(note as LineageNote, path);
  if (after === undefined) {
    // A system commit (a revert, an antibody) lists no write set for the files it writes: its own commit holds them.
    if (!(landing.paths ?? []).includes(path)) throw ftError(404, `landing ${landing.id} did not change ${path}: ask for a file it wrote`);
    after = (await writer.baseBlobs(landing.trunkSha, [path]))[0]?.blob ?? null;
  }
  const before = (await writer.baseBlobs(landing.parentSha, [path]))[0]?.blob ?? null;
  const base = { colonyId, landingId: landing.id, trunkSha: landing.trunkSha, parentSha: landing.parentSha, path, before, after };
  const none = { added: 0, removed: 0, hunks: "", truncated: false };
  if (before === after) return { ...base, ...none, status: "unchanged", detail: "This landing left the file as its parent commit had it." };
  const storage = colonyStorage(env, record.trunk.owner);
  const binding = storage.bindingFor(record.trunk.namespace) ?? storage.trunk;
  const versions = await readVersions(binding, record.trunk.name, [before, after]);
  const [was, now] = versions;
  if (versions.some((v) => v?.kind === "too-large")) {
    return { ...base, ...none, status: "too-large", detail: "A version of the file is over 512 KB, too large to show here: read it from a plain git clone of the colony." };
  }
  if (versions.some((v) => v?.kind === "unreadable")) {
    return { ...base, ...none, status: "unreadable", detail: "The trunk repository did not return the file's contents just now: try again in a moment." };
  }
  if (versions.some((v) => v?.kind === "binary")) return { ...base, ...none, status: "binary", detail: "The file is binary, so there are no lines to show." };
  const d = fileDiff(path, textIn(was), textIn(now), { maxChars: Number.MAX_SAFE_INTEGER });
  const status = d.status === "added" || d.status === "deleted" ? d.status : "modified";
  return fitHunks({ ...base, status, added: d.added, removed: d.removed, hunks: d.hunks, truncated: false }, DIFF_ANSWER_BYTES);
}

/** The blob a lineage note's write sets give `path` (null: the change deleted it), or undefined when no write set names it. */
export function noteBlob(note: LineageNote, path: Path): Sha | null | undefined {
  for (const p of Array.isArray(note?.proposals) ? note.proposals : []) {
    for (const w of Array.isArray(p?.writeSet) ? p.writeSet : []) {
      if (w && w.path === path) return typeof w.blob === "string" ? w.blob : null;
    }
  }
  return undefined;
}

/**
 * `answer` with its hunks cut on a line boundary, and marked as cut, so that its JSON is at most `max` bytes. An answer
 * that fits is returned as it is.
 */
export function fitHunks(answer: LandingDiff, max: number): LandingDiff {
  if (utf8Bytes(JSON.stringify(answer)) <= max) return answer;
  // Each kept line adds its JSON-escaped text and an escaped newline to the answer that holds only the cut marker.
  let room = max - utf8Bytes(JSON.stringify({ ...answer, hunks: CUT, truncated: true }));
  const kept: string[] = [];
  for (const line of answer.hunks.split("\n")) {
    const cost = utf8Bytes(JSON.stringify(line));
    if (cost > room) break;
    kept.push(line);
    room -= cost;
  }
  return { ...answer, hunks: kept.length > 0 ? `${kept.join("\n")}\n${CUT}` : CUT, truncated: true };
}

/** What one version of the file holds for the diff. */
type Version = { kind: "absent" } | { kind: "text"; text: string } | { kind: "binary" } | { kind: "too-large" } | { kind: "unreadable" };

/** Each blob's version through the binding (null: the file is absent there), in order. */
async function readVersions(binding: Artifacts, name: string, blobs: Array<Sha | null>): Promise<Version[]> {
  const absent: Version = { kind: "absent" };
  if (blobs.every((b) => b === null)) return blobs.map(() => absent);
  let repo: ArtifactsRepo;
  try {
    repo = await withArtifactsRetry(() => binding.get(name));
  } catch {
    return blobs.map((b): Version => (b === null ? absent : { kind: "unreadable" }));
  }
  try {
    return await Promise.all(blobs.map((b) => (b === null ? absent : readVersion(repo, b))));
  } finally {
    dispose(repo);
  }
}

/** One blob as text, or why it is not text: binary (a NUL in its first 8 KiB, or not UTF-8), too large, or unreadable. */
async function readVersion(repo: ArtifactsRepo, blob: Sha): Promise<Version> {
  try {
    const b = await withArtifactsRetry(() => repo.readBlob(blob));
    if (!b) return { kind: "unreadable" };
    if (b.size > DIFF_FILE_BYTES) return { kind: "too-large" };
    const bytes = new Uint8Array(await b.arrayBuffer());
    if (bytes.subarray(0, 8192).includes(0)) return { kind: "binary" };
    try {
      return { kind: "text", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
    } catch {
      return { kind: "binary" };
    }
  } catch {
    return { kind: "unreadable" };
  }
}

function textIn(v: Version | undefined): string | null {
  return v?.kind === "text" ? v.text : null;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Colonies whose trunk is public already: plain git (FT_PUBLIC_GIT) or the public MCP (FT_PUBLIC_MCP) serves them. */
function isPublic(env: Env, id: Id): boolean {
  return publicColonies(env.FT_PUBLIC_GIT).has(id) || publicColonies(env.FT_PUBLIC_MCP).has(id);
}

function landingRef(raw: string | undefined): string {
  const ref = (raw ?? "").trim();
  if (!LANDING_REF.test(ref)) throw ftError(400, "name the landing by its id (lnd_...) or by the trunk commit it made (7 to 40 hex characters)");
  return ref;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function colonyId(c: Context<ApiEnv>): Id {
  const id = c.req.param("id") ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(id)) throw ftError(404, "colony not found");
  return id;
}

function colony(env: Env, id: Id) {
  return env.COLONY.get(env.COLONY.idFromName(id));
}

function trunk(env: Env, id: Id) {
  return env.TRUNK.get(env.TRUNK.idFromName(id));
}
