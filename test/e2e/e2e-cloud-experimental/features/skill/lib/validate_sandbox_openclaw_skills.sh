#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# OpenClaw skill-related layout inside the NemoClaw sandbox (after migrate).
# - Requires migrated state at /sandbox/.openclaw (openclaw.json).
# - /sandbox/.openclaw/skills is optional (host snapshot may omit it); prints status for the caller.
#
# Usage:
#   SANDBOX_NAME=my-sbx bash test/e2e/e2e-cloud-experimental/features/skill/lib/validate_sandbox_openclaw_skills.sh
# Exit:
#   0 — state dir + config OK (stdout: SKILLS_SUBDIR=present|absent)
#   1 — ssh/openshell failure or missing required paths

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-experimental}}"

die() {
  printf '%s\n' "validate_sandbox_openclaw_skills: FAIL: $*" >&2
  exit 1
}

ssh_config="$(mktemp)"
trap 'rm -f "$ssh_config"' EXIT

openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null \
  || die "openshell sandbox ssh-config failed for '${SANDBOX_NAME}'"

TIMEOUT_CMD=""
command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD="timeout 60"
command -v gtimeout >/dev/null 2>&1 && TIMEOUT_CMD="gtimeout 60"

ssh_host="openshell-${SANDBOX_NAME}"
remote='set -e
if [ ! -d /sandbox/.openclaw ]; then echo "MISSING_STATE_DIR"; exit 2; fi
if [ ! -f /sandbox/.openclaw/openclaw.json ]; then echo "MISSING_CONFIG"; exit 3; fi
if [ -d /sandbox/.openclaw/skills ]; then echo "SKILLS_SUBDIR=present"; else echo "SKILLS_SUBDIR=absent"; fi
exit 0'

set +e
out=$(
  $TIMEOUT_CMD ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "$ssh_host" \
    "$remote" 2>/dev/null
)
rc=$?
set -e

out="$(echo "$out" | tr -d '\r' | tail -n 5)"

[ "$rc" -eq 0 ] || die "ssh failed (exit $rc): ${out:0:200}"

case "$out" in
  *MISSING_STATE_DIR*) die "/sandbox/.openclaw missing inside sandbox" ;;
  *MISSING_CONFIG*) die "/sandbox/.openclaw/openclaw.json missing inside sandbox" ;;
  *SKILLS_SUBDIR=present*)
    printf '%s\n' "$out"
    exit 0
    ;;
  *SKILLS_SUBDIR=absent*)
    printf '%s\n' "$out"
    exit 0
    ;;
  *) die "unexpected remote output: ${out:0:200}" ;;
esac
