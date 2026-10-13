import { useState } from "react";
import { readReviewer, readToken, saveReviewer, saveToken } from "../api.ts";

/**
 * Asks for this colony's admin token (and the reviewer's name) when the server refused a decision,
 * saves both in this browser, and retries the decision. `action` names the button: "Approve",
 * "Dismiss the report", ...
 */
export function TokenForm({ refused, action, onRetry, onCancel }: { refused: boolean; action: string; onRetry: () => void; onCancel: () => void }) {
  const [token, setToken] = useState(readToken);
  const [reviewer, setReviewer] = useState(readReviewer);
  return (
    <form
      className="token token-inline"
      onSubmit={(e) => {
        e.preventDefault();
        saveToken(token.trim());
        saveReviewer(reviewer.trim());
        onRetry();
      }}
    >
      <div className="token-note">{refused ? "The server refused that token. Paste this colony's admin token." : "Recording a decision needs this colony's admin token."}</div>
      <input type="password" placeholder="Admin token" aria-label="Admin token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" autoFocus />
      <input type="text" placeholder="Your name, recorded with the decision" aria-label="Your name" value={reviewer} onChange={(e) => setReviewer(e.target.value)} autoComplete="name" />
      <div className="token-actions">
        <button type="submit" className="btn btn-approve" disabled={!token.trim()}>
          {action} with this token
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
