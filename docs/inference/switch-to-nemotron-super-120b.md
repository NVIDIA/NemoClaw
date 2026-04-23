---
title:
  page: "Switch NemoClaw to Nemotron 3 Super 120B (Brev-Hosted)"
  nav: "Nemotron 3 Super 120B"
description: "End-to-end guide to change the default NemoClaw model from OpenAI GPT-5.4 to NVIDIA Nemotron 3 Super 120B hosted on a Brev endpoint."
keywords: ["nemotron", "nemotron-3-super-120b", "brev", "custom endpoint", "model switch"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "inference_routing", "nemotron", "brev"]
content:
  type: how_to
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Switch NemoClaw to Nemotron 3 Super 120B (Brev-Hosted)

This guide walks you through switching NemoClaw's default inference model from
OpenAI GPT-5.4 to **NVIDIA Nemotron 3 Super 120B** hosted on a Brev endpoint,
end-to-end.

## Prerequisites

- NemoClaw repository cloned locally
- Docker Desktop installed and running
- `openshell` CLI installed (`openshell --version`)
- `nemoclaw` CLI installed (`nemoclaw --help`)
- A running Nemotron 3 Super 120B endpoint (this guide uses Brev)

### Verify Your Endpoint

Before starting, confirm the endpoint is healthy:

```bash
curl https://nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com/v1/health/ready
```

Expected response:

```json
{"object":"health.response","message":"Service is ready","status":"ok"}
```

Test a chat completion:

```bash
curl https://nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/nemotron-3-super-120b-a12b",
    "messages": [{"role": "user", "content": "Say hello."}],
    "max_tokens": 50,
    "temperature": 0.2
  }'
```

---

## Overview of Changes

Four files need to be modified:

| # | File | What Changes |
|---|------|-------------|
| 1 | `Dockerfile` | Default model, endpoint URL, and model catalog patch |
| 2 | `scripts/nemoclaw-start.sh` | Startup default model and auth profile |
| 3 | `nemoclaw-blueprint/blueprint.yaml` | Default inference profile |
| 4 | `nemoclaw-blueprint/policies/openclaw-sandbox.yaml` | Network policy to allow Brev endpoint |

---

## Step 1: Update the Dockerfile

The Dockerfile builds the sandbox container image. It patches the OpenClaw model
catalog and writes the default `openclaw.json` configuration.

Open `Dockerfile` and make three changes:

### 1a. Change the Model Catalog Patch

Find the section that patches the OpenClaw model catalog (around line 42):

**Before:**

```dockerfile
# Patch OpenClaw's model catalog: replace Meta Llama 3.3 70B with OpenAI GPT-5.4
# (OpenClaw's embedded catalog doesn't include this model yet)
RUN find /usr/local/lib/node_modules/openclaw/dist -name "*.js" \
      -exec grep -l "meta/llama-3.3-70b-instruct" {} \; \
    | xargs -I{} sed -i \
        -e 's|meta/llama-3.3-70b-instruct|gpt-5.4|g' \
        -e 's|Meta Llama 3.3 70B Instruct|OpenAI GPT-5.4|g' \
        {}
# GPT-5.4 supports reasoning; flip the flag and bump maxTokens
RUN find /usr/local/lib/node_modules/openclaw/dist -name "*.js" \
      -exec grep -l "gpt-5.4" {} \; \
    | xargs -I{} python3 -c "import re,sys;\
s=open('{}').read();\
s=re.sub(r'(id:\\s*\"gpt-5.4.*?reasoning:\\s*)false',r'\\1true',s,flags=re.DOTALL);\
s=re.sub(r'(id:\\s*\"gpt-5.4.*?maxTokens:\\s*)4096',r'\\g<1>8192',s,flags=re.DOTALL);\
open('{}','w').write(s)"
```

**After:**

