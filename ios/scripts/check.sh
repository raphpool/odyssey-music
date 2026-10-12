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
contract_dir=""
contract_pid=""
contract_base_url=""
swift_discovery_file=""
swift_sorted_file=""
runtime_id="$(xcrun simctl list runtimes available -j | jq -r '.runtimes[] | select(.name == "iOS 26.4") | .identifier' | head -n 1)"
simulator_boot_timeout_seconds="${SIMULATOR_BOOT_TIMEOUT_SECONDS:-600}"
swift_files=()

# 2026-10-12: #330 (TRA-368) had its ios-check cancelled three times at the 30 min job timeout because one
# test awaited a continuation that was never resumed (a fake OSOpener(hold: true) reused after release()),
# and nothing named the culprit. With test timeouts on, XCTest fails the hanging test by name (xcresult),
# restarts the test process and carries on with the next test.
# 180 s = 3 whole minutes (XCTest rounds allowances up to the next minute). The slowest passing tests in
# the xcresults of #336 and main after #334 took 15 s (unit) and 24 s (UI), up to 48 s (UI) under load,
# so the margin is about 3.8x. No test sets its own executionTimeAllowance, hence no
# -maximum-test-execution-time-allowance: it would also cap tests that ask for more.
test_execution_time_allowance_seconds=180

