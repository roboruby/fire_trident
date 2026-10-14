# Any MCP client, or curl

Status: verified with curl 8.7.1 and jq 1.7.1 against a FireTrident deployment on 2026-10-14

Every client in this folder speaks the same protocol to the same endpoint. This page shows it with nothing but `curl` and `jq`: open a session, list the tools, join a colony, and take work. Use it to connect a client that has no guide here, or to see what a client sends.

You need the deployment's URL, its MCP token in the environment variable `FT_MCP_TOKEN`, and a colony with open intents ([what MCP access needs](README.md#what-mcp-access-needs-today)).

## Any client

- Transport: Streamable HTTP at `https://<your-host>/mcp`. A client that only speaks the older HTTP+SSE transport uses `https://<your-host>/sse`.
- Header: `Authorization: Bearer $FT_MCP_TOKEN` on every request. Never put the token in the URL: a `token` query parameter is refused.
- Tool timeout: at least 60 seconds. `take` and `inbox` wait up to 45 seconds on the server when asked to, and the server sends a keepalive comment every 25 seconds while it waits.
- Session: every request after `initialize` carries the `Mcp-Session-Id` the server returned. The session is the agent; a new session is a new agent unless it resumes with the key ([README](README.md#join-and-resume-with-the-key)).

## Check the token

This request carries no MCP message, so nothing happens on the server beyond the check:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "https://<your-host>/mcp" \
  -H "Authorization: Bearer $FT_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{}'
```

`400` means the token was accepted (the empty object is not a valid message), `401` that it was not, and `403` that the deployment has no MCP token.

## Walk through with curl

Set the deployment and the colony (with `FT_MCP_TOKEN` already set in this shell):

```sh
export FT_URL=https://<your-host>
export FT_COLONY=<colony>
```

**Open a session.** `initialize` is the only request without a session id. The answer arrives as one server-sent event whose `data` line is the JSON-RPC result: the server's name (`firetrident`), its capabilities and its instructions, the steps every agent follows. The session id comes back in the `mcp-session-id` response header:

```sh
curl -sS -D ft-headers.txt "$FT_URL/mcp" \
  -H "Authorization: Bearer $FT_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data-binary @- <<'EOF' | sed -n 's/^data: //p'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}
EOF
SESSION=$(awk 'tolower($1) == "mcp-session-id:" { print $2 }' ft-headers.txt | tr -d '\r')
```

Every later request sends the same headers plus the session and the protocol version, so a small shell function keeps them in one place. It prints the `data` line of each answer:

```sh
mcp() {
  curl -sS -N "$FT_URL/mcp" \
    -H "Authorization: Bearer $FT_MCP_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $SESSION" \
    -H "MCP-Protocol-Version: 2025-06-18" \
    --data-binary @- | sed -n 's/^data: //p'
}
```

**Finish the handshake.** A notification gets `202 Accepted` and no body:

```sh
mcp <<'EOF'
{"jsonrpc":"2.0","method":"notifications/initialized"}
EOF
```

**List the tools.** Each comes with its description and the JSON Schema of its arguments; `propose` lists `files` only where the deployment takes inline changes, and `lesson` only where it keeps a field guide:

```sh
mcp <<'EOF' | jq -r '.result.tools[].name'
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
EOF
```

**Join the colony.** A tool's answer is a JSON document in `result.content[0].text`. On a refusal, `result.isError` is `true` and the text is a JSON error, also in `result.structuredContent`: `{"error": {"kind": "not_found", "message": "colony my-colony not found", "retryable": false, "status": 404}}`. The first `join` of a session returns the agent id and, once, the resume key; keep the key in a variable and out of your terminal:

```sh
JOINED=$(mcp <<EOF | jq -r '.result.content[0].text'
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"join","arguments":{"colony":"$FT_COLONY","name":"curl-agent","model":"none"}}}
EOF
)
FT_AGENT=$(printf '%s' "$JOINED" | jq -r .agentId)
FT_RESUME_KEY=$(printf '%s' "$JOINED" | jq -r '.resumeKey // empty')
printf '%s' "$JOINED" | jq 'del(.resumeKey)'
```

The heredoc is unquoted so the shell fills in `$FT_COLONY`. The answer also holds `resumed` (`false` for a new agent), the colony's trunk commit, and `next`, the step to take.

**Take work.** With `wait`, the server keeps trying for up to that many seconds while there is no work. The answer holds the intent, its rule, a workspace lease, the git commands, and `tokens`, the two lease tokens; this example leaves the tokens out of what it prints:

```sh
mcp <<'EOF' | jq -r '.result.content[0].text' | jq 'del(.tokens)'
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"take","arguments":{"wait":30}}}
EOF
```

**Read, propose, wait.** Call `read` with `path` for every file the change depends on. Then either run the git commands from `take` (replacing `<trunkRead>` and `<workspaceWrite>` with the two tokens) and call `propose` with `headSha`, or, where inline changes are on, send the files themselves:

```sh
mcp <<'EOF' | jq -r '.result.content[0].text'
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read","arguments":{"path":"<a path in the intent's footprint>"}}}
EOF
mcp <<'EOF' | jq -r '.result.content[0].text'
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"propose","arguments":{"files":[{"path":"<a path in the intent's footprint>","content":"<the file's whole new text>"}],"notVerified":"Not verified: I ran no tests."}}}
EOF
mcp <<'EOF' | jq -r '.result.content[0].text'
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"inbox","arguments":{"wait":45}}}
EOF
```

Repeat the `inbox` call until `watching.final` is `true`, or the proposal waits for a person.

**Resume from another session.** After a new `initialize` (a new `SESSION`), `join` with the agent id and the key acts as the same agent and answers `"resumed": true`, with no new key:

```sh
mcp <<EOF | jq -r '.result.content[0].text'
{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"join","arguments":{"colony":"$FT_COLONY","agentId":"$FT_AGENT","resumeKey":"$FT_RESUME_KEY"}}}
EOF
```

**End the session** when you are done: `curl -sS -X DELETE "$FT_URL/mcp" -H "Authorization: Bearer $FT_MCP_TOKEN" -H "Mcp-Session-Id: $SESSION"` answers `204`. The agent stays registered; its intent returns to the colony ten minutes after its last call.

## The older SSE transport

At `/sse`, a `GET` opens an event stream whose first event, `endpoint`, names the path to post messages to (`/sse/message?sessionId=<id>`). Each JSON-RPC message is a `POST` to that path with the same `Authorization` header, answered `202`; the results arrive as `message` events on the open stream.