```dockerfile
# Patch OpenClaw's model catalog: replace Meta Llama 3.3 70B with Nemotron 3 Super 120B
# (OpenClaw's embedded catalog doesn't include this model yet)
RUN find /usr/local/lib/node_modules/openclaw/dist -name "*.js" \
      -exec grep -l "meta/llama-3.3-70b-instruct" {} \; \
    | xargs -I{} sed -i \
        -e 's|meta/llama-3.3-70b-instruct|nvidia/nemotron-3-super-120b-a12b|g' \
        -e 's|Meta Llama 3.3 70B Instruct|Nemotron 3 Super 120B|g' \
        {}
# Bump maxTokens for Nemotron 3 Super 120B
RUN find /usr/local/lib/node_modules/openclaw/dist -name "*.js" \
      -exec grep -l "nvidia/nemotron-3-super-120b-a12b" {} \; \
    | xargs -I{} python3 -c "import re,sys;\
s=open('{}').read();\
s=re.sub(r'(id:\\s*\"nvidia/nemotron-3-super-120b-a12b.*?maxTokens:\\s*)4096',r'\\g<1>8192',s,flags=re.DOTALL);\
open('{}','w').write(s)"
```

### 1b. Change the Default openclaw.json Configuration

Find the `RUN python3 -c` block that writes `openclaw.json` (around line 66):

**Before:**

```dockerfile
# Write openclaw.json: set OpenAI as default provider, route through
# OpenAI API directly. openshell injects credentials via the provider configuration.
RUN python3 -c "\
import json, os; \
config = { \
    'agents': {'defaults': {'model': {'primary': 'gpt-5.4'}}}, \
    'models': {'mode': 'merge', 'providers': {'openai': { \
        'baseUrl': 'https://api.openai.com/v1', \
        'apiKey': 'openshell-managed', \
        'api': 'openai-completions', \
        'models': [{'id': 'gpt-5.4', 'name': 'OpenAI GPT-5.4', 'reasoning': True, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 131072, 'maxTokens': 8192}] \
    }}} \
}; \
path = os.path.expanduser('~/.openclaw/openclaw.json'); \
json.dump(config, open(path, 'w'), indent=2); \
os.chmod(path, 0o600)"
```

**After:**

```dockerfile
# Write openclaw.json: set Nemotron 3 Super 120B as default provider, route through
# Brev-hosted endpoint. No API key required for this endpoint.
RUN python3 -c "\
import json, os; \
config = { \
    'agents': {'defaults': {'model': {'primary': 'nvidia/nemotron-3-super-120b-a12b'}}}, \
    'models': {'mode': 'merge', 'providers': {'openai': { \
        'baseUrl': 'https://nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com/v1', \
        'apiKey': 'no-key-required', \
        'api': 'openai-completions', \
        'models': [{'id': 'nvidia/nemotron-3-super-120b-a12b', 'name': 'Nemotron 3 Super 120B', 'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 131072, 'maxTokens': 8192}] \
    }}} \
}; \
path = os.path.expanduser('~/.openclaw/openclaw.json'); \
json.dump(config, open(path, 'w'), indent=2); \
os.chmod(path, 0o600)"
```

**Key changes:**
- Model ID: `gpt-5.4` → `nvidia/nemotron-3-super-120b-a12b`
- Model name: `OpenAI GPT-5.4` → `Nemotron 3 Super 120B`
- Base URL: `https://api.openai.com/v1` → `https://nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com/v1`
- API key: `openshell-managed` → `no-key-required` (Brev endpoint has no auth)
- Reasoning: `True` → `False`

---

## Step 2: Update the Startup Script

Open `scripts/nemoclaw-start.sh` and make two changes:

### 2a. Change the Default Model in fix_openclaw_config()

Find the line inside the `fix_openclaw_config()` function (around line 33):

**Before:**

```python
cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = 'gpt-5.4'
```

**After:**

```python
cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = 'nvidia/nemotron-3-super-120b-a12b'
```

### 2b. Change the Model Set Command

Find the `openclaw models set` line (around line 171):

**Before:**

```bash
openclaw models set gpt-5.4 > /dev/null 2>&1 || true
```

**After:**

```bash
openclaw models set nvidia/nemotron-3-super-120b-a12b > /dev/null 2>&1 || true
```

### 2c. Update the Auth Profile

Since the Brev endpoint does not require an API key, update the `write_auth_profile()` function:

**Before:**

```bash
write_auth_profile() {
  if [ -z "${OPENAI_API_KEY:-}" ]; then
    return
  fi

  python3 - <<'PYAUTH'
import json
import os
path = os.path.expanduser('~/.openclaw/agents/main/agent/auth-profiles.json')
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump({
    'openai:manual': {
        'type': 'api_key',
        'provider': 'openai',
        'keyRef': {'source': 'env', 'id': 'OPENAI_API_KEY'},
        'profileId': 'openai:manual',
    }
}, open(path, 'w'))
os.chmod(path, 0o600)
PYAUTH
}
```

