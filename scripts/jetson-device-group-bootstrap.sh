#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly GROUP_GIDS="${NEMOCLAW_JETSON_DEVICE_GROUP_GIDS:-}"
readonly SANDBOX_USER="sandbox"

[[ "$(id -u)" == "0" ]] || {
  echo "Jetson device-group bootstrap must run as root before the OpenShell supervisor." >&2
  exit 1
}
[[ $# -gt 0 ]] || {
  echo "Jetson device-group bootstrap requires the OpenShell supervisor command." >&2
  exit 1
}
id "$SANDBOX_USER" >/dev/null 2>&1 || {
  echo "Jetson device-group bootstrap could not resolve the sandbox user." >&2
  exit 1
}

IFS=',' read -r -a gids <<<"$GROUP_GIDS"
for gid in "${gids[@]}"; do
  [[ "$gid" =~ ^[1-9][0-9]*$ ]] || {
    echo "Jetson device-group bootstrap received an invalid group ID." >&2
    exit 1
  }

  group_record="$(getent group "$gid" || true)"
  if [[ -n "$group_record" ]]; then
    IFS=':' read -r group_name _ <<<"$group_record"
  else
    group_name="nemoclaw_gpu_$gid"
    groupadd --gid "$gid" "$group_name"
  fi
  [[ -n "$group_name" ]] || {
    echo "Jetson device-group bootstrap could not resolve group ID $gid." >&2
    exit 1
  }
  usermod --append --groups "$group_name" "$SANDBOX_USER"
done

# OpenShell calls initgroups() before setgid()/setuid(). The container group
# database must contain every device group before the supervisor starts.
for gid in "${gids[@]}"; do
  [[ " $(id -G "$SANDBOX_USER") " == *" $gid "* ]] || {
    echo "Jetson device-group bootstrap did not add sandbox to group ID $gid." >&2
    exit 1
  }
done

exec "$@"
