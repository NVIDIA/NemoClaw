# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

# OpenShell uses a login shell for managed probes. Select an image-owned home
# before Bash reads personal files; the managed launcher restores agent HOME.
case "${BASH_EXECUTION_STRING:-}" in
  *"/usr/local/lib/nemoclaw/dcode-managed-exec"*)
    unset BASH_ENV ENV
    export HOME=/usr/local/lib/nemoclaw
    ;;
esac
