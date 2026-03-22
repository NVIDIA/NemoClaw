# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Sourced by .husky/* hooks. Git GUI / non-login shells often omit PATH entries where Node lives,
# which breaks bin stubs that use `#!/usr/bin/env node` (tsc, vitest, lint-staged, etc.).

PATH="/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"
export PATH

if [ -z "${NVM_DIR:-}" ]; then
  NVM_DIR="$HOME/.nvm"
fi
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi

if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env)" || true
fi
