#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# Bash is required for process-substitution log mirroring below and for the
# validation-only test path.
LOG_PATH="${NEMOCLAW_HERMES_STALE_OPENCLAW_IMAGE_LOG:-/tmp/nemoclaw-hermes-stale-openclaw-image.log}"
: >"$LOG_PATH"
# The mirrored log is intentionally limited to this verifier's command stream.
# require_safe_image_ref runs before any Docker build and only allows local test
# tags or immutable GHCR digest refs, so credential-bearing image URLs are not
# accepted into the build/log path.
exec > >(tee -a "$LOG_PATH") 2>&1

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
fail() {
  echo -e "${RED}[FAIL]${NC} $1" >&2
  exit 1
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail "docker is required"
  docker info >/dev/null 2>&1 || fail "docker daemon is not available"
}

require_safe_image_ref() {
  local ref="$1"
  if [ -z "$ref" ]; then
    fail "set NEMOCLAW_HERMES_BASE_IMAGE or HERMES_BASE_IMAGE to the resolved Hermes base image"
  fi
  case "$ref" in
    *[[:space:]]* | *[\;\`\"\']* | *\\*)
      fail "Hermes base image ref contains unsafe characters: $ref"
      ;;
  esac
  if [[ "$ref" == nemoclaw-hermes-base-local ]] \
    || [[ "$ref" == nemoclaw-hermes-stale-openclaw-dir-base:* ]] \
    || [[ "$ref" == nemoclaw-hermes-stale-openclaw-link-base:* ]]; then
    return 0
  fi
  if [[ "$ref" =~ ^ghcr\.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:[a-f0-9]{64}$ ]]; then
    return 0
  fi
  if [[ "$ref" == ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:* ]]; then
    fail "Hermes base image ref has an invalid sha256 digest: $ref"
  fi
  if [[ "$ref" == ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:* ]]; then
    fail "Hermes base image ref must be an immutable digest while stale .openclaw cleanup is present: $ref"
  fi
  if [[ "$ref" == ghcr.io/nvidia/nemoclaw/hermes-sandbox-base* ]]; then
    fail "Hermes base image ref is not an allowed Hermes base form: $ref"
  fi
  fail "Hermes base image ref is outside the allowed Hermes base images: $ref"
}

verify_dockerfile_base_digest_contract() {
  local dockerfile="${REPO_ROOT}/agents/hermes/Dockerfile"
  # This is a Dockerfile contract check. Semantic cleanup proof comes from
  # building synthetic stale directory and symlink bases from the resolved digest
  # below; mutable GHCR tag lineage checks are intentionally rejected while this
  # temporary cleanup exists.
  # shellcheck disable=SC2016 # literal Dockerfile ARG reference, not shell expansion
  grep -Fx 'ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${NEMOCLAW_STALE_OPENCLAW_BASE_DIGEST}' "$dockerfile" >/dev/null \
    || fail "Hermes Dockerfile must single-source BASE_IMAGE from NEMOCLAW_STALE_OPENCLAW_BASE_DIGEST"
  grep -Eq '^ARG NEMOCLAW_STALE_OPENCLAW_BASE_DIGEST=sha256:[a-f0-9]{64}$' "$dockerfile" \
    || fail "Hermes Dockerfile must define a pinned stale OpenClaw base digest"
  if grep -Eq '^ARG BASE_IMAGE=ghcr[.]io/nvidia/nemoclaw/hermes-sandbox-base@sha256:' "$dockerfile"; then
    fail "Hermes Dockerfile must not hard-code the stale digest in BASE_IMAGE"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUN_ID="${GITHUB_RUN_ID:-local}-$$"
STALE_DIR_BASE="nemoclaw-hermes-stale-openclaw-dir-base:${RUN_ID}"
STALE_DIR_IMAGE="nemoclaw-hermes-stale-openclaw-dir:${RUN_ID}"
STALE_LINK_BASE="nemoclaw-hermes-stale-openclaw-link-base:${RUN_ID}"
STALE_LINK_IMAGE="nemoclaw-hermes-stale-openclaw-link:${RUN_ID}"
SYMLINK_BUILD_LOG=""
CLEANUP_DOCKER_IMAGES=0

cleanup() {
  if [ -n "$SYMLINK_BUILD_LOG" ]; then
    rm -f "$SYMLINK_BUILD_LOG"
  fi
  if [ "$CLEANUP_DOCKER_IMAGES" = "1" ]; then
    docker rmi -f "$STALE_DIR_IMAGE" "$STALE_DIR_BASE" "$STALE_LINK_BASE" "$STALE_LINK_IMAGE" \
      >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

build_stale_dir_base() {
  info "Building stale Hermes base with /sandbox/.openclaw directory from ${BASE_IMAGE}"
  docker build -f - --build-arg "BASE_IMAGE=${BASE_IMAGE}" -t "$STALE_DIR_BASE" "$REPO_ROOT" <<'DOCKERFILE' || fail "failed to build stale-directory Hermes base"
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN rm -rf /sandbox/.openclaw \
    && mkdir -p /sandbox/.openclaw \
    && printf '{}\n' > /sandbox/.openclaw/openclaw.json
DOCKERFILE
}

build_stale_link_base() {
  info "Building stale Hermes base with symlinked /sandbox/.openclaw from ${BASE_IMAGE}"
  docker build -f - --build-arg "BASE_IMAGE=${BASE_IMAGE}" -t "$STALE_LINK_BASE" "$REPO_ROOT" <<'DOCKERFILE' || fail "failed to build stale-symlink Hermes base"
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN rm -rf /sandbox/.openclaw \
    && mkdir -p /tmp/stale-openclaw-target \
    && printf 'keep\n' > /tmp/stale-openclaw-target/sentinel \
    && ln -s /tmp/stale-openclaw-target /sandbox/.openclaw
DOCKERFILE
}

verify_stale_dir_final_image() {
  info "Building Hermes final image from stale-directory base"
  docker build -f "${REPO_ROOT}/agents/hermes/Dockerfile" \
    --build-arg "BASE_IMAGE=${STALE_DIR_BASE}" \
    -t "$STALE_DIR_IMAGE" \
    "$REPO_ROOT" \
    || fail "Hermes final image did not build from stale-directory base"

  docker run --rm --entrypoint sh "$STALE_DIR_IMAGE" -lc '
    set -eu
    test ! -e /sandbox/.openclaw
    test "$(stat -c "%a" /sandbox/.hermes/runtime)" = "2770"
    test "$(readlink /sandbox/.hermes/gateway_state.json)" = "runtime/gateway_state.json"
  ' || fail "stale-directory Hermes final image layout assertions failed"
  pass "Hermes final image removes stale /sandbox/.openclaw directory"
}

verify_stale_link_final_image_fails() {
  info "Building Hermes final image from stale-symlink base; this must fail closed"
  set +e
  docker build -f "${REPO_ROOT}/agents/hermes/Dockerfile" \
    --build-arg "BASE_IMAGE=${STALE_LINK_BASE}" \
    -t "$STALE_LINK_IMAGE" \
    "$REPO_ROOT" \
    >"$SYMLINK_BUILD_LOG" 2>&1
  local status="$?"
  set -e

  if [ "$status" -eq 0 ]; then
    cat "$SYMLINK_BUILD_LOG" >&2
    fail "Hermes final image unexpectedly built from stale-symlink base"
  fi
  grep -F ".openclaw is a symlink" "$SYMLINK_BUILD_LOG" >/dev/null \
    || {
      cat "$SYMLINK_BUILD_LOG" >&2
      fail "symlink failure did not mention .openclaw"
    }
  docker run --rm --entrypoint sh "$STALE_LINK_BASE" -lc \
    'test "$(cat /tmp/stale-openclaw-target/sentinel)" = "keep"' \
    || fail "stale-symlink base sentinel was not preserved"
  pass "Hermes final image refuses symlinked stale /sandbox/.openclaw"
}

main() {
  if [ "${1:-}" = "--validate-ref-only" ]; then
    require_safe_image_ref "${2:-}"
    pass "Hermes base image ref is allowed"
    return 0
  fi

  BASE_IMAGE="${NEMOCLAW_HERMES_BASE_IMAGE:-${HERMES_BASE_IMAGE:-}}"
  require_safe_image_ref "$BASE_IMAGE"
  verify_dockerfile_base_digest_contract
  require_docker
  SYMLINK_BUILD_LOG="$(mktemp -t nemoclaw-hermes-stale-openclaw-build.XXXXXX.log)"
  CLEANUP_DOCKER_IMAGES=1
  # Keep the two build/proof paths sequential so Docker logs remain attributable
  # and the self-hosted daemon is not competing for image layers.
  build_stale_dir_base
  verify_stale_dir_final_image
  build_stale_link_base
  verify_stale_link_final_image_fails
}

main "$@"
