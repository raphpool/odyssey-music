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

# 2026-10-12: ios-check took about 10 min (#336): two complete passes, one per scheme, each compiling
# from an empty DerivedData in the job's temporary folder (Track1 2 min 30 + 3 min of tests, then
# Track1Preview 45 s + 3 min of tests). Two changes, no test dropped where a result can differ:
#  - Track1 compiles and runs the whole suite, then verifies the contract report, as before.
#    Track1Preview is still compiled completely (that proves the scheme builds) but only runs the tests
#    below, because they are the only ones whose outcome can differ between the two schemes. The schemes
#    differ by (a) the Preview build configuration of the packages and of the app, (b) the Preview
#    xcconfig values (bundle identifier, Track1Environment, API base URL) that land in Info.plist, and
#    (c) SEGMENT_CDN_STANDARD on the Track1Tests target. Everything else compiles from the same sources.
#    - AppConfigurationTests.testApplicationBundleDeclaresAModernLaunchScreen reads the host app's
#      Info.plist at run time, which Preview generates from its own xcconfig.
#    - NavigationTests.testThreeTabsKeepTheirIndependentNavigationStacks is the one UI test kept: it
#      launches the Preview app and asserts that no "invalid-configuration" screen appears. A broken
#      Preview.xcconfig (bad API URL, empty environment) would put AppContainer in its fail-closed state
#      there and nowhere else, since the UI tests cover the same screens under both schemes.
#    - The five AnalyticsClientTests.testRealSegment* tests drive the real Segment SDK. Preview compiles
#      it without DEBUG (Development compiles it with DEBUG, which bypasses the CDN settings under
#      XCTest), and testRealSegmentWaitsForDelayedStartupBeforeSendingTheFirstEvent branches on
#      SEGMENT_CDN_STANDARD (the only use of the flag).
#    Not listed, on purpose: no other test reads the bundle, a compilation flag or the app identifier
#    (grep of Bundle, infoDictionary, #if, SEGMENT_CDN, bundleIdentifier in ios/Track1Tests and
#    ios/Track1UITests). The other AppConfigurationTests and the API tests build their configuration from
#    literals (AppConfiguration.validate(values:)); the other AnalyticsClientTests use fake transports or
#    SegmentTaskRegistry, so they never reach the SDK; the other UI tests run the same screens against
#    fixtures with no Segment write key (Info.plist declares none), so only the validity of the
#    configuration can differ, which the UI test above covers. test/ios-check.test.ts fails when a test file
#    outside this list starts reading the bundle, a compilation flag or the app identifier, and when a
#    listed test no longer exists.
#  - DerivedData is persistent and machine-local: <cache>/<Xcode>-<Package.resolved hash>-<ISO week>/<scheme>.
#    The week in the key rotates it weekly, which is a periodic clean build; keys unused for 14 days are
#    purged. A mkdir lock keeps two check.sh (the Mac hosts two runners) off the same folder: the loser does
#    not wait, it builds in a private folder under the output dir, exactly like before. A build that fails
#    on top of an existing cache is retried once from an empty folder, and says so.
# TRACK1_DERIVED_DATA_CACHE_DIR overrides the cache location (the tests use it).
derived_data_cache_base="${TRACK1_DERIVED_DATA_CACHE_DIR:-${HOME:-}/Library/Caches/track1-ci/DerivedData}"
derived_data_cache_retention_days=14
derived_data_root="$output_dir/DerivedData"
cache_lock_dir=""
preview_only_testing=(
	"Track1Tests/AppConfigurationTests/testApplicationBundleDeclaresAModernLaunchScreen"
	"Track1UITests/NavigationTests/testThreeTabsKeepTheirIndependentNavigationStacks"
	"Track1Tests/AnalyticsClientTests/testRealSegmentAdapterSendsOnlyAfterGrantAndPurgesAfterWithdrawal"
	"Track1Tests/AnalyticsClientTests/testRealSegmentAdapterMapsEventIDToMessageIDAndStripsContext"
	"Track1Tests/AnalyticsClientTests/testRealSegmentWaitsForDelayedStartupBeforeSendingTheFirstEvent"
	"Track1Tests/AnalyticsClientTests/testRealSegmentWithdrawalCancelsDelayedUploadAndPurgesSDKIdentity"
	"Track1Tests/AnalyticsClientTests/testRealSegmentAdapterReusesItsSingleSDKInstanceAfterRapidRegrant"
)

