#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

[[ "$#" == "4" ]] || exit 20
authority="$1"
sentinel="$2"
source_receipt="$3"
consumed_receipt="$4"

for value in "$authority" "$sentinel" "$source_receipt" "$consumed_receipt"; do
  [[ "$value" == /* && "$value" != *$'\n'* ]] || exit 21
done

# The dedicated UID cannot traverse the controller authority, even when it is
# handed an exact child path. The consumed receipt has no remaining pathname.
! /bin/cat -- "$sentinel" >/dev/null 2>&1 || exit 30
! /bin/ls -- "$authority" >/dev/null 2>&1 || exit 31
for receipt in "$source_receipt" "$consumed_receipt"; do
  [[ ! -e "$receipt" ]] || exit 32
  ! /bin/cat -- "$receipt" >/dev/null 2>&1 || exit 33
done

# The private procfs contains only this invocation's namespace. PID 1 is this
# artifact, with the runner's exact sanitized environment, rather than the host
# init process or controller.
namespace_pid=""
while read -r status_key status_values; do
  if [[ "$status_key" == "NSpid:" ]]; then
    read -r -a namespace_pids <<<"$status_values"
    namespace_pid="${namespace_pids[-1]}"
  fi
done </proc/1/status
[[ "$$" == "1" && "$namespace_pid" == "1" ]] || exit 35
declare -A expected_environment=(
  ["HOME=/run/nemoclaw-cua-artifact/home"]=1
  ["LANG=C"]=1
  ["LC_ALL=C"]=1
  ["PATH=/usr/bin:/bin"]=1
  ["TEMP=/run/nemoclaw-cua-artifact/tmp"]=1
  ["TMP=/run/nemoclaw-cua-artifact/tmp"]=1
  ["TMPDIR=/run/nemoclaw-cua-artifact/tmp"]=1
  ["XDG_RUNTIME_DIR=/run/user/$(/usr/bin/id -u)"]=1
)
observed_environment_count=0
while IFS= read -r -d '' environment_entry; do
  [[ -n "${expected_environment[$environment_entry]+present}" ]] || exit 35
  unset 'expected_environment[$environment_entry]'
  ((observed_environment_count += 1))
done </proc/1/environ
[[ "$observed_environment_count" == "8" && "${#expected_environment[@]}" == "0" ]] || exit 35

# The explicit no-target-channel runner mode exposes neither the image-owned
# source socket nor the isolated fixed-path projection used by CUA artifacts.
[[ -z "${NEMOCLAW_CUA_QUALIFICATION_TARGET_SOCKET:-}" ]] || exit 37
[[ ! -e /run/nemoclaw/cua-qualification-target.sock ]] || exit 38
[[ ! -e /run/nemoclaw-cua-artifact/target.sock ]] || exit 39

artifact_uid="$(/usr/bin/id -u)"
[[ "$artifact_uid" =~ ^[1-9][0-9]*$ ]] || exit 36

# Leave a signal-ignoring descendant behind as the behavioral cleanup probe.
# The host test verifies that the dedicated UID/GID, transient unit, and cgroup
# are all absent after the runner returns.
/usr/bin/bash -c 'trap "" HUP INT TERM; exec /usr/bin/sleep 120' &

printf '{"schemaVersion":"1.0.0","kind":"cua-qualification-isolation-probe","status":"isolated","uid":%s}\n' \
  "$artifact_uid"
