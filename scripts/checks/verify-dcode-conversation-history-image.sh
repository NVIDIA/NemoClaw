#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

image_reference="${1:-}"
platform="${2:-}"
darwin_compat="${3:-0}"

if [ -z "$image_reference" ] || [ -z "$platform" ] \
  || { [ "$darwin_compat" != "0" ] && [ "$darwin_compat" != "1" ]; }; then
  echo "Usage: $0 <image-reference> <platform> [darwin-compat: 0|1]" >&2
  exit 2
fi

docker run --rm --platform "$platform" --user root --entrypoint /bin/sh "$image_reference" -c '
  set -eu
  darwin_compat="$1"
  history=/sandbox/.deepagents/conversation_history
  marker="$history/nemoclaw-permission-probe"
  renamed="$history.deleted"

  test "$(stat -c "%U:%G:%a" "$history")" = "sandbox:sandbox:700"
  printf "%s\n" private > "$marker"
  chown sandbox:sandbox "$marker"
  chmod 0600 "$marker"

  if setpriv --reuid=65534 --regid=65534 --clear-groups /bin/sh -c \
    "cat $marker >/dev/null 2>&1"; then
    echo "ERROR: another UID can read Deep Agents Code conversation history." >&2
    exit 1
  fi
  if setpriv --reuid=65534 --regid=65534 --clear-groups /bin/sh -c \
    "printf denied > $history/nonowner-write 2>/dev/null"; then
    echo "ERROR: another UID can write Deep Agents Code conversation history." >&2
    exit 1
  fi
  if setpriv --reuid=65534 --regid=65534 --clear-groups /bin/rm -f "$marker" 2>/dev/null; then
    echo "ERROR: another UID can delete Deep Agents Code conversation history." >&2
    exit 1
  fi
  if setpriv --reuid=65534 --regid=65534 --clear-groups /bin/mv "$history" "$renamed" 2>/dev/null; then
    echo "ERROR: another UID can rename the Deep Agents Code conversation-history directory." >&2
    exit 1
  fi
  test ! -e "$history/nonowner-write"
  test ! -e "$renamed"
  test -f "$marker"

  if [ "$darwin_compat" = "1" ] &&
    ! setpriv --reuid=65534 --regid=65534 --clear-groups /bin/sh -c \
      ": >> /sandbox/.deepagents/config.toml"; then
    echo "ERROR: Darwin compatibility did not retain shared Deep Agents Code configuration access." >&2
    exit 1
  fi
' -- "$darwin_compat"
