# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

# OpenShell starts command-bearing sandbox sessions with `bash -lc` and sets
# HOME to the writable workspace before Bash reads its first login file. Keep
# this first-match profile root-owned so sandbox code cannot run before a
# NemoClaw-managed DCode probe. Ordinary login commands retain the established
# runtime environment; the managed launcher rebuilds that environment from
# image-owned inputs and must not source the sandbox-user-owned convenience
# file first.
unset BASH_ENV ENV
case "${BASH_EXECUTION_STRING:-}" in
  *"/usr/local/lib/nemoclaw/dcode-managed-exec"*) ;;
  *)
    [ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh
    export HOME=/sandbox
    export PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
    ;;
esac
