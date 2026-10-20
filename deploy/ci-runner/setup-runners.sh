#!/usr/bin/env bash
# Registers COUNT GitHub Actions runners for raphpool/odyssey-music on a host provisioned by cloud-init.yaml.
# Idempotent: configured runners are skipped. Labels: the automatic self-hosted/Linux/<arch> plus `linux`, which
# the workflows select.
#
# Each runner gets its own unprivileged user (runner-1 ... runner-N) and a private /tmp. Runners execute PR code,
# and deploy.yml loads the prod key into an ssh-agent whose socket lives under /tmp: with one shared account, a
# job on another runner could reach that socket, or read another job's files.
#
# From a machine with gh logged in (the token goes through stdin, not a command line):
#   scp -i ~/.ssh/odyssey-ci deploy/ci-runner/setup-runners.sh root@<host>:/root/
#   gh api -X POST repos/raphpool/odyssey-music/actions/runners/registration-token --jq .token \
#     | ssh -i ~/.ssh/odyssey-ci root@<host> bash /root/setup-runners.sh 4
set -euo pipefail

COUNT="${1:-4}"
REPO_URL="https://github.com/raphpool/odyssey-music"
RUNNER_VERSION="2.338.0"
read -r RUNNER_TOKEN
test -n "$RUNNER_TOKEN"

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

deps_done=false
for i in $(seq 1 "$COUNT"); do
	user="runner-$i"
	dir="/home/$user/actions-runner"
	id "$user" > /dev/null 2>&1 || useradd --create-home --shell /bin/bash "$user"
	chmod 700 "/home/$user"
	if [ -f "$dir/.runner" ]; then
		echo "odyssey-linux-$i already configured"
		continue
	fi
	sudo -u "$user" mkdir -p "$dir"
	sudo -u "$user" tar -xzf "$TARBALL" -C "$dir"
	if [ "$deps_done" = false ]; then
		"$dir/bin/installdependencies.sh" > /dev/null
		deps_done=true
	fi
	# config.sh only takes the token as an argument; it is a one-hour registration token, and no job runs yet.
	sudo -u "$user" "$dir/config.sh" --unattended --replace --url "$REPO_URL" --token "$RUNNER_TOKEN" \
		--name "odyssey-linux-$i" --labels linux --work _work
	(cd "$dir" && ./svc.sh install "$user" > /dev/null)
	unit="$(cat "$dir/.service")"
	install -d "/etc/systemd/system/$unit.d"
	printf '[Service]\nPrivateTmp=yes\n' > "/etc/systemd/system/$unit.d/10-private-tmp.conf"
	systemctl daemon-reload
	(cd "$dir" && ./svc.sh start > /dev/null)
	echo "odyssey-linux-$i installed ($user)"
done
