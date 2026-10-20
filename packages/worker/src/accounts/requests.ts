import { z } from "zod";
import type { Env } from "../env.ts";
import { publicOrigin, sessionKey } from "./config.ts";
import { signValue, verifySigned } from "./crypto.ts";
import { REQUEST_NOTE_MAX } from "./limits.ts";
import type { InviteRequestView } from "./types.ts";

/**
 * Invite requests. A person without an invite code asks for one on the account page: their GitHub username and an
 * email, behind a Cloudflare Turnstile check. The operator gets an email with a signed link to a page that approves or
 * denies the request, and an approved GitHub account opens on its next sign-in with no code. Needs FT_TURNSTILE_SITE_KEY,
 * FT_TURNSTILE_SECRET, FT_INVITE_TO, FT_INVITE_FROM and the INVITE_MAIL send_email binding (whose destination is the
 * operator's verified address); without them the account page offers no request.
 */

/** Turnstile's server-side check. */
export const TURNSTILE_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** The HKDF purpose of the signed link in the operator's email. */
export const REQUEST_PURPOSE = "firetrident invite request v1";
/** Where the operator decides a request: GET shows it, POST approves or denies it. */
export const REQUEST_PATH = "/auth/invite-requests";

/** What a configured deployment has for requests. */
export interface RequestsConfig {
  siteKey: string;
  secret: string;
  to: string;
  from: string;
  mail: SendEmail;
  sessionKey: string;
  origin: string;
}

/** The configuration, or what is missing (logged by the caller, never shown with values). */
export function requestsConfig(env: Partial<Env>): RequestsConfig | { missing: string } {
  const gaps: string[] = [];
  const siteKey = (env.FT_TURNSTILE_SITE_KEY ?? "").trim();
  const secret = (env.FT_TURNSTILE_SECRET ?? "").trim();
  const to = (env.FT_INVITE_TO ?? "").trim();
  const from = (env.FT_INVITE_FROM ?? "").trim();
  const key = sessionKey(env);
  const origin = publicOrigin(env);
  if (!siteKey) gaps.push("FT_TURNSTILE_SITE_KEY");
  if (!secret) gaps.push("FT_TURNSTILE_SECRET");
  if (!to) gaps.push("FT_INVITE_TO");
  if (!from) gaps.push("FT_INVITE_FROM");
  if (!env.INVITE_MAIL) gaps.push("the INVITE_MAIL send_email binding");
  if (!key) gaps.push("FT_SESSION_KEY");
  if (!origin) gaps.push("FT_PUBLIC_URL");
  if (gaps.length || !key || !origin || !env.INVITE_MAIL) return { missing: gaps.join(", ") };
  return { siteKey, secret, to, from, mail: env.INVITE_MAIL, sessionKey: key, origin };
}

/** A GitHub username: 1 to 39 letters, digits and single hyphens, none at the ends. */
export const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A note: control characters out, spaces folded, at most REQUEST_NOTE_MAX characters. */
export function cleanNote(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REQUEST_NOTE_MAX);
}

export const RequestBody = z.object({
  login: z.string().trim().regex(GITHUB_LOGIN, "must be a GitHub username"),
  email: z.string().trim().max(254).regex(EMAIL, "must be an email address"),
  note: z.string().max(2_000).optional(),
  token: z.string().min(1).max(4_096),
});

/** Turnstile's siteverify: true when the token is good for this secret and, when known, this visitor. */
export type VerifyTurnstile = (secret: string, token: string, ip: string | null) => Promise<boolean>;

export const verifyTurnstile: VerifyTurnstile = async (secret, token, ip) => {
  const form = new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) });
  const res = await fetch(TURNSTILE_VERIFY, { method: "POST", body: form });
  if (!res.ok) return false;
  const data = (await res.json().catch(() => null)) as { success?: unknown } | null;
  return data?.success === true;
};

/** The link in the operator's email: the request's id, signed, so only the email's reader can open the decision page. */
export async function decisionLink(cfg: Pick<RequestsConfig, "origin" | "sessionKey">, id: string): Promise<string> {
  const t = await signValue(id, cfg.sessionKey, REQUEST_PURPOSE);
  return `${cfg.origin}${REQUEST_PATH}/${encodeURIComponent(id)}?t=${encodeURIComponent(t)}`;
}

/** The request id a signed token names, when its signature checks out; else null. */
export async function linkedId(token: string, key: string): Promise<string | null> {
  return verifySigned(token, key, REQUEST_PURPOSE);
}

