#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly ORIGINAL_OPENCLAW=/usr/local/bin/openclaw.nemoclaw-original
readonly INVOCATION_PARSER=/usr/local/lib/nemoclaw/openclaw-security-revision-invocation.mts
readonly AXIOS_REMEDIATION=/usr/local/lib/nemoclaw/openclaw-plugin-axios-security-revision.mts
readonly NPM_REMEDIATION=/usr/local/lib/nemoclaw/npm-tar-security-revision.mts
readonly REPLACEMENT_ROOT=/usr/local/share/nemoclaw/openclaw-plugin-axios-1.18.0
readonly NEMOCLAW_ROOT=/opt/nemoclaw

invocation_file="$(mktemp /tmp/nemoclaw-openclaw-security-invocation.XXXXXX)"
node --experimental-strip-types "$INVOCATION_PARSER" \
  --describe-plugin-install -- "$@" >"$invocation_file" || {
  parser_status=$?
  rm -f -- "$invocation_file"
  exit "$parser_status"
}

exec 3<"$invocation_file"
target_index=""
state_directory=""
install_target=""
if ! IFS= read -r -d '' target_index <&3 \
  || ! IFS= read -r -d '' state_directory <&3 \
  || ! IFS= read -r -d '' install_target <&3; then
  exec 3<&-
  rm -f -- "$invocation_file"
  exec "$ORIGINAL_OPENCLAW" "$@"
fi
exec 3<&-
rm -f -- "$invocation_file"

case "$target_index" in
  '' | *[!0-9]*)
    echo "ERROR: OpenClaw install target index is invalid" >&2
    exit 64
    ;;
esac
if [[ "$state_directory" != /* || "$state_directory" == / ]]; then
  echo "ERROR: OpenClaw state directory must be a non-root absolute path" >&2
  exit 64
fi

resolved_target="$(
  node -e \
    'const path = require("node:path"); process.stdout.write(path.resolve(process.argv[1]));' \
    "$install_target"
)"
expected_package_spec=""
historical_nemoclaw=0
if [[ "$resolved_target" == "$NEMOCLAW_ROOT" ]]; then
  historical_nemoclaw=1
else
  expected_package_spec="$(
    node --experimental-strip-types "$AXIOS_REMEDIATION" \
      --classify-install-target "$install_target"
  )"
  if [[ -z "$expected_package_spec" ]]; then
    exec "$ORIGINAL_OPENCLAW" "$@"
  fi
fi

remediation_working_directory="$(mktemp -d /tmp/nemoclaw-openclaw-plugin-remediation.XXXXXX)"
rollback_root=""
prior_state=absent
rollback_required=0
rollback_failed=0

# Reached through the trap-invoked cleanup function below.
# shellcheck disable=SC2329
rollback_openclaw_state() {
  local current_state=""
  if [[ -e "$state_directory" || -L "$state_directory" ]]; then
    if [[ -z "$rollback_root" ]]; then
      rollback_root="$(mktemp -d "$(dirname -- "$state_directory")/.nemoclaw-openclaw-state-rollback.XXXXXX")" || return 1
    fi
    current_state="$rollback_root/current-state"
    mv -- "$state_directory" "$current_state" || return 1
  fi
  if [[ "$prior_state" == present ]]; then
    if ! mv -- "$rollback_root/prior-state" "$state_directory"; then
      if [[ -n "$current_state" ]]; then
        mv -- "$current_state" "$state_directory" || true
      fi
      return 1
    fi
  fi
}

# Invoked indirectly by the EXIT trap below.
# shellcheck disable=SC2329
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$rollback_required" == 1 ]]; then
    if ! rollback_openclaw_state; then
      echo "ERROR: failed to restore the prior OpenClaw state after plugin installation" >&2
      rollback_failed=1
      status=70
    fi
  fi
  if [[ -n "$rollback_root" ]]; then
    if [[ "$rollback_failed" == 1 ]]; then
      echo "ERROR: retained the OpenClaw state rollback snapshot at $rollback_root" >&2
    elif ! rm -rf -- "$rollback_root"; then
      echo "ERROR: failed to remove the OpenClaw state rollback snapshot" >&2
      status=70
    fi
  fi
  if ! rm -rf -- "$remediation_working_directory"; then
    echo "ERROR: failed to remove the OpenClaw remediation working directory" >&2
    status=70
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ -e "$state_directory" || -L "$state_directory" ]]; then
  if [[ ! -d "$state_directory" || -L "$state_directory" ]]; then
    echo "ERROR: OpenClaw state directory must be a real directory: $state_directory" >&2
    exit 64
  fi
  rollback_root="$(mktemp -d "$(dirname -- "$state_directory")/.nemoclaw-openclaw-state-rollback.XXXXXX")"
  cp -a -- "$state_directory" "$rollback_root/prior-state"
  prior_state=present
fi
rollback_required=1

install_args=("$@")
if [[ "$historical_nemoclaw" == 0 ]]; then
  materialized_target="$(
    node --experimental-strip-types "$AXIOS_REMEDIATION" \
      --materialize-install-target "$install_target" \
      --working-directory "$remediation_working_directory"
  )"
  install_args[target_index]="$materialized_target"
fi

if "$ORIGINAL_OPENCLAW" "${install_args[@]}"; then
  :
else
  original_status=$?
  exit "$original_status"
fi

if [[ "$historical_nemoclaw" == 1 ]]; then
  if node --experimental-strip-types "$NPM_REMEDIATION" \
    --verify-install --nemoclaw-root "$NEMOCLAW_ROOT" \
    && node --experimental-strip-types "$NPM_REMEDIATION" \
      --verify-install --nemoclaw-root "$state_directory/extensions/nemoclaw"; then
    :
  else
    remediation_status=$?
    exit "$remediation_status"
  fi
else
  if node --experimental-strip-types "$AXIOS_REMEDIATION" \
    --state-directory "$state_directory" \
    --replacement-root "$REPLACEMENT_ROOT" \
    --expected-package-spec "$expected_package_spec"; then
    :
  else
    remediation_status=$?
    exit "$remediation_status"
  fi
fi

rollback_required=0
if [[ -n "$rollback_root" ]]; then
  rm -rf -- "$rollback_root"
fi
rm -rf -- "$remediation_working_directory"
trap - EXIT
exit 0
