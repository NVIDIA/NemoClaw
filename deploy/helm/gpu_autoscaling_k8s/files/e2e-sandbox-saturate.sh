#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Runs *inside* one OpenShell sandbox. This user's in-flight chat
# completions go to https://inference.local (OpenShell → Envoy LeastRequest →
# GPU HPA). It is the per-user half of the 20-sandbox 8×H100 saturator — not
# the metrics-proxy pod-IP Job in files/load-generator.ts.

set -euo pipefail

INFLIGHT="${INFLIGHT:-32}"
MAX_INFLIGHT="${MAX_INFLIGHT:-256}"
DURATION_SEC="${DURATION_SEC:-900}"
MAX_TOKENS="${MAX_TOKENS:-128}"
MODEL="${INFERENCE_MODEL:-llama3.2:3b}"
PROMPT="${PROMPT:-Say OK in one word.}"
ESCALATE_INTERVAL_SEC="${ESCALATE_INTERVAL_SEC:-15}"
ESCALATE_FACTOR_PCT="${ESCALATE_FACTOR_PCT:-35}"
REQUEST_TIMEOUT_SEC="${REQUEST_TIMEOUT_SEC:-120}"
URL="${INFERENCE_URL:-https://inference.local/v1/chat/completions}"

if [[ ! "${INFLIGHT}" =~ ^[1-9][0-9]*$ || ! "${MAX_INFLIGHT}" =~ ^[1-9][0-9]*$ ]]; then
  echo "INFLIGHT and MAX_INFLIGHT must be positive integers" >&2
  exit 1
fi
if ((INFLIGHT > MAX_INFLIGHT)); then
  INFLIGHT="${MAX_INFLIGHT}"
fi

BODY="$(printf '{"model":"%s","messages":[{"role":"user","content":"%s"}],"max_tokens":%s,"stream":false}' \
  "${MODEL}" "${PROMPT}" "${MAX_TOKENS}")"

ok=0
err=0
pids=()
end=$((SECONDS + DURATION_SEC))
current="${INFLIGHT}"
last_escalate="${SECONDS}"
last_log="${SECONDS}"

reap() {
  local pid still=()
  for pid in "${pids[@]+"${pids[@]}"}"; do
    if kill -0 "${pid}" 2>/dev/null; then
      still+=("${pid}")
      continue
    fi
    if wait "${pid}"; then
      ok=$((ok + 1))
    else
      err=$((err + 1))
    fi
  done
  pids=("${still[@]+"${still[@]}"}")
}

stop_workers() {
  local pid
  for pid in "${pids[@]+"${pids[@]}"}"; do
    kill "${pid}" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}

trap 'stop_workers; echo "sandbox-saturate stop ok=${ok} err=${err} inflight=${current}"; exit 0' TERM INT

launch_one() {
  curl -fsS --max-time "${REQUEST_TIMEOUT_SEC}" "${URL}" \
    -H 'Content-Type: application/json' \
    -d "${BODY}" >/dev/null &
  pids+=("$!")
}

echo "sandbox-saturate start inflight=${current} max=${MAX_INFLIGHT} duration=${DURATION_SEC}s model=${MODEL}"

while ((SECONDS < end)); do
  reap
  while ((${#pids[@]} < current && SECONDS < end)); do
    launch_one
  done
  if ((SECONDS - last_escalate >= ESCALATE_INTERVAL_SEC && current < MAX_INFLIGHT)); then
    add=$((current * ESCALATE_FACTOR_PCT / 100))
    if ((add < 1)); then
      add=1
    fi
    current=$((current + add))
    if ((current > MAX_INFLIGHT)); then
      current="${MAX_INFLIGHT}"
    fi
    last_escalate="${SECONDS}"
    echo "sandbox-saturate escalate inflight=${current} ok=${ok} err=${err}"
  fi
  if ((SECONDS - last_log >= 15)); then
    echo "sandbox-saturate progress ok=${ok} err=${err} live=${#pids[@]} target=${current}"
    last_log="${SECONDS}"
  fi
  sleep 0.2
done

reap
wait 2>/dev/null || true
echo "sandbox-saturate done ok=${ok} err=${err}"