/** The email the operator gets: who asks, how to reach them, and the signed link to decide. Plain text. */
export function requestMail(cfg: Pick<RequestsConfig, "to" | "from" | "origin">, r: InviteRequestView, link: string): { from: string; to: string; subject: string; text: string } {
  const host = cfg.origin.replace(/^https?:\/\//, "");
  const text = [
    `@${r.login} asks for an invite to ${host}.`,
    "",
    `GitHub:  https://github.com/${r.login}`,
    `Email:   ${r.email}`,
    `Note:    ${r.note || "(none)"}`,
    `Asked:   ${new Date(r.createdAt).toISOString()}`,
    "",
    "Decide here (the page has an Approve button and a Deny button):",
    link,
    "",
    `Approving lets that GitHub account open its FireTrident account on its next sign-in at ${cfg.origin}/account, with no code.`,
    "",
    "Sent by FireTrident.",
  ].join("\n");
  return { from: cfg.from, to: cfg.to, subject: `FireTrident: invite request from @${r.login}`, text };
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const STYLE =
  "body{margin:0;background:#05070b;color:#e6eefc;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}main{max-width:620px;margin:0 auto;padding:48px 20px}h1{font-size:24px;margin:0 0 16px}dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0 0 24px}dt{color:#8a97ad}dd{margin:0;overflow-wrap:anywhere}form{display:inline-block;margin:0 10px 0 0}button{font:inherit;font-weight:650;padding:10px 18px;border-radius:10px;border:1px solid #2a3647;background:#0e141e;color:#e6eefc;cursor:pointer}button.ok{border-color:#1fe08e;color:#1fe08e}button.no{border-color:#e5484d;color:#e5484d}a{color:#f6a24b}p.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;color:#8a97ad}";

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} · FireTrident</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function details(r: InviteRequestView): string {
  return `<dl><dt>GitHub</dt><dd><a href="https://github.com/${encodeURIComponent(r.login)}" rel="noreferrer">@${escape(r.login)}</a></dd><dt>Email</dt><dd>${escape(r.email)}</dd><dt>Note</dt><dd>${r.note ? escape(r.note) : "(none)"}</dd><dt>Asked</dt><dd>${escape(new Date(r.createdAt).toISOString())}</dd></dl>`;
}

/** A link the operator clicks to tell the person, from their own mail client. */
function tellLink(r: InviteRequestView, origin: string): string {
  const subject = encodeURIComponent("Your FireTrident invite");
  const body = encodeURIComponent(`You're in: sign in with GitHub as @${r.login} at ${origin}/account and your account opens.`);
  return `<p><a href="mailto:${escape(encodeURIComponent(r.email))}?subject=${subject}&amp;body=${body}">Tell @${escape(r.login)} by email</a> (opens your mail client with the message written).</p>`;
}

/** The decision page the email links to: the request, and a button each way. */
export function decisionPage(r: InviteRequestView, token: string, origin: string): string {
  if (r.status !== "pending") return decidedPage(r, origin);
  const t = escape(token);
  return page(
    `Invite request from @${r.login}`,
    `<h1>@${escape(r.login)} asks for an invite.</h1>${details(r)}<form method="post"><input type="hidden" name="t" value="${t}"><input type="hidden" name="decision" value="approve"><button class="ok" type="submit">Approve</button></form><form method="post"><input type="hidden" name="t" value="${t}"><input type="hidden" name="decision" value="deny"><button class="no" type="submit">Deny</button></form><p class="mono">Approving lets that GitHub account open its FireTrident account on its next sign-in at ${escape(origin)}/account, with no code.</p>`,
  );
}

/** What the operator sees after deciding, or when opening a request decided already. */
export function decidedPage(r: InviteRequestView, origin: string): string {
  const what =
    r.status === "approved"
      ? `<h1>Approved: @${escape(r.login)} can sign in.</h1><p>Their FireTrident account opens the next time they sign in with GitHub as that account.</p>${tellLink(r, origin)}`
      : r.status === "opened"
        ? `<h1>@${escape(r.login)} is in.</h1><p>The request was approved and the account is open.</p>`
        : r.status === "denied"
          ? `<h1>Denied: @${escape(r.login)}.</h1><p>Nothing opens for that account. They can ask again after a week.</p>`
          : `<h1>@${escape(r.login)}: still waiting.</h1>`;
  return page(`Invite request from @${r.login}`, `${what}${details(r)}`);
}

/** The page for a link that names no request, or a bad signature. */
export function noRequestPage(): string {
  return page("No such request", "<h1>This link does not name an invite request.</h1><p>It may have been cut short in your mail client. Open it again from the email.</p>");
}
