---
name: craft-brief
description: Turn a task into a brief a cheap worker can execute and you can verify without reading its code. Use BEFORE dispatching any work to a worker, and whenever a worker's output must be accepted or rejected.
---

# Craft a verifiable brief

The economics of delegation live or die here. A poorly-specified brief goes
to a cheap model, comes back wrong with a green self-report, and you pay the
debugging — more than doing it yourself. A well-specified brief makes free
models match paid ones (measured: identical production code from a free and
a paid model on the same well-formed brief).

## The four mandatory parts

1. **Exact files** — which to touch, and explicitly which NOT to.
2. **The pattern, by path** — "replicate `src/hooks/useQuota.js`", never
   "follow repo conventions". A convention reference is a decision you're
   smuggling onto the worker.
3. **Decisions, pre-made** — every choice written down. If the worker must
   decide anything, the brief is not ready: decide it yourself or escalate
   only that decision to a strong model.
4. **Executable acceptance** — a command that exits 0/1. Seed it via
   `.gatekeeper-verify` (and `.gatekeeper-protected` for exams the worker
   must not edit).

Name edge cases one by one — unnamed edge cases do not exist for the worker.

## The exam (strong form of part 4)

Write the test yourself. Seed it in the worktree BEFORE the brief. The brief
becomes: "make this test pass with the minimum change; do not modify the test."

- **Red first.** Run the exam before dispatching. If it passes already, abort:
  it's tautological or the work is done.
- **Flow level, not piece level.** "The summary shows the new amount", not
  "component X exists". Piece-level exams pass on unwired components.
- **Validate the exam.** Break the code on purpose; the exam must fail. An
  exam that can't fail verifies nothing — including mocks asserting mocks.
- **Protect it.** List it in `.gatekeeper-protected`. Workers under pressure
  edit exams — measured, including inlining the implementation into the test
  file to dodge a missing module.

## Acceptance patterns by work type

| Work | Cheapest unfakeable check |
|---|---|
| Pure logic | unit test on values |
| API endpoint | `curl` + assert on the JSON |
| Mechanical change / rename | the build or typecheck |
| Refactor | the existing suite, before and after |
| UI / component | a Playwright flow test — unit tests say nothing about wiring or rendering |

## Scope guards (learned the hard way)

- Tell the worker what NOT to run: an unscoped "make the test pass" sent a
  worker into the repo's full test suite.
- Forbid commits explicitly. Review is diff-based; a commit breaks it.
- One brief, one outcome, small enough to verify in one review.

## Accepting the result

The gates handle the mechanical part. What they can't check:

- Read the diff. Every changed line must trace to the brief.
- The implementer never audits itself — second opinions come from a fresh
  agent without the implementation context.
- A failed gate ⇒ fix the brief and re-dispatch. Hand-patching the output
  hides the brief's defect and guarantees a repeat.
