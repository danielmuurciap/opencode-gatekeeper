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

For anything beyond a one-line fix, write the change down first. We use
[OpenSpec](https://github.com/Fission-AI/OpenSpec), but any format works if
it answers the three questions every brief will need: **what is touched,
what is NOT touched, and which decisions are already made**. Without that
written down, every dispatch improvises its own scope — and a worker without
a written boundary knocks down the neighboring wall because "it looked
better that way".

The OpenSpec cycle, mapped to dispatching:

```
unclear request  → openspec explore     think out loud, clarify requirements
clear request    → openspec propose     generates the change folder:
                                          proposal.md   why + what changes
                                          design.md     decisions, trade-offs
                                          tasks.md      ← THE DISPATCH QUEUE
each task        → worktree → brief → worker → gates    (sections 2–6)
tasks done       → openspec apply       mark tasks complete against the spec
change closed    → openspec archive     fold the delta into the living specs
```

(`openspec init --tools claude,opencode` sets a repo up; the CLI acts on the
nearest `openspec/` directory. Agent-facing slash commands ship for Claude
Code and OpenCode.)

Three rules make this SDD instead of paperwork:

- **`tasks.md` is the dispatch queue, not a wishlist.** If a task there
  can't be turned into a verifiable brief — four parts, §2 — the spec is
  unfinished. Fix the spec, don't improvise the brief.
- **The spec is where decisions die.** `design.md` records what was decided
  and why; the brief copies decisions from it. If a worker asks a question
  mid-task, the answer belongs in `design.md` first, the brief second.
- **Count before you start.** Read `tasks.md` and count: 3+ tasks, or 5+
  files, or crossing subprojects → isolated worktrees per task, because a
  change that size makes the main checkout unusable for anything else while
  it lasts, and aborting means abandoning a worktree instead of reverting by
  hand. Below that, a branch on the main checkout is fine. Tune the numbers
  per repo; never skip the counting.

When to skip all of it: a one-line fix with an obvious verification. The
rule of thumb — if the work goes to a worker, it needs a spec; if you do it
yourself in two minutes, it doesn't.

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

Classic TDD is one person alternating roles: write the test, then write the
code, and the value lives in the *ordering* — the test forces design
thinking before typing. With agents the ordering is not the point.
**The separation between examiner and examined is.**

The evidence, from our own logs: given the same task as a prose brief, two
cheap models shipped code that crashed **while reporting success** — and 43
repo security guardians approved the broken code. Given the same task with
the test written by the dispatcher and seeded before launch, four models
(including both that had failed) went 9/9. Same models, same task; the only
variable was who wrote the exam. A worker that writes its own test performs
the entire TDD ritual and verifies nothing — the exam adapts to the code,
which is precisely what TDD exists to prevent.

What survives from classic TDD unchanged is **red-first**: run the exam
before dispatching, and abort if it passes. A pre-green exam means it's
tautological or the work already exists — either way, dispatching against
it verifies nothing.

What is *not* TDD at all: the exam doesn't guide the worker's design the
way a TDD test guides a human's. It's an acceptance contract, closer to an
externally-held integration test. And there is no red-green-refactor cycle
inside the dispatch — it's a single shot: seed, dispatch, gate.

The full sequence, end to end:

```bash
REPO=~/code/myapp

# 1. Worktree with the agent waiting — no prompt yet, so the exam
#    is in place before the worker's first token
orca worktree create --name quota-fix --repo path:$REPO \
     --agent opencode --json
#    → WT=<worktree path>, HANDLE=<result.agentTerminalHandle>

# 2. Write the exam YOURSELF, at flow level, and seed it
cat > $WT/quota.test.js <<'JS'
import { getQuota } from "./src/quota.js"
const q = await getQuota("tenant-a")          // named edge case: real tenant
if (q.remaining !== q.limit - q.used) process.exit(1)
const empty = await getQuota("tenant-none")   // named edge case: no rows
if (empty.remaining !== empty.limit) process.exit(1)
console.log("ok")
JS
echo 'quota.test.js'      > $WT/.gatekeeper-protected
echo 'node quota.test.js' > $WT/.gatekeeper-verify

# 3. RED FIRST — the exam must fail before the worker starts
(cd $WT && node quota.test.js) && { echo "ABORT: exam already green"; exit 1; }

# 4. Validate the exam can catch a lie: if you can break the code and the
#    exam stays green, the exam is decoration (mocks asserting mocks)

# 5. Now, and only now, the brief
orca terminal send --terminal $HANDLE --enter --text \
  "Make quota.test.js pass with the minimum change. The bug: getQuota
   ignores rows with NULL used. Touch only src/quota.js. Replicate the
   null-handling pattern in src/limits.js. Do not modify quota.test.js.
   Do not run the repo suite. Do not commit."
```

When it finishes, gatekeeper checks — in this order, because each one
invalidates the next — that the exam is **intact** (`protected_modified`:
workers under pressure do edit exams; we caught one inlining the
implementation into the test file to dodge a missing module, with `verify`
showing green), that the exam **passes** (`verify`), and that the linter
holds on touched files.

Write acceptance at **flow level, not piece level**: "the summary shows the
new amount", not "component X exists" — piece-level checks pass on
components nobody wired up. Cost the exam honestly: for logic it's minutes;
for UI it feels expensive and is where it pays most (our worst retry
hotspots were all UI tasks that a 20-minute Playwright flow test would have
cut from 7–8 dispatch round-trips to 1–2).

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

## 7. The gauntlet: roles, and who delegates to whom

The repo ships four agent definitions (`agents/`, install: copy into
`.opencode/agent/` of the project or `~/.config/opencode/agent/`). Each is
deny-by-default and **none can delegate** (`task: deny`) — an agent that
opens agents opens a tree nobody controls; we measured 2 research agents
turning into 9 across three levels before capping it.

| Role | Writes | Launched how | Why it exists |
|---|---|---|---|
| `scout` | no | `opencode run --agent scout "where does X live?"` | briefs need exact paths, not guesses |
| `implementer` | **yes** | TUI dispatch (worktree + gates) | refuses briefs missing the four parts |
| `reviewer` | no | `opencode run --agent reviewer` on the diff | the implementer can't find its own bugs |
| `test-runner` | no | `opencode run --agent test-runner` | suite output stays out of your context |

The launch asymmetry is deliberate: **writers go through the TUI dispatch so
gates fire; read-only roles can use one-shot `opencode run`** — nothing to
gate when nothing is written, and one-shot is cheaper and simpler.

The loop, end to end (the orchestrator drives it; nothing here is a
fire-and-forget daemon):

```bash
# 1. scout → brief   (orchestrator writes the brief + exam from scout's map)
opencode run --agent scout "Where is quota computed? What imports it?"

# 2. implementer in a gated worktree            (§3–4: seed exam, red-first)
orca worktree create --name task --repo path:$REPO --agent opencode --json
orca terminal send --terminal $HANDLE --text "$BRIEF" --enter
#    … gatekeeper runs gates on idle → board: in-review or in-progress+reason

# 3. gates passed → reviewer, FRESH context, in the worktree
cd $WT && git diff | opencode run --agent reviewer \
  "Review this diff against the brief below. Brief: $BRIEF"

# 4. REVISE? → findings go back to the SAME implementer session
orca terminal send --terminal $HANDLE --enter --text \
  "Reviewer findings, fix exactly these and nothing else: …"
#    … gates re-fire on the next idle (per-turn re-arm is built in)

# 5. repeat 3–4 until APPROVE — with a hard cap
```

Rules that keep the loop honest:

- **Three strikes.** If the same task fails gates or review three times,
  stop dispatching: the defect is in the brief or the spec. Fix it there.
  (Escalating the model instead of the brief pays premium for the same
  failure — measured.)
- **The reviewer reviews the diff, not the worker's report.** Feed it
  `git diff` output; never ask "did it go well?".
- **Fresh context per review round** — a reviewer that watched the
  implementation inherits its blind spots.
- **QA is the exam, not an agent.** The flow-level acceptance test (§3) is
  the QA of this loop, and the dispatcher owns it. An agent drafting exams
  for itself is self-grading with extra steps; if you want help writing the
  exam, have an agent draft it, then YOU validate it red-first and
  break-test it before seeding.
- The human stays at the end: gates + reviewer shrink what reaches your
  eyes, they don't replace them. Orca's diff annotation (hover → `+`,
  Send to agent) is the last mile.

What this loop deliberately does NOT include: an aesthetic/visual judge as
a gate. A zero-shot model scoring visual quality in the absolute barely
beats a coin flip (57.7% vs 50% in DesignPref's measurements against
professional designers' preferences) — a default gate built on that ships
noise with a verdict attached.

The defensible form is **comparative**: a
[gauntlet loop](https://somethingbig.ai/gauntlet-loop) where a fresh critic
blind-compares the rendered artifact against a **concrete reference of
excellent** (A/B in both orders — judges flip preference on order swap in
~1/3 of cases), and returns the single biggest gap to the builder each
round. Relative judgment is where models have signal; that's why UI-Bench
is pairwise by design. Run it as an **opt-in command with an explicit
reference and a hard round cap** — never as an ambient gate. The `critic`
agent in `agents/` is the judge role for that loop.

## 8. Racing (optional, for the hard or ambiguous)

For tasks where iteration count hurts (UI polish, ambiguous specs), race
N cheap workers on the same brief in N worktrees. Orca's recipe: same prompt,
different agents/models, compare diffs, merge the winner, delete the rest.

Gatekeeper improves the economics: workers that fail gates are discarded
unseen — you only compare survivors. Where the survivors agree, it's probably
right; where they split, you've found the actual hard part.

## 9. Scheduled upkeep

Orca automations run prompts on cron against a repo or workspace. Useful
standing jobs:

- weekly dispatch-log analysis (`scripts/analyze.py` output, summarized to
  the worktree comment),
- stale dispatch-branch cleanup,
- issue triage from the tracker.

## 10. Cost discipline

- MCP schemas dominate worker bills: every active server ships its full tool
  schema every turn. Workers go light (code navigation and little else);
  the orchestrator carries the diagnostic tools.
- The log answers the only question that matters: does delegation save money,
  or burn it in retries? Watch success rate per model, cost concentration
  per task, and retry hotspots. Escalating a failing task to a premium model
  without fixing the brief pays premium price for the same failure — measured
  at 400× the cost, with a lower pass rate.
