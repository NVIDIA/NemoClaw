---
name: "nemoclaw-user-guide"
description: "Find official NemoClaw documentation for installation, configuration, operation, or troubleshooting. Also handles requested docs MCP setup."
license: "Apache-2.0"
---

# NemoClaw Docs for AI Agents

Use the canonical NemoClaw documentation as your source of truth.
Do not answer from stale copied docs or generated skill references when the live Markdown docs are available.

## Retrieval Order

1. If the NemoClaw docs MCP server is already configured, use its read-only `searchDocs` tool to find task-relevant docs.
2. Otherwise, use the Markdown index and pages below. Docs lookup does not require installing or configuring MCP.
3. If MCP is not available, fetch the AI documentation index first: `https://docs.nvidia.com/nemoclaw/llms.txt`.
4. Fetch the specific `.md` page listed in the index or returned by docs search for the user's task.
5. If you only find an HTML documentation URL, replace the `.html` suffix with `.md`, or append `.md` to the route when the URL has no suffix.
6. Prefer the user's selected agent variant. Do not mix variant-specific instructions unless you explain why.

## Optional setup and starting pages

Read [Docs Access](references/docs-access.md) when the user requests MCP configuration or when
starting an installation needs direct links for the selected agent variant. Ordinary docs questions
can use the index without reading that reference.

## How to Help the User

- Use the selected agent variant from the request or current sandbox. Ask when it cannot be determined and changes the instructions. Check the selected release's support status, including Pi activation.
- Ask only for missing operating-system, provider, model, endpoint, policy, or channel choices that affect the requested task.
- Run commands within the user's requested scope and the environment's permissions. Explain material effects; request authorization only for effects outside that scope.
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

- Cite the documentation pages used with direct source links.
- Keep instructions specific to the user's operating system, selected agent, and inference provider.
- Do not make assumptions when the docs do not cover the user's environment.
- Verify the requested setup or recovery outcome with the relevant documented check.
