/**
 * "Connect Cloudflare" on the account page: the Worker's answers (cloudflare/routes.ts in the worker), the words for
 * each scope and for each way a connection can come back, and the three calls the panel makes. With accounts off the
 * Worker answers 404 and the panel shows nothing.
 */

/** A Cloudflare account. Its name is the person's own text; React escapes it like any text. */
export interface CloudflareAccount {
  id: string;
  name: string;
}

/** GET /api/me/cloudflare. */
export interface CloudflareStatus {
  configured: boolean;
  state: "none" | "choose" | "connected" | "broken";
  account?: CloudflareAccount;
  accounts?: CloudflareAccount[];
  scopes: string[];
  workersAi: boolean;
  reason?: string;
  connectedAt?: number;
}

/** What the panel shows. */
export type PanelState =
  | { kind: "loading" }
  /** Accounts are off on this deployment (404): the panel shows nothing. */
  | { kind: "off" }
  | { kind: "signin" }
  /** Connecting is not set up on this deployment. */
  | { kind: "unset" }
  | { kind: "error"; message: string }
  | { kind: "status"; status: CloudflareStatus };

/** Where "Connect Cloudflare" goes: the Worker starts the OAuth flow there. */
export const START_HREF = "/auth/cloudflare/start";
export const STATUS_PATH = "/api/me/cloudflare";
export const CHOOSE_PATH = "/api/me/cloudflare/account";
export const DISCONNECT_PATH = "/api/me/cloudflare/disconnect";

/** One line per scope FireTrident asks for: what it allows and why. */
export interface ScopeLine {
  scopes: string[];
  label: string;
  why: string;
  optional: boolean;
}

export const SCOPE_LINES: readonly ScopeLine[] = [
  { scopes: ["user-details.read"], label: "Your user details", why: "who you are on Cloudflare and which accounts you can use, so you choose the one your colonies use and are billed to.", optional: false },
  { scopes: ["account-settings.read"], label: "Your account settings", why: "your account's name, to show which account your colonies use.", optional: false },
  { scopes: ["artifacts.read", "artifacts.write"], label: "Artifacts", why: "your colonies' repositories live in your Artifacts, billed to your account.", optional: false },
  {
    scopes: ["ai.read", "ai.write"],
    label: "Workers AI (optional)",
    why: "in-platform agents and model review run on your Workers AI, billed to your account. Without it, bring your own agents over MCP.",
    optional: true,
  },
  { scopes: ["offline_access"], label: "Stay connected", why: "FireTrident renews its access on its own until you disconnect.", optional: true },
];

/** Whether a scope line was granted (any of its scopes; Workers AI runs with either one). */
export function lineGranted(line: ScopeLine, granted: readonly string[]): boolean {
  return line.scopes.some((s) => granted.includes(s));
}

/** What the callback's ?cloudflare=<what happened> says, one sentence each. */
export const NOTICES: Readonly<Record<string, string>> = {
  connected: "Cloudflare is connected.",
  choose: "Cloudflare is connected. Choose the account your colonies use.",
  expired: "That connection did not start here, or took longer than 10 minutes. Connect again.",
  denied: "You declined on Cloudflare's page, so nothing was connected.",
  refused: "Cloudflare refused the connection. Connect again.",
  scopes: "Cloudflare did not grant what FireTrident needs (your user details, your account settings and Artifacts). Connect again and allow them.",
  accounts: "Cloudflare did not list an account this connection reaches. Connect again and choose an account on Cloudflare's page.",
  unavailable: "Connecting Cloudflare is not set up here, or Cloudflare did not answer. Try again in a minute.",
  signin: "Sign in first, then connect Cloudflare.",
  error: "Cloudflare sent back an incomplete answer. Connect again.",
};

/** The notice for an address's ?cloudflare= (null when there is none or it is not one of ours). */
export function noticeFor(search: string): string | null {
  const what = new URLSearchParams(search).get("cloudflare");
  return what && Object.hasOwn(NOTICES, what) ? (NOTICES[what] ?? null) : null;
}

/** fetch as the panel calls it (the browser's, or a fake in tests). */
export type PanelFetch = (input: string, init?: RequestInit) => Promise<Response>;

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON: the status says enough.
  }
  return `The server answered ${res.status}. Try again.`;
}

/** A status answer as the panel state. */
async function asState(res: Response): Promise<PanelState> {
  if (res.status === 404) return { kind: "off" };
  if (res.status === 401) return { kind: "signin" };
  if (!res.ok) return { kind: "error", message: await errorOf(res) };
  const status = (await res.json()) as CloudflareStatus;
  if (!status.configured) return { kind: "unset" };
  return { kind: "status", status: { ...status, scopes: Array.isArray(status.scopes) ? status.scopes : [] } };
}

const NO_ANSWER: PanelState = { kind: "error", message: "The server did not answer. Try again." };

/** Read the connection (GET /api/me/cloudflare). */
export async function loadCloudflare(fetchFn: PanelFetch): Promise<PanelState> {
  try {
    return await asState(await fetchFn(STATUS_PATH, { credentials: "same-origin", headers: { accept: "application/json" } }));
  } catch {
    return NO_ANSWER;
  }
}

/** Choose the Cloudflare account (POST /api/me/cloudflare/account). */
export async function chooseAccount(fetchFn: PanelFetch, accountId: string): Promise<PanelState> {
  try {
    const res = await fetchFn(CHOOSE_PATH, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ accountId }) });
    return await asState(res);
  } catch {
    return NO_ANSWER;
  }
}

/** Disconnect (POST /api/me/cloudflare/disconnect), then read the connection again. */
export async function disconnectCloudflare(fetchFn: PanelFetch): Promise<PanelState> {
  try {
    const res = await fetchFn(DISCONNECT_PATH, { method: "POST", credentials: "same-origin", headers: { accept: "application/json" } });
    if (!res.ok) return res.status === 404 || res.status === 401 ? asState(res) : { kind: "error", message: await errorOf(res) };
    return loadCloudflare(fetchFn);
  } catch {
    return NO_ANSWER;
  }
}
