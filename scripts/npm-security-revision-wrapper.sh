#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly ORIGINAL_NPM=/usr/local/bin/npm.nemoclaw-original
readonly REMEDIATION=/usr/local/lib/nemoclaw/npm-tar-security-revision.mts
readonly NEMOCLAW_ROOT=/opt/nemoclaw
readonly MCPORTER_REMEDIATION=/usr/local/lib/nemoclaw/mcporter-hono-security-revision.mts
readonly MCPORTER_ROOT=/usr/local/lib/nemoclaw/mcporter-runtime

is_reviewed_mcporter_ci() {
  [[ "${EUID}" -eq 0 ]] || return 1
  [[ "${1:-}" == --prefix ]] || return 1
  [[ "${2:-}" == "$MCPORTER_ROOT" ]] || return 1
  [[ "${3:-}" == ci ]] || return 1
  [[ -d "$MCPORTER_ROOT" && ! -L "$MCPORTER_ROOT" ]] || return 1
  [[ "$(stat -c %u -- "$MCPORTER_ROOT")" == 0 ]]
}

if is_reviewed_mcporter_ci "$@"; then
  backup_directory="$(mktemp -d /usr/local/lib/nemoclaw/.mcporter-hono-security-revision.XXXXXX)"
  restore_required=0
  # Invoked indirectly by the EXIT trap below.
  # shellcheck disable=SC2329
  cleanup_mcporter() {
    local status=$?
    trap - EXIT
    if [[ "$restore_required" == 1 ]]; then
      if ! node --no-warnings --experimental-strip-types "$MCPORTER_REMEDIATION" \
        --restore-install \
        --mcporter-root "$MCPORTER_ROOT" \
        --backup-directory "$backup_directory"; then
        echo "ERROR: failed to restore historical mcporter package metadata" >&2
        status=70
      fi
    fi
    rm -rf -- "$backup_directory"
    exit "$status"
  }
  trap cleanup_mcporter EXIT

  node --no-warnings --experimental-strip-types "$MCPORTER_REMEDIATION" \
    --prepare-install \
    --mcporter-root "$MCPORTER_ROOT" \
    --backup-directory "$backup_directory"
  restore_required=1
  "$ORIGINAL_NPM" "$@"
  node --no-warnings --experimental-strip-types "$MCPORTER_REMEDIATION" \
    --verify-install \
    --mcporter-root "$MCPORTER_ROOT"
  restore_required=0
  rm -rf -- "$backup_directory"
  trap - EXIT
  exit 0
fi

if [[ "${EUID}" -eq 0 && "${1:-}" == ci ]]; then
  physical_cwd="$(pwd -P)"
  if [[ "$physical_cwd" == "$NEMOCLAW_ROOT" && -d "$NEMOCLAW_ROOT" && ! -L "$NEMOCLAW_ROOT" && "$(stat -c %u -- "$NEMOCLAW_ROOT")" == 0 ]]; then
    backup_directory="$(mktemp -d /opt/.nemoclaw-npm-security-revision.XXXXXX)"
    restore_required=0
    # Invoked indirectly by the EXIT trap below.
    # shellcheck disable=SC2329
    cleanup() {
      local status=$?
      trap - EXIT
      if [[ "$restore_required" == 1 ]]; then
        if ! node --no-warnings --experimental-strip-types "$REMEDIATION" \
          --restore-install \
          --nemoclaw-root "$NEMOCLAW_ROOT" \
          --backup-directory "$backup_directory"; then
          echo "ERROR: failed to restore historical NemoClaw package metadata" >&2
          status=70
        fi
      fi
      rm -rf -- "$backup_directory"
      exit "$status"
    }
    trap cleanup EXIT

    node --no-warnings --experimental-strip-types "$REMEDIATION" \
      --prepare-install \
      --nemoclaw-root "$NEMOCLAW_ROOT" \
      --backup-directory "$backup_directory"
    restore_required=1
    "$ORIGINAL_NPM" "$@"
    node --no-warnings --experimental-strip-types "$REMEDIATION" \
      --verify-install \
      --nemoclaw-root "$NEMOCLAW_ROOT"
    restore_required=0
    rm -rf -- "$backup_directory"
    trap - EXIT
    exit 0
  fi
fi

exec "$ORIGINAL_NPM" "$@"
