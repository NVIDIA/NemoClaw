---
title:
  page: "Create Sub-Agents"
  nav: "Create Sub-Agents"
description: "How to create additional OpenClaw agents inside a NemoClaw sandbox and persist them across sandbox restarts."
keywords: ["nemoclaw sub agents", "openclaw agents add", "nemoclaw create agent", "multi-agent sandbox"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "nemoclaw", "workspace", "multi-agent"]
content:
  type: how_to
  difficulty: technical_intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Create Sub-Agents

Use additional OpenClaw agents when one sandbox needs multiple specialized personas, workspaces, or routing targets.
Each agent gets its own workspace, session store, and agent state directory.

In NemoClaw, you create these agents from inside the sandbox with the OpenClaw CLI.

## What a Sub-Agent Is

In practical terms, a sub-agent in NemoClaw is an additional OpenClaw agent entry under `agents.list`.
Each entry can have its own:

- `workspace` directory with `SOUL.md`, `AGENTS.md`, `IDENTITY.md`, and related files.
- `agentDir` for auth profiles and per-agent state.
- model selection.
- channel bindings if you want traffic routed to that agent.

To appear in `agents_list` or be targetable with `sessions_spawn`, the requester agent must also allow that target through `subagents.allowAgents`.

## Prerequisites

- A running sandbox, shown by `nemoclaw list`.
- Shell access with `nemoclaw <name> connect`.
- A clear agent id that follows lowercase RFC 1123-style naming, such as `designer`, `coder`, or `jophiel`.

## Step 1: Connect to the Sandbox

```console
$ nemoclaw my-assistant connect
```

You should land in the sandbox shell.

## Step 2: Target the Writable Runtime Config

NemoClaw keeps the base `openclaw.json` under `/sandbox/.openclaw/openclaw.json` as an immutable file.
That means `openclaw agents add` must target the writable runtime config instead.

In the sandbox shell, set:

```console
$ export OPENCLAW_CONFIG_PATH=/tmp/nemoclaw/openclaw.json
```

:::{note}
If you omit this variable, `openclaw agents add` can fail with a permission error because it tries to write next to the immutable base config.
:::

## Step 3: Create the Agent

Run `openclaw agents add` with an explicit workspace path and non-interactive flags.

```console
$ openclaw agents add jophiel \
    --workspace /sandbox/.openclaw-data/workspace-jophiel \
    --model inference/qwen3.5:9b-64k \
    --non-interactive \
    --json
```

This writes a new `agents.list[]` entry to the runtime config and creates the new workspace.

## Step 4: Ensure the Agent State Directory Exists

Some OpenClaw versions create the workspace and sessions directory but do not materialize the final agent state directory immediately.
Create it if needed:

```console
$ mkdir -p /sandbox/.openclaw/agents/jophiel/agent
```

## Step 5: Add the Agent Persona Files

Write the new agent's workspace files under its workspace directory.
For example:

```console
$ ls /sandbox/.openclaw-data/workspace-jophiel/
AGENTS.md
BOOTSTRAP.md
HEARTBEAT.md
IDENTITY.md
SOUL.md
TOOLS.md
USER.md
```

Update `SOUL.md`, `AGENTS.md`, and `IDENTITY.md` for that agent just as you would for the main agent.

## Step 6: Verify the Agent Runs

Use a direct local agent call:

```console
$ openclaw agent --agent jophiel --local -m "Reply with exactly JOPHIEL_OK" --session-id verify-jophiel --json
```

Expected output includes:

```json

## Optional: Enable GitHub CLI (`gh`) for a Sub-Agent

If you want a sub-agent to run GitHub operations through the GitHub CLI:

1. Ensure the sandbox image includes `gh`.
2. Authenticate `gh` inside the sandbox.
3. Verify the target agent can execute a `gh` command.

### 1) Ensure `gh` exists in the sandbox

New sandboxes built from the latest NemoClaw base image include `gh`.
Existing sandboxes created before that image change must be recreated to pick it up.

Check from a sandbox shell:

```console
$ command -v gh
$ gh --version
```

### 2) Authenticate `gh`

Use token-based auth in the sandbox shell:

```console
$ export GH_TOKEN=<your-token>
$ gh auth login --with-token <<<"$GH_TOKEN"
$ gh auth status
```

Use a least-privilege token that only grants the repo scopes you need.

### 3) Verify the Agent Can Use `gh`

Run a direct local call using your target agent id:

```console
$ openclaw agent --agent <agent-id> --local -m "Run 'gh --version' and return only the first line." --session-id verify-agent-gh --json
```

If this fails with `command not found`, your sandbox image does not yet contain `gh`.
Recreate the sandbox so it uses the updated base image.
{
  "payloads": [
    {
      "text": "JOPHIEL_OK"
    }
  ]
}
```

## Step 7: Allow Main to See or Spawn the Agent

Creating `jophiel` adds the agent to `agents.list`, but it does not automatically make the agent visible to `main`.
OpenClaw restricts `agents_list` and `sessions_spawn` using the requester agent's `subagents.allowAgents` list.

If you want `main` to see only `jophiel`, update the `main` agent entry in the writable runtime config like this:

