<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# #4851 runtime validation — Ultra 550B tool-less system-prompt injection

Repository-verifiable acceptance evidence for [PR #5085](https://github.com/NVIDIA/NemoClaw/pull/5085).

The unit tests in `test/nemotron-inference-fix.test.ts` prove request mutation, Content-Length refresh, and the 12 inject/skip branches via stubbed http + real fetch/undici. They do not prove the upstream model-output behavior the issue's expected result asks for. That requires a live call to NVIDIA Endpoints, which can't run in unit CI without API-key secret infrastructure.

This runbook is the maintained runtime-validation path. Anyone reviewing #4851 acceptance can run it directly against `inference-api.nvidia.com` and confirm the model returns `content` with both file-creation code and the run command after the preload's system message is injected.

## When to run

- Before merging any PR that changes `nemoclaw-blueprint/scripts/nemotron-inference-fix.js` or `EXECUTION_TOOL_NAMES`.
- When a NemoClaw release pins a new OpenClaw version that may change the upstream chat template behavior on Ultra 550B.
- If QA reopens #4851.

## Prerequisites

- An NVIDIA API key with access to `nvidia/nemotron-3-ultra-550b-a55b` (build.nvidia.com → API Keys).
- `node >= 18`, `curl`, and `jq` (the scenarios below pipe responses through `jq` for readable parsing). Any Linux or macOS host works — this validates upstream model behavior, not local sandbox runtime.

Export the key once for the session:

```bash
export NVIDIA_INFERENCE_API_KEY="nvapi-..."
```

## Scenario A — baseline (no preload, no system message, no tools)

Demonstrates the bug as filed in the issue body.

```bash
curl -sS -X POST https://inference-api.nvidia.com/v1/chat/completions \
  -H "Authorization: Bearer ${NVIDIA_INFERENCE_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/nemotron-3-ultra-550b-a55b",
    "messages": [{"role": "user", "content": "Create a file called hello.py in /tmp with a hello world script, then run it."}],
    "max_tokens": 400,
    "temperature": 0.0
  }' | jq '{
    finish_reason: .choices[0].finish_reason,
    completion_tokens: .usage.completion_tokens,
    reasoning_chars: (.choices[0].message.reasoning_content // "" | length),
    content_chars: (.choices[0].message.content // "" | length),
    content: (.choices[0].message.content // "")
  }'
```

Expected result with `nemotron-3-ultra-550b-a55b` (matches issue body):

- `finish_reason: "stop"`
- `reasoning_chars` ≈ 150–300 (model plans 3 steps internally)
- `content_chars` ≈ 0–60 (model drops file-creation step, may emit only the run command or empty)

## Scenario B — `force_nonempty_content` kwarg only (no preload's system message)

Demonstrates that the existing Nemotron-family kwarg doesn't fix #4851 by itself.

```bash
curl -sS -X POST https://inference-api.nvidia.com/v1/chat/completions \
  -H "Authorization: Bearer ${NVIDIA_INFERENCE_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/nemotron-3-ultra-550b-a55b",
    "messages": [{"role": "user", "content": "Create a file called hello.py in /tmp with a hello world script, then run it."}],
    "max_tokens": 400,
    "temperature": 0.0,
    "chat_template_kwargs": {"force_nonempty_content": true}
  }' | jq '.choices[0].message.content | length'
```

Expected: still ≈ 0–60 chars. The kwarg doesn't change the failure mode.

## Scenario C — preload's full mutation (system message + kwarg)

Demonstrates the fix shipped in this PR.

```bash
curl -sS -X POST https://inference-api.nvidia.com/v1/chat/completions \
  -H "Authorization: Bearer ${NVIDIA_INFERENCE_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/nemotron-3-ultra-550b-a55b",
    "messages": [
      {"role": "system", "content": "You do not have tools to write files or execute commands. When the user asks you to perform such actions, include the complete code or command they would need to run manually. Do not skip steps."},
      {"role": "user", "content": "Create a file called hello.py in /tmp with a hello world script, then run it."}
    ],
    "max_tokens": 400,
    "temperature": 0.0,
    "chat_template_kwargs": {"force_nonempty_content": true}
  }' | jq '{
    finish_reason: .choices[0].finish_reason,
    content_chars: (.choices[0].message.content // "" | length),
    content: (.choices[0].message.content // "")
  }'
```

Expected (`#4851` acceptance):

- `content_chars` ≈ 400–600
- `content` includes BOTH file creation (heredoc, redirection, or full source of `hello.py`) AND the run command (`python3 /tmp/hello.py` or equivalent)
- `finish_reason: "stop"`

This satisfies the issue's "Expected Result, Option A" (`Model explains it lacks a file-write tool and shows the full code the user would need to run manually`).

## Sanitized acceptance transcript

The transcript below was captured by @cjagwani on 2026-06-09 against `inference-api.nvidia.com` from a GCP Brev box. Reproduces the bug behavior in Scenarios A/B and the fix behavior in Scenario C. Use this as the durable acceptance baseline; new runs that differ structurally should update this section (and the dated entry below) rather than the unit tests.

### Scenario A (baseline) — 2026-06-09

```text
finish_reason:     stop
prompt_tokens:     35
completion_tokens: 117
reasoning_chars:   184
content_chars:     1
content:           " "
```

Reasoning content (the model plans 3 steps but emits none of them in `content`):

```text
The user wants me to:
1. Create a file called hello.py in /tmp
2. Put a hello world script in it
3. Run it

I'll use the write tool to create the file and then the bash tool to run it.
```

### Scenario B (force_nonempty_content only) — 2026-06-09

```text
finish_reason:     stop
prompt_tokens:     35
completion_tokens: 131
reasoning_chars:   184
content_chars:     1
content:           " "
```

Same baseline failure mode — the kwarg alone doesn't address #4851.

### Scenario C (full preload mutation) — 2026-06-09

```text
finish_reason:     stop
prompt_tokens:     75
completion_tokens: 187
reasoning_chars:   241
content_chars:     501
```

Content (full text):

````markdown
I'll provide you with the commands to create and run the hello world script manually.

## Create the file

```bash
cat > /tmp/hello.py << 'EOF'
#!/usr/bin/env python3

def main():
    print("Hello, World!")

if __name__ == "__main__":
    main()
EOF
```

## Make it executable (optional)

```bash
chmod +x /tmp/hello.py
```

## Run it

```bash
python3 /tmp/hello.py
```

**Expected output:**

```text
Hello, World!
```

You can copy and paste these commands into your terminal to create and run the script.
````

This satisfies the issue's Option A acceptance condition: model explains it lacks file-write/execute tools and shows the complete code the user would need to run manually, with all 3 planned steps present in `content`.

## Live verification log

- 2026-06-09 — verified by @cjagwani on a GCP Brev box against `inference-api.nvidia.com`. Numbers and content above match this run.

When you re-run this runbook, add a dated entry here so the next reviewer can see how recently the upstream behavior was last confirmed. If the response shape differs materially from the sanitized transcript above, update both this log and the transcript.
