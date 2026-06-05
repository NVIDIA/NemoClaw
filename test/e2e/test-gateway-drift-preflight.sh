#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -uo pipefail

section() { printf '\n=== %s ===\n' "$1"; }
pass() { echo "PASS: $1"; }
info() { echo "INFO: $1"; }
fail() {
  echo "FAIL: $1" >&2
  if [ -n "${CASE_DIR:-}" ] && [ -d "$CASE_DIR" ]; then
    echo "--- fake openshell calls ---" >&2
    cat "$CASE_DIR/openshell-calls.log" 2>/dev/null >&2 || true
    echo "--- fake docker calls ---" >&2
    cat "$CASE_DIR/docker-calls.log" 2>/dev/null >&2 || true
    echo "--- command output ---" >&2
    cat "$CASE_DIR/command.out" 2>/dev/null >&2 || true
  fi
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORK_ROOT="$(mktemp -d -t nemoclaw-gateway-drift-preflight.XXXXXX)"
export NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT=0
LIVE_GATEWAY_PID=""

cleanup() {
  if [ -n "$LIVE_GATEWAY_PID" ]; then
    kill "$LIVE_GATEWAY_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_ROOT"
}
trap cleanup EXIT

load_shell_path() {
  if [ -f "$HOME/.bashrc" ]; then
    # shellcheck source=/dev/null
    source "$HOME/.bashrc" 2>/dev/null || true
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
  fi
}

write_registry() {
  local home="$1"
  mkdir -p "$home/.nemoclaw"
  cat >"$home/.nemoclaw/sandboxes.json" <<'JSON'
{
  "sandboxes": {
    "alpha": {
      "name": "alpha",
      "model": "test-model",
      "provider": "nvidia-prod",
      "gpuEnabled": false,
      "policies": [],
      "agent": "openclaw",
      "agentVersion": "test-version"
    }
  },
  "defaultSandbox": "alpha"
}
JSON
  chmod 600 "$home/.nemoclaw/sandboxes.json"
}

write_fake_openshell() {
  local bin_dir="$1"
  cat >"$bin_dir/openshell" <<'SH'
#!/usr/bin/env bash
set -uo pipefail
: "${NEMOCLAW_FAKE_CASE_DIR:?}"
printf '%s\n' "$*" >> "$NEMOCLAW_FAKE_CASE_DIR/openshell-calls.log"
case "${1:-}" in
  --version|-V)
    printf 'openshell 0.0.37\n'
    exit 0
    ;;
  status)
    printf 'Server Status\n\n  Gateway: nemoclaw\n  Gateway endpoint: http://127.0.0.1:8080\n  Status: Connected\n'
    exit 0
    ;;
  gateway)
    if [ "${2:-}" = "info" ]; then
      printf 'Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: http://127.0.0.1:8080\n'
      exit 0
    fi
    ;;
  sandbox)
    if [ "${2:-}" = "list" ]; then
      printf '%s\n' 'Error: status: Internal, message: "failed to decode Protobuf message: Sandbox.metadata: SandboxResponse.sandbox: invalid wire type value: 6"' >&2
      exit "${NEMOCLAW_FAKE_SANDBOX_LIST_EXIT:-1}"
    fi
    ;;
esac
printf 'unexpected openshell args: %s\n' "$*" >&2
exit 9
SH
  chmod +x "$bin_dir/openshell"
}

write_fake_docker() {
  local bin_dir="$1"
  local gateway_running="${NEMOCLAW_FAKE_GATEWAY_RUNNING:-true}"
  local gateway_ports="${NEMOCLAW_FAKE_GATEWAY_PORTS:-}"
  if [ -z "$gateway_ports" ]; then
    gateway_ports='{"30051/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"}]}'
  fi
  local gateway_image="${NEMOCLAW_FAKE_GATEWAY_IMAGE:-ghcr.io/nvidia/openshell/cluster:0.0.37}"
  cat >"$bin_dir/docker" <<SH
#!/usr/bin/env bash
set -uo pipefail
case_dir="\${NEMOCLAW_FAKE_CASE_DIR:-\${TMPDIR:-/tmp}/nemoclaw-gateway-drift-preflight-current}"
printf '%s\n' "\$*" >> "\$case_dir/docker-calls.log"
format=""
if [ "\${1:-}" = "inspect" ] || { [ "\${1:-}" = "container" ] && [ "\${2:-}" = "inspect" ]; }; then
  while [ "\$#" -gt 0 ]; do
    if [ "\${1:-}" = "--format" ]; then
      shift
      format="\${1:-}"
      break
    fi
    shift
  done
  case "\$format" in
    '{{.State.Running}}'|"'{{.State.Running}}'")
      printf '%s\n' '$gateway_running'
      exit 0
      ;;
    '{{json .NetworkSettings.Ports}}'|"'{{json .NetworkSettings.Ports}}'")
      printf '%s\n' '$gateway_ports'
      exit 0
      ;;
    '{{.Config.Image}}'|"'{{.Config.Image}}'")
      printf '%s\n' '$gateway_image'
      exit 0
      ;;
  esac
