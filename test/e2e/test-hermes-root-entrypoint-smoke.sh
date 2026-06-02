#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hermes root-entrypoint smoke test:
#   - builds the real Hermes sandbox image unless NEMOCLAW_HERMES_TEST_IMAGE is set
#   - starts the container as root via /usr/local/bin/nemoclaw-start
#   - verifies Hermes health, privilege separation, PID-file layout, and sticky
#     config protection
#   - repeats startup from a legacy image/state shape with gateway.pid as a
#     runtime symlink

set -euo pipefail

LOG_PATH="${NEMOCLAW_HERMES_ROOT_ENTRYPOINT_LOG:-/tmp/nemoclaw-hermes-root-entrypoint-smoke.log}"
: >"$LOG_PATH"
exec > >(tee -a "$LOG_PATH") 2>&1

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUN_ID="${GITHUB_RUN_ID:-local}-$$"
IMAGE="${NEMOCLAW_HERMES_TEST_IMAGE:-nemoclaw-hermes-root-entrypoint-smoke:${RUN_ID}}"
BASE_IMAGE="nemoclaw-hermes-root-entrypoint-base:${RUN_ID}"
containers=()

dump_container() {
  local container="$1"
  docker inspect "$container" >/dev/null 2>&1 || return 0
  echo -e "${YELLOW}[DIAG]${NC} --- ${container} diagnostics ---" >&2
  docker ps -a --filter "name=^/${container}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' >&2 || true
  docker logs "$container" >&2 || true
  docker exec "$container" sh -lc \
    'set +e; echo "== identity =="; id; echo "== hermes tree =="; ls -ld /sandbox/.hermes /sandbox/.hermes/runtime /sandbox/.hermes/logs /sandbox/.hermes/logs/curator /sandbox/.hermes/hooks /sandbox/.hermes/image_cache /sandbox/.hermes/audio_cache 2>&1; ls -l /sandbox/.hermes/gateway.pid /sandbox/.hermes/runtime/gateway.pid /sandbox/.hermes/config.yaml 2>&1; echo "== processes =="; ps -eo user=,pid=,args= | grep -E "hermes|socat" | grep -v grep; echo "== start log =="; tail -n 120 /tmp/nemoclaw-start.log 2>&1; echo "== gateway log =="; tail -n 160 /tmp/gateway.log 2>&1' \
    >&2 || true
  echo -e "${YELLOW}[DIAG]${NC} --- end ${container} diagnostics ---" >&2
}

fail() {
  echo -e "${RED}[FAIL]${NC} $1" >&2
  for container in "${containers[@]}"; do
    dump_container "$container"
  done
  exit 1
}

