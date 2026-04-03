#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: inside sandbox, https://inference.local responds (HTTP 200).
# Pattern aligned with test-full-e2e.sh (ssh via openshell sandbox ssh-config).

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-experimental}}"

die() {
  printf '%s\n' "02-inference-local-http: FAIL: $*" >&2
  exit 1
}

ssh_config="$(mktemp)"
trap 'rm -f "$ssh_config"' EXIT

openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null \
  || die "openshell sandbox ssh-config failed for '${SANDBOX_NAME}'"

TIMEOUT_CMD=""
command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD="timeout 90"
command -v gtimeout >/dev/null 2>&1 && TIMEOUT_CMD="gtimeout 90"

# GET /v1/models — lightweight 200 check (no API key in curl; gateway routes inference)
ssh_host="openshell-${SANDBOX_NAME}"
curl_inner='curl -sS -o /dev/null -w "%{http_code}" --max-time 60 https://inference.local/v1/models'

set +e
# stderr from ssh can include host-key noise; curl -w code should be the only stdout line
http_code=$(
  $TIMEOUT_CMD ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "$ssh_host" \
    "$curl_inner" 2>/dev/null
)
ssh_rc=$?
set -e
http_code="$(echo "$http_code" | tr -d '\r' | tail -n 1)"

[ "$ssh_rc" -eq 0 ] || die "ssh/curl failed (exit $ssh_rc): ${http_code:0:200}"
[ "$http_code" = "200" ] || die "expected HTTP 200 from https://inference.local/v1/models, got '${http_code}'"

printf '%s\n' "02-inference-local-http: OK (HTTP 200 on /v1/models)"
exit 0
