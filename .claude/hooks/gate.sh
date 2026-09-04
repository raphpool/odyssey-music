#!/usr/bin/env bash
# Stop : les mêmes gates que la CI, en fin de tour, en local.
# Exit 2 = bloquant : stderr est renvoyé à l'agent qui doit corriger.
# Un aller-retour local est ~50x moins cher qu'un aller-retour CI.
#
# Adapté à ce repo : npm, pas pnpm. Les noms de scripts sont ceux de
# package.json (`typecheck`, `lint`, `test`), et `test` exclut déjà les
# *.live.test.ts qui tapent les vraies API.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}"

# Rien à vérifier si rien n'a bougé.
git diff --quiet HEAD -- '*.ts' '*.tsx' 2>/dev/null && exit 0

FAIL=""
run() {
  local name="$1"; shift
  if ! OUT=$("$@" 2>&1); then
    FAIL+=$'\n=== '"$name"$' ===\n'"$(printf '%s' "$OUT" | tail -40)"
  fi
}

run "typecheck" npm run --silent typecheck
run "lint" npm run --silent lint
run "tests" npm run --silent test -- --run --passWithNoTests

if [ -n "$FAIL" ]; then
  printf 'Gates en échec. Corrige avant de terminer le tour :%s\n' "$FAIL" >&2
  exit 2
fi
exit 0
