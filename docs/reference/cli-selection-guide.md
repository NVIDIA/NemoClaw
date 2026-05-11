---
title:
  page: "CLI Selection Guide"
  nav: "CLI Selection Guide"
description:
  main: "Choose between the NemoClaw CLI and the OpenShell CLI for common sandbox operations."
  agent: "Explains when to use `nemoclaw` versus `openshell` for NemoClaw-managed sandboxes, including lifecycle, inference, policy, monitoring, file transfer, and gateway operations."
keywords: ["nemoclaw vs openshell", "which cli", "nemoclaw cli", "openshell cli", "sandbox commands"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "nemoclaw", "cli", "sandboxing"]
content:
  type: reference
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# CLI Selection Guide

NemoClaw uses two host-side CLIs.
Use `nemoclaw` for NemoClaw-managed workflows.
Use `openshell` when you need a lower-level OpenShell operation that NemoClaw intentionally exposes.

## Rule of Thumb

If the task changes how NemoClaw creates, rebuilds, preserves, or configures a sandbox, start with `nemoclaw`.

If the task inspects or changes the live OpenShell gateway, TUI, raw policy, port forwarding, inference route, or sandbox file transfer, use `openshell`.

Do not create or recreate NemoClaw-managed sandboxes directly with `openshell sandbox create` unless you intend to manage OpenShell yourself.
Run `nemoclaw onboard` afterward if you need to return to a NemoClaw-managed environment.

## Use `nemoclaw` For NemoClaw Workflows

Use `nemoclaw` for operations where NemoClaw adds product-specific state, safety checks, backup behavior, credential handling, or OpenClaw configuration.

- Install, onboard, or recreate a NemoClaw sandbox:

  ```console
  $ nemoclaw onboard
  $ nemoclaw onboard --resume --recreate-sandbox
  ```

- List, connect to, check, or delete NemoClaw-managed sandboxes:

  ```console
  $ nemoclaw list
  $ nemoclaw my-assistant connect
  $ nemoclaw my-assistant status
  $ nemoclaw my-assistant logs --follow
  $ nemoclaw my-assistant destroy
  ```

- Rebuild or upgrade while preserving workspace state:

  ```console
  $ nemoclaw my-assistant rebuild
  $ nemoclaw upgrade-sandboxes --check
  ```

- Snapshot, restore, or mount sandbox state:

  ```console
  $ nemoclaw my-assistant snapshot create --name before-change
  $ nemoclaw my-assistant snapshot restore before-change
  $ nemoclaw my-assistant share mount
  ```

- Add or remove NemoClaw policy presets:

  ```console
  $ nemoclaw my-assistant policy-add pypi --yes
  $ nemoclaw my-assistant policy-list
  $ nemoclaw my-assistant policy-remove pypi --yes
  ```

- Manage NemoClaw messaging channels, credentials, diagnostics, and cleanup:

  ```console
  $ nemoclaw my-assistant channels add slack
  $ nemoclaw credentials list
  $ nemoclaw credentials reset nvidia-prod
  $ nemoclaw debug --sandbox my-assistant
  $ nemoclaw gc --dry-run
  ```

## Use `openshell` For OpenShell Operations

Use `openshell` when the docs explicitly call for a live OpenShell gateway operation or when you need a lower-level view beneath the NemoClaw wrapper.

- Open the OpenShell TUI for network approvals and live activity:

  ```console
  $ openshell term
  ```

- Inspect the live gateway inference route:

  ```console
  $ openshell inference get -g nemoclaw
  ```

- Manage dashboard or service port forwards:

  ```console
  $ openshell forward start --background <port> <sandbox-name>
  $ openshell forward list
  ```

- Inspect the underlying sandbox state:

  ```console
  $ openshell sandbox list
  $ openshell sandbox get <sandbox-name>
  $ openshell logs <sandbox-name> --tail
  ```

