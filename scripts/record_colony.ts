#!/usr/bin/env node
/**
 * Record a colony's finished run for playback with no network (/c/<colony>?replay=1&recording=<name>, the director and
 * the tour included). With public GET requests only, it reads everything those pages read: GET /api/about (the build),
 * the colony's snapshot, its agents, its whole event record (page by page), each file's lineage (/why?path=), each
 * landing's note check (/notes/verify?landing=), the change each landing made to each of its files
 * (/landings/:id/diff?path=), and the reads of the colony's tour; then it writes them into one file
 * (packages/web/src/playback/recording.ts has the layout). Every answer passes through the evidence redaction
 * (packages/bench/src/evidence.ts: tokens, the account id, emails, local paths) and loses any token field; no request
 * header is written, and neither is the deployment's address.
 *
 * Usage:
 *   node --experimental-transform-types scripts/record_colony.ts --base https://<deployment> --colony hono
 *     writes recordings/hono.json.gz; --out <file> writes elsewhere (a name ending .json is written uncompressed)
 *   node --experimental-transform-types scripts/record_colony.ts --base https://<deployment> --colony hono --bundle
 *     writes packages/web/public/recordings/hono.json.gz, which `vite build` ships at /recordings/hono.json.gz
 *
 * Behind Cloudflare Access: put the service token in CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET; they are sent as
 * the CF-Access-Client-Id and CF-Access-Client-Secret headers. Any other header: --header "Name: value", or
 * --header "Name: env:VAR" to read its value from the environment (required for a header that carries a secret, so it
 * stays off the command line). An Authorization header is refused: the recorder reads what the public reads.
 *
 * Options: --name <name> (the file's name, default the colony id), --source auto|recorded|reconstructed,
 * --no-diffs, --max-reads <n> (reads besides the record, default 5000), --concurrency <n> (default 6).
 *
 * Exits 0 when the recording is written, 1 when a read the replay cannot do without fails, 2 on a usage error.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import type { ColonySnapshot, EventsPage, RecordedEvent } from "@fire_trident/core";
import { redactEvidence } from "../packages/bench/src/evidence.ts";
import { RECORDING_FORMAT, RECORDING_NAME, RECORDING_VERSION, keyOf, type Recording, type RecordingRefusal } from "../packages/web/src/playback/recording.ts";
import { tourFor } from "../packages/web/src/tour/tours.ts";

/** The repository root (bundled recordings go under it). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Where `--bundle` writes: the web app's public folder, which `vite build` copies to the site's root. */
export const BUNDLE_DIR = join(REPO_ROOT, "packages", "web", "public", "recordings");
/** Events per page: what the replay page asks for, and the most the colony serves. */
const PAGE = 5_000;

/** A mistake in how the recorder was asked to run (exit code 2). */
export class UsageError extends Error {}

/** Header names whose value must come from the environment (env:VAR), never from the command line. */
const SECRET_HEADER = /secret|token|key|password|auth|cookie/i;

/**
 * The request headers to send: each `--header "Name: value"` (a value of `env:VAR` is read from `env`), plus Cloudflare
 * Access's service-token headers from CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET when both are set. Refuses an
 * Authorization or Cookie header, and a literal value for a header that carries a secret. `values` are what the
 * recording is checked against: none of them may appear in it.
 */