# Takes the lock, or returns 1 while a live process holds it. A lock whose owner is gone is taken over.
acquire_cache_lock() {
	local lock_dir="$1"
	local owner_pid
	if mkdir "$lock_dir" 2>/dev/null; then
		echo "$$" >"$lock_dir/pid"
		return 0
	fi
	owner_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
	if [[ "$owner_pid" =~ ^[0-9]+$ ]]; then
		kill -0 "$owner_pid" 2>/dev/null && return 1
	elif [[ -z "$(find "$lock_dir" -maxdepth 0 -mmin +1 2>/dev/null)" ]]; then
		# No pid yet and created less than a minute ago: its creator sits between mkdir and the write.
		return 1
	fi
	echo "Taking over the derived data lock of process ${owner_pid:-unknown}, which is gone."
	rm -rf "$lock_dir"
	mkdir "$lock_dir" 2>/dev/null || return 1
	echo "$$" >"$lock_dir/pid"
	# Two runs taking over the same dead lock can still interleave rm and mkdir: only the last writer wins.
	[[ "$(cat "$lock_dir/pid" 2>/dev/null || true)" == "$$" ]]
}

# Sets derived_data_root to the persistent folder of the current key, or leaves the private one under
# the output dir when the cache cannot be used. Never fails the check by itself.
setup_derived_data_cache() {
	local resolved_hash="none"
	local xcode_slug iso_week cache_key
	if [[ -z "${HOME:-}" && -z "${TRACK1_DERIVED_DATA_CACHE_DIR:-}" ]]; then
		echo "No home directory: DerivedData stays in $derived_data_root (cold build)."
		return 0
	fi
	if [[ -f "$package_resolved_path" ]]; then
		resolved_hash="$(shasum -a 256 <"$package_resolved_path" | cut -c1-12)"
	fi
	xcode_slug="$(printf '%s' "$actual_xcode" | tr -c 'A-Za-z0-9.' '-' | tr -s '-' | sed 's/-*$//')"
	iso_week="$(date +%G-W%V)"
	cache_key="$xcode_slug-$resolved_hash-$iso_week"
	if ! mkdir -p "$derived_data_cache_base"; then
		echo "Could not create $derived_data_cache_base: DerivedData stays in $derived_data_root (cold build)." >&2
		return 0
	fi
	if ! acquire_cache_lock "$derived_data_cache_base/$cache_key.lock"; then
		echo "DerivedData cache $cache_key is locked by another check.sh: building in $derived_data_root (cold build)."
		return 0
	fi
	cache_lock_dir="$derived_data_cache_base/$cache_key.lock"
	# A directory's mtime only moves when entries are added or removed, so refresh it: it is the age of the key.
	if ! mkdir -p "$derived_data_cache_base/$cache_key" || ! touch "$derived_data_cache_base/$cache_key"; then
		echo "Could not use $derived_data_cache_base/$cache_key: DerivedData stays in $derived_data_root (cold build)." >&2
		rm -rf "$cache_lock_dir"
		cache_lock_dir=""
		return 0
	fi
	derived_data_root="$derived_data_cache_base/$cache_key"
	find "$derived_data_cache_base" -mindepth 1 -maxdepth 1 -type d -mtime "+$derived_data_cache_retention_days" \
		! -name "$cache_key" ! -name "$cache_key.lock" -exec rm -rf {} + \
		|| echo "Could not purge the old DerivedData keys in $derived_data_cache_base; continuing." >&2
	echo "Using DerivedData cache $derived_data_root"
}

run_build_for_testing() {
	local scheme="$1"
	local derived_data_path="$2"
	xcodebuild \
		-onlyUsePackageVersionsFromResolvedFile \
		-disableAutomaticPackageResolution \
		-project "$project_path" \
		-scheme "$scheme" \
		-destination "platform=iOS Simulator,id=$simulator_id" \
		-derivedDataPath "$derived_data_path" \
		CODE_SIGNING_ALLOWED=NO \
		ONLY_ACTIVE_ARCH=NO \
		build-for-testing
}

