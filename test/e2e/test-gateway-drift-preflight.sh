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

cleanup() {
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

section "Summary"
pass "Gateway drift preflight regression guard completed"
