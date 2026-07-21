<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Instructions for a Non-Technical User

Help me install and run NVIDIA NemoClaw from this coding-agent UI.
I may use Cursor, Claude Code, Codex, Copilot, or another local coding agent.
I do not know how to use a terminal.

## Interaction Rules

- Ask exactly one question at a time.
- Use clickable choices when supported; otherwise show one short numbered list and wait.
- Detect the operating system and whether it is WSL using read-only checks.
- Ask which computer I am using only if the environment cannot be determined reliably.
- Next ask which agent I want: OpenClaw, Hermes, or LangChain Deep Agents Code.
- Never ask me to run commands myself, except the one workstation-side `ssh -N -L` command needed to open a remote credential form securely.
- Explain each command in plain language, ask permission, then run it for me.
- Pause before installs, system changes, administrator access, large downloads, credentials, sandbox creation, and long-running processes.
- Summarize command output instead of asking me to copy it into chat.
- Explain errors and unfamiliar terms such as Docker, container, model, API key, port, and SSH.
- Never ask me to paste passwords, API keys, tokens, or private credentials into chat.
- Use redacted placeholders such as `<PASTE_YOUR_API_KEY_HERE>` in examples.
- During long operations, give a short update at least once per minute.
- Do not start duplicate installers, downloads, or model servers.
- Verify results after important commands; do not rely only on exit codes.

## Goal

Install NemoClaw, collect onboarding choices before execution, include messaging in the first sandbox build when the selected agent supports it, launch the selected agent, and verify that it responds.

## Agent Selection

Ask: "Which NemoClaw agent would you like?"
Choices:

1. OpenClaw, the default.
2. Hermes.
3. LangChain Deep Agents Code.

Set `NEMOCLAW_AGENT=openclaw` for OpenClaw.
Set `NEMOCLAW_AGENT=hermes` for Hermes, or use `nemohermes onboard`.
Set `NEMOCLAW_AGENT=langchain-deepagents-code` for Deep Agents, or use `nemo-deepagents onboard`.

## Hardware and Readiness

- On Linux, ask permission to run a read-only readiness check before provider selection.
- Check distribution, architecture, product and firmware identity, GPU and memory, NVIDIA driver, Container Toolkit, Docker, Node.js, disk space, existing NemoClaw, Ollama, vLLM, relevant ports, and administrator access.
- Classify the computer as DGX Spark, DGX Station, NVIDIA GB300, another NVIDIA computer, ordinary macOS/Linux, or unknown.
- Do not identify DGX Spark from the GPU name alone; combine product, firmware, architecture, and GPU evidence.
- Classify a system as DGX Station when its firmware identifies a Station GB300 platform, or when its exact OEM model is documented by NVIDIA or the manufacturer as based on DGX Station architecture.
- A confirmed NVIDIA GB300 can independently qualify for expanded local-runtime choices.
- If uncertain, explain that and let NemoClaw's official preflight make the final platform decision.

## Administrator Access

- Check administrator availability without waiting for input, such as with a non-interactive sudo check.
- If passwordless sudo works, continue without prompt mode.
- If passwordless sudo is unavailable but the coding-agent UI provides a secure visible password prompt, explain why access is needed, ask permission, and set `NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt`.
- Let the real `sudo` program collect the password; never use chat or the API-key form for the computer password.
- If neither passwordless sudo nor a secure password prompt is available, stop before the affected install or system change.
- Never pipe a password, store it in a file, generate a password helper, or put it in command arguments.
- Offer a user-local alternative only when official documentation supports it for that exact operation.
- Do not silently use user-local Ollama for a system Ollama upgrade when the old system service would remain active.

## Execution Sandbox

- If the coding agent's execution sandbox blocks a Docker command, use its command-scoped approval flow, if available.
- Request permission to rerun only that exact command outside the sandbox.
- Before requesting approval, explain that Docker daemon access can modify containers, images, and host files.
- Do not change Docker socket permissions or request broad host access only to bypass the execution sandbox.
- If the user or managed policy denies approval, stop before the command.
- Explain that `NEMOCLAW_NON_INTERACTIVE=1` removes NemoClaw prompts.
- Explain that `NEMOCLAW_NON_INTERACTIVE=1` does not bypass execution-sandbox permissions.

## Platform-Specific Instructions

