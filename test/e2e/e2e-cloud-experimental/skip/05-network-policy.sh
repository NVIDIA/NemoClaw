#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: network policy — declared YAML (VDR3 #6) + enforced egress inside sandbox (VDR3 #15).
#
# A) Host: openshell policy get --full — Version header, network_policies, npm/pypi hosts
#    (expects NEMOCLAW_POLICY_MODE=custom + npm,pypi presets from suite defaults).
# B) Sandbox over SSH: outlook / Docker Hub (optional curl, commented by default); pypi: venv + pip download;
#    npm: npm ping + npm view; huggingface: venv + pip install huggingface_hub + hf|huggingface-cli download
#    tiny public config.json (hub + CDN as allowed by preset). Then blocked URL probe.
#    Default: curl uses sandbox HTTPS_PROXY / env (matches pip/npm when traffic goes via proxy).
#    NEMOCLAW_E2E_CURL_NOPROXY=1: add curl --noproxy '*' (direct TLS; use if CONNECT via proxy returns 403).
#    NEMOCLAW_E2E_SKIP_NETWORK_POLICY_HUGGINGFACE=1: skip venv + huggingface_hub + hf download (~5m); still runs pypi + npm + blocked probe.
#
# Vitest (same checks): NEMOCLAW_E2E_NETWORK_POLICY=1 npx vitest run --project network-policy-cli
#
# run_whitelist_egress / curl_exit_hint are optional (outlook/docker curl cases commented out below).
# shellcheck disable=SC2329

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-experimental}}"
BLOCKED_URL="${E2E_CLOUD_EXPERIMENTAL_EGRESS_BLOCKED_URL:-${SCENARIO_A_EGRESS_BLOCKED_URL:-https://example.com/}}"
USE_NOPROXY="${NEMOCLAW_E2E_CURL_NOPROXY:-0}"
SKIP_HUGGINGFACE="${NEMOCLAW_E2E_SKIP_NETWORK_POLICY_HUGGINGFACE:-1}"

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
    56) printf '%s' "curl 56 = network receive error (TLS reset, proxy CONNECT rejected, etc.)." ;;
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
bl_log="$(mktemp)"
trap 'rm -f "$ssh_config" "$bl_log"' EXIT

openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null \
  || die "egress: openshell sandbox ssh-config failed for '${SANDBOX_NAME}'"

TIMEOUT_CMD=""
TIMEOUT_CMD_LONG=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout 180"
  TIMEOUT_CMD_LONG="timeout 300"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout 180"
  TIMEOUT_CMD_LONG="gtimeout 300"
fi
if [[ -z "$TIMEOUT_CMD" ]]; then
  printf '%s\n' "05-network-policy: WARN: no timeout/gtimeout on PATH — each SSH egress step may hang indefinitely (brew install coreutils for gtimeout)." >&2
  TIMEOUT_CMD_LONG=""
fi

ssh_host="openshell-${SANDBOX_NAME}"
ssh_base=(ssh -F "$ssh_config"
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o ConnectTimeout=10
  -o LogLevel=ERROR
)

run_whitelist_egress() {
  local case_name=$1
  local url=$2
  local wl_log
  printf '%s\n' "05-network-policy: egress running: ${case_name} (curl ${url})"
  wl_log=$(mktemp)
  set +e
  $TIMEOUT_CMD "${ssh_base[@]}" "$ssh_host" bash -s -- "$url" "$USE_NOPROXY" <<'REMOTE' >"$wl_log" 2>&1
set -uo pipefail
url=$1
np=$2
efile=$(mktemp)
if [ "$np" = "1" ]; then
  code=$(curl --noproxy '*' -sS -o /dev/null -w "%{http_code}" --max-time 60 "$url" 2>"$efile")
else
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 60 "$url" 2>"$efile")
fi
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
exit 0
REMOTE
  local wl_rc=$?
  set -e
  if [ "$wl_rc" -ne 0 ]; then
    hint=$(curl_exit_hint "$wl_rc")
    tail_out=$(sed 's/^/  /' "$wl_log" | tail -n 60)
    rm -f "$wl_log"
    die "egress whitelist case '${case_name}' (${url}) failed.

  ssh/remote exit: ${wl_rc}
  hint: ${hint}

  --- output from sandbox (last 60 lines) ---
${tail_out}
  ---"
  fi
  rm -f "$wl_log"
  printf '%s\n' "05-network-policy: egress whitelist OK (${case_name})"
}