```console
$ python3 - <<'PY'
import json

path = '/tmp/nemoclaw/openclaw.json'
with open(path) as f:
  cfg = json.load(f)

agents = cfg.setdefault('agents', {}).setdefault('list', [])
main_entry = next((entry for entry in agents if isinstance(entry, dict) and entry.get('id') == 'main'), None)
if main_entry is None:
  main_entry = {'id': 'main'}
  agents.insert(0, main_entry)

main_entry.setdefault('subagents', {})['allowAgents'] = ['jophiel']

with open(path, 'w') as f:
  json.dump(cfg, f, indent=2)
PY
```

If you want `main` to see every configured agent, use `['*']` instead:

```console
$ python3 - <<'PY'
import json

path = '/tmp/nemoclaw/openclaw.json'
with open(path) as f:
  cfg = json.load(f)

agents = cfg.setdefault('agents', {}).setdefault('list', [])
main_entry = next((entry for entry in agents if isinstance(entry, dict) and entry.get('id') == 'main'), None)
if main_entry is None:
  main_entry = {'id': 'main'}
  agents.insert(0, main_entry)

main_entry.setdefault('subagents', {})['allowAgents'] = ['*']

with open(path, 'w') as f:
  json.dump(cfg, f, indent=2)
PY
```

After updating the allowlist, you can verify that `main` now sees the agent:

```console
$ openclaw agent --agent main --local -m "Call the agents_list tool and return only its raw JSON result." --session-id verify-main-allowlist --json
```

Expected output includes `jophiel` in the returned `agents` array.

## Step 8: Persist the Agent Across Sandbox Restarts

On current NemoClaw builds, the runtime config is regenerated when the sandbox gateway starts.
To keep custom agents across sandbox restarts, copy non-default agents into the sandbox-local overlay file.
If you also configured `main.subagents.allowAgents`, persist a minimal `main` overlay entry alongside the custom agents:

```console
$ python3 - <<'PY'
import json

with open('/tmp/nemoclaw/openclaw.json') as f:
    cfg = json.load(f)

agent_list = []

for entry in (cfg.get('agents', {}).get('list') or []):
  if not isinstance(entry, dict):
    continue

  if entry.get('id') == 'main':
    allow_agents = ((entry.get('subagents') or {}).get('allowAgents') or [])
    if allow_agents:
      agent_list.append({
        'id': 'main',
        'subagents': {
          'allowAgents': allow_agents,
        },
      })
    continue

  agent_list.append(entry)

with open('/sandbox/.nemoclaw/agents-overlay.json', 'w') as f:
    json.dump({'agents': {'list': agent_list}}, f, indent=2)
PY
```

The startup script merges `/sandbox/.nemoclaw/agents-overlay.json` into the runtime config when the sandbox starts.

:::{note}
This is sandbox-local state, not a global default for all future sandboxes.
Only sandboxes that contain this overlay file load those additional agents.

The overlay merge preserves the basic agent entry fields such as `id`, `name`, `workspace`, `agentDir`, `model`, `default`, and `identity`.
It also preserves `subagents.allowAgents` when you include that field in the overlay entry.
:::

## Optional: Make the Agent Visible in the Control UI

Seed a webchat session entry so the Control UI can surface the agent immediately:

```console
$ python3 - <<'PY'
import json
import os

store_path = '/sandbox/.openclaw-data/agents/jophiel/sessions/sessions.json'
os.makedirs(os.path.dirname(store_path), exist_ok=True)

store = {}
if os.path.exists(store_path):
    with open(store_path) as f:
        store = json.load(f)

store['agent:jophiel:main'] = {
    'sessionId': 'init-jophiel',
    'chatType': 'direct',
    'deliveryContext': {'channel': 'webchat'},
    'lastChannel': 'webchat',
    'origin': {'provider': 'webchat', 'surface': 'webchat', 'chatType': 'direct'},
}

with open(store_path, 'w') as f:
    json.dump(store, f)
PY
```

## Troubleshooting

`EACCES` while running `openclaw agents add`

Set `OPENCLAW_CONFIG_PATH=/tmp/nemoclaw/openclaw.json` before running the command.

Agent appears in `agents list` but will not answer

Create the missing agent directory with `mkdir -p /sandbox/.openclaw/agents/<agent-id>/agent` and test again.

Agent disappears after restart

Write the non-default agent entries into `/sandbox/.nemoclaw/agents-overlay.json`.

Agent exists, but `main` cannot see or spawn it

Update `main.subagents.allowAgents` in `/tmp/nemoclaw/openclaw.json` to include the agent id or `*`.
If you want it to survive restart, include a minimal `main` entry with that allowlist in `/sandbox/.nemoclaw/agents-overlay.json`.

`main` is missing or routes to another agent in an older sandbox

Run `nemoclaw <name> repair-main` from the host to rebuild the explicit `main` entry in `/tmp/nemoclaw/openclaw.json` without manual edits.
Use `--model <model>` if you also want to pin a specific primary model during the repair.

Agent does not appear in the Control UI

Seed the webchat session metadata in `/sandbox/.openclaw-data/agents/<agent-id>/sessions/sessions.json`.

## Next Steps

- [Workspace Files](workspace-files.md)
- [Serialized Turn-Taking](serialized-turn-taking.md)
- [Back Up and Restore](backup-restore.md)
- [Commands reference](../reference/commands.md)
