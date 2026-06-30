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

_self_src="${BASH_SOURCE[0]:-$0}"
_self_parent="${_self_src%/*}"
if [ "$_self_parent" = "$_self_src" ]; then
  _self_parent="."
fi
_self_dir="$(cd "$_self_parent" && pwd)"

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
  # Stream Hermes stderr through a bash coprocess so the raw bytes live only
  # in a kernel pipe — no temp file under TMPDIR, no procfs-visible inode for
  # cross-namespace observers, and no process-substitution PID that
  # PIPESTATUS would silently drop. The coprocess runs the same Python
  # masker as the stdout pipeline. After Hermes exits, we close the write
  # end of the stderr pipe so the masker sees EOF, then `wait` for it and
  # capture its exit status. The masker itself buffers in memory and writes
  # only on success, so a mid-stream crash never produces a partial secret
  # on either stream.
  #
  # Residual surface: a same-UID process inside the sandbox can in principle
  # open the pipe FDs via /proc/<pid>/fd and race-read raw bytes before the
  # masker reads them. Closing that surface requires sandbox-level procfs
  # isolation (hidepid mount or a PID namespace), which is the OpenShell
  # sandbox's responsibility and lives outside this wrapper. The source-
  # level fix (Hermes CLI native env-var references) would eliminate the
  # raw value upstream entirely.
  coproc STDERR_MASK { "$PYTHON3" "$GUARD" mask-config-output >&2; }
  _stderr_mask_pid=$STDERR_MASK_PID
  # shellcheck disable=SC2086  # bash redirect targets cannot be quoted; quoting forces filename semantics
  exec 9>&${STDERR_MASK[1]}
  eval "exec ${STDERR_MASK[1]}>&-"
  eval "exec ${STDERR_MASK[0]}<&-"
  "$REAL_HERMES" "$@" 2>&9 | "$PYTHON3" "$GUARD" mask-config-output
  statuses=("${PIPESTATUS[@]}")
  hermes_status="${statuses[0]}"
  stdout_masker_status="${statuses[1]}"
  exec 9>&-
  wait "$_stderr_mask_pid"
  stderr_masker_status=$?
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
