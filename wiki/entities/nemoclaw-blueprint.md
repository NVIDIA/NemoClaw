---
title: NemoClaw Blueprint
category: entity
created: 2026-04-11
updated: 2026-04-11
sources: [docs-reference-architecture, docs-about-how-it-works]
tags: [blueprint, python, orchestration, core]
---

# NemoClaw Blueprint

The versioned Python artifact that orchestrates all [OpenShell](openshell.md)
resource creation and updates. It is the heavy-lifting half of the
[two-part architecture](../concepts/two-part-architecture.md).

## Location

`nemoclaw-blueprint/` in the repository.

## Structure

```text
nemoclaw-blueprint/
├── blueprint.yaml           — Manifest (version, profiles, compatibility)
├── policies/
│   ├── openclaw-sandbox.yaml — Default baseline policy
│   └── presets/              — Policy templates for common integrations
```

## Manifest (`blueprint.yaml`)

- `version` — Semantic version
- `min_openshell_version` — Minimum OpenShell required
- `min_openclaw_version` — Minimum OpenClaw required
- `digest` — SHA256 computed at release time
- `profiles` — Inference profiles (default, ncp, nim-local, vllm)
- `components` — Sandbox image, inference routing, network policies

## Lifecycle

See [blueprint lifecycle](../concepts/blueprint-lifecycle.md):

```text
Resolve → Verify digest → Plan resources → Apply via OpenShell CLI → Status
```

## Responsibilities

- Orchestrates sandbox creation
- Applies [network policy](../concepts/network-policy.md)
- Configures [inference routing](../concepts/inference-routing.md)
- Manages the full apply lifecycle through OpenShell

## See Also

- [NemoClaw Plugin](nemoclaw-plugin.md) — TypeScript CLI that invokes the blueprint
- [Blueprint Lifecycle](../concepts/blueprint-lifecycle.md) — Resolve → verify → plan → apply
- [Policy Presets](../concepts/policy-presets.md) — Pre-built policy templates
