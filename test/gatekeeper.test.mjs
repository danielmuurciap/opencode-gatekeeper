import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "child_process"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { despachar, crearWorktree, crearShell, comentarioTablero, estadoTablero, textoRealimentado } from "./harness.mjs"

const PLUGIN = new URL("../plugin/gatekeeper.js", import.meta.url).href
const URL_G = `${PLUGIN}?t=${Date.now()}`

// `despachar` no deja hueco para actuar entre el arranque del plugin y el idle,
// y dos comportamientos (committed, verify_removed) viven exactamente ahí:
// la comparación de HEAD y `hadVerify` se capturan al cargar, así que hay que
// comitear / borrar el examen después de cargar y antes de cerrar el turno.
async function despacharConGancho({ verify, ficheros = {}, env = {}, alMedio }) {
  const w = crearWorktree()
  const logPath = join(w.raiz, "log.jsonl")
  const anterior = { ...process.env }
  Object.assign(process.env, {
    ORCA_WORKTREE_ID: "prueba",
    ORCA_TERMINAL_HANDLE: "term_prueba",
    GATEKEEPER_LOG: logPath,
    GATEKEEPER_NOTIFY: "0",
    ...env,
  })
  try {
    if (verify !== undefined) writeFileSync(join(w.wt, ".gatekeeper-verify"), verify)
    for (const [nombre, contenido] of Object.entries(ficheros)) writeFileSync(join(w.wt, nombre), contenido)
    const { $, registro } = crearShell(w.wt)
    const { Gatekeeper } = await import(`${URL_G}${Math.random()}`)
    const g = await Gatekeeper({ $, directory: w.wt })
    await g.event({ event: { type: "file.edited", properties: { file: join(w.wt, Object.keys(ficheros)[0]) } } })
    await alMedio(w.wt)
    await g.event({ event: { type: "session.status", properties: { status: { type: "idle" }, sessionID: "s1" } } })
    const filas = existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : []
    return { filas, fila: filas[filas.length - 1], registro, w }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in anterior)) delete process.env[k]
    Object.assign(process.env, anterior)
  }
}

test("un examen que pasa deja el despacho listo para revisar, sin sonar", async () => {
  const r = await despachar({
    verify: "exit 0\n",
    ficheros: { "a.js": "const a = 1\n" },
    env: { GATEKEEPER_NOTIFY: "1" },
  })
  assert.equal(r.fila.gate, "verify:pass")
  assert.equal(r.fila.exit, 0)
  assert.equal(r.fila.feedback, false)
  assert.equal(estadoTablero(r.registro), "in-review")
  assert.ok(!r.registro.argv.some((a) => a[0] === "osascript"), "un pase en verde no debe notificar")
  r.w.limpiar()
})

test("no escribir nada es un fallo, no un éxito silencioso", async () => {
  const r = await despachar({ verify: "exit 0\n", ficheros: {}, tocados: [] })
  assert.match(r.fila.failure_reason, /wrote_nothing/)
  assert.equal(r.fila.exit, 1)
  assert.equal(r.fila.feedback, false)
  r.w.limpiar()
})

test("comitear es un fallo", async () => {
  const r = await despacharConGancho({
    ficheros: { "a.js": "const a = 1\n" },
    alMedio: (wt) => {
      execFileSync("git", ["add", "-A"], { cwd: wt })
      execFileSync("git", ["commit", "-qm", "trampa"], { cwd: wt })
    },
  })
  assert.match(r.fila.failure_reason, /committed/)
  assert.equal(r.fila.exit, 1)
  r.w.limpiar()
})

test("tocar un fichero protegido invalida el verde, aunque el examen pase", async () => {
  const r = await despachar({
    verify: "exit 1\n",
    protegidos: "a.js\n",
    ficheros: { "a.js": "const a = 1\n" },
    tocados: ["a.js"],
  })
  assert.match(r.fila.failure_reason, /protected_modified:a\.js/)
  assert.equal(r.fila.exit, 1)
  assert.equal(r.fila.feedback, false)
  assert.equal(estadoTablero(r.registro), "in-progress")
  r.w.limpiar()
})

test("expirar no es fallar: el timeout se distingue de un verify en rojo", async () => {
  const r = await despachar({
    verify: "exit 124\n",
    ficheros: { "a.js": "const a = 1\n" },
    env: { GATEKEEPER_VERIFY_TIMEOUT: "1" },
  })
  assert.equal(r.fila.gate, "verify:timeout")
  assert.match(r.fila.failure_reason, /verify_timeout/)
  assert.doesNotMatch(r.fila.failure_reason, /^verify$/m)
  r.w.limpiar()
})

