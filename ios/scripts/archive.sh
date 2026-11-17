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

# Defines fail and the validate_* helpers; reads the variables set above.
source "$script_dir/release-common.sh"

validate_team_id
validate_api_base_url
validate_xcode
validate_clean_tree

git_sha="$(git -C "$repository_root" rev-parse HEAD)"
build_number="$(date -u +%Y%m%d%H%M)"

prepare_output_base "$@"
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
	-onlyUsePackageVersionsFromResolvedFile \
	-disableAutomaticPackageResolution \
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
unzip -q "$ipa_path" -d "$unpacked_dir" || fail "Could not unpack $ipa_path."
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

archived_api_base_url="$(plutil -extract Track1APIBaseURL raw -o - "$app_path/Info.plist")" \
	|| fail "Could not read Track1APIBaseURL from the exported app."
[[ "$archived_api_base_url" == "$api_base_url" ]] \
	|| fail "The exported app embeds API URL '$archived_api_base_url', expected '$api_base_url'."

marketing_version="$(plutil -extract CFBundleShortVersionString raw -o - "$app_path/Info.plist")"
bundle_version="$(plutil -extract CFBundleVersion raw -o - "$app_path/Info.plist")"
echo "Git SHA:  $git_sha"
echo "Version:  $marketing_version"
echo "Build:    $bundle_version"
echo "API URL:  $archived_api_base_url"
echo "IPA:      $ipa_path"
