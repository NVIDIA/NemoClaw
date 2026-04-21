---
name: "nemoclaw-user-manage-policy"
description: "Reviews and approves blocked agent network requests in the TUI. Use when approving or denying sandbox egress requests, managing blocked network calls, or using the approval TUI. Trigger keywords - nemoclaw approve network requests, sandbox egress approval tui, customize nemoclaw network policy, sandbox egress policy configuration."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Approve or Deny NemoClaw Agent Network Requests

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.
- A running NemoClaw sandbox for dynamic changes, or the NemoClaw source repository for static changes.

Review and act on network requests that the agent makes to endpoints not listed in the sandbox policy.
OpenShell intercepts these requests and presents them in the TUI for operator approval.

## Step 1: Open the TUI

Start the OpenShell terminal UI to monitor sandbox activity:

```console
$ openshell term
```

For a remote sandbox, pass the instance name:

```console
$ ssh my-gpu-box 'cd ~/nemoclaw && . .env && openshell term'
```

The TUI displays the sandbox state, active inference provider, and a live feed of network activity.

## Step 2: Trigger a Blocked Request

When the agent attempts to reach an endpoint that is not in the baseline policy, OpenShell blocks the connection and displays the request in the TUI.
The blocked request includes the following details:

- **Host and port** of the destination.
- **Binary** that initiated the request.
- **HTTP method** and path, if available.

## Step 3: Approve or Deny the Request

The TUI presents an approval prompt for each blocked request.

- **Approve** the request to add the endpoint to the running policy for the current session.
- **Deny** the request to keep the endpoint blocked.

Approved endpoints remain in the running policy until the sandbox stops.
They are not persisted to the baseline policy file.

## Step 4: Run the Walkthrough

To observe the approval flow in a guided session, run the walkthrough script:

```console
$ ./scripts/walkthrough.sh
```

This script opens a split tmux session with the TUI on the left and the agent on the right.
The walkthrough requires tmux and the `NVIDIA_API_KEY` environment variable.

---

Add, remove, or modify the endpoints that the sandbox is allowed to reach.

The sandbox policy is defined in a declarative YAML file in the NemoClaw repository and enforced at runtime by [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell).
NemoClaw supports both static policy changes that persist across restarts and dynamic updates applied to a running sandbox through the OpenShell CLI.

## Step 5: Static Changes

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

## Step 6: Dynamic Changes

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

## Step 7: Policy Presets

NemoClaw ships preset policy files for common integrations in `nemoclaw-blueprint/policies/presets/`.
Apply a preset as-is or use it as a starting template for a custom policy.

During onboarding, the policy tier (use the `nemoclaw-user-reference` skill) you select determines which presets are enabled by default.
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

> **Note:** Preset selection is interactive.
> Positional preset arguments are ignored.

For example, to interactively add PyPI access to a running sandbox:

```console
$ nemoclaw my-assistant policy-add
```

To list which presets are applied to a sandbox:

```console
$ nemoclaw <name> policy-list
```

To include a preset in the baseline, merge its entries into `openclaw-sandbox.yaml` and re-run `nemoclaw onboard`.

> **Note:** The `openshell policy set --policy <file> <sandbox-name>` command operates on raw policy files and does not
> accept the `preset:` metadata block used in preset YAML files. Use `nemoclaw <name> policy-add` for
> presets.
For scripted workflows, `policy-add` and `policy-remove` accept the preset name as a positional argument:

```console
$ nemoclaw my-assistant policy-add pypi --yes
$ nemoclaw my-assistant policy-remove pypi --yes
```

Set `NEMOCLAW_NON_INTERACTIVE=1` instead of `--yes` to drive the same flow from an environment variable.
See Commands (use the `nemoclaw-user-reference` skill) for the full flag reference.

`nemoclaw <name> rebuild` reapplies every policy preset to the recreated sandbox, so presets survive an agent-version upgrade without manual reapplication.

## Related Skills

- `nemoclaw-user-reference` — Network Policies (use the `nemoclaw-user-reference` skill) for the full baseline policy reference
- `nemoclaw-user-monitor-sandbox` — Monitor Sandbox Activity (use the `nemoclaw-user-monitor-sandbox` skill) for general sandbox monitoring
- OpenShell [Policy Schema](https://docs.nvidia.com/openshell/latest/reference/policy-schema.html) for the full YAML policy schema reference.
- OpenShell [Sandbox Policies](https://docs.nvidia.com/openshell/latest/sandboxes/policies.html) for applying, iterating, and debugging policies at the OpenShell layer.
