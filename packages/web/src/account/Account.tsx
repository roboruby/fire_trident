import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { SiteNav } from "../components/SiteNav.tsx";
import { Code } from "../landing/RunIt.tsx";
import { colonyHref } from "../route.ts";
import { CloudflarePanel } from "../cloudflare/CloudflarePanel.tsx";
import { ROLE_TEXT, TOKEN_ROLES, errorOf, parseMe, parseTokens, send, shortDate, signinText, tokenState, whoText, type Me, type OwnedColony, type TokenRole, type TokenView } from "./account.ts";
import "../landing/landing.css";
import "./account.css";

/**
 * The account page (/account), on deployments with accounts on (FT_ACCOUNTS): sign in with GitHub, enter an invite code
 * the first time, connect a Cloudflare account, create colonies and mint the tokens that let agents and reviewers work
 * on them. Everything a person or GitHub wrote is shown as text.
 */

type Load = { kind: "loading" } | { kind: "off" } | { kind: "error"; text: string } | { kind: "ready"; me: Me };

/** The page. */
export function AccountPage() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const params = new URLSearchParams(location.search);
  const outcome = params.get("signin");
  const [notice, setNotice] = useState<string | null>(() => signinText(outcome));

  const refresh = useCallback(async () => {
    try {
      const res = await send("GET", "/api/me");
      if (res.status === 404) return setLoad({ kind: "off" });
      if (!res.ok) return setLoad({ kind: "error", text: await errorOf(res) });
      const me = parseMe(await res.json());
      setLoad(me ? { kind: "ready", me } : { kind: "error", text: "The server's answer did not read as an account." });
    } catch {
      setLoad({ kind: "error", text: "The server could not be reached. Check your connection and reload." });
    }
  }, []);

  useEffect(() => {
    document.title = "Your account · FireTrident";
    void refresh();
  }, [refresh]);

  const signOut = async () => {
    const res = await send("POST", "/auth/logout");
    if (!res.ok) return setNotice(await errorOf(res));
    setNotice("You are signed out.");
    history.replaceState(null, "", "/account");
    await refresh();
  };

  return (
    <div className="landing ac-page">
      <SiteNav
        account={false}
        extra={
          load.kind === "ready" && load.me.signedIn ? (
            <button type="button" className="ac-link" onClick={() => void signOut()}>
              Sign out
            </button>
          ) : null
        }
      />
      <main className="l-section ac-main">
        <div className="l-kicker">Your account</div>
        {notice ? (
          <p className="ac-notice" role="status">
            {notice}
          </p>
        ) : null}
        {load.kind === "loading" ? <p className="ac-text">Loading your account.</p> : null}
        {load.kind === "off" ? <Off /> : null}
        {load.kind === "error" ? <p className="ac-error">{load.text}</p> : null}
        {load.kind === "ready" && !load.me.signedIn ? outcome === "invite" ? <InviteStep onDone={refresh} onNotice={setNotice} /> : <SignIn /> : null}
        {load.kind === "ready" && load.me.signedIn ? <SignedIn me={load.me} onChange={refresh} /> : null}
      </main>
    </div>
  );
}

/** Accounts are off on this deployment. */
function Off() {
  return (
    <>
      <h1 className="l-h2">There is no account page on this deployment.</h1>
      <p className="ac-text">
        <a href="/">Go to the front page.</a>
      </p>
    </>
  );
}

/** Signed out: what an account is for, and the one way in. */
export function SignIn() {
  return (
    <>
      <h1 className="l-h2">Sign in to run your own colonies.</h1>
      <p className="ac-text">
        A colony is one repository that FireTrident coordinates agents on. With an account you can create up to three, on your own Cloudflare account, and give each agent or reviewer a token for just one of them. Reading every
        colony needs no account.
      </p>
      <p className="ac-text">The first time, you also need an invite code from whoever runs this deployment, or an approved request.</p>
      <div className="l-ctas">
        <a className="l-btn l-btn-primary" href="/auth/github/start">
          Sign in with GitHub
        </a>
      </div>
      <RequestInvite />
    </>
  );
}

