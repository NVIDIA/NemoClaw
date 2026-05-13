<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Tool-Calling Reliability for Local Inference

Local inference is useful for privacy, cost control, and offline development, but
tool-calling agents place stricter demands on the model server than simple chat.
The model server must return structured `tool_calls`, not a JSON-looking string
inside normal assistant text.

Use this page when the TUI shows raw JSON such as:

```json
{"arguments":{"query":"robotics"},"name":"memory_search"}
```

If that appears as text in the assistant reply, OpenClaw cannot dispatch the
tool because the inference response did not include a structured tool call.

## Quick Choice Guide

| Workload | Ollama is usually sufficient | Prefer vLLM with a parser |
|---|---|---|
| Plain chat | Yes | Optional |
| Embeddings-only or retrieval setup | Yes | Optional |
| One simple tool with short prompts | Often | Optional |
| Agent loops with several tools | Risky | Yes |
| Long system prompts or sender metadata | Risky | Yes |
| Multi-turn tool dispatch | Risky | Yes |

Ollama can work well for lightweight local chat and some simple tool surfaces.
For OpenClaw-style agent loops with multiple tools, long instructions, or
multi-turn dispatch, use a server that exposes OpenAI-compatible
`/v1/chat/completions` with a tool-call parser. vLLM is the common local choice.

## Symptom

The common failure mode is:

- The model emits text that looks like a tool call.
- The response does not include a structured `tool_calls` field.
- The gateway treats the response as normal text.
- No tool runs, and the user sees raw JSON in the TUI.

This is different from a network or policy block. `nemoclaw <name> status`,
`nemoclaw <name> logs`, and `nemoclaw debug --quick` can all look healthy while
tool dispatch still fails inside the conversation.

## Recommended Fix

For persistent NemoClaw use, start vLLM with auto tool choice and the parser that
matches your model family, then rerun onboarding and select **Local vLLM
[experimental]** or **Other OpenAI-compatible endpoint**.

For Hermes 3 style models, a known-good vLLM command shape is:

```console
$ vllm serve /models/Hermes-3-Llama-3.1-8B \
  --served-model-name hermes-3-llama-3.1-8b \
  --enable-auto-tool-choice \
  --tool-call-parser hermes \
  --port 8000
```

For a Docker Compose setup:

```yaml
services:
  vllm-nemoclaw:
    image: vllm/vllm-openai:latest
    container_name: vllm-nemoclaw
    restart: unless-stopped
    ports:
      - "8002:8000"
    volumes:
      - /path/to/models:/models:ro
      - /path/to/hf-cache:/root/.cache/huggingface
    ipc: host
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu]
              count: all
    command: >
      --model /models/Hermes-3-Llama-3.1-8B
      --served-model-name hermes-3-llama-3.1-8b
      --enable-auto-tool-choice
      --tool-call-parser hermes
      --gpu-memory-utilization 0.20
      --max-model-len 32768
      --api-key ${VLLM_API_KEY}
```

Then onboard against that endpoint:

```console
$ NEMOCLAW_PROVIDER=custom \
  NEMOCLAW_ENDPOINT_URL=http://localhost:8002/v1 \
  NEMOCLAW_MODEL=hermes-3-llama-3.1-8b \
  COMPATIBLE_API_KEY=$VLLM_API_KEY \
  nemoclaw onboard --non-interactive
```

If the endpoint does not require authentication, set `COMPATIBLE_API_KEY` to any
non-empty placeholder, such as `dummy`.

## Advanced Temporary Repointing

NemoClaw-managed sandboxes normally block direct `openclaw config set` writes
inside the sandbox because those edits do not survive rebuilds. Prefer rerunning
`nemoclaw onboard` for a persistent provider change.

If you are intentionally testing a mutable OpenClaw config, prepare a batch file
like this:

```json
{
  "models": {
    "providers": {
      "vllm-local": {
        "baseUrl": "http://host.openshell.internal:8002/v1",
        "api": "openai",
        "apiKey": "${VLLM_API_KEY}"
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "vllm-local/hermes-3-llama-3.1-8b"
      }
    }
  }
}
```

Apply it only in environments where OpenClaw config writes are allowed:

```console
$ openclaw config set --batch-file /sandbox/.openclaw/vllm-tool-calls.json
```

After testing, persist the working provider through `nemoclaw onboard` so the
sandbox image, OpenShell inference route, and host-managed credentials stay in
sync.

## Verify the Fix

After switching to vLLM, ask for an action that should use a tool. Good signs:

- The TUI does not show JSON blobs as assistant text.
- The gateway log shows tool dispatch and a follow-up answer.
- `nemoclaw <name> status` reports the local vLLM or compatible endpoint as the
  active provider.

If JSON still appears as text, confirm that vLLM was started with both
`--enable-auto-tool-choice` and the correct `--tool-call-parser` value for your
model.

## Next Steps

- Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill)
- Inference Options (use the `nemoclaw-user-configure-inference` skill)
- Switch Inference Models (use the `nemoclaw-user-configure-inference` skill)
