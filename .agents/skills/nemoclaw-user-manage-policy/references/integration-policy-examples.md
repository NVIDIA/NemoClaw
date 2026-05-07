<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Common NemoClaw Integration Policy Examples

Use these examples when a sandbox is already installed and an integration needs network access.
This page covers only integrations that NemoClaw currently ships as maintained policy preset YAML under `nemoclaw-blueprint/policies/presets/`.
Integration setup usually has two separate parts:

- Configure the integration itself, such as a bot token, OAuth credential, or agent plugin setting.
- Allow the sandbox to reach the integration's network endpoints through NemoClaw and OpenShell policy.

Prefer NemoClaw commands for policy changes that should be tracked with the sandbox.
Use OpenShell directly when you need to inspect blocked requests or approve a one-off request in the TUI.

## Before You Start

Replace `my-assistant` with your sandbox name in the examples.

Check the current policy state first:

```console
$ nemoclaw my-assistant policy-list
```

For a live view of blocked requests, open the OpenShell TUI in a separate host terminal:

```console
$ openshell term
```

When the agent reaches an endpoint that is not in policy, the TUI shows the host, port, requesting binary, method, and path when available.
Approve a request only when you understand why the integration needs it.
An approval updates the running policy, but it does not create a NemoClaw preset entry that can be reviewed and replayed like `policy-add`.

## Supported Integration Presets

NemoClaw ships maintained policy presets for common services in `nemoclaw-blueprint/policies/presets/`.

| Workflow | Preset |
|----------|--------|
| Brave Search | `brave` |
| Homebrew packages | `brew` |
| Discord messaging | `discord` |
| GitHub and GitHub API | `github` |
| Hugging Face Hub and Inference API | `huggingface` |
| Jira and Atlassian Cloud | `jira` |
| Local Ollama or vLLM through the host gateway | `local-inference` |
| npm and Yarn packages | `npm` |
| Microsoft 365, Outlook, and Graph API | `outlook` |
| Python Package Index | `pypi` |
| Slack messaging | `slack` |
| Telegram Bot API | `telegram` |

Preview the endpoints before applying:

```console
$ nemoclaw my-assistant policy-add outlook --dry-run
```

Apply the preset:

```console
$ nemoclaw my-assistant policy-add outlook --yes
```

Remove it later if the sandbox no longer needs that access:

```console
$ nemoclaw my-assistant policy-remove outlook --yes
```

## Email and Calendar With Microsoft 365

Use the `outlook` preset for Microsoft 365 email and calendar workflows that use Microsoft Graph or Outlook endpoints.
The preset allows `graph.microsoft.com`, Microsoft login, and Outlook service endpoints.

```console
$ nemoclaw my-assistant policy-add outlook --dry-run
$ nemoclaw my-assistant policy-add outlook --yes
```

Then configure the email or calendar tool credentials through the integration you are running in the sandbox.
Keep OAuth client secrets and refresh tokens out of policy files.

If the tool still fails, run `openshell term`, trigger the workflow again, and inspect the blocked request.
If the blocked endpoint is not covered by the maintained `outlook` preset, treat it as a separate policy review instead of assuming it is part of the supported preset.

## Telegram Bot Messaging

Telegram needs both channel configuration and egress policy.
If you already enabled Telegram during onboarding but did not include the preset, add it to the running sandbox:

```console
$ nemoclaw my-assistant policy-add telegram --yes
```

To add Telegram after onboarding, set the token on the host, add the channel, rebuild so the image picks up the channel config, and make sure the policy preset is applied:

```console
$ export TELEGRAM_BOT_TOKEN=<your-bot-token>
$ NEMOCLAW_NON_INTERACTIVE=1 nemoclaw my-assistant channels add telegram
$ nemoclaw my-assistant rebuild
$ nemoclaw my-assistant policy-add telegram --yes
```

If delivery fails, open the TUI and send a test message to the bot:

```console
$ openshell term
```

The matching preset for each supported messaging channel is the channel name (`telegram`, `discord`, or `slack`).

## Slack or Discord Messaging

Slack and Discord also need both channel configuration and egress policy.
Use the matching policy preset after you configure the channel credentials.

For Slack:

```console
$ export SLACK_BOT_TOKEN=<your-slack-bot-token>
$ export SLACK_APP_TOKEN=<your-slack-app-token>
$ NEMOCLAW_NON_INTERACTIVE=1 nemoclaw my-assistant channels add slack
$ nemoclaw my-assistant rebuild
$ nemoclaw my-assistant policy-add slack --yes
```

