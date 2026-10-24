#!/usr/bin/env bash
set -euo pipefail
# Commit the nodes `deploy/pull-cache.sh --apply` copied into cache/nodes/, push a data branch and open a
# DRAFT PR for them (TRA-493). Run by .github/workflows/pull-cache.yml from the repo checkout; never merges.
#
# Env: PULL_OUT_DIR   dir holding new.txt / changed.txt written by pull-cache-validate.ts (required)
#      GH_TOKEN       token for the push and for `gh` (required unless PULL_PUSH_REMOTE is set)
#      GITHUB_REPOSITORY owner/name, for the push URL
#      PULL_BASE (main), PULL_DATE (today, UTC), PULL_PUSH_REMOTE (test seam: any git remote)
#
# Only ADDED files under cache/nodes/ may be staged: a modified or deleted file, or anything elsewhere,
# means the pull went wrong and nothing is committed. The branch is never force-pushed: a second run on
# the same day fails on the existing branch instead of rewriting a PR someone may be reviewing.
#
# This repo disallows Actions-created pull requests: when `gh pr create` is refused for that reason the
# job stays green, the branch is pushed, and the run summary gets the exact command (same behavior as
# top-up-genres.yml). A PR opened by a human is also the one that triggers ci.yml's required checks.

OUT_DIR="${PULL_OUT_DIR:?PULL_OUT_DIR is required}"
BASE="${PULL_BASE:-main}"
BRANCH="data/pull-cache-${PULL_DATE:-$(date -u +%F)}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

NEW_COUNT="$(grep -c . "$OUT_DIR/new.txt" || true)"
CHANGED_COUNT="$(grep -c . "$OUT_DIR/changed.txt" || true)"
if [ "$NEW_COUNT" -eq 0 ]; then
	echo "No new node to import ($CHANGED_COUNT changed): no branch, no PR."
	exit 0
fi

git checkout -q -b "$BRANCH"
git add -A -- cache/nodes
STAGED="$(git diff --cached --name-status)"
STAGED_TOTAL="$(printf '%s\n' "$STAGED" | grep -c . || true)"
STAGED_UNEXPECTED="$(printf '%s\n' "$STAGED" | grep -cvE $'^A\tcache/nodes/[a-z]+/[a-z0-9-]+\\.json$' || true)"
if [ "$STAGED_TOTAL" -ne "$NEW_COUNT" ] || [ "$STAGED_UNEXPECTED" -ne 0 ]; then
	echo "ERROR: the staged changes are not exactly the $NEW_COUNT added node file(s):" >&2
	printf '%s\n' "$STAGED" >&2
	exit 1
fi

TITLE="data(cache): rapatrier $NEW_COUNT nœuds JIT de prod"
LIST_CAP=200
list() { # list <file>: one bullet per slug, capped so the PR body stays far below GitHub's limit
	head -n "$LIST_CAP" "$1" | sed 's/.*/- `&`/'
	local total
	total="$(grep -c . "$1" || true)"
	if [ "$total" -gt "$LIST_CAP" ]; then echo "- ... et $((total - LIST_CAP)) autres"; fi
}
{
	echo "Rapatriement des nœuds matérialisés en prod et absents du dépôt (workflow \`pull-cache\`, généré)."
	echo
	echo "- nœuds ajoutés : $NEW_COUNT"
	echo "- nœuds divergents (même slug, contenu différent) : $CHANGED_COUNT. Le dépôt gagne : aucun n'est copié, ils sont seulement listés."
	echo "- validation passée avant la copie : schéma Zod (slug canonique), slug = chemin, aucun champ que le schéma supprimerait, URL http(s) simples, slug non redirigé, audit d'intégrité contre les seuils committés. Aucun seuil n'est modifié."
	echo
	echo "## Nœuds ajoutés ($NEW_COUNT)"
	list "$OUT_DIR/new.txt"
	if [ "$CHANGED_COUNT" -gt 0 ]; then
		echo
		echo "## Divergences prod / dépôt ($CHANGED_COUNT)"
		echo "Signal d'intégrité à instruire à part : la prod et le dépôt ne disent pas la même chose de ces nœuds."
		list "$OUT_DIR/changed.txt"
	fi
	echo
	echo "Brouillon généré : revue humaine requise avant merge, jamais d'auto-merge. Refs TRA-493"
} > "$OUT_DIR/pr-body.md"

git -c user.name="odyssey-bot" -c user.email="actions@users.noreply.github.com" \
	commit -q -m "data(cache): rapatrier $NEW_COUNT nœuds JIT de prod" -m "Refs TRA-493"

# Token given only to this push (checkout used persist-credentials: false), never written to .git/config.
REMOTE="${PULL_PUSH_REMOTE:-}"
if [ -z "$REMOTE" ]; then
	REMOTE="https://x-access-token:${GH_TOKEN:?GH_TOKEN is required}@github.com/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}.git"
fi
git push "$REMOTE" "$BRANCH"

set +e
PR_OUTPUT="$(gh pr create --draft --base "$BASE" --head "$BRANCH" --title "$TITLE" --body-file "$OUT_DIR/pr-body.md" 2>&1)"
PR_STATUS=$?
set -e
if [ "$PR_STATUS" -eq 0 ]; then
	echo "$PR_OUTPUT"
	{ echo "### PR ouverte"; echo; echo "$PR_OUTPUT"; } >> "$SUMMARY"
elif echo "$PR_OUTPUT" | grep -qi "not permitted to create"; then
	{
		echo "### Ouverture de PR refusée par la configuration du dépôt"
		echo
		echo "La branche \`$BRANCH\` est poussée. Ouvre la PR toi-même (c'est aussi ce qui déclenche les checks requis) :"
		echo
		echo '```'
		echo "gh pr create --draft --base $BASE --head $BRANCH --title \"$TITLE\" --body-file <(cat <<'PRBODY'"
		cat "$OUT_DIR/pr-body.md"
		echo "PRBODY"
		echo ")"
		echo '```'
	} >> "$SUMMARY"
	echo "gh pr create refused by the repository settings: see the run summary."
else
	echo "ERROR: gh pr create failed: $PR_OUTPUT" >&2
	exit 1
fi
