#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly NEMOCUA_RUNTIME_VERSION="0.0.20-dev-v3"
readonly NEMOCUA_APP_ROOT="/app"
readonly NEMOCUA_RUNS_DIR="/sandbox/.nemocua/runs"
readonly NEMOCUA_ARTIFACTS="/usr/local/share/nemoclaw/nemocua-runtime-artifacts.json"
NEMOCUA_PYTHON="$(command -v python3 2>/dev/null || true)"
readonly NEMOCUA_PYTHON

require_runtime() {
  case "$NEMOCUA_PYTHON" in
    /usr/bin/python3 | /usr/local/bin/python3) ;;
    *) return 1 ;;
  esac
  test -f "${NEMOCUA_APP_ROOT}/run.py"
  test -f "${NEMOCUA_APP_ROOT}/run_with_harness.py"
  test -s "$NEMOCUA_ARTIFACTS"
}

probe_inference() {
  if ! command -v curl >/dev/null 2>&1; then
    printf '%s\n' "NemoCUA managed inference smoke requires curl." >&2
    return 1
  fi
  curl --fail --silent --show-error --max-time 10 \
    https://inference.local/v1/models >/dev/null
}

case "${1:-}" in
  version | --version)
    require_runtime
    printf '%s\n' "$NEMOCUA_RUNTIME_VERSION"
    ;;
  smoke)
    require_runtime
    if [[ "${2:-}" != "--image-build" ]]; then
      probe_inference
    fi
    printf '%s\n' "NEMOCUA_RUNTIME_SMOKE_OK"
    ;;
  interactive)
    shift
    require_runtime
    exec "$NEMOCUA_PYTHON" "${NEMOCUA_APP_ROOT}/run.py" "$@"
    ;;
  headless)
    shift
    require_runtime
    if (($# == 0)); then
      printf '%s\n' "NemoCUA headless execution requires task text." >&2
      exit 2
    fi
    mkdir -p "$NEMOCUA_RUNS_DIR"
    task_id="nemoclaw-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    exec "$NEMOCUA_PYTHON" "${NEMOCUA_APP_ROOT}/run_with_harness.py" \
      --runs-dir "$NEMOCUA_RUNS_DIR" start --task-id "$task_id" --query "$*"
    ;;
  *)
    printf '%s\n' "Usage: nemocua-runtime {interactive|headless|version|smoke}" >&2
    exit 2
    ;;
esac
