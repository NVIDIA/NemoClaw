# NemoClaw Inference Options

import { AgentOnly } from "../_components/AgentGuide";

NemoClaw supports multiple inference providers.
During onboarding, the NemoClaw onboarding wizard presents a numbered list of providers to choose from.
Your selection determines where NemoClaw routes the agent's inference traffic.

<AgentOnly variant="openclaw">
For OpenClaw onboarding, use `nemoclaw onboard`.
The provider flow is the same, with the NVIDIA Endpoints route available for OpenClaw Agent.
</AgentOnly>

<AgentOnly variant="hermes">
For Hermes onboarding, use `nemoclaw onboard`.
The provider flow is the same, with the Hermes Provider route available for Hermes Agent.
</AgentOnly>

## How Inference Routing Works

The agent inside the sandbox talks to `inference.local`.
It never connects to a provider directly.
OpenShell intercepts inference traffic on the host and forwards it to the provider you selected.

Provider credentials stay on the host.
The sandbox does not receive your API key.
Local Ollama and local vLLM do not require your host `OPENAI_API_KEY`.
NemoClaw uses provider-specific local tokens for those routes, and rebuilds of legacy local-inference sandboxes migrate away from stale OpenAI credential requirements.

## Provider Status

| Provider | Status | Endpoint type | Notes |
|----------|--------|---------------|-------|
| NVIDIA Endpoints | Tested | OpenAI-compatible | Hosted models on integrate.api.nvidia.com |
| OpenAI | Tested | Native OpenAI-compatible | Uses OpenAI model IDs |
| Other OpenAI-compatible endpoint | Tested | Custom OpenAI-compatible | For compatible proxies and gateways |
| Anthropic | Tested | Native Anthropic | Uses anthropic-messages |
| Other Anthropic-compatible endpoint | Tested | Custom Anthropic-compatible | For Claude proxies and compatible gateways |
| Google Gemini | Tested | OpenAI-compatible | Uses Google's OpenAI-compatible endpoint |
| Hermes Provider | Hermes only | OpenAI-compatible route | Available when onboarding Hermes Agent through `nemohermes` |
| Local Ollama | Caveated | Local Ollama API | Available when Ollama is installed or running on the host |
| Local NVIDIA NIM | Experimental | Local OpenAI-compatible | Requires `NEMOCLAW_EXPERIMENTAL=1` and a NIM-capable GPU |
| Local vLLM (already running) | Caveated | Local OpenAI-compatible | Appears in the onboarding menu when NemoClaw detects a server already on `localhost:8000`. No flag required. |
| Local vLLM (managed install/start) | Caveated | Local OpenAI-compatible | Appears by default on DGX Spark and DGX Station. Generic Linux NVIDIA GPU hosts require `NEMOCLAW_EXPERIMENTAL=1` or `NEMOCLAW_PROVIDER=install-vllm`. NemoClaw pulls/starts a vLLM container on a supported NVIDIA GPU host. |

## Provider Options

The onboard wizard presents the following provider options by default.
The first six are always available.
Ollama appears when you have installed or started it on the host.
Local vLLM appears when NemoClaw detects a running vLLM server.
The managed install/start vLLM entry appears by default on DGX Spark and DGX Station, and appears on generic Linux NVIDIA GPU hosts after opt-in.

