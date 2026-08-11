// opencode-gatekeeper — deterministic gates for agent dispatches.
//
// An OpenCode plugin that verifies every dispatch run in an Orca worktree:
// when the worker goes idle, it runs a set of deterministic checks (gates),
// appends one JSONL record with real metrics, updates the Orca board status,
// and optionally notifies. No gate uses a model: each one either fails or it
// doesn't. The worker's own report is never treated as verification.
//
// Why a plugin and not a wrapper script: a wrapper can only verify dispatches
// it launched itself. The plugin runs inside OpenCode, so gates fire no matter
// who launched the worker — the Orca desktop app, the mobile companion, the
// CLI, or a human typing into the TUI.
//
// The end-of-turn signal is `session.status` with `status.type === "idle"`.
// NOT the `session.idle` event: measured against OpenCode 1.18, a 3-step
// dispatch emitted 197 events and zero `session.idle`; a single status-idle
// arrived as the last event. Orca's own status plugin calls status-idle the
// canonical signal and session.idle the deprecated one.
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "fs"
import { homedir } from "os"
import { basename, dirname, extname, join } from "path"

// ── Configuration (env overrides) ────────────────────────────────────────────
const LOG = process.env.GATEKEEPER_LOG || `${homedir()}/.local/share/gatekeeper/dispatches.jsonl`
const DB = process.env.GATEKEEPER_DB || `${homedir()}/.local/share/opencode/opencode.db`
const NOTIFY = process.env.GATEKEEPER_NOTIFY !== "0"
const VERIFY_TIMEOUT = Number(process.env.GATEKEEPER_VERIFY_TIMEOUT || 300)

// Files the dispatcher seeds INSIDE the worktree before (or while) the worker
// runs. The worker is free to read them; the gates are what make lying about
// them useless.
//   .gatekeeper-verify    — one line: the acceptance command. Written by the
//                           dispatcher BEFORE launching. Exit 0 = pass.
//   .gatekeeper-protected — paths (relative, one per line) the worker must not
//                           touch. Typically the test you seeded: if the worker
//                           edits the exam, its green means nothing.
const VERIFY_FILE = ".gatekeeper-verify"
const PROTECTED_FILE = ".gatekeeper-protected"

const WEB = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte"]
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

