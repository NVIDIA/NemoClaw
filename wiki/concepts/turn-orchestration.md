---
title: Turn Orchestration
category: concept
created: 2026-04-11
updated: 2026-04-11
sources: [docs-reference-architecture]
tags: [multi-agent, turn-taking, gpu, orchestration]
---

# Turn Orchestration

Serialized turn-taking pattern for running multiple agents with different models
on a single GPU by switching the [inference route](inference-routing.md)
between turns.

## Use Case

Single GPU must serve multiple specialized [sub-agents](sub-agents.md); models
are unknown to [OpenClaw](../entities/openclaw.md) until runtime.

## Workflow

1. Create a JSON plan file with turns, models, and instructions
2. Run: `node scripts/turn-orchestrator.js --plan ./run/plan.json`
3. For each turn:
   - Acquire sandbox-scoped lock
   - Switch route: `openshell inference set --provider <x> --model <y>`
   - Run agent: `openclaw agent --agent <id> --local ...`
   - Append transcript to next turn
   - Restore original route

## Plan File Format

```json
{
  "sandbox": "the-crucible",
  "provider": "ollama-local",
  "task": "Draft, audit, finalize",
  "sharedInstructions": "Assume single GPU.",
  "turns": [
    {
      "agent": "jophiel",
      "model": "glm-4.6v-flash-9b:latest",
      "instructions": "Generate first draft..."
    },
    {
      "agent": "gabriel",
      "model": "phi4-mini:latest",
      "instructions": "Audit the draft..."
    }
  ]
}
```

## CLI Options

| Flag | Purpose |
|---|---|
| `--output <file>` | Write JSON report |
| `--sandbox <name>` | Override sandbox |
| `--provider <id>` | Override provider |
| `--session-prefix <prefix>` | Generated session IDs |
| `--timeout-seconds <n>` | Per-turn timeout |
| `--keep-route` | Don't restore original route at end |

## See Also

- [Inference Routing](inference-routing.md) — Provider switching mechanism
- [Sub-Agents](sub-agents.md) — Multi-agent sandbox setup
