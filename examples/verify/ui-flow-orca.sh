#!/bin/sh
# Acceptance for UI work using ORCA'S OWN BROWSER — no Playwright needed.
#
# Why this over Playwright: Orca's browser is scoped PER WORKTREE, so parallel
# dispatches each verify in their own tab without fighting over a single shared
# browser instance (measured: two worktrees, two tabs, two independent
# snapshots, simultaneously). And the accessibility snapshot is text, not
# pixels — cheap to assert on and it fails for the right reasons.
#
# Flow level, not piece level: assert on what the user must SEE.
#
# Two traps, both measured:
#  - `orca` returns exit 0 with `"ok": false` in the body for some errors, so
#    a gate must parse the JSON — never trust orca's exit code alone.
#  - The snapshot mangles some non-ASCII (a literal "€" came back as "â‚¬"),
#    so match on the digits, not on currency symbols or accents.

URL="http://127.0.0.1:3000/checkout"
EXPECTED="18,00"

orca goto --worktree "path:$PWD" --url "$URL" --json >/dev/null 2>&1
sleep 2   # let the app render; prefer `orca wait --text` when you know the marker

orca snapshot --worktree "path:$PWD" --json 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
if not d.get('ok'):
    print('snapshot failed:', d.get('error')); sys.exit(1)
tree = json.dumps(d['result'])
sys.exit(0 if '$EXPECTED' in tree else 1)
"
