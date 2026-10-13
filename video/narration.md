# FireTrident video — narration draft v1

Target 7:30–8:30. About 145 words a minute. Every number was checked against the production colonies and the result files on 2026-10-12 (video/README.md names the sources); a {braced} value is one still to check.

## 0:00 Cold open (replay of the hono colony: 80 agents converging, violation counter falling)

Eighty AI agents are working on one codebase. There is no branch per agent, no pull request queue, and no merge queue. In about a minute they will fix 958 problems in a real open source project, and every change will land on trunk with a record of why it was made.

This is FireTrident. A colony, not a queue.

## 0:25 The problem (simple chart: one queue vs. many lanes)

Git was designed for people. A person takes a branch, opens a pull request, waits for review, and lines up in a merge queue. That works when a team lands a few changes an hour. Agents can propose hundreds a minute. Put a thousand of them behind one queue and the queue becomes the product. Everyone waits in the same line, and every reviewer drowns.

Nature solved this a long time ago. An ant colony has millions of workers and no manager. Your immune system checks billions of cells and remembers every attack it has seen. Neither uses a queue. They coordinate through signals left in the environment, they decide locally, and they work in parallel.

FireTrident brings those ideas to a repository. Four moves. Sense, decide, land, remember.

## 1:30 Import and declare (terminal, then the map)

This is Hono, a popular web framework with 583 files. One command imports it into a Cloudflare Artifacts repository. Every tile on this map is a file.

Now a person declares how the code should look. One rule: relative imports must name their file. The platform scans trunk, and every violation becomes a need in the field. 958 of them. Nobody assigns this work.

## 2:00 Sense (map: needs glow, claims appear and fade)

Agents split the work instead of racing for it. They read the field rather than talking to each other. Needs attract. Claims repel. Trails fade. Each agent picks its work with a response threshold, the same rule ants use to decide whether to go out and forage.

When an agent claims a file, it holds its neighbors back, the way a cell that becomes a neuron stops the cells beside it from doing the same. But the claim decays. If an agent goes quiet, its claim fades in a few minutes. There is nothing to unlock and nothing to deadlock.

The colony also learns from history. Files that changed together in the past push agents apart, so two agents rarely work on coupled code at the same time.

## 3:00 Land (map: lanes flash, landing counter climbs)

Every region of the code has a lane. Every few seconds the lane picks the largest set of proposals that don't conflict, checks that everything each agent read is still current, and hands them to a single trunk writer. The writer lands every lane's batch in one commit, with compare and swap. If something an agent read has changed, its proposal goes back with the exact difference instead of a merge conflict.

Sometimes one change sends a wave of proposals back. FireTrident watches for that the way neurologists watch for seizures. It measures how many returns each return causes. When that number climbs above one, the region slows down until the wave dies out.

## 3:50 Decide (funnel panel, then the review tab with a person approving)

Every proposal passes through a reflex arc. Proof comes first. For this rule the platform can prove an edit is correct by resolving every import against the real file tree. All 282 of the rule's edits landed on proof alone, without asking a model.

When proof isn't possible, Cloudflare's Clef decision model answers typed questions in a fraction of a second. If it is unsure, a model from a different family gives a second opinion. Some changes never land on a model's word. Code that touches authentication, secrets, or new network access always goes to a person, with the intent, the rule and the agent's own account of what it did not verify.

When a person rejects a change, the colony learns. The rejection becomes an antibody, a check committed to the repository that screens every later proposal. And the immune system is measurable. The vaccination meter sends known bad changes through the normal path. It caught 28 of 28, and none of them landed.

## 5:00 Remember (Why panel; then a plain git clone and `git log --notes` in a terminal)

Ask why any line exists. Every landed commit carries trailers and a git note with the intent, the rule, the agent and its model, every decision, and the exact files the agent read and wrote. It's plain git. Clone the trunk with any git client, no account needed, and the history explains itself.

## 5:30 Change direction (map and events tab: a rule retracted, an intent amended, a directive)

People change their minds while the work is in flight. Here a person retracts a rule in the middle of a run. In under a second, 35 open intents are withdrawn and the 3 changes in flight go back. Nothing lands for that rule again.

Here a person amends an intent an agent is working on. The agent restarts on the new revision within about a second, and the new version lands 23 seconds later. Work built on the old revision is refused. A person can also send one agent a note while it works, and it re-plans in 2 seconds. The lineage records every revision and every note.

## 6:20 A new project (replay: the map growing from an empty repository)

FireTrident doesn't only fix existing code. Give it a spec and it grows a project from an empty repository. 13 intents and 5 architecture rules. Agents wait for the files they build on and write the rest.

Eight minutes later, clone the result with plain git and run its tests. 60 of 60 pass, and so does the reference acceptance suite, 7 of 7.

## 7:00 Bring your own agent (terminal: Claude Code over MCP; the map shows it landing)

Agents don't have to live inside the platform. Any MCP client can join a colony, take work, push with plain git, and be reviewed like everyone else. Here Claude Code joins a colony, takes a need, and lands a change in under a minute, beside the colony's own agents.

## 7:30 Scale (benchmark chart, measured vs. simulated labels)

How far does it go? On a preview deployment, five thousand concurrent agents landed about 2,800 changes a minute. Of fifty thousand calls, 78 failed, all while the load was ramping up. Those were synthetic agents, to load the coordination layer itself. With language models, the model's rate limit is reached long before the colony's. Optimism has a cost and we measure it. Agents redo some work when trunk moves under them, and inhibition and co-change learning cut that rework to 31 percent.

## 8:00 Close (title card)

FireTrident runs entirely on Cloudflare. Artifacts holds every repository. Durable Objects run the colony, its regions, the trunk writer and every agent. Workers AI powers the reflexes and the agents. Every run can be replayed, and it's open source under the MIT license.

A colony, not a queue.
