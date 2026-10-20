# FireTrident spike: Artifacts, git in a Durable Object, push triggers, Clef

Measured 2026-10-12 between 04:46 and 04:56 UTC against the live service. Worker `ft-spike` (`https://ft-spike.mattsolt.workers.dev`, which no longer answers), namespaces `ft-spike-a` and `ft-spike-b`. Requests from the DO to Artifacts went through IAD (from `cf-ray`). Raw JSON for every number below is in `spike/results/`.

## Methodology

- **Worker** (`spike/src/index.ts`, `spike/wrangler.jsonc`): compatibility date 2026-10-11 with `nodejs_compat`. It has Artifacts bindings `A` (`ft-spike-a`) and `B` (`ft-spike-b`), Workers AI `AI`, and a SQLite-backed DO `SpikeDO` that owns a `@cloudflare/computer` `Workspace` with `createGitClient()`. A Workflow `SpikePushWorkflow` is started by a `triggers.events` entry for `cf.artifacts.repo.pushed` filtered to namespace `ft-spike-b`, and it records each event into the DO. Every route requires an `x-spike-key` header. The key lives only in `spike/.dev.vars` (gitignored) and in the Worker secret `SPIKE_KEY`.
- **Same filesystem for both git layers.** `createGitClient({ adapter })` gets an isomorphic-git fs built over `workspace.provider()`. It mirrors the package's own `@platformatic/vfs` glue, so `ws.git.clone/commit/push` and raw isomorphic-git (`writeBlob/writeTree/writeCommit/addNote/push`) operate on one fs object. `@platformatic/vfs` is an optional peer of `@cloudflare/computer/git` and is not installed by default, so it was added to `spike/package.json` (0.4.1).
- **Driver** (`spike/scripts/spike.rb`, Ruby). Parallel fan-out sends one HTTP request per fork, so each fork runs in its own Worker invocation and the per-invocation connection limit cannot queue the forks being measured. Server-side timings come from `Date.now()` around each awaited call. Client walls come from a monotonic clock on a laptop. The laptop-to-DO round trip (`/do/ping`) was 103 to 238 ms.
- **Ready detection.** After `fork()`/`import()`/`create()` returns, the route polls `get()` and then `log({limit:1})` with backoff starting at 100 ms. A repo is ready once a commit is readable. `create()` uses `info()` instead, because a new repo has no commits.
- **Clock caveat.** Workers clocks advance only at I/O boundaries. DO-side timings for purely local work (SQLite VFS) are therefore lower bounds. Compare them with the client wall minus the DO ping.
- **Stale-writer simulation.** isomorphic-git checks fast-forward on the client and takes the old oid from a fresh ref advertisement. To send a genuinely stale old oid, the DO captured `info/refs?service=git-receive-pack` while `main` was C0. Writer 1 then pushed C1, and writer 2 pushed C2 (parent C0) through an http shim that replays the stale advertisement. That push carries the command `C0 C2 refs/heads/main`.
- **Budget used.** 51 fork calls (49 succeeded), 1 import, 3 creates, and 51 deletes. About 520 binding (control-plane) calls, of which 403 are recorded in the results files, plus about 80 git smart-HTTP requests.
- **Test repo.** `sindresorhus/is-plain-obj`: 13 top-level entries, `main` at `666df7c1`.

## 1. Import

| Call | Result |
|---|---|
| `A.import({source:{url}, target:{name:"base"}})` | returned in **2,396 ms**, already `ready` (first poll at 2,437 ms) |

`import()` is synchronous through the binding. No `IMPORT_IN_PROGRESS` was observed.

## 2. Forks

All forks below were readable on the first poll after `fork()` returned (`polls = 1` for 49/49 successes), so **`fork()` is synchronous**. `getMs` (the `get()` before `fork()`) has a p50 of 28 ms.

