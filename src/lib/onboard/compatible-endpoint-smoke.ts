// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StdioOptions } from "node:child_process";
import { shellQuote } from "../core/shell-quote";
import { compactText } from "../core/url-utils";
import { INFERENCE_ROUTE_URL, MANAGED_PROVIDER_ID } from "../inference/config";
import { resolveMaxTokensField } from "../inference/max-tokens-field";
import type { HostLocalInferenceSandboxProofAuthority } from "./runtime-provider/host-local-inference-routing";
import {
  buildCompatibleEndpointSmokeRequestScript,
  RETRYABLE_HTTP_STATUS_PYTHON_EXPRESSION,
  SUCCESS_HTTP_STATUS_PYTHON_EXPRESSION,
  totalRetryBackoffSeconds,
} from "./smoke-retry-classifier";

type CompatibleEndpointSmokeAgent =
  | {
      name?: string | null;
    }
  | null
  | undefined;

type CompatibleEndpointSandboxSmokeScriptOptions = {
  attempts?: number;
  configPath?: string;
  inferenceUrl?: string;
  initialMaxTokens?: number;
  retryDelaySeconds?: number;
  retryMaxTokens?: number;
};

type CompatibleEndpointSmokeRun = (
  args: string[],
  options?: {
    ignoreError?: boolean;
    suppressOutput?: boolean;
    stdio?: StdioOptions;
    timeout?: number;
  },
) => { status: number | null; stdout?: unknown; stderr?: unknown };

const COMPATIBLE_ENDPOINT_SMOKE_ATTEMPTS = 3;
const COMPATIBLE_ENDPOINT_SMOKE_REQUEST_TIMEOUT_SECONDS = 60;
const COMPATIBLE_ENDPOINT_SMOKE_RETRY_DELAY_SECONDS = 5;
const COMPATIBLE_ENDPOINT_SMOKE_COMMAND_OVERHEAD_SECONDS = 30;
const PROVIDER_NEUTRAL_SMOKE_INFERENCE_PROOF_COUNT = 3;
const PROVIDER_NEUTRAL_SMOKE_DIRECT_DENY_TIMEOUT_SECONDS = 10;
const COMPATIBLE_ENDPOINT_SMOKE_PROOF_TIMEOUT_SECONDS =
  COMPATIBLE_ENDPOINT_SMOKE_ATTEMPTS * COMPATIBLE_ENDPOINT_SMOKE_REQUEST_TIMEOUT_SECONDS +
  totalRetryBackoffSeconds(
    COMPATIBLE_ENDPOINT_SMOKE_ATTEMPTS,
    COMPATIBLE_ENDPOINT_SMOKE_RETRY_DELAY_SECONDS,
  );
const COMPATIBLE_ENDPOINT_SMOKE_COMMAND_TIMEOUT_MS =
  (COMPATIBLE_ENDPOINT_SMOKE_PROOF_TIMEOUT_SECONDS +
    COMPATIBLE_ENDPOINT_SMOKE_COMMAND_OVERHEAD_SECONDS) *
  1000;
const PROVIDER_NEUTRAL_SMOKE_COMMAND_TIMEOUT_MS =
  (PROVIDER_NEUTRAL_SMOKE_INFERENCE_PROOF_COUNT * COMPATIBLE_ENDPOINT_SMOKE_PROOF_TIMEOUT_SECONDS +
    PROVIDER_NEUTRAL_SMOKE_DIRECT_DENY_TIMEOUT_SECONDS +
    COMPATIBLE_ENDPOINT_SMOKE_COMMAND_OVERHEAD_SECONDS) *
  1000;
const OPEN_SHELL_DIRECT_POLICY_DENIAL_CONTRACT = Object.freeze({
  version: 1,
  httpStatus: 403,
  error: "policy_denied",
  method: "POST",
  host: "host.openshell.internal",
  path: "/v1/chat/completions",
  detailSuffix: "not permitted by policy",
});

/**
 * Normalizes optional token-budget overrides while preserving safe defaults for
 * the generated sandbox smoke script.
 */
function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.floor(Number(value));
  return rounded > 0 ? rounded : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.floor(Number(value));
  return rounded >= 0 ? rounded : fallback;
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

