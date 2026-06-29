#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Wrapper installed at /usr/local/bin/hermes that enforces the runtime
# environment secret boundary for `hermes gateway` (NVIDIA/NemoClaw#4975) and
# masks credential-shaped values in `hermes config show` output.
#
# Source-of-truth note for the `config show` masking layer: the upstream Hermes
# CLI emits the resolved configuration (including `api_key`) verbatim because
# the seed pipeline (`agents/hermes/seed-dashboard-config.py:_route_api_key`)
# and the runtime config guard (`agents/hermes/runtime-config-guard.py:
# ensure_api_key`) require an `sk-`-prefixed value before LiteLLM issues a
# request — the placeholder `sk-OPENSHELL-PROXY-REWRITE` is substituted at the
# OpenShell egress boundary, not in-process. A source-level fix would require
# Hermes CLI native env-var reference support (an upstream change). Until that
# lands, this wrapper post-filters `config show` stdout through the Python
# masker. Remove the `config show` branch and this comment once Hermes CLI
# redacts credential-shaped fields natively.
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

_resolve_trusted_python3() {
  for _candidate in /usr/bin/python3 /usr/local/bin/python3 /opt/hermes/.venv/bin/python3; do
    if [ -x "$_candidate" ]; then
      printf '%s' "$_candidate"
      return 0
    fi
  done
  return 1
}

if [ "${1:-}" = "config" ] && [ "${2:-}" = "show" ]; then
  set -o pipefail
  PYTHON3="$(_resolve_trusted_python3)" || {
    echo "[SECURITY] Refusing hermes config show: no python3 at a trusted absolute path to run the output masker" >&2
    exit 127
  }
  "$REAL_HERMES" "$@" | "$PYTHON3" "$GUARD" mask-config-output
  statuses=("${PIPESTATUS[@]}")
  hermes_status="${statuses[0]}"
  masker_status="${statuses[1]}"
  if [ "$masker_status" -ne 0 ]; then
    echo "[SECURITY] Refusing hermes config show: output masker failed" >&2
    exit "$masker_status"
  fi
  exit "$hermes_status"
fi

if [ "${1:-}" = "gateway" ]; then
  PYTHON3="$(_resolve_trusted_python3)" || {
    echo "[SECURITY] Refusing hermes gateway: no python3 at a trusted absolute path to run the secret-boundary guard" >&2
    exit 127
  }
  "$PYTHON3" "$GUARD" runtime-env || exit $?
fi

exec "$REAL_HERMES" "$@"
