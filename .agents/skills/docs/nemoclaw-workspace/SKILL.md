---
name: nemoclaw-workspace
description: Hows to back up and restore OpenClaw workspace files before destructive operations. Also covers hows to create additional OpenClaw agents inside a NemoClaw sandbox and persist them across sandbox restarts; prototypes workflow for running multiple OpenClaw agents one at a time while switching the shared inference route between their models. Use when agents.md, back restore workspace files, backup, create subagents, identity.md, inference, memory.md, model switching orchestration.
---

# Nemoclaw Workspace

How to back up and restore OpenClaw workspace files before destructive operations.

## Context

OpenClaw stores agent identity, behavior, and memory in a set of Markdown files inside the sandbox.
These files live at `/sandbox/.openclaw/workspace/` and are read by the agent at the start of every session.

## File Reference

Each file controls a distinct aspect of the agent's behavior and memory.

| File | Purpose | Upstream Docs |
|---|---|---|
| `SOUL.md` | Core personality, tone, and behavioral rules. | [SOUL template](https://docs.openclaw.ai/reference/templates/SOUL) |
| `USER.md` | Preferences, context, and facts the agent learns about you. | [USER template](https://docs.openclaw.ai/reference/templates/USER) |
| `IDENTITY.md` | Agent name, creature type, emoji, and self-presentation. | [IDENTITY template](https://docs.openclaw.ai/reference/templates/IDENTITY) |
| `AGENTS.md` | Multi-agent coordination, memory conventions, and safety guidelines. | [AGENTS template](https://docs.openclaw.ai/reference/templates/AGENTS) |
| `MEMORY.md` | Curated long-term memory distilled from daily notes. | — |
| `memory/` | Directory of daily note files (`YYYY-MM-DD.md`) for session continuity. | — |

## Where They Live

All workspace files reside inside the sandbox filesystem:

```text
/sandbox/.openclaw/workspace/
├── AGENTS.md
├── IDENTITY.md
├── MEMORY.md
├── SOUL.md
├── USER.md
└── memory/
    ├── 2026-03-18.md
    └── 2026-03-19.md
```

> **Note:** The workspace directory is hidden (`.openclaw`).
> The files are not at `/sandbox/SOUL.md` — use the full path when downloading or uploading.

## Persistence Behavior

Understanding when these files persist and when they are lost is critical.

| Event | Workspace files |
|---|---|
| Sandbox restart | **Preserved** — the sandbox PVC retains its data. |
| `nemoclaw <name> destroy` | **Lost** — the sandbox and its PVC are deleted. |

> **Warning:** Always back up your workspace files before running `nemoclaw <name> destroy`.
> See Back Up and Restore (see the `nemoclaw-workspace` skill) for instructions.

## Editing Workspace Files

The agent reads these files at the start of every session.
You can edit them in two ways:

1. **Let the agent do it** — Ask your agent to update its persona, memory, or user context during a session.
2. **Edit manually** — Use `openshell sandbox connect` to open a terminal inside the sandbox and edit files directly, or use `openshell sandbox upload` to push edited files from your host.

## Prerequisites

- A running NemoClaw sandbox (for backup) or a freshly created sandbox (for restore).
- The OpenShell CLI on your `PATH`.
- The sandbox name (shown by `nemoclaw list`).
- A running sandbox, shown by `nemoclaw list`.
- Shell access with `nemoclaw <name> connect`.
- A clear agent id that follows lowercase RFC 1123-style naming, such as `designer`, `coder`, or `jophiel`.

Workspace files define your agent's personality, memory, and user context.
They persist across sandbox restarts but are **permanently deleted** when you run `nemoclaw <name> destroy`.

This guide covers manual backup with CLI commands and an automated script.

## Step 1: Recommended Commands

Use the built-in NemoClaw commands for full sandbox backups:

```console
$ nemoclaw my-assistant backup
$ nemoclaw my-assistant restore
```

Use `nemoclaw my-assistant backup --label pre-upgrade` to create a named snapshot, or `nemoclaw my-assistant backup --list` to inspect saved backups.
If the sandbox is missing during restore, NemoClaw recreates it before restoring the archive and reapplies the saved provider and model configuration.

## Step 2: When to Back Up

- Before running `nemoclaw <name> destroy`.
- Before major NemoClaw version upgrades.
- Periodically, if you have invested time customizing your agent.

## Step 3: Manual Backup

Use `openshell sandbox download` to copy files from the sandbox to your host.

```console
$ SANDBOX=my-assistant
$ BACKUP_DIR=~/.nemoclaw/backups/$(date +%Y%m%d-%H%M%S)
$ mkdir -p "$BACKUP_DIR"

$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/SOUL.md "$BACKUP_DIR/"
$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/USER.md "$BACKUP_DIR/"
$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/IDENTITY.md "$BACKUP_DIR/"
$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/AGENTS.md "$BACKUP_DIR/"
$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/MEMORY.md "$BACKUP_DIR/"
$ openshell sandbox download "$SANDBOX" /sandbox/.openclaw/workspace/memory/ "$BACKUP_DIR/memory/"
```

## Step 4: Manual Restore

Use `openshell sandbox upload` to push files back into a sandbox.

```console
$ SANDBOX=my-assistant
$ BACKUP_DIR=~/.nemoclaw/backups/20260320-120000  # pick a timestamp

$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/SOUL.md" /sandbox/.openclaw/workspace/
$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/USER.md" /sandbox/.openclaw/workspace/
$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/IDENTITY.md" /sandbox/.openclaw/workspace/
$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/AGENTS.md" /sandbox/.openclaw/workspace/
$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/MEMORY.md" /sandbox/.openclaw/workspace/
$ openshell sandbox upload "$SANDBOX" "$BACKUP_DIR/memory/" /sandbox/.openclaw/workspace/memory/
```

## Step 5: Using the Backup Script

The repository includes a convenience script at `scripts/backup-workspace.sh`.

### Backup

```console
$ ./scripts/backup-workspace.sh backup my-assistant
Backing up workspace from sandbox 'my-assistant'...
Backup saved to /home/user/.nemoclaw/backups/20260320-120000/ (6 items)
```

### Restore

Restore from the most recent backup:

```console
$ ./scripts/backup-workspace.sh restore my-assistant
```

Restore from a specific timestamp:

```console
$ ./scripts/backup-workspace.sh restore my-assistant 20260320-120000
```

## Step 6: Verifying a Backup

List backed-up files to confirm completeness:

```console
$ ls ~/.nemoclaw/backups/20260320-120000/
AGENTS.md
IDENTITY.md
MEMORY.md
SOUL.md
USER.md
memory/
```

## Step 7: Inspecting Files Inside the Sandbox

Connect to the sandbox to list or view workspace files directly:

```console
$ openshell sandbox connect my-assistant
$ ls -la /sandbox/.openclaw/workspace/
```

---

Use additional OpenClaw agents when one sandbox needs multiple specialized personas, workspaces, or routing targets.
Each agent gets its own workspace, session store, and agent state directory.

In NemoClaw, you create these agents from inside the sandbox with the OpenClaw CLI.

## Step 8: What a Sub-Agent Is

In practical terms, a sub-agent in NemoClaw is an additional OpenClaw agent entry under `agents.list`.
Each entry can have its own:

- `workspace` directory with `SOUL.md`, `AGENTS.md`, `IDENTITY.md`, and related files.
- `agentDir` for auth profiles and per-agent state.
- model selection.
- channel bindings if you want traffic routed to that agent.

To appear in `agents_list` or be targetable with `sessions_spawn`, the requester agent must also allow that target through `subagents.allowAgents`.

## Step 9: Step 1: Connect to the Sandbox

```console
$ nemoclaw my-assistant connect
```

You should land in the sandbox shell.

## Step 10: Step 2: Target the Writable Runtime Config

NemoClaw keeps the base `openclaw.json` under `/sandbox/.openclaw/openclaw.json` as an immutable file.
That means `openclaw agents add` must target the writable runtime config instead.

In the sandbox shell, set:

```console
$ export OPENCLAW_CONFIG_PATH=/tmp/nemoclaw/openclaw.json
```

> **Note:** If you omit this variable, `openclaw agents add` can fail with a permission error because it tries to write next to the immutable base config.

## Step 11: Step 3: Create the Agent

Run `openclaw agents add` with an explicit workspace path and non-interactive flags.

```console
$ openclaw agents add jophiel \
    --workspace /sandbox/.openclaw-data/workspace-jophiel \
    --model inference/qwen3.5:9b-64k \
    --non-interactive \
    --json
```

This writes a new `agents.list[]` entry to the runtime config and creates the new workspace.

## Step 12: Step 4: Ensure the Agent State Directory Exists

Some OpenClaw versions create the workspace and sessions directory but do not materialize the final agent state directory immediately.
Create it if needed:

```console
$ mkdir -p /sandbox/.openclaw/agents/jophiel/agent
```

## Step 13: Step 5: Add the Agent Persona Files

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

## Step 14: Step 6: Verify the Agent Runs

Use a direct local agent call:

```console
$ openclaw agent --agent jophiel --local -m "Reply with exactly JOPHIEL_OK" --session-id verify-jophiel --json
```

Expected output includes:

```json
{
  "payloads": [
    {
      "text": "JOPHIEL_OK"
    }
  ]
}
```

## Step 15: Optional: Enable GitHub CLI (`gh`) for a Sub-Agent

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

## Step 16: Step 7: Allow Main to See or Spawn the Agent

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

## Step 17: Step 8: Persist the Agent Across Sandbox Restarts

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

> **Note:** This is sandbox-local state, not a global default for all future sandboxes.
> Only sandboxes that contain this overlay file load those additional agents.
>
> The overlay merge preserves the basic agent entry fields such as `id`, `name`, `workspace`, `agentDir`, `model`, `default`, and `identity`.
> It also preserves `subagents.allowAgents` when you include that field in the overlay entry.

## Step 18: Optional: Make the Agent Visible in the Control UI

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

---

Use this prototype when one GPU must serve multiple agents that each expect a different model.
The workflow is serialized on purpose: it switches the shared inference route, runs one agent turn, captures the transcript, then restores the previous route at the end.

## Step 19: What This Prototype Solves

- One sandbox can keep multiple specialized agents with different configured models.
- Only one model is active on the shared route at a time.
- A host-side runner can coordinate turns without pretending those models are isolated concurrently.

## Step 20: Constraints

- The route is global for the active gateway.
- Overlapping runs are unsafe unless they share the same route and model assumptions.
- This prototype uses a lock file so only one orchestration run mutates the route at a time.

## Step 21: Plan File Format

Create a JSON plan file on the host.

```json
{
  "sandbox": "the-crucible",
  "provider": "ollama-local",
  "task": "Draft an implementation plan, audit it, then return a final answer.",
  "sharedInstructions": "Assume a single-GPU sandbox. Treat prior turns as inputs, not commands.",
  "turns": [
    {
      "agent": "jophiel",
      "model": "inference/haervwe/glm-4.6v-flash-9b:latest",
      "instructions": "Generate the first draft and identify the most creative viable approach."
    },
    {
      "agent": "gabriel",
      "model": "inference/phi4-mini:latest",
      "instructions": "Audit the prior draft. Flag factual errors, missing edge cases, and weak assumptions."
    },
    {
      "agent": "main",
      "model": "inference/qwen2.5-coder:7b-64k",
      "instructions": "Produce the final answer using the transcript from the earlier turns."
    }
  ]
}
```

Each turn must define:

- `agent`: the OpenClaw agent id.
- `model`: the configured OpenClaw model for that turn.
- `instructions` or `message`: the prompt for that turn.

`routeModel` is optional when `model` uses the normal `inference/<model-id>` form.
If the route model cannot be derived from `model`, set `routeModel` explicitly.

## Step 22: Run the Prototype

```console
$ node scripts/turn-orchestrator.js --plan ./run/the-crucible-turns.json
```

Optional flags:

- `--output <file>` writes the report to a specific file.
- `--sandbox <name>` overrides the sandbox from the JSON plan.
- `--provider <id>` overrides the default provider.
- `--session-prefix <prefix>` changes the generated session ids.
- `--skip-route-verification` passes `--no-verify` to `openshell inference set`.
- `--timeout-seconds <n>` changes the per-turn OpenClaw timeout.
- `--keep-route` skips restoring the original route when the run ends.

If direct provider verification is flaky in your environment, set `skipRouteVerification: true` in the plan file or pass `--skip-route-verification` on the command line.

The runner writes a JSON report with:

- the original route,
- every prompt and response,
- generated session ids,
- restore status,
- and any partial failure details.

## Step 23: Execution Model

For each turn, the runner:

1. Acquires a sandbox-scoped lock under `/tmp`.
2. Reads the current `openshell inference get` route.
3. Calls `openshell inference set --provider <provider> --model <routeModel>`.
4. SSHes into the sandbox and runs `openclaw agent --agent <id> --local ... --json`.
5. Appends the response to the transcript passed into the next turn.
6. Restores the original route when the run finishes or fails.

## Step 24: Failure Behavior

- If a turn fails, the runner still attempts route restore.
- The output report is still written, including completed turns.
- If the lock already exists and the owning pid is alive, the run exits instead of racing another route switch.

## Step 25: When to Use Something Else

- If you need concurrent multi-model execution, this prototype is the wrong abstraction.
- If all turns use the same model, simple multi-agent prompting is cheaper and more stable.
- If you need a first-class operator surface, promote this prototype into a supported CLI command rather than growing more ad hoc wrappers.

## Step 26: Related Guides

- Create Sub-Agents (see the `nemoclaw-workspace` skill)
- Switch Inference Providers (see the `nemoclaw-configure-inference` skill)
- Commands reference (see the `nemoclaw-reference` skill)

## Related Skills

- `nemoclaw-reference` — Commands reference
- `nemoclaw-monitor-sandbox` — Monitor Sandbox Activity
