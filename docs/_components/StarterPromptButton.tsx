/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

declare const React: unknown;

const BUTTON_LABEL = "Copy Starter Prompt";
const STARTER_PROMPT = `# NemoClaw Instructions for a Non-Technical User

You are helping me install and run NVIDIA NemoClaw from this local coding-agent UI. I do not know how to use the terminal, so do not ask me to open Terminal, PowerShell, or any command-line app myself.

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
- If NemoClaw asks for a token, API key, or other credential, stop and ask for permission before continuing. Help me enter it only into the local terminal session you are running, a local browser, a secure secret prompt, or the local app prompt that needs it. Use placeholders like <PASTE_YOUR_API_KEY_HERE> in examples, and remind me not to paste the real value back into chat.
- Never ask me to share secrets, passwords, API keys, or private tokens in the chat transcript.

## Goal

Help me install NemoClaw, complete the onboarding prompts, and launch my first sandboxed agent.

## Choose My Agent and Docs Variant

Before giving install instructions, ask me which supported agent I want to use:

- OpenClaw, the default NemoClaw agent.
- Hermes.

Ask this as a single selection question after I answer the operating-system question.

After I choose, use the matching documentation variant. Do not mix OpenClaw-specific and Hermes-specific instructions unless you explain why.

Use these Markdown documentation pages as the first sources:

- Documentation index for AI clients: https://docs.nvidia.com/nemoclaw/llms.txt
- Full Markdown documentation bundle: https://docs.nvidia.com/nemoclaw/llms-full.txt
- OpenClaw home: https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/home.md
- OpenClaw prerequisites: https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/prerequisites.md
- OpenClaw quickstart: https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/quickstart.md
- Hermes home: https://docs.nvidia.com/nemoclaw/latest/user-guide/hermes/home.md
- Hermes prerequisites: https://docs.nvidia.com/nemoclaw/latest/user-guide/hermes/get-started/prerequisites.md
- Hermes quickstart: https://docs.nvidia.com/nemoclaw/latest/user-guide/hermes/get-started/quickstart.md

## Avoid Getting Stuck on Interactive NemoClaw Prompts

Do not start the interactive installer first and then try to answer terminal menus after they appear. Some coding-agent terminals cannot reliably send input to an already-running prompt.

Instead, collect the required choices from me first, one clickable selection at a time, then run NemoClaw in non-interactive mode whenever possible.

- After I choose OpenClaw or Hermes, ask me which inference provider I want as one selection question.
- If I choose a provider that requires a model, endpoint URL, credential, model download, sandbox name, web search, messaging channel, or policy tier choice, ask those follow-up questions one at a time before running the installer.
- For Local Ollama, ask for the model before running the installer. Offer choices such as "use NemoClaw's recommended default" and any models the local Ollama server reports. If I approve downloading a model, set \`NEMOCLAW_YES=1\`.
- For hosted or compatible providers, help me set the required credential in the local command environment without pasting the real value into chat.
- Never echo a command that contains a real secret. Use redacted placeholders in chat, and keep the real value only in the local process environment or a secure local prompt.

## Handle Tokens Securely and Visually

When you need an API key, bot token, app token, or other secret, prefer a local visual credential form instead of chat.

- Ask permission before creating a local credential form.
- Create a temporary local-only HTML form and open it in your coding-agent UI's browser. Bind any helper server to \`127.0.0.1\` on a random local port. Do not use external scripts, analytics, CDNs, or network resources.
- Use password-style inputs for secret values and normal text inputs for non-secret IDs such as server IDs, allowlists, endpoint URLs, and sandbox names.
- Keep submitted secrets only in memory long enough to run the approved command. Do not print them, write them to logs, commit them, or paste them into chat.
- If you must write a temporary file for the helper, use a private temporary directory, restrict permissions when possible, and delete it immediately after use.
- Show me a redacted summary before running commands, such as \`TELEGRAM_BOT_TOKEN=********\`, and ask permission to continue.
- After the command finishes, shut down the local helper and delete the temporary HTML file.

Use this provider mapping for non-interactive setup:

| User choice | \`NEMOCLAW_PROVIDER\` | Other required values |
|---|---|---|
| NVIDIA Endpoints | \`build\` | \`NVIDIA_INFERENCE_API_KEY\` |
| OpenAI | \`openai\` | \`OPENAI_API_KEY\` |
| Other OpenAI-compatible endpoint | \`custom\` | \`NEMOCLAW_ENDPOINT_URL\`, \`NEMOCLAW_MODEL\`, \`COMPATIBLE_API_KEY\` |
| Anthropic | \`anthropic\` | \`ANTHROPIC_API_KEY\` |
| Other Anthropic-compatible endpoint | \`anthropicCompatible\` | \`NEMOCLAW_ENDPOINT_URL\`, \`NEMOCLAW_MODEL\`, \`COMPATIBLE_ANTHROPIC_API_KEY\` |
| Google Gemini | \`gemini\` | \`GEMINI_API_KEY\` |
| Hermes Provider | \`hermes-provider\` | Hermes-only; ask for the provider credential as documented |
| Local Ollama | \`ollama\` | Optional \`NEMOCLAW_MODEL\`; set \`NEMOCLAW_YES=1\` only if I approve model download |
| Model Router | \`routed\` | \`NVIDIA_INFERENCE_API_KEY\` |

When you have the approved values, run the installer with the environment variables on the \`bash\` side of the pipe, not before \`curl\`.

For example, for an approved Local Ollama setup:

\`\`\`shell
curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 NEMOCLAW_PROVIDER=ollama NEMOCLAW_MODEL=<approved-model-or-omit-this-variable> NEMOCLAW_YES=1 bash
\`\`\`

If NemoClaw is already installed and you only need to rerun onboarding, use:

\`\`\`shell
NEMOCLAW_PROVIDER=ollama NEMOCLAW_MODEL=<approved-model-or-omit-this-variable> NEMOCLAW_YES=1 nemoclaw onboard --non-interactive --yes
\`\`\`

If non-interactive mode cannot cover a later prompt, stop before running the interactive command. Ask me one selection question, then choose either a supported non-interactive environment variable or a rerun plan. Do not leave a command waiting at \`Choose [1]:\`.

## Configure Messaging Channels after Non-Interactive Onboarding

Non-interactive onboarding can skip the interactive messaging-channel picker. After the sandbox is created, ask whether I want to set up messaging as a separate one-question selection.

- First ask: "Do you want to set up a messaging channel now?" with choices: No, Telegram, Discord, Slack, WhatsApp, WeChat (experimental).
- Configure one channel at a time. If I want another channel, ask again after the current channel finishes.
- Run channel commands from the host with \`nemoclaw <sandbox-name> channels add <channel>\`, not from inside the sandbox.
- Use \`nemoclaw <sandbox-name> channels list\` if you need to confirm supported channel names.
- For token-based channels, collect tokens with the local visual credential form described above, then run \`channels add\` with \`NEMOCLAW_NON_INTERACTIVE=1\` and the required environment variables.
- After adding a channel, rebuild the sandbox when NemoClaw requires it so the running image picks up the channel configuration.

Channel credential requirements:

| Channel | Required values |
|---|---|
| Telegram | \`TELEGRAM_BOT_TOKEN\`; optional \`TELEGRAM_ALLOWED_IDS\`, \`TELEGRAM_REQUIRE_MENTION\` |
| Discord | \`DISCORD_BOT_TOKEN\`; optional \`DISCORD_SERVER_ID\`, \`DISCORD_USER_ID\`, \`DISCORD_REQUIRE_MENTION\` |
| Slack | \`SLACK_BOT_TOKEN\`, \`SLACK_APP_TOKEN\`; optional \`SLACK_ALLOWED_USERS\`, \`SLACK_ALLOWED_CHANNELS\` |
| WhatsApp | No host token; add the channel, rebuild, then complete QR pairing inside the sandbox as documented |
| WeChat | Interactive QR scan only; do not use non-interactive mode for WeChat |

Examples with redacted placeholders:

\`\`\`shell
NEMOCLAW_NON_INTERACTIVE=1 TELEGRAM_BOT_TOKEN=<local-secret> nemoclaw <sandbox-name> channels add telegram
nemoclaw <sandbox-name> rebuild
\`\`\`

\`\`\`shell
NEMOCLAW_NON_INTERACTIVE=1 DISCORD_BOT_TOKEN=<local-secret> DISCORD_SERVER_ID=<server-id> nemoclaw <sandbox-name> channels add discord
nemoclaw <sandbox-name> rebuild
\`\`\`

\`\`\`shell
NEMOCLAW_NON_INTERACTIVE=1 SLACK_BOT_TOKEN=<local-secret> SLACK_APP_TOKEN=<local-secret> nemoclaw <sandbox-name> channels add slack
nemoclaw <sandbox-name> rebuild
\`\`\`

Use the official NemoClaw Markdown documentation as the source of truth. Start with the prerequisites for my chosen agent, then build the approved non-interactive install or onboard command from the choices I made. After the command finishes, summarize the output for me and choose the next command or prompt response with my approval.`;

