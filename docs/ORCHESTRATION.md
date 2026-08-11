# Orchestration: the full flow

How to run a spec-driven, test-first dispatch loop on top of Orca + OpenCode +
gatekeeper. This is the flow the plugin was extracted from; every rule here
exists because skipping it cost us at least one failed dispatch.

The roles:

- **The orchestrator** (you, or an agent like Claude Code acting for you)
  talks to whoever asks for the work, decides what gets built, writes the
  briefs and the exams, and verifies results. This is never delegated.
- **Workers** (OpenCode with a cheap model) execute fully-specified briefs in
  isolated Orca worktrees. They never grade their own homework.
- **Gatekeeper** closes the loop mechanically: gates, log, board, notification.

## 0. Decide: dispatch or do it yourself

Do it yourself when it fits in two minutes and you can verify at a glance —
or when it's a judgment call (architecture, money, security, a subtle bug):
then *you decide*, and dispatch the already-decided execution.

Dispatch when it means reading volume, touching several files, running a
suite, or repeating a pattern.

## 1. Spec before dispatch (SDD)

For anything beyond a one-line fix, write the change down first — we use
[OpenSpec](https://github.com/openspec) (`proposal.md` + `design.md` +
`tasks.md`), but any format works if it answers three questions the brief
will need: what is touched, what is NOT touched, and which decisions are
already made.

`tasks.md` is not a wishlist — **it is the dispatch queue**. If a task there
can't be turned into a verifiable brief, the spec is unfinished; fix it
before dispatching anything.

## 2. The brief: four things or it doesn't ship

A valid brief contains, always:

1. **Exact files** to touch — and explicitly what NOT to touch.
2. **The pattern to replicate, with its concrete path.** Never "follow the
   repo conventions" — that's a decision disguised as an instruction.
3. **The decisions already made**, written into the brief.
4. **An executable acceptance criterion** — a command, a test, a URL check.

The test: if the worker has to decide something you didn't write, the brief
isn't ready. Decide it, or route that decision to a strong model first and
then dispatch the decided work to a cheap one.

Name the edge cases one by one. The ones you don't name don't exist for the
worker. And scope hard — an under-scoped "make the test pass" once sent a
worker off running the entire repo suite.

## 3. TDD, adapted: the dispatcher writes the exam

Classic TDD says write the test first. With agents, the ordering is not the
point — **the separation between examiner and examined is**. Measured: the
same models that shipped broken code with a green self-report went 9/9 when
the dispatcher wrote the test and seeded it before launch.

```bash
# worktree with the agent waiting, no prompt yet
orca worktree create --name task --repo path:$REPO --agent opencode --json

# seed the exam
cp task.test.js $WT/
echo 'task.test.js'      > $WT/.gatekeeper-protected
echo 'node task.test.js' > $WT/.gatekeeper-verify

# RED FIRST: if the exam already passes, it's tautological or already done
node $WT/task.test.js && echo "ABORT"

# now the brief
orca terminal send --terminal $HANDLE --text "…" --enter
```

Write the acceptance at **flow level, not piece level**: "the summary shows
the new amount", not "component X exists". Piece-level checks pass on
components nobody wired up. A Playwright flow test is the hardest to fake.

Validate the exam itself before trusting it: break the code on purpose and
watch the exam fail. An exam that can't fail verifies nothing.

## 4. Dispatch (all native Orca)

```bash
# simple: prompt at create time
orca worktree create --name task --repo path:$REPO --agent opencode \
     --prompt "…" --comment "short summary" --json

# with a seeded exam: create → seed → send (see §3)
```

- The worker model/variant comes from OpenCode's config (`agent.build.model`
  + `agent.build.variant` in `opencode.json`) — `--agent` takes no model flag.
- Run repo setup (don't skip it): without `node_modules` the eslint gate
  can't run.
- **Never dispatch through one-shot `opencode run`** — it exits before the
  idle signal, so gates never fire.
- Multiple parallel dispatches: each worktree is isolated for files, **not**
  for databases, containers, ports, or a shared dev server. Workers that run
  the same integration suite will collide.

## 5. While it runs

- `orca worktree ps` — every worktree, live terminals, unread state, agent
  progress preview. This is the board.
- Orca notifies when an agent finishes or needs attention, desktop and
  mobile. Gatekeeper's own notification carries the gate verdict.
- The board statuses are written by the plugin: gates pass → `in-review`;
  fail → `in-progress` with the reason in the comment.

## 6. Verify before accepting

`worker done` is a claim, not a verification. The gates already checked the
mechanical part; what's left is yours:

- **Read the diff** (Orca's diff viewer, or `orca file open-changed`).
- Annotate line-by-line in Orca (hover → `+`, or press `c`), then **Send to
  agent**: Orca composes a single line-anchored prompt for the revision pass.
  One review round, one revision round — no ping-pong.
- The agent that implemented never audits its own work. If you want a second
  model's opinion, give the diff to a fresh agent without the implementation
  context in its window.

A failed gate means **fix the brief and re-dispatch** — never patch the
worker's output by hand. Hand-patching hides the brief's defect and the next
dispatch repeats it.

## 7. Racing (optional, for the hard or ambiguous)

For tasks where iteration count hurts (UI polish, ambiguous specs), race
N cheap workers on the same brief in N worktrees. Orca's recipe: same prompt,
different agents/models, compare diffs, merge the winner, delete the rest.

Gatekeeper improves the economics: workers that fail gates are discarded
unseen — you only compare survivors. Where the survivors agree, it's probably
right; where they split, you've found the actual hard part.

## 8. Scheduled upkeep

Orca automations run prompts on cron against a repo or workspace. Useful
standing jobs:

- weekly dispatch-log analysis (`scripts/analyze.py` output, summarized to
  the worktree comment),
- stale dispatch-branch cleanup,
- issue triage from the tracker.

## 9. Cost discipline

- MCP schemas dominate worker bills: every active server ships its full tool
  schema every turn. Workers go light (code navigation and little else);
  the orchestrator carries the diagnostic tools.
- The log answers the only question that matters: does delegation save money,
  or burn it in retries? Watch success rate per model, cost concentration
  per task, and retry hotspots. Escalating a failing task to a premium model
  without fixing the brief pays premium price for the same failure — measured
  at 400× the cost, with a lower pass rate.