export const Gatekeeper = async ({ $, directory }) => {
  // A dispatch is a session running in a DERIVED worktree opened by Orca.
  // Two signals, both required:
  //   1. ORCA_WORKTREE_ID — Orca injects it into every terminal it owns.
  //   2. the worktree is not the main checkout — that's where the human works,
  //      and human sessions must not trigger gates or pollute the log.
  if (!directory || !process.env.ORCA_WORKTREE_ID) return {}

  const sh = (strings, ...args) => $(strings, ...args).quiet().nothrow()

  // In a derived worktree `--git-dir` lives under `--git-common-dir/worktrees/…`;
  // in the main checkout both resolve to the same path.
  try {
    const common = (await sh`git -C ${directory} rev-parse --path-format=absolute --git-common-dir`).stdout.toString().trim()
    const own = (await sh`git -C ${directory} rev-parse --path-format=absolute --git-dir`).stdout.toString().trim()
    if (!common || !own || common === own) return {}
  } catch {
    return {}
  }

  // Captured when the plugin loads, before the worker touches anything.
  let initialHead = null
  try {
    initialHead = (await sh`git -C ${directory} rev-parse HEAD`).stdout.toString().trim()
  } catch {}

  const touched = new Set()
  let closed = false

  return {
    event: async ({ event }) => {
      if (event.type === "file.edited" && event.properties?.file) {
        touched.add(event.properties.file)
        return
      }
      if (event.type !== "session.status") return
      // Re-arm on `busy`: without this, a continued session would only be
      // gated on its first turn and every later turn would pass unchecked.
      if (event.properties?.status?.type === "busy") {
        closed = false
        return
      }
      if (event.properties?.status?.type !== "idle" || closed) return

      const sid = event.properties.sessionID
      // Subagents emit their own idle while the root worker keeps going.
      // Treating a child's idle as the end would close the record and run
      // gates on half-finished work. Only the root session closes.
      try {
        const parent = (await sh`sqlite3 ${DB} ${`SELECT COALESCE(parent_id,'') FROM session WHERE id='${sid}';`}`)
          .stdout.toString().trim()
        if (parent) return
      } catch {}

      closed = true
      const failures = []

      // ── Gate 1: writing nothing is a FAILURE, not a silent success.
      // Don't patch it up by hand: fix the brief and re-dispatch.
      if (touched.size === 0) failures.push("wrote_nothing")

      // ── Gate 2: the worker does not commit. A commit breaks diff-based
      // review, and undoing stops being `git checkout .`.
      let finalHead = null
      try {
        finalHead = (await sh`git -C ${directory} rev-parse HEAD`).stdout.toString().trim()
      } catch {}
      if (initialHead && finalHead && initialHead !== finalHead) failures.push("committed")

      // ── Gate 3a: the exam is intact. Checked BEFORE the acceptance command,
      // because if the worker edited the test its green means nothing.
      // Detection uses the file.edited events we already collect — git status
      // can't catch this: rewriting an untracked file leaves `?? file` identical.
      const protectedPath = join(directory, PROTECTED_FILE)
      let protectedList = []
      if (existsSync(protectedPath)) {
        protectedList = readFileSync(protectedPath, "utf8")
          .split("\n").map((l) => l.trim()).filter(Boolean)
        const violated = protectedList.filter((rel) => touched.has(join(directory, rel)))
        if (violated.length) failures.push(`protected_modified:${violated.join("|")}`)
      }

      // ── Gate 3: the acceptance command, written by the dispatcher BEFORE
      // launch. The cheapest gate there is: a boolean that doesn't require
      // reading the worker's code. A timeout is NOT a failure — reporting
      // "failed" when nothing was checked sends you hunting a bug that may
      // not exist.
      const verifyPath = join(directory, VERIFY_FILE)
      let verification = null
      if (existsSync(verifyPath)) {
        const cmd = readFileSync(verifyPath, "utf8").trim()
        if (cmd) {
          const r = await sh`timeout ${String(VERIFY_TIMEOUT)} sh -c ${`cd ${directory} && ${cmd}`}`
          if (r.exitCode === 124) {
            verification = "timeout"
            failures.push("verify_timeout")
          } else if (r.exitCode !== 0) {
            verification = "fail"
            failures.push("verify")
          } else {
            verification = "pass"
          }
        }
      }

      // ── Gate 4: the PROJECT's own linter, only on the files the worker
      // touched. Linting the whole repo would surface pre-existing warnings —
      // noise that teaches everyone to ignore the gate.
      //
      // A gate that cannot run NEVER passes silently: that's how a
      // `const a = ;` once got a green light (worktree without node_modules).
      // If there's no checker we say so; weak fallbacks are named too.
      const web = [...touched].filter((p) => WEB.includes(extname(p).toLowerCase()))
      const eslint = join(directory, "node_modules", ".bin", "eslint")
      let linter = null
      let unchecked = 0

      if (web.length && existsSync(eslint)) {
        const r = await sh`${eslint} ${web}`
        linter = r.exitCode === 0 ? "pass" : "fail"
        if (r.exitCode !== 0) failures.push("linter")
      } else if (web.length) {
        // No node_modules (worktree created with setup skipped). The base
        // repo's eslint does NOT work across worktrees — ESM module resolution
        // fails (measured). `node --check` only handles plain JS: JSX throws
        // ERR_UNKNOWN_FILE_EXTENSION even when the file is correct.
        const plain = web.filter((p) => [".js", ".mjs", ".cjs"].includes(extname(p).toLowerCase()))
        for (const p of plain) {
          const r = await sh`node --check ${p}`
          if (r.exitCode !== 0) {
            linter = "fail"
            if (!failures.includes("syntax")) failures.push("syntax")
          }
        }
        unchecked += web.length - plain.length
        if (linter === null && plain.length) linter = "node--check"
      }

      // Checks that need no node_modules and cost nothing.
      for (const p of touched) {
        const ext = extname(p).toLowerCase()
        if (ext === ".json") {
          try {
            JSON.parse(readFileSync(p, "utf8"))
          } catch {
            if (!failures.includes("invalid_json")) failures.push("invalid_json")
          }
        } else if (ext === ".sh" || ext === ".bash") {
          const r = await sh`bash -n ${p}`
          if (r.exitCode !== 0 && !failures.includes("invalid_bash")) failures.push("invalid_bash")
        } else if (ext === ".py") {
          const r = await sh`python3 -m py_compile ${p}`
          if (r.exitCode !== 0 && !failures.includes("invalid_python")) failures.push("invalid_python")
        }
      }
      if (unchecked) linter = linter ? `${linter}+${unchecked}_unchecked` : `${unchecked}_unchecked`

      // ── Metrics: the root session PLUS all descendants — a subagent costs
      // tokens too, and counting only the root under-reports every dispatch
      // that fanned out.
      let m = {}
      const sql = `
        WITH RECURSIVE tree(id) AS (
          SELECT '${sid}'
          UNION SELECT s.id FROM session s JOIN tree t ON s.parent_id = t.id
        )
        SELECT json_object(
          'duration_s', round((MAX(s.time_updated) - MIN(s.time_created))/1000.0, 1),
          'tokens', SUM(s.tokens_input + s.tokens_output + s.tokens_cache_read),
          'cost_usd', round(SUM(s.cost), 6),
          'subsessions', COUNT(*) - 1,
          'model', (SELECT json_extract(model,'$.providerID')||'/'||json_extract(model,'$.id')
                      FROM session WHERE id = '${sid}'),
          'variant', (SELECT json_extract(model,'$.variant') FROM session WHERE id = '${sid}'),
          'agent', (SELECT agent FROM session WHERE id = '${sid}')
        ) FROM session s JOIN tree t ON s.id = t.id;`
      for (const ms of [1500, 3000, 5000]) {
        await wait(ms)
        try {
          m = JSON.parse((await sh`sqlite3 ${DB} ${sql}`).stdout.toString().trim())
          if (m.duration_s != null) break
        } catch {}
      }

      const row = {
        ts: Math.floor(Date.now() / 1000),
        name: basename(directory),
        model: m.model ?? null,
        variant: m.variant ?? null,
        agent: m.agent ?? null,
        dir: directory,
        exit: failures.length ? 1 : 0,
        failure_reason: failures.length ? failures.join(",") : null,
        gate: verification ? `verify:${verification}` : "no_gate",
        protected: protectedList.length,
        linter,
        duration_s: m.duration_s ?? null,
        files: touched.size,
        files_list: [...touched],
        tokens: m.tokens ?? null,
        cost_usd: m.cost_usd ?? null,
        subsessions: m.subsessions ?? 0,
        session_id: sid,
        source: "gatekeeper",
      }
      try {
        mkdirSync(dirname(LOG), { recursive: true })
        appendFileSync(LOG, JSON.stringify(row) + "\n")
      } catch {}

      // Board status: the Orca app becomes the dispatch board. Gates pass →
      // in-review (ready for human eyes); gates fail → stays in-progress and
      // the comment says WHY, so you fix the brief without digging in the log.
      try {
        const status = failures.length ? "in-progress" : "in-review"
        const note = failures.length
          ? `✗ gates: ${failures.join(", ")} · ${touched.size} file(s)`
          : `✓ gates ok · ${touched.size} file(s) · ready for review`
        await sh`orca worktree set --worktree ${`path:${directory}`} --comment ${note} --workspace-status ${status} --json`
      } catch {}

      if (NOTIFY && process.platform === "darwin") {
        const cost = row.cost_usd ? `$${row.cost_usd.toFixed(4)}` : "free"
        const title = failures.length ? `✗ ${row.name} — ${failures.join(", ")}` : `✓ ${row.name}`
        const body = `${row.files} file(s) · ${Math.round(row.duration_s ?? 0)}s · ${cost}`
        const sound = failures.length ? "Basso" : "Glass"
        try {
          await sh`osascript -e ${`display notification "${body}" with title "${title}" sound name "${sound}"`}`
        } catch {}
      }
    },
  }
}