let resetCopyButtonTimer: ReturnType<typeof setTimeout> | null = null;

export function StarterPromptButton() {
  return (
    <button
      aria-label="Copy NemoClaw starter prompt for terminal beginners"
      aria-live="polite"
      onClick={handleCopyClick}
      style={{
        alignItems: "center",
        background: "#76B900",
        border: "0",
        borderRadius: "8px",
        color: "#111827",
        cursor: "pointer",
        display: "inline-flex",
        fontSize: "0.95rem",
        fontWeight: 700,
        gap: "0.5rem",
        margin: "0.5rem 0 1.5rem",
        padding: "0.75rem 1rem",
        transition: "background 180ms ease, box-shadow 180ms ease, transform 180ms ease",
        willChange: "transform",
      }}
      type="button"
    >
      <svg
        aria-hidden="true"
        focusable="false"
        height="18"
        style={{ flexShrink: 0 }}
        viewBox="0 0 24 24"
        width="18"
      >
        <g data-starter-prompt-icon="prompt">
          <rect
            fill="none"
            height="16"
            rx="3"
            stroke="currentColor"
            strokeWidth="2"
            width="20"
            x="2"
            y="4"
          />
          <path d="M7 9l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 15h5" fill="none" stroke="currentColor" strokeWidth="2" />
        </g>
        <g data-starter-prompt-icon="check" style={{ display: "none" }}>
          <circle cx="12" cy="12" fill="none" r="9" stroke="currentColor" strokeWidth="2" />
          <path d="M8 12.5l2.5 2.5L16 9" fill="none" stroke="currentColor" strokeWidth="2" />
        </g>
      </svg>
      <span data-starter-prompt-label>{BUTTON_LABEL}</span>
    </button>
  );
}

