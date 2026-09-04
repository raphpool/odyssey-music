#!/usr/bin/env bash
# PostToolUse sur Edit|Write : formatage du seul fichier touché.
# Rapide et silencieux — ne bloque jamais, ne consomme aucun token.
#
# Adapté à ce repo : npx au lieu de pnpm exec. Biome est en devDependency.
set -euo pipefail
FILE=$(jq -r '.tool_input.file_path // empty' 2>/dev/null || true)
[ -z "${FILE:-}" ] && exit 0
[ -f "$FILE" ] || exit 0
case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.css)
    npx --no-install biome check --write --no-errors-on-unmatched "$FILE" >/dev/null 2>&1 || true
    ;;
esac
exit 0
