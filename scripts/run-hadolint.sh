#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Run hadolint on Dockerfiles when the binary is available. Local clones may
# not install hadolint; CI always does (see .github/actions/basic-checks/action.yaml).
# Without hadolint locally, skip with a notice so `git push` pre-push hooks can succeed.
#
# Usage (prek / pre-commit):
#   scripts/run-hadolint.sh <Dockerfile> [...]

set -euo pipefail

if [[ $# -eq 0 ]]; then
  exit 0
fi

if [[ -n "${SKIP_HADOLINT:-}" ]]; then
  exit 0
fi

if ! command -v hadolint >/dev/null 2>&1; then
  # GitHub Actions installs hadolint in .github/actions/basic-checks; fail if missing there.
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "hadolint: required in GitHub Actions but not found on PATH" >&2
    exit 1
  fi
  echo "hadolint: not installed; skipping Dockerfile lint (install: see CONTRIBUTING.md)" >&2
  exit 0
fi

exec hadolint "$@"
