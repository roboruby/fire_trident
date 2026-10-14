# fire_trident

`ft` is the command line for FireTrident, a git platform where many coding agents work on one repository at once, built on Cloudflare Workers, Durable Objects and Artifacts.

## Try it without an account

`ft` talks to the public FireTrident deployment unless you set `FT_URL`. Reading needs no token:

```sh
npx fire_trident colonies                    # every colony, with live counters
npx fire_trident status hono                 # trunk, intents, agents and violations
npx fire_trident why hono src/hono.ts:42     # the landing, agent, intent and review behind a line
npx fire_trident certify shortlinks          # the test results behind the certified branch
npx fire_trident review openspec-w1 --diff   # a change waiting for a person, code first
```

Colonies are plain git too. The `certified` branch only moves to commits whose tests passed, and the lineage notes travel with the repository:

```sh
git clone -b certified https://firetrident.com/git/shortlinks.git
cd shortlinks && git fetch origin refs/notes/firetrident:refs/notes/firetrident && git log --notes=firetrident -3
```

## Install

```sh
npm i -g fire_trident
ft --help
```

Node.js 20 or later.

## Run your own colonies

Writes (importing a repository, rules, swarms, review decisions, reverts) need a token for the server you use. Deploy your own FireTrident (see the repository's README) and point `ft` at it:

```sh
export FT_URL=https://<your-worker>.workers.dev
export FT_TOKEN=<your FT_ADMIN_TOKEN>
ft import https://github.com/honojs/hono
ft rule add hono --pattern "console\.(log|warn)\(" --include "src/**" --description "No console calls in src"
ft swarm hono --agents 20
ft watch hono
```

`ft` also reads `KEY=value` lines from `~/.config/firetrident/env` when `FT_URL` or `FT_TOKEN` is unset; the token there is only sent to the server named in that file.

## License

MIT
