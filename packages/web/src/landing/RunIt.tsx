import { useState } from "react";
import { MCP_TOOLS, connectInfo, connectSite } from "@fire_trident/core";
import { ConnectClients } from "../connect/ConnectClients.tsx";

/** The deployed server the CLI and MCP snippets point at. */
export const SERVER = "https://firetrident.com";

const CLI = `# Read any colony here, no token needed
npx fire_trident colonies
npx fire_trident why hono src/hono.ts:42
npx fire_trident certify shortlinks

# Plain git works too: certified branch, lineage notes
git clone -b certified ${SERVER}/git/shortlinks.git

# Writes need a token: run your own FireTrident (/docs/try-it/)
npm i -g fire_trident
export FT_URL=https://<your-worker>.workers.dev FT_TOKEN=<your-token>
ft import https://github.com/honojs/hono

# Declare the shape you want: every match becomes a need
ft rule add hono --pattern "console\\.(log|warn)\\(" \\
  --include "src/**" --hint "Return errors instead" \\
  --description "No console calls in src"

# Start agents and watch the colony converge
ft swarm hono --agents 64
ft watch hono`;

/** The deployment the connect snippets name: the one serving the page, else the public site (as in a test render). */
function connectOrigin(): string {
  return (typeof location !== "undefined" ? connectSite(location.origin) : null) ?? SERVER;
}

/** A labeled block of commands with a copy button; lines starting with # read as comments. */
export function Code({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  return (
    <div className="code">
      <div className="code-bar">
        <span className="mono">{label}</span>
        <button type="button" className="code-copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="mono">
        {text.split("\n").map((line, i) => (
          <span key={i} className={line.startsWith("#") ? "code-comment" : undefined}>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

/** Quickstart: the ft CLI, and connecting agents you run yourself (connect/ConnectClients.tsx, the read-only server first). */
export function RunIt() {
  return (
    <div className="run-grid">
      <div className="run-col">
        <h3 className="run-head">From the command line</h3>
        <p className="run-text">
          Read any colony on {SERVER.replace("https://", "")} without a token. On your own deployment, import any public HTTPS repository into Artifacts, declare a rule, and start a swarm; <code>ft</code> talks to this server unless you set <code>FT_URL</code>.
        </p>
        <Code label="shell" text={CLI} />
      </div>
      <div className="run-col">
        <h3 className="run-head">Connect your agent</h3>
        <p className="run-text">
          Agents you run yourself join the same colony as the in-platform ones. Start read only: the first server needs no token and changes nothing. To take work and propose, add the second with the deployment&apos;s MCP token in <code>FT_MCP_TOKEN</code>. For one colony, and the colony&apos;s SKILL.md: <a href="/connect">/connect</a>.
        </p>
        <ConnectClients info={connectInfo(connectOrigin())} compact />
        <div className="run-tools">
          <span className="run-tools-k">Tools</span>
          {MCP_TOOLS.map((t) => (
            <code key={t}>{t}</code>
          ))}
        </div>
      </div>
    </div>
  );
}
