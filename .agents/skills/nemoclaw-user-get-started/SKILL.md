---
name: "nemoclaw-user-get-started"
description: "Installs NemoClaw, launches a sandbox, and runs the first agent prompt. Use when onboarding, installing, or launching a NemoClaw sandbox for the first time. Trigger keywords - nemoclaw quickstart, install nemoclaw openclaw sandbox, nemohermes quickstart, hermes agent nemoclaw, run hermes openshell sandbox, nemoclaw prerequisites, nemoclaw supported platforms, nemoclaw hardware software, nemoclaw windows wsl2 setup, nemoclaw install windows docker desktop."
license: "Apache-2.0"
---

# NemoClaw Quickstart with OpenClaw

Follow these steps to get started with NemoClaw and your first sandboxed OpenClaw agent.

**Note:**

Review the [Prerequisites](references/prerequisites.md) before following this guide.

**Use Agent Skills:**

NemoClaw ships user skills for AI coding assistants.
Load them when you want your assistant to walk through installation, inference choices, policy approvals, monitoring, or troubleshooting with NemoClaw-specific guidance.
Refer to Agent Skills (use the `nemoclaw-user-agent-skills` skill).

## Install NemoClaw and Onboard an OpenClaw Agent

Download and run the installer script.
The script installs Node.js if it is not already present, then runs the guided onboard wizard to create a sandbox, configure inference, and apply security policies.

**Note:**

NemoClaw creates a fresh OpenClaw instance inside the sandbox during the onboarding process.

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

The third-party software notice runs before the installer installs Node.js or the NemoClaw CLI.
The piped installer can prompt through your terminal when a TTY is available.
In non-TTY contexts, such as CI, an SSH command with piped stdin, or a shell script, pass explicit acceptance to the `bash` side of the pipe:

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash
```

Or pass the installer flag through `bash -s`:

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash -s -- --yes-i-accept-third-party-software
```

To run both installation and onboarding without prompts, also set non-interactive mode and the provider variables your chosen inference path requires:

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash
```

Do not place `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1` before `curl`.
In `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 curl ... | bash`, the variable applies only to `curl`, so the installer process cannot see the acceptance.

If you use nvm or fnm to manage Node.js, the installer might not update your current shell's PATH.
If `nemoclaw` is not found after install, run `source ~/.bashrc` (or `source ~/.zshrc` for zsh) or open a new terminal.

On Linux, the installer checks Docker before it installs NemoClaw.
If Docker is missing, the installer downloads the official Docker convenience script, asks for `sudo`, installs Docker, and starts the Docker service when systemd is available.
If you installed Docker but your current shell cannot use the Docker socket yet, the installer adds your user to the `docker` group when needed and exits with a recovery command.

On macOS, the installer uses the Docker-driver OpenShell gateway path with Docker Desktop or Colima.

```bash
newgrp docker
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

On DGX Spark, DGX Station, and Windows WSL, an interactive installer offers express install after you accept the third-party software notice.
Express install switches onboarding to non-interactive mode, allows `sudo` password prompts for required host changes, and selects the managed local inference path for that platform.
Unless `NEMOCLAW_POLICY_TIER` is set, it applies sandbox policy in `suggested` mode with the `balanced` tier by default, using the base sandbox policy plus supported package, model, web-search, and local-inference presets.
On DGX Spark, express install uses `my-spark-assistant` as the sandbox name unless `NEMOCLAW_SANDBOX_NAME` is already set.
On WSL, express install selects the Windows-host Ollama setup path.
Set `NEMOCLAW_NO_EXPRESS=1` to skip the express prompt, or set `NEMOCLAW_PROVIDER` before launching the installer when you want to choose a provider yourself.

The installer auto-launches `nemoclaw onboard` when it can locate the freshly installed binary.
If it cannot locate the binary, or if blocking host preflight checks fail, it does not launch the wizard automatically.
In that case, the installer prints the relevant diagnostics and a `To finish setup, run:` block with the explicit `nemoclaw onboard` command.

**Note:**

The onboard flow builds the sandbox image with `NEMOCLAW_DISABLE_DEVICE_AUTH=1` so the dashboard is immediately usable during setup.
This is a build-time setting baked into the sandbox image, not a runtime knob.
If you export `NEMOCLAW_DISABLE_DEVICE_AUTH` after onboarding finishes, it has no effect on an existing sandbox.

### Respond to the Onboard Wizard