/** A new person after GitHub: who GitHub said they are, and the invite code that opens their account. */
function InviteStep({ onDone, onNotice }: { onDone: () => Promise<void>; onNotice: (s: string | null) => void }) {
  const [who, setWho] = useState<{ login: string; name?: string } | null | "none">(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await send("GET", "/auth/github/pending").catch(() => null);
      if (!res?.ok) return setWho("none");
      const body = (await res.json().catch(() => null)) as { github?: { login?: unknown; name?: unknown } } | null;
      const login = typeof body?.github?.login === "string" ? body.github.login : null;
      const name = typeof body?.github?.name === "string" ? body.github.name : undefined;
      setWho(login ? { login, ...(name ? { name } : {}) } : "none");
    })();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await send("POST", "/auth/github/invite", { code });
    setBusy(false);
    if (!res.ok) return setError(await errorOf(res));
    onNotice("Your account is open and you are signed in.");
    history.replaceState(null, "", "/account");
    await onDone();
  };

  if (who === null) return <p className="ac-text">Reading your sign-in.</p>;
  if (who === "none") {
    return (
      <>
        <p className="ac-error">No sign-up is waiting here, or it waited longer than fifteen minutes. Sign in with GitHub again, then enter your code.</p>
        <SignIn />
      </>
    );
  }
  return (
    <>
      <h1 className="l-h2">Welcome, {whoText(who)}.</h1>
      <p className="ac-text">This GitHub account has no FireTrident account yet. Enter the invite code you were given to open one. You need it only this once.</p>
      <form className="ac-form" onSubmit={(e) => void submit(e)}>
        <label className="ac-field">
          <span>Invite code</span>
          <input className="mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ft-inv-…" autoComplete="off" spellCheck={false} required maxLength={200} />
        </label>
        <button type="submit" className="btn btn-approve" disabled={busy || code.trim() === ""}>
          Open my account
        </button>
        {error ? <p className="ac-error">{error}</p> : null}
      </form>
      <RequestInvite login={who.login} />
    </>
  );
}

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string; remove: (id: string) => void };
  }
}

/** Turnstile's script, loaded once and only when the form opens (explicit rendering: nothing runs until render is called). */
const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let turnstileLoading: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!turnstileLoading) {
    turnstileLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TURNSTILE_SCRIPT;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        turnstileLoading = null;
        reject(new Error("Turnstile did not load"));
      };
      document.head.appendChild(s);
    });
  }
  return turnstileLoading;
}

/**
 * Asking for an invite: a button, then a short form (GitHub username, email, a note) behind a Turnstile check. The
 * request goes to the operator by email with a link that approves it; an approved GitHub account opens on its next
 * sign-in here. Offered only where the deployment has requests set up (GET /api/accounts/invite-requests/config).
 */
