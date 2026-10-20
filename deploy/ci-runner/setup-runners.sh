#!/usr/bin/env bash
# Registers COUNT GitHub Actions runners for raphpool/odyssey-music on a host provisioned by cloud-init.yaml,
# one systemd service each, all running as the unprivileged `runner` user. Idempotent: configured runners are
# skipped. Labels: the automatic self-hosted/Linux/<arch> plus `linux`, which the workflows select.
#
# From a machine with gh logged in:
#   TOKEN=$(gh api -X POST repos/raphpool/odyssey-music/actions/runners/registration-token --jq .token)
#   ssh -i ~/.ssh/odyssey-ci root@<host> "RUNNER_TOKEN=$TOKEN bash -s 4" < deploy/ci-runner/setup-runners.sh
set -euo pipefail

COUNT="${1:-4}"
REPO_URL="https://github.com/raphpool/odyssey-music"
RUNNER_VERSION="2.338.0"
: "${RUNNER_TOKEN:?registration token required, see the header}"

# SHA-256 from the release notes of actions/runner v2.338.0; the download is checked against it.
case "$(uname -m)" in
	aarch64) ARCH=arm64 SHA=628b4a7258487b80c1d3c221095a7ded349f5ae0175fd3dfab708d07428f041b ;;
	x86_64) ARCH=x64 SHA=af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32 ;;
	*) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

id runner > /dev/null
TARBALL="/home/runner/actions-runner-linux-${ARCH}-${RUNNER_VERSION}.tar.gz"
if [ ! -f "$TARBALL" ]; then
	sudo -u runner curl -fsSLo "$TARBALL" \
		"https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/$(basename "$TARBALL")"
fi
echo "${SHA}  ${TARBALL}" | sha256sum -c --quiet -

deps_done=false
for i in $(seq 1 "$COUNT"); do
	dir="/home/runner/actions-runner-$i"
	if [ -f "$dir/.runner" ]; then
		echo "odyssey-linux-$i already configured"
		continue
	fi
	sudo -u runner mkdir -p "$dir"
	sudo -u runner tar -xzf "$TARBALL" -C "$dir"
	if [ "$deps_done" = false ]; then
		"$dir/bin/installdependencies.sh" > /dev/null
		deps_done=true
	fi
	sudo -u runner "$dir/config.sh" --unattended --replace --url "$REPO_URL" --token "$RUNNER_TOKEN" \
		--name "odyssey-linux-$i" --labels linux --work _work
	(cd "$dir" && ./svc.sh install runner > /dev/null && ./svc.sh start > /dev/null)
	echo "odyssey-linux-$i installed"
done