export function verifyCompatibleEndpointSandboxSmoke(options: {
  sandboxName: string;
  provider: string;
  model: string;
  runOpenshell: CompatibleEndpointSmokeRun;
  redact: (value: string) => string;
  endpointUrl?: string | null;
  credentialEnv?: string | null;
  messagingChannels?: string[] | null;
  agent?: CompatibleEndpointSmokeAgent;
  /** Force the provider-neutral inference.local proof for any supported agent. */
  forceCanonicalRoute?: boolean;
  hostLocalInferenceProofAuthority?: HostLocalInferenceSandboxProofAuthority;
  /** Recheck policy authority after the sandbox proof and before success output. */
  beforeSuccess?: () => void;
}): void {
  if (
    options.forceCanonicalRoute !== true &&
    !shouldRunCompatibleEndpointSandboxSmoke(
      options.provider,
      options.messagingChannels,
      options.agent,
    )
  ) {
    return;
  }

  console.log(
    options.forceCanonicalRoute
      ? "  Verifying provider-neutral inference through the sandbox runtime..."
      : "  Verifying compatible endpoint through the messaging sandbox...",
  );

  const providerResult = options.runOpenshell(["provider", "get", options.provider], {
    ignoreError: true,
    suppressOutput: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const providerDetails = [
    spawnOutputToString(providerResult.stdout),
    spawnOutputToString(providerResult.stderr),
  ]
    .join("\n")
    .trim();

  if (providerResult.status !== 0) {
    console.error(
      options.forceCanonicalRoute
        ? `  Provider-neutral inference provider '${options.provider}' is missing or unreachable in the OpenShell gateway.`
        : `  Compatible endpoint provider '${options.provider}' is missing from the OpenShell gateway.`,
    );
    console.error(
      options.forceCanonicalRoute
        ? "  The sandbox inference.local route cannot reach the selected model provider."
        : "  The sandbox would start Telegram, but agent turns would fail before reaching the model.",
    );
    if (providerDetails) {
      console.error(`  ${compactText(options.redact(providerDetails)).slice(0, 800)}`);
    }
    process.exit(providerResult.status || 1);
  }

  if (
    options.forceCanonicalRoute !== true &&
    options.endpointUrl &&
    providerDetails &&
    /OPENAI_BASE_URL|baseUrl|base URL|endpoint/i.test(providerDetails) &&
    !providerDetails.includes(options.endpointUrl)
  ) {
    console.warn(
      `  \u26a0 Gateway provider '${options.provider}' did not report the selected endpoint URL.`,
    );
    console.warn("    Continuing to the sandbox-side inference.local smoke check.");
  }
  if (
    options.credentialEnv &&
    providerDetails &&
    /credential|api key|secret/i.test(providerDetails) &&
    !providerDetails.includes(options.credentialEnv)
  ) {
    console.warn(
      `  \u26a0 Gateway provider '${options.provider}' did not report the selected credential binding.`,
    );
  }

  const forceCanonicalRoute = options.forceCanonicalRoute === true;
  const script = forceCanonicalRoute
    ? buildProviderNeutralInferenceSandboxSmokeScript(
        options.model,
        options.hostLocalInferenceProofAuthority,
      )
    : buildCompatibleEndpointSandboxSmokeCommand(options.model);
  const smokeResult = options.runOpenshell(
    forceCanonicalRoute
      ? ["sandbox", "exec", "-n", options.sandboxName, "--", "python3", "-c", script]
      : ["sandbox", "exec", "-n", options.sandboxName, "--", "sh", "-lc", script],
    {
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: forceCanonicalRoute
        ? PROVIDER_NEUTRAL_SMOKE_COMMAND_TIMEOUT_MS
        : COMPATIBLE_ENDPOINT_SMOKE_COMMAND_TIMEOUT_MS,
    },
  );
  const smokeOutput = [
    spawnOutputToString(smokeResult.stdout),
    spawnOutputToString(smokeResult.stderr),
  ]
    .join("\n")
    .trim();

  if (smokeResult.status !== 0 || !/INFERENCE_SMOKE_OK/.test(smokeOutput)) {
    console.error(
      options.forceCanonicalRoute
        ? "  Provider-neutral sandbox inference smoke check failed."
        : "  Compatible endpoint sandbox smoke check failed.",
    );
    if (!options.forceCanonicalRoute) {
      console.error("  Telegram provider startup is not the root cause; inference.local failed.");
    }
    if (smokeOutput) console.error(`  ${compactText(options.redact(smokeOutput)).slice(0, 1200)}`);
    process.exit(smokeResult.status || 1);
  }

  options.beforeSuccess?.();
  console.log(
    options.forceCanonicalRoute
      ? "  \u2713 Provider responds through inference.local inside the sandbox"
      : "  \u2713 Compatible endpoint responds through inference.local inside the sandbox",
  );
}

/**
 * Builds the shell script that runs inside the sandbox to confirm OpenClaw is
 * routed through NemoClaw's managed inference provider and can receive assistant
 * content from the compatible endpoint.
 * Reasoning-only endpoints may fill 512 tokens in reasoning_content before final content;
 * finish_reason=length retries at 1024 until providers offer non-reasoning output.
 */
export function buildCompatibleEndpointSandboxSmokeScript(
  model: string,
  options: CompatibleEndpointSandboxSmokeScriptOptions = {},
): string {
  const configPath = options.configPath || "/sandbox/.openclaw/openclaw.json";
  const inferenceUrl = options.inferenceUrl || `${INFERENCE_ROUTE_URL}/chat/completions`;
  const initialMaxTokens = positiveInt(options.initialMaxTokens, 512);
  const attempts = positiveInt(options.attempts, COMPATIBLE_ENDPOINT_SMOKE_ATTEMPTS);
  const retryDelaySeconds = nonNegativeInt(
    options.retryDelaySeconds,
    COMPATIBLE_ENDPOINT_SMOKE_RETRY_DELAY_SECONDS,
  );
  const retryMaxTokens = positiveInt(options.retryMaxTokens, 1024);
  // GPT-5/o-series (incl. Azure OpenAI) require `max_completion_tokens`; every
  // other model still expects `max_tokens`. Kept in lockstep with the host-side
  // onboarding probe via the shared resolver.
  const maxTokensField = resolveMaxTokensField(model);
  const smokeRequestScript = buildCompatibleEndpointSmokeRequestScript();

  return `
set -eu
MODEL=${shellQuote(model)}
CONFIG=${shellQuote(configPath)}
INFERENCE_URL=${shellQuote(inferenceUrl)}
INITIAL_MAX_TOKENS=${initialMaxTokens}
RETRY_MAX_TOKENS=${retryMaxTokens}
MAX_TOKENS_FIELD=${shellQuote(maxTokensField)}
SMOKE_ATTEMPTS=${attempts}
SMOKE_REQUEST_TIMEOUT_SECONDS=${COMPATIBLE_ENDPOINT_SMOKE_REQUEST_TIMEOUT_SECONDS}
SMOKE_RETRY_DELAY_SECONDS=${retryDelaySeconds}

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
status_file="$(mktemp)"
trap 'rm -f "$payload_file" "$response_file" "$status_file"' EXIT

write_payload() {
  python3 - "$MODEL" "$1" "$MAX_TOKENS_FIELD" >"$payload_file" <<'PYPAYLOAD'
import json
import sys

model = sys.argv[1]
max_tokens = int(sys.argv[2])
max_tokens_field = sys.argv[3]
print(json.dumps({
    "model": model,
    "messages": [
        {"role": "user", "content": "Reply with exactly: PONG"}
    ],
    max_tokens_field: max_tokens,
}))
PYPAYLOAD
}

${smokeRequestScript}

check_response() {
  python3 - "$response_file" "$status_file" "$1" "$2" "$3" <<'PYRESP'
import json
import os
import sys

path = sys.argv[1]
status_path = sys.argv[2]
attempt = sys.argv[3]
max_tokens = sys.argv[4]
can_retry = sys.argv[5] == "1"
with open(status_path, "r", encoding="utf-8") as f:
    http_status = f.read().strip()
if len(http_status) != 3 or not http_status.isdigit():
    print("inference.local returned invalid curl HTTP status metadata", file=sys.stderr)
    sys.exit(1)
http_status_code = int(http_status)
response_bytes = os.path.getsize(path)
try:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception as exc:
    print(
        "inference.local returned non-JSON response: %s; response_bytes=%s; http_status=%s"
        % (exc, response_bytes, http_status),
        file=sys.stderr,
    )
    retryable_gateway_error = ${RETRYABLE_HTTP_STATUS_PYTHON_EXPRESSION}
    sys.exit(3 if can_retry and retryable_gateway_error else 1)

retryable_http_error = ${RETRYABLE_HTTP_STATUS_PYTHON_EXPRESSION}
if retryable_http_error:
    print(
        "inference.local returned transient HTTP %s; response_bytes=%s"
        % (http_status, response_bytes),
        file=sys.stderr,
    )
    sys.exit(3 if can_retry else 1)

if not (${SUCCESS_HTTP_STATUS_PYTHON_EXPRESSION}):
    print(
        "inference.local returned terminal HTTP %s; response_bytes=%s"
        % (http_status, response_bytes),
        file=sys.stderr,
    )
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

# OpenShell provider refresh has no route-ready acknowledgement for a reused
# sandbox, so this first authenticated request retries only explicit transport
# and HTTP 5xx signals while keeping config/content failures strict.
# Remove this retry when provider refresh exposes a route-ready acknowledgement.
# Timeout escalation extends onboarding but not propagation readiness after exit 28.
# Three attempts sleep twice: 5s after attempt 1, then 10s after attempt 2.
attempt=1
while [ "$attempt" -le "$SMOKE_ATTEMPTS" ]; do
  max_tokens="$RETRY_MAX_TOKENS"
  attempt_label=retry
  if [ "$attempt" -eq 1 ]; then
    max_tokens="$INITIAL_MAX_TOKENS"
    attempt_label=initial
  fi

  write_payload "$max_tokens"
  status=0
  run_smoke_request || status=$?
  if [ "$status" -eq 0 ]; then
    can_retry=0
    if [ "$attempt" -lt "$SMOKE_ATTEMPTS" ]; then
      can_retry=1
    fi
    check_response "$attempt_label" "$max_tokens" "$can_retry" || status=$?
  fi
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  if [ "$status" -ne 2 ] && [ "$status" -ne 3 ] && [ "$status" -ne 4 ]; then
    exit "$status"
  fi
  if [ "$attempt" -ge "$SMOKE_ATTEMPTS" ]; then
    exit "$status"
  fi
  retry_delay=$((SMOKE_RETRY_DELAY_SECONDS * attempt))
  if [ "$status" -ne 2 ]; then
    printf 'inference.local smoke attempt %s/%s failed; retrying in %ss\n' \
      "$attempt" "$SMOKE_ATTEMPTS" "$retry_delay" >&2
  fi
  sleep "$retry_delay"
  attempt=$((attempt + 1))
done
  `.trim();
}

export function buildCompatibleEndpointSandboxSmokeCommand(model: string): string {
  return buildCompatibleEndpointSandboxSmokeScript(model);
}

/**
 * Runs a Python standard-library request inside the sandbox, proving a real
 * chat response through inference.local and explicit policy denial for the
 * selected direct host-native inference port that would bypass the gateway.
 */
export function buildProviderNeutralInferenceSandboxSmokeScript(
  model: string,
  authority: HostLocalInferenceSandboxProofAuthority | undefined,
): string {
  const expectedHealthPath =
    authority?.service === "ollama"
      ? "/api/tags"
      : authority?.service === "nim"
        ? "/v1/health/ready"
        : authority?.service === "vllm" || authority?.service === "llama-cpp"
          ? "/health"
          : null;
  if (
    !authority ||
    !Number.isSafeInteger(authority.directHostPort) ||
    authority.directHostPort < 1 ||
    authority.directHostPort > 65_535 ||
    authority.directHealthPath !== expectedHealthPath
  ) {
    throw new Error("Provider-neutral sandbox smoke requires exact provider health authority.");
  }
  const inferenceUrl = JSON.stringify(`${INFERENCE_ROUTE_URL}/chat/completions`);
  const maxTokensField = JSON.stringify(resolveMaxTokensField(model));
  const modelValue = JSON.stringify(model);
  const toolCallingRequired = authority.toolCallingRequired ? "True" : "False";
  const directAuthority = `${OPEN_SHELL_DIRECT_POLICY_DENIAL_CONTRACT.host}:${String(
    authority.directHostPort,
  )}`;
  const directUrl = JSON.stringify(
    `http://${directAuthority}${OPEN_SHELL_DIRECT_POLICY_DENIAL_CONTRACT.path}`,
  );
  const directMethod = JSON.stringify(OPEN_SHELL_DIRECT_POLICY_DENIAL_CONTRACT.method);
  const directDenialError = JSON.stringify(OPEN_SHELL_DIRECT_POLICY_DENIAL_CONTRACT.error);
  const directDenialDetail = JSON.stringify(
    `${OPEN_SHELL_DIRECT_POLICY_DENIAL_CONTRACT.method} ${directAuthority}${OPEN_SHELL_DIRECT_POLICY_DENIAL_CONTRACT.path} ${OPEN_SHELL_DIRECT_POLICY_DENIAL_CONTRACT.detailSuffix}`,
  );
  return `
import errno
import json
import sys
import time
import urllib.error
import urllib.request

inference_url = ${inferenceUrl}
model = ${modelValue}
max_tokens_field = ${maxTokensField}
tool_calling_required = ${toolCallingRequired}
max_response_bytes = 1048576
inference_opener = urllib.request.build_opener()
direct_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def post_inference(payload, label):
    request = urllib.request.Request(
        inference_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    response_data = None
    for attempt in range(3):
        try:
            with inference_opener.open(request, timeout=60) as response:
                if response.status < 200 or response.status > 299:
                    raise RuntimeError("inference.local returned HTTP %s" % response.status)
                response_bytes = response.read(max_response_bytes + 1)
                if len(response_bytes) > max_response_bytes:
                    print("inference.local %s proof response exceeded byte limit" % label, file=sys.stderr)
                    sys.exit(1)
                try:
                    response_data = json.loads(response_bytes.decode("utf-8", errors="strict"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    print("inference.local %s proof returned invalid JSON" % label, file=sys.stderr)
                    sys.exit(1)
            break
        except urllib.error.HTTPError as error:
            if 500 <= error.code <= 599 and attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            print("inference.local %s proof returned terminal HTTP %s" % (label, error.code), file=sys.stderr)
            sys.exit(1)
        except urllib.error.URLError:
            if attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            print("inference.local %s proof transport failed after bounded retries" % label, file=sys.stderr)
            sys.exit(1)
    if not isinstance(response_data, dict) or response_data.get("model") != model:
        print("inference.local %s proof returned a different model identity" % label, file=sys.stderr)
        sys.exit(1)
    return response_data

response_data = post_inference({
    "model": model,
    "messages": [{"role": "user", "content": "Reply with exactly: PONG"}],
    max_tokens_field: 512,
}, "content")

def classify_content_shape(data):
    choices = data.get("choices") if isinstance(data, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return "CHOICES_MISSING", None, False
    choice = choices[0]
    message = choice.get("message")
    if not isinstance(message, dict):
        return "MESSAGE_MISSING", None, False
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return "CONTENT", content, False
    reasoning = message.get("reasoning_content")
    if not isinstance(reasoning, str) or not reasoning.strip():
        reasoning = message.get("reasoning")
    if isinstance(reasoning, str) and reasoning.strip():
        return "REASONING_ONLY", None, choice.get("finish_reason") == "length"
    tool_calls = message.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        return "TOOL_CALL_ONLY", None, False
    if choice.get("finish_reason") == "length":
        return "EMPTY_LENGTH", None, False
    return "EMPTY_OTHER", None, False

content_shape, content, retry_reasoning = classify_content_shape(response_data)
if retry_reasoning:
    print(
        "inference.local content proof returned REASONING_ONLY at the initial token limit; retrying once with a larger content budget",
        file=sys.stderr,
    )
    response_data = post_inference({
        "model": model,
        "messages": [{"role": "user", "content": "Reply with exactly: PONG"}],
        max_tokens_field: 1024,
    }, "content")
    content_shape, content, _ = classify_content_shape(response_data)
if not isinstance(content, str) or not content.strip():
    print("inference.local content proof failed: %s" % content_shape, file=sys.stderr)
    sys.exit(1)

if tool_calling_required:
    tool_name = "nemoclaw_route_probe"
    tool_data = post_inference({
        "model": model,
        "messages": [{"role": "user", "content": "Call the required route probe tool."}],
        "tools": [{
            "type": "function",
            "function": {
                "name": tool_name,
                "description": "Prove tool calling through the selected inference route.",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
            },
        }],
        "tool_choice": {"type": "function", "function": {"name": tool_name}},
        max_tokens_field: 512,
    }, "tool")
    tool_choices = tool_data.get("choices")
    tool_choice = tool_choices[0] if isinstance(tool_choices, list) and tool_choices and isinstance(tool_choices[0], dict) else {}
    tool_message = tool_choice.get("message") if isinstance(tool_choice.get("message"), dict) else {}
    tool_calls = tool_message.get("tool_calls")
    matching_call = next((call for call in tool_calls if isinstance(call, dict) and isinstance(call.get("function"), dict) and call["function"].get("name") == tool_name), None) if isinstance(tool_calls, list) else None
    if matching_call is None:
        print("inference.local tool proof did not return the required tool call", file=sys.stderr)
        sys.exit(1)
    arguments = matching_call["function"].get("arguments")
    try:
        decoded_arguments = json.loads(arguments) if isinstance(arguments, str) else arguments
    except json.JSONDecodeError:
        decoded_arguments = None
    if not isinstance(decoded_arguments, dict) or decoded_arguments:
        print("inference.local tool proof returned invalid tool arguments", file=sys.stderr)
        sys.exit(1)

direct_url = ${directUrl}
direct_method = ${directMethod}
direct_denial_contract_version = ${String(OPEN_SHELL_DIRECT_POLICY_DENIAL_CONTRACT.version)}
direct_denial_http_status = ${String(OPEN_SHELL_DIRECT_POLICY_DENIAL_CONTRACT.httpStatus)}
direct_denial_error = ${directDenialError}
direct_denial_detail = ${directDenialDetail}
direct_deny_timeout_seconds = ${String(PROVIDER_NEUTRAL_SMOKE_DIRECT_DENY_TIMEOUT_SECONDS)}
direct_request = urllib.request.Request(
    direct_url,
    data=json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "Prove direct inference is denied."}],
        max_tokens_field: 1,
    }).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method=direct_method,
)
try:
    with direct_opener.open(direct_request, timeout=direct_deny_timeout_seconds) as direct_response:
        print(
            "direct host inference route unexpectedly returned HTTP %s" % direct_response.status,
            file=sys.stderr,
        )
        sys.exit(1)
except urllib.error.HTTPError as error:
    denial_bytes = error.read(max_response_bytes + 1)
    if len(denial_bytes) > max_response_bytes:
        print("direct host inference policy-denial response exceeded byte limit", file=sys.stderr)
        sys.exit(1)
    try:
        denial_text = denial_bytes.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        print("direct host inference policy-denial response was not valid UTF-8", file=sys.stderr)
        sys.exit(1)
    try:
        denial = json.loads(denial_text)
    except json.JSONDecodeError:
        print("direct host inference policy-denial response was not valid JSON", file=sys.stderr)
        sys.exit(1)
    detail = denial.get("detail") if isinstance(denial, dict) else None
    if (
        error.code != direct_denial_http_status
        or not isinstance(denial, dict)
        or denial.get("error") != direct_denial_error
    ):
        print("direct host inference response was not an OpenShell policy denial", file=sys.stderr)
        sys.exit(1)
    if detail != direct_denial_detail:
        print(
            "direct host inference OpenShell policy-denial contract v%s format drifted"
            % direct_denial_contract_version,
            file=sys.stderr,
        )
        sys.exit(1)
except urllib.error.URLError as error:
    reason = error.reason
    if not isinstance(reason, ConnectionRefusedError) or reason.errno != errno.ECONNREFUSED:
        print("direct host inference deny could not be proven", file=sys.stderr)
        sys.exit(1)

print("INFERENCE_SMOKE_OK " + content.strip()[:200])
`.trim();
}
