---
title:
  page: "Serialized Turn-Taking"
  nav: "Serialized Turn-Taking"
description: "Prototype workflow for running multiple OpenClaw agents one at a time while switching the shared inference route between their models."
keywords: ["nemoclaw turn taking", "single gpu multi agent", "model switching orchestration", "openclaw serialized turns"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "nemoclaw", "workspace", "inference"]
content:
  type: how_to
  difficulty: technical_advanced
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Serialized Turn-Taking

Use this prototype when one GPU must serve multiple agents that each expect a different model.
The workflow is serialized on purpose: it switches the shared inference route, runs one agent turn, captures the transcript, then restores the previous route at the end.

## What This Prototype Solves

- One sandbox can keep multiple specialized agents with different configured models.
- Only one model is active on the shared route at a time.
- A host-side runner can coordinate turns without pretending those models are isolated concurrently.

## Constraints

- The route is global for the active gateway.
- Overlapping runs are unsafe unless they share the same route and model assumptions.
- This prototype uses a lock file so only one orchestration run mutates the route at a time.

## Plan File Format

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

## Run the Prototype

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

## Execution Model

For each turn, the runner:

1. Acquires a sandbox-scoped lock under `/tmp`.
2. Reads the current `openshell inference get` route.
3. Calls `openshell inference set --provider <provider> --model <routeModel>`.
4. SSHes into the sandbox and runs `openclaw agent --agent <id> --local ... --json`.
5. Appends the response to the transcript passed into the next turn.
6. Restores the original route when the run finishes or fails.

## Failure Behavior

- If a turn fails, the runner still attempts route restore.
- The output report is still written, including completed turns.
- If the lock already exists and the owning pid is alive, the run exits instead of racing another route switch.

## When to Use Something Else

- If you need concurrent multi-model execution, this prototype is the wrong abstraction.
- If all turns use the same model, simple multi-agent prompting is cheaper and more stable.
- If you need a first-class operator surface, promote this prototype into a supported CLI command rather than growing more ad hoc wrappers.

## Related Guides

- [Create Sub-Agents](create-sub-agents.md)
- [Switch Inference Providers](../inference/switch-inference-providers.md)
- [Commands reference](../reference/commands.md)
