#!/usr/bin/env bash
# El examen de la suite: no comprueba que los tests pasen, comprueba que SIRVEN.
#
# Una suite escrita contra codigo que ya existe pasa por construccion: describe
# lo que el codigo hace, sale verde, no informa de nada, y congela los bugs
# actuales como si fueran la especificacion. La unica prueba que vale es
# romper el plugin a proposito y exigir que la suite se entere.
#
# Cada mutacion se VERIFICA aplicada antes de correr nada: un reemplazo que no
# encuentra su patron deja el codigo intacto, la suite pasa, y parece que la
# suite no sirve cuando el que no sirvio fue el check.
#
# Uso:  scripts/mutantes.sh
# Sale 0 si la suite pasa limpia Y caza todas las mutaciones.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PLUGIN=plugin/gatekeeper.js
# El glob explicito, no `node --test test/`: en Node 25 eso intenta cargar el
# DIRECTORIO como modulo CJS y responde MODULE_NOT_FOUND. Ese rojo se parece al
# de "no existe la suite" y me lo trague al validar el examen — dos rondas
# suspendiendo a un worker cuya suite pasaba 11 de 11. Leer el rojo, no contarlo.
suite() { node --test test/*.test.mjs; }
# Cerrojo: este examen MUTA un fichero compartido. Dos ejecuciones a la vez se
# pisan y el `trap restaurar` de una repone una copia que la otra ya habia
# mutado — el plugin queda roto en el arbol de trabajo y nadie se entera.
# Medido 14-ago-2026: lo corri mientras el worker lo corria en el mismo worktree
# y quedo la mutacion `baseline = false &&` viva en plugin/gatekeeper.js.
LOCK=.mutantes.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "✗ ya hay un scripts/mutantes.sh corriendo aqui (existe $LOCK)"
  echo "  si estas seguro de que no, borra el directorio y repite"
  exit 1
fi

COPIA=$(mktemp)
cp "$PLUGIN" "$COPIA"
restaurar() { cp "$COPIA" "$PLUGIN"; rm -f "$COPIA"; rmdir "$LOCK" 2>/dev/null; }
trap restaurar EXIT

# ── Paso 1: en limpio la suite tiene que pasar ───────────────────────────────
echo "── suite sin mutar"
if ! suite >/tmp/gk-limpio.log 2>&1; then
  echo "✗ la suite falla sobre el plugin intacto — arregla eso antes de nada"
  tail -25 /tmp/gk-limpio.log
  exit 1
fi
echo "✓ verde en limpio"

# ── Paso 2: cada mutacion tiene que ponerla en rojo ──────────────────────────
# Separador @@@ y no "|": el propio codigo mutado contiene tuberias
# (violated.join("|")) y partirlo por ahi troceaba la mutacion en silencio.
# Formato: nombre @@@ texto original @@@ texto mutado
MUTACIONES=(
  'wrote_nothing nunca dispara@@@if (touched.size === 0)@@@if (touched.size === -1)'
  'committed nunca dispara@@@if (initialHead && finalHead && initialHead !== finalHead) failures.push("committed")@@@if (false) failures.push("committed")'
  'el examen tocado deja de contar@@@if (violated.length) failures.push@@@if (false) failures.push'
  'expirar se reporta como fallar@@@if (r.exitCode === 124) {@@@if (r.exitCode === 1240) {'
  'el tope de rondas desaparece@@@round < MAX_ROUNDS &&@@@round < 99 &&'
  'se realimenta una trampa ya cazada@@@const FEEDABLE = new Set(["verify"@@@const FEEDABLE = new Set(["protected_modified", "verify_removed", "verify"'
  'el examen borrado pasa en silencio@@@failures.push("verify_removed")@@@void 0'
  'suena tambien en verde limpio@@@const worthRinging = (failures.length && !willFeedback)@@@const worthRinging = true || (failures.length && !willFeedback)'
  'el timeout nunca salta@@@Number(process.env.GATEKEEPER_VERIFY_TIMEOUT || 300)@@@999999'
  'los gates corren en el checkout principal@@@if (!common || !own || common === own) return {}@@@if (false) return {}'
  'el veredicto de examen base se pierde@@@baseline = /^#@@@baseline = false && /^#'
)

fallos=0
for m in "${MUTACIONES[@]}"; do
  nombre="${m%%@@@*}"
  resto="${m#*@@@}"
  original="${resto%@@@*}"
  mutado="${resto##*@@@}"

  cp "$COPIA" "$PLUGIN"
  if ! ORIGINAL="$original" MUTADO="$mutado" PLUGIN="$PLUGIN" python3 - <<'PY'
import os, sys, pathlib
p = pathlib.Path(os.environ["PLUGIN"])
s = p.read_text()
o, m = os.environ["ORIGINAL"], os.environ["MUTADO"]
if o not in s:
    sys.exit(1)          # el patron ya no existe: la mutacion esta caducada
p.write_text(s.replace(o, m, 1))
PY
  then
    echo "✗ MUTACION CADUCADA: «${nombre}» — su patron ya no esta en el plugin, actualiza este examen"
    fallos=$((fallos + 1))
    continue
  fi

  if suite >/dev/null 2>&1; then
    echo "✗ SOBREVIVE: «${nombre}» — la suite pasa con el plugin roto"
    fallos=$((fallos + 1))
  else
    echo "✓ cazada: $nombre"
  fi
done

restaurar
trap - EXIT

echo
if [ "$fallos" -gt 0 ]; then
  echo "$fallos de ${#MUTACIONES[@]} mutaciones sin cubrir"
  exit 1
fi
echo "las ${#MUTACIONES[@]} mutaciones cazadas"
