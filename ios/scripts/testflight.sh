#!/usr/bin/env bash
# Archives the Production variant with manual distribution signing and, on request, uploads it to
# App Store Connect (TRA-718, decision D5). The TestFlight workflow only calls this script.
#
# Reads TRACK1_TEAM_ID, TRACK1_API_BASE_URL, TRACK1_PROFILE_NAME, ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID and
# TRACK1_UPLOAD (1 sends the build to App Store Connect; anything else only exports the IPA).
# Usage: ios/scripts/testflight.sh [output directory]
# The API key is only handed to xcodebuild by path: it is never read or printed here.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ios_dir="$(cd "$script_dir/.." && pwd -P)"
repository_root="$(cd "$ios_dir/.." && pwd -P)"
expected_xcode="$(<"$ios_dir/.xcode-version")"
# Set by Production.xcconfig and not overridden on the xcodebuild command line; only the export's profile map reads this.
bundle_identifier="com.dropcliffs.track1"
team_id="${TRACK1_TEAM_ID:-}"
api_base_url="${TRACK1_API_BASE_URL:-}"
profile_name="${TRACK1_PROFILE_NAME:-}"
upload="${TRACK1_UPLOAD:-0}"

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
work_dir="$(mktemp -d "$output_base/track1-testflight.XXXXXX")"
archive_path="$work_dir/Track1.xcarchive"
export_dir="$work_dir/export"
export_options="$work_dir/ExportOptions-AppStore.plist"

xcodebuild archive \
	-project "$ios_dir/Track1.xcodeproj" \
	-scheme Track1 \
	-configuration Production \
	-destination generic/platform=iOS \
	-archivePath "$archive_path" \
	-onlyUsePackageVersionsFromResolvedFile \
	-disableAutomaticPackageResolution \
	CODE_SIGNING_ALLOWED=YES \
	CODE_SIGNING_REQUIRED=YES \
	CODE_SIGN_STYLE=Manual \
	"CODE_SIGN_IDENTITY=Apple Distribution" \
	"DEVELOPMENT_TEAM=$team_id" \
	"PROVISIONING_PROFILE_SPECIFIER=$profile_name" \
	"TRACK1_API_BASE_URL=$api_base_url" \
	"CURRENT_PROJECT_VERSION=$build_number"

# Checked before the export: with TRACK1_UPLOAD=1 the export already sends the build.
archived_apps=("$archive_path"/Products/Applications/*.app)
[[ ${#archived_apps[@]} -eq 1 && -d "${archived_apps[0]}" ]] || fail "Expected exactly one .app in $archive_path."
marketing_version="$(plutil -extract CFBundleShortVersionString raw -o - "${archived_apps[0]}/Info.plist")"
# plutil key paths split on dots, so the profile map goes in as XML, with the name escaped for it.
xml_profile_name="$(printf '%s' "$profile_name" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
cp "$ios_dir/Configurations/ExportOptions-AppStore.plist" "$export_options"
plutil -replace teamID -string "$team_id" "$export_options"
plutil -replace provisioningProfiles -xml \
	"<dict><key>$bundle_identifier</key><string>$xml_profile_name</string></dict>" "$export_options"
[[ "$upload" != 1 ]] || plutil -replace destination -string upload "$export_options"
xcodebuild -exportArchive \
	-archivePath "$archive_path" \
	-exportPath "$export_dir" \
	-exportOptionsPlist "$export_options" \
	-authenticationKeyPath "${ASC_KEY_PATH:-}" \
	-authenticationKeyID "${ASC_KEY_ID:-}" \
	-authenticationKeyIssuerID "${ASC_ISSUER_ID:-}"

# An uploaded build leaves no IPA behind.
ipas=("$export_dir"/*.ipa)
[[ "$upload" == 1 || (${#ipas[@]} -eq 1 && -f "${ipas[0]}") ]] || fail "Expected exactly one IPA in $export_dir."

echo "Git SHA:  $git_sha"
echo "Version:  $marketing_version"
echo "Build:    $build_number"
echo "API URL:  $api_base_url"
[[ "$upload" == 1 ]] || echo "IPA:      ${ipas[0]}"
