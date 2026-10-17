/**
 * Live check of signed lineage notes (trunk/signature.ts) on a deployment with FT_NOTE_KEY set, as a scripted external
 * agent over MCP plus the admin API, then a stock git clone:
 * - GET /.well-known/firetrident-keys.json lists one Ed25519 key whose id is the first 16 hex digits of the SHA-256 of
 *   its raw public key, and GET /api/about names the same key id;
 * - in a new colony listed in FT_PUBLIC_GIT, an agent lands one change, and the note check of that landing
 *   (GET /api/colonies/:id/notes/verify?landing=) finds its note intact and its commit signed by that key;
 * - in a stock `git clone` of /git/<colony>.git with the notes fetched, the landing commit ends with the
 *   FT-Note-Signature and FT-Note trailers; scripts/verify_note.mjs prints "intact" without --keys, as before, and
 *   "intact, signed by <key id>" with --keys <deployment>/.well-known/firetrident-keys.json;
 * - the note edited in the clone: "altered"; the history rewritten to match it (the same tree and parent, the FT-Note
 *   trailer recomputed for the edited note): "intact" without --keys, which the digest alone cannot catch, and
 *   "bad signature" with them.
 * The colony must not exist yet. The deployment needs FT_NOTE_KEY, FT_INLINE on, and the colony in FT_PUBLIC_GIT.
 *
 * Usage:
 *   FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/signed_notes.ts --url https://<deployment> --colony <new colony id>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const URL_BASE = (arg("url", process.env.FT_URL) ?? "").replace(/\/+$/, "");
const COLONY = arg("colony") ?? "";
const MCP_TOKEN = process.env.FT_MCP_TOKEN ?? "";
const ADMIN_TOKEN = process.env.FT_ADMIN_TOKEN ?? "";
if (!URL_BASE || !COLONY || !MCP_TOKEN || !ADMIN_TOKEN) {
  console.error("usage: FT_MCP_TOKEN=... FT_ADMIN_TOKEN=... node scripts/signed_notes.ts --url <deployment> --colony <new colony id listed in FT_PUBLIC_GIT>");
  process.exit(2);
}

const VERIFY_NOTE = fileURLToPath(new URL("./verify_note.mjs", import.meta.url));
const KEYS_URL = `${URL_BASE}/.well-known/firetrident-keys.json`;
const FILE = "notes/signed.md";

let failed = false;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (x: unknown, n = 160): string => String(typeof x === "string" ? x : JSON.stringify(x ?? null)).replace(/\s+/g, " ").slice(0, n);

async function rest(method: string, path: string, body?: unknown, token: string | null = ADMIN_TOKEN): Promise<{ status: number; data: any; type: string }> {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: res.status, data, type: res.headers.get("content-type") ?? "" };
}

/** A public read: no token, as anyone reads it. */
const read = (path: string) => rest("GET", path, undefined, null);

/** One MCP session: an external agent of its own. */
async function session(name: string): Promise<{ call: (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; data: any; text: string }>; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } });
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(transport);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const text = ((res.content as Array<{ type: string; text?: string }> | undefined) ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { ok: res.isError !== true, data, text };
  };
  return { call, close: () => client.close() };
}

/** Wait for a proposal to settle; its status and landing. */
async function settle(pid: string): Promise<{ status: string; landingId: string | null }> {
  let p: any = {};
  for (let i = 0; i < 40 && !["landed", "returned", "rejected"].includes(p.status ?? ""); i++) {
    await sleep(3000);
    p = (await rest("GET", `/api/colonies/${COLONY}/proposals/${pid}`)).data ?? {};
  }
  return { status: p.status ?? "", landingId: p.landingId ?? null };
}

/** The first 16 hex digits of the SHA-256 of a base64url public key's raw bytes: its key id. */
const keyIdOf = (publicKey: string): string => createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 16);

/** The note as FireTrident writes it (scripts/verify_note.mjs): keys sorted at every depth, 2-space indent. */
const canon = (v: unknown, i = ""): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const n = `${i}  `,
    a = Array.isArray(v);
  const items = a ? (v as unknown[]).map((x) => canon(x, n)) : Object.keys(v).sort().map((k) => `${JSON.stringify(k)}: ${canon((v as Record<string, unknown>)[k], n)}`);
  return items.length ? `${a ? "[" : "{"}\n${n}${items.join(`,\n${n}`)}\n${i}${a ? "]" : "}"}` : a ? "[]" : "{}";
};

