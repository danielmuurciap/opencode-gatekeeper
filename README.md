# opencode-gatekeeper

Deterministic gates for AI agent dispatches. An [OpenCode](https://opencode.ai)
plugin that verifies every worker run in an [Orca](https://github.com/stablyai/orca)
worktree — **the worker's own report is never the verification**.

When a dispatched worker finishes, gatekeeper:

1. runs a set of deterministic **gates** (no model involved — each one fails or it doesn't),
2. appends one JSONL record with **real metrics** (duration, tokens, cost, files, subagents),
3. updates the **Orca board** (`in-review` when gates pass, `in-progress` + reason when they fail),
4. optionally fires a desktop notification with the verdict.

Built on evidence, not vibes: in our measurements, cheap workers produced code
that crashed **while reporting success**, and 43 repo security guardians
approved it. A dispatcher-written test seeded before launch took the same
models from broken-with-green-report to 9/9 passing. The deciding factor is
who writes the exam — never the worker.

## Why

Delegating to cheap models works — our logs show free workers matching paid
ones when the brief is right, at 1/400th the cost of escalating to a premium
model. What breaks the economics is **unverified green**: a worker that says
"done, tests pass" and is wrong costs you the debugging afterwards. Gatekeeper
makes the green mean something.

The plugin runs inside OpenCode, so gates fire **no matter who launched the
worker** — the Orca desktop app, the mobile companion, a CLI, an orchestrating
agent, or you typing into the TUI. There is no wrapper script to remember.

## Install

**Per project** (loads for everyone who clones the repo):

```
mkdir -p .opencode/plugins
cp plugin/gatekeeper.js .opencode/plugins/
```

**Per machine** (all projects):

```
mkdir -p ~/.config/opencode/plugins
cp plugin/gatekeeper.js ~/.config/opencode/plugins/
```

npm install (`"plugin": ["opencode-gatekeeper"]` in `opencode.json`) is planned.

Requirements: OpenCode ≥ 1.18, Orca (the plugin activates only inside
Orca-managed derived worktrees), `sqlite3` on PATH (preinstalled on macOS).

## The dispatch flow

```bash
# 1. Create the worktree with the agent waiting (no prompt yet)
orca worktree create --name fix-quota --repo path:$REPO --agent opencode --json
#    → note result.agentTerminalHandle

# 2. Seed the exam — the dispatcher writes it, the worker must not
cp quota.test.js $WT/
echo 'quota.test.js'      > $WT/.gatekeeper-protected
echo 'node quota.test.js' > $WT/.gatekeeper-verify

# 3. Red first: if the exam already passes, it's tautological or the work is done
node $WT/quota.test.js && echo "ABORT: exam is already green" 

# 4. Send the brief
orca terminal send --terminal $HANDLE --text "Make quota.test.js pass. ..." --enter
```

The plugin does the rest when the worker goes idle. For simple dispatches,
skip steps 2–3 and pass `--prompt` directly on `worktree create`.

## Gates

| Gate | Cuts when | Why |
|---|---|---|
| `wrote_nothing` | zero `file.edited` events | The most silent failure there is. Fix the brief, don't patch by hand. |
| `committed` | HEAD moved | A commit breaks diff review; undo stops being `git checkout .` |
| `protected_modified` | worker edited a path in `.gatekeeper-protected` | If the worker edits the exam, its green means nothing. `git status` can't catch this on untracked files — events can. Catches **rewrites**, not deletions: a shell `rm` emits no `file.edited` event. |
| `verify` / `verify_timeout` | `.gatekeeper-verify` exits non-zero / times out | Your acceptance boolean. **Timeout is reported separately — "not checked" is not "failed".** |
| `verify_removed` | the exam was present at launch and gone at idle | Closes the hole `protected_modified` cannot see. Absence of evidence is a failure, same rule as `wrote_nothing`. |
| `linter` | project's own eslint fails on touched files | Only touched files: whole-repo lint surfaces pre-existing noise that teaches people to ignore the gate. |
| `syntax` / `invalid_json` / `invalid_bash` / `invalid_python` | fallback checks without node_modules | A gate that cannot run **never passes silently** — uncheckable files are counted and named. |

All eight gates (plus the pass-through control) are covered by break-tests:
each one was made to fail on purpose before shipping, including a real
exam-tampering case where the worker inlined the implementation into the test
file — caught by `protected_modified` while `verify` showed green.

### No exam is not a pass

A dispatch with no `.gatekeeper-verify` used to reach the board as
`✓ gates ok`. Measured over 239 real dispatches: **193 ran with no exam and
116 of those were announced green.** Work nobody checked looked exactly like
verified work on the one surface you actually watch.

The board now says **`⚠ sin examen · solo gates parciales`**, and so does the
desktop notification. It is not a failure — the other gates still run and still
cut — it is a refusal to call *unchecked* the same thing as *checked*. The log
already distinguished it as `gate: "no_gate"`; the board did not.

### Nor is a stale verdict a pass

The board comment is written when a dispatch **closes**. Reuse a worktree — a
follow-up turn, a second dispatch — and until the new run finished the card kept
showing the previous run's `✓ gates ok`: a green that belongs to someone else's
work, on a worker that had not written a line yet. Reported from a real dispatch
where it cost real time.

The plugin now clears it on the first `busy` of each run
(`⋯ trabajando · veredicto anterior descartado`, status `in-progress`) and the
real verdict replaces it on close. Verified live: `✓ gates ok` → `⋯ trabajando`
4s after the brief landed → new `✓ gates ok` on close.

### The baseline exam

`orca.yaml` seeds a baseline exam into every worktree. It measures
non-regression — the tree stays green before and after the work — not
achievement, so it passes trivially on any change that does not break the
baseline. A task-specific exam in the brief intentionally overrides it and
becomes the real bar.

Seed it from `orca.yaml` at the repo root, so it lands in every worktree Orca
creates — CLI, issue drawer, automation or the mobile companion alike:

```yaml
scripts:
  setup: |
    set -e
    printf 'npm run lint --silent\n' > .gatekeeper-verify
    printf '.gatekeeper-verify\n.gatekeeper-protected\n' > .gatekeeper-protected
```

Two conditions, both of which cost us a debugging round: `orca.yaml` must be
**pushed** (a worktree is cut from the remote branch, so a local-only commit
isn't there), and the repo must not be set to
`hookSettings.commandSourcePolicy: "local-only"` — under that policy `scripts:`
is ignored **with no error**.

## The silence of a worker is not success

Gates fire when a dispatch ends. Nothing fires when it never ends — a worker
sitting on an unanswered permission prompt looks exactly like a worker thinking
hard. Orca already knows the difference and `orca worktree ps --json` already
says so: `status` is the max over its panes
(`inactive < active < done < working < permission`), and each agent carries
`state` (`working|blocked|waiting|done`) with `stateStartedAt`.

[`scripts/watch-dispatches.sh`](scripts/watch-dispatches.sh) boils that down to
one line per worktree that needs a human, and prints nothing when nothing does.
It exits **0 when it found something** — inverted on purpose, so it can be the
`--precheck` of an Orca automation.

```
$ scripts/watch-dispatches.sh 15
ESPERANDO  fix-quota    7 min   HOKENFI   cpu 1.2   waiting
COLGADO    kyb-import   41 min  HOKENFI   cpu 0.4   sin cambio de estado
```

The CPU column comes from `orca diagnostics memory` — a second signal that does
not depend on the status hooks at all. 63% is real work; 1% next to a `working`
pane is a corpse.

## The log

One JSON line per dispatch in `~/.local/share/gatekeeper/dispatches.jsonl`:

```json
{ "ts": 1786466595, "name": "fix-quota", "model": "opencode-go/deepseek-v4-flash",
  "variant": "max", "exit": 0, "failure_reason": null, "gate": "verify:pass",
  "base_tree": "3256d72...", "candidate_tree": "9dfe92d...",
  "delivery_ref": "refs/gatekeeper/fix-quota/1786638153", "branch": "user/fix-quota",
  "duration_s": 96.4, "files": 3, "files_list": ["..."], "tokens": 812345,
  "cost_usd": 0.0031, "subsessions": 1, "session_id": "ses_...", "source": "gatekeeper" }
```

### The frozen delivery

`candidate_tree` is what the worker actually delivered, frozen as a real Git
tree the moment the gates ran. The dirty worktree dies when you remove the
worktree; this outlives it, so weeks later you can still ask whether that work
landed intact, was edited on top of, or never landed at all — which makes the
verdict **computable instead of self-reported**.

How, borrowed from gentle-ai's `reviewtransaction/snapshot.go`: copy
`.git/index` aside **preserving its mtime** (load-bearing — Git's racily-clean
check keys off it, and without it `add -u` can reuse stale cached content and
write a tree that doesn't match the files), then `GIT_INDEX_FILE=<tmp> git
add -u` plus the untracked paths the worker touched, then `write-tree`. The
live index and the worktree are never touched.

A bare tree is unreachable and **`git gc --prune=now` deletes it** — measured;
storing only the SHA would have been a perfectly silent data loss weeks later.
So it is wrapped in a commit and anchored at `refs/gatekeeper/<task>/<ts>`,
which survives both `gc` and `orca worktree rm`. `git diff <ref>^ <ref>` is the
delivered diff.

It measures whether code **survived**, not whether it was **good**: anything
you merge without reading counts as accepted.

`scripts/analyze.py` turns it into the numbers that matter: success rate per
model/variant, cost concentration, retry hotspots, which gate cuts most.
Without the log you cannot know whether delegation saves you money or burns it
in retries.

## Configuration

Environment variables (set them where OpenCode runs):

| Var | Default | |
|---|---|---|
| `GATEKEEPER_LOG` | `~/.local/share/gatekeeper/dispatches.jsonl` | log path |
| `GATEKEEPER_NOTIFY` | on | `0` disables desktop notifications |
| `GATEKEEPER_VERIFY_TIMEOUT` | `300` | seconds for the acceptance command |
| `GATEKEEPER_DB` | `~/.local/share/opencode/opencode.db` | OpenCode's DB |

## Agents

Four ready-to-use OpenCode agent definitions in [`agents/`](agents/) — the
roles of the review loop ("gauntlet") documented in
[`docs/ORCHESTRATION.md §7`](docs/ORCHESTRATION.md):

| Agent | Writes | For |
|---|---|---|
| `scout` | no | "where does X live / what breaks" — so briefs carry exact paths |
| `implementer` | yes | fully-specified changes; **refuses** briefs missing the four parts |
| `reviewer` | no | diff review with fresh eyes — the implementer never audits itself |
| `test-runner` | no | runs suites, returns only failures — output stays out of your context |
| `critic` | no | blind A/B judge vs a concrete reference, for opt-in gauntlet loops — never a default gate |

```
# per project                              # per machine
cp agents/*.md .opencode/agent/            cp agents/*.md ~/.config/opencode/agent/
```

All four are deny-by-default (no web, no delegation — `task: deny`; agents
that open agents open trees nobody controls). Writers dispatch through the
gated TUI path; read-only roles can use one-shot `opencode run --agent <x>`,
which is fine precisely because they write nothing.

## Docs

- [`docs/ORCHESTRATION.md`](docs/ORCHESTRATION.md) — the full flow: spec-driven
  changes (OpenSpec), briefs, dispatch, gates, the gauntlet review loop,
  racing, merge. How to run it with an orchestrating agent (Claude Code or
  any other) on top.
- [`skills/craft-brief/`](skills/craft-brief/SKILL.md) — how to write a brief
  a cheap worker can execute and you can verify without reading its code.
- [`examples/verify/`](examples/verify/) — acceptance commands per work type
  (API, UI flow, refactor, mechanical change).

## Sharp edges we already hit for you

- **`opencode run` (one-shot) does not fire the gates** — the process exits
  before emitting the idle status. Dispatch through the TUI:
  `orca worktree create --agent opencode`, then `orca terminal send`.
- **Subagent sessions emit their own idle.** Gatekeeper only closes on the
  root session; a `@explore` child finishing mid-task won't cut your dispatch
  short (and its tokens are counted).
- **Worktrees created with setup skipped have no `node_modules`**, so the
  eslint gate can't run there. Named fallbacks apply; prefer running setup.
- **Ambiguous briefs derail workers.** "Make the test pass" sent a worker off
  running the repo's whole suite. Scope explicitly: name files, forbid the rest.

## License

MIT
