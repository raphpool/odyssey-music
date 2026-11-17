#!/usr/bin/env bash
# Archives the Production variant with manual distribution signing and, on request, uploads it to
# App Store Connect (TRA-718, decision D5). The TestFlight workflow only calls this script.
#
# Reads TRACK1_TEAM_ID, TRACK1_API_BASE_URL, TRACK1_PROFILE_NAME, ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID and
# TRACK1_UPLOAD (0, the default, exports the IPA and checks it; 1 sends the build to App Store Connect; else refused).
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
key_path="${ASC_KEY_PATH:-}"
key_id="${ASC_KEY_ID:-}"
issuer_id="${ASC_ISSUER_ID:-}"
upload="${TRACK1_UPLOAD:-0}"

# Defines fail and the validate_* helpers; reads the variables set above.
source "$script_dir/release-common.sh"

validate_team_id
validate_api_base_url
validate_xcode
validate_clean_tree
[[ "$upload" == 0 || "$upload" == 1 ]] || fail "TRACK1_UPLOAD must be 0 or 1."
[[ -n "$profile_name" ]] || fail "TRACK1_PROFILE_NAME is required: the name of the App Store provisioning profile."
# The name becomes a build setting, where a $(...) reference would be expanded.
[[ "$profile_name" != *'$'* ]] || fail "TRACK1_PROFILE_NAME must not contain a dollar sign."
[[ -n "$key_id" ]] || fail "ASC_KEY_ID is required."
[[ -n "$issuer_id" ]] || fail "ASC_ISSUER_ID is required."
[[ -f "$key_path" && -r "$key_path" ]] || fail "ASC_KEY_PATH must be a readable App Store Connect API key (.p8) file."

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
	-authenticationKeyPath "$key_path" \
	-authenticationKeyID "$key_id" \
	-authenticationKeyIssuerID "$issuer_id"

# An uploaded build leaves no IPA behind.
ipas=("$export_dir"/*.ipa)
[[ "$upload" == 1 || (${#ipas[@]} -eq 1 && -f "${ipas[0]}") ]] || fail "Expected exactly one IPA in $export_dir."

if [[ "$upload" != 1 ]]; then
	unzip -q "${ipas[0]}" -d "$work_dir/unpacked" || fail "Could not unpack ${ipas[0]}."
	apps=("$work_dir/unpacked"/Payload/*.app)
	[[ ${#apps[@]} -eq 1 && -d "${apps[0]}" ]] || fail "Expected exactly one .app in ${ipas[0]}."
	signature="$(codesign -d --verbose=2 "${apps[0]}" 2>&1)" || fail "codesign could not read the signature of ${apps[0]}."
	signed_identifier="$(printf '%s\n' "$signature" | sed -n 's/^Identifier=//p')"
	signed_team="$(printf '%s\n' "$signature" | sed -n 's/^TeamIdentifier=//p')"
	[[ "$signed_identifier" == "$bundle_identifier" ]] \
		|| fail "The exported app is signed as '$signed_identifier', expected '$bundle_identifier'."
	[[ "$signed_team" == "$team_id" ]] || fail "The exported app is signed by team '$signed_team', expected '$team_id'."
	embedded_url="$(plutil -extract Track1APIBaseURL raw -o - "${apps[0]}/Info.plist")" \
		|| fail "Could not read Track1APIBaseURL from the exported app."
	[[ "$embedded_url" == "$api_base_url" ]] \
		|| fail "The exported app embeds API URL '$embedded_url', expected '$api_base_url'."
fi

echo "Git SHA:  $git_sha"
echo "Version:  $marketing_version"
echo "Build:    $build_number"
echo "API URL:  $api_base_url"
[[ "$upload" == 1 ]] || echo "IPA:      ${ipas[0]}"
