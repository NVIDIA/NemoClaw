# NemoClaw Quickstart with OpenClaw: Details

## Respond to the Onboard Wizard

After the installer launches `nemoclaw onboard`, the wizard runs preflight checks, starts or reuses the OpenShell gateway, and asks for an inference provider, sandbox name, optional web search, optional messaging channels, and network policy presets.
At any prompt, press Enter to accept the default shown in `[brackets]`, type `back` to return to the previous prompt, or type `exit` to quit.
If existing sandbox sessions are running, the installer warns before onboarding because the setup can rebuild or upgrade sandboxes after the new sandbox launches.

The inference provider prompt presents a numbered list.

```text
  1) NVIDIA Endpoints
  2) OpenAI
  3) Other OpenAI-compatible endpoint
  4) Anthropic
  5) Other Anthropic-compatible endpoint
  6) Google Gemini
  7) Local Ollama (localhost:11434)
  8) Model Router (experimental)
  Choose [1]:
```

Pick the option that matches where you want inference traffic to go, then expand the matching helper below for the follow-up prompts and the API key environment variable to set.
For the full list of providers and validation behavior, refer to Inference Options (use the `nemoclaw-user-configure-inference` skill).
Local Ollama appears when NemoClaw detects a usable local Ollama path or can offer an install or start action for your platform.
The Model Router option appears when the blueprint router profile is enabled.

**Tip:**

Export the API key before launching the installer so the wizard does not have to ask for it.
For example, run `export NVIDIA_API_KEY=<your-key>` before `curl ... | bash`.
If you entered a key incorrectly, refer to Reset a Stored Credential (use the `nemoclaw-user-manage-sandboxes` skill) to clear and re-enter it.

**Option 1: NVIDIA Endpoints:**

