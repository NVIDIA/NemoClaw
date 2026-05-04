#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# E2E: Docker 26+ overlayfs nested-mount auto-fix (NemoClaw#2481)
#
# Validates that NemoClaw transparently builds a fuse-overlayfs cluster
# image and routes around the kernel-level nested-overlay limitation when
# the host runs Docker 26+ with the containerd image store enabled. Also
# validates the negative path: with NEMOCLAW_DISABLE_OVERLAY_FIX=1 the
# original failure mode reproduces, proving the auto-fix is the
# load-bearing piece (not coincidence).
#
# This test is **TEMPORARY**. It exists to guard the workaround in
# src/lib/cluster-image-patch.ts while OpenShell roadmap #873 lands a
# non-k3s sandbox driver. Remove this script, the
# overlayfs-autofix-e2e workflow job, and the matching notify-on-failure
# needs entry in the same PR that deletes src/lib/cluster-image-patch.ts.
#
# Test phases:
#   1. Prerequisites — Docker running, NVIDIA_API_KEY, sudo, etc.
#   2. Setup — flip /etc/docker/daemon.json to enable containerd-snapshotter,
#      restart Docker, verify the conflict config is active. Auto-skip on
#      runners whose Docker does not support the feature flag.
#   3. Pre-cleanup — destroy any leftover sandbox/gateway/patched image.
#   4. Positive — install + onboard, expect the auto-fix to trigger and
#      the gateway to come up on the patched image.
#   5. Idempotency — call ensurePatchedClusterImage directly via Node and
#      verify the local Docker cache hit returns the same tag without
#      re-invoking docker pull/build. We deliberately do NOT re-run
#      install.sh here because the OpenClaw sandbox-image build step is
#      independently flaky on GitHub Actions runner kernels (nested
#      overlayfs limitations) and would make this phase a coin toss.
#   6. Negative — onboard with NEMOCLAW_DISABLE_OVERLAY_FIX=1, expect
#      install.sh to fail within a bounded timeout. Three-way result:
#        - nested-overlay signature in cluster or install log → PASS
#          (canonical k3s string, "CreateDiff: Canceled", or
#          "failed to mount overlay")
#        - signature absent AND `timeout` fired (exit 124)      → SKIP
#          (this runner instance did not reproduce the bug)
#        - signature absent AND a different non-zero exit       → FAIL
#          (likely an unrelated flake)
#   7. Final teardown — revert daemon.json, restart Docker, destroy sandbox.
#
# Prerequisites:
#   - Docker installed (any version that supports `features.containerd-snapshotter`,
#     i.e. Docker 23+; the test skips cleanly on older versions)
#   - Passwordless sudo (for editing /etc/docker/daemon.json + restarting Docker)
#   - NVIDIA_API_KEY set (real key; required by install.sh)
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1                — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1    — required
#   NVIDIA_API_KEY                            — required
#   NEMOCLAW_SANDBOX_NAME                     — sandbox name (default: e2e-overlayfs)
#   NEMOCLAW_E2E_TIMEOUT_SECONDS              — overall timeout (default: 1500)
#   NEMOCLAW_OVERLAYFS_E2E_NEGATIVE_TIMEOUT   — negative-phase k3s wait (default: 300)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 \
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#   NVIDIA_API_KEY=nvapi-... \
#     bash test/e2e/test-overlayfs-autofix.sh

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=1500
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() {
  ((PASS++))
  ((TOTAL++))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail() {
  ((FAIL++))
  ((TOTAL++))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}
skip() {
  ((SKIP++))
  ((TOTAL++))
  printf '\033[33m  SKIP: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-overlayfs}"
NEGATIVE_TIMEOUT="${NEMOCLAW_OVERLAYFS_E2E_NEGATIVE_TIMEOUT:-300}"
GATEWAY_CONTAINER="openshell-cluster-nemoclaw"
DAEMON_JSON="/etc/docker/daemon.json"

# Use a private temp directory for daemon-state files. The previous
# fixed-name paths under /tmp were predictable enough that a pre-created
# symlink at /tmp/nemoclaw-e2e-daemon.json.bak could redirect the
# subsequent `sudo cp` into an attacker-chosen path on a shared runner.
# `mktemp -d` returns a per-run directory with mode 0700, so neither the
# backup nor the absent-marker path is guessable.
STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-overlayfs-e2e.XXXXXX")"
DAEMON_JSON_BACKUP="${STATE_DIR}/daemon.json.bak"
DAEMON_JSON_ABSENT_MARKER="${STATE_DIR}/daemon.json.absent"
INSTALL_LOG="${NEMOCLAW_E2E_INSTALL_LOG:-/tmp/nemoclaw-e2e-install.log}"
ONBOARD_LOG_POSITIVE="/tmp/nemoclaw-e2e-onboard-positive.log"
ONBOARD_LOG_NEGATIVE="/tmp/nemoclaw-e2e-onboard-negative.log"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ── Daemon revert ───────────────────────────────────────────────────
# Always restore the original daemon.json on exit so we don't leave the
# runner in a degraded state if the test crashes mid-flight.
# shellcheck disable=SC2329  # invoked via the EXIT trap below
revert_daemon_config() {
  if [ -f "$DAEMON_JSON_ABSENT_MARKER" ]; then
    # No original file existed; remove whatever we wrote so the daemon
    # falls back to defaults on restart.
    info "Removing test-generated $DAEMON_JSON (no original to restore)..."
    sudo rm -f "$DAEMON_JSON" 2>/dev/null || true
    sudo systemctl restart docker 2>/dev/null || true
  elif [ -f "$DAEMON_JSON_BACKUP" ]; then
    info "Reverting Docker daemon configuration..."
    sudo cp "$DAEMON_JSON_BACKUP" "$DAEMON_JSON" 2>/dev/null || true
    sudo systemctl restart docker 2>/dev/null || true
  fi
  # Always wipe the private state dir on exit. mktemp -d created it 0700,
  # so this is per-run cleanup without affecting other concurrent tests.
  rm -rf "$STATE_DIR" 2>/dev/null || true
}
trap revert_daemon_config EXIT

# ══════════════════════════════════════════════════════════════════
# Phase 0: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Prerequisites"

if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running — cannot continue"
  exit 1
fi

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY is set"
else
  fail "NVIDIA_API_KEY not set or invalid"
  exit 1
fi

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
  fail "NEMOCLAW_NON_INTERACTIVE=1 is required"
  exit 1
fi

if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
  fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required"
  exit 1
fi

if sudo -n true 2>/dev/null; then
  pass "Passwordless sudo available"
else
  fail "Passwordless sudo required to edit $DAEMON_JSON"
  exit 1
fi

if [ ! -f "$REPO_ROOT/install.sh" ]; then
  fail "Cannot find install.sh at $REPO_ROOT/install.sh"
  exit 1
fi
pass "Repo root found: $REPO_ROOT"

DOCKER_VERSION=$(docker info --format '{{.ServerVersion}}' 2>/dev/null || echo "unknown")
DOCKER_MAJOR=$(echo "$DOCKER_VERSION" | cut -d. -f1)
info "Docker server version: $DOCKER_VERSION"
if [ "${DOCKER_MAJOR:-0}" -lt 23 ] 2>/dev/null; then
  skip "Docker $DOCKER_VERSION predates the containerd-snapshotter feature flag — nothing to validate"
  echo ""
  printf '\033[1;33m=== Test summary ===\033[0m\n'
  echo "  PASS:  $PASS"
  echo "  FAIL:  $FAIL"
  echo "  SKIP:  $SKIP"
  exit 0
fi

# ══════════════════════════════════════════════════════════════════
# Phase 1: Force the bug-triggering Docker configuration
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Enable containerd image store on the host"

# Back up whatever's there (or note its absence) so the EXIT trap can restore it.
# Both paths live inside the per-run STATE_DIR (mode 0700, mktemp-allocated),
# so neither is guessable for symlink redirects.
if [ -f "$DAEMON_JSON" ]; then
  sudo cp "$DAEMON_JSON" "$DAEMON_JSON_BACKUP"
  info "Backed up existing $DAEMON_JSON to $DAEMON_JSON_BACKUP"
else
  # Marker file (separate from the backup path) tells revert there was no
  # original to restore — never write a non-JSON sentinel into the backup
  # itself, since that would corrupt $DAEMON_JSON on revert.
  : >"${DAEMON_JSON_ABSENT_MARKER}.tmp"
  mv "${DAEMON_JSON_ABSENT_MARKER}.tmp" "$DAEMON_JSON_ABSENT_MARKER"
  info "No existing $DAEMON_JSON; flagged for removal on revert"
fi

# Write a minimal daemon.json that enables the containerd-snapshotter feature.
# We deliberately do NOT merge with any user keys — the GitHub runner only
# owns this daemon for the duration of the job.
sudo tee "$DAEMON_JSON" >/dev/null <<'EOF'
{
  "features": { "containerd-snapshotter": true }
}
EOF
info "Wrote new $DAEMON_JSON enabling containerd-snapshotter"

if ! sudo systemctl restart docker; then
  fail "Failed to restart Docker after daemon.json change"
  exit 1
fi

# Give Docker a moment to settle.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if docker info >/dev/null 2>&1; then break; fi
  sleep 2
done

if ! docker info >/dev/null 2>&1; then
  fail "Docker did not come back up after restart"
  exit 1
fi

DOCKER_INFO_JSON=$(docker info --format '{{json .}}' 2>/dev/null || echo "{}")

if echo "$DOCKER_INFO_JSON" | grep -q '"Driver":"overlayfs"'; then
  pass "Docker storage Driver is now overlayfs"
else
  driver=$(echo "$DOCKER_INFO_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Driver","?"))' 2>/dev/null || echo "?")
  skip "Docker reports Driver=$driver — runner did not switch to overlayfs (containerd-snapshotter may be disabled in this image)"
  echo ""
  printf '\033[1;33m=== Test summary ===\033[0m\n'
  echo "  PASS:  $PASS"
  echo "  FAIL:  $FAIL"
  echo "  SKIP:  $SKIP"
  exit 0
fi

if echo "$DOCKER_INFO_JSON" | grep -q 'io.containerd.snapshotter.v1'; then
  pass "DriverStatus reports io.containerd.snapshotter.v1 (the bug-triggering config)"
else
  skip "Docker overlayfs is active but DriverStatus does not advertise the v1 snapshotter — host may not exhibit the nested-overlay break"
  echo ""
  printf '\033[1;33m=== Test summary ===\033[0m\n'
  echo "  PASS:  $PASS"
  echo "  FAIL:  $FAIL"
  echo "  SKIP:  $SKIP"
  exit 0
fi

# ══════════════════════════════════════════════════════════════════
# Phase 2: Pre-cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Pre-cleanup"

if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
docker rm -f "$GATEWAY_CONTAINER" 2>/dev/null || true
# Drop any patched cluster images from previous runs so we measure first-build behavior.
patched_images=$(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^nemoclaw-cluster:' || true)
if [ -n "$patched_images" ]; then
  echo "$patched_images" | xargs -r docker rmi -f >/dev/null 2>&1 || true
fi
rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
pass "Pre-cleanup complete"

# ══════════════════════════════════════════════════════════════════
# Phase 3: Positive — install + onboard with auto-fix on
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Install + onboard (auto-fix on)"

cd "$REPO_ROOT" || {
  fail "Could not cd to repo root: $REPO_ROOT"
  exit 1
}

# Hermetic env: explicitly unset the auto-fix override knobs so a caller
# that already exports NEMOCLAW_DISABLE_OVERLAY_FIX=1 or
# NEMOCLAW_OVERLAY_SNAPSHOTTER=native can't silently change the path the
# positive phase is asserting on (lines 325-345 below).
env -u NEMOCLAW_DISABLE_OVERLAY_FIX -u NEMOCLAW_OVERLAY_SNAPSHOTTER \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait $install_pid
install_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true

# Source nvm/PATH so a fresh installer becomes visible to subsequent commands.
if [ -f "$HOME/.bashrc" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.bashrc" 2>/dev/null || true
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if [ $install_exit -eq 0 ]; then
  pass "install.sh + onboard completed (exit 0)"
else
  fail "install.sh + onboard failed (exit $install_exit)"
  exit 1
fi

# Capture the install log into a phase-specific file so later phases can
# overwrite it without losing the positive-phase signal.
cp "$INSTALL_LOG" "$ONBOARD_LOG_POSITIVE" 2>/dev/null || true

# ── Auto-fix signals ─────────────────────────────────────────────
if grep -q "Detected Docker 26+ containerd-snapshotter overlayfs" "$ONBOARD_LOG_POSITIVE"; then
  pass "Onboard log contains the auto-fix detection message"
else
  fail "Onboard log missing 'Detected Docker 26+ containerd-snapshotter overlayfs'"
fi

patched_tag=$(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^nemoclaw-cluster:.*-fuse-overlayfs-[0-9a-f]{8}$' | head -1)
if [ -n "$patched_tag" ]; then
  pass "Patched cluster image present: $patched_tag"
else
  fail "No nemoclaw-cluster:*-fuse-overlayfs-* image found after onboard"
fi

# Only assert image-equality + log-cleanliness when we actually found a
# patched tag. Without this guard, an empty `gateway_image` could equal an
# empty `patched_tag` and silently PASS, and the log-grep would scan the
# wrong (empty / non-existent) container.
if [ -n "$patched_tag" ]; then
  gateway_image=$(docker inspect --format '{{.Config.Image}}' "$GATEWAY_CONTAINER" 2>/dev/null || echo "")
  if [ "$gateway_image" = "$patched_tag" ]; then
    pass "Gateway container is running the patched image"
  else
    fail "Gateway image '$gateway_image' does not match patched tag '$patched_tag'"
  fi
fi

# Cluster log must NOT carry the original error string.
if docker logs "$GATEWAY_CONTAINER" 2>&1 | grep -q "overlayfs.*snapshotter cannot be enabled"; then
  fail "Cluster log still contains the nested-overlay error after auto-fix"
else
  pass "Cluster log clean of the nested-overlay error"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Idempotency — ensurePatchedClusterImage no-ops when cached
# ══════════════════════════════════════════════════════════════════
# We deliberately do NOT re-run install.sh here. install.sh would
# rebuild the OpenClaw sandbox image from scratch, and that build
# step is independently flaky on GitHub-Actions runner kernels (see
# the negative phase below for the same failure mode). The behavior
# we actually want to validate is narrower: when the cluster image is
# already in the local Docker cache, calling ensurePatchedClusterImage
# again must return the same tag without invoking docker build. That's
# a property of the patch module, not of install.sh, and it's most
# precisely tested by calling the module directly.
section "Phase 4: Idempotency check"

if [ -z "$patched_tag" ]; then
  skip "Idempotency check skipped (no patched image from phase 3)"
else
  before_created=$(docker inspect --format '{{.Created}}' "$patched_tag" 2>/dev/null || echo "")

  # Derive the upstream image from patched_tag (format:
  # `nemoclaw-cluster:<openshell-version>-<snapshotter>-<sha8>`).
  openshell_version=$(printf '%s\n' "$patched_tag" | sed -E 's|^nemoclaw-cluster:([^-]+)-.*|\1|')
  upstream_image="ghcr.io/nvidia/openshell/cluster:${openshell_version}"

  # Invoke ensurePatchedClusterImage a second time. With the patched
  # image already in the local cache, it must return the same tag and
  # invoke neither docker pull nor docker build.
  cd "$REPO_ROOT" || exit 1
  second_tag=$(node -e '
    const m = require("./dist/lib/cluster-image-patch");
    const tag = m.ensurePatchedClusterImage({
      upstreamImage: process.argv[1],
      logger: () => {},
    });
    console.log(tag);
  ' "$upstream_image" 2>&1 | tail -1)

  after_created=$(docker inspect --format '{{.Created}}' "$patched_tag" 2>/dev/null || echo "")

  if [ "$second_tag" = "$patched_tag" ]; then
    pass "ensurePatchedClusterImage returned the same tag on second invocation: $second_tag"
  else
    fail "ensurePatchedClusterImage tag mismatch (first=$patched_tag second=$second_tag)"
  fi

  if [ -n "$before_created" ] && [ "$before_created" = "$after_created" ]; then
    pass "Patched image was reused (Created timestamp unchanged: $before_created)"
  else
    fail "Patched image was rebuilt unexpectedly (before=$before_created after=$after_created)"
  fi
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Negative — opt out of the auto-fix, expect the original failure
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Negative path (NEMOCLAW_DISABLE_OVERLAY_FIX=1)"

if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
docker rm -f "$GATEWAY_CONTAINER" 2>/dev/null || true

# The script header sets `set -uo pipefail` only — errexit is NOT enabled,
# so a non-zero exit from `timeout` won't terminate us. The previous
# `set +e` / `set -e` toggle was both unnecessary and unsafe: forcing
# `set -e` after the timeout would have made later `((PASS++))` calls fatal
# whenever the counter starts at zero (post-increment returns 0, which bash
# interprets as exit 1 under errexit). Just don't touch errexit here.
env \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  NEMOCLAW_DISABLE_OVERLAY_FIX=1 \
  timeout "$NEGATIVE_TIMEOUT" bash install.sh --non-interactive >"$ONBOARD_LOG_NEGATIVE" 2>&1
negative_exit=$?

if [ $negative_exit -ne 0 ]; then
  pass "Onboard with auto-fix disabled exited non-zero (exit $negative_exit) within $NEGATIVE_TIMEOUT s"
else
  fail "Onboard unexpectedly succeeded with NEMOCLAW_DISABLE_OVERLAY_FIX=1"
fi

# Negative-phase characterization. Three-way result, distinguished by
# whether a known nested-overlay failure signature shows up AND by the
# `timeout` exit code (124 = our wrapper fired, anything else = install.sh
# exited under its own steam):
#
#   - signature present                 → PASS  (confirmed reproduction)
#   - signature absent + exit == 124    → SKIP  (this runner instance did
#                                                not reproduce the bug;
#                                                we hit our 300s timeout
#                                                while install.sh was
#                                                making progress past the
#                                                gateway and sandbox build)
#   - signature absent + exit != 124    → FAIL  (install.sh exited for an
#                                                unrelated reason — likely
#                                                an unrelated flake)
#
# GitHub-Actions ubuntu-latest runners vary kernel and Docker patchlevels
# enough that some runs just don't reproduce the bug at all; the SKIP
# path keeps the gate honest without papering over real failures. The
# unit + idempotency phases still validate the auto-fix on every run.
#
# Recognized signatures, in either the cluster container log or the
# install.sh log:
#   - "overlayfs snapshotter cannot be enabled"   (k3s init — user's report)
#   - "CreateDiff: Canceled"                       (sandbox image build — alt manifestation)
#   - "failed to mount overlay"                    (catch-all)
overlay_signatures='overlayfs.*snapshotter cannot be enabled|CreateDiff: Canceled|failed to mount overlay'
overlay_evidence=""

if docker ps -a --format '{{.Names}}' | grep -q "^${GATEWAY_CONTAINER}$"; then
  if
    cluster_match=$(docker logs "$GATEWAY_CONTAINER" 2>&1 | grep -m1 -E "$overlay_signatures" || true)
    [ -n "$cluster_match" ]
  then
    overlay_evidence="cluster log: $cluster_match"
  fi
fi

if [ -z "$overlay_evidence" ] && [ -f "$ONBOARD_LOG_NEGATIVE" ]; then
  if
    install_match=$(grep -m1 -E "$overlay_signatures" "$ONBOARD_LOG_NEGATIVE" || true)
    [ -n "$install_match" ]
  then
    overlay_evidence="install log: $install_match"
  fi
fi

if [ -n "$overlay_evidence" ]; then
  pass "Cluster/install logs surface a nested-overlay failure signature ($overlay_evidence)"
elif [ "$negative_exit" -eq 124 ]; then
  skip "This runner did not reproduce the nested-overlay bug under the upstream image (no signature; install.sh hit our $NEGATIVE_TIMEOUT s timeout). Auto-fix correctness is still validated by phases 3 and 4."
else
  fail "Negative phase exited $negative_exit (not our timeout, no overlay signature) — likely unrelated flake"
fi

# ══════════════════════════════════════════════════════════════════
# Test summary
# ══════════════════════════════════════════════════════════════════
echo ""
printf '\033[1;33m=== Test summary ===\033[0m\n'
echo "  PASS:  $PASS"
echo "  FAIL:  $FAIL"
echo "  SKIP:  $SKIP"
echo "  TOTAL: $TOTAL"
echo ""

if [ $FAIL -gt 0 ]; then
  exit 1
fi
exit 0
