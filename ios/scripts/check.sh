#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ios_dir="$(cd "$script_dir/.." && pwd)"
repository_root="$(cd "$ios_dir/.." && pwd)"
project_path="$ios_dir/Track1.xcodeproj"
project_file="$project_path/project.pbxproj"
format_configuration="$ios_dir/.swift-format"
expected_xcode="$(<"$ios_dir/.xcode-version")"
actual_xcode="$({ xcodebuild -version | awk '
  NR == 1 { version = $2 }
  NR == 2 { build = $3 }
  END { printf "Xcode %s (%s)", version, build }
'; })"
output_dir="${TRACK1_CI_OUTPUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/track1-ci.XXXXXX")}"
package_resolved_relative="ios/Track1.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
package_resolved_path="$repository_root/$package_resolved_relative"
simulator_name="track1-ci-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
simulator_id=""
runtime_id="$(xcrun simctl list runtimes available -j | jq -r '.runtimes[] | select(.name == "iOS 26.4") | .identifier' | head -n 1)"
simulator_boot_timeout_seconds="${SIMULATOR_BOOT_TIMEOUT_SECONDS:-600}"
swift_files=(
	"$ios_dir/Track1/App/AppConfiguration.swift"
	"$ios_dir/Track1/App/AppRouter.swift"
	"$ios_dir/Track1/App/RootView.swift"
	"$ios_dir/Track1/DesignSystem/Track1Theme.swift"
	"$ios_dir/Track1Tests/AppConfigurationTests.swift"
)

cleanup() {
	if [[ -n "$simulator_id" ]]; then
		xcrun simctl shutdown "$simulator_id" >/dev/null 2>&1 || true
		xcrun simctl delete "$simulator_id" >/dev/null 2>&1 || true
	fi
}

wait_for_simulator_boot() {
	xcrun simctl bootstatus "$simulator_id" -b &
	local bootstatus_process_id=$!
	local elapsed_seconds=0

	while kill -0 "$bootstatus_process_id" 2>/dev/null; do
		if ((elapsed_seconds >= simulator_boot_timeout_seconds)); then
			kill "$bootstatus_process_id" 2>/dev/null || true
			wait "$bootstatus_process_id" || true
			echo "Simulator $simulator_name did not finish booting within ${simulator_boot_timeout_seconds}s." >&2
			return 1
		fi
		sleep 1
		((elapsed_seconds += 1))
	done

	wait "$bootstatus_process_id"
}

trap cleanup EXIT

if [[ "$actual_xcode" != "$expected_xcode" ]]; then
	echo "Expected $expected_xcode but xcodebuild selected $actual_xcode." >&2
	exit 1
fi
if [[ -z "$runtime_id" ]]; then
	echo "The iOS 26.4 simulator runtime required by $expected_xcode is unavailable." >&2
	exit 1
fi

echo "Using $actual_xcode"
mkdir -p "$output_dir"

if grep -q "XCRemoteSwiftPackageReference" "$project_file"; then
	if [[ ! -f "$package_resolved_path" ]]; then
		echo "External Swift packages require $package_resolved_relative." >&2
		exit 1
	fi
	if ! git -C "$repository_root" ls-files --error-unmatch -- "$package_resolved_relative" >/dev/null; then
		echo "$package_resolved_relative must be versioned when external Swift packages are declared." >&2
		exit 1
	fi
else
	echo "No external Swift package is declared; no Package.resolved is required."
fi

xcrun swift-format lint --strict --configuration "$format_configuration" "${swift_files[@]}"

for scheme in Track1 Track1Preview; do
	xcodebuild \
		-resolvePackageDependencies \
		-onlyUsePackageVersionsFromResolvedFile \
		-disableAutomaticPackageResolution \
		-project "$project_path" \
		-scheme "$scheme" \
		-clonedSourcePackagesDirPath "$output_dir/SourcePackages"
done

simulator_id="$(xcrun simctl create "$simulator_name" "iPhone 17 Pro" "$runtime_id")"
wait_for_simulator_boot

for scheme in Track1 Track1Preview; do
	xcodebuild \
		-onlyUsePackageVersionsFromResolvedFile \
		-disableAutomaticPackageResolution \
		-project "$project_path" \
		-scheme "$scheme" \
		-destination "platform=iOS Simulator,id=$simulator_id" \
		-derivedDataPath "$output_dir/DerivedData/$scheme" \
		CODE_SIGNING_ALLOWED=NO \
		build
	xcodebuild \
		-onlyUsePackageVersionsFromResolvedFile \
		-disableAutomaticPackageResolution \
		-project "$project_path" \
		-scheme "$scheme" \
		-destination "platform=iOS Simulator,id=$simulator_id" \
		-derivedDataPath "$output_dir/DerivedData/$scheme" \
		-resultBundlePath "$output_dir/$scheme-$$.xcresult" \
		CODE_SIGNING_ALLOWED=NO \
		test
done
