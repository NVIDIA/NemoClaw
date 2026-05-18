// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../core/shell-quote";
import { INFERENCE_ROUTE_URL, MANAGED_PROVIDER_ID } from "../inference/config";

type CompatibleEndpointSmokeAgent = {
  name?: string | null;
} | null | undefined;

type CompatibleEndpointSandboxSmokeScriptOptions = {
  configPath?: string;
  inferenceUrl?: string;
  initialMaxTokens?: number;
  retryMaxTokens?: number;
};

/**
 * Normalizes optional token-budget overrides while preserving safe defaults for
 * the generated sandbox smoke script.
 */
function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.floor(Number(value));
  return rounded > 0 ? rounded : fallback;
}

/**
 * Returns whether onboarding should validate the compatible endpoint through
 * the OpenClaw sandbox instead of only checking host-side configuration.
 */
export function shouldRunCompatibleEndpointSandboxSmoke(
  provider: string | null | undefined,
  messagingChannels: string[] | null | undefined,
  agent: CompatibleEndpointSmokeAgent = null,
): boolean {
  const agentName = agent?.name || "openclaw";
  return (
    agentName === "openclaw" &&
    provider === "compatible-endpoint" &&
    Array.isArray(messagingChannels) &&
    messagingChannels.length > 0
  );
}

/**
 * Converts child-process output into text for diagnostics without assuming
 * whether Node returned strings, buffers, nulls, or primitive values.
 */
export function spawnOutputToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  if (value == null) return "";
  return String(value);
}

/**
 * Builds the shell script that runs inside the sandbox to confirm OpenClaw is
 * routed through NemoClaw's managed inference provider and can receive assistant
 * content from the compatible endpoint.
 */