- Run one-off commands or move files without starting a NemoClaw chat session:

  ```console
  $ openshell sandbox exec -n <sandbox-name> -- ls -la /sandbox
  $ openshell sandbox upload <sandbox-name> ./local-file /sandbox/
  $ openshell sandbox download <sandbox-name> /sandbox/output ./output
  ```

- Inspect or replace raw OpenShell policy:

  ```console
  $ openshell policy get --full <sandbox-name> > live-policy.yaml
  $ openshell policy update <sandbox-name> --add-endpoint api.example.com:443:read-only:rest:enforce
  $ openshell policy set --policy live-policy.yaml <sandbox-name>
  ```

`openshell policy update` merges specific endpoint and rule changes into the live sandbox policy.
`openshell policy set` replaces the live policy with the file you provide.
For normal NemoClaw network access changes, prefer `nemoclaw <name> policy-add` so NemoClaw preserves presets and records the change for rebuilds.

## Common Decisions

This section covers common decisions when using the NemoClaw CLI and the OpenShell CLI.

### First Setup or Full Recreate

Use `nemoclaw onboard`.
It starts the OpenShell gateway when needed, registers providers, builds the OpenClaw sandbox image, applies NemoClaw policy choices, and creates the sandbox.

Avoid running `openshell gateway start --recreate` or `openshell sandbox create` directly for NemoClaw-managed sandboxes.
Those commands do not update NemoClaw's registry, session metadata, workspace-preservation flow, or OpenClaw-specific configuration.

### Connect to the Sandbox

Use `nemoclaw <name> connect` for an interactive NemoClaw sandbox shell.
It waits for readiness, handles stale SSH host keys after gateway restarts, and prints agent-specific hints.

Use `openshell sandbox connect <name>` only when you intentionally want the raw OpenShell connection path.

For a one-off command, use `openshell sandbox exec` instead of opening an interactive shell.

```console
$ openshell sandbox exec -n my-assistant -- cat /tmp/gateway.log
```

### Check Health or Logs

Use `nemoclaw <name> status` and `nemoclaw <name> logs` first.
They combine NemoClaw registry data, OpenShell state, OpenClaw process health, inference health, policy details, and messaging-channel warnings.

Use `openshell sandbox list`, `openshell sandbox get`, or `openshell logs` when debugging lower-level OpenShell behavior.

### Approve Blocked Network Requests

Use `openshell term`.
The OpenShell TUI owns live network activity and operator approval prompts.

Approved endpoints are session-scoped unless you also add them to the policy through a NemoClaw preset or raw OpenShell policy update.

### Change Models or Providers

Use the NemoClaw command for model or provider switches so the OpenShell route and the running OpenClaw config stay consistent:

```console
$ nemoclaw inference set --provider nvidia-prod --model nvidia/nemotron-3-super-120b-a12b
```

For a build-time OpenClaw setting change, rerun onboarding so the sandbox configuration is recreated consistently:

```console
$ nemoclaw onboard --resume --recreate-sandbox
```

Verify either path with:

```console
$ nemoclaw <name> status
```

### Update Network Policy

Use `nemoclaw <name> policy-add` or `policy-remove` for NemoClaw presets and custom preset files.
NemoClaw merges the new policy with the live policy and reapplies presets during rebuilds.

Use `openshell policy update` for precise live endpoint or REST rule changes.
Use `openshell policy get --full` and `openshell policy set` only when you need to edit and replace the raw policy file.

### Move Workspace Files

Use `nemoclaw <name> snapshot create`, `snapshot restore`, or `share mount` for normal workspace preservation and editing.

Use `openshell sandbox upload` and `openshell sandbox download` for manual file copies when you need exact control over source and destination paths.

## Related Topics

- [Commands](commands.md) for the full NemoClaw command reference.
- [Manage Sandbox Lifecycle](../manage-sandboxes/lifecycle.md) for day-two operations.
- [Switch Inference Models](../inference/switch-inference-providers.md) for inference route examples.
- [Customize the Network Policy](../network-policy/customize-network-policy.md) for persistent network access changes.
- [Approve or Deny Network Requests](../network-policy/approve-network-requests.md) for the OpenShell TUI approval flow.
