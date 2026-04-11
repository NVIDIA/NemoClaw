---
name: "nemoclaw-user-workspace"
description: "Backs up and restores OpenClaw workspace files before destructive operations. Use when backing up a sandbox, restoring workspace state, or preparing for a destructive operation. Hows to create additional OpenClaw agents inside a NemoClaw sandbox and persist them across sandbox restarts. Prototypes workflow for running multiple OpenClaw agents one at a time while switching the shared inference route between their models. Hows to set up and use the LLM Wiki pattern for persistent, compounding agent memory. Explains what workspace files are, where they live, and how they persist across sandbox restarts. Use when asking about soul.md, identity.md, memory.md, agents.md, or sandbox file persistence."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw User Workspace

Backs up and restores OpenClaw workspace files before destructive operations. Use when backing up a sandbox, restoring workspace state, or preparing for a destructive operation.

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
| `WIKI.md` | Schema and conventions for the wiki memory (see the `nemoclaw-user-workspace` skill) knowledge base. | — |
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
├── WIKI.md
└── memory/
```

> **Note:** The workspace directory is hidden (`.openclaw`).
> The files are not at `/sandbox/SOUL.md`. Use the full path when downloading or uploading.

## Persistence Behavior

Understanding when these files persist and when they are lost is critical.

| Event | Workspace files |
|---|---|
| Sandbox restart | **Preserved:** the sandbox PVC retains its data. |
| `nemoclaw <name> destroy` | **Lost:** the sandbox and its PVC are deleted. |

> **Warning:** Always back up your workspace files before running `nemoclaw <name> destroy`.
> See Back Up and Restore (see the `nemoclaw-user-workspace` skill) for instructions.

## Editing Workspace Files

The agent reads these files at the start of every session.
You can edit them in two ways:

1. **Let the agent do it:** Ask your agent to update its persona, memory, or user context during a session.
2. **Edit manually:** Use `openshell sandbox connect` to open a terminal inside the sandbox and edit files directly, or use `openshell sandbox upload` to push edited files from your host.

*Full details in `references/workspace-files.md`.*

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
NemoClaw's backup helper also includes agent-specific `workspace-*`, `wiki-*`,
and `wiki-raw-*` directories automatically when they exist.

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
When using the NemoClaw backup helper, agent-specific workspaces and wiki
directories are restored alongside the main workspace files.

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

## Step 14: Step 5a: Add a Per-Agent Wiki Memory Layer

If you want the sub-agent to maintain its own long-term memory wiki, initialise
an agent-local wiki instead of sharing the main agent's wiki.

Run the wiki init script with the shared data root, the sub-agent workspace,
and the agent id:

```console
$ bash /path/to/scripts/wiki-init.sh \
  /sandbox/.openclaw-data \
  /sandbox/.openclaw-data/workspace-jophiel \
  jophiel
