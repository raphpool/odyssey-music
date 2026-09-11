#!/usr/bin/env bash
set -euo pipefail

usage() {
	printf 'Usage: %s <pr> <pending|pass|block> [description]\n' "$0" >&2
	exit 2
}

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
	usage
fi

pr="$1"
verdict="$2"
description="${3:-Review Codex locale}"

case "$verdict" in
	pending) state="pending" ;;
	pass) state="success" ;;
	block) state="failure" ;;
	*) usage ;;
esac

description="${description:0:140}"

if [ "${CODEX_REVIEW_DRY_RUN:-0}" = "1" ]; then
	repo="${CODEX_REVIEW_REPO:-owner/repository}"
	sha="${CODEX_REVIEW_SHA:-0000000000000000000000000000000000000000}"
	target_url="${CODEX_REVIEW_URL:-https://github.com/$repo/pull/$pr}"
	printf 'repo=%s\nsha=%s\nstate=%s\ncontext=review-gate\ndescription=%s\ntarget_url=%s\n' \
		"$repo" "$sha" "$state" "$description" "$target_url"
	exit 0
fi

repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
sha="$(gh pr view "$pr" --json headRefOid --jq '.headRefOid')"
target_url="$(gh pr view "$pr" --json url --jq '.url')"

gh api --method POST "repos/$repo/statuses/$sha" \
	-f state="$state" \
	-f context="review-gate" \
	-f description="$description" \
	-f target_url="$target_url" >/dev/null

printf 'review-gate=%s pour %s (%s)\n' "$state" "$sha" "$target_url"
