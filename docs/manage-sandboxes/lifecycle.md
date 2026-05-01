---
title:
  page: "Manage Sandbox Lifecycle"
  nav: "Manage Sandbox Lifecycle"
description:
  main: "Open the sandbox UI, manage dashboard ports, reconfigure providers, rebuild safely, upgrade sandboxes, and uninstall NemoClaw."
  agent: "Explains operational tasks after the quickstart: browser access, port forwards, multiple sandboxes, credential reset, rebuilds, network presets, upgrades, and uninstall."
keywords: ["manage nemoclaw sandboxes", "nemoclaw dashboard port", "nemoclaw rebuild", "nemoclaw upgrade sandboxes", "nemoclaw uninstall"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "operations", "nemoclaw"]
content:
  type: how_to
  difficulty: intermediate
  audience: ["developer", "engineer"]
skill:
  priority: 10
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Manage Sandbox Lifecycle

Use this guide after you finish the [OpenClaw quickstart](../get-started/quickstart.md).
It covers day-two sandbox operations such as managing ports, rebuilding safely, upgrading, and uninstalling.

## Restart the Port Forward

If the forward stopped, or the installer reported that no active forward was found and the URL does not load, restart it manually with the port from the install summary.

```console
$ openshell forward start --background <dashboard-port> my-gpt-claw
```

To list active forwards across all sandboxes, run the following command.

```console
$ openshell forward list
```

## Run Multiple Sandboxes

Each sandbox needs its own dashboard port, since `openshell forward` refuses to bind a port that another sandbox is already using.
When the default port is already held by another sandbox, `nemoclaw onboard` scans ports `18789` through `18799` and uses the next free port.

```console
$ nemoclaw onboard                                      # first sandbox uses 18789
$ nemoclaw onboard                                      # second sandbox uses the next free port, such as 18790
```

To choose a specific port, pass `--control-ui-port`:

```console
$ nemoclaw onboard --control-ui-port 19000
```

You can also set `CHAT_UI_URL` or `NEMOCLAW_DASHBOARD_PORT` before onboarding:

```console
$ CHAT_UI_URL=http://127.0.0.1:19000 nemoclaw onboard
$ NEMOCLAW_DASHBOARD_PORT=19000 nemoclaw onboard
```