fi
printf 'unexpected docker args: %s\n' "\$*" >&2
exit 9
SH
  chmod +x "$bin_dir/docker"
}

run_backup_case() {
  local name="$1"
  shift
  CASE_DIR="$WORK_ROOT/$name"
  local home="$CASE_DIR/home"
  local bin_dir="$CASE_DIR/bin"
  mkdir -p "$home" "$bin_dir"
  export TMPDIR="$CASE_DIR"
  : >"$CASE_DIR/openshell-calls.log"
  : >"$CASE_DIR/docker-calls.log"
  write_registry "$home"
  write_fake_openshell "$bin_dir"
  write_fake_docker "$bin_dir"

  local output="$CASE_DIR/command.out"
  HOME="$home" \
    PATH="$bin_dir:$PATH" \
    NEMOCLAW_FAKE_CASE_DIR="$CASE_DIR" \
    TMPDIR="$CASE_DIR" \
    NEMOCLAW_FAKE_GATEWAY_RUNNING="${NEMOCLAW_FAKE_GATEWAY_RUNNING:-}" \
    NEMOCLAW_FAKE_GATEWAY_PORTS="${NEMOCLAW_FAKE_GATEWAY_PORTS:-}" \
    NEMOCLAW_FAKE_GATEWAY_IMAGE="${NEMOCLAW_FAKE_GATEWAY_IMAGE:-}" \
    NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT="${NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT:-0}" \
    "$@" >"$output" 2>&1
  return $?
}

# Host-process / Docker-driver gateway: there is no openshell-cluster-* container,
# so docker inspect always fails. The gateway version comes from probing the
# gateway binary recorded in the runtime marker.
write_fake_docker_no_cluster() {
  local bin_dir="$1"
  cat >"$bin_dir/docker" <<'SH'
#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "$NEMOCLAW_FAKE_CASE_DIR/docker-calls.log"
if [ "${1:-}" = "inspect" ] || { [ "${1:-}" = "container" ] && [ "${2:-}" = "inspect" ]; }; then
  printf 'Error: No such object\n' >&2
  exit 1
fi
exit 0
SH
  chmod +x "$bin_dir/docker"
}

write_fake_gateway_binary() {
  local bin_dir="$1"
  local version="${2:-0.0.43}"
  # --version prints the (drifted) version; any other invocation sleeps so the
  # script can run it as a long-lived process whose PID seeds a live marker.
  cat >"$bin_dir/openshell-gateway" <<SH
#!/usr/bin/env bash
case "\${1:-}" in --version|-V) printf 'openshell-gateway %s\n' '$version'; exit 0 ;; esac
# Stay alive as a long-lived process whose argv0 is this binary path, so the
# drift detector's argv0-based liveness/identity check recognizes it the same
# way it recognizes a real openshell-gateway process.
exec -a "\$0" sleep 600
SH
  chmod +x "$bin_dir/openshell-gateway"
}

write_host_process_marker() {
  local home="$1"
  local gateway_bin="$2"
  local pid="${3:-999999}"
  local state_dir="$home/.local/state/nemoclaw/openshell-docker-gateway"
  mkdir -p "$state_dir"
  cat >"$state_dir/runtime.json" <<JSON
{
  "version": 1,
  "pid": $pid,
  "driver": "docker",
  "platform": "linux",
  "arch": "$(node -e 'process.stdout.write(process.arch)')",
  "endpoint": "http://127.0.0.1:8080",
  "desiredEnvHash": "deadbeef",
  "gatewayBin": "$gateway_bin",
  "openshellVersion": "0.0.44",
  "dockerHost": "unix:///run/docker.sock",
  "createdAt": "2026-05-25T10:27:03.702Z"
}
JSON
  chmod 600 "$state_dir/runtime.json"
}