export function requestHeaders(specs: readonly string[], env: Readonly<Record<string, string | undefined>>): { headers: Record<string, string>; values: string[] } {
  const headers: Record<string, string> = {};
  for (const spec of specs) {
    const m = /^\s*([A-Za-z0-9-]+)\s*:\s*(.*?)\s*$/.exec(spec);
    if (!m?.[1]) throw new UsageError(`--header "${spec.split(":")[0] ?? ""}": write it as "Name: value" or "Name: env:VAR".`);
    const name = m[1];
    const raw = m[2] ?? "";
    if (/^(authorization|cookie)$/i.test(name)) throw new UsageError(`--header ${name}: the recorder reads public routes only, so it sends no ${name} header (an admin token would make the deployment answer with what the public never sees).`);
    let value = raw;
    const fromEnv = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw);
    if (fromEnv?.[1]) {
      value = env[fromEnv[1]] ?? "";
      if (!value) throw new UsageError(`--header ${name}: the environment variable ${fromEnv[1]} is not set.`);
    } else if (SECRET_HEADER.test(name)) {
      throw new UsageError(`--header ${name}: give its value as env:<VAR> so the secret stays off the command line.`);
    }
    if (!value) throw new UsageError(`--header ${name}: the value is empty.`);
    headers[name] = value;
  }
  const has = (n: string) => Object.keys(headers).some((k) => k.toLowerCase() === n.toLowerCase());
  const id = env.CF_ACCESS_CLIENT_ID;
  const secret = env.CF_ACCESS_CLIENT_SECRET;
  if (id && secret && !has("CF-Access-Client-Id") && !has("CF-Access-Client-Secret")) {
    headers["CF-Access-Client-Id"] = id;
    headers["CF-Access-Client-Secret"] = secret;
  }
  return { headers, values: Object.values(headers) };
}

/** Field names whose values are never recorded (an Artifacts lease's tokens, should any answer carry one). */
const SECRET_FIELD = /^(?:authorization|cookie|set-cookie|password|secret|token|bearer|api[-_]?key)$|(?:token|secret|password)$/i;

/**
 * `value` with what must not be published taken out: each of `secrets` (the request headers' values) wherever it
 * appears, credentials in URLs, Artifacts hosts (as artifacts://), then the evidence redaction (tokens, the account id,
 * emails, local paths) on every string and key; fields named like a token or a secret are dropped.
 */
