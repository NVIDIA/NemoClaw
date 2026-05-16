---
name: "nemoclaw-user-monitor-sandbox"
description: "Inspects sandbox health, traces agent behavior, and diagnoses problems. Use when monitoring a running sandbox, debugging agent issues, or checking sandbox logs. Trigger keywords - monitor nemoclaw sandbox, debug nemoclaw agent issues."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Monitor NemoClaw Sandbox Activity and Debug Issues

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.

Use the NemoClaw status, logs, and TUI tools together to inspect sandbox health, trace agent behavior, and diagnose problems.

## Step 1: Check Sandbox Health

Run the status command to view the sandbox state, gateway health, and active inference configuration:

```console
$ nemoclaw <name> status
```

For local Ollama and local vLLM routes, `nemoclaw <name> status` also probes the host-side health endpoint directly.
This catches a stopped local backend before you retry `inference.local` from inside the sandbox.

Key fields in the output include the following:

- Sandbox details, which show the configured model, provider, GPU mode, and applied policy presets.
- Gateway and process health, which show whether NemoClaw can still reach the OpenShell gateway and whether the in-sandbox agent process is running.
- Inference health for local Ollama and local vLLM, which shows `healthy` or `unreachable` together with the probed local URL.
- NIM status, which shows whether a NIM container is running and healthy when that path is in use.

Run `nemoclaw <name> status` on the host to check sandbox state.
Use `openshell sandbox list` for the underlying sandbox details.

## Step 2: View Blueprint and Sandbox Logs

Stream the most recent log output from the blueprint runner and sandbox:

```console
$ nemoclaw <name> logs
```

To follow the log output in real time:

```console
$ nemoclaw <name> logs --follow
```

## Step 3: Monitor Network Activity in the TUI

Open the OpenShell terminal UI for a live view of sandbox network activity and egress requests:

```console
$ openshell term
```

For a remote sandbox, SSH to the instance and run `openshell term` there.

The TUI shows the following information:

- Active network connections from the sandbox.
- Blocked egress requests awaiting operator approval.
- Inference routing status.

Refer to Approve or Deny Agent Network Requests (use the `nemoclaw-user-manage-policy` skill) for details on handling blocked requests.

## Step 4: Test Inference

Run a test inference request to verify that the provider is responding:

```console
$ nemoclaw my-assistant connect
$ openclaw agent --agent main --local -m "Test inference" --session-id debug
```

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
