<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Use a Local Inference Server: Details

## Non-Interactive Setup

```console
$ NEMOCLAW_PROVIDER=ollama \
  NEMOCLAW_MODEL=qwen2.5:14b \
  nemoclaw onboard --non-interactive --yes
```

If `NEMOCLAW_MODEL` is not set, NemoClaw selects a default model based on available memory.
If `NEMOCLAW_MODEL` names a known bootstrap model (for example `qwen3.6:35b`) that does not fit the host's currently available GPU memory, NemoClaw warns and falls back to the largest known model that does fit.
Unknown or custom tags (any value the bootstrap registry has not seen) are still passed through; the Ollama runner validates the choice itself.

`--yes` (or `NEMOCLAW_YES=1`) authorises the Ollama model download without an interactive confirmation prompt.
Under `--non-interactive`, `--yes` (or `NEMOCLAW_YES=1`) is required to authorise the download — onboard exits otherwise, since it cannot prompt.
Run onboard without `--non-interactive` to get the interactive `[y/N]` prompt that shows the model size before downloading.

| Variable | Purpose |
|---|---|
| `NEMOCLAW_PROVIDER` | Set to `ollama`. |
| `NEMOCLAW_MODEL` | Ollama model tag to use. Optional. |
| `NEMOCLAW_YES` | Set to `1` to auto-accept the model-download confirmation prompt. Optional. |

### Selecting the API Path

For the compatible-endpoint provider, `/v1/chat/completions` is the default.
NemoClaw tests streaming events during onboarding and uses chat completions
without probing the Responses API.

To opt in to `/v1/responses`, set `NEMOCLAW_PREFERRED_API` before running onboard:

```console
$ NEMOCLAW_PREFERRED_API=openai-responses nemoclaw onboard
```

The wizard then probes `/v1/responses` and only selects it when streaming
support is complete.
If the probe fails, the wizard falls back to `/v1/chat/completions`
automatically.
You can use this variable in both interactive and non-interactive mode.

| Variable | Values | Default |
|---|---|---|
| `NEMOCLAW_PREFERRED_API` | `openai-completions`, `openai-responses` | `openai-completions` for compatible endpoints |

If you already onboarded and the sandbox is failing at runtime, re-run
`nemoclaw onboard` to re-probe the endpoint and bake the correct API path
into the image.
Refer to [Switch Inference Models](switch-inference-providers.md) for details.

## Anthropic-Compatible Server

If your local server implements the Anthropic Messages API (`/v1/messages`), choose **Other Anthropic-compatible endpoint** during onboarding instead.

```console
$ nemoclaw onboard
```

For non-interactive setup, use `NEMOCLAW_PROVIDER=anthropicCompatible` and set `COMPATIBLE_ANTHROPIC_API_KEY`.

```console
$ NEMOCLAW_PROVIDER=anthropicCompatible \
  NEMOCLAW_ENDPOINT_URL=http://localhost:8080 \
  NEMOCLAW_MODEL=my-model \
  COMPATIBLE_ANTHROPIC_API_KEY=dummy \
  nemoclaw onboard --non-interactive
```

### Override the Managed-vLLM Model

Managed vLLM serves the profile default unless you select a different registry entry.
Export `NEMOCLAW_VLLM_MODEL=<slug>` before invoking the installer to choose a different model from the registry.
NemoClaw uses the matching `vllm serve` flags, including the reasoning parser, tool-call parser, and `--max-model-len`.
Recognised slugs:

| Slug | Hugging Face model | Notes |
|---|---|---|
| `qwen3.6-27b` | `Qwen/Qwen3.6-27B-FP8` | Default on DGX Spark and DGX Station profiles |
| `nemotron-3-nano-4b` | `nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8` | Default on the generic Linux + NVIDIA GPU profile |
| `deepseek-r1-distill-70b` | `deepseek-ai/DeepSeek-R1-Distill-Llama-70B` | Gated. Requires Hugging Face license acceptance |

The slug is case-insensitive; the full Hugging Face id is also accepted.
An unrecognised value fails fast with a list of valid slugs.

Gated models require a Hugging Face token; export it before onboarding so NemoClaw can forward it into the managed vLLM container:

```console
$ export HF_TOKEN=<your-hf-token>
$ NEMOCLAW_PROVIDER=install-vllm \
  NEMOCLAW_VLLM_MODEL=deepseek-r1-distill-70b \
  nemoclaw onboard --non-interactive
```

`HUGGING_FACE_HUB_TOKEN` is accepted as an alternative.
The token check runs on the host before any docker pull, so a missing or empty token aborts onboarding before bandwidth is spent on a 401.

## Timeout Configuration

Local inference requests use a default timeout of 180 seconds.
Large prompts on hardware such as DGX Spark can exceed shorter timeouts, so NemoClaw sets a higher default for Ollama, vLLM, NIM, and compatible-endpoint setup.

To override the timeout, set the `NEMOCLAW_LOCAL_INFERENCE_TIMEOUT` environment variable before onboarding:

```console
$ export NEMOCLAW_LOCAL_INFERENCE_TIMEOUT=300
$ nemoclaw onboard
```

The value is in seconds.
This setting is baked into the sandbox at build time.
Changing it after onboarding requires re-running `nemoclaw onboard`.

`NEMOCLAW_LOCAL_INFERENCE_TIMEOUT` only governs the inference-server validation probe.
The post-create readiness wait (image build, gateway upload, in-sandbox boot) has its own budget, `NEMOCLAW_SANDBOX_READY_TIMEOUT`, also defaulting to 180 seconds.
On hosts where the sandbox image takes minutes to build or upload — large quantised models, DGX Station first runs, or remote VMs over a slow link — raise both together:

```console
$ export NEMOCLAW_LOCAL_INFERENCE_TIMEOUT=300
$ export NEMOCLAW_SANDBOX_READY_TIMEOUT=600
$ nemoclaw onboard
```

If onboard ends with `Sandbox '<name>' was created but did not become ready within 180s`, refer to Troubleshooting (use the `nemoclaw-user-reference` skill).

## Verify the Configuration

After onboarding completes, confirm the active provider and model.

```console
$ nemoclaw <name> status
```

The output shows the provider label (for example, "Local vLLM" or "Other OpenAI-compatible endpoint") and the active model.
For Local Ollama, status also checks the authenticated proxy when a proxy token is available.
If `Inference` is healthy but `Inference (auth proxy)` is not, rerun onboarding to repair the proxy path that sandbox requests use.

## Switch Models at Runtime

You can change the model without re-running onboard.
Refer to [Switch Inference Models](switch-inference-providers.md) for the full procedure.

For compatible endpoints, the command is:

```console
$ nemoclaw inference set --provider compatible-endpoint --model <model-name>
```

If the provider itself needs to change (for example, switching from vLLM to a cloud API), pass the new provider to `nemoclaw inference set`.