export function scrub<T>(value: T, secrets: readonly string[] = []): T {
  const clean = (s: string): string => {
    let out = s;
    for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("<redacted>");
    out = out.replace(/(https?:\/\/)[^\s/@:"']+:[^\s/@"']+@/g, "$1");
    // An Artifacts remote as public readers see it (the API's hideRemotes), before the redaction would name ACCOUNT_ID.
    out = out.replace(/https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net\/git\//g, "artifacts://");
    return redactEvidence(out);
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return clean(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (!SECRET_FIELD.test(k)) out[clean(k)] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** What to record and from where. */
export interface RecordOptions {
  /** The deployment, e.g. https://<worker>.workers.dev (never written into the recording). */
  base: string;
  colonyId: string;
  /** Sent with every request (requestHeaders); never written. */
  headers?: Record<string, string>;
  /** The record's source, as ?source= on the events route; "auto" lets the colony choose, as the replay page does. */
  source?: "auto" | "recorded" | "reconstructed";
  /** Record each landing's change to each of its files (default true). */
  diffs?: boolean;
  /** Reads besides the event record, at most (default 5000): the lineage of landed files first, then note checks, changes and the other files. */
  maxReads?: number;
  concurrency?: number;
  /** Paths under the colony a tour reads ("/certifications?limit=50"); "" is the snapshot. */
  extraReads?: readonly string[];
  /** Events per page (default 5000). */
  pageSize?: number;
  /** Wait before a failed read is tried once more (default 400 ms). */
  retryMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
}

/** A recording and what went into it. */
export interface RecordResult {
  recording: Recording;
  /** Pages of the event record read. */
  pages: number;
  /** Reads recorded besides the record (answers and refusals). */
  reads: number;
  refused: number;
  /** Reads that failed, as "GET <path>: why" (playback answers them "not in this recording"). */
  failed: string[];
  /** Reads left out for maxReads. */
  skipped: number;
}

type Outcome = { kind: "ok"; body: unknown } | { kind: "refused"; status: number; error: string } | { kind: "failed"; why: string };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Run `fn` over `items`, at most `limit` at once. */
async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(lanes);
}

/**
 * Record one colony (see the module comment): the snapshot and every page of the event record are required; every
 * other read is kept when it answers, kept as a refusal when the deployment refuses it (a 4xx with its sentence), and
 * listed in `failed` otherwise. The recording is checked to hold none of the request headers' values.
 */
export async function recordColony(opts: RecordOptions): Promise<RecordResult> {
  const base = opts.base.replace(/\/+$/, "");
  const fetcher = opts.fetch ?? ((input, init) => fetch(input, init));
  const headers = { accept: "application/json", ...(opts.headers ?? {}) };
  const secrets = Object.values(opts.headers ?? {});
  const log = opts.log ?? (() => undefined);
  const retryMs = opts.retryMs ?? 400;
  const colony = `/api/colonies/${encodeURIComponent(opts.colonyId)}`;

  const signIn = "(behind Cloudflare Access? put its service token in CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET)";
  const get = async (path: string): Promise<Outcome> => {
    let last: Outcome = { kind: "failed", why: "no answer" };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, retryMs));
      let res: Response;
      try {
        // A redirect is a sign-in page, never an answer: it is not followed.
        res = await fetcher(`${base}${path}`, { headers, redirect: "manual" });
      } catch (e) {
        last = { kind: "failed", why: messageOf(e) };
        continue;
      }
      if (res.status >= 300 && res.status < 400) return { kind: "failed", why: `${res.status}: a redirect came back, not JSON ${signIn}` };
      if (!(res.headers.get("content-type") ?? "").includes("json")) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: "failed", why: `${res.status}: a page came back, not JSON ${signIn}` };
      }
      const body: unknown = await res.json().catch(() => null);
      if (res.ok) return { kind: "ok", body };
      const error = isObj(body) && typeof body.error === "string" && body.error.trim() ? body.error.trim() : `${res.status} ${res.statusText}`.trim();
      if (res.status < 500) return { kind: "refused", status: res.status, error };
      last = { kind: "failed", why: `${res.status}: ${error}` };
    }
    return last;
  };

  const reads: Record<string, unknown> = {};
  const refused: Record<string, RecordingRefusal> = {};
  const failed: string[] = [];
  const keep = (path: string, out: Outcome): void => {
    const key = keyOf(path);
    if (out.kind === "ok") reads[key] = scrub(out.body, secrets);
    else if (out.kind === "refused") refused[key] = { status: out.status, error: scrub(out.error, secrets) };
    else failed.push(`GET ${path}: ${scrub(out.why, secrets)}`);
  };

  // The snapshot and the record: without them there is nothing to replay.
  const snapOut = await get(colony);
  if (snapOut.kind !== "ok" || !isObj(snapOut.body) || !isObj(snapOut.body.colony)) {
    throw new Error(`GET ${colony} gave no snapshot: ${snapOut.kind === "ok" ? "the answer was not one" : snapOut.kind === "refused" ? `${snapOut.status} ${snapOut.error}` : snapOut.why}.`);
  }
  keep(colony, snapOut);
  const snap = snapOut.body as unknown as ColonySnapshot;
  const [about, agents] = await Promise.all([get("/api/about"), get(`${colony}/agents?all=1&journal=0&limit=10000`)]);
  keep("/api/about", about);
  keep(`${colony}/agents?all=1&journal=0&limit=10000`, agents);

  const pageSize = Math.max(1, Math.min(PAGE, opts.pageSize ?? PAGE));
  const source = opts.source && opts.source !== "auto" ? `&source=${opts.source}` : "";
  const events: RecordedEvent[] = [];
  let first: EventsPage | null = null;
  let pages = 0;
  for (let after = 0; ; ) {
    const path = `${colony}/events?after=${after}&limit=${pageSize}${source}`;
    const out = await get(path);
    if (out.kind !== "ok" || !isObj(out.body) || !Array.isArray(out.body.events)) {
      throw new Error(`GET ${path} gave no page of the event record: ${out.kind === "ok" ? "the answer was not one" : out.kind === "refused" ? `${out.status} ${out.error}` : out.why}.`);
    }
    const page = out.body as unknown as EventsPage;
    first ??= page;
    pages++;
    events.push(...page.events);
    log(`events: ${events.length.toLocaleString("en-US")} of ${(page.total ?? events.length).toLocaleString("en-US")}`);
    if (page.next === null || page.next === undefined || !page.events.length) break;
    if (page.next <= after) throw new Error(`The event record's pages did not move forward at ${after}.`);
    after = page.next;
  }
  if (!events.length) throw new Error(`Colony ${opts.colonyId} has no events to record.`);

  // Everything else the pages read, the most useful first, up to maxReads.
  let budget = Math.max(0, opts.maxReads ?? 5_000);
  let skipped = 0;
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const phase = async (paths: readonly string[]): Promise<void> => {
    const todo = paths.filter((p) => !(keyOf(p) in reads) && !(keyOf(p) in refused));
    const take = todo.slice(0, budget);
    skipped += todo.length - take.length;
    budget -= take.length;
    await eachLimit(take, concurrency, async (path) => keep(path, await get(path)));
  };

  await phase([...new Set((opts.extraReads ?? []).map((s) => `${colony}${s}`))]);

  const landings: Array<{ id: string; paths: string[] }> = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.t === "landing" && typeof e.landingId === "string") landings.push({ id: e.landingId, paths: Array.isArray(e.paths) ? e.paths : [] });
  }
  const landed = [...new Set(landings.flatMap((l) => l.paths))];
  const others = [...new Set((snap.files ?? []).map((f) => f.path))].filter((p) => !landed.includes(p));
  const whyPath = (p: string) => `${colony}/why?path=${encodeURIComponent(p)}`;
  await phase(landed.map(whyPath));
  log(`lineage: ${landed.length.toLocaleString("en-US")} landed files`);

  // Each landing's note check, and the change it made to each file (from the record and from the lineage read).
  const pairs = new Map<string, { id: string; path: string }>();
  const ids = new Set(landings.map((l) => l.id));
  for (const l of landings) for (const p of l.paths) pairs.set(`${l.id}\n${p}`, { id: l.id, path: p });
  for (const p of landed) {
    const entries = reads[keyOf(whyPath(p))];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const id = isObj(entry) && isObj(entry.landing) && typeof entry.landing.id === "string" ? entry.landing.id : null;
      if (!id) continue;
      ids.add(id);
      pairs.set(`${id}\n${p}`, { id, path: p });
    }
  }
  await phase([...ids].map((id) => `${colony}/notes/verify?landing=${encodeURIComponent(id)}`));
  log(`note checks: ${ids.size.toLocaleString("en-US")} landings`);
  if (opts.diffs !== false) {
    await phase([...pairs.values()].map(({ id, path }) => `${colony}/landings/${encodeURIComponent(id)}/diff?path=${encodeURIComponent(path)}`));
    log(`changes: ${pairs.size.toLocaleString("en-US")} files of landings`);
  }
  await phase(others.map(whyPath));

  const recording: Recording = {
    format: RECORDING_FORMAT,
    version: RECORDING_VERSION,
    colonyId: opts.colonyId,
    recordedAt: (opts.now ?? (() => new Date()))().toISOString(),
    note: `Public reads of colony ${opts.colonyId}, recorded by scripts/record_colony.ts for playback with no network: the event record, the snapshot, the agents, the build, each file's lineage, each landing's note check${opts.diffs === false ? "" : " and changes"}, and the tour's reads. Tokens, account ids, emails and local paths are redacted; no request header or deployment address is kept.`,
    record: {
      source: first?.source === "reconstructed" ? "reconstructed" : "recorded",
      total: first?.total ?? events.length,
      first: first?.first ?? null,
      last: first?.last ?? null,
      events: scrub(events, secrets),
    },
    reads,
    refused,
  };
  const text = JSON.stringify(recording);
  if (secrets.some((s) => s.length >= 4 && text.includes(s))) throw new Error("A request header's value is still in the recording, so nothing was written.");
  return { recording, pages, reads: Object.keys(reads).length + Object.keys(refused).length, refused: Object.keys(refused).length, failed, skipped };
}

