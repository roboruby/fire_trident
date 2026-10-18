import type { Id, Sha } from "@fire_trident/core";
import { configuredToken } from "../../api/token.ts";

/**
 * Decision codes: only a person's click in the review view decides. review_card hands the view a code in its result's
 * `_meta` (the part of a tool result MCP Apps keeps for the view, never shown to the host's model), and decide refuses
 * a call without a valid one. A code is an HMAC over the colony, the change, the change's head commit, the decisions
 * it allows (approve or return) and its expiry, ten minutes after it was issued, under a key derived from
 * FT_ADMIN_TOKEN; a random nonce makes each code unique, and the colony spends it once (colony/reviewcodes.ts).
 */

/** How long a code lasts. */
export const DECISION_CODE_TTL_MS = 10 * 60_000;
/** The `_meta` key of a review_card result that carries the code. */
export const DECISION_CODE_META = "com.firetrident/decision-code";
/** The decisions one code allows. */
const ALLOWED = "approve,return";
/** What the derived key is for, so it signs nothing else. */
const KEY_LABEL = "firetrident review decision code v1";
const CODE = /^([0-9a-z]{1,12})\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;

/** The change a code decides. */
export interface CodeSubject {
  colony: Id;
  proposalId: Id;
  head: Sha;
}

/** A code read apart: its expiry, its nonce and its MAC. */
export interface ParsedCode {
  expiresAt: number;
  nonce: string;
  mac: string;
}

const enc = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The HMAC key for codes, derived from the admin token; null when none is configured (no code is ever valid). */
async function codeKey(adminToken: string | undefined): Promise<CryptoKey | null> {
  const secret = configuredToken(adminToken ?? "");
  if (secret === "") return null;
  const root = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", root, enc.encode(KEY_LABEL)));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function message(s: CodeSubject, expiresAt: number, nonce: string): Uint8Array {
  return enc.encode(["ft-review-decision", s.colony, s.proposalId, s.head, ALLOWED, String(expiresAt), nonce].join("\n"));
}

/** A new code for one change, valid for DECISION_CODE_TTL_MS from `now`; null without FT_ADMIN_TOKEN. */
export async function issueDecisionCode(adminToken: string | undefined, s: CodeSubject, now: number): Promise<string | null> {
  const key = await codeKey(adminToken);
  if (!key) return null;
  const expiresAt = now + DECISION_CODE_TTL_MS;
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message(s, expiresAt, nonce)));
  return `${expiresAt.toString(36)}.${nonce}.${base64url(mac)}`;
}

/** A code read apart when it has the shape of one and has not expired at `now`; null otherwise. */
export function parseDecisionCode(code: unknown, now: number): ParsedCode | null {
  if (typeof code !== "string") return null;
  const m = CODE.exec(code);
  if (!m) return null;
  const expiresAt = parseInt(m[1] ?? "", 36);
  if (!Number.isSafeInteger(expiresAt) || now > expiresAt || expiresAt - now > DECISION_CODE_TTL_MS) return null;
  return { expiresAt, nonce: m[2] ?? "", mac: m[3] ?? "" };
}

/** Whether a parsed code was issued for this change at this head (the MAC checked in constant time). */
export async function decisionCodeSigned(adminToken: string | undefined, s: CodeSubject, c: ParsedCode): Promise<boolean> {
  const key = await codeKey(adminToken);
  if (!key) return false;
  return crypto.subtle.verify("HMAC", key, fromBase64url(c.mac), message(s, c.expiresAt, c.nonce));
}
