#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Artifact collection helpers. Designed to be called from failure traps.
# All helpers are best-effort: missing sources are logged but do not abort.

_E2E_ART_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# e2e_artifact_collect_file <src> <dst>
# Copies a single file. Returns 0 on success or when src is missing.
e2e_artifact_collect_file() {
  local src="${1:-}"
  local dst="${2:-}"
  if [[ -z "${src}" || -z "${dst}" ]]; then
    echo "e2e_artifact_collect_file: missing src or dst" >&2
    return 2
  fi
  if [[ ! -f "${src}" ]]; then
    echo "e2e_artifact_collect_file: ${src} not found, skipping" >&2
    return 0
  fi
  mkdir -p "$(dirname "${dst}")"
  cp -f "${src}" "${dst}"
}

# e2e_artifact_collect_dir <src-dir> <dst-dir>
# Recursively copies a directory. No-op if missing.
e2e_artifact_collect_dir() {
  local src="${1:-}"
  local dst="${2:-}"
  if [[ ! -d "${src}" ]]; then
    echo "e2e_artifact_collect_dir: ${src} not found, skipping" >&2
    return 0
  fi
  mkdir -p "${dst}"
  cp -rf "${src}/." "${dst}/"
}

# e2e_artifact_preserve_exit <original_exit>
# Intended for failure traps. Collects artifacts (caller-defined function
# `_e2e_collect_artifacts` if present) but always returns the provided exit
# code so it can be passed to `exit`.
e2e_artifact_preserve_exit() {
  local rc="${1:-1}"
  if declare -F _e2e_collect_artifacts >/dev/null 2>&1; then
    _e2e_collect_artifacts || true
  fi
  return "${rc}"
}
