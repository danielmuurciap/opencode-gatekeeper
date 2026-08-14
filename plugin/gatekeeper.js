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
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync, utimesSync, rmSync } from "fs"
import { homedir } from "os"
import { basename, dirname, extname, join, relative } from "path"

// ── Configuration (env overrides) ────────────────────────────────────────────
const LOG = process.env.GATEKEEPER_LOG || `${homedir()}/.local/share/gatekeeper/dispatches.jsonl`
const DB = process.env.GATEKEEPER_DB || `${homedir()}/.local/share/opencode/opencode.db`
const NOTIFY = process.env.GATEKEEPER_NOTIFY !== "0"
const VERIFY_TIMEOUT = Number(process.env.GATEKEEPER_VERIFY_TIMEOUT || 300)

// ── Feedback loop ────────────────────────────────────────────────────────────
// A gate that runs after the worker left teaches nobody. Handing the real
// failure back to the same session and letting it fix itself is worth between
// +5 and +30 points depending on the benchmark, and nearly all of that lands
// in the first two rounds — hence the default cap of 2.
//
// Only failures the worker can actually act on are fed back. `wrote_nothing`
// and `committed` are bad briefs and bad process, not bugs: the rule is fix
// the brief and re-dispatch. `protected_modified` and `verify_removed` are
// cheating already detected — replaying them would just be coaching a retry.
// `verify_timeout` says nothing was measured, so there is nothing to hand back.
const FEEDBACK = process.env.GATEKEEPER_FEEDBACK !== "0"
const MAX_ROUNDS = Number(process.env.GATEKEEPER_MAX_ROUNDS || 2)
const FEEDABLE = new Set(["verify", "linter", "syntax", "invalid_json", "invalid_bash", "invalid_python"])

// Runners put the failure at the end. Head-truncating a 4000-line test log
// would hand back the part that says everything is fine.
const tail = (s, lines = 40, chars = 3000) => {
  const t = (s || "").trim().split("\n").slice(-lines).join("\n")
  return t.length > chars ? "…\n" + t.slice(-chars) : t
}