/** The bytes to write for `rec` at `path`: gzip when the name ends in .gz. */
export function encodeRecording(rec: Recording, path: string): Uint8Array {
  const json = JSON.stringify(rec);
  return path.endsWith(".gz") ? gzipSync(json, { level: 9 }) : new TextEncoder().encode(json);
}

const kb = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        base: { type: "string" },
        url: { type: "string" },
        colony: { type: "string" },
        header: { type: "string", multiple: true },
        out: { type: "string" },
        bundle: { type: "boolean" },
        name: { type: "string" },
        source: { type: "string" },
        "no-diffs": { type: "boolean" },
        "max-reads": { type: "string" },
        concurrency: { type: "string" },
      },
    }));
  } catch (e) {
    throw new UsageError(messageOf(e));
  }
  const base = (values.base ?? values.url ?? process.env.FT_URL ?? "").trim();
  const colonyId = (values.colony ?? "").trim();
  if (!/^https?:\/\//.test(base) || !colonyId) throw new UsageError("usage: node --experimental-transform-types scripts/record_colony.ts --base https://<deployment> --colony <id> [--bundle | --out <file>] [--header \"Name: env:VAR\"]");
  const name = (values.name ?? colonyId).trim();
  if (!RECORDING_NAME.test(name)) throw new UsageError(`--name ${name}: use letters, digits, dots, dashes and underscores.`);
  const source = values.source ?? "auto";
  if (source !== "auto" && source !== "recorded" && source !== "reconstructed") throw new UsageError("--source is auto, recorded or reconstructed.");
  const count = (raw: string | undefined, key: string, fallback: number): number => {
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) throw new UsageError(`--${key} takes a whole number.`);
    return Number(raw);
  };
  const { headers } = requestHeaders(values.header ?? [], process.env);
  const out = values.bundle ? join(BUNDLE_DIR, `${name}.json.gz`) : (values.out ?? join("recordings", `${name}.json.gz`));

  const result = await recordColony({
    base,
    colonyId,
    headers,
    source,
    diffs: !values["no-diffs"],
    maxReads: count(values["max-reads"], "max-reads", 5_000),
    concurrency: Math.max(1, count(values.concurrency, "concurrency", 6)),
    extraReads: Object.values(tourFor(colonyId).reads),
    log: (line) => console.error(line),
  });
  const bytes = encodeRecording(result.recording, out);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, bytes);
  const json = JSON.stringify(result.recording).length;
  const shown = relative(process.cwd(), resolve(out)) || out;
  console.log(`recorded ${colonyId}: ${result.recording.record.events.length.toLocaleString("en-US")} events in ${result.pages} page(s), ${result.reads.toLocaleString("en-US")} reads (${result.refused} refused, ${result.failed.length} failed, ${result.skipped} left out for --max-reads)`);
  for (const f of result.failed.slice(0, 10)) console.log(`  not recorded: ${f}`);
  console.log(`wrote ${shown}: ${kb(bytes.length)}${out.endsWith(".gz") ? ` (${kb(json)} as JSON)` : ""}`);
  const href = (q: string) => `/c/${encodeURIComponent(colonyId)}?${q}recording=${encodeURIComponent(name)}`;
  if (values.bundle) console.log(`bundled: \`npm run build -w @fire_trident/web\` ships it at /recordings/${name}.json.gz; open ${href("replay=1&")} or ${href("director=1&replay=1&")}`);
  else console.log(`play it: pick or drop the file on /c/${encodeURIComponent(colonyId)}?replay=1&recording= , or bundle it with --bundle`);
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(redactEvidence(messageOf(e)));
      process.exitCode = e instanceof UsageError ? 2 : 1;
    },
  );
}
