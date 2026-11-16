# Validations shared by the release scripts (archive.sh and the TestFlight upload).
#
# Meant to be sourced, never executed: it only defines functions, so loading it has no side
# effect. The caller sets `team_id`, `api_base_url`, `expected_xcode` and `repository_root`
# first, and runs under `set -euo pipefail`. `prepare_output_base` hands its result back in the
# global `output_base`.

fail() {
	echo "$1" >&2
	exit 1
}

validate_team_id() {
	[[ "$team_id" =~ ^[A-Z0-9]{10}$ ]] \
		|| fail "TRACK1_TEAM_ID is required and must be a 10-character Apple Team ID (A-Z, 0-9)."
}

# The value ends up in a build setting and in the app's Info.plist, so it is held to a strict
# allowlist instead of being sanitised: no credentials, port, query, fragment or shell/build-setting
# metacharacters (such as $ or quotes).
validate_api_base_url() {
	local authority host lower_url
	[[ -n "$api_base_url" ]] || fail "TRACK1_API_BASE_URL is required."
	[[ "$api_base_url" == https://* ]] || fail "TRACK1_API_BASE_URL must start with https://."
	authority="${api_base_url#https://}"
	authority="${authority%%/*}"
	[[ "$authority" != *@* ]] || fail "TRACK1_API_BASE_URL must not contain credentials."
	[[ "$authority" != *:* ]] || fail "TRACK1_API_BASE_URL must not contain an explicit port."
	host="$(printf '%s' "$authority" | tr '[:upper:]' '[:lower:]')"
	lower_url="$(printf '%s' "$api_base_url" | tr '[:upper:]' '[:lower:]')"
	[[ "$host" != *.example && "$lower_url" != *.example ]] \
		|| fail "TRACK1_API_BASE_URL must not end with .example: that is a placeholder domain."
	[[ "$api_base_url" =~ ^https://([A-Za-z0-9-]+\.)+[A-Za-z0-9-]+(/[A-Za-z0-9._~-]+)*/?$ ]] \
		|| fail "TRACK1_API_BASE_URL must be an https URL with a dotted host and a plain path (no query, fragment or special characters)."
	# AppConfiguration.swift refuses any other path at launch, after the app has been archived and signed.
	[[ "${api_base_url%/}" == */mobile/v1 ]] \
		|| fail "TRACK1_API_BASE_URL must end with /mobile/v1: the app refuses any other API path at launch."
}

validate_xcode() {
	local actual_xcode
	actual_xcode="$({ xcodebuild -version | awk '
		NR == 1 { version = $2 }
		NR == 2 { build = $3 }
		END { printf "Xcode %s (%s)", version, build }
	'; })"
	[[ "$actual_xcode" == "$expected_xcode" ]] \
		|| fail "Expected $expected_xcode but xcodebuild selected $actual_xcode."
}

validate_clean_tree() {
	local status
	status="$(git -C "$repository_root" status --porcelain)" || fail "Could not read the git status."
	[[ -z "$status" ]] || fail "The git working tree has uncommitted changes (untracked files included):
$status
Commit them, run 'git stash -u' (a plain 'git stash' keeps untracked files), or archive from a clean clone."
}

# APFS ignores case, so the comparison must too (at the cost of rejecting a case-only sibling on Linux).
is_inside_repository() {
	local candidate repository
	candidate="$(printf '%s/' "$1" | tr '[:upper:]' '[:lower:]')"
	repository="$(printf '%s/' "$repository_root" | tr '[:upper:]' '[:lower:]')"
	[[ "$candidate" == "$repository"* ]]
}

# Checked lexically before anything is created, then again once symlinks and ".." are resolved.
prepare_output_base() {
	output_base="${1:-${TMPDIR:-/tmp}}"
	[[ "$output_base" == /* ]] || output_base="$PWD/$output_base"
	! is_inside_repository "$output_base" || fail "The output directory must be outside the repository: $output_base"
	mkdir -p "$output_base"
	output_base="$(cd "$output_base" && pwd -P)"
	! is_inside_repository "$output_base" || fail "The output directory must be outside the repository: $output_base"
}
