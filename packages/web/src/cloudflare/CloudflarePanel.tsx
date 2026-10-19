import { useEffect, useState, type ReactNode } from "react";
import { chooseAccount, disconnectCloudflare, lineGranted, loadCloudflare, noticeFor, SCOPE_LINES, START_HREF, type CloudflareStatus, type PanelFetch, type PanelState } from "./cloudflare.ts";
import "./cloudflare.css";

/**
 * The "Connect Cloudflare" panel on the account page: whether this account is connected, to which Cloudflare account and
 * with which scopes (one line each on what it allows and why), and the actions: connect, choose the account, connect
 * again, disconnect. Nothing shows while accounts are off. CloudflarePanelView draws one state; CloudflarePanel loads
 * it and runs the actions.
 */

/** The scopes FireTrident asks for, one line each; with `granted`, which ones the connection has. */
function ScopeList({ granted }: { granted: readonly string[] | null }) {
  return (
    <ul className="cf-scopes">
      {SCOPE_LINES.map((line) => {
        const has = granted ? lineGranted(line, granted) : null;
        return (
          <li key={line.label} className={has === null ? "" : has ? "is-on" : "is-off"}>
            <span className="cf-scope-label">
              {has === null ? null : <span className="cf-mark" aria-label={has ? "granted" : "not granted"}>{has ? "✓" : "–"}</span>}
              {line.label}
            </span>
            <span className="cf-scope-why">{line.why}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** What one panel state needs to draw, and the actions it offers. */
export interface CloudflarePanelViewProps {
  state: PanelState;
  /** The callback's notice (?cloudflare=), or null. */
  notice: string | null;
  /** An action is running: its buttons are disabled. */
  busy?: boolean;
  /** The account picked in the list while choosing. */
  picked?: string | null;
  /** Disconnect was pressed once: ask to confirm. */
  confirming?: boolean;
  onPick?: (id: string) => void;
  onChoose?: () => void;
  onDisconnect?: () => void;
  onCancel?: () => void;
}

function Lede() {
  return (
    <p className="cf-lede">
      Connect your Cloudflare account to create colonies (each colony is one repository under coordination). Everything that costs money in your colonies runs on your account and is billed to it:
      their repositories live in your Artifacts and their models run on your Workers AI. FireTrident itself is free.
    </p>
  );
}

function DisconnectRow({ busy, confirming, onDisconnect, onCancel }: Pick<CloudflarePanelViewProps, "busy" | "confirming" | "onDisconnect" | "onCancel">) {
  if (!confirming) {
    return (
      <button type="button" className="btn btn-reject" disabled={busy} onClick={onDisconnect}>
        Disconnect
      </button>
    );
  }
  return (
    <span className="cf-confirm">
      <span>Disconnect? Your colonies&apos; repositories stay in your Artifacts, but FireTrident cannot reach them, or run their models, until you connect again.</span>
      <button type="button" className="btn btn-reject" disabled={busy} onClick={onDisconnect}>
        Yes, disconnect
      </button>
      <button type="button" className="btn" disabled={busy} onClick={onCancel}>
        Keep it
      </button>
    </span>
  );
}

function Connected({ status, ...p }: { status: CloudflareStatus } & CloudflarePanelViewProps) {
  return (
    <>
      <p className="cf-state">
        Connected to <strong>{status.account?.name ?? "your account"}</strong> <span className="mono cf-id">{status.account?.id}</span>
      </p>
      <ScopeList granted={status.scopes} />
      {status.workersAi ? null : (
        <p className="cf-warn">
          Workers AI was not allowed: in-platform agents and model review are off in your colonies. Connect again and allow Workers AI, or bring your own agents over MCP.
        </p>
      )}
      <div className="cf-actions">
        {status.workersAi ? null : (
          <a className="btn" href={START_HREF}>
            Connect again
          </a>
        )}
        <DisconnectRow {...p} />
      </div>
    </>
  );
}

function Choose({ status, busy, picked, onPick, onChoose, ...p }: { status: CloudflareStatus } & CloudflarePanelViewProps) {
  const accounts = status.accounts ?? [];
  return (
    <>
      <p className="cf-state">Choose the Cloudflare account your colonies use. Their repositories and models are billed to it, and changing it later means connecting again.</p>
      <fieldset className="cf-accounts" disabled={busy}>
        <legend className="cf-legend">Accounts this connection reaches</legend>
        {accounts.map((a) => (
          <label key={a.id} className="cf-account">
            <input type="radio" name="cf-account" value={a.id} checked={picked === a.id} onChange={() => onPick?.(a.id)} />
            <span>{a.name}</span> <span className="mono cf-id">{a.id}</span>
          </label>
        ))}
      </fieldset>
      <div className="cf-actions">
        <button type="button" className="btn btn-approve" disabled={busy || !picked} onClick={onChoose}>
          Use this account
        </button>
        <DisconnectRow busy={busy} {...p} />
      </div>
    </>
  );
}

/** One state of the panel, drawn. */
export function CloudflarePanelView(props: CloudflarePanelViewProps) {
  const { state, notice } = props;
  if (state.kind === "off") return null;
  let body: ReactNode;
  if (state.kind === "loading") body = <p className="cf-state">Reading your Cloudflare connection…</p>;
  else if (state.kind === "signin") body = <p className="cf-state">Sign in to connect your Cloudflare account.</p>;
  else if (state.kind === "unset") body = <p className="cf-state">Connecting Cloudflare is not set up on this deployment yet.</p>;
  else if (state.kind === "error") body = <p className="cf-warn">{state.message}</p>;
  else {
    const s = state.status;
    if (s.state === "connected") body = <Connected status={s} {...props} />;
    else if (s.state === "choose") body = <Choose status={s} {...props} />;
    else if (s.state === "broken")
      body = (
        <>
          <p className="cf-state">
            This connection stopped working{s.account ? <> (it was connected to <strong>{s.account.name}</strong>)</> : null}.
          </p>
          <p className="cf-warn">{s.reason ?? "Connect Cloudflare again."}</p>
          <div className="cf-actions">
            <a className="btn btn-approve" href={START_HREF}>
              Connect again
            </a>
            <DisconnectRow {...props} />
          </div>
        </>
      );
    else
      body = (
        <>
          <p className="cf-state">Not connected.</p>
          <Lede />
          <ScopeList granted={null} />
          <div className="cf-actions">
            <a className="btn btn-approve" href={START_HREF}>
              Connect Cloudflare
            </a>
          </div>
        </>
      );
  }
  return (
    <section className="cf-panel" aria-labelledby="cf-panel-title">
      <h2 id="cf-panel-title" className="cf-title">
        Cloudflare
      </h2>
      {notice ? (
        <p className="cf-notice" role="status">
          {notice}
        </p>
      ) : null}
      {body}
    </section>
  );
}

/** The panel: loads the connection, then connects, chooses and disconnects through the Worker. */
export function CloudflarePanel({ fetchFn, search }: { fetchFn?: PanelFetch; search?: string } = {}) {
  const f: PanelFetch = fetchFn ?? ((input, init) => fetch(input, init));
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const notice = noticeFor(search ?? (typeof window === "undefined" ? "" : window.location.search));
  useEffect(() => {
    let live = true;
    void loadCloudflare(f).then((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
    // Loaded once per mount.
  }, []);
  const run = (action: () => Promise<PanelState>) => {
    setBusy(true);
    void action().then((s) => {
      setState(s);
      setBusy(false);
      setConfirming(false);
    });
  };
  return (
    <CloudflarePanelView
      state={state}
      notice={notice}
      busy={busy}
      picked={picked}
      confirming={confirming}
      onPick={setPicked}
      onChoose={() => picked && run(() => chooseAccount(f, picked))}
      onDisconnect={() => (confirming ? run(() => disconnectCloudflare(f)) : setConfirming(true))}
      onCancel={() => setConfirming(false)}
    />
  );
}
