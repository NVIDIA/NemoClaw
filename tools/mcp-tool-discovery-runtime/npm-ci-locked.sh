#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

install_log=$(mktemp)
trap 'rm -f "$install_log"' EXIT

if npm ci "$@" >"$install_log" 2>&1; then
  cat "$install_log"
else
  install_status=$?
  cat "$install_log" >&2
  if ! grep -Fq 'Exit handler never called!' "$install_log"; then
    exit "$install_status"
  fi

  echo "[nemoclaw] npm hit its internal exit-handler failure; retrying the locked install once from cache" >&2
  rm -rf node_modules
  if npm ci "$@" --prefer-offline >"$install_log" 2>&1; then
    cat "$install_log"
  else
    install_status=$?
    cat "$install_log" >&2
    exit "$install_status"
  fi
fi

rm -f "$install_log"
trap - EXIT
