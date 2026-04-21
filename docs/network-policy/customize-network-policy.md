---
title:
  page: "Customize the NemoClaw Sandbox Network Policy"
  nav: "Customize Network Policy"
description:
  main: "Add, remove, or modify allowed endpoints in the sandbox policy."
  agent: "Adds, removes, or modifies allowed endpoints in the sandbox policy. Use when customizing network policy, changing egress rules, or configuring sandbox endpoint access."
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

The sandbox policy is defined in a declarative YAML file in the NemoClaw repository and enforced at runtime by [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell).
NemoClaw supports both static policy changes that persist across restarts and dynamic updates applied to a running sandbox through the OpenShell CLI.

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

To remove a previously applied preset, use `nemoclaw <name> policy-remove`:

```console
$ nemoclaw my-assistant policy-remove
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
$ nemoclaw <name> status
```

## Dynamic Changes

Dynamic changes apply a policy update to a running sandbox without restarting it.

### Create a Policy File

Create a YAML file with the endpoints to add.
Follow the same format as the baseline policy in `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`.
Add a top-level `version` field (for example, `version: 1`).
OpenShell rejects policy YAML that omits this field.

### Apply the Policy

Use the OpenShell CLI to apply the policy update:

```console
$ openshell policy set --policy <policy-file> <sandbox-name>
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

## Policy Presets

NemoClaw ships preset policy files for common integrations in `nemoclaw-blueprint/policies/presets/`.
Apply a preset as-is or use it as a starting template for a custom policy.

During onboarding, the [policy tier](../reference/network-policies.md#policy-tiers) you select determines which presets are enabled by default.
You can add or remove individual presets in the interactive preset screen that follows tier selection.

Available presets:

| Preset | Endpoints |
|--------|-----------|
| `brave` | Brave Search API |
| `brew` | Homebrew (Linuxbrew) package manager |
| `discord` | Discord webhook API |
| `github` | GitHub and GitHub REST API |
| `huggingface` | Hugging Face Hub (download-only) and inference router |
| `jira` | Atlassian Jira API |
| `npm` | npm and Yarn registries |
| `outlook` | Microsoft 365 and Outlook |
| `pypi` | Python Package Index |
| `slack` | Slack API and webhooks |
| `telegram` | Telegram Bot API |

To apply a preset to a running sandbox:

```console
$ nemoclaw <name> policy-add
```

:::{note}
Preset selection is interactive.
Positional preset arguments are ignored.
:::

For example, to interactively add PyPI access to a running sandbox:

```console
$ nemoclaw my-assistant policy-add
```

To list which presets are applied to a sandbox:

```console
$ nemoclaw <name> policy-list
```

To include a preset in the baseline, merge its entries into `openclaw-sandbox.yaml` and re-run `nemoclaw onboard`.

:::{note}
The `openshell policy set --policy <file> <sandbox-name>` command operates on raw policy files and does not
accept the `preset:` metadata block used in preset YAML files. Use `nemoclaw <name> policy-add` for
presets.
:::
For scripted workflows, `policy-add` and `policy-remove` accept the preset name as a positional argument:

```console
$ nemoclaw my-assistant policy-add pypi --yes
$ nemoclaw my-assistant policy-remove pypi --yes
```

Set `NEMOCLAW_NON_INTERACTIVE=1` instead of `--yes` to drive the same flow from an environment variable.
See [Commands](../reference/commands.md#nemoclaw-name-policy-add) for the full flag reference.

`nemoclaw <name> rebuild` reapplies every policy preset to the recreated sandbox, so presets survive an agent-version upgrade without manual reapplication.

## Related Topics

- [Approve or Deny Agent Network Requests](approve-network-requests.md) for real-time operator approval.
- [Network Policies](../reference/network-policies.md) for the full baseline policy reference.
- OpenShell [Policy Schema](https://docs.nvidia.com/openshell/latest/reference/policy-schema.html) for the full YAML policy schema reference.
- OpenShell [Sandbox Policies](https://docs.nvidia.com/openshell/latest/sandboxes/policies.html) for applying, iterating, and debugging policies at the OpenShell layer.