test("el examen va envuelto en timeout con la duración configurada", async () => {
  const r = await despachar({
    verify: "exit 0\n",
    ficheros: { "a.js": "const a = 1\n" },
    env: { GATEKEEPER_VERIFY_TIMEOUT: "1" },
  })
  const envoltorio = r.registro.argv.find((a) => a[0] === "timeout")
  assert.ok(envoltorio, "el verify debe ejecutarse bajo timeout")
  assert.equal(envoltorio[1], "1")
  assert.equal(envoltorio[2], "sh")
  assert.equal(envoltorio[3], "-c")
  r.w.limpiar()
})

test("el plugin se autodesactiva en el checkout principal", async () => {
  const w = crearWorktree()
  const anterior = { ...process.env }
  Object.assign(process.env, { ORCA_WORKTREE_ID: "prueba", GATEKEEPER_NOTIFY: "0" })
  try {
    const { $ } = crearShell(w.base)
    const { Gatekeeper } = await import(`${URL_G}${Math.random()}`)
    const g = await Gatekeeper({ $, directory: w.base })
    assert.equal(g.event, undefined)
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in anterior)) delete process.env[k]
    Object.assign(process.env, anterior)
    w.limpiar()
  }
})

test("sin examen no es aprobado: no_gate y el tablero avisa", async () => {
  const r = await despachar({ ficheros: { "a.js": "const a = 1\n" } })
  assert.equal(r.fila.gate, "no_gate")
  assert.equal(r.fila.exit, 0)
  const comentario = comentarioTablero(r.registro)
  assert.match(comentario, /sin examen/)
  assert.doesNotMatch(comentario, /gates ok/)
  r.w.limpiar()
})

test("el examen borrado no pasa en silencio", async () => {
  const r = await despacharConGancho({
    verify: "exit 0\n",
    ficheros: { "a.js": "const a = 1\n" },
    alMedio: (wt) => execFileSync("rm", [join(wt, ".gatekeeper-verify")]),
  })
  assert.equal(r.fila.gate, "verify:removed")
  assert.match(r.fila.failure_reason, /verify_removed/)
  assert.equal(r.fila.feedback, false)
  r.w.limpiar()
})

test("el fallo vuelve al worker: feedback, terminal send y ronda en el tablero", async () => {
  const r = await despachar({ verify: "exit 1\n", ficheros: { "a.js": "const a = 1\n" } })
  assert.equal(r.fila.feedback, true)
  assert.equal(r.fila.failure_reason, "verify")
  assert.equal(r.registro.enviados.length, 1)
  assert.match(textoRealimentado(r.registro), /verify/)
  assert.match(comentarioTablero(r.registro), /ronda/)
  r.w.limpiar()
})

test("el tope de rondas se respeta: solo se realimenta una vez", async () => {
  const r = await despachar({
    verify: "exit 1\n",
    ficheros: { "a.js": "const a = 1\n" },
    env: { GATEKEEPER_MAX_ROUNDS: "1" },
    turnos: 2,
  })
  assert.equal(r.filas.length, 2)
  assert.equal(r.filas[0].feedback, true)
  assert.equal(r.filas[0].round, 1)
  assert.equal(r.filas[1].feedback, false)
  assert.equal(r.filas[1].round, 2)
  assert.equal(r.filas[1].exit, 1)
  assert.equal(r.registro.enviados.length, 1)
  r.w.limpiar()
})

test("el examen base se distingue del examen de tarea", async () => {
  const r = await despachar({
    verify: "# gatekeeper:baseline\nexit 0\n",
    ficheros: { "a.js": "const a = 1\n" },
  })
  assert.equal(r.fila.gate, "verify:baseline:pass")
  assert.equal(r.fila.exit, 0)
  assert.match(comentarioTablero(r.registro), /examen base/)
  r.w.limpiar()
})

test("la entrega se congela en un árbol y un ref", async () => {
  const r = await despachar({ verify: "exit 0\n", ficheros: { "a.js": "const a = 1\n" } })
  assert.match(r.fila.candidate_tree, /^[0-9a-f]{40}$/)
  assert.match(r.fila.delivery_ref, /^refs\/gatekeeper\//)
  assert.match(r.fila.base_tree, /^[0-9a-f]{40}$/)
  r.w.limpiar()
})
