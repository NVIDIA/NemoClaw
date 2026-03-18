---
title:
  page: "Customize the NemoClaw Sandbox Network Policy"
  nav: "Customize Network Policy"
description: "Add, remove, or modify allowed endpoints in the sandbox policy."
keywords: ["customize nemoclaw network policy", "sandbox egress policy configuration"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "network_policy", "security", "nemoclaw"]
content:
  type: how_to
  difficulty: intermediate
  audience: ["developer", "engineer", "security_engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Customize the Sandbox Network Policy

Add, remove, or modify the endpoints that the sandbox is allowed to reach.
NemoClaw supports both static policy changes that persist across restarts and dynamic updates to a running sandbox.

## Prerequisites

- A running NemoClaw sandbox for dynamic changes, or the NemoClaw source repository for static changes.
- The OpenShell CLI on your `PATH`.

> [!IMPORTANT]
> Make static policy edits on the host, not inside the sandbox.
> The sandbox image is intentionally minimal and may not include editors or package-management tools.
> Changes made only inside the sandbox are also ephemeral and are lost when the sandbox is recreated.

## Static Changes

Static changes modify the baseline policy file and take effect after the next sandbox creation.

### Edit the Policy File

Open `nemoclaw-blueprint/policies/openclaw-sandbox.yaml` and add or modify endpoint entries.

If you only need one of the built-in presets, use `nemoclaw <name> policy-add` instead of editing YAML by hand:

```console
$ nemoclaw my-assistant policy-add
```

Use a manual YAML edit when you need to allow custom hosts that are not covered by a preset, such as an internal API or a weather service.

Each entry in the `network` section defines an endpoint group with the following fields:

`endpoints`
: Host and port pairs that the sandbox can reach.

`binaries`
: Executables allowed to use this endpoint.

`rules`
: HTTP methods and paths that are permitted.

### Re-Run Onboard

Apply the updated policy by re-running the onboard wizard:

```console
$ nemoclaw onboard
```

The wizard picks up the modified policy file and applies it to the sandbox.

### Verify the Policy

Check that the sandbox is running with the updated policy:

```console
$ openclaw nemoclaw status
```

## Dynamic Changes

Dynamic changes apply a policy update to a running sandbox without restarting it.

### Create a Policy File

Create a YAML file with the endpoints to add.
Follow the same format as the baseline policy in `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`.

### Apply the Policy

Use the OpenShell CLI to apply the policy update:

```console
$ openshell policy set <policy-file>
```

The change takes effect immediately.

### Scope of Dynamic Changes

Dynamic changes apply only to the current session.
When the sandbox stops, the running policy resets to the baseline defined in the policy file.
To make changes permanent, update the static policy file and re-run setup.

### Approve Requests Interactively

For one-off access, you can approve blocked requests in the OpenShell TUI instead of editing the baseline policy:

```console
$ openshell term
```

This is useful when you want to test a destination before deciding whether it belongs in a permanent preset or custom policy file.

## Related Topics

- [Approve or Deny Agent Network Requests](approve-network-requests.md) for real-time operator approval.
- [Network Policies](../reference/network-policies.md) for the full baseline policy reference.
