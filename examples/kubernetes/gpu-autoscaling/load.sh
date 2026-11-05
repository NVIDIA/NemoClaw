#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Send prompts to the agents of an applied deployment, a bounded number at a
# time, and report each request's latency and errors. See README.md, "Drive
# Load Through the Agents".
#
# Usage: load.sh APPLY_JSON
#
# APPLY_JSON is the result of `nemoclaw apply -o json`. For each sandbox in
# its `agents`:
# - a sandbox with an `api` interface and a service URL for it, Hermes's API
#   server, gets OpenAI chat completions at that URL, with the interface's
#   token, which this script reads once at start with `openshell sandbox exec`;
# - any other sandbox gets `fabric-agent-ctl invoke` with its runtime ID,
#   through `openshell sandbox exec`.
#
# The OpenShell CLI must select the deployment's gateway and workspace
# (OPENSHELL_GATEWAY and OPENSHELL_WORKSPACE).
#
# Environment:
#   PROMPTS          prompts to send, spread over the sandboxes in turn (20)
#   CONCURRENCY      most requests in flight at once (4)
#   TIMEOUT          seconds each request may take (300)
#   PROMPT_FILE      file with one prompt per line, used in turn (built-in prompts)
#   GATEWAY_ADDRESS  host:port where this host reaches the gateway, such as its
#                    port forward (127.0.0.1:17671); service URLs connect there
#   MTLS_DIR         the gateway's client certificate: ca.crt, tls.crt, tls.key
#                    (the OpenShell CLI's directory for OPENSHELL_GATEWAY)
#   RESULTS          file to write one JSON line per request to (none)
#
# Adapted from scripts/e2e-fabric-load-test.py in NVIDIA/NemoClaw#14009 at
# ac69c22: its prompts, timeout and success checks, without kubectl exec or
# reading NemoClaw's state.

set -euo pipefail

if [[ "${1:-}" == "--request" ]]; then
  # One request, run by xargs below: $2 is its number, from 1. A failed
  # command is the request's error, not the script's.
  set +e
  n="$2"
  count="$(wc -l <"$LOAD_DIR/sandboxes")"
  read -r sandbox mode agent runtime url < <(sed -n "$(((n - 1) % count + 1))p" "$LOAD_DIR/sandboxes")
  prompts="$(wc -l <"$LOAD_DIR/prompts")"
  prompt="$(sed -n "$(((n - 1) % prompts + 1))p" "$LOAD_DIR/prompts")"
  out="$LOAD_DIR/out.$n"
  start="$(date +%s%N)"
  ok=false error="" reply=""
  if [[ "$mode" == api ]]; then
    code="$(jq -n --arg p "$prompt" '{model: "hermes-agent", messages: [{role: "user", content: $p}]}' |
      curl -sS --max-time "$TIMEOUT" --cacert "$MTLS_DIR/ca.crt" --cert "$MTLS_DIR/tls.crt" --key "$MTLS_DIR/tls.key" \
        --connect-to "::$GATEWAY_ADDRESS" -H @"$LOAD_DIR/$sandbox.header" -H 'Content-Type: application/json' \
        --data-binary @- -o "$out" -w '%{http_code}' "${url%/}/v1/chat/completions" 2>"$out.err")" || true
    reply="$(jq -r '.choices[0].message.content // empty' "$out" 2>/dev/null || true)"
    if [[ "$code" == 200 && -n "$reply" ]]; then
      ok=true
    else
      error="HTTP ${code:-none}: $(cat "$out.err" "$out" 2>/dev/null | head -c 300 | tr '\n' ' ')"
    fi
  else
    jq -n --arg p "$prompt" '$p' |
      timeout "$TIMEOUT" openshell sandbox exec -n "$sandbox" --no-tty -- \
        fabric-agent-ctl invoke --agent "$agent" --runtime-id "$runtime" --input - >"$out" 2>"$out.err"
    status=$?
    reply="$(jq -r 'select(.result.status == "succeeded") | .result.output.response // empty' "$out" 2>/dev/null || true)"
    if [[ -n "$reply" ]]; then
      ok=true
    else
      error="$(jq -r '[.status, .result.status, ((.error // .result.error // {}) | .code, .stage)] | map(select(. != null)) | join(" ")' "$out" 2>/dev/null ||
        head -c 300 "$out.err" | tr '\n' ' ')"
      [[ "$status" != 124 ]] || error="timed out after $TIMEOUT s"
      [[ -n "$error" ]] || error="exit $status: $(head -c 300 "$out.err" | tr '\n' ' ')"
    fi
  fi
  end="$(date +%s%N)"
  jq -cn --argjson n "$n" --arg sandbox "$sandbox" --arg path "$mode" --argjson ok "$ok" \
    --argjson seconds "$(((end - start) / 1000000))e-3" --arg error "$error" --arg reply "$reply" \
    '{n: $n, sandbox: $sandbox, path: $path, ok: $ok, seconds: $seconds, error: $error, reply: $reply}' >"$LOAD_DIR/result.$n"
  rm -f "$out" "$out.err"
  exit 0
fi