async function main(): Promise<void> {
  // The published key, and the key id GET /api/about names.
  const keys = await read("/.well-known/firetrident-keys.json");
  const key = keys.data?.keys?.[0];
  check(`${KEYS_URL} lists one Ed25519 key (${keys.status}, ${short(key)})`, keys.status === 200 && keys.type.includes("application/json") && keys.data?.keys?.length === 1 && key?.alg === "Ed25519");
  const keyId: string = typeof key?.id === "string" ? key.id : "";
  check(`its id ${keyId} is the first 16 hex digits of the SHA-256 of its public key`, typeof key?.publicKey === "string" && /^[A-Za-z0-9_-]{43}$/.test(key.publicKey) && keyIdOf(key.publicKey) === keyId);
  check(`it says since when it signs (${short(key?.since)})`, key?.since === null || (typeof key?.since === "string" && Number.isFinite(Date.parse(key.since))));
  const about = await read("/api/about");
  check(`GET /api/about names the same key (${short(about.data?.noteKey)})`, about.status === 200 && about.data?.noteKey === keyId);
  if (!keyId) throw new Error("the deployment publishes no signing key: set FT_NOTE_KEY on it");

  // One landing in a new public colony.
  const made = await rest("POST", "/api/colonies", { name: COLONY, poolTarget: 4 });
  check(`created ${COLONY} (${made.status})`, made.status === 201);
  check(`${COLONY}: review off for this check`, (await rest("POST", `/api/colonies/${COLONY}/decide/policy`, { enabled: false })).status === 200);
  const s = await session(`signed-notes-${COLONY}`);
  const joined = await s.call("join", { colony: COLONY, name: "signed-notes-check", model: "scripted-writer" });
  check(`${COLONY}: joined (${short(joined.data?.agentId)})`, joined.ok);
  const title = `Add ${FILE}`;
  const declared = await s.call("declare", { title, why: `The signed notes check writes ${FILE}.`, footprint: [FILE] });
  const intentId = declared.data?.intent?.id;
  check(`${COLONY}: declared "${title}" (${short(intentId)})`, declared.ok && typeof intentId === "string");
  let taken = await s.call("take", { wait: 30 });
  for (let i = 0; i < 5 && taken.data?.intent?.id !== intentId; i++) {
    if (taken.data?.intent) await s.call("release", { reason: "the signed notes check wants its own intent" });
    taken = await s.call("take", { wait: 30 });
  }
  check(`${COLONY}: took "${title}"`, taken.data?.intent?.id === intentId);
  const proposed = await s.call("propose", { files: [{ path: FILE, content: "signed\n" }], summary: title, notVerified: "Not verified: the check ran nothing; it reads the landing back." });
  const settled = await settle(proposed.data?.proposal?.id ?? "");
  await s.close();
  check(`${COLONY}: "${title}" landed (${settled.status}, ${short(settled.landingId)})`, settled.status === "landed" && typeof settled.landingId === "string");
  if (!settled.landingId) throw new Error("the change did not land");

  // The note check of that landing, once its note is pushed.
  let v = await read(`/api/colonies/${COLONY}/notes/verify?landing=${settled.landingId}`);
  for (let i = 0; i < 20 && v.data?.notes?.[0]?.status !== "intact"; i++) {
    await sleep(3000);
    v = await read(`/api/colonies/${COLONY}/notes/verify?landing=${settled.landingId}`);
  }
  const n = v.data?.notes?.[0];
  check(`the note check finds it intact and signed by ${keyId} (${short(n?.status)}, ${short(n?.signature)})`, v.status === 200 && n?.status === "intact" && n?.signature?.status === "signed" && n?.signature?.keyId === keyId);
  const sha: string = typeof n?.trunkSha === "string" ? n.trunkSha : "";
  const newest = await read(`/api/colonies/${COLONY}/notes/verify?limit=1`);
  check(`ft verify's read says the same of the newest landing (${short(newest.data?.notes?.[0]?.signature)})`, newest.data?.notes?.[0]?.trunkSha === sha && newest.data?.notes?.[0]?.signature?.status === "signed");

  // A stock git clone, with the notes.
  const dir = mkdtempSync(join(tmpdir(), "ft-signed-notes-"));
  try {
    const git = (...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["clone", "--quiet", `${URL_BASE}/git/${COLONY}.git`, dir], { stdio: ["ignore", "ignore", "pipe"] });
    git("fetch", "--quiet", "origin", "refs/notes/firetrident:refs/notes/firetrident");
    const lines = git("log", "-1", "--format=%B", sha).trimEnd().split("\n");
    check(`the clone's commit ${sha.slice(0, 7)} ends with FT-Note-Signature (key ${keyId}) and then FT-Note`, /^FT-Note: sha256:[0-9a-f]{64}$/.test(lines.at(-1) ?? "") && new RegExp(`^FT-Note-Signature: ed25519 ${keyId} [A-Za-z0-9_-]{86}$`).test(lines.at(-2) ?? ""));
    // The verdict is the first line; a note that checks out gets a second, "answerable: <who> (<why>)".
    const verifyNote = (commit: string, keys: boolean): { code: number | null; out: string; answerable: string } => {
      const r = spawnSync(process.execPath, [VERIFY_NOTE, commit, ...(keys ? ["--keys", KEYS_URL] : [])], { cwd: dir, encoding: "utf8" });
      const [out = "", answerable = ""] = (r.stdout ?? "").trim().split("\n");
      return { code: r.status, out, answerable };
    };
    let r = verifyNote(sha, false);
    check(`verify_note.mjs ${sha.slice(0, 7)} prints intact, as before (${r.out}, exit ${r.code})`, r.out === "intact" && r.code === 0);
    // The check's intent was declared by its agent over MCP and landed with review off: no person answers for it.
    check(`and says who answers for it (${r.answerable})`, /^answerable: none \(agent \S+ declared the intent and it landed with no review recorded\)$/.test(r.answerable));
    r = verifyNote(sha, true);
    check(`verify_note.mjs ${sha.slice(0, 7)} --keys ${KEYS_URL} prints "intact, signed by ${keyId}" (${r.out}, exit ${r.code})`, r.out === `intact, signed by ${keyId}` && r.code === 0);

    // The note edited in the clone.
    const note = JSON.parse(git("notes", "--ref=firetrident", "show", sha)) as Record<string, unknown>;
    const edited = `${canon({ ...note, colonyId: `${COLONY}-forged` })}\n`;
    const noteFile = join(dir, ".git", "edited-note.json");
    writeFileSync(noteFile, edited);
    git("notes", "--ref=firetrident", "add", "-f", "-F", noteFile, sha);
    r = verifyNote(sha, true);
    check(`with the note edited in the clone, it prints altered (${r.out}, exit ${r.code})`, r.out === "altered" && r.code === 1);

    // History rewritten to match: the same tree and parent, the FT-Note trailer recomputed for the edited note.
    const { certification: _added, ...hashed } = JSON.parse(edited) as Record<string, unknown>;
    const digest = createHash("sha256").update(`${canon(hashed)}\n`).digest("hex");
    const messageFile = join(dir, ".git", "rewritten-message.txt");
    writeFileSync(messageFile, `${[...lines.slice(0, -1), `FT-Note: sha256:${digest}`].join("\n")}\n`);
    const [tree, parent] = git("log", "-1", "--format=%T%n%P", sha).trim().split("\n");
    const who = { GIT_AUTHOR_NAME: "rewriter", GIT_AUTHOR_EMAIL: "rewriter@example.invalid", GIT_COMMITTER_NAME: "rewriter", GIT_COMMITTER_EMAIL: "rewriter@example.invalid" };
    const forged = execFileSync("git", ["-C", dir, "commit-tree", tree ?? "", "-p", parent ?? "", "-F", messageFile], { encoding: "utf8", env: { ...process.env, ...who } }).trim();
    git("notes", "--ref=firetrident", "add", "-f", "-F", noteFile, forged);
    r = verifyNote(forged, false);
    check(`the history rewritten to match (${forged.slice(0, 7)}): the digest alone says intact (${r.out}, exit ${r.code})`, r.out === "intact" && r.code === 0);
    r = verifyNote(forged, true);
    check(`and with --keys it prints bad signature (${r.out}, exit ${r.code})`, r.out === "bad signature" && r.code === 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`signed notes check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
