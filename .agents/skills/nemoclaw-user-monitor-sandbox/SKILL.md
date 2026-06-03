---
name: "nemoclaw-user-monitor-sandbox"
description: "Inspects sandbox health, traces agent behavior, and diagnoses problems. Use when monitoring a running sandbox, debugging agent issues, or checking sandbox logs. Trigger keywords - monitor nemoclaw sandbox, debug nemoclaw agent issues."
license: "Apache-2.0"
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Monitor Sandbox Activity and Debug Issues

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.

import { AgentOnly } from "../_components/AgentGuide";

Use the NemoClaw status, logs, and TUI tools together to inspect sandbox health, trace agent behavior, and diagnose problems.

## Check Sandbox Health

Run the status command to view the sandbox state, gateway health, and active inference configuration:

<AgentOnly variant="openclaw">
```bash
nemoclaw <name> status
```
</AgentOnly>
<AgentOnly variant="hermes">
```bash
nemohermes <name> status
```
</AgentOnly>

<AgentOnly variant="openclaw">
For local Ollama and local vLLM routes, `nemoclaw <name> status` also probes the host-side health endpoint directly.
</AgentOnly>
<AgentOnly variant="hermes">
For local Ollama and local vLLM routes, `nemohermes <name> status` also probes the host-side health endpoint directly.
</AgentOnly>
This check catches a stopped local backend before you retry `inference.local` from inside the sandbox.

Key output fields include:

- Sandbox details show the configured model, provider, GPU mode, and applied policy presets.
- Gateway and process health show whether NemoClaw can still reach the OpenShell gateway and whether the in-sandbox agent process is running.
- Inference health for local Ollama and local vLLM shows `healthy` or `unreachable` together with the probed local URL.
- NIM status shows whether a NIM container is running and healthy when that path is in use.

<AgentOnly variant="openclaw">
Run `nemoclaw <name> status` on the host to check sandbox state.
</AgentOnly>
<AgentOnly variant="hermes">
Run `nemohermes <name> status` on the host to check sandbox state.
</AgentOnly>
Use `openshell sandbox list` for the underlying sandbox details.

## View Blueprint and Sandbox Logs

Stream the most recent log output from the blueprint runner and sandbox:

<AgentOnly variant="openclaw">
```bash
nemoclaw <name> logs
```
</AgentOnly>
<AgentOnly variant="hermes">
```bash
nemohermes <name> logs
```
</AgentOnly>

To follow the log output in real time:

<AgentOnly variant="openclaw">
```bash
nemoclaw <name> logs --follow
```
</AgentOnly>
<AgentOnly variant="hermes">
```bash
nemohermes <name> logs --follow
```
</AgentOnly>

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
nemohermes my-hermes connect
hermes
```
</AgentOnly>

If the request fails, check the following:

<AgentOnly variant="openclaw">

1. Run `nemoclaw <name> status` to confirm the active provider and endpoint.
   For local Ollama and local vLLM, check the `Inference` line first.
   If it shows `unreachable`, restart the local backend before retrying from inside the sandbox.
2. Run `nemoclaw <name> logs --follow` to view error messages from the blueprint runner.
3. Verify that the inference endpoint is reachable from the host.

</AgentOnly>
<AgentOnly variant="hermes">

1. Run `nemohermes <name> status` to confirm the active provider and endpoint.
   For local Ollama and local vLLM, check the `Inference` line first.
   If it shows `unreachable`, restart the local backend before retrying from inside the sandbox.
2. Run `nemohermes <name> logs --follow` to view error messages from the blueprint runner.
3. Verify that the inference endpoint is reachable from the host.

</AgentOnly>

## Related Skills

- `nemoclaw-user-reference` — Troubleshooting (use the `nemoclaw-user-reference` skill) for common issues and resolution steps
- `nemoclaw-user-manage-policy` — Approve or Deny Agent Network Requests (use the `nemoclaw-user-manage-policy` skill) for the operator approval flow
- `nemoclaw-user-configure-inference` — Switch Inference Providers (use the `nemoclaw-user-configure-inference` skill) to change the active provider
