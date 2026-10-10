#!/usr/bin/env bash
# Produces a signed Preview IPA on the maintainer's Mac (TRA-337, decision D6).
#
# Usage: TRACK1_TEAM_ID=<Team ID> TRACK1_API_BASE_URL=<https URL> ios/scripts/archive.sh [output directory]
#
# The API URL is never written in the repository: it is supplied at archive time so the
# hosting can change without a code change. CI never signs (Base.xcconfig keeps
# CODE_SIGNING_ALLOWED = NO); only this script turns signing on, and it reads no secret.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ios_dir="$(cd "$script_dir/.." && pwd -P)"
repository_root="$(cd "$ios_dir/.." && pwd -P)"
expected_xcode="$(<"$ios_dir/.xcode-version")"
bundle_identifier="com.dropcliffs.track1.preview"
team_id="${TRACK1_TEAM_ID:-}"
api_base_url="${TRACK1_API_BASE_URL:-}"

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
	[[ -z "$status" ]] \
		|| fail "The git working tree has uncommitted changes; commit or stash them so the archive matches a commit."
}

validate_team_id
validate_api_base_url
validate_xcode
validate_clean_tree

git_sha="$(git -C "$repository_root" rev-parse HEAD)"
build_number="$(date -u +%Y%m%d%H%M)"

output_base="${1:-${TMPDIR:-/tmp}}"
mkdir -p "$output_base"
output_base="$(cd "$output_base" && pwd -P)"
case "$output_base/" in
	"$repository_root"/*) fail "The output directory must be outside the repository: $output_base" ;;
esac
# A fresh directory per run, so a previous archive or IPA can never be picked up by mistake.
work_dir="$(mktemp -d "$output_base/track1-archive.XXXXXX")"
archive_path="$work_dir/Track1Preview.xcarchive"
export_dir="$work_dir/export"
export_options="$work_dir/ExportOptions-Preview.plist"
unpacked_dir="$work_dir/unpacked"

xcodebuild archive \
	-project "$ios_dir/Track1.xcodeproj" \
	-scheme Track1Preview \
	-configuration Preview \
	-destination generic/platform=iOS \
	-archivePath "$archive_path" \
	-allowProvisioningUpdates \
	CODE_SIGNING_ALLOWED=YES \
	CODE_SIGNING_REQUIRED=YES \
	CODE_SIGN_STYLE=Automatic \
	"DEVELOPMENT_TEAM=$team_id" \
	"TRACK1_API_BASE_URL=$api_base_url" \
	"CURRENT_PROJECT_VERSION=$build_number"

cp "$ios_dir/Configurations/ExportOptions-Preview.plist" "$export_options"
plutil -replace teamID -string "$team_id" "$export_options"
xcodebuild -exportArchive \
	-archivePath "$archive_path" \
	-exportPath "$export_dir" \
	-exportOptionsPlist "$export_options" \
	-allowProvisioningUpdates

ipas=("$export_dir"/*.ipa)
[[ ${#ipas[@]} -eq 1 && -f "${ipas[0]}" ]] || fail "Expected exactly one IPA in $export_dir."
ipa_path="${ipas[0]}"
unzip -q "$ipa_path" -d "$unpacked_dir"
apps=("$unpacked_dir"/Payload/*.app)
[[ ${#apps[@]} -eq 1 && -d "${apps[0]}" ]] || fail "Expected exactly one .app in $ipa_path."
app_path="${apps[0]}"

signature="$(codesign -d --verbose=2 "$app_path" 2>&1)" || fail "codesign could not read the signature of $app_path."
signed_identifier="$(printf '%s\n' "$signature" | sed -n 's/^Identifier=//p')"
signed_team="$(printf '%s\n' "$signature" | sed -n 's/^TeamIdentifier=//p')"
[[ "$signed_identifier" == "$bundle_identifier" ]] \
	|| fail "The exported app is signed as '$signed_identifier', expected '$bundle_identifier'."
[[ "$signed_team" == "$team_id" ]] \
	|| fail "The exported app is signed by team '$signed_team', expected '$team_id'."

marketing_version="$(plutil -extract CFBundleShortVersionString raw -o - "$app_path/Info.plist")"
bundle_version="$(plutil -extract CFBundleVersion raw -o - "$app_path/Info.plist")"
echo "Git SHA:  $git_sha"
echo "Version:  $marketing_version"
echo "Build:    $bundle_version"
echo "API URL:  $api_base_url"
echo "IPA:      $ipa_path"
