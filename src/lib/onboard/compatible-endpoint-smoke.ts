// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../core/shell-quote";
import { INFERENCE_ROUTE_URL, MANAGED_PROVIDER_ID } from "../inference/config";

type CompatibleEndpointSmokeAgent = {
  name?: string | null;
} | null | undefined;

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

export function spawnOutputToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  if (value == null) return "";
  return String(value);
}

export function buildCompatibleEndpointSandboxSmokeScript(model: string): string {
  return `
set -eu
MODEL=${shellQuote(model)}
CONFIG=/sandbox/.openclaw/openclaw.json

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

python3 - "$MODEL" >"$payload_file" <<'PYPAYLOAD'
import json
import sys

model = sys.argv[1]
print(json.dumps({
    "model": model,
    "messages": [
        {"role": "user", "content": "Reply with exactly: PONG"}
    ],
    "max_tokens": 32,
}))
PYPAYLOAD

curl -sS --connect-timeout 10 --max-time 60 \
    "${INFERENCE_ROUTE_URL}/chat/completions" \
    -H "Content-Type: application/json" \
    -d "@$payload_file" >"$response_file" 2>"$error_file" || {
  rc=$?
  printf 'curl exit %s: ' "$rc" >&2
  cat "$error_file" >&2
  exit "$rc"
}

python3 - "$response_file" <<'PYRESP'
import json
import sys

path = sys.argv[1]
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

content = (
    data.get("choices", [{}])[0]
    .get("message", {})
    .get("content")
)
if not isinstance(content, str) or not content.strip():
    print("inference.local response did not contain choices[0].message.content: %s" % json.dumps(data)[:1000], file=sys.stderr)
    sys.exit(1)

print("INFERENCE_SMOKE_OK " + content.strip()[:200])
PYRESP
`.trim();
}

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
