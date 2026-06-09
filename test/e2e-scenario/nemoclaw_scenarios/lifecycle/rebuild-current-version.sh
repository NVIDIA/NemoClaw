#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Lifecycle worker: rebuild-current-version.
#
# Drives the workspace-state-preservation invariant from
# test/e2e/test-rebuild-openclaw.sh, scoped to the rebuild trigger and
# the contract the runtime-phase rebuild_upgrade.sh assertions consume.
# The legacy test additionally exercised the version-upgrade path
# (build OLD-version base image, create sandbox from it, then rebuild
# to current). That dimension belongs to a future
# `rebuild-from-old-version` lifecycle profile and is intentionally
# out of scope here: this profile validates that
# `nemoclaw <sandbox> rebuild --yes` preserves workspace state across
# a rebuild, which is the core invariant the rebuild_upgrade.sh
# assertions assert.
#
# Sequence:
#   1. Read E2E_SANDBOX_NAME from the context the onboarding phase
#      already populated.
#   2. Snapshot the current agent version (informational; runtime
#      assertions accept an empty E2E_OLD_AGENT_VERSION as a vacuous
#      pass on the version-upgraded check, which is the right default
#      until the old-version profile lands).
#   3. Write a unique marker into /sandbox/.openclaw/workspace via the
#      canonical e2e_sandbox_exec wrapper. Path mirrors the legacy
#      test's MARKER_FILE so the read-side assertion stays unchanged.
#   4. Verify the marker is readable post-write (catch silent write
#      failures before rebuild kicks off).
#   5. Run `nemoclaw <sandbox> rebuild --yes` and capture the output.
#   6. Seed E2E_REBUILD_MARKER_PATH and E2E_REBUILD_MARKER_EXPECTED in
#      context.env so the runtime-phase
#      rebuild_upgrade_assert_marker_preserved assertion can read them.
#   7. Optionally seed E2E_AGENT_VERSION_COMMAND so the version-check
#      assertion uses the in-sandbox `openclaw --version` invocation.

# Source the canonical sandbox-exec wrapper so this worker inherits the
# ssh-config preferred / openshell-exec fallback transport without
# re-implementing the routing logic.
_E2E_LIFECYCLE_RC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_E2E_LIFECYCLE_RC_VALIDATION_SUITES="$(cd "${_E2E_LIFECYCLE_RC_DIR}/../../validation_suites" && pwd)"
# shellcheck source=../../validation_suites/sandbox-exec.sh
. "${_E2E_LIFECYCLE_RC_VALIDATION_SUITES}/sandbox-exec.sh"

# Marker file path inside the sandbox. Mirrors the legacy
# test-rebuild-openclaw.sh MARKER_FILE so cross-check against the
# legacy contract stays apples-to-apples.
LIFECYCLE_REBUILD_MARKER_PATH="/sandbox/.openclaw/workspace/rebuild-marker.txt"

e2e_lifecycle_rebuild_current_version() {
  e2e_env_apply_noninteractive

  local sandbox_name marker_content rc=0
  sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"
  if [[ -z "${sandbox_name}" ]]; then
    echo "lifecycle:rebuild-current-version: E2E_SANDBOX_NAME missing in context" >&2
    return 1
  fi
  # Random suffix prevents marker-content collisions across re-runs that
  # somehow inherit a partially-rebuilt sandbox; the timestamp keeps the
  # value greppable in logs.
  marker_content="REBUILD_LIFECYCLE_$(date +%s)_${RANDOM}"

  echo "lifecycle:rebuild-current-version: sandbox=${sandbox_name}"
  echo "lifecycle:rebuild-current-version: marker_path=${LIFECYCLE_REBUILD_MARKER_PATH}"
  echo "lifecycle:rebuild-current-version: marker_content=${marker_content}"

  # Step 2: snapshot current version (best-effort; vacuous if it fails).
  local pre_rebuild_version=""
  if pre_rebuild_version="$(
    E2E_SANDBOX_EXEC_TIMEOUT_SECONDS=30 \
      e2e_sandbox_exec "${sandbox_name}" -- bash -lc 'openclaw --version 2>/dev/null || true'
  )"; then
    echo "lifecycle:rebuild-current-version: pre_rebuild_version=${pre_rebuild_version}"
  fi

  # Step 3: write the marker file.
  if ! E2E_SANDBOX_EXEC_TIMEOUT_SECONDS=30 \
    e2e_sandbox_exec "${sandbox_name}" -- sh -c \
    "mkdir -p '$(dirname "${LIFECYCLE_REBUILD_MARKER_PATH}")' && printf '%s' '${marker_content}' > '${LIFECYCLE_REBUILD_MARKER_PATH}'"; then
    echo "lifecycle:rebuild-current-version: failed to write marker into sandbox" >&2
    return 1
  fi

  # Step 4: verify marker readable pre-rebuild. This catches sandbox
  # filesystem oddities (read-only mounts, perms) before we waste the
  # rebuild cycle.
  local verify_content=""
  verify_content="$(
    E2E_SANDBOX_EXEC_TIMEOUT_SECONDS=30 \
      e2e_sandbox_exec "${sandbox_name}" -- cat "${LIFECYCLE_REBUILD_MARKER_PATH}"
  )" || rc=$?
  if [[ "${rc}" -ne 0 || "${verify_content}" != "${marker_content}" ]]; then
    echo "lifecycle:rebuild-current-version: marker readback mismatch (got '${verify_content}', expected '${marker_content}')" >&2
    return 1
  fi
  echo "lifecycle:rebuild-current-version: marker seeded and verified"

  # Step 5: trigger the rebuild. Match the legacy contract:
  # `--yes` to skip the confirmation prompt; `--verbose` to surface
  # progress in the action log so failures are diagnosable from the
  # artifact bundle alone.
  echo "lifecycle:rebuild-current-version: invoking nemoclaw ${sandbox_name} rebuild --yes --verbose"
  if ! nemoclaw "${sandbox_name}" rebuild --yes --verbose; then
    rc=$?
    echo "lifecycle:rebuild-current-version: nemoclaw rebuild exited ${rc}" >&2
    return "${rc}"
  fi
  echo "lifecycle:rebuild-current-version: rebuild completed"

  # Step 6: publish the marker contract to runtime-phase assertions.
  e2e_context_set E2E_REBUILD_MARKER_PATH "${LIFECYCLE_REBUILD_MARKER_PATH}"
  e2e_context_set E2E_REBUILD_MARKER_EXPECTED "${marker_content}"
  # Step 7: tell the version-check assertion how to read the agent
  # version inside the sandbox. The default in rebuild_upgrade.sh is
  # already `openclaw --version`, but seeding it explicitly makes the
  # contract obvious in context.env when artifacts are inspected.
  e2e_context_set E2E_AGENT_VERSION_COMMAND "openclaw --version"
  if [[ -n "${pre_rebuild_version}" ]]; then
    # Only set E2E_OLD_AGENT_VERSION when we actually captured a
    # non-empty pre-rebuild version. The version-upgraded assertion
    # treats an empty value as "no comparison required" and passes
    # vacuously, which is the correct behavior for the
    # rebuild-current-version profile (no upgrade is expected; we are
    # only validating workspace preservation).
    e2e_context_set E2E_OLD_AGENT_VERSION "${pre_rebuild_version}"
  fi

  echo "lifecycle:rebuild-current-version: context.env updated"
  return 0
}
