/**
 * The accounts module's limits, in one place: quotas on what a person may hold, and how long credentials live.
 */

/** Colonies one account may own. */
export const MAX_COLONIES_PER_ACCOUNT = 3;
/** In-platform agents (internal and synthetic, not stopped) one owned colony may run at once. */
export const MAX_AGENTS_PER_COLONY = 20;
/** Scoped tokens (neither revoked nor expired) one colony may have at once. */
export const MAX_LIVE_TOKENS_PER_COLONY = 20;
/** The longest a scoped token may live, in days, and what a mint without `days` gets. */
export const TOKEN_MAX_DAYS = 30;

/** How long a session lasts after sign-in. It does not slide: sign in again after it. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60_000;
/** How long the sign-in round trip to GitHub may take (the state cookie's life). */
export const OAUTH_TTL_MS = 10 * 60_000;
/** How long a new person has to enter their invite code after GitHub said who they are. */
export const SIGNUP_TTL_MS = 15 * 60_000;

/** Invite codes: uses and days a mint may ask for, and what it gets when it does not say. */
export const INVITE_MAX_USES = 1_000;
export const INVITE_DEFAULT_DAYS = 14;
export const INVITE_MAX_DAYS = 90;

/** How often a token's last use is written (a busy agent's every call need not write). */
export const TOKEN_TOUCH_MS = 60_000;

/** One day in milliseconds. */
export const DAY_MS = 24 * 60 * 60_000;

/** An invite request's note is at most this long. */
export const REQUEST_NOTE_MAX = 280;
/** A GitHub account or email with a request waiting or approved within this window cannot ask again. */
export const REQUEST_WINDOW_MS = 7 * DAY_MS;