run_whitelist_pypi_via_venv() {
  local case_name="pypi"
  local wl_log
  printf '%s\n' "05-network-policy: egress running: ${case_name} (venv + pip download)"
  wl_log=$(mktemp)
  set +e
  $TIMEOUT_CMD "${ssh_base[@]}" "$ssh_host" bash -s -- "$USE_NOPROXY" <<'REMOTE' >"$wl_log" 2>&1
set -uo pipefail
np=$1
VENVD=$(mktemp -d)
PROBE_DL=$(mktemp -d)
cleanup() { rm -rf "$VENVD" "$PROBE_DL"; }
trap cleanup EXIT
if ! command -v python3 >/dev/null 2>&1; then
  echo "pypi whitelist: python3 not on PATH"
  exit 1
fi
if ! python3 -m venv "$VENVD" 2>/dev/null; then
  echo "pypi whitelist: python3 -m venv failed (need python3-venv / ensure-virtualenv package?)"
  exit 1
fi
# shellcheck disable=SC1091
. "$VENVD/bin/activate"
if [ "$np" = "1" ]; then
  export NO_PROXY='*'
  unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy || true
fi
if ! python -m pip download --no-deps --disable-pip-version-check -d "$PROBE_DL" --timeout 90 idna==3.7; then
  echo "pypi whitelist: pip download idna==3.7 from PyPI failed (egress / proxy / policy)"
  exit 1
fi
exit 0
REMOTE
  local wl_rc=$?
  set -e
  if [ "$wl_rc" -ne 0 ]; then
    tail_out=$(sed 's/^/  /' "$wl_log" | tail -n 60)
    rm -f "$wl_log"
    die "egress whitelist case '${case_name}' (venv + pip download from PyPI) failed.

  ssh/remote exit: ${wl_rc}

  --- output from sandbox (last 60 lines) ---
${tail_out}
  ---"
  fi
  rm -f "$wl_log"
  printf '%s\n' "05-network-policy: egress whitelist OK (${case_name})"
}

run_whitelist_npm_via_cli() {
  local case_name="npm registry"
  local wl_log
  printf '%s\n' "05-network-policy: egress running: ${case_name} (npm ping + npm view — lighter than pack/install)"
  wl_log=$(mktemp)
  set +e
  $TIMEOUT_CMD "${ssh_base[@]}" "$ssh_host" bash -s -- "$USE_NOPROXY" <<'REMOTE' >"$wl_log" 2>&1
set -uo pipefail
np=$1
WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
cd "$WORK"
export CI=true
export NODE_NO_WARNINGS=1
export npm_config_progress=false
export npm_config_loglevel=error
export npm_config_fetch_timeout=120000
export npm_config_fetch_retries=2
if [ "$np" = "1" ]; then
  export NO_PROXY='*'
  unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy || true
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm whitelist: npm not on PATH"
  exit 1
fi
# npm ping: minimal registry round-trip (avoids tarball download / long hangs vs npm pack).
echo "npm whitelist: npm ping..."
if ! npm ping --silent 2>/dev/null; then
  if ! npm ping; then
    echo "npm whitelist: npm ping failed (egress / proxy / policy)"
    exit 1
  fi
fi
echo "npm whitelist: npm view is-odd@3.0.1 (metadata)..."
if ! npm view is-odd@3.0.1 version --silent 2>/dev/null; then
  if ! npm view is-odd@3.0.1 version; then
    echo "npm whitelist: npm view is-odd@3.0.1 failed"
    exit 1
  fi
fi
echo "npm whitelist: OK"
exit 0
REMOTE
  local wl_rc=$?
  set -e
  if [ "$wl_rc" -ne 0 ]; then
    tail_out=$(sed 's/^/  /' "$wl_log" | tail -n 60)
    rm -f "$wl_log"
    die "egress whitelist case '${case_name}' (npm ping / npm view) failed.

  ssh/remote exit: ${wl_rc}

  --- output from sandbox (last 60 lines) ---
${tail_out}
  ---"
  fi
  rm -f "$wl_log"
  printf '%s\n' "05-network-policy: egress whitelist OK (${case_name})"
}