export function RequestInvite({ login: known }: { login?: string } = {}) {
  const [open, setOpen] = useState(() => typeof location !== "undefined" && new URLSearchParams(location.search).get("request") === "1");
  const [siteKey, setSiteKey] = useState<string | null | undefined>(undefined);
  const [login, setLogin] = useState(known ?? "");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const widget = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || siteKey !== undefined) return;
    send("GET", "/api/accounts/invite-requests/config")
      .then(async (res) => {
        const b = res.ok ? ((await res.json().catch(() => null)) as { siteKey?: unknown } | null) : null;
        setSiteKey(typeof b?.siteKey === "string" && b.siteKey ? b.siteKey : null);
      })
      .catch(() => setSiteKey(null));
  }, [open, siteKey]);

  useEffect(() => {
    if (!open || !siteKey || sent) return;
    const el = widget.current;
    if (!el) return;
    let id: string | null = null;
    let gone = false;
    loadTurnstile()
      .then(() => {
        if (gone || !window.turnstile) return;
        id = window.turnstile.render(el, {
          sitekey: siteKey,
          callback: (t: string) => setToken(t),
          "expired-callback": () => setToken(null),
          "error-callback": () => setToken(null),
        });
      })
      .catch(() => setError("The check that you are a person could not load. Reload the page and try again."));
    return () => {
      gone = true;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [open, siteKey, sent]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    const res = await send("POST", "/api/accounts/invite-requests", { login: login.trim(), email: email.trim(), note, token }).catch(() => null);
    setBusy(false);
    if (!res) return setError("The server could not be reached.");
    if (!res.ok) return setError(await errorOf(res));
    setSent(login.trim());
  };

  if (!open) {
    return (
      <div className="ac-request">
        <p className="ac-text">
          No code?{" "}
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            Request an invite
          </button>
        </p>
      </div>
    );
  }
  if (sent) {
    return (
      <div className="ac-request">
        <p className="ac-strong">Request sent.</p>
        <p className="ac-text">When it is approved, sign in with GitHub as @{sent} and your account opens. Nothing else to do until then.</p>
      </div>
    );
  }
  if (siteKey === null) {
    return (
      <div className="ac-request">
        <p className="ac-text">Invite requests are not open on this deployment. Ask whoever runs it for a code.</p>
      </div>
    );
  }
  return (
    <form className="ac-form ac-request" onSubmit={(e) => void submit(e)}>
      <h3 className="ac-h3">Request an invite</h3>
      <p className="ac-text">The operator gets your request by email and approves it with one click. Then you sign in with GitHub here and your account opens.</p>
      <label className="ac-field">
        <span>Your GitHub username (the account you will sign in with)</span>
        <input className="mono" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="octocat" autoComplete="username" spellCheck={false} required maxLength={39} readOnly={!!known} />
      </label>
      <label className="ac-field">
        <span>Email (so the operator can reach you)</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required maxLength={254} />
      </label>
      <label className="ac-field">
        <span>What you would use it for (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="a repository, a team, a question" maxLength={280} />
      </label>
      <div className="ac-turnstile" ref={widget} aria-label="A check that you are a person" />
      <button type="submit" className="btn btn-approve" disabled={busy || !token || login.trim() === "" || email.trim() === ""}>
        {busy ? "Sending…" : "Send the request"}
      </button>
      {siteKey === undefined ? <p className="ac-text">Loading.</p> : null}
      {error ? <p className="ac-error">{error}</p> : null}
    </form>
  );
}

/** Signed in: the person, their Cloudflare connection, and their colonies. */
export function SignedIn({ me, onChange }: { me: Extract<Me, { signedIn: true }>; onChange: () => Promise<void> }) {
  return (
    <>
      <h1 className="l-h2">Signed in as {whoText(me.account.github)}.</h1>
      <CloudflarePanel onChange={() => void onChange()} />
      <section className="ac-card">
        <h2 className="ac-h2">Your colonies</h2>
        <p className="ac-text">
          You own {me.colonies.length} of the {me.limits.colonies} colonies an account may have. Each may run up to {me.limits.agentsPerColony} in-platform agents (agents FireTrident runs for you) and have up to{" "}
          {me.limits.tokensPerColony} live tokens.
        </p>
        {me.colonies.length > 0 && me.modelsOff ? <p className="ac-text">{me.modelsOff}</p> : null}
        {me.colonies.length > 0 ? (
          <ul className="ac-colonies">
            {me.colonies.map((c) => (
              <ColonyRow key={c.id} colony={c} maxDays={me.limits.tokenDays} onDeleted={onChange} />
            ))}
          </ul>
        ) : null}
        {me.colonies.length < me.limits.colonies ? (
          <CreateColony connected={me.cloudflare === "connected"} onCreated={onChange} />
        ) : (
          <p className="ac-text">You have as many colonies as an account may have.</p>
        )}
      </section>
    </>
  );
}

/** Create a colony: empty, or from a public repository. */
function CreateColony({ connected, onCreated }: { connected: boolean; onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const source = url.trim() ? { url: url.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}) } : undefined;
    const res = await send("POST", "/api/me/colonies", { name, ...(source ? { source } : {}) });
    setBusy(false);
    if (!res.ok) return setError(await errorOf(res));
    setName("");
    setUrl("");
    setBranch("");
    await onCreated();
  };

  return (
    <form className="ac-form" onSubmit={(e) => void submit(e)}>
      <h3 className="ac-h3">Create a colony</h3>
      {!connected ? <p className="ac-text">Connect your Cloudflare account first: the colony&apos;s repositories and model calls run on it.</p> : null}
      <label className="ac-field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app" maxLength={200} required />
      </label>
      <label className="ac-field">
        <span>Public repository to start from (optional; empty starts with a README)</span>
        <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/you/repo.git" maxLength={2048} />
      </label>
      {url.trim() ? (
        <label className="ac-field">
          <span>Branch (optional)</span>
          <input className="mono" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" maxLength={255} />
        </label>
      ) : null}
      <button type="submit" className="btn btn-approve" disabled={busy || !connected || name.trim() === ""}>
        {busy ? "Creating…" : "Create the colony"}
      </button>
      {error ? <p className="ac-error">{error}</p> : null}
    </form>
  );
}

