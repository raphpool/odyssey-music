#!/usr/bin/env bash
set -euo pipefail
usage() {
	printf 'Usage: %s <pr> <pending|pass|block> <reviewed-sha> [description]\n' "$0" >&2
	exit 2
}
if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
	usage
fi
pr="$1"
verdict="$2"
reviewed_sha="$3"
description="${4:-Review Codex locale}"
case "$verdict" in
	pending) state="pending" ;;
	pass) state="success" ;;
	block) state="failure" ;;
	*) usage ;;
esac
description="${description:0:140}"
if [ "${CODEX_REVIEW_DRY_RUN:-0}" = "1" ]; then
	repo="${CODEX_REVIEW_REPO:-owner/repository}"
	current_sha="${CODEX_REVIEW_CURRENT_SHA:-$reviewed_sha}"
	target_url="${CODEX_REVIEW_URL:-https://github.com/$repo/pull/$pr}"
else
	repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
	current_sha="$(gh pr view "$pr" --json headRefOid --jq '.headRefOid')"
	target_url="$(gh pr view "$pr" --json url --jq '.url')"
fi
if [ "$current_sha" != "$reviewed_sha" ]; then
	printf 'Refus: la PR pointe sur %s, pas sur le SHA reviewé %s.\n' "$current_sha" "$reviewed_sha" >&2
	exit 1
fi
if [ "${CODEX_REVIEW_DRY_RUN:-0}" = "1" ]; then
	printf 'repo=%s\nsha=%s\nstate=%s\ncontext=codex-review\ndescription=%s\ntarget_url=%s\n' \
		"$repo" "$reviewed_sha" "$state" "$description" "$target_url"
	exit 0
fi
gh api --method POST "repos/$repo/statuses/$reviewed_sha" \
	-f state="$state" \
	-f context="codex-review" \
	-f description="$description" \
	-f target_url="$target_url" >/dev/null
run_info="$(gh run list --commit "$reviewed_sha" --event pull_request --limit 100 \
	--json databaseId,name,status,conclusion,headSha \
	--jq 'map(select(.name == "review-gate")) | .[0] | select(.headSha != null) | [.databaseId, .status, .conclusion, .headSha] | @tsv')"
if [ -n "$run_info" ]; then
	IFS=$'\t' read -r run_id run_status run_conclusion run_sha <<< "$run_info"
	if [ "$run_sha" = "$reviewed_sha" ] && [ "$run_status" = "completed" ] && [ "$run_conclusion" != "success" ]; then
		gh run rerun "$run_id" >/dev/null
	fi
fi
printf 'codex-review=%s pour %s (%s)\n' "$state" "$reviewed_sha" "$target_url"
