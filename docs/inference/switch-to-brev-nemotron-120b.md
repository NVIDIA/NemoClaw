---
title:
  page: "Fresh Setup: NemoClaw with Brev-Hosted Nemotron 3 Super 120B"
  nav: "Brev Nemotron 3 Super 120B"
description: "End-to-end guide to switch NemoClaw from the default NVIDIA NIM cloud endpoint to a Brev-hosted Nemotron 3 Super 120B instance — no API key required."
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

# Fresh Setup: NemoClaw with Brev-Hosted Nemotron 3 Super 120B

Prerequisites: Docker running, openshell CLI installed, a Brev-hosted Nemotron 3 Super 120B
endpoint accessible. **No API key required** — the Brev endpoint has open access.

---

## Step 1 — Verify your Brev endpoint

Confirm the endpoint is healthy before making any changes:

```bash
curl https://nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com/v1/health/ready
# Expected: {"object":"health.response","message":"Service is ready","status":"ok"}
```

---

## Step 2 — Fix the Dockerfile model primary (line 70)

The Dockerfile writes `openclaw.json` at build time. The model primary must use
the fully-qualified catalog key (`openai/nvidia/nemotron-3-super-120b-a12b`), not
the bare model ID.

```python
# Before
'agents': {'defaults': {'model': {'primary': 'nvidia/nemotron-3-super-120b-a12b'}}},

# After
'agents': {'defaults': {'model': {'primary': 'openai/nvidia/nemotron-3-super-120b-a12b'}}},
```

Everything else in the Dockerfile stays the same (provider key `openai`, baseUrl, apiKey, model ID in provider).

---

## Step 3 — Fix `scripts/nemoclaw-start.sh`

Three changes in this file:

### 3a. Add model catalog registration to `fix_openclaw_config()`

The `fix_openclaw_config()` function writes `openclaw.json` at runtime but was only
setting the model primary — it never registered the model in the catalog. Add the
provider/model block so OpenClaw knows what the model is:

```python
cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = 'openai/nvidia/nemotron-3-super-120b-a12b'

# Register the model in the catalog so OpenClaw recognises it
models = cfg.setdefault('models', {})
models['mode'] = 'merge'
openai_prov = models.setdefault('providers', {}).setdefault('openai', {})
openai_prov['baseUrl'] = 'https://nemotron-3-super-120b-a12b-6ucal9h69.brevlab.com/v1'
openai_prov['apiKey'] = 'no-key-required'
openai_prov['api'] = 'openai-completions'
openai_prov['models'] = [
    {
        'id': 'nvidia/nemotron-3-super-120b-a12b',
        'name': 'Nemotron 3 Super 120B',
        'reasoning': False,
        'input': ['text'],
        'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
        'contextWindow': 131072,
        'maxTokens': 8192,
    }
]
```

### 3b. Fix the `openclaw models set` argument (line 167)

```bash
# Before
openclaw models set nvidia/nemotron-3-super-120b-a12b > /dev/null 2>&1 || true

# After
openclaw models set openai/nvidia/nemotron-3-super-120b-a12b > /dev/null 2>&1 || true
```

### 3c. Reorder the startup sequence

`fix_openclaw_config` must run **before** `openclaw models set`, otherwise the model
catalog is empty when OpenClaw tries to resolve the model.

```bash
# Before (broken order)
echo 'Setting up NemoClaw...'
openclaw doctor --fix > /dev/null 2>&1 || true
openclaw models set openai/nvidia/nemotron-3-super-120b-a12b > /dev/null 2>&1 || true
write_auth_profile
export CHAT_UI_URL PUBLIC_PORT
fix_openclaw_config
openclaw plugins install /opt/nemoclaw > /dev/null 2>&1 || true

# After (working order)
echo 'Setting up NemoClaw...'
export CHAT_UI_URL PUBLIC_PORT
fix_openclaw_config
write_auth_profile
openclaw doctor --fix > /dev/null 2>&1 || true
openclaw models set openai/nvidia/nemotron-3-super-120b-a12b > /dev/null 2>&1 || true
openclaw plugins install /opt/nemoclaw > /dev/null 2>&1 || true
```

---

## Step 4 — Build and verify

```bash
docker build -t nemoclaw .
docker run --rm nemoclaw -c 'openclaw models list'
```

Expected output:

```
Model                                      Input      Ctx      Local Auth  Tags
openai/nvidia/nemotron-3-super-120b-a12b   text       128k     no    yes   default,configured
```

The model should show with full metadata (Input, Ctx, Auth populated) and no `missing` tag.

---

## Step 5 — Run the onboard wizard

```bash
nemoclaw onboard
```

---

## Step 6 — Verify end-to-end

```bash
# Test via OpenClaw agent
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  -o "ProxyCommand=$(which openshell) ssh-proxy --gateway-name nemoclaw --name my-assistant" \
  sandbox@openshell-my-assistant \
  'openclaw agent --agent main --message "Say hello in one sentence"'
# Expected: a response from Nemotron 3 Super 120B
```

Dashboard available at: **http://127.0.0.1:18789/**

---

## Why this fixes it

OpenClaw resolves models as `{provider_key}/{model_id}`. The model is registered under
the `openai` provider with ID `nvidia/nemotron-3-super-120b-a12b`, so its catalog key is
`openai/nvidia/nemotron-3-super-120b-a12b`.

The "Unknown model" error had two causes:

1. **Missing provider prefix** — the model primary was `nvidia/nemotron-3-super-120b-a12b`
   instead of `openai/nvidia/nemotron-3-super-120b-a12b`, so no catalog entry matched.

2. **Missing catalog registration at runtime** — `fix_openclaw_config()` set the model
   primary but never wrote the `models.providers.openai` block, so OpenClaw had no model
   definition. The startup also ran `openclaw models set` before `fix_openclaw_config`,
   meaning the catalog was empty when the command executed.

The model ID inside the provider config stays as `nvidia/nemotron-3-super-120b-a12b` —
this is what gets sent to the Brev endpoint in API calls, which is what the endpoint expects.

---

## Troubleshooting

### `Unknown model: nvidia/nemotron-3-super-120b-a12b`

The model primary is not using the fully-qualified catalog key. Ensure the primary is
`openai/nvidia/nemotron-3-super-120b-a12b` (with `openai/` prefix).

Check with:
```bash
openclaw models list
```

### Model shows as `missing` in `openclaw models list`

The model is referenced in the agent config but not found in any provider catalog. Verify
that `openclaw.json` has the provider config:

```bash
cat ~/.openclaw/openclaw.json | python3 -m json.tool
```

Look for `models.providers.openai.models` containing an entry with
`"id": "nvidia/nemotron-3-super-120b-a12b"`.

---

## Related Topics

- [Use a Custom LLM Provider](./custom-llm-provider.md)
- [Switch Inference Models at Runtime](./switch-inference-providers.md)
- [Inference Profiles Reference](../reference/inference-profiles.md)
- [Network Policy — Approve Network Requests](../network-policy/approve-network-requests.md)