**After:**

```bash
write_auth_profile() {
  python3 - <<'PYAUTH'
import json
import os
path = os.path.expanduser('~/.openclaw/agents/main/agent/auth-profiles.json')
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump({
    'brev-nemotron:manual': {
        'type': 'api_key',
        'provider': 'openai',
        'keyRef': {'source': 'literal', 'id': 'no-key-required'},
        'profileId': 'brev-nemotron:manual',
    }
}, open(path, 'w'))
os.chmod(path, 0o600)
PYAUTH
}
```

**Key changes:**
- Removed the `OPENAI_API_KEY` guard (no key needed)
- Changed provider name to `brev-nemotron`
- Changed key source from `env` to `literal`

---

## Step 3: Update the Blueprint

Open `nemoclaw-blueprint/blueprint.yaml` and update the default inference profile:

**Before:**

```yaml
      default:
        provider_type: "openai"
        provider_name: "openai-direct"
        endpoint: "https://api.openai.com/v1"
        model: "gpt-5.4"
        credential_env: "OPENAI_API_KEY"
```

**After:**

```yaml
      default:
        provider_type: "openai"
        provider_name: "brev-nemotron"
        endpoint: "https://nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com/v1"
        model: "nvidia/nemotron-3-super-120b-a12b"
        credential_env: ""
```

**Key changes:**
- Provider name: `openai-direct` → `brev-nemotron`
- Endpoint: OpenAI URL → Brev URL
- Model: `gpt-5.4` → `nvidia/nemotron-3-super-120b-a12b`
- Credential env: cleared (no API key required)

---

## Step 4: Update the Network Policy

The sandbox network policy must allow outbound traffic to the Brev endpoint.

Open `nemoclaw-blueprint/policies/openclaw-sandbox.yaml` and update the `nvidia` network policy:

**Before:**

```yaml
  nvidia:
    name: nvidia
    endpoints:
      - host: api.openai.com
        port: 443
        protocol: rest
        enforcement: enforce
        tls: terminate
        rules:
          - allow: { method: "*", path: "/**" }
    binaries:
      - { path: /usr/local/bin/claude }
      - { path: /usr/local/bin/openclaw }
      - { path: /usr/local/bin/node }
      - { path: /usr/bin/curl }
      - { path: "*" }
```

**After:**

```yaml
  nvidia:
    name: nvidia
    endpoints:
      - host: nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com
        port: 443
        protocol: rest
        enforcement: enforce
        tls: terminate
        rules:
          - allow: { method: "*", path: "/**" }
    binaries:
      - { path: /usr/local/bin/claude }
      - { path: /usr/local/bin/openclaw }
      - { path: /usr/local/bin/node }
      - { path: /usr/bin/curl }
      - { path: "*" }
```

**Key change:**
- Host: `api.openai.com` → `nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com`

---

## Step 5: Deploy

You have two options — full re-onboard or incremental update on a running sandbox.

### Option A: Full Re-Onboard (Clean Setup)

This rebuilds the container image and creates a fresh sandbox:

```bash
# 1. Set a dummy API key (the onboard wizard still prompts for one)
export OPENAI_API_KEY="no-key-required"

# 2. Clear the old sandbox registry
rm -f ~/.nemoclaw/sandboxes.json

# 3. Run the onboard wizard
nemoclaw onboard
```

When prompted:
1. **Sandbox name** — press Enter for `my-assistant` (or type a name)
2. **Inference options** — choose `1` (OpenAI API — now routes to Brev)
3. **Policy presets** — press Enter to accept defaults

### Option B: Incremental Update (Existing Sandbox)

If you already have a running sandbox:

```bash
# 1. Create the inference provider
openshell provider create \
  --name brev-nemotron \
  --type openai \
  --credential "OPENAI_API_KEY=no-key-required" \
  --config "OPENAI_BASE_URL=https://nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com/v1"

# 2. Set the inference route
openshell inference set \
  --provider brev-nemotron \
  --model "nvidia/nemotron-3-super-120b-a12b"

# 3. Apply the updated network policy
openshell policy set \
  --policy nemoclaw-blueprint/policies/openclaw-sandbox.yaml \
  my-assistant

# 4. Verify
openshell inference get
```

