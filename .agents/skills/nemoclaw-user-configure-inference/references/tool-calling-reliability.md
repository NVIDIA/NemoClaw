<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tool-Calling Reliability for Local Inference

Use this reference when a local model returns raw JSON in the TUI instead of
dispatching a tool.

The failure usually looks like assistant text containing a JSON object such as:

```json
{"arguments":{"query":"robotics"},"name":"memory_search"}
```

If that appears as normal assistant text, OpenClaw cannot dispatch the tool
because the inference response did not include a structured `tool_calls` field.

## Choice Guide

| Workload | Ollama is usually sufficient | Prefer vLLM with a parser |
|---|---|---|
| Plain chat | Yes | Optional |
| Embeddings-only or retrieval setup | Yes | Optional |
| One simple tool with short prompts | Often | Optional |
| Agent loops with several tools | Risky | Yes |
| Long system prompts or sender metadata | Risky | Yes |
| Multi-turn tool dispatch | Risky | Yes |

For OpenClaw-style agent loops with multiple tools, long instructions, or
multi-turn dispatch, use an OpenAI-compatible `/v1/chat/completions` server with
a tool-call parser. vLLM is the common local choice.

## Recommended vLLM Shape

For Hermes 3 style models:

```console
$ vllm serve /models/Hermes-3-Llama-3.1-8B \
  --served-model-name hermes-3-llama-3.1-8b \
  --enable-auto-tool-choice \
  --tool-call-parser hermes \
  --port 8000
```

For persistent NemoClaw use, rerun onboarding against that endpoint:

```console
$ NEMOCLAW_PROVIDER=custom \
  NEMOCLAW_ENDPOINT_URL=http://localhost:8000/v1 \
  NEMOCLAW_MODEL=hermes-3-llama-3.1-8b \
  COMPATIBLE_API_KEY=dummy \
  nemoclaw onboard --non-interactive
```

If the endpoint requires a real key, set `COMPATIBLE_API_KEY` to that key.

## Advanced Temporary Repointing

NemoClaw-managed sandboxes normally block direct `openclaw config set` writes
inside the sandbox because those edits do not survive rebuilds. Prefer rerunning
`nemoclaw onboard` for persistent changes.

For a mutable OpenClaw config, a batch file can look like:

```json
{
  "models": {
    "providers": {
      "vllm-local": {
        "baseUrl": "http://host.openshell.internal:8000/v1",
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

Apply it only where OpenClaw config writes are allowed:

```console
$ openclaw config set --batch-file /sandbox/.openclaw/vllm-tool-calls.json
```

After testing, persist the working provider through `nemoclaw onboard`.

## Verify the Fix

- The TUI no longer shows JSON blobs as assistant text.
- The gateway log shows tool dispatch and a follow-up answer.
- `nemoclaw <name> status` reports the local vLLM or compatible endpoint.

If JSON still appears as text, confirm that vLLM was started with both
`--enable-auto-tool-choice` and the model-appropriate `--tool-call-parser`.