For Discord:

```console
$ export DISCORD_BOT_TOKEN=<your-discord-bot-token>
$ export DISCORD_SERVER_ID=<your-discord-server-id>
$ NEMOCLAW_NON_INTERACTIVE=1 nemoclaw my-assistant channels add discord
$ nemoclaw my-assistant rebuild
$ nemoclaw my-assistant policy-add discord --yes
```

If you enabled Slack or Discord during onboarding, apply only the matching preset:

```console
$ nemoclaw my-assistant policy-add slack --yes
$ nemoclaw my-assistant policy-add discord --yes
```

## GitHub and Jira

Use `github` when the agent needs GitHub API, Git, or `gh` access.
Use `jira` when the agent needs Atlassian Jira access.

Preview first:

```console
$ nemoclaw my-assistant policy-add github --dry-run
$ nemoclaw my-assistant policy-add jira --dry-run
```

Apply the preset that matches the workflow:

```console
$ nemoclaw my-assistant policy-add github --yes
$ nemoclaw my-assistant policy-add jira --yes
```

Remove access when the task is done:

```console
$ nemoclaw my-assistant policy-remove github --yes
$ nemoclaw my-assistant policy-remove jira --yes
```

## Brave Search

The default Balanced policy tier includes `brave`.
If you chose Restricted during onboarding or removed the preset later, add it before enabling Brave Search workflows:

```console
$ nemoclaw my-assistant policy-add brave --dry-run
$ nemoclaw my-assistant policy-add brave --yes
```

The Brave Search API key is still configured separately during onboarding or through the web search setup flow.

## Package and Model Tooling

Use these presets when an agent workflow installs packages or downloads model assets:

| Workflow | Preset |
|----------|--------|
| npm or Yarn packages | `npm` |
| Python packages from PyPI | `pypi` |
| Homebrew packages | `brew` |
| Hugging Face model or dataset access | `huggingface` |

Add only the preset required for the task:

```console
$ nemoclaw my-assistant policy-add npm --yes
$ nemoclaw my-assistant policy-add pypi --yes
$ nemoclaw my-assistant policy-add brew --yes
$ nemoclaw my-assistant policy-add huggingface --yes
```

Remove package access after a one-time setup task if the sandbox no longer needs it:

```console
$ nemoclaw my-assistant policy-remove npm --yes
$ nemoclaw my-assistant policy-remove pypi --yes
$ nemoclaw my-assistant policy-remove brew --yes
$ nemoclaw my-assistant policy-remove huggingface --yes
```

## Local Inference

Use `local-inference` when the sandbox needs access to host-side local inference services such as Ollama or vLLM through the OpenShell host gateway.
Onboarding auto-suggests this preset when you choose a local provider.
If you need to add it after onboarding:

```console
$ nemoclaw my-assistant policy-add local-inference --dry-run
$ nemoclaw my-assistant policy-add local-inference --yes
```

Then verify the sandbox status:

```console
$ nemoclaw my-assistant status
```

## Inspect or Replace the Live Policy

Use `policy-list` for normal preset state:

```console
$ nemoclaw my-assistant policy-list
```

Use OpenShell when you need the full enforced YAML:

```console
$ openshell policy get --full my-assistant > live-policy.yaml
```

If you must replace the live policy, edit the full policy file and set it back:

```console
$ openshell policy set --policy live-policy.yaml my-assistant --wait
```

`openshell policy set` replaces the live policy with the file you provide.
It does not accept a preset file that starts with a `preset:` block, and it does not merge a single endpoint into the existing policy.
Use `nemoclaw my-assistant policy-add` for maintained NemoClaw presets.

## Next Steps

- Approve or Deny Agent Network Requests (use the `nemoclaw-user-manage-policy` skill) for the interactive OpenShell TUI flow.
- Customize the Sandbox Network Policy (use the `nemoclaw-user-manage-policy` skill) for static policy edits and raw OpenShell policy files.
- Messaging Channels (use the `nemoclaw-user-manage-sandboxes` skill) for Telegram, Discord, and Slack channel configuration.
- Commands (use the `nemoclaw-user-reference` skill) for the full `policy-add`, `policy-list`, `policy-remove`, and `channels` command reference.
