#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Wrapper installed at /usr/local/bin/hermes that enforces the runtime
# environment secret boundary for `hermes gateway` (NVIDIA/NemoClaw#4975).
#
# The same guard runs in the nemoclaw-start entrypoint
# (agents/hermes/start.sh: validate_hermes_runtime_env_secret_boundary) and in
# the host-side gateway recovery path, but a direct `docker exec ... hermes
# gateway run` invokes the CLI without ever crossing the entrypoint, so it
# started the gateway with raw secret-shaped env vars (e.g.
# SLACK_BOT_TOKEN=xoxb-real-...). Wrapping the binary closes that bypass: every
# path that launches the gateway now passes through the same single-source-of-
# truth validator before the port is bound.
#
# Only the `gateway` subcommand is guarded; all other hermes subcommands
# (dashboard, --version, ...) pass straight through unchanged.
#
# SECURITY: the validator, the python interpreter that runs it, and the real
# binary are all resolved from fixed paths, never from the environment. This
# wrapper exists to reject a malicious runtime environment, so it must not let
# that same environment redirect the guard (to a no-op), the interpreter (a
# PATH-shadowed python3), or the binary it protects. The dev fallback resolves
# against this script's own directory so a checkout works without an install,
# matching start.sh's _HERMES_BOUNDARY_VALIDATOR resolution.
set -u

_self_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

REAL_HERMES="/usr/local/bin/hermes.real"
[ -x "$REAL_HERMES" ] || REAL_HERMES="${_self_dir}/hermes.real"

GUARD="/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py"
[ -f "$GUARD" ] || GUARD="${_self_dir}/validate-env-secret-boundary.py"

if [ "${1:-}" = "gateway" ]; then
  # Run the guard with python3 resolved from a fixed set of absolute paths, not
  # via PATH: PATH is part of the untrusted environment this wrapper guards
  # against, so a PATH-shadowed python3 could no-op the secret check. Fail
  # closed if no trusted interpreter is found.
  PYTHON3=""
  for _candidate in /usr/bin/python3 /usr/local/bin/python3 /opt/hermes/.venv/bin/python3; do
    if [ -x "$_candidate" ]; then
      PYTHON3="$_candidate"
      break
    fi
  done
  if [ -z "$PYTHON3" ]; then
    echo "[SECURITY] Refusing hermes gateway: no python3 at a trusted absolute path to run the secret-boundary guard" >&2
    exit 127
  fi
  "$PYTHON3" "$GUARD" runtime-env || exit $?
fi

exec "$REAL_HERMES" "$@"
