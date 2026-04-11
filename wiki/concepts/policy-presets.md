---
title: Policy Presets
category: concept
created: 2026-04-11
updated: 2026-04-11
sources: [docs-network-policy]
tags: [policy, presets, network, security]
---

# Policy Presets

Pre-built [network policy](network-policy.md) templates for common integrations,
shipped in `nemoclaw-blueprint/policies/presets/`.

## Available Presets

| Preset | Integration |
|---|---|
| `discord.yaml` | Discord webhook API |
| `telegram.yaml` | Telegram Bot API |
| `slack.yaml` | Slack API + webhooks |
| `docker.yaml` | Docker Hub, NVIDIA container registry |
| `pypi.yaml` | Python Package Index |
| `npm.yaml` | npm and Yarn registries |
| `huggingface.yaml` | Hugging Face model registry |
| `jira.yaml` | Atlassian Jira API |
| `outlook.yaml` | Microsoft 365 and Outlook |

## Usage

```bash
# List presets and applied policies
nemoclaw <name> policy-list

# Add a preset interactively
nemoclaw <name> policy-add

# Apply directly via OpenShell
openshell policy set nemoclaw-blueprint/policies/presets/pypi.yaml
```

## Scope

- **Static** — edit baseline YAML, re-run `nemoclaw onboard` → persists across restarts
- **Dynamic** — `openshell policy set` or `nemoclaw policy-add` → session only

NemoClaw is still determining which presets to ship by default.
Community suggestions welcome via issues or discussions.

## See Also

- [Network Policy](network-policy.md) — Baseline policy details
- [Sandbox Hardening](sandbox-hardening.md) — Full security stack
