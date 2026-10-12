# FireTrident video — narration draft v0

Target 7:30–8:30. About 145 words a minute. Every number is checked against the final production runs before recording; placeholders are marked {like this}.

## 0:00 Cold open (live map, 80 agents converging, violation counter falling)

Eighty AI agents are working on one codebase right now. There is no branch per agent, no pull request queue, and no merge queue. In about a minute they will fix {958} problems, and every change will land on trunk with a record of why it was made.

This is FireTrident. A colony, not a queue.

## 0:25 The problem (simple chart: one queue vs. many lanes)

Git was designed for people. A person takes a branch, opens a pull request, waits for review, and lines up in a merge queue. That works when a team lands a few changes an hour. Agents can propose hundreds a minute. Put a thousand of them behind one queue and the queue becomes the product. Everyone waits in the same line, and every reviewer drowns.

Nature solved this a long time ago. An ant colony has millions of workers and no manager. A slime mold finds the shortest path through a maze without a map. Your immune system checks billions of cells and remembers every attack it has seen. None of them use a queue. They coordinate through signals left in the environment, they decide locally, and they work in parallel.

FireTrident brings those ideas to a repository. Four moves. Sense, decide, land, remember.

## 1:30 Import and declare (terminal, then the map)

This is Hono, a popular web framework with {583} files. One command imports it into a Cloudflare Artifacts repository. Every tile on this map is a file.

Now a person declares how the code should look. One rule: relative imports must name their file. The platform scans trunk, and every violation becomes a need in the field. {958} of them. Nobody assigns this work.

## 2:00 Sense (map: needs glow, claims appear and fade)

Agents read the field instead of talking to each other. Needs attract. Claims repel. Trails fade. Each agent chooses its work with a response threshold, the same rule ants use to decide whether to go out and forage. Reading the field costs the same with ten agents or ten thousand.

When an agent claims a file, it suppresses its neighbors, the way a cell that commits to becoming a neuron stops the cells beside it. But the claim decays. If an agent goes quiet, its claim fades in a few minutes. There is nothing to unlock and nothing to deadlock.

The colony also learns from history. Files that changed together in the past push agents apart, so two agents rarely work on coupled code at the same time.

## 3:00 Land (map: lanes flash, landing counter climbs)

Every region of the code has a lane. Every few seconds the lane picks the largest set of proposals that don't conflict, checks that everything each agent read is still current, and hands them to a single trunk writer. The writer lands them as one commit, with compare and swap. If something an agent read has changed, its proposal goes back with the exact difference instead of a merge conflict.

Sometimes one change sends a wave of proposals back. FireTrident watches for that the way neurologists watch for seizures. It measures how many returns each return causes. When that number climbs above one, the region slows down until the wave dies out.

## 3:50 Decide (funnel panel, then the review tab)

Every proposal passes through a reflex arc. Deterministic checks come first. For this rule the platform can prove an edit is correct by resolving every import against the real file tree. {282} edits landed on proof alone, without asking a model.

When proof isn't possible, Cloudflare's Clef decision models answer typed questions in a fraction of a second. If they are unsure, a model from a different family gives a second opinion. Only then is a person asked. A change lands without a human only when two independent signals agree.

When a person rejects a change, the colony learns. The rejection becomes an antibody, a check committed to the repository that screens every later proposal. And the immune system is measurable. The vaccination meter sends known bad changes through the normal path. It caught {28 of 28}, and none of them landed.

## 5:00 Remember (Why panel; then `git log --notes` in a terminal)

Ask why any line exists. Every landed commit carries trailers and a git note with the intent, the rule, the agent and its model, every decision with its probability, and the exact files the agent read and wrote. It's plain git. Any git client can read it.

## 5:30 Change direction (pending the Direction stream)

People change their minds mid-flight. Here a person amends an intent while agents are working on it. The agents holding it get the new direction on their next heartbeat, work built on the old version goes back, and the lineage records revision two.

## 6:00 A new project (terminal, map growing from empty)

FireTrident doesn't only fix existing code. Give it a spec and it grows a project from an empty repository. {13} intents and {5} architecture rules. Agents wait for the files they build on and write the rest, and the colony converges on the shape the spec declares. Clone the result with plain git and run its tests. {50 of 50} pass.

## 6:45 Bring your own agent (pending M1)

Agents don't have to live inside the platform. Any MCP client can join a colony, take work, push with plain git, and be reviewed like everyone else. Here Claude Code joins a colony and lands a change.

## 7:15 Scale (benchmark chart, measured vs. simulated labels)

On the live service, a thousand concurrent agents landed {138} changes a minute with zero errors. In simulation the curve keeps climbing where one serialized queue flattens. Optimism has a cost and we measure it: agents redo some work when trunk moves under them, and inhibition and co-change learning cut that rework to {31} percent.

## 7:45 Close (title card)

FireTrident runs entirely on Cloudflare. Artifacts holds every repository. Durable Objects run the colony, its regions, the trunk writer and every agent. Workers AI powers the reflexes and the agents. It's open source under the MIT license.

A colony, not a queue.