After the readiness check, load exactly one matching instruction asset before provider selection:

- Confirmed DGX Spark: [DGX Spark Express instructions](https://raw.githubusercontent.com/NVIDIA/NemoClaw/c718a78c5794574a98fdd885d94466c3b6794153/docs/resources/prompt-assets/dgx-spark.md).
- Confirmed DGX Station: [DGX Station installation instructions](https://raw.githubusercontent.com/NVIDIA/NemoClaw/c718a78c5794574a98fdd885d94466c3b6794153/docs/resources/prompt-assets/dgx-station.md).
- Officially detected Windows WSL: [Windows WSL Express instructions](https://raw.githubusercontent.com/NVIDIA/NemoClaw/c718a78c5794574a98fdd885d94466c3b6794153/docs/resources/prompt-assets/windows-wsl.md).

Read the matching raw Markdown file completely and follow it before continuing.
Do not load a platform asset for any other computer.

## Runtime and Provider Selection

If no platform asset applies, or its offered install path is declined, ask: "Which inference runtime or provider would you like?"
Choices:

1. Existing vLLM, only when a ready server is detected on `localhost:8000`.
2. Managed vLLM, optimized local inference with a large download.
3. Local Ollama, only when the selected agent and platform support it.
4. NVIDIA Endpoints, which requires an NVIDIA API key.
5. OpenRouter, which requires an OpenRouter API key.
6. OpenAI, which requires an OpenAI API key.
7. Anthropic, which requires an Anthropic API key.
8. Google Gemini, which requires a Gemini API key.
9. Model Router, which requires an NVIDIA API key.
10. Other OpenAI-compatible endpoint, which requires an endpoint, model, and usually a key.
11. Other Anthropic-compatible endpoint, which requires an endpoint, model, and usually a key.
12. Hermes Provider, only when Hermes is selected.

On ordinary supported macOS or Linux:

- Offer Local Ollama for OpenClaw or Hermes when it is installed, running, or officially installable.
- Do not offer Local Ollama for Deep Agents unless current official documentation adds support.
- Offer an existing ready vLLM server when detected.
- Also show all applicable hosted and compatible providers.
- Do not hide Ollama merely because the computer is not DGX or GB300.
- Omit managed vLLM unless current official support permits it for the detected hardware.

When a platform asset applies, follow its local-runtime eligibility and model instructions.
On other platforms, show every provider supported by the selected agent and platform.
Renumber choices after filtering and do not hide hosted providers behind another menu.
Ask required model, endpoint, credential, and download questions one at a time.

## Local Models

- Fetch current model choices from the selected agent's official Markdown documentation.
- The selected maintained NemoClaw release is authoritative for supported slugs and arguments.
- For Ollama, ask permission to inspect installed models and offer NemoClaw's memory-aware recommendation first.
- Current Ollama starter examples include `qwen3.6:35b`, `nemotron-3-nano:30b`, and `qwen3.5:9b`.
- Explain download size and storage requirements, then ask separately for permission.
- Do not request an NGC or Hugging Face credential unless the selected operation actually requires it.

## Avoid Interactive Menus

- Collect every choice before running the installer.
- Ask one question at a time for model, endpoint, sandbox name, web search, messaging when the selected agent supports it, policy when no platform-asset install path is selected, credentials, administrator access, and downloads.
- Use non-interactive environment variables whenever supported.
- For installation outside an accepted platform-asset path, set `NEMOCLAW_AGENT` and `NEMOCLAW_PROVIDER` from my selections.
- Use the maintained release unless I request a specific version.
- For a specific version, clear any inherited `NEMOCLAW_INSTALL_REF`, then set `NEMOCLAW_INSTALL_TAG=vX.Y.Z` to its versioned release tag.
- Never leave a command waiting at `Choose [1]:`.
- If a choice cannot be supplied non-interactively, stop before starting and explain the supported alternative.
- The DGX Station asset is the exception for the official third-party-software notice and Express confirmation. Keep those installer prompts visible, wait for the user's response, and do not pre-answer them.

## Handle Tokens Securely and Visually

Before collecting secrets, determine the exact environment-variable names and exact command argv, explain them, and ask permission.
Do not generate, rewrite, or redesign the helper or form.
Use this reviewed pair without modification:

- Helper: `https://raw.githubusercontent.com/NVIDIA/NemoClaw/dd61a307d7ddf7be99de8ff1e2678fb8ef42f8e6/scripts/local-credential-helper.mts` (SHA-256 `1a42bbe8dbc9003cb79d4e641b53760571aacd85293671aee97c09c0746fef33`).
- Form: `https://raw.githubusercontent.com/NVIDIA/NemoClaw/dd61a307d7ddf7be99de8ff1e2678fb8ef42f8e6/docs/resources/local-credential-form.html` (SHA-256 `5512a256e0ad7c63a26ab82cf4f5924e98652097172ab8a5dc9d9358dd4f6ae8`).

- Treat the two immutable URL and digest pairs as one reviewed trust boundary; before executing the helper, compute the SHA-256 digest of both downloaded files and compare each result with its pinned digest.
- If either digest differs, do not execute the helper; delete both temporary files and stop.
- Store them in a private temporary directory and delete them afterward.
- The helper requires Node.js 22.19 or newer.
- If Node is unavailable, use an existing secure local application prompt or secure terminal prompt; never use chat or generated credential code.
- Keep the helper bound to `http://127.0.0.1`, accept only one valid submission, and run only the already-approved command.
- Use `:secret` for secrets and `:text` only for non-secret values.
- Use `--execution-profile isolated` for stateless commands.
- For persistent install or onboarding, use `--execution-profile account-home --cwd <approved-absolute-directory>` and ask permission for both.
- Pass every `--field NAME:type`, then a literal `--`, an absolute executable path, and the exact approved argv.
- Never omit the literal `--`.
- Never use a relative, alias-only, or PATH-only approved executable.
- Never put credentials in argv.
- Command shape: `node --experimental-strip-types <helper> --execution-profile <profile> --form <form> --field NAME:secret -- <absolute-executable> <approved-args...>`.
- Use **Preview Credentials**, **Edit**, then **Confirm and Run Approved Command**.
- If the outcome is unknown, check whether the command ran; do not retry or resubmit blindly.
- Keep secrets in memory only long enough to start the command.
- Treat deletion as exposure minimization, not guaranteed erasure.
- Prefer letting an account-persistent command use its own reviewed secure credential prompt when available.
- For credential-bearing installation, use the reviewed helper only with an already-downloaded and verified installer.
- Do not hand-assemble a `curl | bash` wrapper around credentials.
- Never print, log, commit, cache, or paste secrets.

Use this provider mapping for non-interactive setup:

- NVIDIA Endpoints: `NEMOCLAW_PROVIDER=build`, `NVIDIA_INFERENCE_API_KEY`.
- OpenRouter: `NEMOCLAW_PROVIDER=openrouter`, `OPENROUTER_API_KEY`.
- OpenAI: `NEMOCLAW_PROVIDER=openai`, `OPENAI_API_KEY`.
- Anthropic: `NEMOCLAW_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`.
- Gemini: `NEMOCLAW_PROVIDER=gemini`, `GEMINI_API_KEY`.
- Hermes Provider: `NEMOCLAW_PROVIDER=hermes-provider`; Hermes only.
- Model Router: `NEMOCLAW_PROVIDER=routed`, `NVIDIA_INFERENCE_API_KEY`.
- OpenAI-compatible: `NEMOCLAW_PROVIDER=custom`, endpoint, model, `COMPATIBLE_API_KEY`.
- Anthropic-compatible: `NEMOCLAW_PROVIDER=anthropicCompatible`, endpoint, model, `COMPATIBLE_ANTHROPIC_API_KEY`.
- Ollama: `NEMOCLAW_PROVIDER=ollama`, optional `NEMOCLAW_MODEL`.
- Existing vLLM: `NEMOCLAW_PROVIDER=vllm`.
- Managed vLLM: `NEMOCLAW_PROVIDER=install-vllm`; use an approved optional model override only when the selected platform supports it.

Do not offer Hermes Provider for OpenClaw or Deep Agents.

## Credential Form and SSH

Ask whether I use SSH only after the helper starts and prints its complete one-time URL: "Are you connected to this computer through SSH?"
Choices:

1. No, I am using it directly.
2. Yes, this is a remote SSH computer.
3. I am not sure.

- Treat the helper's complete URL as an opaque, sensitive, one-time capability.
- Preserve its scheme, host, port, `/local-credential-form.html` path, complete `field=` query string, and `#cap=` fragment exactly.
- Never replace it with a reconstructed bare `http://127.0.0.1:<port>` URL.
- If local, give me the complete original URL unchanged.
- If remote, read its port and ask me to run: `ssh -N -L <port>:127.0.0.1:<port> <username>@<host>`.
- Fill in the actual port, username, and host when known.
- Explain that it runs on my workstation, normally prints nothing, and must remain open until credential entry finishes.
- After the tunnel starts, give me the helper's original complete URL unchanged.
- Require the same port on both sides; do not remap the helper to another local port.
- If that local port is occupied, stop the unused helper safely, resolve the conflict or start a fresh helper session, and use only the new complete URL.
- Never reuse an old URL or expose the form through `0.0.0.0`, LAN, public URL, shared tunnel, or unauthenticated proxy.
- Tell me when it is safe to stop the forwarding command.

## Messaging During Initial Onboarding

For OpenClaw or Hermes, ask before the first sandbox build: "Do you want to configure a messaging channel during onboarding?"
Choices: No, Telegram, Discord, Slack, WhatsApp, WeChat (experimental).
Skip messaging for Deep Agents.
Configure one channel at a time, then ask whether to add another.
Collect messaging before policy selection so the first image includes channel configuration and matching network presets.

- Telegram requires `TELEGRAM_BOT_TOKEN`; optional settings include allowed IDs, mention mode, and OpenClaw group policy.
- Discord requires `DISCORD_BOT_TOKEN`; optional settings include server ID, user ID, and mention mode.
- Slack requires `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`; optional settings include allowed users and channels.
- WhatsApp uses documented allowed IDs for non-interactive selection, followed by QR pairing after startup.
- WeChat requires an interactive QR handshake; explain the limitation before installation and never leave an unsupported UI waiting.

Collect messaging secrets through the reviewed helper and exact-URL SSH flow.
Do not manually set `NEMOCLAW_MESSAGING_CHANNELS_B64`; let NemoClaw generate it.
Use `channels add` and rebuild only for channels omitted from initial onboarding or changed later.

## Policy, Approval, and Verification

- If a loaded platform asset selects its approved install path, follow its policy requirement and skip the policy-tier question.
- For installation outside an accepted platform-asset path, ask for Balanced, Restricted, or Open policy.
- Explain that messaging and web-search selections add required endpoints.
- Before installation outside an accepted platform-asset path, summarize platform, administrator access, agent, provider, exact model, validation warning, downloads, storage, sandbox, web search, messaging, policy, credential names without their values, and system changes.
- Ask for final permission before installation outside an accepted platform-asset path.
- When a platform asset delegates consent to the official installer, let the installer present its notice and final Express confirmation instead of pre-accepting them.
- For other accepted platform-asset install paths, treat the asset's confirmation as final permission and do not ask again.
- Set `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1` and `NEMOCLAW_YES=1` only after their approvals.
- Keep credentials in the approved environment and never display them.
- Verify the command and version, sandbox status, provider, model, `inference.local`, GPU access when applicable, messaging bridges when configured, and dashboard route when available.
- If `curl | bash` returns no output, verify installation; if absent, ask permission to download and inspect the official installer before retrying.
- For remote dashboards, use private loopback SSH forwarding, preserve authenticated URLs exactly, and treat them as secrets.
- Ask permission before sending a live channel test or harmless first agent prompt.
- Declare success only after the sandbox is ready and the agent responds.
- Summarize what was installed, how to reconnect, what starts after reboot, and anything skipped.

## Use Docs for Information

- Use clean `.md` pages for searching more information in the selected agent's documentation. Example URLs:
  - [Documentation index for AI clients](https://docs.nvidia.com/nemoclaw/llms.txt)
  - [OpenClaw quickstart](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/quickstart.md)
  - [Hermes quickstart](https://docs.nvidia.com/nemoclaw/latest/user-guide/hermes/get-started/quickstart.md)
  - [Deep Agents quickstart](https://docs.nvidia.com/nemoclaw/latest/user-guide/deepagents/get-started/quickstart.md)
- Suggest to add the docs MCP server `https://docs.nvidia.com/nemoclaw/_mcp/server` if the coding agent supports MCP.
