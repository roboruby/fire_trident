# Overlapping pull requests in honojs/hono, replayed

MEASURED from the repository's real history: pull requests merged into any branch from 2025-10-17 to 2026-10-17 (UTC, the last day excluded), each paired only with pull requests into the same branch; the first merged 2025-10-17T13:48:36Z, the last 2026-10-16T10:01:28Z. Left out: 5 branch merges ([#4574](https://github.com/honojs/hono/pull/4574), [#4735](https://github.com/honojs/hono/pull/4735), [#5154](https://github.com/honojs/hono/pull/5154), [#5237](https://github.com/honojs/hono/pull/5237), [#5236](https://github.com/honojs/hono/pull/5236)), whose changes are other pull requests' work. How often work that was open at the same time touched the same files, how often stock git could not merge it, and what FireTrident's text merge would have done with it. Written by `packages/bench/src/overlap/replay.ts`; every pair and its verdicts are in [overlap.json](overlap.json).

| Measure (MEASURED) | Count |
| --- | --- |
| Pull requests merged in the window | 360 |
| Pairs open at the same time (open-to-merge windows overlapped) | 1,562 |
| Pairs sharing a changed file (what per-file locks would have serialized) | 89 |
| Pairs replayed | 87 |
| Of those, replayed at the later one's last commit before it took in the earlier | 42 |
| Pairs sharing a file not replayable (one was rebased onto or opened on top of the other) | 2 |
| Pairs sharing a file with a commit missing from the clone | 0 |
| git conflicts (stock `git merge-tree` of the two heads) | 20 |
| Of those, every conflicting file the same at both pull requests' own bases | 8 |
| Of the git conflicts, text merge lands both (FT_TEXT_MERGE) | 1 |
| Of the git conflicts, text merge with the insertion rule lands both (FT_MERGE_INSERTIONS) | 7 |
| Still conflicting (git conflicts neither lands) | 13 |
| git merges cleanly, text merge sends the later one back | 4 |
| git merges cleanly, text merge with the insertion rule sends the later one back | 4 |

- Pairs sharing a file: 89 of 1,562 (5.7%) of the pairs open at the same time.
- git conflicts: 20 of 87 (23.0%) of the replayed pairs.
- Text merge lands 1 of 20 (5.0%) of the git conflicts; with the insertion rule, 7 of 20 (35.0%).
- Per-file locks would have held the later pull request of all 89 pairs sharing a file until the earlier one merged. Of the 87 replayed, git merges 67 cleanly, and text merge with the insertion rule lands 70.
- The 20 git conflicts involve 9 distinct later pull requests; 8 are between the two pull requests' own edits, the others also involve what their branch did between the two bases.

## By branch

| Branch merged into | Pull requests | Pairs open at the same time | Sharing a file | git conflicts |
| --- | --- | --- | --- | --- |
| `main` | 288 | 1,151 | 48 | 3 |
| `next` | 42 | 271 | 12 | 2 |
| `refactor/body-cache-bytes-first` | 1 | 0 | 0 | 0 |
| `refactor/trie-router-reduce-bundle-size` | 1 | 0 | 0 | 0 |
| `v5` | 28 | 140 | 29 | 15 |

## Still conflicting, by reason

| Reason (the first file that stops the merge) | Pairs |
| --- | --- |
| overlapping edits | 13 |

## Every git conflict