run_host_process_case() {
  local name="$1"
  shift
  CASE_DIR="$WORK_ROOT/$name"
  local home="$CASE_DIR/home"
  local bin_dir="$CASE_DIR/bin"
  mkdir -p "$home" "$bin_dir"
  export TMPDIR="$CASE_DIR"
  : >"$CASE_DIR/openshell-calls.log"
  : >"$CASE_DIR/docker-calls.log"
  write_registry "$home"
  write_fake_openshell "$bin_dir"
  write_fake_docker_no_cluster "$bin_dir"
  write_fake_gateway_binary "$bin_dir" "${NEMOCLAW_FAKE_GATEWAY_BIN_VERSION:-0.0.43}"
  if [ "${NEMOCLAW_E2E_SKIP_MARKER:-0}" = "1" ]; then
    # No marker: exercise the marker-less fallback resolver (sibling of the
    # resolved openshell binary on PATH).
    :
  elif [ "${NEMOCLAW_E2E_LIVE_MARKER:-0}" = "1" ]; then
    # Live marker: start the gateway as a long-lived process and seed the marker
    # with its PID, so the detector trusts marker.gatewayBin via the liveness
    # check rather than the fallback resolver.
    "$bin_dir/openshell-gateway" serve &
    LIVE_GATEWAY_PID=$!
    write_host_process_marker "$home" "$bin_dir/openshell-gateway" "$LIVE_GATEWAY_PID"
  else
    # Stale marker (dead PID): the detector must ignore marker.gatewayBin and
    # fall back to live resolution.
    write_host_process_marker "$home" "$bin_dir/openshell-gateway"
  fi

  local output="$CASE_DIR/command.out"
  HOME="$home" \
    PATH="$bin_dir:$PATH" \
    NEMOCLAW_FAKE_CASE_DIR="$CASE_DIR" \
    TMPDIR="$CASE_DIR" \
    NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT="${NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT:-0}" \
    "$@" >"$output" 2>&1
  return $?
}

assert_contains() {
  local file="$1" pattern="$2" description="$3"
  if grep -qiE "$pattern" "$file"; then
    pass "$description"
  else
    fail "$description (missing pattern: $pattern)"
  fi
}

assert_not_contains() {
  local file="$1" pattern="$2" description="$3"
  if grep -qiE "$pattern" "$file"; then
    fail "$description (unexpected pattern: $pattern)"
  else
    pass "$description"
  fi
}

section "Prepare CLI build"
cd "$REPO_ROOT"
load_shell_path
if [ ! -d node_modules ]; then
  npm ci --ignore-scripts || fail "npm ci failed"
fi
npm run build:cli || fail "CLI build failed"

section "Protobuf mismatch from sandbox list fails closed"
set +e
NEMOCLAW_FAKE_GATEWAY_RUNNING=false \
  NEMOCLAW_FAKE_GATEWAY_IMAGE=ghcr.io/nvidia/openshell/cluster:0.0.37 \
  run_backup_case protobuf-mismatch \
  node "$REPO_ROOT/bin/nemoclaw.js" backup-all
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  pass "backup-all exits non-zero on protobuf mismatch"
else
  info "backup-all exited 0; checking that it did not silently treat the RPC failure as stopped"
fi
assert_contains "$CASE_DIR/command.out" 'protobuf|schema mismatch|invalid wire type|Skipping '\''?alpha'\''? \(not running\)' "protobuf failure is not silently swallowed"
assert_contains "$CASE_DIR/command.out" 'No sandbox data was changed|Refusing to trust OpenShell sandbox state' "fail-closed no-mutation guidance is printed"
assert_not_contains "$CASE_DIR/command.out" "Skipping '?alpha'? \\(not running\\)" "running sandbox is not misclassified as stopped"
assert_not_contains "$CASE_DIR/command.out" 'Backup complete' "backup does not proceed after unsafe state RPC"

section "Patched stale gateway image fails before sandbox list"
set +e
NEMOCLAW_FAKE_GATEWAY_IMAGE=nemoclaw-cluster:0.0.36-fuse-overlayfs-aa8b8487 \
  run_backup_case patched-image-drift \
  node "$REPO_ROOT/bin/nemoclaw.js" backup-all
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "backup-all unexpectedly succeeded with stale patched gateway image"
pass "backup-all exits non-zero on stale patched gateway image"
assert_contains "$CASE_DIR/command.out" 'schema preflight failed|gateway schema preflight failed|image.*does not match|Running gateway image' "gateway image drift preflight is surfaced"
assert_contains "$CASE_DIR/command.out" '0\.0\.37' "installed OpenShell version is reported"
assert_contains "$CASE_DIR/command.out" 'nemoclaw-cluster:0\.0\.36-fuse-overlayfs-aa8b8487|0\.0\.36' "patched stale gateway image/version is reported"
if grep -qx 'sandbox list' "$CASE_DIR/openshell-calls.log"; then
  fail "sandbox list was called despite preflight image drift"
fi
pass "preflight image drift blocks sandbox list"