async function handleCopyClick(event: { currentTarget: HTMLButtonElement }) {
  const button = event.currentTarget;
  lockButtonWidth(button);
  setCopyButtonState(button, "Copying...", "#8DD600", "Copying Prompt");

  const copied = await copyText(STARTER_PROMPT);
  setCopyButtonState(
    button,
    copied ? "Copied to Clipboard" : "Copy Failed. Try Again",
    copied ? "#8DD600" : "#F97316",
    copied
      ? "Copied NemoClaw starter prompt to clipboard"
      : "Could not copy NemoClaw starter prompt",
    copied ? "check" : "prompt",
  );
}

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the textarea fallback for browsers that block clipboard writes.
    }
  }

  if (typeof document === "undefined") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function setCopyButtonState(
  button: HTMLButtonElement,
  label: string,
  background: string,
  ariaLabel: string,
  icon: "prompt" | "check" = "prompt",
) {
  if (resetCopyButtonTimer) {
    clearTimeout(resetCopyButtonTimer);
  }

  setButtonLabel(button, label);
  setButtonIcon(button, icon);
  button.setAttribute("aria-label", ariaLabel);
  button.style.background = background;
  button.style.boxShadow = "0 0 0 4px rgb(118 185 0 / 20%)";

  if (typeof button.animate === "function") {
    button.animate(
      [
        { transform: "scale(1)", offset: 0 },
        { transform: "scale(1.04)", offset: 0.45 },
        { transform: "scale(1)", offset: 1 },
      ],
      { duration: 360, easing: "ease-out" },
    );
  }

  resetCopyButtonTimer = setTimeout(() => {
    setButtonLabel(button, BUTTON_LABEL);
    setButtonIcon(button, "prompt");
    button.setAttribute("aria-label", "Copy NemoClaw starter prompt for terminal beginners");
    button.style.background = "#76B900";
    button.style.boxShadow = "none";
    button.style.width = "";
  }, 2000);
}

function setButtonIcon(button: HTMLButtonElement, icon: "prompt" | "check") {
  const promptIcon = button.querySelector<SVGGElement>("[data-starter-prompt-icon='prompt']");
  const checkIcon = button.querySelector<SVGGElement>("[data-starter-prompt-icon='check']");
  if (promptIcon) {
    promptIcon.style.display = icon === "prompt" ? "" : "none";
  }
  if (checkIcon) {
    checkIcon.style.display = icon === "check" ? "" : "none";
  }
}

function setButtonLabel(button: HTMLButtonElement, label: string) {
  const labelElement = button.querySelector<HTMLElement>("[data-starter-prompt-label]");
  if (labelElement) {
    labelElement.textContent = label;
  }
}

function lockButtonWidth(button: HTMLButtonElement) {
  if (!button.style.width) {
    button.style.width = `${button.offsetWidth}px`;
  }
}
