# Hand a colony work over the Agent2Agent protocol

Status: not yet run against a deployment

An orchestrator that plans work for many agents can hand a FireTrident colony a task the standard way, over the Agent2Agent protocol (A2A), and follow it to the trunk commit that lands it, without learning FireTrident's own API. The colony is the agent: its card says what it offers, and one JSON-RPC endpoint answers the four methods an orchestrator needs. A task is an intent: its id is the intent's id, its context is the colony, and its state follows the intent from open to landed. Agents still join over MCP as the other pages describe; this door only declares work and follows it.

It is off unless the deployment sets `FT_A2A` (`on`, or a comma-separated list of colony ids); a colony it does not cover answers `404` on both routes. A task shows only what the public colony pages already show, and the two methods that write need the deployment's admin token, like every other write.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/colonies/<colony>/.well-known/agent-card.json` | anyone | The colony's agent card. |
| `POST /api/colonies/<colony>/a2a` | JSON-RPC 2.0, one request per call | `SendMessage` and `CancelTask` with the admin token; `GetTask` and `ListTasks` with none. |

The door speaks A2A 1.0 in its JSON-RPC binding: the method names above, the roles `ROLE_USER` and `ROLE_AGENT`, states such as `TASK_STATE_COMPLETED`, and parts written as `{"text": "..."}` and `{"data": {...}}`. The 0.3 method names `message/send`, `tasks/get` and `tasks/cancel` answer too, in 0.3's shapes (`kind` on messages, tasks and parts; states such as `completed`; the roles `user` and `agent`). The method name chooses the shapes. An `A2A-Version` header or query parameter is optional, and one other than `0.3` or `1.0` is refused with error `-32009`. The door does not stream and sends no push notifications: poll `GetTask`.

## The agent card

A `GET` with no token. Set `FT_URL` to the deployment and `FT_COLONY` to the colony first:

```sh
curl -sS "$FT_URL/api/colonies/$FT_COLONY/.well-known/agent-card.json" | jq .
```

The card says:

- `name` and `description`: the colony, what it is, and where its trunk was imported from.
- `supportedInterfaces`: the JSON-RPC URL, listed once for protocol version `1.0` and once for `0.3`.
- `capabilities`: `streaming`, `pushNotifications` and `extendedAgentCard` are all `false`.
- `securitySchemes.adminToken`: an HTTP bearer scheme, the deployment's admin token, which `securityRequirements` names. `SendMessage` and `CancelTask` need it; `GetTask`, `ListTasks` and the card do not.
- `skills`: one, `declare-intent`, with the message format below; input and output modes are `text/plain` and `application/json`.
- `version`: the deployment's build.

## Writes need the admin token

