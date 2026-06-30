#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Wrapper installed at /usr/local/bin/hermes that enforces the runtime
# environment secret boundary for `hermes gateway` (NVIDIA/NemoClaw#4975) and
# masks credential-shaped values in `hermes config show` output.
#
# Source-of-truth note for the `config show` masking layer.
#
# - Invalid state: the upstream Hermes CLI emits inline provider `api_key`
#   values verbatim when asked to print the resolved configuration, so a
#   user running `hermes config show` sees an `sk-`-prefixed string that
#   looks like a real credential.
# - Value being masked: the literal placeholder `sk-OPENSHELL-PROXY-REWRITE`
#   hard-coded by `agents/hermes/config/hermes-config.ts:buildHermesConfig`
#   for the `model`, `providers`, and `custom_providers` `api_key` fields.
#   The user's real provider credential is never written into the rendered
#   config: requests carrying the placeholder are rewritten at the OpenShell
#   egress boundary, and the `sk-`-prefix exists only to satisfy LiteLLM's
#   input validation in the upstream Hermes runtime. The masker therefore
#   protects against the cosmetic appearance of a credential leak (#5981),
#   not the leak of a real secret — even an unfiltered raw stream contains
#   only a constant placeholder string.
# - Source boundary: see `buildHermesConfig` and the seed-time routing in
#   `agents/hermes/seed-dashboard-config.py:_route_api_key`.
# - Source-fix constraint: removing the inline `api_key` would require
#   either Hermes CLI native env-var reference support (an upstream change)
#   or a redesigned dashboard/runtime contract that no longer needs an
#   `sk-`-prefixed placeholder in the rendered config.
# - Regression test: see `test/hermes-gateway-wrapper.test.ts` —
#   `masks every api_key emitted by buildHermesConfig ...` derives a fixture
#   from `buildHermesConfig()` and asserts no raw placeholder survives in
#   stdout for `config show`.
# - Removal condition: delete this `config show` branch when Hermes CLI
#   redacts credential-shaped fields natively or `buildHermesConfig` stops
#   emitting an inline `api_key` value.
#
# Scope note: this masker covers `hermes config show` stdout/stderr. The
# contract is intentionally narrow:
#   - It masks recognised key-labelled secret fields (`api_key`, `api_secret`,
#     `access_token`, `auth_token`, `client_secret`, `secret_key`, `secret`,
#     `token`, `password`, `bearer`, `authorization`, `credential`, plus their
#     hyphen/underscore/camelCase variants) in Python-dict, JSON, YAML, env-
#     style, and YAML block-scalar shapes.
#   - It does NOT redact arbitrary credential-shaped strings appearing in
#     free-form prose diagnostics. Hermes' rendered config is structured
#     (key: value) — covering the structured shapes is sufficient for the
#     reported `#5981` leak path. Diagnostic prose escape hatches require an
#     upstream Hermes fix, not a wrapper one.
# The Hermes dashboard is upstream-managed (Hermes' own HTTP surface); per the
# linked report the dashboard already omits provider credentials. NemoClaw
# vends the dashboard config through `agents/hermes/seed-dashboard-config.py`
# without exposing a resolved-config REST surface in this repo (grep for
# `/api/config` returns nothing). If a future NemoClaw-side resolved-config
# route is added, mirror this masker on that route.
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

# Hard-require Bash 4+. The `config show` branch uses array indexing on
# PIPESTATUS, the `coproc` builtin, named-FD allocation, and the BASH_SOURCE
# array — all features that older shells silently mis-parse, breaking the
# fail-closed status check and the in-memory stderr pipe. The NemoClaw
# sandbox image pins Bash 5+; assert the floor so a downgraded interpreter
# cannot bypass the masker.
if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
  echo "[SECURITY] Refusing hermes wrapper: bash >= 4 required (PIPESTATUS array, coproc, BASH_SOURCE), found ${BASH_VERSION:-unknown}" >&2
  exit 127
fi

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
  # masker reads them. The race is bounded: the raw stream contains only
  # the constant placeholder `sk-OPENSHELL-PROXY-REWRITE` (see the
  # source-of-truth note above), never a user-provided credential — so a
  # successful race yields a public placeholder string, not a secret.
  # Closing the side channel entirely would require sandbox-level procfs
  # isolation (hidepid mount or a PID namespace) outside this wrapper, or
  # the upstream Hermes CLI redacting the field natively.
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
