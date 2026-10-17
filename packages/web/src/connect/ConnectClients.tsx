import { useState } from "react";
import { ACCESS_TITLE, type ConnectClientId, type ConnectInfo, type ConnectSnippet } from "@fire_trident/core";
import { Code } from "../landing/RunIt.tsx";
import "./connect.css";

/** One snippet: a one-click install link as a button above its text, everything else as code to copy. */
function Snippet({ s, client }: { s: ConnectSnippet; client: string }) {
  if (s.kind === "link") {
    return (
      <div className="cx-link">
        <a className="l-btn cx-install" href={s.text}>
          Add to {client}
        </a>
        <Code label="install link" text={s.text} />
      </div>
    );
  }
  return <Code label={s.file ?? (s.kind === "steps" ? "in the app" : s.label === "Shell" ? "shell" : s.label)} text={s.text} />;
}

/**
 * Every client's connection (core/connect.ts), one tab each: the read-only public server first, then the server that
 * joins with the deployment's MCP token. Every panel is in the page; the ones not chosen are hidden. `compact` stacks
 * the two servers and shows only the first snippet of each (the command or the link), for a narrow column.
 */
export function ConnectClients({ info, initial = "claude-code", compact = false }: { info: ConnectInfo; initial?: ConnectClientId; compact?: boolean }) {
  const [active, setActive] = useState<ConnectClientId>(initial);
  return (
    <div className={`cx${compact ? " cx-compact" : ""}`}>
      <div className="cx-tabs" role="tablist" aria-label="MCP client">
        {info.clients.map((c) => (
          <button key={c.id} type="button" role="tab" id={`cx-tab-${c.id}`} aria-controls={`cx-panel-${c.id}`} aria-selected={c.id === active} className={`cx-tab${c.id === active ? " is-on" : ""}`} onClick={() => setActive(c.id)}>
            {c.name}
          </button>
        ))}
      </div>
      {info.clients.map((c) => (
        <div key={c.id} className="cx-panel" role="tabpanel" id={`cx-panel-${c.id}`} aria-labelledby={`cx-tab-${c.id}`} hidden={c.id !== active}>
          {c.variants.map((v) => (
            <section key={v.access} className={`cx-variant cx-${v.access}`}>
              <h3 className="cx-head">{ACCESS_TITLE[v.access]}</h3>
              <p className="cx-note">{v.note}</p>
              {(compact ? v.snippets.slice(0, 1) : v.snippets).map((s, i) => (
                <Snippet key={i} s={s} client={c.name} />
              ))}
            </section>
          ))}
        </div>
      ))}
    </div>
  );
}
