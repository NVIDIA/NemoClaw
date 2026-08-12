#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Compatibility bridge for #7610. Remove when the minimum supported OpenShell
# release natively preserves Jetson device groups across the sandbox-user handoff.

set -euo pipefail

fail() {
  printf 'Jetson device-group bootstrap: %s\n' "$*" >&2
  exit 1
}

[ "$(/usr/bin/id -u)" -eq 0 ] || fail "must run as root"
[ "${1:-}" = "--device-group-gids" ] || fail "device group argument is missing"
group_gids="${2:-}"
[ "${3:-}" = "--" ] || fail "supervisor delimiter is missing"
shift 3
[ "${1:-}" = "/opt/openshell/bin/openshell-sandbox" ] \
  || fail "OpenShell supervisor entrypoint is invalid"
/usr/bin/id sandbox >/dev/null 2>&1 || fail "sandbox user is missing"
if [ ! -f /etc/group ] || [ -L /etc/group ]; then
  fail "container group database is invalid"
fi

IFS=',' read -r -a gids <<<"$group_gids"
if [ "${#gids[@]}" -eq 0 ] || [ "${#gids[@]}" -gt 16 ]; then
  fail "device group count is invalid"
fi

declare -A seen=()
for gid in "${gids[@]}"; do
  [[ "$gid" =~ ^[1-9][0-9]{0,9}$ ]] || fail "device group ID is invalid"
  [ "$gid" -le 2147483647 ] || fail "device group ID is out of range"
  [ -z "${seen[$gid]:-}" ] || fail "device group ID is duplicated"
  seen[$gid]=1
done

for gid in "${gids[@]}"; do
  group_record="$(/usr/bin/getent group "$gid" || true)"
  if [ -z "$group_record" ]; then
    group_name="nemoclaw_gpu_$gid"
    /usr/sbin/groupadd --gid "$gid" "$group_name"
  else
    IFS=':' read -r group_name _ resolved_gid _ <<<"$group_record"
    if [ -z "$group_name" ] || [ "$resolved_gid" != "$gid" ]; then
      fail "device group record is invalid"
    fi
  fi
  /usr/sbin/usermod --append --groups "$group_name" sandbox
done

sandbox_groups=" $(/usr/bin/id -G sandbox) "
for gid in "${gids[@]}"; do
  [[ "$sandbox_groups" == *" $gid "* ]] \
    || fail "sandbox membership verification failed"
done

exec "$@"