For full details on port conflicts and overrides, refer to [Port already in use](../reference/troubleshooting.md#port-already-in-use).

## Chat with the Agent from the Terminal

Connect to the sandbox and use the OpenClaw terminal UI.

```bash
nemoclaw my-assistant connect
```

In the sandbox shell, open the OpenClaw terminal UI and start a chat.

```bash
openclaw tui
```

To send a single message and print the response instead, run:

```bash
openclaw agent --agent main --local -m "hello" --session-id test
```

## Reconfigure or Recover

Recover from a misconfigured sandbox without re-running the full onboard wizard or destroying workspace state.

### Change Inference Model or API

Change the active model or provider at runtime without rebuilding the sandbox:

```console
$ openshell inference set -g nemoclaw --model <model> --provider <provider>
```

Refer to [Switch Inference Providers](../inference/switch-inference-providers.md) for provider-specific model IDs and API compatibility notes.

### Reset a Stored Credential

If a provider credential was entered incorrectly during onboarding, clear the gateway-registered value and re-enter it on the next onboard run:

```console
$ nemoclaw credentials list                # see which providers are registered
$ nemoclaw credentials reset <PROVIDER>    # clear a single provider, for example nvidia-prod
$ nemoclaw onboard                         # re-run to re-enter the cleared provider
```

The credentials command is documented in full at [`nemoclaw credentials reset <PROVIDER>`](../reference/commands.md#nemoclaw-credentials-reset-provider).

### Rebuild a Sandbox While Preserving Workspace State

If you changed the underlying Dockerfile, upgraded OpenClaw, or want to pick up a new base image without losing your sandbox's workspace files, use `rebuild` instead of destroying and recreating:

```console
$ nemoclaw <sandbox-name> rebuild
```

Rebuild preserves the mounted workspace and registered policies while recreating the container.
Refer to [`nemoclaw <name> rebuild`](../reference/commands.md#nemoclaw-name-rebuild) for flag details.

### Add a Network Preset After Onboarding

Apply an additional preset, such as Telegram or GitHub, to a running sandbox without re-onboarding:

```console
$ nemoclaw <sandbox-name> policy-add
```

Refer to [`nemoclaw <name> policy-add`](../reference/commands.md#nemoclaw-name-policy-add) for usage details and flags.

## Update to the Latest Version

When a new NemoClaw release becomes available, update the `nemoclaw` CLI on your host and check existing sandboxes for stale agent/runtime versions.

### Update the NemoClaw CLI

Re-run the installer.
Before it onboards anything, the installer calls [`nemoclaw backup-all`](../reference/commands.md#nemoclaw-backup-all) automatically, storing a snapshot of each running sandbox in `~/.nemoclaw/rebuild-backups/` as a safety net.

```console
$ curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

### Upgrade Sandboxes with Stale Agent and Runtime Versions

The installer checks registered sandboxes after onboarding succeeds and runs `nemoclaw upgrade-sandboxes --auto` for stale running sandboxes.
Use `upgrade-sandboxes` directly to verify the result, rebuild when you skipped the installer or onboarding step, or handle sandboxes that were stopped or could not be version-checked.
The upgrade flow is non-destructive by default because NemoClaw preserves manifest-defined workspace state, but a manual snapshot before any major upgrade gives you a state restore point.

```console
$ nemoclaw <sandbox-name> snapshot create --name pre-upgrade   # optional, recommended
$ curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash          # updates CLI; auto-upgrades stale running sandboxes
$ nemoclaw upgrade-sandboxes --check                            # verify or list remaining stale/unknown sandboxes
$ nemoclaw upgrade-sandboxes                                    # manually rebuild remaining stale running sandboxes
```

For scripted manual rebuilds, use `nemoclaw upgrade-sandboxes --auto` to skip the confirmation prompt.

If the upgraded sandbox needs its workspace state reverted, restore the pre-upgrade snapshot into the running sandbox.
This restores saved state directories only; it does not downgrade the sandbox image or agent/runtime:

```console
$ nemoclaw <sandbox-name> snapshot restore pre-upgrade
```

### What Changes During a Rebuild

Each rebuild destroys the existing container and creates a new one.
NemoClaw protects your data through the same backup-and-restore flow as [`nemoclaw <name> rebuild`](../reference/commands.md#nemoclaw-name-rebuild):

- NemoClaw preserves manifest-defined workspace state. Before deleting the old container, NemoClaw snapshots the state directories defined in the agent manifest, typically `/sandbox/.openclaw/workspace/`, and restores them into the new container. Stored credentials (`~/.nemoclaw/credentials.json`) and registered policy presets live on the host and are re-applied to the new sandbox automatically.
- NemoClaw does not preserve runtime changes outside the workspace state directories. This includes packages installed inside the running container with `apt` or `pip`, files in non-workspace paths, and in-memory or process state. If you have customized the running container at runtime, capture that as `Dockerfile` changes for `nemoclaw onboard --from` or a manual `openshell sandbox download` before the rebuild starts.

Aborts before the destroy step are non-destructive.
The flow refuses to proceed past preflight if a credential is missing or past backup if the snapshot fails with `"Aborting rebuild to prevent data loss"`, so a failed run leaves the original sandbox intact and ready to retry.

See [Backup and Restore](backup-restore.md) for the full list of state-preservation guarantees, snapshot retention, and instructions for manual backups when the auto-flow is not enough.

:::{note} If the rebuild aborts with `Missing credential: <KEY>`
The rebuild preflight reads the provider credential recorded by your last `nemoclaw onboard` session.
If you have switched providers since onboarding, for example from a remote API to a local Ollama setup, the preflight may still reference the old key and fail before any destroy step runs.

To recover, re-run `nemoclaw onboard` and select your current provider.
This refreshes the session metadata.
Your existing container keeps serving traffic until the new image is ready.
:::

## Uninstall

To remove NemoClaw and all resources created during setup, run the CLI's built-in uninstall command:

```bash
nemoclaw uninstall
```

| Flag               | Effect                                               |
|--------------------|------------------------------------------------------|
| `--yes`            | Skip the confirmation prompt.                        |
| `--keep-openshell` | Leave the `openshell` binary installed.              |
| `--delete-models`  | Also remove NemoClaw-pulled Ollama models.           |

`nemoclaw uninstall` runs the version-pinned `uninstall.sh` that shipped with your installed CLI, so it does not fetch anything over the network at uninstall time.

If the `nemoclaw` CLI is missing or broken, fall back to the hosted script:

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh | bash
```

For a full comparison of the two forms, including what they fetch, what they trust, and when to prefer each, see [`nemoclaw uninstall` vs. the hosted `uninstall.sh`](../reference/commands.md#nemoclaw-uninstall-vs-the-hosted-uninstallsh).

## Related Topics

- [Set Up Messaging Channels](messaging-channels.md) to connect Telegram, Discord, or Slack.
- [Workspace Files](workspace-files.md) for persistent OpenClaw files inside the sandbox.
- [Backup and Restore](backup-restore.md) for snapshot and restore workflows.
- [Monitor Sandbox Activity](../monitoring/monitor-sandbox-activity.md) for observability tools.
