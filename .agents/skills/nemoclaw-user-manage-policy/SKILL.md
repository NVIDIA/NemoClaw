---
name: "nemoclaw-user-manage-policy"
description: "Adds, removes, or modifies allowed endpoints in the sandbox policy. Use when customizing network policy, changing egress rules, or configuring sandbox endpoint access. Trigger keywords - customize nemoclaw network policy, sandbox egress policy configuration, nemoclaw approve network requests, sandbox egress approval tui."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Customize the NemoClaw Sandbox Network Policy

## Gotchas

- Custom preset hosts bypass NemoClaw's review process and can widen sandbox egress to arbitrary destinations.

## Prerequisites

- A running NemoClaw sandbox for dynamic changes, or the NemoClaw source repository for static changes.
- The OpenShell CLI on your `PATH`.

Add, remove, or modify the endpoints that the sandbox is allowed to reach.

The sandbox policy is defined in a declarative YAML file in the NemoClaw repository and enforced at runtime by [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell).
NemoClaw supports both static policy changes that persist across restarts and dynamic updates applied to a running sandbox through the OpenShell CLI.

> **Note:** If the sandbox needs to reach an HTTP service running on the host, expose the service on a host IP that the OpenShell gateway can reach.
> Apply a custom NemoClaw preset with `nemoclaw <sandbox> policy-add --from-file`.
> Do not rely on `host.docker.internal` as a general host-service path because it bypasses the OpenShell policy path and may not be reachable in every sandbox runtime.
> See Agent cannot reach a host-side HTTP service (use the `nemoclaw-user-reference` skill).

## Step 1: Static Changes

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

## Step 2: Dynamic Changes

Dynamic changes apply a policy update to a running sandbox without restarting it.

> [!WARNING]
> `openshell policy set` **replaces** the sandbox's live policy with the contents of the file you provide; it does not merge.
> A running sandbox's live policy is the baseline from `openclaw-sandbox.yaml` plus every preset that was layered on during onboarding.
> Applying a file that contains only the baseline (or only a single preset) silently drops every other preset that was in effect.

### Option 1: Drop a Preset File and Use `policy-add` (Recommended)

This is the non-destructive path and the only flow NemoClaw supports out of the box for merging new entries into a running policy.

1. Create a preset-format YAML file under `nemoclaw-blueprint/policies/presets/`, for example `nemoclaw-blueprint/policies/presets/influxdb.yaml`:

   ```yaml
   preset:
     name: influxdb
     description: "InfluxDB time-series database"
   network_policies:
     influxdb:
       name: influxdb
       endpoints:
         - host: influxdb.internal.example.com
           port: 8086
           protocol: rest
           enforcement: enforce
           rules:
             - allow: { method: GET, path: "/**" }
             - allow: { method: POST, path: "/api/v2/write" }
       binaries:
         - { path: /usr/bin/curl }
   ```

2. Apply it to the running sandbox:

   ```console
   $ nemoclaw my-assistant policy-add
   ```

   NemoClaw reads the live policy via `openshell policy get --full`, structurally merges your preset's `network_policies` into it, and writes the merged result back.
   Existing presets and the baseline remain in place.
   The preset file under `presets/` also persists across sandbox recreations.

### Option 2: Snapshot, Edit, and Set via OpenShell

Use this path only when you cannot add a file under the NemoClaw source tree.
You must start from the **live** policy, not from `openclaw-sandbox.yaml`, so the presets layered on at onboarding are preserved in the file you apply.

```console
$ openshell policy get --full my-assistant > live-policy.yaml
```

Edit `live-policy.yaml` to add your entries under `network_policies:`, keeping the existing `version` field intact, then apply:

```console
$ openshell policy set --policy live-policy.yaml my-assistant
```

### Scope of Dynamic Changes

Dynamic changes apply only to the current session.
When the sandbox stops, the running policy resets to the baseline composed from `openclaw-sandbox.yaml` plus the presets recorded for the sandbox.
To make a custom policy survive a sandbox recreation, ship the preset file in the repository (Option 1 above — the file under `presets/` persists) or edit `openclaw-sandbox.yaml` and re-run `nemoclaw onboard`.

### Approve Requests Interactively

For one-off access, you can approve blocked requests in the OpenShell TUI instead of editing the baseline policy:

```console
$ openshell term
```

This is useful when you want to test a destination before deciding whether it belongs in a permanent preset or custom policy file.

## Step 3: Policy Presets

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

> **Note:** Preset selection is interactive when you omit a preset name.
> Pass a preset name with `--yes` for scripted workflows.

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

## Step 4: Custom Preset Files

Apply a user-authored preset YAML to a running sandbox without editing the baseline or dropping to `openshell policy set`.

### Authoring

A custom preset follows the same shape as the built-in ones under `nemoclaw-blueprint/policies/presets/`:

```yaml
preset:
  name: my-internal-api
  description: "Internal service"
network_policies:
  my-internal-api:
    name: my-internal-api
    endpoints:
      - host: api.example.internal
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }
    binaries:
      - { path: /usr/local/bin/node }
```

The top-level `preset.name` must be a lowercase RFC 1123 label (letters, digits, hyphens) and must not collide with a built-in preset name such as `slack` or `pypi`.
Rename `preset.name` if NemoClaw refuses to apply the file because of a collision.

### Apply a Single File

```console
$ nemoclaw my-assistant policy-add --from-file ./presets/my-internal-api.yaml
```

Preview the endpoints without applying with `--dry-run`, and skip the confirmation prompt with `--yes` or by exporting `NEMOCLAW_NON_INTERACTIVE=1`.

### Apply Every File in a Directory

```console
$ nemoclaw my-assistant policy-add --from-dir ./presets/ --yes
```

Files are processed in lexicographic order.
Processing stops at the first failure; presets already applied are not rolled back.
Fix the failing file and re-run the command to continue.

> **Warning:** Custom preset hosts bypass NemoClaw's review process and can widen sandbox egress to arbitrary destinations.
> Review every host in a custom preset before applying it, especially when the file originates outside your team.

### Remove a Custom Preset

Custom presets applied with `--from-file` or `--from-dir` are recorded in the NemoClaw sandbox registry alongside their full YAML content, so they can be removed by name — the original file does not need to be kept on disk:

```console
$ nemoclaw my-assistant policy-remove my-internal-api --yes
```

`policy-remove` accepts both built-in and custom preset names. Run `nemoclaw <name> policy-list` to see every preset currently applied to the sandbox.

## References

- **Load [references/approve-network-requests.md](references/approve-network-requests.md)** when approving or denying sandbox egress requests, managing blocked network calls, or using the approval TUI. Reviews and approves blocked agent network requests in the TUI.

## Related Skills

- `nemoclaw-user-reference` — Network Policies (use the `nemoclaw-user-reference` skill) for the full baseline policy reference
- OpenShell [Policy Schema](https://docs.nvidia.com/openshell/latest/reference/policy-schema.html) for the full YAML policy schema reference.
- OpenShell [Sandbox Policies](https://docs.nvidia.com/openshell/latest/sandboxes/policies.html) for applying, iterating, and debugging policies at the OpenShell layer.
