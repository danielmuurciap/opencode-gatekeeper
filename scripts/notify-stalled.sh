#!/usr/bin/env bash
# Corre el vigilante y avisa por notificacion cuando encuentra algo.
# Pensado para launchd; a mano tambien vale.
#
# Por que esto y no una automation de Orca: `orca automations create` exige
# --prompt y --provider, asi que SIEMPRE lanza un agente. Gastar un modelo para
# enterarme de que un worker esta parado cuesta tokens y ensucia el tablero con
# un worktree mas. Lo que hace falta aqui es un aviso, y eso es osascript.
#
# Uso:  notify-stalled.sh [minutos]     (umbral de "colgado", por defecto 15)

set -uo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ESTADO="${HOME}/.local/state/gatekeeper/ultimo-aviso"

HALLAZGOS=$("$DIR/watch-dispatches.sh" "${1:-15}" 2>/dev/null) || exit 0

# El mismo worker parado avisando cada 10 minutos se silencia solo, y entonces
# no avisa de nada nunca mas. La firma lleva el tramo de media hora: mismo
# problema, un aviso por tramo — sigue insistiendo, sin machacar.
TRAMO=$(( $(date +%s) / 1800 ))
# cksum y no md5: md5 vive en /sbin, fuera del PATH de arriba. Con el PATH mal
# la firma salia vacia, coincidia con el fichero vacio, y el aviso se callaba
# para siempre despues del primero — silencio que parecia "no hay nada".
FIRMA=$(printf '%s\n%s' "$TRAMO" "$(echo "$HALLAZGOS" | awk '{print $1, $2}')" | cksum)
[ -z "$FIRMA" ] && FIRMA="sin-firma-$TRAMO"
[ -f "$ESTADO" ] && [ "$(cat "$ESTADO")" = "$FIRMA" ] && exit 0
mkdir -p "$(dirname "$ESTADO")" && echo "$FIRMA" > "$ESTADO"

N=$(echo "$HALLAZGOS" | wc -l | tr -d ' ')
CUERPO=$(echo "$HALLAZGOS" | awk '{print $1 " " $2 " (" $3 " " $4 ")"}' | head -4 | paste -sd '\n' -)
TITULO=$([ "$N" = 1 ] && echo "1 despacho necesita a alguien" || echo "$N despachos necesitan a alguien")

# Sin silenciar osascript: bajo launchd un fallo de permisos de notificacion no
# tiene ningun otro sintoma, y un aviso que falla callando es peor que no tenerlo.
if ! osascript -e "display notification \"${CUERPO//\"/\'}\" with title \"$TITULO\" sound name \"Submarine\""; then
  echo "AVISO: osascript fallo — la notificacion no se mostro" >&2
fi
echo "$HALLAZGOS"