| Scenario | n | ok | `fork()` call ms p50 / p95 / max | ready ms p50 / max | round wall |
|---|---|---|---|---|---|
| Sequential from `base` | 8 | 8 | 1,297 / 2,191 / 2,191 | 1,480 / 2,284 | 14.6 s total |
| Burst: 8 parallel from `base` | 8 | 8 | 1,336 / 2,754 / 2,754 | 1,400 / 2,862 | **3.1 s** |
| Tree round 1 (1 source) | 1 | 1 | 1,386 | 1,462 | 1.6 s |
| Tree round 2 (2 sources) | 2 | 2 | 1,340 / 1,917 | 1,414 / 1,980 | 2.1 s |
| Tree round 3 (4 sources) | 4 | 4 | 1,149 / 1,723 | 1,241 / 1,807 | 1.9 s |
| Tree round 4 (8 sources) | 8 | 8 | 1,540 / 1,758 | 1,796 / 1,956 | **2.1 s** |
| All 31 forks of never-pushed sources | 31 | 31 | 1,344 / 2,191 / 2,754 | 1,462 / 2,862 | |
| 4 parallel from `work-1`, issued about 0.1 s after a push to it | 4 | **3** | 1,594 / 2,122 | | 2.3 s |
| 6 parallel from `work-1`, issued about 0.1 s after a push to it | 6 | **5** | 1,677 / 2,026 | | 2.4 s |
| Control: 4 parallel from `work-1`, about 18 s after its last push | 4 | 4 | 1,253 / 1,837 | | 2.1 s |

- **Do forks of different sources run in parallel? Yes.** Tree round wall time stayed at 1.6 to 2.1 s from 1 to 8 parallel sources (16 repos after round 4, 15 forks, 0 failures). Forks of a repo that had itself just been forked worked immediately.
- **Do forks of the same source serialize? No, not at 8-wide.** In the 8-burst from `base`, 7 of 8 finished in 1.26 to 1.34 s and the slowest in 2.75 s. Throughput was about 2.5 forks/s, not 0.8/s.
- **Burst forks from one source fail? No** (0/8).
- **Parallel forks right after a push fail? Sometimes:** 2 of 10 returned `ArtifactsError INTERNAL_ERROR (10400) "An internal error occurred."` after about 2 s. The control run 18 s later had 0/4 failures, and never-pushed sources had 0/31. A failed fork leaves **no repo behind** (`list()` showed no `pp-1` or `ppb-3`), so retrying with the same name is safe. The exact settle time lies somewhere between 0.1 s and 18 s and was not narrowed down.
- **Refs copied by `fork()`:** `ls-remote` of a fork of `trunk` (which had `main`, `feature-x`, and `refs/notes/firetrident`) showed **all four refs including `refs/notes/firetrident`**. `fork(name, { defaultBranchOnly: true })` produced the **identical ref set**, so the option is ignored.
- Deletes: 51/51 succeeded, sequential `delete()` p50 **1,024 ms**, max 1,469 ms. `create()` of an empty repo took 1,311 to 1,722 ms and was synchronous.

## 3. Git in `SpikeDO` (`@cloudflare/computer` + isomorphic-git on the same fs)

| Step | DO-side ms | client wall ms | Result |
|---|---|---|---|
| `ws.git.clone` of fork `work-1` (write token, Bearer header) | **348** | 713 | 13 entries checked out |
| `ws.fs.writeFile` + `ws.git.add` + `ws.git.commit` | 0 + **91** | 395 | `87506c28` |
| `ws.git.push` `main` to `work-1` | **337** | 554 | `{ok:true}` |
| Tree surgery, no working copy: `readCommit` → `writeBlob` → `readTree`/`writeTree` → `writeCommit` → `writeRef` | **36** | 200 | `a24b5d6c` replaces `readme.md` on base `666df7c1` |
| isomorphic-git push of `refs/heads/surgery` to `trunk:refs/heads/main` (fast-forward) | **254** | 477 | `{ok:true}`, thin pack |
| `git.addNote` under `refs/notes/firetrident` (+ `readNote`) | **38** | 190 | note commit `fc7c9832` |
| Push `refs/notes/firetrident` to `trunk` | **138** | 337 | `{ok:true}` |
| Push `main` to `trunk:refs/heads/feature-x` (non-default branch) | 178 | 512 | `{ok:true}` |
| isomorphic-git `init` + `fetch` (no checkout) of a fork | 230–247 | 489–556 | |
| Real git clone of `trunk` from the laptop | | 591 | |