/** One owned colony, with its tokens, and deleting it (asked twice: its repositories go from your Cloudflare account). */
function ColonyRow({ colony, maxDays, onDeleted }: { colony: OwnedColony; maxDays: number; onDeleted: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    const res = await send("DELETE", `/api/me/colonies/${encodeURIComponent(colony.id)}`).catch(() => null);
    setBusy(false);
    if (!res) return setError("The server could not be reached.");
    if (!res.ok) return setError(await errorOf(res));
    setConfirming(false);
    await onDeleted();
  };

  return (
    <li className="ac-colony">
      <div className="ac-colony-head">
        <a href={colonyHref(colony.id)} className="ac-colony-name">
          {colony.name ?? colony.id}
        </a>
        <span className="ac-muted mono">{colony.id}</span>
        <span className="ac-muted">{colony.state === "pending" ? "being created" : `created ${shortDate(colony.createdAt)}`}</span>
        <button type="button" className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Hide tokens" : "Tokens"}
        </button>
        {confirming ? null : (
          <button type="button" className="btn btn-reject" onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </div>
      {confirming ? (
        <p className="ac-text">
          Delete {colony.name ?? colony.id}? Its repositories are deleted from your Cloudflare account, its agents stop and its tokens stop working. This cannot be undone.{" "}
          <button type="button" className="btn btn-reject" disabled={busy} onClick={() => void remove()}>
            {busy ? "Deleting…" : "Yes, delete it"}
          </button>{" "}
          <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </p>
      ) : null}
      {error ? <p className="ac-error">{error}</p> : null}
      {open ? <Tokens colonyId={colony.id} maxDays={maxDays} /> : null}
    </li>
  );
}

/** A colony's scoped tokens: mint (the secret shown once), list and revoke. */
export function Tokens({ colonyId, maxDays }: { colonyId: string; maxDays: number }) {
  const [tokens, setTokens] = useState<TokenView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<TokenRole>("agent");
  const [days, setDays] = useState(maxDays);
  const [minted, setMinted] = useState<{ secret: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/me/colonies/${encodeURIComponent(colonyId)}/tokens`;

  const reload = useCallback(async () => {
    const res = await send("GET", base).catch(() => null);
    if (!res) return setError("The server could not be reached.");
    if (!res.ok) return setError(await errorOf(res));
    setTokens(parseTokens(await res.json()));
  }, [base]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const mint = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await send("POST", base, { role, label, days });
    setBusy(false);
    if (!res.ok) return setError(await errorOf(res));
    const body = (await res.json()) as { secret?: unknown };
    if (typeof body.secret === "string") setMinted({ secret: body.secret, label });
    setLabel("");
    await reload();
  };

  const revoke = async (t: TokenView) => {
    const res = await send("DELETE", `${base}/${encodeURIComponent(t.id)}`);
    if (!res.ok) return setError(await errorOf(res));
    await reload();
  };

  const now = Date.now();
  return (
    <div className="ac-tokens">
      <p className="ac-text">
        A scoped token lets one agent or one person work on this colony only, with one role. Agents use it as their bearer token on the API and at /mcp. It lasts at most {maxDays} days.
      </p>
      {minted ? (
        <div className="ac-minted">
          <p className="ac-strong">Copy the token for &ldquo;{minted.label}&rdquo; now: FireTrident keeps only its hash and cannot show it again.</p>
          <Code label="token" text={minted.secret} />
          <button type="button" className="btn" onClick={() => setMinted(null)}>
            I have copied it
          </button>
        </div>
      ) : null}
      <form className="ac-form" onSubmit={(e) => void mint(e)}>
        <h3 className="ac-h3">Mint a token</h3>
        <label className="ac-field">
          <span>Label (who or what uses it)</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="my coding agent" maxLength={80} required />
        </label>
        <fieldset className="ac-roles">
          <legend>Role</legend>
          {TOKEN_ROLES.map((r) => (
            <label key={r} className="ac-role">
              <input type="radio" name={`role-${colonyId}`} value={r} checked={role === r} onChange={() => setRole(r)} />
              <span>
                <b>{r}</b> {ROLE_TEXT[r]}
              </span>
            </label>
          ))}
        </fieldset>
        <label className="ac-field ac-days">
          <span>Days it lasts (1 to {maxDays})</span>
          <input type="number" min={1} max={maxDays} value={days} onChange={(e) => setDays(Math.max(1, Math.min(maxDays, Math.floor(Number(e.target.value) || 1))))} />
        </label>
        <button type="submit" className="btn btn-approve" disabled={busy || label.trim() === ""}>
          Mint the token
        </button>
      </form>
      {error ? <p className="ac-error">{error}</p> : null}
      {tokens === null ? (
        <p className="ac-text">Loading the tokens.</p>
      ) : tokens.length === 0 ? (
        <p className="ac-text">No tokens yet.</p>
      ) : (
        <ul className="ac-token-list">
          {tokens.map((t) => (
            <li key={t.id} className={`ac-token${t.live ? "" : " is-dead"}`}>
              <span className="ac-token-label">{t.label}</span>
              <span className="ac-chip">{t.role}</span>
              <span className="ac-muted">{tokenState(t, now)}</span>
              <span className="ac-muted">{t.lastUsedAt ? `last used ${shortDate(t.lastUsedAt)}` : "never used"}</span>
              {t.live ? (
                <button type="button" className="btn btn-reject" onClick={() => void revoke(t)}>
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