| Option | Description | Curated models |
|--------|-------------|----------------|
| NVIDIA Endpoints | Routes to models hosted on [build.nvidia.com](https://build.nvidia.com). You can also enter any model ID from the catalog. Set `NVIDIA_API_KEY`. | Nemotron 3 Super 120B, Nemotron 3 Ultra 550B, GLM-5.1, MiniMax M2.7, GPT-OSS 120B, DeepSeek V4 Pro |
| OpenAI | Routes to the OpenAI API. Set `OPENAI_API_KEY`. | `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.4-pro-2026-03-05` |
| Other OpenAI-compatible endpoint | Routes to any server that implements `/v1/chat/completions`. NemoClaw uses `/v1/chat/completions` at runtime by default; set `NEMOCLAW_PREFERRED_API=openai-responses` to allow `/v1/responses` for proxies that implement it, such as some llama.cpp builds. The wizard prompts for a base URL and model name. Works with OpenRouter, LocalAI, llama.cpp, or any compatible proxy. When you enable Telegram messaging, onboarding also runs a bounded sandbox-side smoke check through `https://inference.local/v1/chat/completions`. Set `COMPATIBLE_API_KEY`. | You provide the model name. |
| Anthropic | Routes to the Anthropic Messages API. Set `ANTHROPIC_API_KEY`. | `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-opus-4-6` |
| Other Anthropic-compatible endpoint | Routes to any server that implements the Anthropic Messages API (`/v1/messages`). The wizard prompts for a base URL and model name. Set `COMPATIBLE_ANTHROPIC_API_KEY`. | You provide the model name. |
| Google Gemini | Routes to Google's OpenAI-compatible chat-completions endpoint. NemoClaw skips the Responses-API probe because Gemini does not support `/v1/responses`. Set `GEMINI_API_KEY`. | `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` |
| Hermes Provider | Routes Hermes Agent through the host OpenShell provider registered by NemoClaw when onboarding Hermes Agent. | Curated Hermes Provider models such as `moonshotai/kimi-k2.6`, `openai/gpt-5.4-mini`, and `z-ai/glm-5.1`. |
| Local Ollama | Routes to a local Ollama instance on `localhost:11434`. NemoClaw detects installed models, offers starter models if none are present, pulls and warms the selected model, and validates it. | Selected during onboarding. For more information, refer to [Use a Local Inference Server](../SKILL.md). |
| Model Router | Starts a host-side router on port `4000`, registers it as an OpenAI-compatible provider, and keeps the sandbox pointed at `inference.local`. Set `NEMOCLAW_PROVIDER=routed` for non-interactive setup. | The router pool defines the model names. |

## Choosing the Right Option for Nemotron

NVIDIA Nemotron models expose OpenAI-compatible APIs across every supported deployment surface, so two onboarding options can route to Nemotron.

| Nemotron Host | Onboard Wizard Option | Why |
|---|---|---|
| `build.nvidia.com` (NVIDIA-hosted) | **Option 1: NVIDIA Endpoints** | NemoClaw sets the base URL to `https://integrate.api.nvidia.com/v1` for you and validates the model against the build catalog. |
| Self-hosted NIM container | **Option 3: Other OpenAI-compatible endpoint** | NIM exposes an OpenAI-compatible `/v1/chat/completions` route. Point the base URL at your NIM service and enter the Nemotron model ID. |
| Enterprise NVIDIA AI Enterprise gateway | **Option 3: Other OpenAI-compatible endpoint** | Enterprise gateways front Nemotron with the same OpenAI-compatible contract. Use the gateway's base URL and your enterprise token. |
| vLLM, SGLang, or TRT-LLM serving Nemotron weights | **Option 3: Other OpenAI-compatible endpoint** | Each runtime exposes Nemotron through `/v1/chat/completions`. Use the runtime's base URL and the model ID it reports. |
| Local NIM started by the wizard | **Local NVIDIA NIM** (experimental) | Requires `NEMOCLAW_EXPERIMENTAL=1` and a NIM-capable GPU. NemoClaw pulls and manages the container for you. |

For Option 3, the API key environment variable is `COMPATIBLE_API_KEY`. Set it to whatever credential your endpoint expects, or any non-empty placeholder if your endpoint does not require auth.

## Model Router

The Model Router option uses the `routed` inference profile in `nemoclaw-blueprint/blueprint.yaml`.
When you select it, NemoClaw starts the router proxy on the host, waits for its health endpoint, registers the `nvidia-router` provider with OpenShell, and creates the sandbox with the same `inference.local` route the agent uses for other providers.
The sandbox does not call the router port directly.

The router model pool lives in `nemoclaw-blueprint/router/pool-config.yaml`.
Edit that file to define which models the router can choose from.
The default pool routes between NVIDIA-hosted Nemotron models and uses the `tolerance` value to choose the lowest-cost model whose predicted quality stays within the configured threshold.

```yaml
routing:
  method: prefill
  checkpoint: llm-router/checkpoints/prefill_router_qwen08b.pt
  tolerance: 0.20
  encoder: Qwen/Qwen3.5-0.8B

models:
  - name: nano
    litellm_model: "openai/nvidia/nvidia/Nemotron-3-Nano-30B-A3B"
    cost_per_m_input_tokens: 0.05
    api_base: "https://inference-api.nvidia.com"

  - name: super
    litellm_model: "openai/nvidia/nvidia/nemotron-3-super-v3"
    cost_per_m_input_tokens: 0.10
    api_base: "https://inference-api.nvidia.com"
```

The `tolerance` parameter controls the accuracy-cost tradeoff.

| Value | Behavior |
|-------|----------|
| `0.0` | Always pick the most accurate model. |
| `0.20` | Allow up to 20 percentage points below the best for a cheaper model (default). |
| `1.0` | Always pick the cheapest model. |

The router runs on the host, not inside the sandbox.

```text
Sandbox (agent) ──> OpenShell Gateway (L7 proxy) ──> Model Router (:4000) ──> NVIDIA API
                                                         └── PrefillRouter selects model
```

Credentials flow through the OpenShell provider system.
The sandbox never sees raw API keys.

To use the router in scripted setup, set:

```bash
NEMOCLAW_PROVIDER=routed NVIDIA_API_KEY=<your-key> nemoclaw onboard --non-interactive
```

### Host Python Requirement

The Model Router runs in a host-side virtual environment that NemoClaw creates during onboarding.
NemoClaw probes `python3.13`, `python3.12`, `python3.11`, `python3.10`, and bare `python3`, and adopts the first interpreter that satisfies both of:

- Version inside `[3.10, 3.14)`.
- `ensurepip`, `pyexpat`, `ssl`, and `venv` all import without error.

If no candidate qualifies, onboarding aborts and prints the real failure for each candidate.
This surfaces issues like Homebrew `python@3.14` whose `pyexpat` extension fails to dlopen against the older system `libexpat` on macOS.

To pin a specific interpreter, set `NEMOCLAW_MODEL_ROUTER_PYTHON` to its absolute path before running `nemoclaw onboard`:

```bash
NEMOCLAW_MODEL_ROUTER_PYTHON=/opt/homebrew/bin/python3.12 nemoclaw onboard
```

The pin is strict.
NemoClaw probes only that interpreter and aborts with the failure reason if it does not qualify, rather than silently falling back to a different python on `PATH`.
NemoClaw rejects relative command names such as `python3.12`.
Use `command -v python3.12` to find the absolute path.
If `python -m venv` itself fails for a probe-clean interpreter (for example, a corrupt ensurepip seed), NemoClaw retries with the next healthy candidate when no pin is set; with a pin set, the failure stops onboarding so you can fix or repoint the pinned python.

## Caveated Local Options

The following local inference options have caveats.
Local NIM and generic Linux managed vLLM install/start require `NEMOCLAW_EXPERIMENTAL=1`; DGX Spark and DGX Station managed vLLM entries appear by default.
An already-running vLLM server appears directly in the onboarding selection list.

| Option | Condition | Notes |
|--------|-----------|-------|
| Local NVIDIA NIM | NIM-capable GPU detected | Pulls and manages a NIM container. |
| Local vLLM | vLLM running on `localhost:8000`, or a supported DGX Spark, DGX Station, or Linux NVIDIA GPU profile | Auto-detects the loaded model when vLLM is already running. Can install or start a managed vLLM container by default on DGX Spark/Station and after opt-in on generic Linux NVIDIA GPU hosts. |

For setup instructions, refer to [Use a Local Inference Server](../SKILL.md).

## Validation

NemoClaw validates the selected provider and model before creating the sandbox.
If credential validation fails, the wizard asks whether to re-enter the API key, choose a different provider, retry, or exit.
The wizard retries transient upstream validation failures before it reports a provider failure.
The `nvapi-` prefix check applies only to `NVIDIA_API_KEY`.
Other provider credentials, such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and compatible endpoint keys, use provider-aware validation during retry.

| Provider type | Validation method |
|---|---|
| OpenAI | Tries `/responses` first, then `/chat/completions`. |
| NVIDIA Endpoints | Validates through `/v1/chat/completions` only; NemoClaw skips the `/v1/responses` probe because NVIDIA Build does not expose `/v1/responses` (returns 404 for every model). |
| Google Gemini | Validates through Gemini's OpenAI-compatible chat-completions path only; NemoClaw skips the `/v1/responses` probe because Gemini does not support the Responses API. |
| Other OpenAI-compatible endpoint | Tries `/v1/responses` first with a tool-calling probe; falls back to `/v1/chat/completions`. Selected runtime API defaults to `/v1/chat/completions`; set `NEMOCLAW_PREFERRED_API=openai-responses` to allow `/v1/responses` at runtime when validation succeeds. |
| Anthropic-compatible | Tries `/v1/messages`. |
| NVIDIA Endpoints (manual model entry) | Validates the model name against the catalog API. |
| Compatible endpoints | Sends a real inference request because many proxies do not expose a `/models` endpoint. For OpenAI-compatible endpoints, the probe tries `/v1/responses` first then falls back to `/v1/chat/completions`; the selected runtime API defaults to `/v1/chat/completions`. Set `NEMOCLAW_PREFERRED_API=openai-responses` to allow `/v1/responses` at runtime when validation succeeds. |
| Local NVIDIA NIM | Validates through `/v1/chat/completions` only; NemoClaw skips the `/v1/responses` probe (same as NVIDIA Endpoints). |

## Setup Details for Local and Compatible Providers

The sections below collect the detailed setup prompts and environment variables for local and compatible inference providers.
Use them when the quickstart or local inference guide points you here for exact command shapes.

## OpenAI-Compatible Server

This option works with any server that implements `/v1/chat/completions`, including vLLM, TensorRT-LLM, llama.cpp, LocalAI, and others.
For compatible endpoints, NemoClaw uses `/v1/chat/completions` by default.
This avoids a class of failures where local backends accept `/v1/responses` requests but silently drop the system prompt and tool definitions.
To opt in to `/v1/responses`, set `NEMOCLAW_PREFERRED_API=openai-responses` before running onboard.

Start your model server.
The examples below use vLLM, but any OpenAI-compatible server works.

```bash
vllm serve meta-llama/Llama-3.1-8B-Instruct --port 8000
```

Run the onboard wizard.

```bash
nemoclaw onboard
```

When the wizard asks you to choose an inference provider, select **Other OpenAI-compatible endpoint**.
Enter the base URL of your local server, for example `http://localhost:8000/v1`.

The wizard prompts for an API key.
If your server does not require authentication, enter any non-empty string (for example, `dummy`).

NemoClaw validates the endpoint by sending a test inference request before continuing.
The wizard probes `/v1/chat/completions` by default for the compatible-endpoint provider.
If you set `NEMOCLAW_PREFERRED_API=openai-responses`, NemoClaw probes `/v1/responses` instead and only selects it when the response includes the streaming events OpenClaw requires.
If a reasoning model returns only reasoning content before producing a final answer, NemoClaw retries the smoke request with a larger response budget.
Route, configuration, and authentication failures still fail immediately.

### Non-Interactive Setup

Set the following environment variables for scripted or CI/CD deployments.

```bash
NEMOCLAW_PROVIDER=custom \
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

```bash
NEMOCLAW_PREFERRED_API=openai-responses nemoclaw onboard
```

The wizard then probes `/v1/responses` and only selects it when streaming
support is complete.
If the probe fails, the wizard falls back to `/v1/chat/completions`
automatically.
You can use this variable in both interactive and non-interactive mode.

| Variable | Values | Default |
|---|---|---|
| `NEMOCLAW_PREFERRED_API` | `openai-completions`, `openai-responses` | `openai-completions` for compatible endpoints |

If you already onboarded and the sandbox is failing at runtime, re-run `nemoclaw onboard` to re-probe the endpoint and bake the correct API path
into the image.
Refer to [Switch Inference Models](switch-inference-providers.md) for more information.

## Anthropic-Compatible Server

If your local server implements the Anthropic Messages API (`/v1/messages`), choose **Other Anthropic-compatible endpoint** during onboarding instead.

```bash
nemoclaw onboard
```

For non-interactive setup, use `NEMOCLAW_PROVIDER=anthropicCompatible` and set `COMPATIBLE_ANTHROPIC_API_KEY`.

```bash
NEMOCLAW_PROVIDER=anthropicCompatible \
  NEMOCLAW_ENDPOINT_URL=http://localhost:8080 \
  NEMOCLAW_MODEL=my-model \
  COMPATIBLE_ANTHROPIC_API_KEY=dummy \
  nemoclaw onboard --non-interactive
```

## vLLM

When vLLM is already running on `localhost:8000`, NemoClaw can detect it automatically and query the `/v1/models` endpoint to determine the loaded model.
On supported Linux hosts with NVIDIA GPUs, the onboard wizard can also install or start a managed vLLM container for you.

For an already-running vLLM server, run `nemoclaw onboard` and select **Local vLLM [experimental]** from the provider list.

If vLLM is already running, NemoClaw detects the running model and validates the endpoint.
When vLLM exposes runtime metadata such as `max_model_len`, NemoClaw uses that value for the `contextWindow` baked into `openclaw.json` unless you set `NEMOCLAW_CONTEXT_WINDOW` yourself.
If vLLM is not running and your host matches a DGX Spark or DGX Station managed profile, NemoClaw shows the **Install vLLM** or **Start vLLM** entry by default.
Generic Linux NVIDIA GPU hosts still require `NEMOCLAW_EXPERIMENTAL=1` or `NEMOCLAW_PROVIDER=install-vllm` before the managed entry appears.
In interactive runs, the managed vLLM path lists the supported registry models for your host profile before it pulls weights.
Press **Enter** to use the default model, or choose a numbered entry to serve another validated model with its matching `vllm serve` flags.
NemoClaw pulls the vLLM image, downloads model weights into `~/.cache/huggingface`, starts the `nemoclaw-vllm` container on `localhost:8000`, streams Hugging Face download progress, and polls `/v1/models` until the model is ready.
Managed DGX Spark and DGX Station profiles use the stable NGC `nvcr.io/nvidia/vllm:26.05.post1-py3` container image.
If Docker pull output stops making progress, a watchdog stops the stalled pull instead of failing slow but active downloads on a fixed wall-clock timeout.
If vLLM never becomes ready, NemoClaw prints a short tail of the vLLM container logs before exiting.
The first run can take 10 to 30 minutes.
Later runs reuse the cached image and model weights.

Managed vLLM uses these profiles:

| Host profile | Default model |
|---|---|
| DGX Spark | `nvidia/Qwen3.6-35B-A3B-NVFP4` |
| DGX Station | `Qwen/Qwen3.6-27B-FP8` |
| Linux with an NVIDIA GPU | `nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8` |

**Note:**

NemoClaw forces the `chat/completions` API path for vLLM.
The vLLM `/v1/responses` endpoint does not run the `--tool-call-parser`, so tool calls arrive as raw text.

### Non-Interactive Setup

Use an already-running vLLM server:

```bash
NEMOCLAW_PROVIDER=vllm \
  nemoclaw onboard --non-interactive
```

Install or start managed vLLM when NemoClaw detects a supported profile.
On DGX Spark and DGX Station, `NEMOCLAW_PROVIDER=install-vllm` is enough for non-interactive runs; add `NEMOCLAW_EXPERIMENTAL=1` on generic Linux NVIDIA GPU hosts.
Non-interactive runs use the profile default unless you set `NEMOCLAW_VLLM_MODEL`.

```bash
NEMOCLAW_PROVIDER=install-vllm \
  nemoclaw onboard --non-interactive
```

NemoClaw records the model returned by vLLM's `/v1/models` endpoint.
Start vLLM with the model you want before onboarding if you manage the server yourself.

### Override the Managed-vLLM Model

Managed vLLM serves the profile default unless you choose a different registry entry in the interactive picker or set an override for automation.
Export `NEMOCLAW_VLLM_MODEL=<slug>` before invoking the installer to choose a different model without prompting.
NemoClaw uses the matching `vllm serve` flags, including the reasoning parser, tool-call parser, and `--max-model-len`.
Recognized slugs are:

| Slug | Hugging Face model | Notes |
|---|---|---|
| `qwen3.6-27b` | `Qwen/Qwen3.6-27B-FP8` | Default on the DGX Station profile |
| `qwen3.6-35b-a3b-nvfp4` | `nvidia/Qwen3.6-35B-A3B-NVFP4` | Default on the DGX Spark profile |
| `nemotron-3-nano-4b` | `nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8` | Default on the generic Linux + NVIDIA GPU profile |
| `deepseek-v4-flash` | `deepseek-ai/DeepSeek-V4-Flash` | Supported override |
| `deepseek-r1-distill-70b` | `deepseek-ai/DeepSeek-R1-Distill-Llama-70B` | Gated. Requires Hugging Face license acceptance |

The slug is case-insensitive; the full Hugging Face id is also accepted.
An unrecognized value fails fast with a list of valid slugs.

Gated models require a Hugging Face token; export it before onboarding so NemoClaw can forward it into the managed vLLM container:

```bash
export HF_TOKEN=<your-hf-token>
NEMOCLAW_PROVIDER=install-vllm \
  NEMOCLAW_VLLM_MODEL=deepseek-r1-distill-70b \
  nemoclaw onboard --non-interactive
```

NemoClaw accepts `HUGGING_FACE_HUB_TOKEN` as an alternative.
The token check runs on the host before any docker pull, so a missing or empty token aborts onboarding before bandwidth is spent on a 401.

## NVIDIA NIM (Experimental)

NemoClaw can pull, start, and manage a NIM container on hosts with a NIM-capable NVIDIA GPU.

Set the experimental flag and run onboard.

```bash
NEMOCLAW_EXPERIMENTAL=1 nemoclaw onboard
```

Select **Local NVIDIA NIM [experimental]** from the provider list.
NemoClaw filters available models by GPU VRAM, pulls the NIM container image, starts it, and waits for it to become healthy before continuing.
On hosts with mixed NVIDIA GPU models, the preflight summary shows each detected GPU model and the total VRAM so you can confirm which device class the model selection used.
On Docker 29.x or containerd image-store hosts, NemoClaw resolves the host-platform manifest digest before pulling multi-architecture NIM images when the registry exposes an index.
It pulls `repo@digest` and retags the local image so NGC attestation metadata on other architectures does not block the selected platform.
If the registry does not expose a matching index, NemoClaw falls back to the tag pull.

NVIDIA hosts NIM container images on `nvcr.io`, and `docker pull` requires NGC registry authentication.
If Docker is not already logged in to `nvcr.io`, onboard prompts for an [NGC API key](https://org.ngc.nvidia.com/setup/api-key) and runs `docker login nvcr.io` over `--password-stdin` so the key is never written to disk or shell history.
The prompt masks the key during input and retries one time on a bad key before failing.
In non-interactive mode, onboard exits with login instructions if Docker is not already authenticated; run `docker login nvcr.io` yourself, then re-run `nemoclaw onboard --non-interactive`.
If `NGC_API_KEY` or `NVIDIA_API_KEY` is already exported, NemoClaw passes it into the managed NIM container through the process environment instead of command-line arguments.
If the NIM container exits before the health endpoint becomes ready, onboarding stops early and prints the last container log lines.
After NIM becomes healthy, NemoClaw reads `/v1/models` and uses the served model id for validation when it differs from the catalog name.
Unsafe served ids are rejected instead of being written into the sandbox config.

**Note:**

NIM uses vLLM internally.
The same `chat/completions` API path restriction applies.

## Timeout Configuration

Local inference requests use a default timeout of 180 seconds.
Large prompts on hardware such as DGX Spark can exceed shorter timeouts, so NemoClaw sets a higher default for Ollama, vLLM, NIM, and compatible-endpoint setup.

To override the timeout, set the `NEMOCLAW_LOCAL_INFERENCE_TIMEOUT` environment variable before onboarding:

```bash
export NEMOCLAW_LOCAL_INFERENCE_TIMEOUT=300
nemoclaw onboard
```

The value is in seconds.
NemoClaw bakes this setting into the sandbox at build time.
Changing it after onboarding requires re-running `nemoclaw onboard`.

`NEMOCLAW_LOCAL_INFERENCE_TIMEOUT` only governs the inference-server validation probe.
During local Ollama setup, NemoClaw treats host-side curl process timeouts as retryable probe failures and retries with a larger timeout before it reports a validation failure.
NemoClaw also retries Docker runtime detection with a longer `docker info` timeout before it chooses the local inference route.
The post-create readiness wait (image build, gateway upload, in-sandbox boot) has its own budget, `NEMOCLAW_SANDBOX_READY_TIMEOUT`, also defaulting to 180 seconds.
On hosts where the sandbox image takes minutes to build or upload, raise both settings together.
Examples include large quantized models, DGX Station first runs, and remote VMs over a slow link.

```bash
export NEMOCLAW_LOCAL_INFERENCE_TIMEOUT=300
export NEMOCLAW_SANDBOX_READY_TIMEOUT=600
nemoclaw onboard
```

If onboard ends with `Sandbox '<name>' was created but did not become ready within 180s`, refer to Troubleshooting (use the `nemoclaw-user-reference` skill).

## Next Steps

- [Use a Local Inference Server](../SKILL.md) for Ollama, vLLM, NIM, and compatible-endpoint setup details.
<AgentOnly variant="openclaw">
- [Tool-Calling Reliability](tool-calling-reliability.md) for deciding when Ollama is enough and when vLLM with a parser is safer.
</AgentOnly>
- [Switch Inference Models](switch-inference-providers.md) for changing the model at runtime without re-onboarding.
