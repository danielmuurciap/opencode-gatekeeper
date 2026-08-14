#!/usr/bin/env bash
# Despachos que necesitan a un humano: los que esperan una respuesta y los que
# llevan demasiado sin dar señales.
#
# El silencio de un worker no es exito. `orca worktree ps --json` ya distingue
# las dos causas y no la estabamos leyendo:
#   status: permission  ->  algun panel esta en waiting|blocked (pregunta sin responder)
#   agents[].state      ->  working|blocked|waiting|done, con stateStartedAt
#
# Uso:  vigilar-despachos.sh [minutos]      (umbral de "colgado", por defecto 15)
#
# Salida: una linea por worktree problematico. Silencio = nada que mirar.
# Exit 0 si hay algo, 1 si no — al reves de lo habitual, para poder usarlo como
# --precheck de una automation de Orca (exit 0 continua, distinto de 0 la salta).

set -uo pipefail
UMBRAL_MIN=${1:-15}

command -v orca >/dev/null || { echo "orca no esta en PATH" >&2; exit 2; }
command -v jq   >/dev/null || { echo "jq no esta en PATH" >&2; exit 2; }

PS=$(orca worktree ps --json 2>/dev/null) || { echo "orca worktree ps fallo" >&2; exit 2; }

HALLAZGOS=$(echo "$PS" | jq -r --argjson umbral "$UMBRAL_MIN" '
  (now * 1000) as $ahora
  | .result.worktrees[]
  | select(.isMainWorktree | not)
  | . as $w
  | ($w.agents // []) as $ags
  # minutos desde que un agente entro en su estado actual
  | ($ags | map(select(.state == "waiting" or .state == "blocked"))) as $esperando
  | ($ags | map(select(.state == "working"))) as $trabajando
  | ($ags | map(select(.restoredUnconfirmed == true))) as $fosiles
  | if ($esperando | length) > 0 then
      ($esperando | map(($ahora - (.stateStartedAt // $ahora)) / 60000 | floor) | max) as $min
      | "ESPERANDO\t\($w.displayName)\t\($min) min\t\($w.repo)\t\($esperando[0].state)"
    elif ($fosiles | length) > 0 then
      "FOSIL\t\($w.displayName)\t? \t\($w.repo)\testado sin reconfirmar tras reiniciar Orca"
    elif ($trabajando | length) > 0 then
      ($trabajando | map(($ahora - (.updatedAt // $ahora)) / 60000 | floor) | max) as $min
      | if $min >= $umbral then
          "COLGADO\t\($w.displayName)\t\($min) min\t\($w.repo)\tsin cambio de estado"
        else empty end
    else empty end
')

[ -z "$HALLAZGOS" ] && exit 1

# La CPU es una segunda señal, independiente de los hooks: un panel "working"
# con CPU plana no esta pensando. No decide nada — solo acompaña al diagnostico.
CPU=$(orca diagnostics memory --json 2>/dev/null \
      | jq -r '.result.worktrees[]? | "\(.worktreeName)\t\(.cpu)"' 2>/dev/null)

echo "$HALLAZGOS" | while IFS=$'\t' read -r tipo nombre tiempo repo detalle; do
  c=$(echo "$CPU" | awk -F'\t' -v n="$nombre" '$1==n {printf "%.1f", $2}')
  printf '%-9s %-28s %-9s %-14s cpu %-5s %s\n' \
    "$tipo" "$nombre" "$tiempo" "$repo" "${c:-?}" "$detalle"
done
exit 0
