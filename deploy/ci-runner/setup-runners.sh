#!/usr/bin/env bash
# Registers COUNT GitHub Actions runners for raphpool/odyssey-music on a host provisioned by cloud-init.yaml and
# writes their systemd units. Idempotent: a configured runner is not registered again, but its unit is rewritten on
# every pass, so a rerun converges after a partial failure. Labels: the automatic self-hosted/Linux/<arch> plus
# `linux` (labels are case-insensitive, so it merges with `Linux`), which the workflows select.
#
# 8 runners by default: a ready PR starts 8 jobs at once (6 ci jobs, review, review-gate), most of them I/O-bound
# npm ci. Over Oct 16-20, outside the night the Mac slept, demand stayed at or under 8 jobs ~85% of the time.
#
# Isolation, per runner (runners execute PR code):
# - its own unprivileged user (runner-1 ... runner-N);
# - PrivateTmp: deploy.yml loads the prod key into an ssh-agent whose socket lives under /tmp;
# - ProtectProc=invisible: /proc of other users' processes would otherwise expose the registration token of a rerun
#   and the GITHUB_TOKEN that top-up-genres.yml passes to `git push` (deep review of PR #568, 2026-10-21).
# Root never executes a file a runner user can write: dependencies are installed from a root-owned extraction, and the
# units are written here rather than by the runner's svc.sh. After setup, manage the runners with systemctl only,
# never with svc.sh (runner-owned, so a job could rewrite it before root runs it).
#
# From a machine with gh logged in (the token goes through stdin, then the environment, never a command line):
#   scp -i ~/.ssh/odyssey-ci deploy/ci-runner/setup-runners.sh root@<host>:/root/
#   gh api -X POST repos/raphpool/odyssey-music/actions/runners/registration-token --jq .token \
#     | ssh -i ~/.ssh/odyssey-ci root@<host> bash /root/setup-runners.sh 8
# A rewritten unit applies at the next restart of that runner; restart while it runs no job:
#   systemctl restart 'actions.runner.raphpool-odyssey-music.odyssey-linux-*'
set -euo pipefail

COUNT="${1:-8}"
REPO_URL="https://github.com/raphpool/odyssey-music"
RUNNER_VERSION="2.338.0"
UNIT_PREFIX="actions.runner.raphpool-odyssey-music.odyssey-linux"

# SHA-256 from the release notes of actions/runner v2.338.0; the download is checked against it.
case "$(uname -m)" in
	aarch64) ARCH=arm64 SHA=628b4a7258487b80c1d3c221095a7ded349f5ae0175fd3dfab708d07428f041b ;;
	x86_64) ARCH=x64 SHA=af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32 ;;
	*) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

install -d -m 755 /opt/actions-runner
TARBALL="/opt/actions-runner/actions-runner-linux-${ARCH}-${RUNNER_VERSION}.tar.gz"
if [ ! -f "$TARBALL" ]; then
	curl -fsSLo "$TARBALL" \
		"https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/$(basename "$TARBALL")"
fi
echo "${SHA}  ${TARBALL}" | sha256sum -c --quiet -
chmod 644 "$TARBALL"

DIST="/opt/actions-runner/dist-${RUNNER_VERSION}-${ARCH}"
if [ ! -d "$DIST" ]; then
	install -d -m 755 "$DIST"
	tar -xzf "$TARBALL" -C "$DIST"
	"$DIST/bin/installdependencies.sh" > /dev/null
fi

RUNNER_TOKEN=""
for i in $(seq 1 "$COUNT"); do
	user="runner-$i"
	dir="/home/$user/actions-runner"
	id "$user" > /dev/null 2>&1 || useradd --create-home --shell /bin/bash "$user"
	chmod 700 "/home/$user"
	if [ ! -f "$dir/.runner" ]; then
		if [ -z "$RUNNER_TOKEN" ]; then
			read -r RUNNER_TOKEN || true
			test -n "$RUNNER_TOKEN"
		fi
		sudo -u "$user" mkdir -p "$dir"
		sudo -u "$user" tar -xzf "$TARBALL" -C "$dir"
		# config.sh reads ACTIONS_RUNNER_INPUT_TOKEN (CommandSettings.cs, v2.338.0), so the token stays out of argv.
		ACTIONS_RUNNER_INPUT_TOKEN="$RUNNER_TOKEN" sudo --preserve-env=ACTIONS_RUNNER_INPUT_TOKEN -u "$user" \
			"$dir/config.sh" --unattended --replace --url "$REPO_URL" --name "odyssey-linux-$i" --labels linux --work _work
		echo "odyssey-linux-$i registered ($user)"
	fi
	[ -f "$dir/runsvc.sh" ] || sudo -u "$user" cp "$dir/bin/runsvc.sh" "$dir/runsvc.sh"
	unit="$UNIT_PREFIX-$i.service"
	# The first version of this script put PrivateTmp in a drop-in; it now lives in the unit itself.
	rm -rf "/etc/systemd/system/$unit.d"
	cat > "/etc/systemd/system/$unit" <<-UNIT
		[Unit]
		Description=GitHub Actions Runner (raphpool-odyssey-music.odyssey-linux-$i)
		After=network-online.target
		Wants=network-online.target

		[Service]
		ExecStart=$dir/runsvc.sh
		User=$user
		WorkingDirectory=$dir
		KillMode=process
		KillSignal=SIGTERM
		TimeoutStopSec=5min
		PrivateTmp=yes
		ProtectProc=invisible

		[Install]
		WantedBy=multi-user.target
	UNIT
done
systemctl daemon-reload
for i in $(seq 1 "$COUNT"); do
	systemctl enable --now "$UNIT_PREFIX-$i.service" 2> /dev/null
done
echo "$COUNT runner units written and enabled"
