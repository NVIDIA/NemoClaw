#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly ORIGINAL_OPENCLAW=/usr/local/bin/openclaw.nemoclaw-original
readonly REMEDIATION=/usr/local/lib/nemoclaw/openclaw-plugin-axios-security-revision.mts
readonly REPLACEMENT_ROOT=/usr/local/share/nemoclaw/openclaw-plugin-axios-1.18.0

if [[ "${1:-}" == plugins && "${2:-}" == install && -n "${3:-}" ]]; then
  remediation_working_directory="$(mktemp -d /tmp/nemoclaw-openclaw-plugin-remediation.XXXXXX)"
  trap 'rm -rf "$remediation_working_directory"' EXIT
  expected_package_spec="$(
    node --experimental-strip-types "$REMEDIATION" --classify-install-target "$3"
  )"
  install_target="$(
    node --experimental-strip-types "$REMEDIATION" \
      --materialize-install-target "$3" \
      --working-directory "$remediation_working_directory"
  )"
  install_args=("$@")
  install_args[2]="$install_target"
  "$ORIGINAL_OPENCLAW" "${install_args[@]}"
  patch_args=(
    --home "${HOME:?HOME is required for OpenClaw plugin installation}"
    --replacement-root "$REPLACEMENT_ROOT"
  )
  if [[ -n "$expected_package_spec" ]]; then
    patch_args+=(--expected-package-spec "$expected_package_spec")
  fi
  node --experimental-strip-types "$REMEDIATION" "${patch_args[@]}"
  rm -rf "$remediation_working_directory"
  trap - EXIT
  exit 0
fi

exec "$ORIGINAL_OPENCLAW" "$@"
