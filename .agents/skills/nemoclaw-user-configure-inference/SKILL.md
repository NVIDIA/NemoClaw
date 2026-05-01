---
name: "nemoclaw-user-configure-inference"
description: "Shows the NemoClaw-specific file paths and update flow for adding an auxiliary OpenClaw sub-agent model. Use when users ask how to add a second model, configure a sub-agent model, use Omni for vision tasks, configure agents.list, or use sessions_spawn in NemoClaw. Trigger keywords - nemoclaw additional model, nemoclaw sub-agent model, openclaw sub-agent, agents.list, sessions_spawn, vlm-demo, switch nemoclaw inference model, change inference runtime, nemoclaw local inference, ollama nemoclaw, vllm nemoclaw, local model server, openai compatible endpoint, nemoclaw inference options, nemoclaw onboarding providers, nemoclaw inference routing."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Set up a Task-Specific Sub-Agent

OpenClaw documents the sub-agent behavior, `sessions_spawn` tool, `agents.list` configuration, tool policy, nesting, and auth model in [Sub-Agents](https://docs.openclaw.ai/tools/subagents).
Use that page as the source of truth for how OpenClaw sub-agents work.

This NemoClaw page covers the sandbox-specific pieces: where the OpenClaw config lives, where to put per-agent credentials, which writable workspace path agents should use, and how the Omni VLM demo maps onto those paths.

## Step 1: NemoClaw Sandbox Paths

NemoClaw runs OpenClaw inside an OpenShell sandbox.
When adapting an OpenClaw sub-agent setup, use these paths inside the sandbox:

| Path | Purpose |
|---|---|
| `/sandbox/.openclaw/openclaw.json` | OpenClaw config, including `models.providers`, `agents.defaults`, and `agents.list`. |
| `/sandbox/.openclaw/.config-hash` | Hash for `openclaw.json`. Keep it in sync after manual config edits; it becomes a startup-enforced trust anchor only after `shields up` locks it root-owned and read-only. |
| `/sandbox/.openclaw/agents/<agent-id>/agent/auth-profiles.json` | Per-agent provider credentials. Use this when a sub-agent calls an auxiliary provider directly. |
| `/sandbox/.openclaw/workspace/` | Writable shared workspace path for files the primary agent passes to the sub-agent. |
| `/tmp/gateway.log` | OpenClaw gateway log. Use it to confirm config reloads and diagnose sub-agent failures. |

For file-based tasks, instruct agents to use `/sandbox/.openclaw/workspace/`.
Avoid relying on legacy `.openclaw-data` paths or read-only OpenClaw paths in delegation instructions.

## Step 2: Omni Vision Sub-Agent Example

The [`vlm-demo`](https://github.com/brevdev/nemoclaw-demos/tree/main/vlm-demo) applies the OpenClaw sub-agent pattern to a vision task.
It keeps the primary `main` agent on the normal NemoClaw inference route and adds a `vision-operator` sub-agent backed by an Omni vision model.

| OpenClaw field | Omni example value |
|---|---|
| Primary agent | `main` |
| Primary model | `inference/nvidia/nemotron-3-super-120b-a12b` |
| Auxiliary provider | `nvidia-omni` |
| Sub-agent | `vision-operator` |
| Sub-agent model | `nvidia-omni/private/nvidia/nemotron-3-nano-omni-reasoning-30b-a3b` |
| Delegation tool | `sessions_spawn` |

Omni is used as the specialist model for image tasks.
The primary orchestration model remains responsible for conversation, planning, and deciding when to delegate.

## Step 3: Update the Sandbox Config

Fetch the current OpenClaw config from the sandbox, patch it with your auxiliary provider and `agents.list` changes, then upload it back.

```console
$ export SANDBOX=my-assistant
$ export DOCKER_CTR=openshell-cluster-nemoclaw
$ docker exec "$DOCKER_CTR" kubectl exec -n openshell "$SANDBOX" -c agent -- cat /sandbox/.openclaw/openclaw.json > /tmp/openclaw.json
```

Create `/tmp/openclaw.updated.json` with the OpenClaw sub-agent config.
For the Omni example, the demo provides `vlm-demo/vlm-subagent/openclaw-patch.py`.

Upload the patched config and refresh the hash.
In the default mutable state, this keeps the local hash consistent but does not make it tamper-proof; run `nemoclaw <name> shields up` afterward if the sandbox should enforce config integrity at startup.

```console
$ docker exec "$DOCKER_CTR" kubectl exec -n openshell "$SANDBOX" -c agent -- chmod 644 /sandbox/.openclaw/openclaw.json
$ docker exec "$DOCKER_CTR" kubectl exec -n openshell "$SANDBOX" -c agent -- chmod 644 /sandbox/.openclaw/.config-hash
$ cat /tmp/openclaw.updated.json | docker exec -i "$DOCKER_CTR" kubectl exec -i -n openshell "$SANDBOX" -c agent -- sh -c 'cat > /sandbox/.openclaw/openclaw.json'
$ docker exec "$DOCKER_CTR" kubectl exec -n openshell "$SANDBOX" -c agent -- /bin/bash -c "cd /sandbox/.openclaw && sha256sum openclaw.json > .config-hash"
$ docker exec "$DOCKER_CTR" kubectl exec -n openshell "$SANDBOX" -c agent -- chmod 444 /sandbox/.openclaw/openclaw.json
$ docker exec "$DOCKER_CTR" kubectl exec -n openshell "$SANDBOX" -c agent -- chmod 444 /sandbox/.openclaw/.config-hash
```

Check `/tmp/gateway.log` after upload and confirm the gateway hot-reloaded the provider or `agents.list` change.

## Step 4: Add Sub-Agent Credentials

If the auxiliary model uses a provider key outside the normal NemoClaw inference route, put that key in the sub-agent auth profile.
For the Omni example:

```text
/sandbox/.openclaw/agents/vision-operator/agent/auth-profiles.json
```

Use the same provider ID that appears in `models.providers`, such as `nvidia-omni`.
After uploading the auth profile, make sure the sub-agent directory is owned by the sandbox user:

```console
$ docker exec "$DOCKER_CTR" kubectl exec -n openshell "$SANDBOX" -c agent -- chown -R sandbox:sandbox /sandbox/.openclaw/agents/vision-operator
```

## Step 5: Allow Auxiliary Provider Egress

If the sub-agent calls a provider directly, update the OpenShell network policy for the binary that makes the request.
In the Omni demo, the OpenClaw gateway runs as `/usr/local/bin/node`, so the NVIDIA endpoint policy must allow that binary.

Refer to Customize the Network Policy (use the `nemoclaw-user-manage-policy` skill) for policy update workflows.

## Step 6: Add Delegation Instructions

OpenClaw handles `sessions_spawn`, but the primary agent still needs task instructions.
Place those instructions in the writable workspace, for example:

```text
/sandbox/.openclaw/workspace/TOOLS.md
```

The Omni demo includes `vlm-demo/vlm-subagent/TOOLS.md`, which tells `main` to delegate image tasks to `vision-operator` and tells the sub-agent to read the image path it receives.
Adapt that file for other task-specific models.

## Step 7: Demo Assets

Use the [`vlm-demo`](https://github.com/brevdev/nemoclaw-demos/tree/main/vlm-demo) repository for runnable Omni example assets:

- `vlm-subagent-guide.md` for a command-by-command walkthrough.
- `vlm-subagent/openclaw-patch.py` for patching `openclaw.json`.
- `vlm-subagent/auth-profiles.template.json` for the sub-agent auth profile.
- `vlm-subagent/TOOLS.md` for delegation instructions.

## References

- **Load [references/switch-inference-providers.md](references/switch-inference-providers.md)** when switching inference providers, changing the model runtime, or reconfiguring inference routing. Changes the active inference model without restarting the sandbox.
- **Load [references/use-local-inference.md](references/use-local-inference.md)** when setting up Ollama, vLLM, TensorRT-LLM, NIM, or any OpenAI-compatible local model server with NemoClaw. Connects NemoClaw to a local inference server.
- **Load [references/inference-options.md](references/inference-options.md)** when explaining which providers are available, what the onboard wizard presents, or how inference routing works. Lists all inference providers offered during NemoClaw onboarding.

## Related Skills

- Refer to [OpenClaw Sub-Agents](https://docs.openclaw.ai/tools/subagents) for `sessions_spawn`, `agents.list`, nesting, tool policy, and auth behavior.
- `nemoclaw-user-workspace` — Refer to Workspace Files (use the `nemoclaw-user-workspace` skill) to understand per-agent workspace directories