```

This creates:

- `/sandbox/.openclaw-data/wiki-jophiel/`
- `/sandbox/.openclaw-data/wiki-raw-jophiel/`
- `/sandbox/.openclaw-data/workspace-jophiel/WIKI.md`

It also patches the sub-agent's `SOUL.md`, `AGENTS.md`, and `MEMORY.md` so the
agent uses its own wiki as a deep memory layer.

Use this pattern for each sub-agent, substituting its agent id and workspace
path.

## Step 15: Step 6: Verify the Agent Runs

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

## Step 16: Optional: Enable GitHub CLI (`gh`) for a Sub-Agent

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

## Step 17: Step 7: Allow Main to See or Spawn the Agent

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

## Step 18: Step 8: Persist the Agent Across Sandbox Restarts

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

## Step 19: Backup Note

If you add per-agent wiki memory, the backup script now includes these
directories automatically:

- `workspace-<agent-id>/`
- `wiki-<agent-id>/`
- `wiki-raw-<agent-id>/`

That keeps each sub-agent's persona files and wiki memory together during
backup and restore.

The startup script merges `/sandbox/.nemoclaw/agents-overlay.json` into the runtime config when the sandbox starts.

> **Note:** This is sandbox-local state, not a global default for all future sandboxes.
> Only sandboxes that contain this overlay file load those additional agents.
>
> The overlay merge preserves the basic agent entry fields such as `id`, `name`, `workspace`, `agentDir`, `model`, `default`, and `identity`.
> It also preserves `subagents.allowAgents` when you include that field in the overlay entry.

## Step 20: Optional: Make the Agent Visible in the Control UI

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

## Step 21: What This Prototype Solves

- One sandbox can keep multiple specialized agents with different configured models.
- Only one model is active on the shared route at a time.
- A host-side runner can coordinate turns without pretending those models are isolated concurrently.

## Step 22: Constraints

- The route is global for the active gateway.
- Overlapping runs are unsafe unless they share the same route and model assumptions.
- This prototype uses a lock file so only one orchestration run mutates the route at a time.

## Step 23: Plan File Format

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

## Step 24: Run the Prototype

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

## Step 25: Execution Model

For each turn, the runner:

1. Acquires a sandbox-scoped lock under `/tmp`.
2. Reads the current `openshell inference get` route.
3. Calls `openshell inference set --provider <provider> --model <routeModel>`.
4. SSHes into the sandbox and runs `openclaw agent --agent <id> --local ... --json`.
5. Appends the response to the transcript passed into the next turn.
6. Restores the original route when the run finishes or fails.

## Step 26: Failure Behavior

- If a turn fails, the runner still attempts route restore.
- The output report is still written, including completed turns.
- If the lock already exists and the owning pid is alive, the run exits instead of racing another route switch.

## Step 27: When to Use Something Else

- If you need concurrent multi-model execution, this prototype is the wrong abstraction.
- If all turns use the same model, simple multi-agent prompting is cheaper and more stable.
- If you need a first-class operator surface, promote this prototype into a supported CLI command rather than growing more ad hoc wrappers.

## Step 28: Related Guides

- Create Sub-Agents (see the `nemoclaw-user-workspace` skill)
- Switch Inference Providers (see the `nemoclaw-user-configure-inference` skill)
- Commands reference (see the `nemoclaw-user-reference` skill)

---

The default NemoClaw memory system (`MEMORY.md` + daily notes) re-derives
knowledge from scratch on every question. The wiki memory pattern replaces
that with a **persistent, compounding knowledge base** — a structured
directory of interlinked markdown pages that the agent maintains over time.

The agent incrementally builds and maintains the wiki. When a new source is
ingested, the agent reads it, writes a summary, updates entity and concept
pages, maintains cross-references, and keeps everything consistent. The
knowledge is compiled once and then kept current, not re-derived on every
query.

## Step 29: Architecture

Three layers, mapped to the sandbox filesystem:

| Layer | Path | Purpose |
|---|---|---|
| **Schema** | `/sandbox/.openclaw/workspace/WIKI.md` | Convention file injected at session start |
| **Wiki pages** | `/sandbox/.openclaw-data/wiki/` | Agent-written, user-readable knowledge base |
| **Raw sources** | `/sandbox/.openclaw-data/wiki-raw/` | Immutable source documents |

The wiki lives under `.openclaw-data/` — **not** in `workspace/` — because
workspace files are injected into the system prompt at session start (max
150K chars total). The wiki will grow far beyond that limit. Only the compact
schema file (`WIKI.md`) and executive summary (`MEMORY.md`) are bootstrapped.
The agent reads wiki pages on-demand using the `read` tool.

For sub-agents, the same pattern works with agent-specific directories:

| Layer | Main agent | Sub-agent `jophiel` example |
|---|---|---|
| Workspace | `/sandbox/.openclaw/workspace` | `/sandbox/.openclaw-data/workspace-jophiel` |
| Schema | `/sandbox/.openclaw/workspace/WIKI.md` | `/sandbox/.openclaw-data/workspace-jophiel/WIKI.md` |
| Wiki pages | `/sandbox/.openclaw-data/wiki/` | `/sandbox/.openclaw-data/wiki-jophiel/` |
| Raw sources | `/sandbox/.openclaw-data/wiki-raw/` | `/sandbox/.openclaw-data/wiki-raw-jophiel/` |

### Directory Structure

```text
/sandbox/.openclaw-data/wiki/
├── index.md          # Content catalog — every page with link and summary
├── log.md            # Chronological append-only activity log
├── overview.md       # High-level living synthesis
├── entities/         # People, agents, systems, projects
├── concepts/         # Themes, patterns, techniques
├── sources/          # One summary per ingested source
└── analyses/         # Filed query results and investigations

/sandbox/.openclaw-data/wiki-raw/
├── conversations/    # Saved transcripts and turn reports
├── documents/        # Uploaded articles, papers, notes
├── web/              # Fetched web content
├── observations/     # Sub-agent outputs and cross-agent learnings
└── artifacts/        # Code, configs, system state snapshots
```

### Relationship to Existing Memory

| File | Role after wiki setup |
|---|---|
| `MEMORY.md` | Compact executive summary (~3–5K chars) distilled from the wiki |
| `memory/` | Daily session notes — continue as raw material for wiki ingestion |
| `WIKI.md` | Schema file defining conventions, workflows, directory reference |
| `SOUL.md` | Add wiki-maintenance behaviors to the agent personality |
| `AGENTS.md` | Add wiki ownership rules (single-agent ownership) |

`MEMORY.md` is **not replaced** — it stays as the bootstrapped summary that
the agent reads at session start. The wiki is the deep knowledge layer that
the agent navigates on-demand.

## Step 30: Setup

### 1. Initialise the wiki

The `wiki-init.sh` script creates the directory tree and deploys seed files.
Run it inside the sandbox:

```bash
# Connect to your sandbox
nemoclaw my-assistant connect

