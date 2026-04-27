# Get Started with NemoClaw on Brev (Web UI)

Run a sandboxed NemoClaw agent in minutes using the Brev web interface.
No CLI installation, no local setup, no GPU required on your machine.

> **Note:** This guide covers the Brev web UI flow, which is the fastest
> way to try NemoClaw. If you prefer the CLI-based remote deployment,
> see [Deploy to a Remote GPU Instance](deploy-to-remote-gpu.md).

## Prerequisites

- A free Brev account at [brev.nvidia.com](https://brev.nvidia.com)
- A free NVIDIA API key from [build.nvidia.com](https://build.nvidia.com)

That's it. No local software installation needed.

## Step 1: Get Your NVIDIA API Key

1. Go to [build.nvidia.com](https://build.nvidia.com)
2. Sign in or create a free account
3. Click your profile icon in the top right
4. Select **API Keys**
5. Click **Generate API Key**
6. Copy the key -- it starts with `nvapi-`

Keep this key ready for the next step.

## Step 2: Deploy NemoClaw on Brev

1. Go to [brev.nvidia.com](https://brev.nvidia.com) and sign in
2. On the **GPUs** page, look for the banner:
   **"Your agents are waiting. Meet NemoClaw"**
3. Click **Try NemoClaw**
4. You will see the NemoClaw setup page showing:
   - Instance type: CPU (4 CPUs, 16 GiB RAM)
   - Cloud Provider: GCP
   - Cost: $0.18/hr
5. Click **Deploy NemoClaw**

## Step 3: Configure Your Agent (3 Steps)

### Step 1 of 3 -- Connect to AI

- **NVIDIA Cloud** is selected by default (recommended)
- This uses Nemotron-3-Super-120B hosted by NVIDIA
- Paste your `nvapi-` API key in the field
- Click **Create Agent**

> **Other providers available:** OpenAI, Anthropic, Google Gemini,
> Local Ollama. Click "Show Other Providers" to see all options.

### Step 2 of 3 -- Setup

NemoClaw automatically:
- Provisions a secure Linux VM on GCP
- Installs Docker and the OpenShell runtime
- Sets up the sandboxed agent environment
- Configures inference routing to NVIDIA Cloud

This takes approximately 2-3 minutes.

### Step 3 of 3 -- Launch

When setup completes you will see:

```
AGENT CREATED SUCCESSFULLY
Your agent is running in a secure sandbox and ready to use.

Agent: agent
Model: nemotron-3-super-120b
Provider: NVIDIA Cloud
```

Click **Chat With Agent** to open the OpenClaw Gateway Dashboard.

## Step 4: Understand the Dashboard

The OpenClaw Gateway Dashboard has the following sections:

**Chat**
Direct chat interface for talking to your agent. This is where
you start. The agent reads your workspace files and responds
using Nemotron-3-Super-120B via NVIDIA Cloud.

**Control**
- **Overview** -- Agent health and status
- **Channels** -- Connect to Slack, Telegram, or Discord
- **Instances** -- Running agent instances
- **Sessions** -- Conversation history
- **Usage** -- Token and API usage
- **Cron Jobs** -- Schedule recurring agent tasks

**Agent**
- **Agents** -- Manage agent profiles
- **Skills** -- Add new capabilities to your agent
- **Nodes** -- Multi-agent node configuration

**Settings**
- **Config** -- Agent configuration
- **Debug** -- Debug logs and diagnostics

## Step 5: Have Your First Conversation

In the Chat box, type:

```
Hello! What can you do for me? What skills do you have available?
```

The agent will read its workspace files and introduce itself.
By default it has three skills available:

- **Weather** -- Get current weather and forecasts
- **Healthcheck** -- Security audit and hardening
- **Skill-Creator** -- Create new custom skills

## Step 6: Tell the Agent Who You Are

The agent starts with an empty USER.md file -- it knows nothing
about you. Update it so the agent can personalize its responses.

In the chat, type:

```
Please update my USER.md file with the following:
Name: [your name]
Timezone: [your timezone, e.g. EST]
Notes: [what you are working on]
```

The agent will write this to your workspace so it remembers
you across sessions.

## Step 7: Stop Your Instance When Done

To avoid unnecessary charges, stop your instance when you are
finished experimenting.

1. Go back to [brev.nvidia.com](https://brev.nvidia.com)
2. Click **GPUs** in the nav bar
3. Find your NemoClaw instance
4. Click **Stop**

At $0.18/hr, a 3-hour session costs approximately $0.54.

## What to Try Next

Now that your agent is running, explore these capabilities:

**Connect a messaging channel**
Go to **Channels** in the dashboard to connect your agent
to Telegram, Slack, or Discord so it can message you proactively.

**Add a new skill**
Go to **Skills** and browse available skills, or use the
built-in Skill-Creator to build your own custom skill.

**Schedule a recurring task**
Go to **Cron Jobs** to set up tasks the agent runs automatically,
such as a daily email check or calendar reminder.

**Use a different AI model**
The agent supports switching inference providers at runtime.
See [Switch Inference Providers](../inference/switch-inference-providers.md)
for instructions.

## Troubleshooting

**The Deploy NemoClaw button is not visible**
Make sure you are signed in to brev.nvidia.com. The banner
appears on the GPUs page. If you do not see it, try refreshing
the page or navigating directly to the NemoClaw tab in the
top navigation.

**API key not accepted**
Make sure your key starts with `nvapi-` and was copied in full.
Keys from build.nvidia.com are free and do not require a paid plan.

**Agent takes more than 5 minutes to deploy**
This can happen during periods of high demand on Brev.
The Cloudflare quota warning at the top of the Brev page
("Secure Links and Tunnels may not be created successfully")
may affect deployment time. Try again after a few minutes.

**OpenClaw dashboard shows a blank chat**
This is normal on first launch. The agent reads its workspace
files during the first session startup. Type a message and
wait a few seconds for the first response.

## Related Topics

- [Quickstart](../get-started/quickstart.md) -- CLI-based local setup
- [Deploy to a Remote GPU Instance](deploy-to-remote-gpu.md) -- CLI-based Brev deployment
- [Set Up the Telegram Bridge](set-up-telegram-bridge.md)
- [Monitor Sandbox Activity](../monitoring/monitor-sandbox-activity.md)