Expected output:

```
Provider: brev-nemotron
Model:    nvidia/nemotron-3-super-120b-a12b
```

---

## Step 6: Verify

### Check Sandbox Status

```bash
openshell sandbox list
```

Expected:

```
NAME          NAMESPACE  CREATED              PHASE
my-assistant  openshell  2026-04-02 09:17:17  Ready
```

### Test Health from Inside the Sandbox

Connect to the sandbox and test:

```bash
nemoclaw my-assistant connect
```

Then inside the sandbox:

```bash
curl -s https://nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com/v1/health/ready
```

Expected:

```json
{"object":"health.response","message":"Service is ready","status":"ok"}
```

### Test Chat Completions from Inside the Sandbox

```bash
curl -s https://nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/nemotron-3-super-120b-a12b",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}],
    "max_tokens": 50,
    "temperature": 0.2
  }'
```

Expected: A valid JSON response with `"choices"` containing the model's reply.

### Check Inference Configuration

```bash
openshell inference get
```

Expected:

```
Provider: brev-nemotron
Model:    nvidia/nemotron-3-super-120b-a12b
Version:  1
```

---

## Summary of All Changes

| File | Field | Before | After |
|------|-------|--------|-------|
| `Dockerfile` | Model catalog ID | `gpt-5.4` | `nvidia/nemotron-3-super-120b-a12b` |
| `Dockerfile` | Model catalog name | `OpenAI GPT-5.4` | `Nemotron 3 Super 120B` |
| `Dockerfile` | openclaw.json baseUrl | `https://api.openai.com/v1` | `https://nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com/v1` |
| `Dockerfile` | openclaw.json apiKey | `openshell-managed` | `no-key-required` |
| `scripts/nemoclaw-start.sh` | Default model | `gpt-5.4` | `nvidia/nemotron-3-super-120b-a12b` |
| `scripts/nemoclaw-start.sh` | Auth profile | `openai:manual` (env-based) | `brev-nemotron:manual` (literal) |
| `nemoclaw-blueprint/blueprint.yaml` | provider_name | `openai-direct` | `brev-nemotron` |
| `nemoclaw-blueprint/blueprint.yaml` | endpoint | `https://api.openai.com/v1` | `https://nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com/v1` |
| `nemoclaw-blueprint/blueprint.yaml` | model | `gpt-5.4` | `nvidia/nemotron-3-super-120b-a12b` |
| `nemoclaw-blueprint/blueprint.yaml` | credential_env | `OPENAI_API_KEY` | `""` (empty) |
| `policies/openclaw-sandbox.yaml` | nvidia endpoint host | `api.openai.com` | `nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com` |

---

## Troubleshooting

### Connection refused from sandbox

The network policy may not be applied. Re-apply it:

```bash
openshell policy set --policy nemoclaw-blueprint/policies/openclaw-sandbox.yaml my-assistant
```

### Model not found error

Ensure the model ID is exactly `nvidia/nemotron-3-super-120b-a12b` (case-sensitive).
Verify available models on the endpoint:

```bash
curl -s https://nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com/v1/models
```

### Sandbox stuck in non-Ready state

Check sandbox logs:

```bash
nemoclaw my-assistant logs --follow
```

### Old model still being used

The startup script may have cached the old config. Rebuild the sandbox:

```bash
rm -f ~/.nemoclaw/sandboxes.json
openshell sandbox delete my-assistant
export OPENAI_API_KEY="no-key-required"
nemoclaw onboard
```

### Switching back to OpenAI GPT-5.4

To revert, either undo all file changes and re-onboard, or update the
inference route at runtime (no rebuild needed):

```bash
openshell provider create --name openai-direct --type openai \
  --credential "OPENAI_API_KEY=$OPENAI_API_KEY" \
  --config "OPENAI_BASE_URL=https://api.openai.com/v1"

openshell inference set --provider openai-direct --model gpt-5.4
```

---

## Related Topics

- [Use a Custom LLM Provider](./custom-llm-provider.md)
- [Switch Inference Models at Runtime](./switch-inference-providers.md)
- [Inference Profiles Reference](../reference/inference-profiles.md)
- [Network Policy — Approve Network Requests](../network-policy/approve-network-requests.md)