section "Host-process gateway binary drift fails before sandbox list (backup-all, live marker)"
set +e
NEMOCLAW_E2E_LIVE_MARKER=1 \
  run_host_process_case host-process-backup \
  node "$REPO_ROOT/bin/nemoclaw.js" backup-all
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "backup-all unexpectedly succeeded with host-process gateway binary drift"
pass "backup-all exits non-zero on host-process gateway binary drift"
assert_contains "$CASE_DIR/command.out" 'schema preflight failed|gateway schema preflight failed|Running gateway binary' "host-process gateway drift preflight is surfaced"
assert_contains "$CASE_DIR/command.out" '0\.0\.37' "installed OpenShell version is reported"
assert_contains "$CASE_DIR/command.out" 'Running gateway binary.*0\.0\.43' "running host-process gateway binary/version is reported"
assert_contains "$CASE_DIR/command.out" 'No sandbox data was changed|Refusing to trust OpenShell sandbox state' "fail-closed no-mutation guidance is printed"
assert_not_contains "$CASE_DIR/command.out" 'Running gateway image' "host-process drift does not claim a cluster image"
if grep -qx 'sandbox list' "$CASE_DIR/openshell-calls.log"; then
  fail "sandbox list was called despite host-process preflight drift"
fi
pass "preflight host-process drift blocks sandbox list"

section "Host-process gateway binary drift fails before sandbox list (upgrade-sandboxes)"
set +e
run_host_process_case host-process-upgrade \
  node "$REPO_ROOT/bin/nemoclaw.js" upgrade-sandboxes --check
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "upgrade-sandboxes unexpectedly succeeded with host-process gateway binary drift"
pass "upgrade-sandboxes exits non-zero on host-process gateway binary drift"
assert_contains "$CASE_DIR/command.out" 'schema preflight failed|gateway schema preflight failed|Running gateway binary' "host-process gateway drift preflight is surfaced for upgrade-sandboxes"
assert_contains "$CASE_DIR/command.out" 'Running gateway binary.*0\.0\.43' "running host-process gateway binary/version is reported for upgrade-sandboxes"
if grep -qx 'sandbox list' "$CASE_DIR/openshell-calls.log"; then
  fail "sandbox list was called despite host-process preflight drift (upgrade-sandboxes)"
fi
pass "preflight host-process drift blocks sandbox list for upgrade-sandboxes"

section "Host-process gateway binary drift detected via fallback resolver (no runtime marker)"
set +e
NEMOCLAW_E2E_SKIP_MARKER=1 \
  run_host_process_case host-process-no-marker \
  node "$REPO_ROOT/bin/nemoclaw.js" backup-all
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "backup-all unexpectedly succeeded with host-process drift and no runtime marker"
pass "backup-all exits non-zero on host-process gateway binary drift without a runtime marker"
assert_contains "$CASE_DIR/command.out" 'schema preflight failed|gateway schema preflight failed|Running gateway binary' "host-process gateway drift preflight is surfaced without a marker"
assert_contains "$CASE_DIR/command.out" 'Running gateway binary.*0\.0\.43' "fallback-resolved gateway binary/version is reported"
if grep -qx 'sandbox list' "$CASE_DIR/openshell-calls.log"; then
  fail "sandbox list was called despite host-process preflight drift (no marker)"
fi
pass "preflight host-process drift (fallback resolver) blocks sandbox list"

section "Stale runtime marker does not false-positive when the live gateway matches the CLI"
# A dead-PID marker points at a separate old binary, but the gateway that
# recovery would actually launch (sibling of openshell on PATH) matches the
# installed CLI. The preflight must NOT flag host-process drift; it should pass
# and let the (reactive) sandbox-list path run.
CASE_DIR="$WORK_ROOT/host-process-stale-marker"
stale_home="$CASE_DIR/home"
stale_bin="$CASE_DIR/bin"
stale_old="$CASE_DIR/old-install"
mkdir -p "$stale_home" "$stale_bin" "$stale_old"
: >"$CASE_DIR/openshell-calls.log"
: >"$CASE_DIR/docker-calls.log"
write_registry "$stale_home"
write_fake_openshell "$stale_bin"
write_fake_docker_no_cluster "$stale_bin"
# Sibling gateway on PATH matches the fake CLI version (0.0.37): no real drift.
write_fake_gateway_binary "$stale_bin" "0.0.37"
# Separate stale binary (0.0.43) referenced by a dead-PID marker.
write_fake_gateway_binary "$stale_old" "0.0.43"
write_host_process_marker "$stale_home" "$stale_old/openshell-gateway" 999999
set +e
HOME="$stale_home" \
  PATH="$stale_bin:$PATH" \
  NEMOCLAW_FAKE_CASE_DIR="$CASE_DIR" \
  TMPDIR="$CASE_DIR" \
  NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT=0 \
  node "$REPO_ROOT/bin/nemoclaw.js" backup-all >"$CASE_DIR/command.out" 2>&1
set -e
assert_not_contains "$CASE_DIR/command.out" 'Running gateway binary.*0\.0\.43' "stale marker binary is not used to fabricate drift"
if grep -qx 'sandbox list' "$CASE_DIR/openshell-calls.log"; then
  pass "preflight passes (no false positive) and proceeds to sandbox list"
else
  fail "preflight blocked sandbox list on a stale marker even though the live gateway matches the CLI"
fi

section "Summary"
pass "Gateway drift preflight regression guard completed"