discover_swift_files() {
	local swift_file
	local swift_root
	swift_discovery_file="$(mktemp "${TMPDIR:-/tmp}/track1-swift-discovery.XXXXXX")"
	swift_sorted_file="$(mktemp "${TMPDIR:-/tmp}/track1-swift-sorted.XXXXXX")"
	for swift_root in "$ios_dir/Track1" "$ios_dir/Track1Tests" "$ios_dir/Track1UITests"; do
		if [[ ! -d "$swift_root" || -L "$swift_root" ]]; then
			echo "Expected Swift source root is missing or is a symlink: $swift_root" >&2
			return 1
		fi
		if ! find -P "$swift_root" \
			\( -type d \( -name DerivedData -o -name SourcePackages -o -name .build \) -prune \) \
			-o \( -type f -name '*.swift' -print \) >>"$swift_discovery_file"; then
			echo "Could not discover Swift source files under $swift_root." >&2
			return 1
		fi
	done
	if ! LC_ALL=C sort -u "$swift_discovery_file" >"$swift_sorted_file"; then
		echo "Could not sort the discovered Swift source files." >&2
		return 1
	fi
	while IFS= read -r swift_file; do
		[[ -n "$swift_file" ]] && swift_files+=("$swift_file")
	done <"$swift_sorted_file"
	if ((${#swift_files[@]} == 0)); then
		echo "No Swift source files were discovered under the expected roots." >&2
		return 1
	fi
}

cleanup() {
	if [[ -n "$contract_pid" ]] && kill -0 "$contract_pid" 2>/dev/null; then
		kill -TERM "$contract_pid" 2>/dev/null || true
		for _ in {1..20}; do
			kill -0 "$contract_pid" 2>/dev/null || break
			sleep 0.1
		done
		kill -0 "$contract_pid" 2>/dev/null && kill -KILL "$contract_pid" 2>/dev/null || true
		wait "$contract_pid" 2>/dev/null || true
	fi
	[[ -n "$contract_dir" ]] && rm -rf "$contract_dir"
	[[ -n "$swift_discovery_file" ]] && rm -f "$swift_discovery_file"
	[[ -n "$swift_sorted_file" ]] && rm -f "$swift_sorted_file"
	if [[ -n "$simulator_id" ]]; then
		xcrun simctl shutdown "$simulator_id" >/dev/null 2>&1 || true
		xcrun simctl delete "$simulator_id" >/dev/null 2>&1 || true
	fi
}

# 2026-10-11: a cancelled run never reaches cleanup(), so its booted simulators stayed alive on the
# single macOS runner (11.7 GB of swap) and the next runs timed out right after "TEST BUILD SUCCEEDED",
# leaving their own simulators behind in turn.
# 2026-10-12: the first version removed every `track1-ci-*` device of another run, but the Mac hosts two
# self-hosted runners, so another ios-check can be running at the same time; it killed the simulator of a
# live run ("Test crashed with signal term"). A device is now removed only once the process that created it
# (the trailing pid of its name, see simulator_name) is gone; the runner kills orphaned processes when a job
# is cancelled, so an abandoned device always has a dead pid. Names without a numeric pid are left alone.
# Failures are logged and ignored so the cleanup can never fail the check itself.
remove_stale_simulators() {
	local own_prefix="track1-ci-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-"
	local device_pattern='^[[:space:]]+(track1-ci-[^ (]+) \(([0-9A-Fa-f-]{36})\)'
	local pid_pattern='-([0-9]+)$'
	local listing line name udid owner_pid
	if ! listing="$(xcrun simctl list devices 2>&1)"; then
		echo "Could not list simulators; skipping stale simulator cleanup: $listing" >&2
		return 0
	fi
	while IFS= read -r line; do
		[[ "$line" =~ $device_pattern ]] || continue
		name="${BASH_REMATCH[1]}"
		udid="${BASH_REMATCH[2]}"
		[[ "$name" == "$own_prefix"* ]] && continue
		[[ "$name" =~ $pid_pattern ]] || continue
		owner_pid="${BASH_REMATCH[1]}"
		kill -0 "$owner_pid" 2>/dev/null && continue
		echo "Removing stale simulator $name ($udid): process $owner_pid is gone."
		xcrun simctl shutdown "$udid" >/dev/null 2>&1 \
			|| echo "Could not shut down stale simulator $name ($udid); continuing." >&2
		xcrun simctl delete "$udid" >/dev/null 2>&1 \
			|| echo "Could not delete stale simulator $name ($udid); continuing." >&2
	done <<<"$listing"
}

start_contract_harness() {
	contract_dir="$(mktemp -d "${TMPDIR:-/tmp}/track1-contract.XXXXXX")"
	local ready_file="$contract_dir/base-url"
	local log_file="$contract_dir/server.log"
	env -i \
		PATH="$PATH" \
		ODYSSEY_CACHE_DIR="$contract_dir/cache" \
		MOBILE_STATE_DIR="$contract_dir/mobile-state" \
		STREAM_CACHE_DIR="$contract_dir/stream-cache" \
		MB_BASE_URL="http://127.0.0.1:1" \
		MOBILE_PUSH_ENABLED="false" \
		MOBILE_APNS_PUSH_ENABLED="false" \
		GEMINI_API_KEY="contract-test-only" \
		TAVILY_API_KEY="contract-test-only" \
		FIRECRAWL_API_KEY="contract-test-only" \
		node --import tsx "$repository_root/test/helpers/mobile-contract-server.ts" --ready-file "$ready_file" >"$log_file" 2>&1 &
	contract_pid=$!
	for _ in {1..100}; do
		[[ -s "$ready_file" ]] && break
		if ! kill -0 "$contract_pid" 2>/dev/null; then
			cat "$log_file" >&2
			return 1
		fi
		sleep 0.05
	done
	if [[ ! -s "$ready_file" ]]; then
		echo "The mobile contract harness did not publish its XCTest base URL." >&2
		cat "$log_file" >&2
		return 1
	fi
	contract_base_url="$(<"$ready_file")"
	if [[ ! "$contract_base_url" =~ ^http://127\.0\.0\.1:[0-9]+/mobile/v1/$ ]]; then
		echo "The mobile contract harness published an unsafe XCTest base URL." >&2
		return 1
	fi
}

verify_contract_report() {
	local report
	report="$(curl --fail --silent --show-error "${contract_base_url%/mobile/v1/}/__track1_contract_report")"
	node -e '
		const report = JSON.parse(process.argv[1]);
		const expected = report.catalogRequests >= 2 && report.notModifiedCatalogRequests >= 1 && report.nodeRequests >= 1 && report.generationPosts === 1 && report.providerFetchAttempts === 0;
		if (!expected) throw new Error(`Invalid mobile contract report: ${JSON.stringify(report)}`);
	' "$report"
}

reset_contract_report() {
	curl --fail --silent --show-error --request POST "${contract_base_url%/mobile/v1/}/__track1_contract_reset" >/dev/null
}

ensure_contract_runtime() {
	if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
		echo "The mobile contract harness requires Node.js >=20 and npm." >&2
		return 1
	fi
	local node_major
	if ! node_major="$(node -p 'process.versions.node.split(".")[0]')"; then
		echo "Could not determine the Node.js version required by the mobile contract harness." >&2
		return 1
	fi
	if [[ ! "$node_major" =~ ^[0-9]+$ ]] || ((node_major < 20)); then
		echo "The mobile contract harness requires Node.js >=20; found $(node --version)." >&2
		return 1
	fi
	if [[ ! -f "$repository_root/package-lock.json" ]]; then
		echo "The mobile contract harness requires the repository package-lock.json." >&2
		return 1
	fi
	if [[ -x "$repository_root/node_modules/.bin/tsx" ]]; then
		return
	fi
	echo "Installing locked Node dependencies required by the mobile contract harness."
	npm --prefix "$repository_root" --cache "$output_dir/npm-cache" ci --ignore-scripts --no-audit --no-fund
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
trap 'exit 130' INT TERM

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
remove_stale_simulators

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

discover_swift_files
ensure_contract_runtime

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

start_contract_harness

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
		ONLY_ACTIVE_ARCH=NO \
		build-for-testing
	xctestrun_path="$(find "$output_dir/DerivedData/$scheme/Build/Products" -maxdepth 1 -name '*.xctestrun' -type f -print -quit)"
	if [[ -z "$xctestrun_path" ]]; then
		echo "xcodebuild did not produce an xctestrun file for $scheme." >&2
		exit 1
	fi
	/usr/libexec/PlistBuddy -c "Add :Track1Tests:EnvironmentVariables dict" "$xctestrun_path" 2>/dev/null || true
	/usr/libexec/PlistBuddy -c "Add :Track1Tests:EnvironmentVariables:TRACK1_CONTRACT_BASE_URL string $contract_base_url" "$xctestrun_path" 2>/dev/null \
		|| /usr/libexec/PlistBuddy -c "Set :Track1Tests:EnvironmentVariables:TRACK1_CONTRACT_BASE_URL $contract_base_url" "$xctestrun_path"
	if ! xcodebuild \
		test-without-building \
		-xctestrun "$xctestrun_path" \
		-test-timeouts-enabled YES \
		-default-test-execution-time-allowance "$test_execution_time_allowance_seconds" \
		-destination "platform=iOS Simulator,id=$simulator_id" \
		-resultBundlePath "$output_dir/$scheme-$$.xcresult" \
		CODE_SIGNING_ALLOWED=NO \
		ONLY_ACTIVE_ARCH=NO \
		-quiet
	then
		echo "XCTest failed before contract verification; observed proxy requests:" >&2
		curl --fail --silent --show-error "${contract_base_url%/mobile/v1/}/__track1_contract_report" >&2 || true
		exit 1
	fi
	verify_contract_report
	reset_contract_report
done