# A build on top of an existing DerivedData that fails is retried once from an empty folder: a stale
# or corrupted cache must never turn into a red check. A build that already started cold is not retried.
build_for_testing() {
	local scheme="$1"
	local derived_data_path="$2"
	local was_warm="no"
	local aside_path="$derived_data_path.failed-$$"
	if [[ -d "$derived_data_path/Build/Products" ]]; then
		was_warm="yes"
		# A reused folder may hold the xctestrun of an earlier build: only this build's must be found.
		find "$derived_data_path/Build/Products" -maxdepth 1 -name '*.xctestrun' -type f -delete 2>/dev/null || true
	fi
	if run_build_for_testing "$scheme" "$derived_data_path"; then
		return 0
	fi
	[[ "$was_warm" == "yes" ]] || return 1
	echo "Build of $scheme failed with the cache at $derived_data_path; falling back to a cold build from an empty folder." >&2
	rm -rf "$aside_path"
	mv "$derived_data_path" "$aside_path"
	mkdir -p "$derived_data_path"
	if run_build_for_testing "$scheme" "$derived_data_path"; then
		rm -rf "$aside_path"
		return 0
	fi
	# The cold build fails too, so the sources are at fault, not the cache: keep the cache for the next run.
	rm -rf "$derived_data_path"
	mv "$aside_path" "$derived_data_path"
	return 1
}

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
	[[ -n "$cache_lock_dir" ]] && rm -rf "$cache_lock_dir"
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

setup_derived_data_cache
start_contract_harness

simulator_id="$(xcrun simctl create "$simulator_name" "iPhone 17 Pro" "$runtime_id")"
wait_for_simulator_boot

for scheme in Track1 Track1Preview; do
	derived_data_path="$derived_data_root/$scheme"
	build_for_testing "$scheme" "$derived_data_path"
	xctestrun_path="$(find "$derived_data_path/Build/Products" -maxdepth 1 -name '*.xctestrun' -type f -print -quit)"
	if [[ -z "$xctestrun_path" ]]; then
		echo "xcodebuild did not produce an xctestrun file for $scheme." >&2
		exit 1
	fi
	/usr/libexec/PlistBuddy -c "Add :Track1Tests:EnvironmentVariables dict" "$xctestrun_path" 2>/dev/null || true
	/usr/libexec/PlistBuddy -c "Add :Track1Tests:EnvironmentVariables:TRACK1_CONTRACT_BASE_URL string $contract_base_url" "$xctestrun_path" 2>/dev/null \
		|| /usr/libexec/PlistBuddy -c "Set :Track1Tests:EnvironmentVariables:TRACK1_CONTRACT_BASE_URL $contract_base_url" "$xctestrun_path"
	# Track1 runs the whole suite; Track1Preview only the tests listed in preview_only_testing.
	only_testing_arguments=()
	if [[ "$scheme" == "Track1Preview" ]]; then
		for only_testing in "${preview_only_testing[@]}"; do
			only_testing_arguments+=("-only-testing:$only_testing")
		done
	fi
	if ! xcodebuild \
		test-without-building \
		-xctestrun "$xctestrun_path" \
		-test-timeouts-enabled YES \
		-default-test-execution-time-allowance "$test_execution_time_allowance_seconds" \
		-destination "platform=iOS Simulator,id=$simulator_id" \
		-resultBundlePath "$output_dir/$scheme-$$.xcresult" \
		${only_testing_arguments[@]+"${only_testing_arguments[@]}"} \
		CODE_SIGNING_ALLOWED=NO \
		ONLY_ACTIVE_ARCH=NO \
		-quiet
	then
		echo "XCTest failed before contract verification; observed proxy requests:" >&2
		curl --fail --silent --show-error "${contract_base_url%/mobile/v1/}/__track1_contract_report" >&2 || true
		exit 1
	fi
	# The contract tests only run in the full pass.
	if [[ "$scheme" == "Track1" ]]; then
		verify_contract_report
		reset_contract_report
	fi
done