run_whitelist_huggingface_via_cli() {
  local case_name="huggingface"
  local wl_log
  local tcmd="${TIMEOUT_CMD_LONG:-$TIMEOUT_CMD}"
  printf '%s\n' "05-network-policy: egress running: ${case_name} (venv + pip huggingface_hub + hf download tiny config.json — up to ~5m)"
  wl_log=$(mktemp)
  set +e
  $tcmd "${ssh_base[@]}" "$ssh_host" bash -s -- "$USE_NOPROXY" <<'REMOTE' >"$wl_log" 2>&1
set -uo pipefail
np=$1
VENVD=$(mktemp -d)
DL=$(mktemp -d)
cleanup() { rm -rf "$VENVD" "$DL"; }
trap cleanup EXIT
export HF_HUB_DISABLE_PROGRESS_BARS=1
export HF_HUB_DISABLE_TELEMETRY=1
if ! command -v python3 >/dev/null 2>&1; then
  echo "huggingface whitelist: python3 not on PATH"
  exit 1
fi
if ! python3 -m venv "$VENVD" 2>/dev/null; then
  echo "huggingface whitelist: python3 -m venv failed (need python3-venv?)"
  exit 1
fi
# shellcheck disable=SC1091
. "$VENVD/bin/activate"
if [ "$np" = "1" ]; then
  export NO_PROXY='*'
  unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy || true
fi
echo "huggingface whitelist: pip install huggingface_hub..."
if ! python -m pip install --disable-pip-version-check --timeout 120 "huggingface_hub>=0.23.0,<1"; then
  echo "huggingface whitelist: pip install huggingface_hub failed (PyPI / proxy / policy)"
  exit 1
fi
REPO="hf-internal-testing/tiny-random-bert"
echo "huggingface whitelist: download ${REPO} config.json..."
if command -v hf >/dev/null 2>&1; then
  if ! hf download "$REPO" config.json --local-dir "$DL"; then
    echo "huggingface whitelist: hf download failed"
    exit 1
  fi
elif command -v huggingface-cli >/dev/null 2>&1; then
  if ! huggingface-cli download "$REPO" config.json --local-dir "$DL"; then
    echo "huggingface whitelist: huggingface-cli download failed"
    exit 1
  fi
else
  if ! python -c "from huggingface_hub import hf_hub_download; hf_hub_download(repo_id=\"${REPO}\", filename=\"config.json\", local_dir=\"${DL}\")"; then
    echo "huggingface whitelist: hf_hub_download (python) failed"
    exit 1
  fi
fi
if [ ! -f "$DL/config.json" ]; then
  echo "huggingface whitelist: config.json not present under ${DL}"
  exit 1
fi
echo "huggingface whitelist: OK"
exit 0
REMOTE
  local wl_rc=$?
  set -e
  if [ "$wl_rc" -ne 0 ]; then
    tail_out=$(sed 's/^/  /' "$wl_log" | tail -n 60)
    rm -f "$wl_log"
    die "egress whitelist case '${case_name}' (venv + huggingface_hub + hub download) failed.

  ssh/remote exit: ${wl_rc}

  --- output from sandbox (last 60 lines) ---
${tail_out}
  ---"
  fi
  rm -f "$wl_log"
  printf '%s\n' "05-network-policy: egress whitelist OK (${case_name})"
}

# run_whitelist_egress "outlook" "https://outlook.com/"
# run_whitelist_egress "docker hub" "https://hub.docker.com/"
run_whitelist_pypi_via_venv
run_whitelist_npm_via_cli
if [[ "$SKIP_HUGGINGFACE" == "1" ]]; then
  printf '%s\n' "05-network-policy: SKIP huggingface whitelist (NEMOCLAW_E2E_SKIP_NETWORK_POLICY_HUGGINGFACE=1)"
else
  run_whitelist_huggingface_via_cli
fi

printf '%s\n' "05-network-policy: egress running: blocked URL probe (${BLOCKED_URL})"
set +e
$TIMEOUT_CMD "${ssh_base[@]}" "$ssh_host" bash -s -- "$BLOCKED_URL" "$USE_NOPROXY" <<'REMOTE' >"$bl_log" 2>&1
set -uo pipefail
url=$1
np=$2
if [ "$np" = "1" ]; then
  if curl --noproxy '*' -f -sS -o /dev/null --max-time 30 "$url"; then
    echo "expected blocked URL to fail curl, but it succeeded"
    exit 1
  fi
else
  if curl -f -sS -o /dev/null --max-time 30 "$url"; then
    echo "expected blocked URL to fail curl, but it succeeded"
    exit 1
  fi
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

if [[ "$SKIP_HUGGINGFACE" == "1" ]]; then
  printf '%s\n' "05-network-policy: OK (policy-yaml + pypi + npm + blocked URL; huggingface skipped)"
else
  printf '%s\n' "05-network-policy: OK (policy-yaml + pypi + npm + huggingface whitelist + blocked URL)"
fi
exit 0