Earlier: merged first (trunk's side of the merge); later: the pull request that would land on it. Own edits: every conflicting file was the same at both pull requests' own bases, so the conflict is between their own changes and not with what the branch they merged into did between their bases. Text merge columns name each file that stops the later one (a conflicting hunk, by its first line in the base, or why the file is not merged).

| Earlier | Later | git conflicts | Own edits | Text merge | With the insertion rule |
| --- | --- | --- | --- | --- | --- |
| [#4558](https://github.com/honojs/hono/pull/4558) | [#4559](https://github.com/honojs/hono/pull/4559) | CONFLICT (contents): src/middleware/csrf/index.ts | yes | src/middleware/csrf/index.ts: hunk at line 139 | src/middleware/csrf/index.ts: hunk at line 139 |
| [#4535](https://github.com/honojs/hono/pull/4535) | [#4556](https://github.com/honojs/hono/pull/4556) | CONFLICT (contents): src/client/client.test.ts | yes | lands | lands |
| [#5118](https://github.com/honojs/hono/pull/5118) | [#5122](https://github.com/honojs/hono/pull/5122) | CONFLICT (contents): src/context.ts | yes | src/context.ts: hunk at line 625 | src/context.ts: hunk at line 625 |
| [#5340](https://github.com/honojs/hono/pull/5340) | [#5329](https://github.com/honojs/hono/pull/5329) | CONFLICT (contents): src/jsx/dom/index.test.tsx; CONFLICT (contents): src/jsx/dom/render.ts | yes | src/jsx/dom/render.ts: hunk at line 544, 553 | src/jsx/dom/render.ts: hunk at line 544, 553 |
| [#5501](https://github.com/honojs/hono/pull/5501) | [#5402](https://github.com/honojs/hono/pull/5402) | CONFLICT (contents): docs/MIGRATION.md; CONFLICT (contents): runtime-tests/workerd/index.ts | no | docs/MIGRATION.md: hunk at line 3; runtime-tests/workerd/index.test.ts: hunk at line 38 | runtime-tests/workerd/index.test.ts: hunk at line 38 |
| [#5502](https://github.com/honojs/hono/pull/5502) | [#5402](https://github.com/honojs/hono/pull/5402) | CONFLICT (contents): docs/MIGRATION.md; CONFLICT (contents): runtime-tests/workerd/index.ts | no | docs/MIGRATION.md: hunk at line 3; runtime-tests/workerd/index.test.ts: hunk at line 38 | runtime-tests/workerd/index.test.ts: hunk at line 38 |
| [#5511](https://github.com/honojs/hono/pull/5511) | [#5402](https://github.com/honojs/hono/pull/5402) | CONFLICT (contents): docs/MIGRATION.md; CONFLICT (contents): runtime-tests/workerd/index.ts | no | docs/MIGRATION.md: hunk at line 3; runtime-tests/workerd/index.test.ts: hunk at line 38 | runtime-tests/workerd/index.test.ts: hunk at line 38 |
| [#5515](https://github.com/honojs/hono/pull/5515) | [#5402](https://github.com/honojs/hono/pull/5402) | CONFLICT (contents): docs/MIGRATION.md; CONFLICT (contents): runtime-tests/workerd/index.ts | no | docs/MIGRATION.md: hunk at line 3; runtime-tests/workerd/index.test.ts: hunk at line 38 | runtime-tests/workerd/index.test.ts: hunk at line 38 |
| [#5517](https://github.com/honojs/hono/pull/5517) | [#5402](https://github.com/honojs/hono/pull/5402) | CONFLICT (contents): docs/MIGRATION.md; CONFLICT (contents): runtime-tests/workerd/index.ts | no | docs/MIGRATION.md: hunk at line 3; runtime-tests/workerd/index.test.ts: hunk at line 38 | runtime-tests/workerd/index.test.ts: hunk at line 38 |
| [#5318](https://github.com/honojs/hono/pull/5318) | [#5243](https://github.com/honojs/hono/pull/5243) | CONFLICT (contents): src/router/common.case.test.ts | yes | src/router/common.case.test.ts: hunk at line 109 | lands (insertion rule) |
| [#5532](https://github.com/honojs/hono/pull/5532) | [#5402](https://github.com/honojs/hono/pull/5402) | CONFLICT (contents): docs/MIGRATION.md; CONFLICT (contents): runtime-tests/workerd/index.ts | no | docs/MIGRATION.md: hunk at line 3; runtime-tests/workerd/index.test.ts: hunk at line 38 | runtime-tests/workerd/index.test.ts: hunk at line 38 |
| [#5532](https://github.com/honojs/hono/pull/5532) | [#5531](https://github.com/honojs/hono/pull/5531) | CONFLICT (contents): src/validator/validator.ts | yes | src/validator/validator.ts: hunk at line 90 | src/validator/validator.ts: hunk at line 90 |
| [#5532](https://github.com/honojs/hono/pull/5532) | [#5243](https://github.com/honojs/hono/pull/5243) | CONFLICT (contents): src/router/common.case.test.ts | no | src/router/common.case.test.ts: hunk at line 109 | lands (insertion rule) |
| [#5533](https://github.com/honojs/hono/pull/5533) | [#5402](https://github.com/honojs/hono/pull/5402) | CONFLICT (contents): docs/MIGRATION.md; CONFLICT (contents): runtime-tests/workerd/index.ts | no | docs/MIGRATION.md: hunk at line 3; runtime-tests/workerd/index.test.ts: hunk at line 38 | runtime-tests/workerd/index.test.ts: hunk at line 38 |
| [#5533](https://github.com/honojs/hono/pull/5533) | [#5243](https://github.com/honojs/hono/pull/5243) | CONFLICT (contents): src/router/common.case.test.ts | no | src/router/common.case.test.ts: hunk at line 109 | lands (insertion rule) |
| [#5534](https://github.com/honojs/hono/pull/5534) | [#5402](https://github.com/honojs/hono/pull/5402) | CONFLICT (contents): docs/MIGRATION.md; CONFLICT (contents): runtime-tests/workerd/index.ts | no | docs/MIGRATION.md: hunk at line 3; runtime-tests/workerd/index.test.ts: hunk at line 38 | runtime-tests/workerd/index.test.ts: hunk at line 38 |
| [#5534](https://github.com/honojs/hono/pull/5534) | [#5243](https://github.com/honojs/hono/pull/5243) | CONFLICT (contents): src/router/common.case.test.ts | no | src/router/common.case.test.ts: hunk at line 109 | lands (insertion rule) |
| [#5402](https://github.com/honojs/hono/pull/5402) | [#5243](https://github.com/honojs/hono/pull/5243) | CONFLICT (contents): src/router/common.case.test.ts | no | src/router/common.case.test.ts: hunk at line 109 | lands (insertion rule) |
| [#5243](https://github.com/honojs/hono/pull/5243) | [#5541](https://github.com/honojs/hono/pull/5541) | CONFLICT (contents): src/router/linear-router/router.test.ts | yes | src/router/linear-router/router.test.ts: hunk at line 13 | src/router/linear-router/router.test.ts: hunk at line 13 |
| [#5450](https://github.com/honojs/hono/pull/5450) | [#5451](https://github.com/honojs/hono/pull/5451) | CONFLICT (contents): src/helper/css/index.test.tsx | yes | src/helper/css/index.test.tsx: hunk at line 250 | lands (insertion rule) |

## git merges cleanly, text merge sends the later one back

| Earlier | Later | Text merge with the insertion rule |
| --- | --- | --- |
| [#5448](https://github.com/honojs/hono/pull/5448) | [#5447](https://github.com/honojs/hono/pull/5447) | pnpm-lock.yaml: a lockfile |
| [#5459](https://github.com/honojs/hono/pull/5459) | [#5447](https://github.com/honojs/hono/pull/5447) | pnpm-lock.yaml: a lockfile |
| [#5465](https://github.com/honojs/hono/pull/5465) | [#5464](https://github.com/honojs/hono/pull/5464) | pnpm-lock.yaml: a lockfile |
| [#5466](https://github.com/honojs/hono/pull/5466) | [#5464](https://github.com/honojs/hono/pull/5464) | pnpm-lock.yaml: a lockfile |

## Files shared most often

| Path | Pairs sharing it |
| --- | --- |
| `docs/MIGRATION.md` | 18 |
| `package.json` | 16 |
| `src/client/client.test.ts` | 7 |
| `src/context.ts` | 5 |
| `pnpm-lock.yaml` | 4 |
| `src/client/client.ts` | 4 |
| `src/client/types.ts` | 4 |
| `src/middleware/serve-static/index.test.ts` | 4 |
| `src/router/common.case.test.ts` | 4 |
| `src/router/linear-router/router.test.ts` | 4 |
| `src/adapter/aws-lambda/handler.ts` | 3 |
| `src/hono-base.ts` | 3 |
| `src/jsx/base.ts` | 3 |
| `src/middleware/etag/index.test.ts` | 3 |
| `src/utils/jwt/jwt.test.ts` | 3 |

## Method

- Pull requests: merged into any branch inside the window, read with GitHub's GraphQL API (number, open and merge times, base and head branches and commits, merge commit, changed files). Branch merges are left out: a pull request from a branch of the repository that others merge into (a release merging one long-lived branch into another) carries other pull requests' work. A pull request merged before the window that overlapped one inside it is not paired.
- Overlap: two pull requests into the same branch overlap when each was opened before the other merged (open-to-merge windows, drafts counted as open); pull requests into different branches never merge into one trunk and are not paired. The earlier is the one merged first: it is trunk's side of the merge, the later one is the change landing on it.
- Sharing a file: a path both pull requests' changed-file lists name. Per-file locks would have held the later one until the earlier merged.
- Updated after the other landed: when the later pull request's final head already holds the earlier one's merge commit or head (its author merged the branch it targets into it, or rebased, after the earlier landed), the replay takes the later one's last commit of its own from before that: the newest commit on its head's first-parent line that holds neither, when that commit is neither on the branch it merged into nor in the earlier one's history. That is the work as it stood when its author took in the earlier one, so a conflict they resolved by hand while updating shows. A rebased branch has no such commit, nor does one opened on top of the other's merge or stacked on its branch (nor an earlier head that holds the later one): those pairs are counted and not replayed.
- git: `git merge-tree --write-tree --merge-base=<base>` of the two heads, where the base is `git merge-base` of the two heads (the first when git finds more than one; mergeBases records how many). Stock git with its default merge (rename detection on).
- Text merge: every file both heads changed against that base to different results (rename detection off, as a colony sees writes) is merged with `packages/core` mergeText as the trunk writer calls it (trunk/plan.ts mergeWrites): base, the earlier head's version as trunk's, the later head's as the change's. A file added on both sides or deleted on one, a lockfile, a submodule, a version over 512 KB, binary or not UTF-8, or a side past the edit limit is not merged and the later change goes back. A pair lands only when every such file merges. With the insertion rule, mergeText runs with `insertions` (FT_MERGE_INSERTIONS). git and mergeText (a plain Myers diff) can place an insertion differently when the lines around it repeat (closing braces), so one can conflict where the other does not; both verdicts are recorded per file.
- Own edits: a git-conflicting file is the two pull requests' own collision when it was the same at both pull requests' own bases (each head's merge base with the branch as it stood just before its merge); otherwise the branch they merged into also changed it between the two bases, and part of the conflict is with that.

## Limits

- Read sets are not measurable from pull request data: a pair git merges cleanly where one pull request changed what the other only read (an import, a called function's signature, a type) is invisible here. FireTrident checks reads at landing (stale reads go back or are revalidated); this replay measures writes only.
- Commits, not working trees. The replay sees the commits a pull request's branch kept: a rebase or force-push drops the work as it stood before (those pairs are not replayed), and work an author held locally before pushing does not show.
- Pairwise, against the earlier head. On a colony the later change merges with trunk as it is when it lands (every landing since its base), not with the earlier head alone; and when the two bases differ, what the branch changed between them counts as the side with the newer base (see own edits).
- The conflict resolver (FT_RESOLVER, one model call per conflicting file) is not replayed: no model calls. Still-conflicting pairs are the ones it would be asked to merge.
- Changed-file lists name a renamed file by its new path only (20 renamed entries in 1 pull request), so a pair where one renamed a file the other changed is not counted as sharing it.

## Reproduce

From the repository root (reads GitHub with the `gh` CLI, clones the repository, and runs only stock git locally; responses and the clone are cached under `--cache` and never fetched twice):

    node packages/bench/src/overlap/replay.ts --repository honojs/hono --since 2025-10-17 --until 2026-10-17 --cache <cache> --out packages/bench/results/2026-10-17-hono-overlap
