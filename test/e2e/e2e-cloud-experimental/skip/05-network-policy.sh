#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: network policy — declared YAML (VDR3 #6) + enforced egress inside sandbox (VDR3 #15).
#
# A) Host: openshell policy get --full — Version header, network_policies, npm/pypi hosts
#    (expects NEMOCLAW_POLICY_MODE=custom + npm,pypi presets from suite defaults).
# B) Sandbox over SSH: whitelist HTTPS 2xx/3xx for github / pypi / npm registry;
#    blocked probe on E2E_CLOUD_EXPERIMENTAL_EGRESS_BLOCKED_URL (legacy: SCENARIO_A_EGRESS_BLOCKED_URL).

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-experimental}}"
BLOCKED_URL="${E2E_CLOUD_EXPERIMENTAL_EGRESS_BLOCKED_URL:-${SCENARIO_A_EGRESS_BLOCKED_URL:-https://example.com/}}"

die() {
  printf '%s\n' "05-network-policy: FAIL: $*" >&2
  exit 1
}

curl_exit_hint() {
  case "${1:-}" in
    6) printf '%s' "curl 6 = could not resolve host (DNS)." ;;
    7) printf '%s' "curl 7 = failed to connect (blocked by policy, down, or wrong port)." ;;
    28) printf '%s' "curl 28 = operation timed out (often policy drop or slow path)." ;;
    35) printf '%s' "curl 35 = SSL connect error." ;;
    56) printf '%s' "curl 56 = network receive error (TLS reset, proxy/gateway closed connection, etc.)." ;;
    60) printf '%s' "curl 60 = peer certificate cannot be authenticated." ;;
    *) printf '%s' "curl exit $1 — see \`man curl\` EXIT CODES." ;;
  esac
}

# ── A) Policy YAML on host ───────────────────────────────────────────
set +e
policy_output=$(openshell policy get --full "$SANDBOX_NAME" 2>&1)
pg_rc=$?
set -e
[ "$pg_rc" -eq 0 ] || die "policy-yaml: openshell policy get --full failed (exit $pg_rc): ${policy_output:0:240}"

case "$policy_output" in
  *---*) ;;
  *) die "policy-yaml: expected '---' between metadata and YAML body" ;;
esac

header="${policy_output%%---*}"
echo "$header" | grep -qi "version" \
  || die "policy-yaml: metadata header missing Version (text before first ---)"

echo "$policy_output" | grep -qi "network_policies" \
  || die "policy-yaml: body missing network_policies"

echo "$policy_output" | grep -qi "registry.npmjs.org" \
  || die "policy-yaml: body missing registry.npmjs.org (npm preset)"
echo "$policy_output" | grep -qi "pypi.org" \
  || die "policy-yaml: body missing pypi.org (pypi preset)"

printf '%s\n' "05-network-policy: policy-yaml OK"

# ── B) Egress inside sandbox (SSH) ────────────────────────────────────
ssh_config="$(mktemp)"
wl_log="$(mktemp)"
bl_log="$(mktemp)"
trap 'rm -f "$ssh_config" "$wl_log" "$bl_log"' EXIT

openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null \
  || die "egress: openshell sandbox ssh-config failed for '${SANDBOX_NAME}'"

TIMEOUT_CMD=""
command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD="timeout 120"
command -v gtimeout >/dev/null 2>&1 && TIMEOUT_CMD="gtimeout 120"

ssh_host="openshell-${SANDBOX_NAME}"
ssh_base=(ssh -F "$ssh_config"
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o ConnectTimeout=10
  -o LogLevel=ERROR
)

set +e
$TIMEOUT_CMD "${ssh_base[@]}" "$ssh_host" bash -s <<'REMOTE' >"$wl_log" 2>&1
set -uo pipefail
for url in https://github.com/ https://pypi.org/ https://registry.npmjs.org/; do
  efile=$(mktemp)
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 60 "$url" 2>"$efile")
  cr=$?
  err=$(head -c 800 "$efile" | tr '\n' ' ')
  rm -f "$efile"
  code=$(printf '%s' "$code" | tr -d '\r' | tail -n 1)
  if [ "$cr" -ne 0 ]; then
    echo "whitelist: curl transport error for ${url}"
    echo "  curl_exit=${cr}"
    echo "  http_code_written=${code:-<empty>}"
    echo "  curl_stderr=${err}"
    exit "$cr"
  fi
  case "$code" in
    2??|3??) ;;
    *)
      echo "whitelist: unexpected HTTP status for ${url}"
      echo "  http_code=${code}"
      exit 1
      ;;
  esac
done
exit 0
REMOTE
wl_rc=$?
set -e
if [ "$wl_rc" -ne 0 ]; then
  hint=$(curl_exit_hint "$wl_rc")
  die "egress whitelist (github / pypi / npm registry) failed.

  ssh/remote exit: ${wl_rc}
  hint: ${hint}

  --- output from sandbox (last 60 lines) ---
$(sed 's/^/  /' "$wl_log" | tail -n 60)
  ---"
fi

set +e
$TIMEOUT_CMD "${ssh_base[@]}" "$ssh_host" bash -s -- "$BLOCKED_URL" <<'REMOTE' >"$bl_log" 2>&1
set -uo pipefail
url=$1
if curl -f -sS -o /dev/null --max-time 30 "$url"; then
  echo "expected blocked URL to fail curl, but it succeeded"
  exit 1
fi
exit 0
REMOTE
bl_rc=$?
set -e
if [ "$bl_rc" -ne 0 ]; then
  die "egress blocked check failed for '${BLOCKED_URL}' (expected curl failure; exit ${bl_rc}).

  --- output from sandbox (last 40 lines) ---
$(sed 's/^/  /' "$bl_log" | tail -n 40)
  ---"
fi

printf '%s\n' "05-network-policy: OK (policy-yaml + whitelist + blocked URL)"
exit 0
