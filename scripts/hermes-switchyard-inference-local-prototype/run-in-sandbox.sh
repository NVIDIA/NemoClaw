#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly PROVIDER="${NEMOCLAW_SWITCHYARD_FAKE_PROVIDER:-/usr/local/lib/nemoclaw/switchyard-native-fake-provider.py}"
readonly PROVIDER_LOG="/tmp/nemoclaw-switchyard-inference-local-classifier.jsonl"
readonly PROVIDER_STDERR="/tmp/nemoclaw-switchyard-inference-local-classifier.log"
readonly FAST_RESPONSE="/tmp/nemoclaw-switchyard-inference-local-fast.json"
readonly QUALITY_RESPONSE="/tmp/nemoclaw-switchyard-inference-local-quality.json"
readonly AUTH_PROBE_RESPONSE="/tmp/nemoclaw-switchyard-inference-local-auth-probe.json"
readonly BOUNDED_PROMPT="Summarize this bounded status in one sentence: 0 critical, 0 high, and 2 medium findings."
readonly CAPABLE_PROMPT="Design a fail-closed remediation plan for critical vulnerabilities across multiple services, including credential isolation, rollback, and end-to-end validation."

provider_pid=""
cleanup() {
  if [[ -n "${provider_pid}" ]]; then
    kill "${provider_pid}" 2>/dev/null || true
    wait "${provider_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

gateway_pid() {
  python3 - <<'PY'
from pathlib import Path

matches = []
for process in Path("/proc").iterdir():
    if not process.name.isdigit():
        continue
    try:
        command = (process / "cmdline").read_bytes().replace(b"\0", b" ").decode()
    except OSError:
        continue
    if "hermes" in command and "gateway" in command and "run" in command:
        matches.append(int(process.name))
if len(matches) != 1:
    raise SystemExit(f"expected one supervised Hermes gateway, found {matches}")
print(matches[0])
PY
}

relay_sidecars() {
  pgrep -af '(^|/)(nemo-relay)( |$)|switchyard-server' || true
}

raw_provider_credentials_present() {
  local compatible_value="${COMPATIBLE_API_KEY:-}"
  if [[ ! "${compatible_value}" =~ ^openshell:resolve:env:(v[0-9]{1,20}_)?COMPATIBLE_API_KEY$ ]]; then
    printf '%s\n' COMPATIBLE_API_KEY
  fi
  env | cut -d= -f1 | grep -E '^(NVIDIA_API_KEY|NVIDIA_INFERENCE_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY)$' || true
}

test -x "${PROVIDER}"
test -s /usr/local/lib/nemoclaw/switchyard-relay-plugin/relay-plugin.toml
grep -Fq 'id = "nvidia.switchyard"' /usr/local/lib/nemoclaw/switchyard-relay-plugin/relay-plugin.toml
grep -Fq 'native_api = "1"' /usr/local/lib/nemoclaw/switchyard-relay-plugin/relay-plugin.toml
grep -Fq 'base_url = "https://inference.local"' /usr/local/lib/nemoclaw/switchyard-relay-plugin/plugins.toml
if grep -Eiq 'header_env|authorization|api[_-]?key|secret' \
  /usr/local/lib/nemoclaw/switchyard-relay-plugin/plugins.toml; then
  echo "prototype plugin configuration contains a credential input" >&2
  exit 1
fi

curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8642/health >/dev/null
gateway_pid_before="$(gateway_pid)"
sidecars_before="$(relay_sidecars)"
credential_names="$(raw_provider_credentials_present)"
[[ -z "${sidecars_before}" ]]
[[ -z "${credential_names}" ]]

rm -f "${PROVIDER_LOG}" "${PROVIDER_STDERR}" "${FAST_RESPONSE}" "${QUALITY_RESPONSE}" \
  "${AUTH_PROBE_RESPONSE}"
python3 "${PROVIDER}" --port 4101 --log "${PROVIDER_LOG}" >"${PROVIDER_STDERR}" 2>&1 &
provider_pid=$!

for _attempt in $(seq 1 50); do
  if curl --fail --silent --show-error --max-time 2 \
    http://127.0.0.1:4101/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
kill -0 "${provider_pid}"

set -a
# The managed Hermes runtime owns this local API credential. It authenticates
# the caller to Hermes and is not a model-provider credential.
# shellcheck disable=SC1091
. /sandbox/.hermes/.env
set +a
test -n "${API_SERVER_KEY:-}"

# Send an intentionally untrusted caller header straight to inference.local.
# OpenShell must strip it and inject the gateway-owned provider credential.
auth_probe_payload='{"model":"caller-supplied-model","messages":[{"role":"user","content":"credential boundary probe"}],"max_tokens":8}'
auth_probe_header_name='Authorization'
auth_probe_value_prefix='nemoclaw-v3-untrusted-'
auth_probe_value="${auth_probe_value_prefix}caller-value"
auth_probe_header_value="Bearer ${auth_probe_value}"
auth_probe_status="$(curl --silent --show-error --max-time 120 \
  --output "${AUTH_PROBE_RESPONSE}" --write-out '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H "${auth_probe_header_name}: ${auth_probe_header_value}" \
  -d "${auth_probe_payload}" \
  https://inference.local/v1/chat/completions)"
[[ "${auth_probe_status}" == "200" ]]

run_turn() {
  local prompt="$1"
  local output="$2"
  local payload
  payload="$(python3 -c 'import json,sys; print(json.dumps({"model":"nemoclaw-managed-bootstrap","messages":[{"role":"user","content":sys.argv[1]}],"max_tokens":512}))' "${prompt}")"
  local status
  status="$(curl --silent --show-error --max-time 120 \
    --output "${output}" --write-out '%{http_code}' \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${API_SERVER_KEY}" \
    -d "${payload}" \
    http://127.0.0.1:8642/v1/chat/completions)"
  if [[ "${status}" != "200" ]]; then
    printf 'Hermes turn failed with HTTP %s: ' "${status}" >&2
    head -c 2000 "${output}" >&2 || true
    printf '\n' >&2
    return 1
  fi
}

run_turn "${BOUNDED_PROMPT}" "${FAST_RESPONSE}"
run_turn "${CAPABLE_PROMPT}" "${QUALITY_RESPONSE}"

gateway_pid_after="$(gateway_pid)"
sidecars_after="$(relay_sidecars)"
[[ "${gateway_pid_before}" == "${gateway_pid_after}" ]]
[[ -z "${sidecars_after}" ]]
[[ -z "$(raw_provider_credentials_present)" ]]

python3 - "${PROVIDER_LOG}" "${FAST_RESPONSE}" "${QUALITY_RESPONSE}" \
  "${AUTH_PROBE_RESPONSE}" "${gateway_pid_before}" "${gateway_pid_after}" <<'PY'
import json
import sys
from pathlib import Path

log_path, fast_path, quality_path, auth_probe_path, pid_before, pid_after = sys.argv[1:]
events = [json.loads(line) for line in Path(log_path).read_text().splitlines() if line]

models = [event.get("model") for event in events]
if models != ["provider/classifier", "provider/classifier"]:
    raise SystemExit(f"final provider calls escaped inference.local: {models}")
if [event.get("prompt_kind") for event in events] != ["bounded", "capable"]:
    raise SystemExit("Switchyard classifier did not receive both deterministic task prompts")
if any(event.get("authorization_present") for event in events):
    raise SystemExit("a provider credential reached the loopback classifier")

def content(path):
    body = json.loads(Path(path).read_text())
    value = body["choices"][0]["message"]["content"]
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(f"empty model response in {path}")
    return value

content(auth_probe_path)
result = {
    "architecture": "supervised-hermes-native-relay-switchyard-inference-local",
    "caller_authorization_probe_succeeded": True,
    "classifier_provider_authorization_absent": True,
    "provider_placeholder_present": True,
    "raw_provider_credentials_absent": True,
    "gateway_pid_after": int(pid_after),
    "gateway_pid_before": int(pid_before),
    "gateway_pid_stable": pid_before == pid_after,
    "native_plugin": "nvidia.switchyard",
    "provider_boundary": "https://inference.local",
    "relay_sidecar_processes": 0,
    "route_model_contract": "gateway-forced-single-model",
    "status": "pass",
    "turns": [
        {
            "answer": content(fast_path),
            "classifier": "efficient",
            "route": "weak",
            "target": "inference.local",
        },
        {
            "answer": content(quality_path),
            "classifier": "capable",
            "route": "strong",
            "target": "inference.local",
        },
    ],
}
print("NEMOCLAW_HERMES_SWITCHYARD_INFERENCE_LOCAL=" + json.dumps(result, separators=(",", ":")))
PY