After the installer launches `nemoclaw onboard`, the wizard runs preflight checks, starts or reuses the OpenShell gateway, asks for an inference provider and model, collects any required credential, then asks for the sandbox name.
It prints a review summary before it registers the provider with OpenShell.
After you confirm, NemoClaw registers inference, prompts for optional web search and messaging channels, builds and starts the sandbox, sets up OpenClaw, then applies the selected network policy tier and presets.
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
A configured blueprint router profile makes the Model Router option appear.

**Tip:**

Export the API key before launching the installer so the wizard does not have to ask for it.
For example, run `export NVIDIA_API_KEY=<your-key>` before `curl ... | bash`.
If you entered a key incorrectly, refer to Reset a Stored Credential (use the `nemoclaw-user-manage-sandboxes` skill) to clear and re-enter it.

### Choose an Inference Provider

Pick the option that matches where you want inference traffic to go.
For full provider behavior, curated models, validation details, and local-runtime setup notes, refer to Inference Options (use the `nemoclaw-user-configure-inference` skill).
For Ollama, vLLM, NIM, and compatible local servers, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill).

| Option | Use when | Credential variable |
|---|---|---|
| NVIDIA Endpoints | You want hosted models from `build.nvidia.com`, including hosted Nemotron models. | `NVIDIA_API_KEY` |
| OpenAI | You want the OpenAI API at `https://api.openai.com/v1`. | `OPENAI_API_KEY` |
| Other OpenAI-compatible endpoint | You have OpenRouter, LocalAI, llama.cpp, vLLM, NIM, SGLang, an enterprise gateway, or another `/v1/chat/completions` endpoint. | `COMPATIBLE_API_KEY` |
| Anthropic | You want the Anthropic Messages API. | `ANTHROPIC_API_KEY` |
| Other Anthropic-compatible endpoint | You have a Claude proxy, Bedrock-compatible gateway, or self-hosted `/v1/messages` endpoint. | `COMPATIBLE_ANTHROPIC_API_KEY` |
| Google Gemini | You want Google's OpenAI-compatible Gemini endpoint. | `GEMINI_API_KEY` |
| Local Ollama | You want a host-local Ollama model. | None |
| Model Router | You want NemoClaw to start the host-side model router. | `NVIDIA_API_KEY` |

Export the relevant key before launching the installer when possible.
If your compatible endpoint does not require authentication, set its credential variable to any non-empty placeholder.

### Review the Configuration Before the Sandbox Build

After you enter the sandbox name, the wizard prints a review summary and asks for final confirmation before registering the provider, prompting for optional integrations, and building the sandbox image.
For example, if you picked an OpenAI-compatible endpoint, the summary looks like the following:

```text
  ──────────────────────────────────────────────────
  Review configuration
  ──────────────────────────────────────────────────
  Provider:      compatible-endpoint
  Model:         openai/openai/gpt-5.5
  API key:       configured for OpenShell gateway registration
  Web search:    disabled
  Managed tools: none
  Messaging:     none
  Sandbox name:  my-gpt-claw
  Note:          Sandbox build typically takes 5–15 minutes on this host.
  ──────────────────────────────────────────────────
  Web search and messaging channels will be prompted next.
  Apply this configuration? [Y/n]:
```

The default is `Y`, so you can press Enter one time to continue. Answer `n` to abort cleanly, fix the entries, and re-run `nemoclaw onboard`.

Non-interactive runs (`NEMOCLAW_NON_INTERACTIVE=1`) print the summary for log clarity but skip the prompt.

### Configure Web Search and Messaging

After you confirm the summary, NemoClaw registers the selected provider with the OpenShell gateway and sets the `inference.local` route.
The wizard then asks whether to enable Brave Web Search.
If you enable it, enter a Brave Search API key when prompted.

The wizard also offers messaging channels such as Telegram, Discord, Slack, WeChat, and WhatsApp.
Press a channel number to toggle it, then press Enter to continue.
If you leave all channels unselected, pressing Enter skips messaging setup.
If you select a channel, NemoClaw validates the token format before it bakes the channel configuration into the sandbox.
For example, Slack bot tokens must start with `xoxb-`.
WeChat and WhatsApp are experimental.
Review Messaging Channels (use the `nemoclaw-user-manage-sandboxes` skill) before enabling them.

### Choose Network Policy Presets

