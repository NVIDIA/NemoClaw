#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

# OpenClaw 2026.9.1 verifies that its package root belongs to the active global
# package manager before even planning an update. NemoClaw's sandbox identity
# intentionally uses /sandbox/.local for ordinary user-owned npm installs, while
# the reviewed OpenClaw runtime is exposed through /usr/local/lib/node_modules.
# Select that system prefix only for OpenClaw's own update command so its owner
# probe and planned install target agree. Plugin/package commands retain the
# sandbox user's ordinary npm prefix.
if [ "${1:-}" = "update" ]; then
  unset npm_config_prefix
  NPM_CONFIG_PREFIX=/usr/local
  export NPM_CONFIG_PREFIX
fi

exec /usr/local/bin/node /usr/local/lib/node_modules/openclaw/openclaw.mjs "$@"
