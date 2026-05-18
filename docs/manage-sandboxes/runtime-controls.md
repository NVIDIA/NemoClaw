---
title:
  page: "Runtime Controls and Sandbox Mutability"
  nav: "Runtime Controls"
description:
  main: "Consolidated reference for what you can change on a running NemoClaw sandbox, what requires rebuild or re-onboard, and the operator-only `shields up` / `shields down` / `shields status` commands."
  agent: "Single page that answers 'what can I change at runtime vs. what requires a rebuild' for NemoClaw sandboxes, and documents the operator-only shields lockdown commands (shields up, shields down with timeout/reason/policy, shields status). Use when an operator needs to temporarily lower or restore the sandbox security posture, or when a user is trying to figure out whether a config change needs a rebuild."
keywords: ["nemoclaw shields", "shields up", "shields down", "shields status", "sandbox mutability", "sandbox runtime configuration", "sandbox lockdown"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "operations", "security", "nemoclaw"]
content:
  type: how_to
  difficulty: intermediate
  audience: ["developer", "engineer", "security_engineer"]
skill:
  priority: 10
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Runtime Controls and Sandbox Mutability

This page is the single reference for two related operator questions about a running NemoClaw sandbox:

1. *Which parts of my sandbox can I change while it is running, and which require a rebuild or re-onboard?*
2. *How do I temporarily lower or restore the sandbox security posture for an operator session?*

The mutability table below answers question 1.
The shields commands answer question 2.

## What you can change at runtime

NemoClaw applies its security posture in three layers — what is baked into the sandbox image at onboard, what is hot-reloadable on the running sandbox, and what requires a rebuild or re-onboard.
The table below maps each commonly changed item to the layer that owns it and the command that changes it.

