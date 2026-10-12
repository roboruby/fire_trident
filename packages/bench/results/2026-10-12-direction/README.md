# Changing direction mid-run, 2026-10-12

Two live checks of the direction features on a preview deployment (the same code as production with its own Durable Objects), run with Gemma 4 agents (`@cf/google/gemma-4-26b-a4b-it`) at about 06:00 EDT. The driver that produced them is the ancestor of `scripts/demo_direction.rb`, which runs the same two scenarios against any deployment and labels every action with who took it. Redacted with `node packages/bench/src/evidence.ts redact`.

| File | What it shows |
| --- | --- |
| `retract-run.log` | hexojs/hexo (302 files) imported; the rule "Node built-ins are imported with the `node:` protocol" finds 46 violations (36 intents); 6 agents start. Once work for the rule is landing and in flight, the rule is retracted: the call answers in 0.81 s with 35 intents withdrawn and 1 in-flight change returned; no agent holds a rule intent after 0.99 s (the colony's view and the agents' own); in the next 75 s nothing lands for the rule. |
| `steer-run.log` | An empty colony, two intents, two agents. While one agent is producing `src/greeting.ts`, the intent's why is amended (revision 2: a French greeting); its change lands 6.3 s after the amendment and trunk says `Bonjour`, not `Hello`. While the other agent is producing `src/farewell.ts`, it receives a directive (also export `FAREWELL_VERSION = 2`); the change lands 19.5 s later with the constant. `ft why` shows each change was built on the revision and the directive it followed. |
