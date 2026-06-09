#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Lifecycle dispatcher. Mirrors install/dispatch.sh and onboard/dispatch.sh:
# sources the runtime libs and per-profile worker files, then defines
# `e2e_lifecycle()` which routes by profile id.
#
# Lifecycle workers run AFTER onboarding completes and BEFORE runtime
# assertions execute. They mutate sandbox state (rebuild, upgrade,
# snapshot, ...) and seed context.env keys that runtime assertions in
# validation_suites/lib/rebuild_upgrade.sh consume:
#
#   E2E_REBUILD_MARKER_PATH        absolute path to the workspace marker
#                                  the worker wrote before rebuild
#   E2E_REBUILD_MARKER_EXPECTED    exact content of that marker
#   E2E_OLD_AGENT_VERSION          (optional) version present pre-rebuild
#   E2E_AGENT_VERSION_COMMAND      (optional) sandbox command to read the
#                                  current agent version
#
# Adding a new profile:
#   1. Drop a worker file here (e.g. snapshot-restore.sh) that defines
#      `e2e_lifecycle_<profile_id>`.
#   2. Source it below.
#   3. Add the case branch in e2e_lifecycle().
#   4. Register the profile id in LIFECYCLE_PROFILE_SECRET_ENV in
#      scenarios/compiler.ts so secret env routing keeps working.

_E2E_LIFECYCLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_E2E_LIFECYCLE_RUNTIME_LIB="$(cd "${_E2E_LIFECYCLE_DIR}/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${_E2E_LIFECYCLE_RUNTIME_LIB}/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${_E2E_LIFECYCLE_RUNTIME_LIB}/context.sh"
# shellcheck source=rebuild-current-version.sh
. "${_E2E_LIFECYCLE_DIR}/rebuild-current-version.sh"

e2e_lifecycle() {
  local profile="${1:-}"
  if [[ -z "${profile}" ]]; then
    echo "e2e_lifecycle: missing lifecycle profile id" >&2
    return 2
  fi
  e2e_env_trace "lifecycle:${profile}"
  case "${profile}" in
    rebuild-current-version)
      e2e_lifecycle_rebuild_current_version
      ;;
    *)
      echo "e2e_lifecycle: unsupported lifecycle profile: ${profile}" >&2
      return 2
      ;;
  esac
}
