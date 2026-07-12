#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# OpenClaw's embedded ACPx runtime runs under the gateway user, while the
# container's default tool redirects are owned by the sandbox user. Keep Codex
# state in a per-UID /tmp tree so codex-acp can initialize without touching
# /sandbox or another user's XDG directories.
_uid="$(id -u)"
_base="${NEMOCLAW_CODEX_ACP_HOME:-/tmp/nemoclaw-codex-acp-${_uid}}"

export HOME="${_base}/home"
export CODEX_HOME="${_base}/codex"
export CODEX_SQLITE_HOME="${_base}/sqlite"
export XDG_CACHE_HOME="${_base}/cache"
export XDG_CONFIG_HOME="${_base}/config"
export XDG_DATA_HOME="${_base}/data"
export XDG_STATE_HOME="${_base}/state"
export XDG_RUNTIME_DIR="${_base}/runtime"
export GIT_CONFIG_GLOBAL="${_base}/gitconfig"
export GNUPGHOME="${_base}/gnupg"

mkdir -p \
  "$HOME" \
  "$CODEX_HOME" \
  "$CODEX_SQLITE_HOME" \
  "$XDG_CACHE_HOME" \
  "$XDG_CONFIG_HOME" \
  "$XDG_DATA_HOME" \
  "$XDG_STATE_HOME" \
  "$XDG_RUNTIME_DIR" \
  "$GNUPGHOME"
chmod 700 \
  "$_base" \
  "$HOME" \
  "$CODEX_HOME" \
  "$CODEX_SQLITE_HOME" \
  "$XDG_CACHE_HOME" \
  "$XDG_CONFIG_HOME" \
  "$XDG_DATA_HOME" \
  "$XDG_STATE_HOME" \
  "$XDG_RUNTIME_DIR" \
  "$GNUPGHOME" 2>/dev/null || true
touch "$GIT_CONFIG_GLOBAL"
chmod 600 "$GIT_CONFIG_GLOBAL" 2>/dev/null || true

exec /usr/local/bin/codex-acp "$@"