**Note readable with real git: yes.** After `git -c http.extraHeader="Authorization: Bearer <read token>" clone`, `git fetch origin 'refs/notes/*:refs/notes/*'`, and `git log --notes=firetrident -1`:

```
commit a24b5d6c5a597f7fd49c237afd08272c4bca771b
Author: ft-spike <spike@firetrident.invalid>
    trunk: replace readme.md via tree surgery

Notes (firetrident):
    {"ft":1,"decision":"merged","by":"spike","at":"2026-10-12T04:49:02Z"}
```

**Two writers and forced pushes** (repo `race-1`, C0 = `666df7c1`):

| Test | Command sent | Outcome |
|---|---|---|
| Writer 1, fast-forward | `C0 → C1` | accepted, 192 ms |
| Writer 2 with a **stale old oid** (replayed advertisement) | `C0 → C2` while main = C1 | **rejected server-side**: `ng refs/heads/main stale ref` (105 ms). `main` stayed C1 |
| Writer 2, fresh advertisement, no force | (none sent) | rejected **client-side** by isomorphic-git: `PushRejectedError not-fast-forward` (49 ms) |
| Writer 2, **force**, non-fast-forward | `C1 → C3` (C3's parent is C0) | **accepted** (222 ms). `main` is now C3 and C1 is gone from `main` |
| Write token push to a fork created with `readOnly: true` | `C0 → C1` | **accepted** (188 ms). `info().readOnly` is still `true` and `main` = C1 |
| Real git `push --atomic` (2 refs) | | `fatal: the receiving end does not support --atomic push` |
| Real git `push -o ft.test=1` | | `fatal: the receiving end does not support push options` |
| Real git multi-ref push (non-atomic), then `push --delete` | | both accepted |

Advertised receive-pack capabilities: `report-status delete-refs ofs-delta side-band-64k symref=HEAD:refs/heads/main`. There is no `atomic`, no `push-options`, and no `no-thin` (so thin packs are accepted).

## 4. Namespace push trigger → Workflow

One `triggers.events` entry (`{"type":"cf.artifacts.repo.pushed","filter":{"namespace":"ft-spike-b"},"targets":[{"type":"workflow","workflow_name":"ft-spike-push"}]}`) was deployed, and wrangler printed `event triggers: 1`. Three repos (`trig-1..3`) were created in `ft-spike-b` **after** the deploy, with no per-repo subscription. The DO pushed 5 commits to them, 4.6 to 5.2 s apart.

| # | repo | push ms | push end → instance created | push end → `run()` start | created → started |
|---|---|---|---|---|---|
| 1 | trig-1 | 725 | 1,532 | 4,419 | 2,887 |
| 2 | trig-2 | 201 | 1,143 | 2,311 | 1,168 |
| 3 | trig-3 | 229 | 455 | 3,349 | 2,894 |
| 4 | trig-1 | 203 | 534 | 1,131 | 597 |
| 5 | trig-2 | 184 | 363 | 1,145 | 782 |
| **p50 / max** | | 203 / 725 | **534 / 1,532** | **2,311 / 4,419** | 1,168 / 2,894 |

- **Fires for every repo in the namespace without per-repo subscriptions: yes** (5/5, 3 repos).
- The filter holds: the 10 accepted pushes to `ft-spike-a` (sections 2 and 3), plus 3 rejected or refused ones, produced **0** Workflow instances. The events table held exactly the 5 `ft-spike-b` events.
- "Instance created" is `WorkflowEvent.timestamp` and "run() start" is `Date.now()` on entry to `run()`, both on Cloudflare clocks. "Push end" is when the DO received the receive-pack response.
- The event delivered to the Workflow has **no `metadata` block**, so there is no `eventTimestamp`, and **`instanceId` equals the event `id`**. The shape is shown below.

## 5. Binding read APIs (repo `base`, 10 sequential calls each, same colo)

| Call | p50 ms | p95/max ms | min ms |
|---|---|---|---|
| `get(name)` | 19 | 211 | 15 |
| `info()` | 12 | 17 | 11 |
| `log({ref:"main", limit:10})` | 14 | 55 | 12 |
| `readCommit(hash)` | 13 | 15 | 11 |
| `readTree(hash)` | 13 | 19 | 11 |
| `readBlob(hash)` | 14 | 19 | 13 |
| `readFile({ref:"main", path})` | 15 | 19 | 12 |
| `createToken("read", 600)` | **49** | 214 | 44 |
| `list({limit:20})` (n=5) | 21 | 218 | 18 |

Three calls took about 200 ms (the first `createToken`, the first `list`, and the fifth `get`). Every other call ran at 11 to 20 ms, except `createToken` at 44 to 51 ms.

**Ref resolution** (`spike/results/5b-refprobe.json`) applies to both `readFile` and `log`:

| ref passed | resolves? |
|---|---|
| `main`, `feature-x` (short branch name) | yes |
| full 40-hex commit oid (including a notes commit) | yes |
| *(omitted)* in `log()` | yes (defaults to the default branch) |
| `HEAD`, `refs/heads/main`, `heads/main`, `refs/notes/firetrident`, `notes/firetrident`, abbreviated oid `a24b5d6` | **no**: `readFile` returns `null` and `log` returns `[]`, with no error |

A note is readable through the binding as `readFile({ ref: <notes commit oid>, path: <annotated commit oid> })`. The binding cannot resolve the notes ref to that oid, so the tip must come from elsewhere: TrunkDO state or git `ls-refs`. **`info().lastPushAt` stayed `null` and `updatedAt` stayed unchanged after every git push** (checked on `trunk`, `work-1`, `race-1`, and `ro-1`).

## 6. Clef (Workers AI), 10 sequential calls each, 553 input tokens

| Model | p50 ms | p95 ms | min / max ms | raw ms |
|---|---|---|---|---|
| `@cf/cloudflare/clef` | **169** | 493 | 117 / 493 | 493, 169, 253, 129, 121, 120, 225, 117, 237, 176 |
| `@cf/cloudflare/clef-flash` | **190** | 275 | 179 / 275 | 275, 190, 179, 195, 191, 193, 181, 264, 182, 181 |

Both models were **deterministic**, giving identical answers on all 10 calls. They **disagreed with each other** on this diff: `clef` answered safe 0.58, `refactor`, risk 1.08, while `clef-flash` answered safe 0.46, `bugfix`, risk 1.45. Confidence was low in both (0.10 to 0.22). At this input size `clef-flash` was not faster.

Request:

```js
env.AI.run("@cf/cloudflare/clef", {
  model: "clef",
  state: { path: "index.js", description: "...", diff: "--- a/index.js\n+++ b/index.js\n..." },
  questions: {
    safe: { type: "noul", instructions: "Is this diff safe to merge into trunk without a human review?",
            criteria: { true: "Safe to merge automatically", false: "Needs a human review" } },
    kind: { type: "choice", instructions: "What kind of change is this diff?",
            criteria: { bugfix: "...", feature: "...", refactor: "...", docs: "..." } },
    risk: { type: "score", instructions: "How risky is this diff for existing callers?",
            criteria: ["trivial", "low", "medium", "high", "critical"] },
  },
});
```

Response (`clef`, verbatim):

```json
{
  "model": "clef",
  "answers": {
    "safe": { "type": "noul", "noul": 0.5817 },
    "kind": { "type": "choice", "choice": "refactor",
              "probabilities": { "bugfix": 0.2107, "feature": 0.2303, "refactor": 0.5401, "docs": 0.0189 },
              "confidence": 0.186 },
    "risk": { "type": "score", "score": 1.0809,
              "legend": { "0": "trivial", "1": "low", "2": "medium", "3": "high", "4": "critical" },
              "probabilities": { "0": 0.3645, "1": 0.3481, "2": 0.1694, "3": 0.0779, "4": 0.0401 },
              "confidence": 0.113 }
  },
  "usage": { "input_tokens": 553, "output_tokens": 0 }
}
```

## Response shapes (trimmed, tokens redacted)

`import()` / `fork()` / `create()` return `ArtifactsCreateRepoResult`:
```json
{ "id": "uo571z3oa1y1uuoi", "name": "base", "description": null, "defaultBranch": "main",
  "remote": "https://<account>.artifacts.cloudflare.net/git/ft-spike-a/base.git", "token": "<redacted>" }
```

`repo.info()`:
```json
{ "id": "wyh8xggbfk9k011o", "name": "trunk", "description": "fork of base", "defaultBranch": "main",
  "createdAt": "2026-10-12T04:48:56.181Z", "updatedAt": "2026-10-12T04:48:56.886Z", "lastPushAt": null,
  "source": "artifacts:ft-spike-a/base", "readOnly": false, "remote": "https://<account>.artifacts.cloudflare.net/git/ft-spike-a/trunk.git" }
```
`source` is `git:<url>` for imports and `artifacts:<ns>/<repo>` for forks.

`list()` returns `{ repos, total, cursor }`. Each repo also carries `status` and `jurisdiction`, and carries `remote` despite the type omitting it:
```json
{ "id": "3de0xflvmtmjbwp5", "name": "ro-1", "description": "fork of base", "defaultBranch": "main",
  "createdAt": "...", "updatedAt": "...", "lastPushAt": null, "source": "artifacts:ft-spike-a/base",
  "readOnly": true, "status": "ready", "jurisdiction": "unrestricted", "remote": "https://..." }
```

`log()[0]` and `readCommit()` (times in unix seconds):
```json
{ "hash": "666df7c1…", "treeHash": "5d176b98…", "message": "Meta tweaks",
  "author": { "name": "Sindre Sorhus", "email": "…" }, "committer": { "name": "…", "email": "…" },
  "parents": ["97f38e88…"], "authoredAt": 1789758565, "committedAt": 1789759571 }
```

`readTree()` returns immediate children only. Note that the tree mode is `"40000"`, not `"040000"`:
```json
[ { "name": ".editorconfig", "mode": "100644", "hash": "1c6314a3…", "type": "blob" },
  { "name": ".github", "mode": "40000", "hash": "7d2a21da…", "type": "tree" } ]
```

`readBlob()` returns a `Blob` with `type: ""`. `readFile()` returns a `Blob` with `type: "text/plain;charset=utf-8"`.

`createToken()`:
```json
{ "id": "oayneb124ephb0ax", "plaintext": "<redacted: art_v1_<40 hex>?expires=<unix>>", "scope": "read", "expiresAt": "2026-10-12T05:01:57.614Z" }
```

Binding error (post-push fork):
```json
{ "name": "ArtifactsError", "code": "INTERNAL_ERROR", "numericCode": 10400, "message": "An internal error occurred." }
```

isomorphic-git `push()` result, and the stale-ref rejection (`GitPushError.data`):
```json
{ "ok": true, "refs": { "refs/heads/main": { "ok": true, "error": "" } } }
{ "prettyDetails": "\n  - refs/heads/main: stale ref",
  "result": { "ok": true, "refs": { "refs/heads/main": { "ok": false, "error": "stale ref" } } } }
```

Workflow `event.payload` for `cf.artifacts.repo.pushed` (`event.instanceId` = `id`):
```json
{ "id": "e49d6a98-cba4-4ad4-a6cc-dad55f701d4a", "type": "cf.artifacts.repo.pushed",
  "source": { "namespace": "ft-spike-b", "repoName": "trig-1" },
  "payload": { "ref": "refs/heads/main", "before": "0000000000000000000000000000000000000000",
    "after": "4665c8a26f45820b9304e9bade07a348c5a4eaf1",
    "commits": [ { "id": "4665c8a2…", "message": "trigger s1", "messageTruncated": false,
      "timestamp": "2026-10-12T04:50:57.000Z", "author": { "name": "ft-spike", "email": "…" },
      "committer": { "name": "ft-spike", "email": "…" }, "parents": [] } ],
    "totalCommitsCount": 1, "commitsTruncated": false } }
```

## Conclusions: design facts for FireTrident

1. **`fork()`, `import()`, and `create()` are synchronous through the binding.** The repo is ready when the promise resolves. Fork p50 is 1.34 s, p95 2.19 s, and max 2.75 s for a small repo. No `*_IN_PROGRESS` poll loop is needed on the happy path.
2. **Forks parallelize across sources and within one source, at least 8-wide.** Eight parallel forks finish in about the time of one (2.1 s round wall at 8 sources, 3.1 s for 8 from one source). PoolDO does not need fork trees for parallelism at this scale: forking straight from trunk is fine. Fork trees remain useful only to avoid forking a repo that was just pushed (fact 3).
3. **Forks issued immediately after a push to the source fail about 20% of the time** (2/10) with `INTERNAL_ERROR` (10400) after about 2 s, and leave no repo behind. Every fork call needs a retry with backoff on `INTERNAL_ERROR`, reusing the same name. Because TrunkDO pushes trunk on every lane tick, pool refills should fork from a quiescent source (an existing fork or a snapshot) or wait out a settle delay after a landing. 18 s was clean; the true threshold was not measured.
4. **`fork()` copies every ref, including `refs/notes/*`. `defaultBranchOnly: true` is ignored.** Workspaces inherit trunk's full lineage notes and any extra branches. Keep trunk's ref set minimal, because every fork pays for it.
5. **The server enforces compare-and-swap on the old oid.** A push with a stale old value is rejected per ref with `stale ref`. TrunkDO's planned expected-old-value push works as written, and the loser of a race learns it from `refs[ref].ok === false` (`error: "stale ref"`).
6. **The server does not enforce fast-forward.** A forced non-fast-forward push was accepted and dropped a commit from `main`. Fast-forward safety exists only in the pushing client. Trunk write tokens must stay inside TrunkDO (already the design), and TrunkDO should only push commits whose parent is the advertised tip.
7. **`readOnly: true` does not block write-token pushes.** It is metadata, not access control, so token scope is the only enforcement. Mint `read` tokens wherever writes are not intended.
8. **There are no atomic multi-ref pushes and no push options.** `--atomic` and `-o` are refused, while plain multi-ref pushes and deletes work. A landing is two independent ref updates: trunk first, then `refs/notes/firetrident`. TrunkDO must journal the landing and re-push a missing note. The `FT-*` trailers in the commit are the only lineage that is atomic with the code.
9. **Tree surgery without a working copy is cheap and correct.** Building blob, tree, and commit on the DO's SQLite VFS takes about 36 ms, and the fast-forward push of the result to trunk takes about 254 ms. isomorphic-git sends thin packs, so only new objects travel. Notes written with `addNote` and pushed with isomorphic-git are readable by stock git.
10. **Binding refs must be short branch names or full oids.** `HEAD`, `refs/heads/*`, `refs/notes/*`, and abbreviated oids return `null`/`[]` silently. Treat `null` as "ref did not resolve", not "file missing". Notes are readable through the binding only by notes-commit oid, so TrunkDO should store the notes tip oid it pushed.
11. **`info().lastPushAt`/`updatedAt` do not change on git pushes.** Detect pushes with the namespace trigger or `ls-refs`, never with `info()`.
12. **One namespace-level Workflow trigger covers every repo in the namespace**, including repos created later. No per-repo Queues subscription is needed, and the filter excludes other namespaces. Latency from push end is p50 0.53 s (max 1.5 s) to instance creation and p50 2.3 s (max 4.4 s) to `run()`. Neither number fits a sub-second loop. The event has no `eventTimestamp`, and `instanceId` = event `id`, which is the natural idempotency key.
13. **Binding reads cost about 12 to 15 ms each** (`createToken` about 49 ms, occasional outliers about 200 ms), against about 350 ms for a clone of even a tiny repo. Use `readBlob`/`readTree`/`readFile` for validation and review context, and clone only to write.
14. **The DO git stack is viable for small repos.** Clone takes 348 ms, add plus commit 91 ms, and push 337 ms. The bundle is 347 KiB gzip. `@cloudflare/computer/git` needs `@platformatic/vfs` installed, and it exposes no `writeTree`/`writeCommit`/`addNote`. Use raw isomorphic-git through the `adapter` seam on the same fs.
15. **Clef answers in about 170 to 190 ms p50 and is deterministic per model.** `clef-flash` is not faster at about 550 input tokens, and the two models disagreed on the test diff with confidence below 0.25. Use Clef as a cheap, reproducible gate keyed on `confidence`, and keep the deterministic checks as the floor.
16. **Deletes take about 1 s each.** Recycling workspaces by delete-and-refork costs about 2.5 s per slot, so reuse forks (push a new base) where possible.
