#!/usr/bin/env bash
set -euo pipefail
usage() {
	printf 'Usage: %s <pr> <pending|pass|block> <reviewed-sha> [description] [standard|deep] [evidence-url]\n' "$0" >&2
	exit 2
}
if [ "$#" -lt 3 ] || [ "$#" -gt 6 ]; then
	usage
fi
pr="$1"
verdict="$2"
reviewed_sha="$3"
description="${4:-Review Codex locale}"
mode="${5:-standard}"
evidence_url="${6:-}"
case "$verdict" in
	pending) state="pending" ;;
	pass) state="success" ;;
	block) state="failure" ;;
	*) usage ;;
esac
case "$mode" in
	standard) context="codex-review" ;;
	deep) context="codex-deep-review" ;;
	*) usage ;;
esac
if [ "$mode" = "deep" ] && [ "$verdict" != "pending" ] && [ -z "$evidence_url" ]; then
	printf 'Refus: une review profonde terminale exige son lien de preuve.\n' >&2
	exit 2
fi
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
if [ "$mode" = "deep" ] && [ "$verdict" != "pending" ]; then
	case "$evidence_url" in
		"$target_url"/*|"$target_url"\#*) ;;
		*) printf 'Refus: la preuve profonde doit référencer cette PR.\n' >&2; exit 2 ;;
	esac
	target_url="$evidence_url"
fi
if [ "${CODEX_REVIEW_DRY_RUN:-0}" = "1" ]; then
	printf 'repo=%s\nsha=%s\nstate=%s\ncontext=%s\ndescription=%s\ntarget_url=%s\n' \
		"$repo" "$reviewed_sha" "$state" "$context" "$description" "$target_url"
	exit 0
fi
gh api --method POST "repos/$repo/statuses/$reviewed_sha" \
	-f state="$state" \
	-f context="$context" \
	-f description="$description" \
	-f target_url="$target_url" >/dev/null
run_info="$(gh run list --commit "$reviewed_sha" --event pull_request --limit 100 \
	--json databaseId,name,status,conclusion,headSha \
	--jq 'map(select(.name == "review-gate")) | .[0] | select(.headSha != null) | [.databaseId, .status, .conclusion, .headSha] | @tsv')"
if [ -n "$run_info" ]; then
	IFS=$'\t' read -r run_id run_status run_conclusion run_sha <<< "$run_info"
	if [ "$run_sha" = "$reviewed_sha" ] && [ "$run_status" = "completed" ] && { [ "$run_conclusion" != "success" ] || [ "$state" = "failure" ]; }; then
		if [ "$state" = "failure" ]; then
			gh run rerun "$run_id" >/dev/null
		else
			gh run rerun "$run_id" --failed >/dev/null
		fi
	fi
fi
printf '%s=%s pour %s (%s)\n' "$context" "$state" "$reviewed_sha" "$target_url"
