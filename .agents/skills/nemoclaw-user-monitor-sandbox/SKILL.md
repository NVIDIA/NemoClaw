---
name: "nemoclaw-user-monitor-sandbox"
description: "Inspects sandbox health, traces agent behavior, and diagnoses problems. Use when monitoring a running sandbox, debugging agent issues, or checking sandbox logs. Trigger keywords - monitor nemoclaw sandbox, debug nemoclaw agent issues."
license: "Apache-2.0"
---

# Monitor Sandbox Activity and Debug Issues

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.

import { AgentOnly } from "../_components/AgentGuide";

Use the NemoClaw status, logs, and TUI tools together to inspect sandbox health, trace agent behavior, and diagnose problems.

## Check Sandbox Health

Run the status command to view the sandbox state, gateway health, and active inference configuration:

```bash
nemoclaw <name> status
```

For local Ollama and local vLLM routes, `nemoclaw <name> status` also probes the host-side health endpoint directly.
This check catches a stopped local backend before you retry `inference.local` from inside the sandbox.

Key output fields include:

- Sandbox details show the configured model, provider, GPU mode, and applied policy presets.
- Gateway and process health show whether NemoClaw can still reach the OpenShell gateway and whether the in-sandbox agent process is running.
- Inference health for local Ollama and local vLLM shows `healthy` or `unreachable` together with the probed local URL.
- NIM status shows whether a NIM container is running and healthy when that path is in use.

Run `nemoclaw <name> status` on the host to check sandbox state.
Use `openshell sandbox list` for the underlying sandbox details.

## View Blueprint and Sandbox Logs

Stream the most recent log output from the blueprint runner and sandbox:

```bash
nemoclaw <name> logs
```

To follow the log output in real time:

```bash
nemoclaw <name> logs --follow
```

The `logs` command shows lifecycle and gateway output.
It does not export the structured per-session agent state that OpenClaw stores under `.openclaw/agents/`.

## Inspect Agent Session State

OpenClaw stores structured session state inside the sandbox.
Use these files when you need an audit trail, a compliance review surface, or replay tooling that includes assistant messages and tool activity.

| File | Purpose |
|---|---|
| `/sandbox/.openclaw/agents/main/sessions/<session-id>.jsonl` | Per-session event log. Use this file for audit trails and compliance dashboards. Records can include assistant messages, `thinking` blocks, tool calls, tool results, token usage, and cost metadata. |
| `/sandbox/.openclaw/agents/main/sessions/<session-id>.trajectory.jsonl` | Lower-level trajectory data for fine-grained replay. This file can be large, so avoid using it for routine audit summaries. |
| `/sandbox/.openclaw/agents/main/sessions/sessions.json` | Session index that maps known session keys to their persisted state. |

To inspect the session directory from the host, run a sandbox command:

```bash
nemoclaw sandbox exec <name> -- ls -lh /sandbox/.openclaw/agents/main/sessions
```

To copy a session log for offline review, use the OpenShell sandbox download command:

```bash
openshell sandbox download <name> /sandbox/.openclaw/agents/main/sessions/<session-id>.jsonl .
```

Treat exported session logs as sensitive data.
They can contain prompts, tool inputs, tool outputs, file paths, and cost metadata from the agent run.

## Monitor Network Activity in the TUI

Open the OpenShell terminal UI for a live view of sandbox network activity and egress requests:

```bash
openshell term
```

For a remote sandbox, SSH to the instance and run `openshell term` there.

The TUI shows the following information:

- Active network connections from the sandbox.
- Blocked egress requests awaiting operator approval.
- Inference routing status.

Refer to Approve or Deny Agent Network Requests (use the `nemoclaw-user-manage-policy` skill) for details on handling blocked requests.

## Test Inference

Run a test inference request to verify that the provider is responding:

<AgentOnly variant="openclaw">
```bash
nemoclaw my-assistant connect
openclaw agent --agent main -m "Test inference" --session-id debug
```
</AgentOnly>
<AgentOnly variant="hermes">
```bash
nemoclaw my-hermes connect
hermes
```
</AgentOnly>

If the request fails, check the following:

1. Run `nemoclaw <name> status` to confirm the active provider and endpoint.
   For local Ollama and local vLLM, check the `Inference` line first.
   If it shows `unreachable`, restart the local backend before retrying from inside the sandbox.
2. Run `nemoclaw <name> logs --follow` to view error messages from the blueprint runner.
3. Verify that the inference endpoint is reachable from the host.

## Related Skills

- `nemoclaw-user-reference` — Troubleshooting (use the `nemoclaw-user-reference` skill) for common issues and resolution steps
- `nemoclaw-user-manage-policy` — Approve or Deny Agent Network Requests (use the `nemoclaw-user-manage-policy` skill) for the operator approval flow
- `nemoclaw-user-configure-inference` — Switch Inference Providers (use the `nemoclaw-user-configure-inference` skill) to change the active provider
