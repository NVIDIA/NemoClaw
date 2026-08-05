#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -Eeuo pipefail
umask 077

PROTOTYPE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROTOTYPE_ROOT
readonly PROTOTYPE_RUNTIME="${PROTOTYPE_RUNTIME:-standalone}"
readonly EVIDENCE_ROOT=/tmp/nemoclaw-hermes-switchyard
readonly PROVIDER_LOG="${EVIDENCE_ROOT}/provider.jsonl"
readonly RELAY_LOG="${EVIDENCE_ROOT}/relay.log"
readonly ATOF_LOG="${EVIDENCE_ROOT}/trajectory.atof.jsonl"
readonly BOUNDED_PROMPT="Summarize this bounded status in one sentence: 0 critical, 0 high, and 2 medium findings."
readonly CAPABLE_PROMPT="Design a fail-closed remediation plan for critical vulnerabilities across multiple services, including credential isolation, rollback, and end-to-end validation."
provider_pid=

case "${PROTOTYPE_RUNTIME}" in
  standalone | nemoclaw-managed) ;;
  *)
    echo "Unsupported prototype runtime: ${PROTOTYPE_RUNTIME}" >&2
    exit 1
    ;;
esac

if [[ "${PROTOTYPE_RUNTIME}" == "nemoclaw-managed" ]]; then
  readonly expected_relay_sha256="${PROTOTYPE_EXPECTED_RELAY_SHA256:-}"
  if [[ ! "${expected_relay_sha256}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Managed prototype requires an exact Relay SHA-256" >&2
    exit 1
  fi
  actual_relay_sha256="$(sha256sum "${PROTOTYPE_ROOT}/nemo-relay" | cut -d ' ' -f 1)"
  readonly actual_relay_sha256
  if [[ "${actual_relay_sha256}" != "${expected_relay_sha256}" ]]; then
    echo "Managed prototype Relay binary did not match the exported artifact" >&2
    exit 1
  fi
fi

cleanup() {
  if [[ -n "${provider_pid}" ]]; then
    kill "${provider_pid}" 2>/dev/null || true
    wait "${provider_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "${OPENAI_API_KEY:-}" != "nemoclaw-prototype-client-sentinel" ]]; then
  echo "Prototype refuses non-sentinel OPENAI_API_KEY input" >&2
  exit 1
fi
if [[ "${PROTOTYPE_PROVIDER_AUTHORIZATION:-}" != "Bearer nemoclaw-prototype-provider-sentinel" ]]; then
  echo "Prototype refuses non-sentinel provider credentials" >&2
  exit 1
fi

mkdir -p \
  "${EVIDENCE_ROOT}" \
  "${HERMES_HOME}" \
  "${HOME}" \
  "${XDG_CACHE_HOME}"
rm -f "${PROVIDER_LOG}" "${RELAY_LOG}" "${ATOF_LOG}"

python3 "${PROTOTYPE_ROOT}/fake-provider.py" \
  --port 4101 \
  --log "${PROVIDER_LOG}" &
provider_pid=$!

provider_ready=false
for _ in $(seq 1 100); do
  if python3 -c 'import socket; socket.create_connection(("127.0.0.1", 4101), 0.1).close()' \
    >/dev/null 2>&1; then
    provider_ready=true
    break
  fi
  sleep 0.05
done
if [[ "${provider_ready}" != "true" ]]; then
  echo "Prototype provider did not become ready" >&2
  exit 1
fi

export PROTOTYPE_HERMES_VERSION
export PROTOTYPE_RELAY_VERSION
PROTOTYPE_HERMES_VERSION="$(hermes --version)"
PROTOTYPE_RELAY_VERSION="$("${PROTOTYPE_ROOT}/nemo-relay" --version)"
if [[ "${PROTOTYPE_HERMES_VERSION}" != *"0.19.0"* ]]; then
  echo "Prototype requires Hermes 0.19.0, got ${PROTOTYPE_HERMES_VERSION}" >&2
  exit 1
fi

run_turn() {
  local turn_name="$1"
  local prompt="$2"
  local turn_relay_log="${EVIDENCE_ROOT}/relay-${turn_name}.log"
  local turn_atof_log="${EVIDENCE_ROOT}/trajectory-${turn_name}.atof.jsonl"

  if ! "${PROTOTYPE_ROOT}/nemo-relay" run \
    --agent hermes \
    --plugin-config-path "${PROTOTYPE_ROOT}/classifier-plugins.toml" \
    -- \
    chat \
    --provider custom \
    --model client/model \
    --query "${prompt}" \
    --quiet \
    --max-turns 1 \
    --ignore-rules \
    >"${turn_relay_log}" 2>&1; then
    python3 "${PROTOTYPE_ROOT}/verify.py" diagnose "${turn_relay_log}"
    exit 1
  fi
  cp "${ATOF_LOG}" "${turn_atof_log}"
}

run_turn bounded "${BOUNDED_PROMPT}"
run_turn capable "${CAPABLE_PROMPT}"

cat \
  "${EVIDENCE_ROOT}/relay-bounded.log" \
  "${EVIDENCE_ROOT}/relay-capable.log" \
  >"${RELAY_LOG}"
cat \
  "${EVIDENCE_ROOT}/trajectory-bounded.atof.jsonl" \
  "${EVIDENCE_ROOT}/trajectory-capable.atof.jsonl" \
  >"${EVIDENCE_ROOT}/trajectory-combined.atof.jsonl"
mv "${EVIDENCE_ROOT}/trajectory-combined.atof.jsonl" "${ATOF_LOG}"

python3 "${PROTOTYPE_ROOT}/verify.py" verify \
  --atof-log "${ATOF_LOG}" \
  --provider-log "${PROVIDER_LOG}" \
  --relay-binary "${PROTOTYPE_ROOT}/nemo-relay" \
  --relay-log "${RELAY_LOG}" \
  --runtime "${PROTOTYPE_RUNTIME}"
