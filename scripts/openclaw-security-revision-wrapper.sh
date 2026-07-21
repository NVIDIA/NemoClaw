#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly ORIGINAL_OPENCLAW=/usr/local/bin/openclaw.nemoclaw-original
readonly INVOCATION_PARSER=/usr/local/lib/nemoclaw/openclaw-security-revision-invocation.mts
readonly AXIOS_REMEDIATION=/usr/local/lib/nemoclaw/openclaw-plugin-axios-security-revision.mts
readonly PLUGIN_CORE_REMEDIATION=/usr/local/lib/nemoclaw/openclaw-plugin-core-security-revision.mts
readonly NPM_REMEDIATION=/usr/local/lib/nemoclaw/npm-tar-security-revision.mts
readonly REPLACEMENT_ROOT=/usr/local/share/nemoclaw/openclaw-plugin-axios-1.18.0
readonly PLUGIN_CORE_REPLACEMENT_ROOT=/usr/local/share/nemoclaw/openclaw-plugin-core-security-replacements-v1
readonly NEMOCLAW_ROOT=/opt/nemoclaw
readonly OPENCLAW_STATE_ROOT=/sandbox

invocation_file="$(mktemp /tmp/nemoclaw-openclaw-security-invocation.XXXXXX)"
node --no-warnings --experimental-strip-types "$INVOCATION_PARSER" \
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
resolved_target="$(
  node -e \
    'const path = require("node:path"); process.stdout.write(path.resolve(process.argv[1]));' \
    "$install_target"
)"
expected_package_spec=""
axios_package_spec=""
historical_nemoclaw=0
if [[ "$resolved_target" == "$NEMOCLAW_ROOT" ]]; then
  historical_nemoclaw=1
else
  expected_package_spec="$(
    node --no-warnings --experimental-strip-types "$PLUGIN_CORE_REMEDIATION" \
      --classify-install-target "$install_target"
  )"
  if [[ -z "$expected_package_spec" ]]; then
    exec "$ORIGINAL_OPENCLAW" "$@"
  fi
  axios_package_spec="$(
    node --no-warnings --experimental-strip-types "$AXIOS_REMEDIATION" \
      --classify-install-target "$install_target"
  )"