cleanup() {
  for container in "${containers[@]}"; do
    docker rm -f "$container" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

require_docker() {
  command -v docker >/dev/null 2>&1 || fail "docker is required"
  docker info >/dev/null 2>&1 || fail "docker daemon is not available"
}

build_image_if_needed() {
  if [ -n "${NEMOCLAW_HERMES_TEST_IMAGE:-}" ]; then
    info "Using prebuilt Hermes image ${IMAGE}"
    docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "prebuilt image not found: ${IMAGE}"
    return 0
  fi

  info "Building Hermes base image ${BASE_IMAGE}"
  docker build -f "${REPO_ROOT}/agents/hermes/Dockerfile.base" -t "$BASE_IMAGE" "$REPO_ROOT" \
    || fail "failed to build Hermes base image"

  info "Building Hermes production image ${IMAGE}"
  docker build -f "${REPO_ROOT}/agents/hermes/Dockerfile" \
    --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
    -t "$IMAGE" \
    "$REPO_ROOT" \
    || fail "failed to build Hermes production image"
}

wait_for_health() {
  local container="$1"
  local body=""
  local running=""

  for _attempt in $(seq 1 90); do
    if body="$(docker exec "$container" sh -lc 'curl -sf --max-time 2 http://127.0.0.1:8642/health' 2>/dev/null)"; then
      echo "$body"
      printf '%s\n' "$body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' \
        || fail "${container}: health response did not report status ok: ${body}"
      printf '%s\n' "$body" | grep -Eq '"platform"[[:space:]]*:[[:space:]]*"hermes-agent"' \
        || fail "${container}: health response did not report Hermes platform: ${body}"
      return 0
    fi

    running="$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)"
    [ "$running" = "true" ] || fail "${container}: container exited before health became ready"
    sleep 2
  done

  fail "${container}: Hermes health did not become ready"
}

assert_container_sh() {
  local container="$1"
  local message="$2"
  local command="$3"
  docker exec "$container" sh -lc "$command" >/dev/null || fail "${container}: ${message}"
}

assert_container_sh_fails() {
  local container="$1"
  local message="$2"
  local command="$3"
  if docker exec "$container" sh -lc "$command" >/dev/null 2>&1; then
    fail "${container}: ${message}"
  fi
}

assert_gateway_log_clean() {
  local container="$1"
  assert_container_sh "$container" "gateway log contains PID race failure" \
    "! grep -F 'PID file race lost' /tmp/gateway.log"
  assert_container_sh "$container" "gateway log contains config load failure" \
    "! grep -F 'Could not load config.yaml' /tmp/gateway.log"
}

assert_runtime_layout() {
  local container="$1"

  assert_container_sh "$container" "Hermes config root mode is not 3770" \
    "[ \"\$(stat -c '%a' /sandbox/.hermes)\" = '3770' ]"
  assert_container_sh "$container" "required Hermes v0.14 directories are missing" \
    "for dir in hooks image_cache audio_cache logs/curator; do test -d \"/sandbox/.hermes/\$dir\"; done"
  assert_container_sh "$container" "gateway user cannot write required Hermes v0.14 directories" \
    "gosu gateway sh -lc 'for dir in hooks image_cache audio_cache logs/curator; do p=\"/sandbox/.hermes/\$dir/.nemoclaw-write-test\"; : >\"\$p\" && rm -f \"\$p\"; done'"
  assert_container_sh "$container" "gateway.pid is not a regular top-level file" \
    "test -f /sandbox/.hermes/gateway.pid && test ! -L /sandbox/.hermes/gateway.pid"
  assert_container_sh_fails "$container" "gateway user was able to remove config.yaml" \
    "gosu gateway rm /sandbox/.hermes/config.yaml"
  assert_container_sh "$container" "config.yaml disappeared after gateway remove attempt" \
    "test -f /sandbox/.hermes/config.yaml"
}

assert_gateway_process() {
  local container="$1"
  assert_container_sh "$container" "Hermes gateway process is not running as gateway user" \
    "ps -eo user=,args= | awk '\$1 == \"gateway\" && index(\$0, \"hermes gateway run\") { found = 1 } END { exit found ? 0 : 1 }'"
  assert_container_sh "$container" "start log does not show gateway privilege separation" \
    "grep -F \"hermes gateway launched as 'gateway' user\" /tmp/nemoclaw-start.log"
}

run_clean_variant() {
  local container="nemoclaw-hermes-root-clean-${RUN_ID}"
  info "Starting clean root-entrypoint container ${container}"
  docker run -d --name "$container" "$IMAGE" /usr/local/bin/nemoclaw-start >/dev/null \
    || fail "failed to start clean root-entrypoint container"
  containers+=("$container")

  wait_for_health "$container" >/dev/null
  assert_gateway_process "$container"
  assert_gateway_log_clean "$container"
  assert_runtime_layout "$container"
  pass "Clean root-entrypoint startup reached Hermes health"
}

run_legacy_variant() {
  local container="nemoclaw-hermes-root-legacy-${RUN_ID}"
  local legacy_bootstrap
  legacy_bootstrap='set -euo pipefail
rm -f /sandbox/.hermes/gateway.pid
printf "stale pid\n" >/sandbox/.hermes/runtime/gateway.pid
printf "stale lock\n" >/sandbox/.hermes/runtime/gateway.lock
ln -s runtime/gateway.pid /sandbox/.hermes/gateway.pid
chmod 750 /sandbox/.hermes
rm -rf /sandbox/.hermes/hooks /sandbox/.hermes/image_cache /sandbox/.hermes/audio_cache /sandbox/.hermes/logs/curator
exec /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-start'

  info "Starting legacy-layout root-entrypoint container ${container}"
  docker run -d --name "$container" --entrypoint /bin/bash "$IMAGE" -lc "$legacy_bootstrap" >/dev/null \
    || fail "failed to start legacy-layout root-entrypoint container"
  containers+=("$container")

  wait_for_health "$container" >/dev/null
  assert_gateway_process "$container"
  assert_gateway_log_clean "$container"
  assert_runtime_layout "$container"
  assert_container_sh "$container" "legacy gateway.pid symlink migration was not logged" \
    "grep -F 'Removing unsafe stale Hermes legacy PID file symlink' /tmp/nemoclaw-start.log"
  pass "Legacy gateway.pid symlink/state migrated and booted"
}

require_docker
build_image_if_needed
run_clean_variant
run_legacy_variant

pass "Hermes root-entrypoint smoke passed"
