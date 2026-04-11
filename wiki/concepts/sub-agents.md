---
title: Sub-Agents
category: concept
created: 2026-04-11
updated: 2026-04-11
sources: [docs-workspace]
tags: [multi-agent, agents, sub-agent]
---

# Sub-Agents

Create specialized agents with separate personas, workspaces, and models
inside a single [sandbox](../entities/sandbox.md).

## What Each Sub-Agent Gets

- Separate workspace directory (e.g., `/sandbox/.openclaw-data/workspace-jophiel`)
- Separate `agentDir` for auth profiles and state
- Model selection capability
- Optional [wiki memory](wiki-memory.md) layer

## Creation Steps

1. Connect: `nemoclaw <name> connect`
2. Set config path: `export OPENCLAW_CONFIG_PATH=/tmp/nemoclaw/openclaw.json`
3. Create agent:

   ```bash
   openclaw agents add jophiel \
     --workspace /sandbox/.openclaw-data/workspace-jophiel \
     --model <model>
   ```

4. Materialize state: `mkdir -p /sandbox/.openclaw/agents/jophiel/agent`
5. Add persona files to the workspace
6. (Optional) Bootstrap wiki: `bash scripts/wiki-init.sh <data-root> <workspace> jophiel`
7. Verify: `openclaw agent --agent jophiel --local -m "test"`
8. (Optional) Enable GitHub CLI: set `GH_TOKEN`, run `gh auth login`

## Wiki Per Agent

| Layer | Main agent | Sub-agent `jophiel` |
|---|---|---|
| Workspace | `/sandbox/.openclaw/workspace` | `/sandbox/.openclaw-data/workspace-jophiel` |
| Wiki | `/sandbox/.openclaw-data/wiki/` | `/sandbox/.openclaw-data/wiki-jophiel/` |
| Raw sources | `/sandbox/.openclaw-data/wiki-raw/` | `/sandbox/.openclaw-data/wiki-raw-jophiel/` |

Main agent can share; sub-agents maintain individual wikis.

## See Also

- [Workspace Files](workspace-files.md) — Agent personality and memory
- [Wiki Memory](wiki-memory.md) — Persistent knowledge base per agent
- [Turn Orchestration](turn-orchestration.md) — Multi-model GPU sharing between agents