fi
if [[ "$state_directory" != /* || "$state_directory" == / ]]; then
  echo "ERROR: OpenClaw state directory must be a non-root absolute path" >&2
  exit 64
fi
if ! node --no-warnings --experimental-strip-types "$INVOCATION_PARSER" \
  --validate-state-directory "$state_directory" \
  --trusted-root "$OPENCLAW_STATE_ROOT"; then
  exit 64
fi

remediation_working_directory="$(mktemp -d /tmp/nemoclaw-openclaw-plugin-remediation.XXXXXX)"
rollback_root=""
prior_state=absent
rollback_required=0
credential_hold_root=""
credential_state=absent

# Reached through normal completion and the trap-invoked rollback/cleanup paths.
# shellcheck disable=SC2329
restore_held_credentials() {
  local credential_path="$state_directory/credentials"
  local held_path="$credential_hold_root/credentials"
  if [[ "$credential_state" != held ]]; then
    return 0
  fi
  mkdir -p -- "$state_directory" || return 1
  if [[ -e "$credential_path" || -L "$credential_path" ]]; then
    if [[ ! -L "$credential_path" || "$(readlink "$credential_path")" != "$held_path" ]]; then
      return 1
    fi
    rm -f -- "$credential_path" || return 1
  fi
  mv -- "$held_path" "$credential_path" || return 1
  rmdir "$credential_hold_root" || return 1
  credential_state=restored
  credential_hold_root=""
}

# Reached through the trap-invoked cleanup function below.
# shellcheck disable=SC2329
rollback_openclaw_state() {
  local current_state=""
  local restore_root=""
  if [[ -e "$state_directory" || -L "$state_directory" ]]; then
    if [[ -z "$rollback_root" ]]; then
      rollback_root="$(mktemp -d "$(dirname -- "$state_directory")/.nemoclaw-openclaw-state-rollback.XXXXXX")" || return 1
    fi
    current_state="$rollback_root/current-state"
    if ! mv -- "$state_directory" "$current_state"; then
      restore_held_credentials || true
      return 1
    fi
  fi
  if [[ "$prior_state" == present ]]; then
    if ! mv -- "$rollback_root/prior-state" "$state_directory"; then
      # Both temporary roots are siblings of the live state directory. If the
      # reverse rename still fails after the live tree was vacated (for example,
      # because of host filesystem policy or endpoint-security contention), the
      # wrapper cannot correct that external condition. Copy only into the
      # private restore root and expose the completed copy with a same-filesystem
      # rename, so a partial copy never becomes live. Remove this fallback only
      # when the supported runtime contract makes reverse sibling renames
      # infallible or replaces rollback with an equally atomic restore primitive.
      restore_root="$(mktemp -d "$(dirname -- "$state_directory")/.nemoclaw-openclaw-state-restore.XXXXXX")" || true
      if [[ -n "$restore_root" ]] \
        && cp -a -- "$rollback_root/prior-state" "$restore_root/completed-state" \
        && mv -- "$restore_root/completed-state" "$state_directory"; then
        rmdir "$restore_root" || true
        restore_held_credentials || return 1
        echo "WARNING: restored the prior OpenClaw state through an atomically staged copy after the direct rollback rename failed" >&2
        return 0
      fi
      if [[ -n "$restore_root" ]]; then
        rm -rf -- "$restore_root" || true
      fi
      rm -rf -- "$state_directory" || true
      restore_held_credentials || true
      return 1
    fi
  fi
  restore_held_credentials || return 1
}

# Invoked indirectly by the EXIT trap below.
# shellcheck disable=SC2329
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$rollback_required" == 1 ]]; then
    if ! rollback_openclaw_state; then
      echo "ERROR: failed to restore the prior OpenClaw state after plugin installation" >&2
      status=70
    fi
  fi
  if [[ "$credential_state" == held ]] && ! restore_held_credentials; then
    echo "ERROR: retained the only recoverable OpenClaw credential state at $credential_hold_root" >&2
    status=70
  fi
  if [[ -n "$rollback_root" ]]; then
    if ! rm -rf -- "$rollback_root"; then
      chmod -R u+rwX -- "$rollback_root" 2>/dev/null || true
      if ! rm -rf -- "$rollback_root"; then
        echo "ERROR: failed to remove the OpenClaw state rollback snapshot" >&2
        status=70
      fi
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
  credential_path="$state_directory/credentials"
  if [[ -e "$credential_path" || -L "$credential_path" ]]; then
    credential_hold_root="$(mktemp -d "$(dirname -- "$state_directory")/.nemoclaw-openclaw-credentials-hold.XXXXXX")"
    if ! chmod 0700 "$credential_hold_root"; then
      rmdir "$credential_hold_root" || true
      credential_hold_root=""
      exit 70
    fi
    mv -- "$credential_path" "$credential_hold_root/credentials"
    credential_state=held
  fi
  cp -a -- "$state_directory" "$rollback_root/prior-state"
  if [[ "$credential_state" == held ]]; then
    ln -s -- "$credential_hold_root/credentials" "$credential_path"
  fi
  prior_state=present
fi
rollback_required=1

install_args=("$@")
if [[ "$historical_nemoclaw" == 0 ]]; then
  materialized_target="$(
    node --no-warnings --experimental-strip-types "$PLUGIN_CORE_REMEDIATION" \
      --materialize-remediated-install-target "$install_target" \
      --working-directory "$remediation_working_directory" \
      --replacement-root "$PLUGIN_CORE_REPLACEMENT_ROOT" \
      --axios-replacement-root "$REPLACEMENT_ROOT"
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
  if node --no-warnings --experimental-strip-types "$NPM_REMEDIATION" \
    --verify-install --nemoclaw-root "$NEMOCLAW_ROOT" \
    && node --no-warnings --experimental-strip-types "$NPM_REMEDIATION" \
      --verify-install --nemoclaw-root "$state_directory/extensions/nemoclaw"; then
    :
  else
    remediation_status=$?
    exit "$remediation_status"
  fi
else
  if [[ -n "$axios_package_spec" ]]; then
    if node --no-warnings --experimental-strip-types "$AXIOS_REMEDIATION" \
      --state-directory "$state_directory" \
      --replacement-root "$REPLACEMENT_ROOT" \
      --expected-package-spec "$axios_package_spec"; then
      :
    else
      remediation_status=$?
      exit "$remediation_status"
    fi
  fi
  if node --no-warnings --experimental-strip-types "$PLUGIN_CORE_REMEDIATION" \
    --state-directory "$state_directory" \
    --replacement-root "$PLUGIN_CORE_REPLACEMENT_ROOT" \
    --expected-package-spec "$expected_package_spec"; then
    :
  else
    remediation_status=$?
    exit "$remediation_status"
  fi
fi
if ! restore_held_credentials; then
  echo "ERROR: failed to restore protected OpenClaw credentials after plugin installation" >&2
  exit 70
fi
rollback_required=0
if [[ -n "$rollback_root" ]]; then
  rm -rf -- "$rollback_root"
fi
rm -rf -- "$remediation_working_directory"
trap - EXIT
exit 0
