#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared install-path-refresh helper for e2e test scripts. Meant to be sourced;
# the shebang and executable bit satisfy repo shell-file conventions.
#
# Why: install.sh places the openshell/nemoclaw binaries under ~/.local/bin.
# Sourcing ~/.bashrc on GitHub runners triggers nvm.sh, which rebuilds $PATH
# from scratch and drops ~/.local/bin — so a post-install `command -v
# nemoclaw` check fails with "nemoclaw not found". This helper centralises
# the recovery so every e2e test script applies the same guard.
#
# Usage:
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/install-path-refresh.sh"
#
#   # After running install.sh, reload the shell profile and pick up the
#   # binaries it installed:
#   nemoclaw_refresh_install_env
#
#   # If you only need to defensively ensure ~/.local/bin is on PATH:
#   nemoclaw_ensure_local_bin_on_path

# Prepend ~/.local/bin to PATH if it exists and isn't already there.
nemoclaw_ensure_local_bin_on_path() {
  if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    export PATH="$HOME/.local/bin:$PATH"
  fi
}

# Source ~/.bashrc (best-effort) and then ensure ~/.local/bin is on PATH.
# Needed after running install.sh because nvm.sh (loaded via .bashrc) rebuilds
# PATH from scratch and can drop the directory where install.sh places the
# openshell/nemoclaw binaries.
nemoclaw_refresh_install_env() {
  if [ -f "$HOME/.bashrc" ]; then
    # shellcheck source=/dev/null
    source "$HOME/.bashrc" 2>/dev/null || true
  fi
  nemoclaw_ensure_local_bin_on_path
}
