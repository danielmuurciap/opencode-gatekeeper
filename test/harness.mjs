// Arnés de pruebas del gatekeeper.
//
// El plugin corre dentro de OpenCode, dentro de un worktree de Orca, y habla con
// git, sqlite3 y el CLI de orca. Probarlo de verdad costaba un despacho real de
// dos minutos por caso. Esto lo baja a ~2 s: git corre de verdad sobre un
// worktree derivado temporal, y todo lo demás se intercepta y se registra.
//
// Lo que NO se simula, a propósito: git. El plugin decide si activarse
// comparando --git-dir con --git-common-dir, y congela el árbol de entrega con
// write-tree y commit-tree. Un doble de git dejaría sin probar justo la parte
// que más veces se ha roto.
import { execFileSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const PLUGIN = new URL("../plugin/gatekeeper.js", import.meta.url).href

// Métricas del despacho: el plugin las sondea con hasta tres esperas
// (1,5 s + 3 s + 5 s) y para en cuanto obtiene duration_s. Devolver una fila
// válida a la primera deja cada caso en 1,5 s en vez de 9,5 s.
const METRICAS = '{"duration_s":1.0,"tokens":100,"cost_usd":0,"subsessions":0,"model":"prueba/modelo","variant":null,"agent":"build"}'

export function crearWorktree() {
  const raiz = mkdtempSync(join(tmpdir(), "gk-"))
  const base = join(raiz, "base")
  const wt = join(raiz, "wt")
  const sh = (c, cwd) => execFileSync("sh", ["-c", c], { cwd, encoding: "utf8" })
  sh(`git init -q "${base}"`)
  sh(`git config user.email t@t && git config user.name t && echo base > base.txt && git add -A && git commit -qm inicial`, base)
  sh(`git worktree add -q "${wt}" -b rama`, base)
  return { raiz, base, wt, limpiar: () => rmSync(raiz, { recursive: true, force: true }) }
}

// Trocea el template en un ARRAY de argumentos, no en una cadena.
//
// Esto no es un detalle de estilo: el `$` de Bun escapa cada interpolación como
// un único argumento, y reconstruir la cadena y pasarla por `sh -c` rompe todo
// argumento con espacios. Medido: el mensaje `-m gatekeeper: nombre @ sesion`
// se partia en cuatro y `commit-tree` respondia "must give exactly one tree", asi
// que el arbol de entrega nunca se anclaba — un fallo del arnes que habria pasado
// por un fallo del plugin. La misma trampa se llevaria por delante cualquier
// comentario de tablero, cualquier comando de aceptacion con espacios, y el texto
// entero de la realimentacion.
function trocear(strings, args) {
  const argv = []
  let pegar = false // el siguiente trozo continua el argumento anterior
  const anadir = (t) => {
    if (pegar && argv.length) argv[argv.length - 1] += t
    else argv.push(t)
    pegar = false
  }
  strings.forEach((s, i) => {
    const abre = /^\s/.test(s)
    const cierra = /\s$/.test(s) || s === ""
    const trozos = s.split(/\s+/).filter(Boolean)
    if (abre) pegar = false
    trozos.forEach((t, j) => { anadir(t); if (j < trozos.length - 1) pegar = false })
    if (i < args.length) {
      const a = args[i]
      if (Array.isArray(a)) {
        pegar = trozos.length > 0 && !cierra
        a.forEach((v) => { anadir(String(v)); pegar = false })
      } else {
        pegar = trozos.length > 0 && !cierra
        anadir(String(a))
      }
      pegar = !/^\s/.test(strings[i + 1] ?? " ")
    }
  })
  return argv
}

// Devuelve el `$` que recibe el plugin, más el registro de lo que intentó hacer.
// git y el comando de aceptación se ejecutan; orca y sqlite3 se fingen.
export function crearShell(dir) {
  const registro = { orca: [], enviados: [], argv: [] }
  const $ = (strings, ...args) => {
    const argv = trocear(strings, args)
    registro.argv.push(argv)
    const p = Promise.resolve().then(() => {
      const correr = (a, cwd) => {
        try { return { exitCode: 0, stdout: execFileSync(a[0], a.slice(1), { cwd, encoding: "utf8" }), stderr: "" } }
        catch (e) { return { exitCode: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" } }
      }
      const [bin] = argv
      if (bin === "git") return correr(argv)
      if (bin === "sqlite3") return { exitCode: 0, stdout: argv.join(" ").includes("json_object") ? METRICAS : "", stderr: "" }
      if (bin === "orca") {
        registro.orca.push(argv)
        if (argv[1] === "terminal" && argv[2] === "send") registro.enviados.push(argv)
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      // El comando de aceptación llega como `timeout N sh -c "cd DIR && …"`.
      if (bin === "timeout") return correr(argv.slice(2), dir)
      // `env VAR=val git …`: execFile no interpreta la asignación, hay que
      // sacarla al entorno del hijo. El plugin la usa para escribir el árbol
      // contra una copia del índice sin tocar el vivo.
      if (bin === "env") {
        const resto = argv.slice(1)
        const vars = {}
        while (resto.length && /^[A-Z_][A-Z0-9_]*=/.test(resto[0])) {
          const [k, ...v] = resto.shift().split("=")
          vars[k] = v.join("=")
        }
        try {
          return { exitCode: 0, stdout: execFileSync(resto[0], resto.slice(1), { cwd: dir, encoding: "utf8", env: { ...process.env, ...vars } }), stderr: "" }
        } catch (e) { return { exitCode: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" } }
      }
      return correr(argv, dir)
    })
    p.quiet = () => p
    p.nothrow = () => p
    return p
  }
  return { $, registro }
}

// Un despacho completo: arranca el plugin, emite los eventos y devuelve la fila
// del registro más lo que el plugin intentó hacer por fuera.
//
// `eventos` describe el turno: los ficheros tocados y si cierra en idle.
export async function despachar({ verify, protegidos, ficheros = {}, tocados, env = {}, turnos = 1 }) {
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
    if (protegidos) writeFileSync(join(w.wt, ".gatekeeper-protected"), protegidos)
    for (const [nombre, contenido] of Object.entries(ficheros)) writeFileSync(join(w.wt, nombre), contenido)

    const { $, registro } = crearShell(w.wt)
    const { Gatekeeper } = await import(`${PLUGIN}?t=${Date.now()}${Math.random()}`)
    const g = await Gatekeeper({ $, directory: w.wt })
    if (!g.event) return { activado: false, filas: [], registro, w }

    for (let t = 0; t < turnos; t++) {
      for (const f of tocados ?? Object.keys(ficheros)) {
        await g.event({ event: { type: "file.edited", properties: { file: join(w.wt, f) } } })
      }
      await g.event({ event: { type: "session.status", properties: { status: { type: "idle" }, sessionID: "s1" } } })
      if (t + 1 < turnos) {
        await g.event({ event: { type: "session.status", properties: { status: { type: "busy" }, sessionID: "s1" } } })
      }
    }

    const filas = existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : []
    return { activado: true, filas, fila: filas[filas.length - 1], registro, w }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in anterior)) delete process.env[k]
    Object.assign(process.env, anterior)
  }
}

// El comentario que el plugin dejó en el tablero, que es la superficie que se mira.
export function comentarioTablero(registro) {
  const ultimo = [...registro.orca].reverse().find((a) => a[1] === "worktree" && a[2] === "set")
  const i = ultimo?.indexOf("--comment")
  return i >= 0 ? ultimo[i + 1] : null
}

// El estado que el plugin pidió para el tablero: in-review o in-progress.
export function estadoTablero(registro) {
  const ultimo = [...registro.orca].reverse().find((a) => a[1] === "worktree" && a[2] === "set")
  const i = ultimo?.indexOf("--workspace-status")
  return i >= 0 ? ultimo[i + 1] : null
}

// El texto que se devolvió al worker, o null si no se realimentó.
export function textoRealimentado(registro) {
  const ultimo = registro.enviados[registro.enviados.length - 1]
  const i = ultimo?.indexOf("--text")
  return i >= 0 ? ultimo[i + 1] : null
}