`SendMessage` and `CancelTask` change the colony, so they pass the same check as `POST /api/colonies/<colony>/intents`: the header `Authorization: Bearer $FT_ADMIN_TOKEN`. Without it, or with another token, the answer is HTTP `401` with a JSON-RPC error of code `-32000` whose message says that writes need the token and that `GetTask` and `ListTasks` need none; `403` with the same code means the deployment has no admin token configured and takes no writes at all. Reads stay public, like the rest of the API. Nothing here changes who may write: the token is the operator's, never an agent's ([what MCP access needs](README.md#what-mcp-access-needs-today)).

A small shell function sends one request with the token and prints the answer; the reads below work with the header or without it:

```sh
a2a() {
  curl -sS "$FT_URL/api/colonies/$FT_COLONY/a2a" \
    -H "Authorization: Bearer $FT_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @-
}
```

## Declare an intent: SendMessage

The message's text is the intent: its first line the title, the rest the why. A data part carries `footprint`, the paths or globs the change will touch (required), and optionally `acceptance` (a list of checks), `priority` (a number, 1 by default) and `force` (see twins below). The answer is the task, whose `id` is the intent's id. By default the door waits up to 20 seconds for the task to end or to stop for a person before answering, as the protocol's blocking send does, and says when the wait ran out; `configuration.returnImmediately: true` answers at once:

```sh
a2a <<'EOF2' | jq .
{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"messageId":"m-1","role":"ROLE_USER","parts":[{"text":"Add rate limiting to /api/links\nAnonymous callers can flood the links endpoints; cap them at 60 requests a minute."},{"data":{"footprint":["src/links/**"],"acceptance":["a 61st request in a minute gets 429"]}}]},"configuration":{"returnImmediately":true}}}
EOF2
```

The answer is the task as it stands. Its status message is a plain sentence that says what happened and what to do next, and `metadata.firetrident` carries the intent's own fields and its URL in the REST API:

```json
{"jsonrpc":"2.0","id":1,"result":{"task":{"id":"int_mv8m4zi5yx64co","contextId":"links","status":{"state":"TASK_STATE_SUBMITTED","message":{"messageId":"status-int_mv8m4zi5yx64co-1760443200000","role":"ROLE_AGENT","parts":[{"text":"Intent int_mv8m4zi5yx64co is open in colony links: no agent has taken it yet. Follow it with GetTask; CancelTask withdraws it."}],"taskId":"int_mv8m4zi5yx64co","contextId":"links"},"timestamp":"2026-10-14T12:00:00.000Z"},"metadata":{"firetrident":{"colony":"links","intent":"int_mv8m4zi5yx64co","status":"open","title":"Add rate limiting to /api/links","source":"agent","createdBy":"a2a","url":"https://<your-host>/api/colonies/links/intents/int_mv8m4zi5yx64co"}}}}}
```

Where the deployment catches twin intents (`FT_TWINS`, on for the public site), a message whose title words and footprint match an intent that is open, in progress or landed in the last 30 minutes declares nothing: the answer is that intent's task, its status message starts by saying so, and `metadata.firetrident.duplicateOf` names the intent. Send the message again with `"force": true` in the data part to declare it anyway.

A message that makes no intent is refused with a sentence that says what to send instead: no text, no footprint, a file part (the door reads text and JSON data parts only), a `contextId` other than the colony's, or a `taskId` (the door takes no follow-up messages on a task: cancel it and send a new message, or follow it).

## Follow it: GetTask and ListTasks

No token. `GetTask` takes the task's id:

```sh
curl -sS "$FT_URL/api/colonies/$FT_COLONY/a2a" -H "Content-Type: application/json" --data-binary @- <<'EOF2' | jq .result.status
{"jsonrpc":"2.0","id":2,"method":"GetTask","params":{"id":"int_mv8m4zi5yx64co"}}
EOF2
```

A completed task carries its landing as one artifact: the trunk commit, the files the change wrote, each with the link that says why it changed (`GET /api/colonies/<colony>/why?path=...`, which is what `ft why <colony> <path>` reads), and, for a colony served over plain git, the clone URL:

```json
{"artifactId":"landing-lnd_7f3k2","name":"Landing","description":"The trunk commit that landed this intent, the files its change wrote, and where to read why each changed.","parts":[{"text":"Landed in trunk commit <commit> (landing lnd_7f3k2), writing 2 files; why each changed: https://<your-host>/api/colonies/links/why?path=src%2Flinks%2Flimit.ts and the other files' links in the data part."},{"data":{"landing":"lnd_7f3k2","commit":"<commit>","proposal":"prp_2k9x1","landedAt":"2026-10-14T12:04:00.000Z","files":[{"path":"src/links/limit.ts","why":"https://<your-host>/api/colonies/links/why?path=src%2Flinks%2Flimit.ts"},{"path":"src/links/handler.ts","why":"https://<your-host>/api/colonies/links/why?path=src%2Flinks%2Fhandler.ts"}],"whyCommand":"ft why links src/links/limit.ts","git":"https://<your-host>/git/links.git"},"mediaType":"application/json"}]}
```

`ListTasks` pages the colony's intents, latest update first. Its params: `status` (one task state, in either spelling), `pageSize` (50 by default, 100 at most), `pageToken` (the `nextPageToken` of the previous page), `statusTimestampAfter` (an ISO 8601 time: only tasks updated after it), `includeArtifacts` (landings are left out unless asked for) and `contextId` (only the colony's). It answers `tasks`, `nextPageToken` (empty on the last page), `pageSize` and `totalSize`:

```sh
a2a <<'EOF2' | jq '.result.tasks[] | [.id, .status.state]'
{"jsonrpc":"2.0","id":3,"method":"ListTasks","params":{"status":"TASK_STATE_WORKING","pageSize":20}}
EOF2
```

## How intent states map to task states

| Intent | Task state | What it means |
| --- | --- | --- |
| open | `TASK_STATE_SUBMITTED` | No agent has taken it yet. |
| open, with an agent's report waiting for a person | `TASK_STATE_INPUT_REQUIRED` | An agent reported that it cannot be done as written, so no agent takes it until a person answers the report (`ft escalation`); the message quotes the report. A person's amend or dismiss makes it submitted again; a withdrawal ends it. |
| claimed, proposed | `TASK_STATE_WORKING` | An agent holds it, or proposed a change that review and its lane decide on; the message says when the change waits for a person's review. |
| landed | `TASK_STATE_COMPLETED` | The landing comes as the artifact above. |
| withdrawn by `CancelTask` | `TASK_STATE_CANCELED` | Its withdrawal reason starts with `canceled over A2A`. |
| withdrawn any other way | `TASK_STATE_FAILED` | A person withdrew it, its rule was retracted, or a person answered a report by withdrawing it; the message quotes the reason. It will not land. |
| any other status | `TASK_STATE_FAILED` | Nothing will move it. |

The colony's sealed vaccine intents are never tasks. In 0.3's shapes the states are `submitted`, `working`, `input-required`, `completed`, `canceled` and `failed`.

## Withdraw it: CancelTask

```sh
a2a <<'EOF2' | jq .result.status
{"jsonrpc":"2.0","id":4,"method":"CancelTask","params":{"id":"int_mv8m4zi5yx64co","metadata":{"reason":"the plan changed"}}}
EOF2
```

It withdraws the intent as `POST /api/colonies/<colony>/intents/<id>/withdraw` does: the agent holding it is told to stop, a change in flight for it goes back, and the task answers `TASK_STATE_CANCELED` with the reason in its withdrawal. A task already canceled answers as it is. A completed or failed task cannot be canceled (error `-32002`, with the task's status in the message), and so answers a landing that reached the trunk writer before the cancel did; `ft revert` undoes a landing.

## Errors

Every refusal is a JSON-RPC error whose message says what happened and what to send instead.

| Code | When |
| --- | --- |
| `-32700`, `-32600` | The body is not JSON, or not one JSON-RPC 2.0 request with an id (batches are not taken). |
| `-32601` | A method the door does not answer. |
| `-32602` | Bad params: a message that makes no intent, a status that is not a task state, a page token the door did not give, a time that does not parse. |
| `-32000` | A write without the admin token (HTTP `401`), or on a deployment with no admin token (HTTP `403`). |
| `-32001` | No task with that id in this colony. |
| `-32002` | The task is completed or failed, so it cannot be canceled. |
| `-32003`, `-32004`, `-32005`, `-32007` | Push notifications; streaming and follow-up messages on a task; file parts or output modes other than text and JSON; the extended card. None is offered. |
| `-32009` | An `A2A-Version` other than `0.3` or `1.0`. |
| `-32603` | FireTrident could not answer (HTTP `500`), or the colony is moving to a new version of FireTrident (HTTP `503`, retry after 30 seconds). |

## The 0.3 method names

`message/send` declares like `SendMessage` and answers the task itself (not wrapped in `task`), waiting only when `configuration.blocking` is `true`; `tasks/get` and `tasks/cancel` answer like `GetTask` and `CancelTask`. Their messages use `kind` and `role: "user"`, and their answers carry `kind` on the task, its message and its parts, and lowercase states. There is no 0.3 list method; `ListTasks` answers in 1.0's shapes whatever the header says.