Routes inference to models hosted on [build.nvidia.com](https://build.nvidia.com).

Use `NVIDIA_API_KEY` for the API key. Get one from the [NVIDIA build API keys page](https://build.nvidia.com/settings/api-keys).

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, press Enter (or type `1`) to select **NVIDIA Endpoints**.
2. At the `NVIDIA_API_KEY:` prompt, paste your key if it is not already exported.
3. At the `Choose model [1]:` prompt, pick a curated model from the list (for example, `Nemotron 3 Super 120B`, `GLM-5`, `MiniMax M2.7`, `GPT-OSS 120B`, or `DeepSeek V4 Pro`), or pick `Other...` to enter any model ID from the [NVIDIA Endpoints catalog](https://build.nvidia.com).

NemoClaw validates the model against the catalog API before creating the sandbox.

**Tip:**

Use this option for Nemotron and other models hosted on `build.nvidia.com`. If you run NVIDIA Nemotron from a self-hosted NIM, an enterprise gateway, or any other endpoint, choose **Option 3** instead, since all Nemotron models expose OpenAI-compatible APIs.

**Option 2: OpenAI:**

Routes inference to the OpenAI API at `https://api.openai.com/v1`.

Use `OPENAI_API_KEY` for the API key. Get one from the [OpenAI API keys page](https://platform.openai.com/api-keys).

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, type `2` to select **OpenAI**.
2. At the `OPENAI_API_KEY:` prompt, paste your key if it is not already exported.
3. At the `Choose model [1]:` prompt, pick a curated model (for example, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, or `gpt-5.4-pro-2026-03-05`), or pick **Other...** to enter any OpenAI model ID.

**Option 3: Other OpenAI-Compatible Endpoint:**

Routes inference to any server that implements `/v1/chat/completions`, including OpenRouter, LocalAI, llama.cpp, vLLM behind a proxy, and any compatible gateway.

Use `COMPATIBLE_API_KEY` for the API key. Set it to whatever credential your endpoint expects. If your endpoint does not require auth, use any non-empty placeholder.

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, type `3` to select **Other OpenAI-compatible endpoint**.
2. At the `OpenAI-compatible base URL` prompt, enter the provider's base URL. Find the exact value in your provider's API documentation. NemoClaw appends `/v1` automatically, so leave that suffix off.
3. At the `COMPATIBLE_API_KEY:` prompt, paste your key if it is not already exported.
4. At the `Other OpenAI-compatible endpoint model []:` prompt, enter the model ID exactly as it appears in your provider's model catalog.

For example, when you use NVIDIA's OpenAI-compatible inference endpoint, enter `https://inference-api.nvidia.com` as the base URL and the model ID your endpoint exposes, such as `openai/openai/gpt-5.5`.

NemoClaw sends a real inference request to validate the endpoint and model.
If the endpoint does not return the streaming events OpenClaw needs from the Responses API, NemoClaw falls back to the chat completions API and configures OpenClaw to use `openai-completions`.

**Tip:**

NVIDIA Nemotron models expose OpenAI-compatible APIs, so this option is the right choice for any Nemotron deployment that does not live on `build.nvidia.com`. Common examples include a self-hosted NIM container, an enterprise NVIDIA AI Enterprise gateway, or a vLLM/SGLang server running Nemotron weights. Point the base URL at your endpoint and enter the Nemotron model ID exactly as your server reports it.

**Option 4: Anthropic:**

Routes inference to the Anthropic Messages API at `https://api.anthropic.com`.

Use `ANTHROPIC_API_KEY` for the API key. Get one from the [Anthropic console keys page](https://console.anthropic.com/settings/keys).

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, type `4` to select **Anthropic**.
2. At the `ANTHROPIC_API_KEY:` prompt, paste your key if it is not already exported.
3. At the `Choose model [1]:` prompt, pick a curated model (for example, `claude-sonnet-4-6`, `claude-haiku-4-5`, or `claude-opus-4-6`), or pick **Other...** to enter any Claude model ID.

**Option 5: Other Anthropic-Compatible Endpoint:**

Routes inference to any server that implements the Anthropic Messages API at `/v1/messages`, including Claude proxies, Bedrock-compatible gateways, and self-hosted Anthropic-compatible servers.

Use `COMPATIBLE_ANTHROPIC_API_KEY` for the API key. Set it to whatever credential your endpoint expects.

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, type `5` to select **Other Anthropic-compatible endpoint**.
2. At the `Anthropic-compatible base URL` prompt, enter the proxy or gateway's base URL from its documentation.
3. At the `COMPATIBLE_ANTHROPIC_API_KEY:` prompt, paste your key if it is not already exported.
4. At the `Other Anthropic-compatible endpoint model []:` prompt, enter the model ID exactly as it appears in your gateway's model catalog.

**Option 6: Google Gemini:**

Routes inference to Google's OpenAI-compatible Gemini endpoint at `https://generativelanguage.googleapis.com/v1beta/openai/`.

Use `GEMINI_API_KEY` for the API key. Get one from [Google AI Studio API keys](https://aistudio.google.com/app/apikey).

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, type `6` to select **Google Gemini**.
2. At the `GEMINI_API_KEY:` prompt, paste your key if it is not already exported.
3. At the `Choose model [5]:` prompt, pick a curated model (for example, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, or `gemini-2.5-flash-lite`), or pick **Other...** to enter any Gemini model ID.

**Option 7: Local Ollama:**

Routes inference to a local Ollama instance. Depending on your platform, the wizard can use an existing daemon, start an installed daemon, or offer an install action.

No API key is required. On non-WSL hosts, NemoClaw generates a token and starts an authenticated proxy so containers can reach Ollama without exposing the daemon directly to your network.
On WSL, NemoClaw can also use Ollama on the Windows host through `host.docker.internal`.

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, type `7` to select **Local Ollama**.
2. At the `Choose model [1]:` prompt, pick from **Ollama models** if any are already installed. If none are installed, pick a **starter model** to pull and load now, or pick **Other...** to enter any Ollama model ID.

For setup details, including GPU recommendations and starter model choices, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill).

**Option 8: Model Router:**

Starts a host-side model router and routes sandbox inference through OpenShell to that router.
The router chooses from the model pool in `nemoclaw-blueprint/router/pool-config.yaml` for each request.

Use `NVIDIA_API_KEY` for the model pool credentials.

Respond to the wizard as follows.

1. At the `Choose [1]:` prompt, type `8` to select **Model Router (experimental)**.
2. At the `NVIDIA_API_KEY:` prompt, paste your key if it is not already exported.
3. Review the configuration summary and continue with the sandbox build.

For scripted setup, set:

```console
$ NEMOCLAW_PROVIDER=routed NVIDIA_API_KEY=<your-key> nemoclaw onboard --non-interactive
```

The router listens on the host at port `4000`.
The sandbox still calls `https://inference.local/v1`, so do not point in-sandbox tools at the host router port directly.

**Local NIM and Local vLLM:**

- **Local NVIDIA NIM** appears when `NEMOCLAW_EXPERIMENTAL=1` is set and the host has a NIM-capable GPU. NemoClaw pulls and manages a NIM container.
- **Local vLLM (already running)** appears whenever NemoClaw detects a vLLM server on `localhost:8000`. No flag is required for the menu entry. NemoClaw auto-detects the loaded model.
- **Local vLLM (managed install/start)** appears by default on DGX Spark and DGX Station. Generic Linux NVIDIA GPU hosts require `NEMOCLAW_EXPERIMENTAL=1` or `NEMOCLAW_PROVIDER=install-vllm`. NemoClaw pulls and starts a vLLM container on supported hosts.

For setup, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill).
