#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Stop leftover Node workers inside one OpenClaw sandbox so :18789 can bind.
# Run via: kubectl cp this file into the pod, then sh /tmp/e2e-stop-openclaw.sh
# Do not inline the patterns in kubectl exec argv (that process matches itself).

list_pids() {
  ps -eo pid=,args= | awk '
    $1 == 1 { next }
    /e2e-stop-openclaw/ { next }
    /sleep infinity/ { next }
    /openshell-sandbox/ { next }
    /nemoclaw-start/ { print $1; next }
    /openclaw/ { print $1; next }
    /\/usr\/local\/bin\/node/ { print $1; next }
    /python3/ { print $1; next }
    /E2E_INFLIGHT/ { print $1; next }
  '
}

i=0
while [ "$i" -lt 10 ]; do
  list_pids | xargs -r kill -9 2>/dev/null || true
  i=$((i + 1))
  sleep 1
done
exit 0