export function buildCompatibleEndpointSandboxSmokeScript(
  model: string,
  options: CompatibleEndpointSandboxSmokeScriptOptions = {},
): string {
  const configPath = options.configPath || "/sandbox/.openclaw/openclaw.json";
  const inferenceUrl = options.inferenceUrl || `${INFERENCE_ROUTE_URL}/chat/completions`;
  const initialMaxTokens = positiveInt(options.initialMaxTokens, 256);
  const retryMaxTokens = positiveInt(options.retryMaxTokens, 1024);

  return `
set -eu
MODEL=${shellQuote(model)}
CONFIG=${shellQuote(configPath)}
INFERENCE_URL=${shellQuote(inferenceUrl)}
INITIAL_MAX_TOKENS=${initialMaxTokens}
RETRY_MAX_TOKENS=${retryMaxTokens}

python3 - "$CONFIG" "$MODEL" <<'PYCFG'
import json
import sys

path = sys.argv[1]
model = sys.argv[2]

def die(message):
    print(message, file=sys.stderr)
    sys.exit(1)

try:
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
except Exception as exc:
    die("could not read openclaw.json: %s" % exc)

providers = cfg.get("models", {}).get("providers", {})
if not isinstance(providers, dict):
    die("openclaw.json models.providers is not an object")
if "deepinfra" in providers:
    die("openclaw.json contains a direct deepinfra provider; expected managed inference provider")

provider = providers.get("${MANAGED_PROVIDER_ID}")
if not isinstance(provider, dict):
    die("openclaw.json missing models.providers.${MANAGED_PROVIDER_ID}")
if provider.get("baseUrl") != "${INFERENCE_ROUTE_URL}":
    die("models.providers.${MANAGED_PROVIDER_ID}.baseUrl is %r; expected ${INFERENCE_ROUTE_URL}" % provider.get("baseUrl"))
if provider.get("apiKey") != "unused":
    die("models.providers.${MANAGED_PROVIDER_ID}.apiKey must remain the non-secret placeholder 'unused'")

primary = cfg.get("agents", {}).get("defaults", {}).get("model", {}).get("primary")
expected_primary = "${MANAGED_PROVIDER_ID}/" + model
if primary != expected_primary:
    die("agents.defaults.model.primary is %r; expected %r" % (primary, expected_primary))

print("OPENCLAW_CONFIG_OK")
PYCFG

payload_file="$(mktemp)"
response_file="$(mktemp)"
error_file="$(mktemp)"
trap 'rm -f "$payload_file" "$response_file" "$error_file"' EXIT

write_payload() {
  python3 - "$MODEL" "$1" >"$payload_file" <<'PYPAYLOAD'
import json
import sys

model = sys.argv[1]
max_tokens = int(sys.argv[2])
print(json.dumps({
    "model": model,
    "messages": [
        {"role": "user", "content": "Reply with exactly: PONG"}
    ],
    "max_tokens": max_tokens,
}))
PYPAYLOAD
}

run_smoke_request() {
  curl -sS --connect-timeout 10 --max-time 60 \
    "$INFERENCE_URL" \
    -H "Content-Type: application/json" \
    -d "@$payload_file" >"$response_file" 2>"$error_file" || {
    rc=$?
    printf 'curl exit %s: ' "$rc" >&2
    cat "$error_file" >&2
    exit "$rc"
  }
}

check_response() {
  python3 - "$response_file" "$1" "$2" "$3" <<'PYRESP'
import json
import sys

path = sys.argv[1]
attempt = sys.argv[2]
max_tokens = sys.argv[3]
can_retry = sys.argv[4] == "1"
try:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception as exc:
    body = ""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            body = f.read(1000)
    except Exception:
        pass
    print("inference.local returned non-JSON response: %s; body=%s" % (exc, body), file=sys.stderr)
    sys.exit(1)

choices = data.get("choices")
choice = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
content = message.get("content")
if not isinstance(content, str) or not content.strip():
    finish_reason = choice.get("finish_reason")
    reasoning_content = message.get("reasoning_content")
    if not isinstance(reasoning_content, str) or not reasoning_content.strip():
        reasoning_content = message.get("reasoning")
    if finish_reason == "length" and isinstance(reasoning_content, str) and reasoning_content.strip():
        if can_retry:
            print(
                "inference.local reached the model, but the %s smoke attempt exhausted max_tokens=%s in reasoning_content before emitting choices[0].message.content; retrying with a larger smoke budget"
                % (attempt, max_tokens),
                file=sys.stderr,
            )
            sys.exit(2)
        print(
            "inference.local reached the model, but the %s smoke attempt still exhausted max_tokens=%s in reasoning_content before emitting choices[0].message.content: %s"
            % (attempt, max_tokens, json.dumps(data)[:1000]),
            file=sys.stderr,
        )
        sys.exit(1)
    print(
        "inference.local response did not contain non-empty choices[0].message.content (finish_reason=%r): %s"
        % (finish_reason, json.dumps(data)[:1000]),
        file=sys.stderr,
    )
    sys.exit(1)

print("INFERENCE_SMOKE_OK " + content.strip()[:200])
PYRESP
}

write_payload "$INITIAL_MAX_TOKENS"
run_smoke_request
status=0
check_response initial "$INITIAL_MAX_TOKENS" 1 || status=$?
if [ "$status" -eq 0 ]; then
  exit 0
fi
if [ "$status" -ne 2 ]; then
  exit "$status"
fi

write_payload "$RETRY_MAX_TOKENS"
run_smoke_request
check_response retry "$RETRY_MAX_TOKENS" 0
  `.trim();
}

/**
 * Wraps the sandbox smoke script as a one-line command suitable for execution
 * through the existing OpenShell command path.
 */
export function buildCompatibleEndpointSandboxSmokeCommand(model: string): string {
  const script = buildCompatibleEndpointSandboxSmokeScript(model);
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return [
    "set -eu",
    'tmp="$(mktemp)"',
    'trap \'rm -f "$tmp"\' EXIT',
    `python3 -c 'import base64, pathlib, sys; pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(sys.argv[2]))' "$tmp" ${shellQuote(encoded)}`,
    'sh "$tmp"',
  ].join("; ");
}
