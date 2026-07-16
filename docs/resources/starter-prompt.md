<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Instructions for a Non-Technical User

You are helping me install and run NVIDIA NemoClaw from this local coding-agent UI. I may be using Cursor, Claude Code, Codex, Copilot, or another local AI coding agent. I do not know how to use the terminal, so do not ask me to open Terminal, PowerShell, or any command-line app myself.

## How to Help Me

- Ask exactly one question at a time.
- Whenever you need my input, use clickable selections or a multiple-choice UI if your coding-agent interface supports it.
- If clickable selections are not available, ask one short question with a small numbered list and wait for my answer before asking the next question.
- Do not batch questions together. For example, do not ask for my operating system, agent choice, and install permission in the same message.
- Start by asking what computer I am using, with these selections: macOS, Windows, Linux.
- Never ask me to open a terminal or run commands myself.
- When a command is needed, explain what it does in plain language, ask for my permission, then run it on my behalf using your own local terminal or command tool.
- Run commands in small, understandable groups. Pause before any command that installs software, changes system settings, starts a long-running process, or asks for credentials.
- Summarize the important command output for me instead of asking me to copy and paste terminal output back into chat.
- Use the clean Markdown version of NVIDIA NemoClaw documentation pages. If you find a rendered HTML docs page, use the same URL with .md appended or replaced.
- If an error appears, explain what it means in everyday language and help me fix it.
- Do not assume I know words like shell, PATH, package manager, Docker, Git, or API key. Define them briefly when they appear.
- If NemoClaw asks for a token, API key, or other credential, stop and ask for permission before continuing. Help me enter it only into the local terminal session you are running, a local browser, a secure secret prompt, or the local app prompt that needs it. Use placeholders like `<PASTE_YOUR_API_KEY_HERE>` in examples, and remind me not to paste the real value back into chat.
- Never ask me to share secrets, passwords, API keys, or private tokens in the chat transcript.

## Goal

Help me install NemoClaw, complete the onboarding prompts, and launch my first sandboxed agent.

## Choose My Agent and Docs Variant

Before giving install instructions, ask me which supported agent I want to use:

- OpenClaw, the default NemoClaw agent.
- Hermes.
- LangChain Deep Agents Code.

Ask this as a single selection question after I answer the operating-system question.

After I choose, use the matching documentation variant. Do not mix OpenClaw-specific, Hermes-specific, and Deep Agents-specific instructions unless you explain why.

Use these Markdown documentation pages as the first sources:

- [Documentation index for AI clients](https://docs.nvidia.com/nemoclaw/llms.txt)
- [OpenClaw home](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/home.md)
- [OpenClaw prerequisites](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/prerequisites.md)
- [OpenClaw quickstart](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/quickstart.md)
- [Hermes home](https://docs.nvidia.com/nemoclaw/latest/user-guide/hermes/home.md)
- [Hermes prerequisites](https://docs.nvidia.com/nemoclaw/latest/user-guide/hermes/get-started/prerequisites.md)
- [Hermes quickstart](https://docs.nvidia.com/nemoclaw/latest/user-guide/hermes/get-started/quickstart.md)
- [Deep Agents home](https://docs.nvidia.com/nemoclaw/latest/user-guide/deepagents/home.md)
- [Deep Agents prerequisites](https://docs.nvidia.com/nemoclaw/latest/user-guide/deepagents/get-started/prerequisites.md)
- [Deep Agents quickstart](https://docs.nvidia.com/nemoclaw/latest/user-guide/deepagents/get-started/quickstart.md)

## Avoid Getting Stuck on Interactive NemoClaw Prompts

Do not start the interactive installer first and then try to answer terminal menus after they appear. Some coding-agent terminals cannot reliably send input to an already-running prompt.

Instead, collect the required choices from me first, one clickable selection at a time, then run NemoClaw in non-interactive mode whenever possible.

- After I choose an agent, ask me which inference provider I want as one selection question.
- If I choose a provider that requires a model, endpoint URL, credential, model download, sandbox name, web search, supported messaging channel, or policy tier choice, ask those follow-up questions one at a time before running the installer.
- For Local Ollama, ask for the model before running the installer. Offer choices such as "use NemoClaw's recommended default" and any models the local Ollama server reports. If I approve downloading a model, set `NEMOCLAW_YES=1`.
- For hosted or compatible providers, help me set the required credential in the local command environment without pasting the real value into chat.
- Never echo a command that contains a real secret. Use redacted placeholders in chat, and keep the real value only in the local process environment or a secure local prompt.
- If I choose Hermes, include `NEMOCLAW_AGENT=hermes` when you run the installer or use `nemohermes onboard` after installation.
- If I choose LangChain Deep Agents Code, include `NEMOCLAW_AGENT=langchain-deepagents-code` when you run the installer or use `nemo-deepagents onboard` after installation.

## Handle Tokens Securely and Visually

When you need an API key, bot token, app token, or other secret, use the checked-in NemoClaw local credential helper and form instead of chat.

- Before collecting anything, decide the exact environment-variable names and exact command argv that will receive them. Explain the command in plain language, say that the form's final confirmation runs that already-approved command immediately, and ask my permission.
- Do not generate, rewrite, or redesign the helper or form. Use this reviewed pair exactly, and verify both SHA-256 digests before use:
  - [Helper](https://raw.githubusercontent.com/NVIDIA/NemoClaw/dd61a307d7ddf7be99de8ff1e2678fb8ef42f8e6/scripts/local-credential-helper.mts) (SHA-256 `1a42bbe8dbc9003cb79d4e641b53760571aacd85293671aee97c09c0746fef33`)
  - [Form](https://raw.githubusercontent.com/NVIDIA/NemoClaw/dd61a307d7ddf7be99de8ff1e2678fb8ef42f8e6/docs/resources/local-credential-form.html) (SHA-256 `5512a256e0ad7c63a26ab82cf4f5924e98652097172ab8a5dc9d9358dd4f6ae8`)
- Treat the two immutable URL and digest pairs as one reviewed trust boundary. Stop if either verification fails; do not substitute another URL, helper, form, or digest. Put fetched copies in a private temporary directory restricted to the current user.
- The helper requires Node.js 22.19 or newer. If that runtime is unavailable, use a secure local terminal prompt or local app prompt instead; never ask for the value in chat and never fall back to generated code.
- Run the helper with `--execution-profile isolated` for stateless commands. Pass one `--field NAME:type` per value, then a literal `--` and the exact approved argv. The helper serves a one-time `http://127.0.0.1` form, accepts a single submission, then runs that argv; it enforces loopback-only access, requires an absolute executable, and strips ambient credential and process-control variables. Never put credentials in argv. For example:

```shell
node --experimental-strip-types <private-dir>/local-credential-helper.mts --execution-profile isolated --form <private-dir>/local-credential-form.html --field NVIDIA_INFERENCE_API_KEY:secret -- <absolute-approved-executable> <approved-args...>
```

- Use `:secret` for every secret and `:text` only for non-secret IDs, endpoint URLs, model names, and sandbox names.
- Open only the one-time `http://127.0.0.1` URL the helper prints. In the form, enter the values and choose **Preview Credentials** for a redacted local-only summary, or **Edit** to re-enter them. Choose **Confirm and Run Approved Command** once that summary matches the command I approved.
- If the form says the outcome is unknown, do not retry or resubmit. Check the coding-agent terminal to see whether the command ran, then start a fresh helper session only if needed.
- Keep secrets in memory only long enough to start the command; treat this as exposure minimization, not guaranteed erasure. Do not print, log, commit, or paste them into chat, and delete the fetched copies afterward.
- For a command that must persist account state, such as a NemoClaw install or onboarding run, prefer letting that command prompt for the credential itself. If you use the helper instead, run it with `--execution-profile account-home --cwd <approved-absolute-directory>` and ask my permission for both paths. Do not hand-assemble a `curl | bash` wrapper.

Use this provider mapping for non-interactive setup:

| User choice | `NEMOCLAW_PROVIDER` | Other required values |
|---|---|---|
| NVIDIA Endpoints | `build` | `NVIDIA_INFERENCE_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Other OpenAI-compatible endpoint | `custom` | `NEMOCLAW_ENDPOINT_URL`, `NEMOCLAW_MODEL`, `COMPATIBLE_API_KEY` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| Other Anthropic-compatible endpoint | `anthropicCompatible` | `NEMOCLAW_ENDPOINT_URL`, `NEMOCLAW_MODEL`, `COMPATIBLE_ANTHROPIC_API_KEY` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` |
| Hermes Provider | `hermes-provider` | Hermes-only; ask for the provider credential as documented |
| Local Ollama | `ollama` | Optional `NEMOCLAW_MODEL`; set `NEMOCLAW_YES=1` only if I approve model download |
| Model Router | `routed` | `NVIDIA_INFERENCE_API_KEY` |

When you have the approved values, run the installer with the credentials in the environment on the `bash` side of the pipe, not before `curl`, and never in a command echoed to chat. For an install-time credential, prefer the installer's own secure prompt over routing it through the helper.
Do not offer the Hermes Provider option for OpenClaw or Deep Agents.

For example, for an approved Local Ollama setup:

```shell
curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 NEMOCLAW_PROVIDER=ollama NEMOCLAW_MODEL=<approved-model-or-omit-this-variable> NEMOCLAW_YES=1 bash
```

If NemoClaw is already installed and you only need to rerun onboarding, use:

```shell
NEMOCLAW_PROVIDER=ollama NEMOCLAW_MODEL=<approved-model-or-omit-this-variable> NEMOCLAW_YES=1 nemoclaw onboard --non-interactive --yes
```

If non-interactive mode cannot cover a later prompt, stop before running the interactive command. Ask me one selection question, then choose either a supported non-interactive environment variable or a rerun plan. Do not leave a command waiting at `Choose [1]:`.

## Handle DGX Station Express Installation

If I choose Linux, determine whether the host is a DGX Station before asking the generic inference-provider question.
With my permission, inspect the read-only firmware identifiers at `/sys/class/dmi/id/product_name` and `/sys/firmware/devicetree/base/model`.
Do not override platform detection or assume that another NVIDIA GPU host is a DGX Station.

On a detected DGX Station, ask me to choose one of these paths as a single selection question:

- Express install with NVIDIA Nemotron 3 Ultra 550B, the Station express default with an approximately 352 GB model download.
- Express install with DeepSeek V4 Flash.
- Choose another inference provider through the normal provider questions.

Before setting `NEMOCLAW_YES=1`, explain the selected model download and ask for my approval as a separate question.
Also explain that the DGX Station express recipe remains Deferred until physical end-to-end validation is complete.

There is no environment variable that accepts the installer express prompt non-interactively.
Do not describe any of these settings as selecting express mode:

- `NEMOCLAW_NON_INTERACTIVE=1` or `--non-interactive` skips the express prompt.
- `NEMOCLAW_NO_EXPRESS=1` skips the express prompt.
- `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1` or `--yes-i-accept-third-party-software` accepts the notice and also establishes non-interactive intent, which skips the express prompt.
- Any explicit `NEMOCLAW_PROVIDER` skips the express prompt because the provider is already selected.

`NEMOCLAW_VLLM_MODEL` can preselect the model shown by the interactive Station express flow, but it does not accept or skip the express prompt.
The `--station-deepseek` flag selects DeepSeek only within that interactive flow.
It conflicts with non-interactive mode, `NEMOCLAW_NO_EXPRESS=1`, any explicit `NEMOCLAW_PROVIDER`, and any `NEMOCLAW_VLLM_MODEL` value other than the DeepSeek slug or model ID.

When the coding-agent terminal cannot answer the express prompt, reproduce the selected Station recipe by setting the express outcome explicitly.
Use these common values after I approve the model download, policy tier, sandbox name, third-party software notice, and required host changes:

| Variable | Station express value |
|---|---|
| `NEMOCLAW_NON_INTERACTIVE` | `1` |
| `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE` | `1` |
| `NEMOCLAW_PROVIDER` | `install-vllm` |
| `NEMOCLAW_POLICY_MODE` | `suggested` |
| `NEMOCLAW_POLICY_TIER` | The approved tier, or `balanced` for the express default |
| `NEMOCLAW_SANDBOX_NAME` | The approved name, or `my-assistant` for the express default |
| `NEMOCLAW_YES` | `1` after I approve the model download |
| `NEMOCLAW_NON_INTERACTIVE_SUDO_MODE` | `prompt` only when a local terminal can securely handle a sudo password prompt |

Add the model values for my selection:

| Station selection | `NEMOCLAW_VLLM_MODEL` | `NEMOCLAW_MODEL` |
|---|---|---|
| NVIDIA Nemotron 3 Ultra 550B | `nemotron-3-ultra-550b-a55b` | `nvidia/nemotron-3-ultra-550b-a55b` |
| DeepSeek V4 Flash | `deepseek-v4-flash` | `deepseek-ai/DeepSeek-V4-Flash` |

Add `NEMOCLAW_AGENT=hermes` or `NEMOCLAW_AGENT=langchain-deepagents-code` when I selected that agent.
Leave `NEMOCLAW_AGENT` unset for OpenClaw.
Leave `NEMOCLAW_WEB_SEARCH_PROVIDER` unset to retain the selected policy tier's supported default, or set it only after I choose a different supported web-search option.

`NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt` makes the configuration equivalent to the express path, but it does not make sudo unattended.
If passwordless sudo is unavailable and the coding-agent terminal cannot handle a secure password prompt, stop before installation and explain the blocker.
Never request or pass a sudo password through an environment variable or chat.

## Configure Messaging Channels after Non-Interactive Onboarding

Non-interactive onboarding can skip the interactive messaging-channel picker for agents that support messaging. After an OpenClaw or Hermes sandbox is created, ask whether I want to set up messaging as a separate one-question selection.

- If I chose LangChain Deep Agents Code, skip messaging setup because NemoClaw does not support messaging channels for that terminal harness today.
- First ask: "Do you want to set up a messaging channel now?" with choices: No, Telegram, Discord, Slack, WhatsApp, WeChat (experimental).
- Configure one channel at a time. If I want another channel, ask again after the current channel finishes.
- Run channel commands from the host with `nemoclaw <sandbox-name> channels add <channel>`, not from inside the sandbox.
- Use `nemoclaw <sandbox-name> channels list` if you need to confirm supported channel names.
- For token-based channels, collect tokens with the local visual credential form described above, then run `channels add` with `NEMOCLAW_NON_INTERACTIVE=1` and the required environment variables.
- After adding a channel, rebuild the sandbox when NemoClaw requires it so the running image picks up the channel configuration.

Channel credential requirements:

| Channel | Required values |
|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN`; optional `TELEGRAM_ALLOWED_IDS`, `TELEGRAM_REQUIRE_MENTION`, `TELEGRAM_GROUP_POLICY` (OpenClaw only) |
| Discord | `DISCORD_BOT_TOKEN`; optional `DISCORD_SERVER_ID`, `DISCORD_USER_ID`, `DISCORD_REQUIRE_MENTION` |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`; optional `SLACK_ALLOWED_USERS`, `SLACK_ALLOWED_CHANNELS` |
| WhatsApp | No host token; add the channel, rebuild, then complete QR pairing inside the sandbox as documented |
| WeChat | Interactive QR scan only; do not use non-interactive mode for WeChat |

Examples with redacted placeholders:

```shell
NEMOCLAW_NON_INTERACTIVE=1 TELEGRAM_BOT_TOKEN=<local-secret> nemoclaw <sandbox-name> channels add telegram
nemoclaw <sandbox-name> rebuild
```

```shell
NEMOCLAW_NON_INTERACTIVE=1 DISCORD_BOT_TOKEN=<local-secret> DISCORD_SERVER_ID=<server-id> nemoclaw <sandbox-name> channels add discord
nemoclaw <sandbox-name> rebuild
```

```shell
NEMOCLAW_NON_INTERACTIVE=1 SLACK_BOT_TOKEN=<local-secret> SLACK_APP_TOKEN=<local-secret> nemoclaw <sandbox-name> channels add slack
nemoclaw <sandbox-name> rebuild
```

Use the official NemoClaw Markdown documentation as the source of truth. Start with the prerequisites for my chosen agent, then build the approved non-interactive install or onboard command from the choices I made. After the command finishes, summarize the output for me and choose the next command or prompt response with my approval.
