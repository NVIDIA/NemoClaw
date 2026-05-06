<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Launch NemoClaw with the Brev Web UI

Use the Brev web UI to launch a hosted NemoClaw sandbox from your browser.
This flow provisions a remote VM, configures inference, starts OpenClaw inside an OpenShell sandbox, and opens the OpenClaw dashboard.

> **Note:** Use this guide when you want to try NemoClaw without installing the CLI or using a local GPU.
> If you want to manage the remote host from a terminal, see Deploy to a Remote GPU Instance (use the `nemoclaw-user-deploy-remote` skill).

## What This Flow Creates

The Brev web flow creates the following resources:

- A Brev-managed Linux VM.
- Docker and the OpenShell runtime on that VM.
- A NemoClaw sandbox running OpenClaw.
- Inference routing for the provider you select during setup.
- A browser-accessible OpenClaw dashboard.

## Prerequisites

- An NVIDIA Brev account at [brev.nvidia.com](https://brev.nvidia.com).
- An NVIDIA API key from [build.nvidia.com](https://build.nvidia.com/settings/api-keys) if you use the default NVIDIA Cloud provider.

You do not need to install local software for this flow.

## Get Your NVIDIA API Key

If you already have an NVIDIA API key skip this section. Otherwise, follow these steps to generate a new key:

1. Go to [build.nvidia.com](https://build.nvidia.com).
2. Sign in or create an account.
3. Click your profile icon in the top right.
4. Select **API Keys**.
5. Click **Generate API Key**.
6. Copy the key. It starts with `nvapi-`.

Keep this key ready for the next step.

## Launch NemoClaw from Brev

Use the [NemoClaw Brev launchable](https://brev.nvidia.com/launchable/deploy/now?launchableID=env-3Azt0aYgVNFEuz7opyx3gscmowS) to launch a NemoClaw sandbox from your browser.

1. Open the [NemoClaw Brev launchable](https://brev.nvidia.com/launchable/deploy/now?launchableID=env-3Azt0aYgVNFEuz7opyx3gscmowS) and sign in if prompted.
2. Review the instance type, cloud provider, and estimated hourly cost on the NemoClaw setup page.
3. Click **Deploy NemoClaw**.

The right-side deployment panel shows progress while Brev deploys the CPU instance and prepares VM mode.
Keep this page open until the deployment completes.
When the panel shows the **NemoClaw** button, click it to open the agent setup page.

## Configure Your Agent

The setup page walks you through three stages: **Configure**, **Setup**, and **Launch**.

### Configure

The Configure stage opens the **Connect to AI** screen.
Use the NVIDIA Cloud provider shown on this screen.

1. Leave **NVIDIA Cloud** selected.
2. Paste your `nvapi-` API key.
3. Click **Create Agent**.

> **Note:** The **Show Other Providers** dropdown appears below the **NVIDIA Cloud** card and can be easy to miss.
> Click it to expand the provider list.
> The expanded list includes **OpenAI**, **Anthropic**, and **Google Gemini**.
> For these providers, get the API key from the provider's own console before you create the agent.

### Setup

NemoClaw configures the remote host and sandbox automatically.
This stage usually takes about 5 minutes.

During setup, NemoClaw installs the runtime, prepares the sandboxed agent environment, and configures inference routing for the provider you selected.

### Launch

When setup finishes, Brev shows the following confirmation:

```text
AGENT CREATED SUCCESSFULLY
Your agent is running in a secure sandbox and ready to use.

Agent: agent
Model: nemotron-3-super-120b
Provider: NVIDIA Cloud
```

Click **Chat With Agent** to open the OpenClaw dashboard.

:> **Note:** The dashboard might initially show a **Pairing required** warning.
> This means the gateway is still completing pairing in the background.
> Wait for about a few minutes for pairing to finish automatically. Refresh the dashboard to see if the warning is resolved and the connection is established.
> If pairing does not finish, go to the **Overview** page in the OpenClaw UI, find the **Gateway Access** panel, and click **Connect**.:

## Start a Chat

Use the dashboard chat box to send your first message:

```text
Hello! What can you do for me? What skills do you have available?
```

The agent reads its workspace files and introduces itself.
The starter workspace includes example skills such as:

- **Weather** gets current weather and forecasts.
- **Healthcheck** runs security audit and hardening checks.
- **Skill-Creator** creates new custom skills.

## Personalize Agent Memory

The agent starts with an empty `USER.md` file.
Ask the agent to add details that help it personalize future responses.

In the chat, type the following:

```text
Please update my USER.md file with the following:
Name: [your name]
Timezone: [your timezone, such as "America/New_York"]
Notes: [what you are working on]
```

The agent writes this information to its workspace so it can use it across sessions on the same sandbox.

## Stop Your Instance When Done

Brev continues billing while the instance runs.
Stop the instance when you finish experimenting.

1. Go back to [brev.nvidia.com](https://brev.nvidia.com).
2. Click **GPUs** in the nav bar.
3. Find your NemoClaw instance.
4. Click **Stop**.

Check the Brev UI for the current hourly price before leaving the instance running.

## Next Steps

After your agent is running, explore these related tasks:

- Set Up Messaging Channels (use the `nemoclaw-user-manage-sandboxes` skill) to learn how to connect Telegram, Slack, or Discord.
- Switch Inference Providers (use the `nemoclaw-user-configure-inference` skill) to learn how to change the model provider after setup.
- Monitor Sandbox Activity (use the `nemoclaw-user-monitor-sandbox` skill) to learn how to inspect sandbox health and logs.
- Deploy to a Remote GPU Instance (use the `nemoclaw-user-deploy-remote` skill) to learn how to deploy NemoClaw to a remote GPU instance using the CLI.
- Troubleshooting (use the `nemoclaw-user-reference` skill) to learn how to fix common setup and runtime issues.
