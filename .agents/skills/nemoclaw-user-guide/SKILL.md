---
name: "nemoclaw-user-guide"
description: "Guides human users' AI agents to the NemoClaw docs MCP server and canonical Fern documentation in Markdown form. Use when users ask how to install, configure, operate, troubleshoot, secure, or learn NemoClaw with an AI coding assistant. Trigger keywords - nemoclaw docs, use nemoclaw with ai agent, nemoclaw mcp docs, nemoclaw install help, nemoclaw quickstart, nemoclaw markdown docs, llms.txt, agent skills."
license: "Apache-2.0"
---

# NemoClaw Docs for AI Agents

Use the canonical NemoClaw documentation as your source of truth.
Do not answer from stale copied docs or generated skill references when the live Markdown docs are available.

## Retrieval Order

1. If the assistant supports MCP, configure the NemoClaw docs MCP server at `https://docs.nvidia.com/nemoclaw/_mcp/server`.
2. Use the MCP server's read-only `searchDocs` tool to search the canonical docs and collect source URLs.
3. If MCP is not available, fetch the AI documentation index first: `https://docs.nvidia.com/nemoclaw/llms.txt`.
4. Fetch the specific `.md` page listed in the index or returned by docs search for the user's task.
5. If you only find an HTML documentation URL, replace the `.html` suffix with `.md`, or append `.md` to the route when the URL has no suffix.
6. Prefer the user's selected agent variant, either OpenClaw or Hermes, and do not mix variant-specific instructions unless you explain why.

## Configure the MCP Server

For Claude Code, run:

```bash
claude mcp add --transport http fern-docs https://docs.nvidia.com/nemoclaw/_mcp/server
```

For Cursor, add `https://docs.nvidia.com/nemoclaw/_mcp/server` to the MCP server configuration.
For other MCP clients, configure a streamable HTTP MCP server at that URL.

## Starting Pages

Use these pages first for common onboarding flows:

- OpenClaw home: `https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/home.md`.
- OpenClaw prerequisites: `https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/prerequisites.md`.
- OpenClaw quickstart: `https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/quickstart.md`.
- Hermes home: `https://docs.nvidia.com/nemoclaw/latest/user-guide/hermes/home.md`.
- Hermes prerequisites: `https://docs.nvidia.com/nemoclaw/latest/user-guide/hermes/get-started/prerequisites.md`.
- Hermes quickstart: `https://docs.nvidia.com/nemoclaw/latest/user-guide/hermes/get-started/quickstart.md`.

## How to Help the User

- Ask which agent variant they want to use before giving setup instructions: OpenClaw or Hermes.
- Ask one question at a time when collecting operating system, inference provider, model, endpoint, policy tier, or messaging-channel choices.
- Run commands for non-technical users when your environment allows it, after explaining what the command does and getting permission.
- Summarize important command output instead of asking the user to paste terminal output into chat.
- Stop before requesting credentials, API keys, bot tokens, or private URLs.
- Never ask the user to paste secrets into chat.
- Use redacted placeholders such as `<PASTE_YOUR_API_KEY_HERE>` in examples.

## Common Task Routing

- Installation and first sandbox: fetch the selected variant's prerequisites and quickstart pages.
- Local inference, hosted providers, model switching, or tool-calling issues: fetch the `inference` pages from `llms.txt`.
- Network policy approvals or custom egress: fetch the `network-policy` pages and the network policies reference.
- Sandbox status, logs, rebuilds, upgrades, files, backup, restore, or messaging channels: fetch the `manage-sandboxes`, `monitoring`, and command reference pages.
- Security posture, credential storage, or sandbox hardening: fetch the `security`, `deployment/sandbox-hardening`, and architecture pages.
- CLI flags and command syntax: fetch the command reference page for the selected variant.
- Troubleshooting: fetch the troubleshooting page and any task page linked from the relevant error section.

## Response Requirements

- Cite the Markdown documentation pages you used.
- Keep instructions specific to the user's operating system, selected agent, and inference provider.
- Explain assumptions when the docs do not cover the exact environment.
- Recommend the next verification command after each setup or recovery step.