// Evidence is arbitrary test output that ends up in a file the worker reads.
// Prefixing every line keeps it visibly quoted — a line starting with `$`, `!`
// or `/` reads like an instruction, and the point of handing back evidence is
// that the worker treats it as a symptom, not as an order.
const quote = (s) => s.split("\n").map((l) => `| ${l}`).join("\n")

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
//   .gatekeeper-failure   — written BY the plugin when a gate fails and the
//                           failure is handed back: the full output the worker
//                           has to read. Rewritten each round.
const FAILURE_FILE = ".gatekeeper-failure.txt"

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

  // Same reason, and `touched` cannot replace it: a shell `rm` emits no
  // file.edited event, so deleting the exam is invisible to protected_modified
  // even when the exam is listed there. Measured 13-ago-2026 — the worker
  // removed a protected .gatekeeper-verify and the board said "✓ gates ok".
  const hadVerify = existsSync(join(directory, VERIFY_FILE))

  const touched = new Set()
  let closed = false
  let marcadoEnCurso = false
  // Rounds already handed back to THIS session. Lives in the closure, so it
  // resets when the worker is relaunched — a fresh dispatch gets a fresh cap.
  let round = 0

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
        // Clear the previous verdict from the board. The comment is only
        // written when a dispatch CLOSES, so a reused worktree kept showing
        // "✓ gates ok" from the run before while the new worker was still
        // working — a green that belongs to someone else's work. Reported
        // from a real dispatch, 13-ago-2026.
        if (!marcadoEnCurso) {
          marcadoEnCurso = true
          try {
            const t = round ? `⋯ corrigiendo · ronda ${round}/${MAX_ROUNDS}` : "⋯ trabajando · veredicto anterior descartado"
            await sh`orca worktree set --worktree ${`path:${directory}`} --comment ${t} --workspace-status in-progress --json`
          } catch {}
        }
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
      marcadoEnCurso = false   // el próximo turno vuelve a limpiar el veredicto
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
      let baseline = false
      // What the gate actually printed, kept to hand back. Without this the
      // worker would only learn the NAME of the gate it failed, which is the
      // one thing it cannot act on.
      const evidence = []
      if (existsSync(verifyPath)) {
        const raw = readFileSync(verifyPath, "utf8")
        // A repo-seeded baseline exam measures non-regression, not achievement:
        // it was green before the work started, so passing it proves far less
        // than passing an exam written for this task. Both would otherwise
        // reach the board as the same "✓ gates ok" — which is the very failure
        // "no exam is not a pass" fixed, walking back in through the door we
        // opened by seeding a default. The seeder marks it; we say which it was.
        baseline = /^#\s*gatekeeper:baseline\b/m.test(raw)
        const cmd = raw.trim()
        if (cmd) {
          const r = await sh`timeout ${String(VERIFY_TIMEOUT)} sh -c ${`cd ${directory} && ${cmd}`}`
          if (r.exitCode === 124) {
            verification = "timeout"
            failures.push("verify_timeout")
          } else if (r.exitCode !== 0) {
            verification = "fail"
            failures.push("verify")
            evidence.push(quote(`comando: ${cmd}\n${tail(r.stdout?.toString() + "\n" + r.stderr?.toString())}`))
          } else {
            verification = "pass"
          }
        }
      } else if (hadVerify) {
        // The exam was there at launch and is gone now. Absence of evidence is
        // a failure, same rule as wrote_nothing — never a silent pass.
        verification = "removed"
        failures.push("verify_removed")
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
        if (r.exitCode !== 0) {
          failures.push("linter")
          evidence.push(quote(`comando: eslint\n${tail(r.stdout?.toString() + "\n" + r.stderr?.toString())}`))
        }
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
            evidence.push(quote(`comando: node --check ${relative(directory, p)}\n${tail(r.stderr?.toString(), 15)}`))
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
          } catch (e) {
            if (!failures.includes("invalid_json")) failures.push("invalid_json")
            evidence.push(quote(`comando: JSON.parse ${relative(directory, p)}\n${e.message}`))
          }
        } else if (ext === ".sh" || ext === ".bash") {
          const r = await sh`bash -n ${p}`
          if (r.exitCode !== 0) {
            if (!failures.includes("invalid_bash")) failures.push("invalid_bash")
            evidence.push(quote(`comando: bash -n ${relative(directory, p)}\n${tail(r.stderr?.toString(), 15)}`))
          }
        } else if (ext === ".py") {
          const r = await sh`python3 -m py_compile ${p}`
          if (r.exitCode !== 0) {
            if (!failures.includes("invalid_python")) failures.push("invalid_python")
            evidence.push(quote(`comando: python3 -m py_compile ${relative(directory, p)}\n${tail(r.stderr?.toString(), 15)}`))
          }
        }
      }
      if (unchecked) linter = linter ? `${linter}+${unchecked}_unchecked` : `${unchecked}_unchecked`

      // ── Board status FIRST. The verdict is already decided here; the metrics
      // below wait up to 9.5s for OpenCode's DB to catch up, and making the
      // board wait with them delays the only thing you're watching for.
      //
      // No exam means nothing was checked — saying "gates ok" there is how a
      // dispatch nobody verified ends up looking exactly like a verified one.
      // Measured 13-ago-2026: 116 of 239 dispatches read "✓ gates ok" with
      // gate "no_gate". The board is the surface you actually look at.
      //
      // A red that is about to fix itself must not look like a red waiting for
      // you. `↻ ronda` is the difference between "go look at it" and "leave it
      // alone for one more turn".
      const feedable = failures.length > 0 && failures.every((f) => FEEDABLE.has(f.split(":")[0]))
      const willFeedback =
        FEEDBACK && feedable && evidence.length > 0 &&
        round < MAX_ROUNDS && !!process.env.ORCA_TERMINAL_HANDLE

      const note = willFeedback
        ? `↻ ronda ${round + 1}/${MAX_ROUNDS} · ${failures.join(", ")} · devuelto al worker`
        : failures.length
          ? `✗ gates: ${failures.join(", ")} · ${touched.size} file(s)`
          : verification
            ? baseline
              ? `✓ examen base · ${touched.size} file(s) · sin examen de tarea`
              : `✓ gates ok · ${touched.size} file(s) · ready for review`
            : `⚠ sin examen · ${touched.size} file(s) · solo gates parciales`
      try {
        const status = failures.length ? "in-progress" : "in-review"
        await sh`orca worktree set --worktree ${`path:${directory}`} --comment ${note} --workspace-status ${status} --json`
      } catch {}

      // ── Freeze what the worker delivered as a real Git tree object, so it can
      // still be compared after the worktree is gone. Without this there is no
      // way to tell later whether the work survived into the base branch, was
      // edited on top, or was thrown away — the dirty tree dies with the
      // worktree. Technique from gentle-ai (internal/reviewtransaction/
      // snapshot.go): copy the index aside and work against the copy, so the
      // live index and the worktree are never touched.
      //
      // Preserving the copied index's mtime is load-bearing, not tidiness:
      // Git's racily-clean check keys off it, and without it `add -u` can reuse
      // stale cached content and write a tree that doesn't match the files.
      let baseTree = null
      let candidateTree = null
      let branchName = null
      let deliveryRef = null
      try {
        branchName = (await sh`git -C ${directory} rev-parse --abbrev-ref HEAD`).stdout.toString().trim() || null
        baseTree = (await sh`git -C ${directory} rev-parse HEAD^{tree}`).stdout.toString().trim() || null
        const gitDir = (await sh`git -C ${directory} rev-parse --path-format=absolute --git-dir`).stdout.toString().trim()
        const liveIndex = join(gitDir, "index")
        const tmpIndex = join(gitDir, `gatekeeper-index-${sid}`)
        if (existsSync(liveIndex)) {
          copyFileSync(liveIndex, tmpIndex)
          const st = statSync(liveIndex)
          utimesSync(tmpIndex, st.atime, st.mtime)
          // `env VAR=…` as an argv prefix rather than the shell's .env() helper:
          // if that helper were missing or chained wrong the whole block would
          // fall into the catch and silently record no tree at all.
          const idx = `GIT_INDEX_FILE=${tmpIndex}`
          // Tracked changes, then the untracked files the worker created.
          // No -f: ignored files (node_modules, .env) are not part of delivery.
          await sh`env ${idx} git -C ${directory} add -u -- .`
          const rel = [...touched]
            .map((p) => relative(directory, p))
            .filter((p) => p && !p.startsWith(".."))
          if (rel.length) await sh`env ${idx} git -C ${directory} add -- ${rel}`
          const wt = await sh`env ${idx} git -C ${directory} write-tree`
          candidateTree = wt.stdout.toString().trim() || null
          rmSync(tmpIndex, { force: true })

          // Anchor it. A bare tree object is unreachable, and `git gc` prunes
          // it — measured: after `gc --prune=now` the tree was gone and the SHA
          // in the log pointed at nothing. Wrapping it in a commit under
          // refs/gatekeeper/ makes it survive, and gives `git diff <ref>^ <ref>`
          // as the delivered diff for free.
          if (candidateTree) {
            const parent = initialHead ? ["-p", initialHead] : []
            const c = await sh`git -C ${directory} commit-tree ${candidateTree} ${parent} -m ${`gatekeeper: ${basename(directory)} @ ${sid}`}`
            const commit = c.stdout.toString().trim()
            if (commit) {
              deliveryRef = `refs/gatekeeper/${basename(directory)}/${Math.floor(Date.now() / 1000)}`
              await sh`git -C ${directory} update-ref ${deliveryRef} ${commit}`
            }
          }
        }
      } catch {}

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
        gate: verification ? `verify${baseline ? ":baseline" : ""}:${verification}` : "no_gate",
        protected: protectedList.length,
        linter,
        // Which correction round produced this row, and whether the failure was
        // handed back. Without them a self-corrected dispatch is indistinguishable
        // from one that got it right the first time — and the difference is the
        // whole point of measuring the loop.
        round: round + 1,
        feedback: willFeedback,
        // Frozen delivery. `candidate_tree` outlives the worktree, so weeks
        // later you can still ask whether this work survived into the base
        // branch, was edited on top of, or never landed at all.
        base_tree: baseTree,
        candidate_tree: candidateTree,
        delivery_ref: deliveryRef,
        branch: branchName,
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

      // ── Hand the failure back. Last, on purpose: the delivery tree and the
      // log row for THIS round are already frozen, so restarting the worker
      // cannot blur them into the next one.
      //
      // The escape-hatch sentence is not politeness. Frontier agents route
      // around read-only files 40–94% of the time — not by editing them, but by
      // adding a conftest, a global monkeypatch, or patching cached bytecode
      // next to them. Of every mitigation tested, an explicit "stop and tell me"
      // was the only one that took evasion to zero. It matters more here than
      // in the brief: a worker being told "you failed, fix it" is exactly the
      // worker under pressure to find a shortcut. And OpenCode workers have no
      // hook to inject it, so this is the only place they ever hear it.
      if (willFeedback) {
        round++
        // The evidence goes to a FILE and the prompt is a single line. Measured
        // 14-ago-2026, twice: a multi-line --text never reaches the model — the
        // TUI passes it through to the shell, which answered `command not found:
        // El` to the first word of the message. One-line sends land correctly.
        // Writing it out also removes the size limit and the escaping problem,
        // and the file never enters the delivery tree (it is neither tracked nor
        // in `touched`), so it cannot pollute the diff under review.
        const body = [
          `Gate fallido: ${failures.join(", ")}   ·   corrección automática ${round}/${MAX_ROUNDS}`,
          "",
          evidence.join("\n\n"),
        ].join("\n")
        try {
          writeFileSync(join(directory, FAILURE_FILE), body + "\n")
        } catch {}
        const msg =
          `El gate automático falló al terminar tu turno (${failures.join(", ")}); no es opinión, es la salida real y la tienes entera en ${FAILURE_FILE}: léela, arregla el código y termina. ` +
          `No toques el examen ni ningún fichero protegido. Si para que pase necesitas tocar un fichero protegido, o añadir algo que cambie cómo se ejecuta (un conftest, un mock global, config de test): PARA Y AVISA, no lo rodees. ` +
          `Si crees que el examen está mal, dilo y no sigas. Corrección automática ${round} de ${MAX_ROUNDS}.`
        try {
          await sh`orca terminal send --terminal ${process.env.ORCA_TERMINAL_HANDLE} --text ${msg} --enter --json`
        } catch {}
      }

      // Only ring when the answer changes what you do. Orca's own
      // agentTaskComplete already fires at idle for every dispatch, so a clean
      // pass would be the second sound saying the same "it's done, nothing to
      // decide" — and two sounds for "all good" is how you learn to ignore the
      // one that isn't. A handed-back round is not waiting for you either.
      // What still rings: a real failure, and a pass nobody verified.
      const worthRinging = (failures.length && !willFeedback) || (!failures.length && !verification)

      if (NOTIFY && worthRinging && process.platform === "darwin") {
        const cost = row.cost_usd ? `$${row.cost_usd.toFixed(4)}` : "free"
        const title = failures.length
          ? `✗ ${row.name} — ${failures.join(", ")}`
          : `⚠ ${row.name} — sin examen`
        const body = `${row.files} file(s) · ${Math.round(row.duration_s ?? 0)}s · ${cost}`
        const sound = failures.length ? "Basso" : "Glass"
        try {
          await sh`osascript -e ${`display notification "${body}" with title "${title}" sound name "${sound}"`}`
        } catch {}
      }
    },
  }
}
