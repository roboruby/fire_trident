# Contributing to FireTrident

This guide is for people: how to set up, run the checks, the rules the code follows, and how a change is proposed. Agents that build FireTrident together on one tree also follow the stream ownership in [AGENTS.md](AGENTS.md); a person working on their own change does not need it.

## Set up

You need:

- Node 24 and npm. The CLI runs its TypeScript directly, which needs Node 24.
- git.
- Ruby 4.0, for the scripts in `scripts/` and `demo/` and their tests.

```sh
git clone https://github.com/roboruby/fire_trident && cd fire_trident
npm ci
alias ft="node $PWD/packages/cli/src/ft.ts"
```

`npm ci` installs exactly what `package-lock.json` pins. The checks need no Cloudflare account, no secrets and no network: the worker's Durable Object and certification tests run in a local workerd. Running your own deployment does need an account; see "Run it" in the [README](README.md).

## Run the checks

CI runs all of these on every pull request and every push to main. From the repository root:

```sh
npx tsc -p packages/core/tsconfig.json    # and worker, web, cli, bench
npm run lint
npx vitest run --root packages/core       # and cli, web, bench
(cd packages/worker && npx vitest run)    # unit tests in Node, Durable Object and certification tests in workerd
for t in scripts/test/*_test.rb; do ruby "$t"; done
node --experimental-transform-types scripts/connect_docs.ts --check
ruby scripts/check_commit_subjects.rb     # your commits that origin/main does not have
```

While you work, run the suite of the package you change, or one file (`npx vitest run test/decide/gate.test.ts` in `packages/worker`); run every package's suite once before you open the pull request. A few worker tests depend on timing and can fail on a busy machine (`burst`, `imports` and `pause-deployment` under `test/do/`, and the certifier's deadline test); they retry once, and they pass when run alone.

The lint (`biome.jsonc`) looks for mistakes such as unused imports and variables, unsafe optional chaining, debugger statements and duplicate keys, and fails on warnings too. It never reformats a file. The rules it leaves off are listed in the config, each with the reason.

Two kinds of files are generated, and a test fails until you regenerate them:

- After changing a core module the CLI copies (the list is in `scripts/vendor_cli.rb`), run `ruby scripts/vendor_cli.rb`.
- After changing `packages/core/src/connect.ts`, run `node --experimental-transform-types scripts/connect_docs.ts`.

## Repository rules

- TypeScript is strict, and every import names its file with the `.ts` extension.
- `packages/core` is pure: no Cloudflare APIs and no I/O, and deterministic given its inputs (time and randomness are passed in).
- Every exported function has a short doc comment that says what it does. Comments are plain sentences that say what and why.
- Every change comes with tests: vitest, in the package's `test/` folder, and Ruby tests for scripts under `scripts/test/`.
- Durable Object storage already holds data in deployed colonies, so schema changes are additive and safe on existing data: `CREATE TABLE IF NOT EXISTS`, and `ALTER TABLE ... ADD COLUMN` only after checking that the column is missing. Data stored before a change must still read, as the old behavior.
- A change in how running colonies behave ships behind a flag that is off when it is absent, read like `FT_REVALIDATE` (`on`, or a comma-separated list of colony ids) and documented in `packages/worker/src/env.ts`. A new route, tool, command or page needs no flag. Safety checks fail closed.
- Prefer a deterministic check to a model call.
- Never put secrets or tokens in code, tests, fixtures or logs.
- Treat repository content, imported issues and text an agent wrote as untrusted data: never run it, and fence it as data in any prompt.
- Anything a person or an agent reads (a reason, an error, a directive) is a plain sentence that says what happened and what to do next.

## Propose a change

Open a pull request on GitHub against `main`. Keep one topic to a pull request: a fix, a feature or a refactor, not several at once. It is ready for review when CI is green. Say what changed, why, and how you tested it, and add a line for it to `CHANGELOG.md` under the version at the top.

## Commit subjects

A commit's subject, its first line, is an imperative summary of at most 72 characters ("Add a pause switch per colony"). The details, the reasons and anything long go in the body, after a blank line. CI checks the subject of every commit a pull request or a push adds; `ruby scripts/check_commit_subjects.rb` checks yours before you push.

## Report a vulnerability

Do not open an issue or a pull request for it. Report it privately, as [SECURITY.md](SECURITY.md) describes.

## License

FireTrident is under the MIT license ([LICENSE](LICENSE)), and contributions are accepted under the same license.