# Run the init script (adjust path if needed)
bash /path/to/scripts/wiki-init.sh
```

Or deploy from the host:

```bash
openshell sandbox upload my-assistant scripts/wiki-init.sh /tmp/
openshell sandbox exec my-assistant bash /tmp/wiki-init.sh
```

The script is idempotent — re-running it will not overwrite existing files.

## Sub-agent setup

For a sub-agent, pass the shared data root, the agent workspace, and the agent id:

```bash
bash /path/to/scripts/wiki-init.sh \
  /sandbox/.openclaw-data \
  /sandbox/.openclaw-data/workspace-jophiel \
  jophiel
```

That creates:

- `/sandbox/.openclaw-data/wiki-jophiel/`
- `/sandbox/.openclaw-data/wiki-raw-jophiel/`
- `/sandbox/.openclaw-data/workspace-jophiel/WIKI.md`

It also patches that agent's `SOUL.md`, `AGENTS.md`, and `MEMORY.md` so the
agent treats the new wiki as its own long-term memory layer.

### 2. Deploy the schema file

The init script copies `WIKI.md` into the workspace automatically. You can
also deploy it manually:

```bash
openshell sandbox upload my-assistant run/_/wiki/WIKI.md \
  /sandbox/.openclaw/workspace/WIKI.md
```

### 3. Update workspace files

Add wiki-maintenance behaviors to your agent's `SOUL.md`:

- Consult the wiki index before answering complex questions.
- File substantive insights back into the wiki.
- Maintain cross-references when creating or updating pages.
- Lint the wiki when prompted or when gaps are noticed.

Add wiki ownership rules to `AGENTS.md`:

- The main agent owns the wiki exclusively. Sub-agents do not access it.
- Wiki paths: `/sandbox/.openclaw-data/wiki/` and `/sandbox/.openclaw-data/wiki-raw/`.

For sub-agents, use agent-local ownership instead of sharing the main agent's
wiki. Each sub-agent should have its own `wiki-<agent-id>/` and
`wiki-raw-<agent-id>/` pair.

Evolve `MEMORY.md` into a curated executive summary with one-line insights
and references to wiki page paths.

## Step 31: Operations

### Ingest

Drop a source into `wiki-raw/` and ask the agent to process it:

> "Ingest the document I just uploaded to wiki-raw/documents/research-paper.md"

The agent will:

1. Read the raw source.
2. Write a source summary to `wiki/sources/`.
3. Create or update entity and concept pages.
4. Update cross-references across all touched pages.
5. Update `wiki/index.md` and append to `wiki/log.md`.
6. Optionally update `wiki/overview.md` and `MEMORY.md`.

### Query

Ask questions against the wiki:

> "What do we know about the sandbox security model?"

The agent reads `wiki/index.md` first, then navigates to relevant pages.
If the answer is substantive, it files the result as an analysis page.

### Lint

Ask the agent to health-check the wiki:

> "Lint the wiki"

The agent scans for contradictions, orphan pages, missing cross-references,
stale claims, and knowledge gaps. Results are appended to `wiki/log.md`.

## Step 32: Page Format

Every wiki page uses YAML frontmatter:

```yaml
---
title: Page Title
category: entity | concept | source | analysis
created: 2026-04-10
updated: 2026-04-10
sources: [source-slug-1, source-slug-2]
tags: [tag1, tag2]
---
```

Slugs are lowercase and hyphenated: `my-topic-name.md`. Pages use relative
links: `[Display Text](docs/category/slug.md)`.

## Step 33: Search

At moderate scale (~100 sources, ~hundreds of pages), `index.md` plus
`grep` is sufficient:

```bash
# Full-text search
grep -rl "search term" /sandbox/.openclaw-data/wiki/

# List all pages
find /sandbox/.openclaw-data/wiki/ -name "*.md"

# Recent log entries
grep "^## \[" /sandbox/.openclaw-data/wiki/log.md | tail -5
```

If the wiki outgrows this approach (~200+ pages), consider adding a
dedicated search tool.

## Step 34: Backup

The backup script includes wiki directories automatically:

```bash
scripts/backup-workspace.sh backup my-assistant   # Backs up wiki + wiki-raw
scripts/backup-workspace.sh restore my-assistant   # Restores everything
```

Both `wiki/` and `wiki-raw/` are backed up alongside workspace files.
Agent-specific `workspace-*`, `wiki-*`, and `wiki-raw-*` directories are also
included automatically.

## Related Skills

- `nemoclaw-user-reference` — Commands reference
- `nemoclaw-user-monitor-sandbox` — Monitor Sandbox Activity
