<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Use a Local Inference Server: Details

## Authenticated Reverse Proxy

On non-WSL hosts, NemoClaw keeps Ollama bound to `127.0.0.1:11434` and starts a token-gated reverse proxy on `0.0.0.0:11435`.
The native install/start paths also reset NemoClaw-managed systemd launches to the loopback binding.
Containers and other hosts on the local network reach Ollama only through the
proxy, which validates a Bearer token before forwarding requests.
On that native path, NemoClaw never exposes Ollama without authentication.

WSL Ollama paths do not use this proxy.
Windows-host Ollama uses the Windows daemon through `host.docker.internal`.

For non-WSL Ollama setups, the onboard wizard manages the proxy automatically:

- Generates a random 24-byte token on first run and stores it in
  `~/.nemoclaw/ollama-proxy-token` with `0600` permissions.
- Starts the proxy after Ollama and verifies it before continuing.
- Cleans up stale proxy processes from previous runs.
- Probes the sandbox Docker network path to the proxy before committing the inference route.
- Stops matching proxy processes during uninstall before deleting NemoClaw state.
- Reuses the persisted token after a host reboot so you do not need to re-run
  onboard.

On native Linux hosts, a firewall can allow the host proxy health check while still blocking sandbox containers on the OpenShell Docker bridge.
When the sandbox-side proxy probe fails with a TCP error, onboarding exits before it saves the inference route and prints a command like:

```console
$ sudo ufw allow from <openshell-docker-subnet> to any port 11435 proto tcp
$ nemoclaw onboard
```

If the probe cannot run, for example because Docker Desktop or WSL uses a different host routing model, onboarding continues and relies on the regular proxy health check.

The sandbox provider is configured to use proxy port `11435` with the generated
token as its `OPENAI_API_KEY` credential.
OpenShell's L7 proxy injects the token at egress, so the agent inside the
sandbox never sees the token directly.

All proxy endpoints require the Bearer token, including `GET /api/tags`.
Internal health and reachability checks run via the proxy treat any HTTP
response (including `401`) as proof the proxy is alive — they only fail
when nothing answers at all.

If Ollama is already running on a non-loopback address when you start onboard,
the wizard restarts it on `127.0.0.1:11434` so the proxy is the only network
path to the model server.

### Non-Interactive Setup

Set the following environment variables for scripted or CI/CD deployments.

```console
$ NEMOCLAW_PROVIDER=custom \
  NEMOCLAW_ENDPOINT_URL=http://localhost:8000/v1 \
  NEMOCLAW_MODEL=meta-llama/Llama-3.1-8B-Instruct \
  COMPATIBLE_API_KEY=dummy \
  nemoclaw onboard --non-interactive
```

| Variable | Purpose |
|---|---|
| `NEMOCLAW_PROVIDER` | Set to `custom` for an OpenAI-compatible endpoint. |
| `NEMOCLAW_ENDPOINT_URL` | Base URL of the local server. |
| `NEMOCLAW_MODEL` | Model ID as reported by the server. |
| `COMPATIBLE_API_KEY` | API key for the endpoint. Use any non-empty value if authentication is not required. |

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

### Non-Interactive Setup

Use an already-running vLLM server:

```console
$ NEMOCLAW_PROVIDER=vllm \
  nemoclaw onboard --non-interactive
```

Install or start managed vLLM when a supported profile is detected.
On DGX Spark and DGX Station, `NEMOCLAW_PROVIDER=install-vllm` is enough for non-interactive runs; add `NEMOCLAW_EXPERIMENTAL=1` on generic Linux NVIDIA GPU hosts.

```console
$ NEMOCLAW_PROVIDER=install-vllm \
  nemoclaw onboard --non-interactive
```

NemoClaw records the model returned by vLLM's `/v1/models` endpoint.
Start vLLM with the model you want before onboarding if you manage the server yourself.

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
During local Ollama setup, NemoClaw treats host-side curl process timeouts as retryable probe failures and retries with a larger timeout before it reports a validation failure.
NemoClaw also retries Docker runtime detection with a longer `docker info` timeout before it chooses the local inference route.
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