| Item | When the change takes effect | How to change it |
|---|---|---|
| Inference provider (cloud, NVIDIA Endpoints, local Ollama / vLLM, compatible-endpoint, …) | Rebuild required (`openclaw.json` is locked at sandbox creation) | `nemoclaw <name> rebuild` after picking a different provider via `nemoclaw inference set` |
| Inference model on the current provider | Rebuild required for OpenClaw; hot-reloadable for managed routers | `nemoclaw <name> rebuild` (OpenClaw) or `nemoclaw inference set` (router-based) |
| Sub-agent (Hermes / OpenClaw / …) | Re-onboard required (the sub-agent and its workspace are baked at onboard) | `nemoclaw onboard --recreate-sandbox` |
| Network policy preset (slack, discord, telegram, brave, …) | Runtime — applies on the next request; rebuild only required if the preset adds bind-mounted secrets | `nemoclaw <name> policy-add <preset>` / `policy-remove <preset>` |
| Network allow-list (custom hosts) | Runtime — picks up at next request | `openshell policy set` or interactive approval prompt at the gateway |
| Channel tokens (Slack / Discord / Telegram bot credentials) | Rebuild required (tokens are baked into the sandbox image at onboard so they never leave the host clear-text) | `nemoclaw <name> channels add <channel>` then accept the rebuild prompt |
| Channel enable/disable (turn a configured channel off without removing the token) | Rebuild required (`openclaw.json` is the source of truth at runtime, see #3453) | `nemoclaw <name> channels stop <channel>` then rebuild |
| Dashboard forward port | Runtime — port is re-resolved on next `connect` | `NEMOCLAW_DASHBOARD_PORT=<port> nemoclaw <name> connect` |
| Dashboard bind address (loopback vs all interfaces) | Runtime — applies on next `connect` | `NEMOCLAW_DASHBOARD_BIND=0.0.0.0 nemoclaw <name> connect` (see #3259) |
| Web search backend (Brave, Tavily, etc.) | Runtime via `web.backend` config flag; rebuild only if `web.fetchEnabled` flips | `nemoclaw <name> config set --key web.backend --value tavily` |
| Filesystem layout (Landlock zones, read-only mounts, container caps) | **Locked at creation** — no runtime change | Re-onboard with `nemoclaw onboard --recreate-sandbox` |
| Sandbox name | **Locked at creation** | Re-onboard with a different `--name` |
| GPU passthrough enable / device selector | **Locked at creation** | Re-onboard with `--gpu` / `--sandbox-gpu-device` |
| Shields posture (locked ↔ default mutable) | Runtime (operator-only) | `nemoclaw <name> shields up` / `shields down` — see the next section |
| Agents allow-list (`agents.list` in `openclaw.json`) | Runtime — hot-reloaded by OpenClaw on config change | Edit `openclaw.json` while shields are down |
| `openclaw.json` keys (general — model, agents.list, web.backend, channel config, etc.) | Mixed: locked under `shields up`, runtime-editable under `shields down`. Individual keys still follow the rebuild rules in the rows above (e.g. provider switch requires rebuild even after editing the JSON). | `nemoclaw <name> shields down`, edit `/opt/nemoclaw/openclaw.json` inside the sandbox, then `nemoclaw <name> shields up` |

If a row above conflicts with what you observe, the runtime source of truth inside the sandbox is `/opt/nemoclaw/openclaw.json`; the host registry caches metadata but the image and OpenClaw read from the in-sandbox file.

## Shields commands

Shields are an operator-only switch that toggles the sandbox between its default mutable state and a locked-down posture.
The sandbox itself cannot raise or lower its own shields — every transition is initiated from the host so a compromised agent cannot escape its policy by editing config.

Three commands manage the posture.
The commands are hidden from the standard `--help` output because they are operator workflows, not developer workflows; everything below documents the full surface.

### `shields status`

Print the current shields mode (`mutable_default`, `locked`, or `temporarily_unlocked`), the active policy preset, and any pending automatic restore timer.

```console
$ nemoclaw my-assistant shields status
Shields:   locked
Policy:    strict
Auto-restore: not scheduled (use `shields down --timeout 10m` to schedule)
```

### `shields up`

Raise shields: lock `openclaw.json` (and other mutable config files) against in-sandbox edits and apply the restrictive network policy that was captured the last time the sandbox was shielded.
This is the default expected state for a sandbox the operator has handed off to an agent.

```console
$ nemoclaw my-assistant shields up
✓ Shields raised: config locked, restrictive policy applied
```

`shields up` takes no flags.
If no saved snapshot exists yet (a fresh sandbox), the snapshot is taken from the current state.

### `shields down`

Lower shields: unlock config and apply a permissive (or operator-named) network policy so the operator can edit `openclaw.json`, swap presets, or run interactive maintenance.

```console
$ nemoclaw my-assistant shields down --timeout 10m --reason "rotating slack token"
✓ Shields lowered for 10m (policy: permissive); auto-restore at 14:32 UTC
```

| Flag | Default | Effect |
|---|---|---|
| `--timeout <duration>` | *no auto-restore* | After the duration elapses, a detached host-side timer re-runs `shields up` automatically. Accepts `5m`, `30s`, `1h`, etc. |
| `--reason <text>` | *empty* | Recorded in the shields audit log on the host. Required by some org policies; recommended for any cross-team session. |
| `--policy <name>` | `permissive` | Apply this named policy preset while shields are down instead of the default permissive set. Use a tighter preset (e.g. `messaging-only`) when the maintenance window only needs a subset of egress. |

The auto-restore timer is detached from the `shields down` invocation — closing your terminal does not cancel the restore.
If the timer process is killed before the deadline (e.g. host reboot), `shields status` will surface the inconsistency on the next check (see #3112 for the fail-open fix).

## See also

The mutability table above is a consolidated index of information that lives in more detail on per-topic pages:

- [Manage Sandbox Lifecycle](lifecycle.md) — full rebuild / re-onboard / upgrade workflow.
- [Switch Inference Providers](../inference/switch-inference-providers.md) — the rebuild path for provider and model changes.
- [Customize Network Policy](../network-policy/customize-network-policy.md) and [Approve Network Requests](../network-policy/approve-network-requests.md) — runtime policy editing and operator approval flow.
- [Security Best Practices](../security/best-practices.md) — the per-attack-surface posture table that this page complements.
- [OpenClaw Security Controls](../security/openclaw-controls.md) — application-layer controls that operate independently of NemoClaw.
- [CLI Commands Reference](../reference/commands.md) — full flag surface for every `nemoclaw` command, including the env vars that affect runtime behavior.
