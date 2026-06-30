#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Wrapper installed at /usr/local/bin/hermes that enforces the runtime
# environment secret boundary for `hermes gateway` (NVIDIA/NemoClaw#4975) and
# masks credential-shaped values in `hermes config show` output.
#
# Source-of-truth note for the `config show` masking layer: the inline provider
# `api_key` placeholder `sk-OPENSHELL-PROXY-REWRITE` is emitted directly by the
# build-time config generator (`agents/hermes/config/hermes-config.ts:
# buildHermesConfig`) into `model`, `providers`, and `custom_providers`, and
# routed at sandbox startup by the seed pipeline
# (`agents/hermes/seed-dashboard-config.py:_route_api_key`) so the upstream
# Hermes CLI must render an `sk-`-prefixed value — the placeholder is later
# substituted at the OpenShell egress boundary, not in-process. A source-level
# fix would require Hermes CLI native env-var reference support (an upstream
# change). Until that lands, this wrapper post-filters `config show` stdout
# through the Python masker. Remove the `config show` branch and this comment
# once Hermes CLI redacts credential-shaped fields natively or `buildHermesConfig`
# stops emitting an inline `api_key` value.
#
# Dashboard parity: the Hermes dashboard is a static web UI seeded by
# `agents/hermes/seed-dashboard-config.py` — there is no `/api/config` REST
# surface that emits the resolved config, so the CLI is the only path that
# can leak `api_key`. If a dashboard config API ships later, mirror this
# masker on that route or assert the response masks the same fields.
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

_resolve_trusted_path() {
  for _candidate in "$@"; do
    if [ -x "$_candidate" ]; then
      printf '%s' "$_candidate"
      return 0
    fi
  done
  return 1
}

_resolve_trusted_python3() {
  _resolve_trusted_path /usr/bin/python3 /usr/local/bin/python3 /opt/hermes/.venv/bin/python3
}

if [ "${1:-}" = "config" ] && [ "${2:-}" = "show" ]; then
  set -o pipefail
  PYTHON3="$(_resolve_trusted_python3)" || {
    echo "[SECURITY] Refusing hermes config show: no python3 at a trusted absolute path to run the output masker" >&2
    exit 127
  }
  # mktemp and rm are resolved from trusted absolute paths so a PATH-shadowed
  # mktemp cannot redirect the raw stderr buffer to an attacker-chosen path and
  # a PATH-shadowed rm cannot retain the buffer past the EXIT trap. Same threat
  # model as the python3 resolver above.
  MKTEMP="$(_resolve_trusted_path /usr/bin/mktemp /bin/mktemp)" || {
    echo "[SECURITY] Refusing hermes config show: no mktemp at a trusted absolute path" >&2
    exit 127
  }
  RM="$(_resolve_trusted_path /bin/rm /usr/bin/rm)" || {
    echo "[SECURITY] Refusing hermes config show: no rm at a trusted absolute path" >&2
    exit 127
  }
  # Buffer Hermes stderr through an anonymous file descriptor so its masker's
  # exit status is observable. A process-substitution `2> >(... mask ...)`
  # cannot be checked via PIPESTATUS — Bash does not record the substituted
  # command's exit status — so a stderr-side masker that crashed or refused
  # unexpected input would silently fall back to whatever the substitution
  # wrote (which on failure is nothing, but the wrapper would also miss
  # observing the failure and return the Hermes status as if everything
  # succeeded). The buffer is created with mktemp, opened read-write on a
  # private FD, then unlinked immediately so the raw stderr bytes never live
  # at an observable filesystem path while Hermes is running — closing the
  # same-UID-process / shared-TMPDIR side channel. The masker reads the FD
  # via /proc/self/fd, which on Linux re-opens the same inode with a fresh
  # position-0 cursor. The masker itself buffers in memory and writes only
  # on success, so neither stream produces a partial secret.
  _stderr_buf="$("$MKTEMP")" || {
    echo "[SECURITY] Refusing hermes config show: cannot create stderr buffer" >&2
    exit 1
  }
  exec 9<>"$_stderr_buf"
  "$RM" -f "$_stderr_buf"
  _stderr_buf=""
  "$REAL_HERMES" "$@" 2>&9 | "$PYTHON3" "$GUARD" mask-config-output
  statuses=("${PIPESTATUS[@]}")
  hermes_status="${statuses[0]}"
  stdout_masker_status="${statuses[1]}"
  "$PYTHON3" "$GUARD" mask-config-output </proc/self/fd/9 >&2
  stderr_masker_status=$?
  exec 9>&-
  if [ "$stdout_masker_status" -ne 0 ]; then
    echo "[SECURITY] Refusing hermes config show: output masker failed (stdout)" >&2
    exit "$stdout_masker_status"
  fi
  if [ "$stderr_masker_status" -ne 0 ]; then
    echo "[SECURITY] Refusing hermes config show: output masker failed (stderr)" >&2
    exit "$stderr_masker_status"
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
