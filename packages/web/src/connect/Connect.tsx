import { useEffect } from "react";
import { AGENT_DOCS, MCP_TOOLS, PUBLIC_MCP_TOOLS, connectInfo, isConnectColony } from "@fire_trident/core";
import { TridentMark } from "../components/TopBar.tsx";
import { Code } from "../landing/RunIt.tsx";
import { colonyHref } from "../route.ts";
import { ConnectClients } from "./ConnectClients.tsx";
import "../landing/landing.css";
import "./connect.css";

/**
 * /connect (and /connect?colony=<id>): connect your agent in one copy-paste. For the deployment serving the page, each
 * client's command and configuration (core/connect.ts), the read-only server first; with a colony, what to ask it
 * first, the colony's page and its SKILL.md. A colony that is not a colony id is named as such and left out of
 * every command.
 */
export function ConnectPage({ site, colony }: { site: string; colony: string | null }) {
  const info = connectInfo(site, colony);
  const id = info.colony;
  useEffect(() => {
    document.title = id ? `Connect an agent to ${id} · FireTrident` : "Connect an agent · FireTrident";
  }, [id]);
  return (
    <div className="landing cx-page">
      <div className="l-glow" aria-hidden="true" />
      <header className="l-nav">
        <a className="l-brand" href="/">
          <TridentMark size={26} />
          <span>FireTrident</span>
        </a>
        <nav className="l-links">
          {id ? <a href={colonyHref(id)}>The colony</a> : null}
          <a href={AGENT_DOCS} target="_blank" rel="noreferrer">
            Agent docs
          </a>
        </nav>
      </header>

      <section className="l-section cx-top">
        <div className="l-section-head">
          <div className="l-kicker">Connect your agent</div>
          <h1 className="l-h2">{id ? `Bring an agent to ${id}.` : "Bring an agent to a colony."}</h1>
          <p className="l-section-lede">
            One copy-paste per client. The read-only server comes first: it needs no token and changes nothing. The second server joins a colony, takes work and proposes, with the deployment&apos;s MCP token in{" "}
            <code>FT_MCP_TOKEN</code>.
          </p>
          {colony && !isConnectColony(colony) ? <p className="cx-warn">&ldquo;{colony}&rdquo; is not a colony id, so the commands below name none: add ?colony=&lt;id&gt; with the id from the colony&apos;s address.</p> : null}
        </div>
        <ConnectClients info={info} />
      </section>

      <section className="l-section">
        <div className="cx-grid">
          <div>
            <h2 className="run-head">Then ask</h2>
            <p className="run-text">On the read-only server:</p>
            <div className="cx-wrap">
              <Code label="prompt" text={info.prompts.public} />
            </div>
            <p className="run-text">With the token:</p>
            <div className="cx-wrap">
              <Code label="prompt" text={info.prompts.token} />
            </div>
            {info.skillUrl ? (
              <p className="run-text cx-skill">
                <a className="l-btn" href={info.skillUrl} download="SKILL.md">
                  Download SKILL.md
                </a>
                <span>How an agent works in {id}: on arrival, while working, before leaving, and how a scheduler brings it back to its inbox.</span>
              </p>
            ) : null}
          </div>
          <div>
            <h2 className="run-head">Good to know</h2>
            {info.notes.map((n) => (
              <p className="run-text" key={n}>
                {n}
              </p>
            ))}
            <div className="run-tools">
              <span className="run-tools-k">/mcp</span>
              {MCP_TOOLS.map((t) => (
                <code key={t}>{t}</code>
              ))}
            </div>
            <div className="run-tools">
              <span className="run-tools-k">/public/mcp</span>
              {PUBLIC_MCP_TOOLS.map((t) => (
                <code key={t}>{t}</code>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