apply_json="${1:?usage: load.sh APPLY_JSON}"
export PROMPTS="${PROMPTS:-20}" CONCURRENCY="${CONCURRENCY:-4}" TIMEOUT="${TIMEOUT:-300}"
export GATEWAY_ADDRESS="${GATEWAY_ADDRESS:-127.0.0.1:17671}"
export MTLS_DIR="${MTLS_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/openshell/gateways/${OPENSHELL_GATEWAY:-}/mtls}"
for command in openshell curl jq; do
  command -v "$command" >/dev/null || { echo "load.sh: $command is required" >&2; exit 2; }
done
[[ "$PROMPTS" =~ ^[1-9][0-9]*$ && "$CONCURRENCY" =~ ^[1-9][0-9]*$ && "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] ||
  { echo "load.sh: PROMPTS, CONCURRENCY and TIMEOUT must be positive integers" >&2; exit 2; }
jq -e '.outcome == "succeeded"' "$apply_json" >/dev/null ||
  { echo "load.sh: $apply_json is not a successful apply result" >&2; exit 2; }

LOAD_DIR="$(mktemp -d)"
export LOAD_DIR
trap 'rm -rf "$LOAD_DIR"' EXIT
umask 077

# One line per sandbox with a runtime: name, path, agent, runtime ID, URL.
jq -r '.agents // {} | to_entries[] | select(.value.runtimeId) | [.key, .value.agent, .value.runtimeId] | @tsv' "$apply_json" |
  while IFS=$'\t' read -r sandbox agent runtime; do
    url="$(jq -r --arg s "$sandbox" '.serviceUrls[$s].api // empty' "$apply_json")"
    token_path="$(jq -r --arg s "$sandbox" '.interfaces // [] | map(select(.sandbox == $s and .interface == "api"))[0].tokenPath // empty' "$apply_json")"
    if [[ -n "$url" && -n "$token_path" ]]; then
      # The adapter writes a new token each time the runtime starts.
      token="$(openshell sandbox exec -n "$sandbox" --no-tty -- cat "$token_path" </dev/null)" ||
        { echo "load.sh: can't read $sandbox's API token" >&2; exit 1; }
      printf 'Authorization: Bearer %s\n' "$token" >"$LOAD_DIR/$sandbox.header"
      echo "$sandbox api $agent $runtime $url"
    else
      echo "$sandbox invoke $agent $runtime -"
    fi
  done >"$LOAD_DIR/sandboxes"
[[ -s "$LOAD_DIR/sandboxes" ]] || { echo "load.sh: $apply_json lists no agent with a runtime" >&2; exit 1; }
if grep -q ' api ' "$LOAD_DIR/sandboxes"; then
  for file in ca.crt tls.crt tls.key; do
    [[ -r "$MTLS_DIR/$file" ]] || { echo "load.sh: $MTLS_DIR/$file is missing; set MTLS_DIR" >&2; exit 2; }
  done
fi
if [[ -n "${PROMPT_FILE:-}" ]]; then
  grep -v '^[[:space:]]*$' "$PROMPT_FILE" >"$LOAD_DIR/prompts"
else
  printf '%s\n' \
    "In one sentence, what is a Kubernetes HorizontalPodAutoscaler?" \
    "In one sentence, what does GPU utilization measure?" \
    "In one sentence, what is vLLM?" >"$LOAD_DIR/prompts"
fi

echo "Sending $PROMPTS prompts to $(wc -l <"$LOAD_DIR/sandboxes") sandboxes, at most $CONCURRENCY at a time:"
awk '{ printf "  %s: %s\n", $1, ($2 == "api" ? "Hermes API at " $5 : "fabric-agent-ctl invoke, runtime " $4) }' "$LOAD_DIR/sandboxes"
started="$(date +%s)"
seq 1 "$PROMPTS" | xargs -P "$CONCURRENCY" -I{} "$0" --request {} || true
elapsed="$(($(date +%s) - started))"

cat "$LOAD_DIR"/result.* | jq -s 'sort_by(.n)' >"$LOAD_DIR/results.json"
[[ -z "${RESULTS:-}" ]] || jq -c '.[]' "$LOAD_DIR/results.json" >"$RESULTS"
jq -r --argjson elapsed "$elapsed" '
  def pct(p): sort | .[(length * p | ceil) - 1];
  def stats: map(.seconds) | if length == 0 then "-" else
    "p50 \(pct(0.5) * 10 | round / 10) s, p95 \(pct(0.95) * 10 | round / 10) s, max \(max * 10 | round / 10) s" end;
  "",
  "Sent \(length) prompts in \($elapsed) s: \(map(select(.ok)) | length) replied, \(map(select(.ok | not)) | length) failed.",
  "Latency of replies: \(map(select(.ok)) | stats).",
  "",
  (group_by(.sandbox)[] | "  \(.[0].sandbox) (\(.[0].path)): \(map(select(.ok)) | length)/\(length) replied; \(map(select(.ok)) | stats)"),
  "",
  (map(select(.ok | not))[:10][] | "  failed #\(.n) \(.sandbox) after \(.seconds) s: \(.error[:200])"),
  (map(select(.ok)) | group_by(.sandbox)[] | .[0] | "  reply #\(.n) \(.sandbox): \(.reply | gsub("\\s+"; " ")[:160])")
' "$LOAD_DIR/results.json"
jq -e 'all(.ok)' "$LOAD_DIR/results.json" >/dev/null