After the sandbox image builds and OpenClaw starts inside the sandbox, NemoClaw asks which network policy tier to apply.
Web search and messaging selections happen before this point so the sandbox image and the policy suggestions stay aligned.
The default **Balanced** tier includes common development presets such as npm, PyPI, Hugging Face, Homebrew, and Brave Search when the selected agent supports web search.
Use the arrow keys or `j` and `k` to move, Space to select, and Enter to confirm.

The preset selector lets you include more destinations, such as GitHub, Jira, Slack, Telegram, or local inference.
Press `r` to toggle a selected preset between read-only and read-write when the preset supports both modes.

When the install completes, a summary confirms the running environment.
Before printing the summary, NemoClaw verifies that the sandbox gateway and dashboard port forward are reachable.
NemoClaw reports inference route and messaging bridge checks as warnings when they need more time or additional configuration.
The `Model` and provider line reflects the inference option you picked during onboarding.
The example below shows the result if you picked an OpenAI-compatible endpoint during onboarding.

```text
──────────────────────────────────────────────────
NemoClaw is ready

Sandbox:  my-gpt-claw
Model:    openai/openai/gpt-5.5 (Other OpenAI-compatible endpoint)

Start chatting

  Browser:
    http://127.0.0.1:18789/

  Terminal:
    nemoclaw my-gpt-claw connect
    then run: openclaw tui

Authenticated dashboard URL, if needed:
  nemoclaw my-gpt-claw dashboard-url --quiet

Manage later

  Status:      nemoclaw my-gpt-claw status
  Logs:        nemoclaw my-gpt-claw logs --follow
  Model:       nemoclaw inference set --model <model> --provider <provider> --sandbox my-gpt-claw
  Policies:    nemoclaw my-gpt-claw policy-add
  Credentials: nemoclaw credentials reset <KEY> && nemoclaw onboard
──────────────────────────────────────────────────

[INFO]  === Installation complete ===
```

If you picked a different option, the `Model` line shows that provider's model and label instead. For example, you might see `gpt-5.4 (OpenAI)`, `claude-sonnet-4-6 (Anthropic)`, `gemini-2.5-flash (Google Gemini)`, `llama3.1:8b (Local Ollama)`, `nvidia-routed (Model Router)`, or `<your-model> (Other OpenAI-compatible endpoint)`.

## Run Your First Agent Prompt

You can chat with the agent from the terminal or the browser.

### Open the OpenClaw UI in a Browser to Chat with the Agent

The onboard wizard starts a background port forward to the sandbox dashboard, then prints the dashboard URL in the install summary.
The default host port is `18789`.
If that port is already taken, NemoClaw uses the next free dashboard port, such as `18790`, and prints that port in the final URL.
If the chosen port becomes occupied after the sandbox build starts, onboarding rolls back the newly created sandbox and asks you to retry instead of printing an unreachable dashboard URL.
The install transcript does not print the gateway token.
If the browser requires authentication, use the `dashboard-url --quiet` command to print a complete URL explicitly.

```text
nemoclaw my-gpt-claw dashboard-url --quiet
```

Open the dashboard URL in your browser.
If the browser asks for authentication, run `nemoclaw my-gpt-claw dashboard-url --quiet` and open the returned URL.
Treat the authenticated URL like a password.

### Chat with the Agent from the Terminal

Connect to the sandbox and use the OpenClaw CLI.

```bash
nemoclaw my-assistant connect
# inside the sandbox:
openclaw tui
```

## References

- **Load [references/quickstart-hermes.md](references/quickstart-hermes.md)** when users ask for Hermes setup, NemoHermes onboarding, or running Hermes inside OpenShell. Installs NemoClaw, selects the Hermes agent, and launches a sandboxed Hermes API endpoint.
- **Load [references/prerequisites.md](references/prerequisites.md)** when verifying prerequisites before installation. Lists the hardware, software, and container runtime requirements for running NemoClaw.
- **Load [references/windows-preparation.md](references/windows-preparation.md)** when preparing a Windows machine for NemoClaw, enabling WSL 2, configuring Docker Desktop for Windows, or troubleshooting a Windows-specific install error. Covers Windows-only preparation steps required before the Quickstart.

## Related Skills

- `nemoclaw-user-overview` — NemoClaw Overview (use the `nemoclaw-user-overview` skill) to learn what NemoClaw is and its capabilities
- `nemoclaw-user-agent-skills` — Agent Skills (use the `nemoclaw-user-agent-skills` skill) to load NemoClaw guidance into an AI coding assistant
