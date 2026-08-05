#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly PROVIDER="${NEMOCLAW_SWITCHYARD_FAKE_PROVIDER:-/usr/local/lib/nemoclaw/switchyard-native-fake-provider.py}"
readonly PROVIDER_LOG="/tmp/nemoclaw-switchyard-native-provider.jsonl"
readonly PROVIDER_STDERR="/tmp/nemoclaw-switchyard-native-provider.log"
readonly FAST_RESPONSE="/tmp/nemoclaw-switchyard-native-fast.json"
readonly QUALITY_RESPONSE="/tmp/nemoclaw-switchyard-native-quality.json"
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

test -x "${PROVIDER}"
test -s /usr/local/lib/nemoclaw/switchyard-relay-plugin/relay-plugin.toml
grep -Fq 'id = "nvidia.switchyard"' /usr/local/lib/nemoclaw/switchyard-relay-plugin/relay-plugin.toml
grep -Fq 'native_api = "1"' /usr/local/lib/nemoclaw/switchyard-relay-plugin/relay-plugin.toml

curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8642/health >/dev/null
gateway_pid_before="$(gateway_pid)"
sidecars_before="$(relay_sidecars)"
[[ -z "${sidecars_before}" ]]

rm -f "${PROVIDER_LOG}" "${PROVIDER_STDERR}" "${FAST_RESPONSE}" "${QUALITY_RESPONSE}"
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
# The managed Hermes runtime owns this file.
# shellcheck disable=SC1091
. /sandbox/.hermes/.env
set +a
test -n "${API_SERVER_KEY:-}"

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

python3 - "${PROVIDER_LOG}" "${FAST_RESPONSE}" "${QUALITY_RESPONSE}" \
  "${gateway_pid_before}" "${gateway_pid_after}" <<'PY'
import json
import sys
from pathlib import Path

log_path, fast_path, quality_path, pid_before, pid_after = sys.argv[1:]
events = [json.loads(line) for line in Path(log_path).read_text().splitlines() if line]

models = [event.get("model") for event in events]
expected = ["provider/classifier", "provider/fast", "provider/classifier", "provider/quality"]
if models != expected:
    raise SystemExit(f"unexpected Switchyard request sequence: {models}")
if [event.get("prompt_kind") for event in events[::2]] != ["bounded", "capable"]:
    raise SystemExit("Switchyard classifier did not receive both deterministic task prompts")
if any(event.get("authorization_present") for event in events):
    raise SystemExit("a provider credential reached the credential-free routing proof")

def content(path):
    body = json.loads(Path(path).read_text())
    return body["choices"][0]["message"]["content"]

result = {
    "architecture": "supervised-hermes-native-relay-dynamic-switchyard",
    "gateway_pid_after": int(pid_after),
    "gateway_pid_before": int(pid_before),
    "gateway_pid_stable": pid_before == pid_after,
    "native_plugin": "nvidia.switchyard",
    "provider_authorization_absent": True,
    "relay_sidecar_processes": 0,
    "status": "pass",
    "turns": [
        {
            "answer": content(fast_path),
            "classifier": "efficient",
            "route": "weak",
            "target": "provider/fast",
        },
        {
            "answer": content(quality_path),
            "classifier": "capable",
            "route": "strong",
            "target": "provider/quality",
        },
    ],
}
print("NEMOCLAW_HERMES_SWITCHYARD_NATIVE=" + json.dumps(result, separators=(",", ":")))
PY
