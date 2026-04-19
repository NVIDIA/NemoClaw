---
title:
  page: "Monitor NemoClaw Sandbox Activity and Debug Issues"
  nav: "Monitor Sandbox Activity"
description:
  main: "Inspect sandbox health, trace agent behavior, and diagnose problems."
  agent: "Inspects sandbox health, traces agent behavior, and diagnoses problems. Use when monitoring a running sandbox, debugging agent issues, or checking sandbox logs."
keywords: ["monitor nemoclaw sandbox", "debug nemoclaw agent issues"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "monitoring", "troubleshooting", "nemoclaw"]
content:
  type: how_to
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Monitor Sandbox Activity and Debug Issues

Use the NemoClaw status, logs, and TUI tools together to inspect sandbox health, trace agent behavior, and diagnose problems.

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.

## Check Sandbox Health

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

## View Blueprint and Sandbox Logs

Stream the most recent log output from the blueprint runner and sandbox:

```console
$ nemoclaw <name> logs
```

To follow the log output in real time:

```console
$ nemoclaw <name> logs --follow
```

## Monitor Network Activity in the TUI

Open the OpenShell terminal UI for a live view of sandbox network activity and egress requests:

```console
$ openshell term
```

For a remote sandbox, SSH to the instance and run `openshell term` there.

The TUI shows the following information:

- Active network connections from the sandbox.
- Blocked egress requests awaiting operator approval.
- Inference routing status.

Refer to [Approve or Deny Agent Network Requests](../network-policy/approve-network-requests.md) for details on handling blocked requests.

## Test Inference

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

## Related Topics

- [Troubleshooting](../reference/troubleshooting.md) for common issues and resolution steps.
- [Commands](../reference/commands.md) for the full CLI reference.
- [Approve or Deny Agent Network Requests](../network-policy/approve-network-requests.md) for the operator approval flow.
- [Switch Inference Providers](../inference/switch-inference-providers.md) to change the active provider.
