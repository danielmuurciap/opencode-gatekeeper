# Agent instructions

You are working in a repo that dispatches implementation work to cheap
workers in Orca worktrees, verified by the gatekeeper plugin.

Before dispatching anything, read `skills/craft-brief/SKILL.md`. The rules
that are never broken:

- The brief carries the four parts (files, pattern-by-path, decisions,
  executable acceptance) or it does not ship.
- The dispatcher writes the exam; the worker never edits it
  (`.gatekeeper-protected`). Red before dispatch.
- Dispatch through the Orca TUI path (`orca worktree create --agent opencode`,
  then `orca terminal send`). One-shot `opencode run` never fires the gates.
- A failed gate means fix the brief and re-dispatch — never hand-patch the
  worker's output.
- The implementer never audits its own diff.
- Never delegate: talking to whoever asked, deciding what to build, and
  verifying results.

The full flow is in `docs/ORCHESTRATION.md`.
