#!/bin/bash -p
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Environment guards for every managed Deep Agents Code entry point.

set -euo pipefail
unset BASH_ENV ENV
while IFS= read -r _nemoclaw_auto_approval_env; do
  unset "$_nemoclaw_auto_approval_env"
done < <(compgen -A variable NEMOCLAW_DCODE_AUTO_APPROVAL || true)
unset _nemoclaw_auto_approval_env

readonly MANAGED_DCODE_WRAPPER="/usr/local/lib/nemoclaw/dcode-wrapper.sh"
readonly MANAGED_EXEC_LAUNCHER="/usr/local/lib/nemoclaw/dcode-managed-exec"
readonly MANAGED_OBSERVABILITY_MARKER="/sandbox/.deepagents/.nemoclaw-observability-enabled"
readonly MANAGED_FETCH_CA_BUNDLE_FILE="/etc/openshell-tls/ca-bundle.pem"
readonly MANAGED_SESSION_SUPERVISOR="/usr/local/lib/nemoclaw/dcode-session-supervisor.py"
export HOME=/sandbox
export PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"

# Raw OpenShell exec processes do not inherit the long-running entrypoint's
# lowered limits or source shell startup hooks. Apply the same image-baked
# resource contract before the managed wrapper or diagnostic command runs.
_NEMOCLAW_SANDBOX_RLIMITS="/usr/local/lib/nemoclaw/sandbox-rlimits.sh"
if [ ! -f "$_NEMOCLAW_SANDBOX_RLIMITS" ]; then
  _NEMOCLAW_SANDBOX_RLIMITS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../scripts/lib/sandbox-rlimits.sh"
fi
if [ ! -f "$_NEMOCLAW_SANDBOX_RLIMITS" ]; then
  printf '%s\n' '[SECURITY] Required sandbox-rlimits.sh is missing; refusing to launch dcode unhardened.' >&2
  exit 1
fi
# shellcheck source=scripts/lib/sandbox-rlimits.sh
. "$_NEMOCLAW_SANDBOX_RLIMITS"
# shellcheck disable=SC2119 # optional $1 selects quiet mode, not launcher args.
harden_resource_limits
# shellcheck disable=SC2119 # optional $1 selects quiet mode, not launcher args.
if ! verify_resource_limits_exact; then
  printf '%s\n' '[SECURITY] Effective sandbox resource limits do not match policy; refusing to launch dcode unhardened.' >&2
  exit 1
fi
unset _NEMOCLAW_SANDBOX_RLIMITS

# Invalid state: raw OpenShell exec processes do not inherit the sandbox
# entrypoint's environment, so an opted-in direct dcode exec can lose tracing.
# Source boundary: start.sh materializes only the credential-free enable bit;
# this launcher recovers it only from a regular, non-symlink marker.
# Source-fix constraint: NemoClaw cannot make OpenShell preserve entrypoint env,
# and policy-only reloads clear /tmp without re-running the entrypoint. Keep the
# reconstructable bit in the sandbox workspace so those reloads retain it.
# Regression: the proxy-launcher tests cover exact values and unsafe file types.
# Removal condition: OpenShell propagates the bit to every exec/login process
# and preserves it across policy reloads or re-runs the entrypoint afterward.
# The marker is convenience state, not an authorization boundary; the
# host-selected network policy controls whether local OTLP egress exists.
unset NEMOCLAW_OBSERVABILITY
if [ -f "$MANAGED_OBSERVABILITY_MARKER" ] \
  && [ ! -L "$MANAGED_OBSERVABILITY_MARKER" ] \
  && [ "$(<"$MANAGED_OBSERVABILITY_MARKER")" = "1" ]; then
  export NEMOCLAW_OBSERVABILITY=1
fi

readonly MANAGED_CA_OWNER_UID=0

managed_fetch_ca_bundle_metadata() {
  local file="$1"
  local metadata
  if metadata="$(stat -c '%u:%a:%s' "$file" 2>/dev/null)"; then
    printf '%s' "$metadata"
  else
    stat -f '%u:%Lp:%z' "$file" 2>/dev/null
  fi
}

validate_managed_fetch_ca_bundle() {
  local file="$MANAGED_FETCH_CA_BUNDLE_FILE"
  local metadata owner mode size extra
  if [ -L "$file" ]; then
    printf '%s\n' 'Missing or unsafe managed fetch CA bundle file.' >&2
    return 1
  fi
  [ -e "$file" ] || return 0
  if [ ! -f "$file" ] || [ ! -r "$file" ]; then
    printf '%s\n' 'Missing or unsafe managed fetch CA bundle file.' >&2
    return 1
  fi
  metadata="$(managed_fetch_ca_bundle_metadata "$file")" || {
    printf '%s\n' 'Cannot inspect managed fetch CA bundle file.' >&2
    return 1
  }
  IFS=: read -r owner mode size extra <<<"$metadata"
  if [ -n "${extra:-}" ] \
    || [[ ! "$owner" =~ ^[0-9]+$ ]] \
    || [[ ! "$mode" =~ ^[0-7]{3,4}$ ]] \
    || [[ ! "$size" =~ ^[0-9]+$ ]] \
    || [ "$owner" != "$MANAGED_CA_OWNER_UID" ] \
    || [ "$size" -le 0 ] \
    || (((8#$mode & 0022) != 0)); then
    printf '%s\n' 'Unsafe ownership or mode on managed fetch CA bundle file.' >&2
    return 1
  fi
}

validate_managed_fetch_ca_bundle
# OpenShell 0.1.3 mediates sockets and DNS. Ambient proxies must not replace that route.
unset HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy
unset ALL_PROXY all_proxy OPENAI_PROXY grpc_proxy GRPC_PROXY NODE_USE_ENV_PROXY
unset NEMOCLAW_PROXY_HOST NEMOCLAW_PROXY_PORT DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL

# Diagnostics need this launcher's environment guards and optional
# observability bit, but must not invoke the stateful sandbox entrypoint. Keep
# the mode bound to a separate root-owned regular-file install so older images
# fail before launching anything, then exact-exec without shell evaluation.
if [ "$0" = "$MANAGED_EXEC_LAUNCHER" ]; then
  if [ "$#" -eq 0 ]; then
    printf '%s\n' 'dcode-managed-exec requires a command.' >&2
    exit 64
  fi
  # Invalid state: OpenShell can preserve auxiliary descriptors from its
  # transport, but route-probe evidence must travel only on stdout/stderr.
  # Close the legacy descriptor before the managed command starts so sandbox
  # startup code cannot reuse the former fd 3 probe channel (#7031).
  exec 3>&-
  exec "$@"
fi

# Read-only managed identity commands never start DCode or LangGraph children.
# Keep onboard's live-route validation on the established wrapper path while
# supervising every command that can create a terminal-agent process tree.
case "${1:-}" in
  status | whoami | identity | --version | -v | -V) exec "$MANAGED_DCODE_WRAPPER" "$@" ;;
esac

exec /opt/venv/bin/python3 -I "$MANAGED_SESSION_SUPERVISOR" "$MANAGED_DCODE_WRAPPER" "$@"
