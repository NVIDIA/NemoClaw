#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly ORIGINAL_OPENCLAW=/usr/local/bin/openclaw.nemoclaw-original
readonly AXIOS_REMEDIATION=/usr/local/lib/nemoclaw/openclaw-plugin-axios-security-revision.mts
readonly AXIOS_REPLACEMENT_ROOT=/usr/local/share/nemoclaw/openclaw-plugin-axios-1.18.0
readonly CORE_REMEDIATION=/usr/local/lib/nemoclaw/openclaw-plugin-core-security-revision.mts
readonly CORE_REPLACEMENT_ROOT=/usr/local/share/nemoclaw/openclaw-plugin-core-security-replacements-v1

install_invocation_output="$(
  node --experimental-strip-types "$AXIOS_REMEDIATION" \
    --resolve-install-invocation \
    --home "${HOME:?HOME is required for OpenClaw plugin installation}" \
    -- "$@"
)"
install_invocation=()
if [[ -n "$install_invocation_output" ]]; then
  mapfile -t install_invocation <<<"$install_invocation_output"
fi

if ((${#install_invocation[@]} > 0)); then
  target_index="${install_invocation[0]}"
  state_directory="${install_invocation[1]:?OpenClaw state directory resolution failed}"
  install_args=("$@")
  install_target="${install_args[$target_index]:?OpenClaw plugin install target is required}"
  remediation_working_directory="$(mktemp -d /tmp/nemoclaw-openclaw-plugin-remediation.XXXXXX)"
  trap 'rm -rf "$remediation_working_directory"' EXIT
  rollback_manifest="$(
    node --experimental-strip-types "$AXIOS_REMEDIATION" \
      --prepare-install-rollback \
      --state-directory "$state_directory" \
      --working-directory "$remediation_working_directory"
  )"
  expected_package_spec="$(
    node --experimental-strip-types "$CORE_REMEDIATION" --classify-install-target "$install_target"
  )"
  install_target="$(
    node --experimental-strip-types "$CORE_REMEDIATION" \
      --materialize-install-target "$install_target" \
      --working-directory "$remediation_working_directory"
  )"
  install_args[target_index]="$install_target"
  "$ORIGINAL_OPENCLAW" "${install_args[@]}"
  axios_patch_args=(
    --state-directory "$state_directory"
    --replacement-root "$AXIOS_REPLACEMENT_ROOT"
  )
  core_patch_args=(
    --state-directory "$state_directory"
    --replacement-root "$CORE_REPLACEMENT_ROOT"
  )
  if [[ -n "$expected_package_spec" ]]; then
    core_patch_args+=(--expected-package-spec "$expected_package_spec")
  fi
  set +e
  node --experimental-strip-types "$AXIOS_REMEDIATION" "${axios_patch_args[@]}" \
    && node --experimental-strip-types "$CORE_REMEDIATION" "${core_patch_args[@]}"
  remediation_status=$?
  set -e
  if ((remediation_status != 0)); then
    if ! node --experimental-strip-types "$AXIOS_REMEDIATION" \
      --rollback-install \
      --state-directory "$state_directory" \
      --manifest "$rollback_manifest"; then
      echo "ERROR: OpenClaw plugin remediation and rollback both failed" >&2
    fi
    exit "$remediation_status"
  fi
  rm -rf "$remediation_working_directory"
  trap - EXIT
  exit 0
fi

exec "$ORIGINAL_OPENCLAW" "$@"
