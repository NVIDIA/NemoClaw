---
title: Blueprint Lifecycle
category: concept
created: 2026-04-11
updated: 2026-04-11
sources: [docs-about-how-it-works, docs-reference-architecture]
tags: [blueprint, lifecycle, architecture]
---

# Blueprint Lifecycle

The [NemoClaw Blueprint](../entities/nemoclaw-blueprint.md) follows four stages
when applied:

## Stages

```text
Resolve → Verify → Plan → Apply → Status
```

### 1. Resolve

Resolve the blueprint artifact from version pin and registry URL configured
in the [plugin manifest](../entities/nemoclaw-plugin.md). Manages local caching.

### 2. Verify

Check the SHA256 digest against the expected value in `blueprint.yaml`.
Validate compatibility constraints (`min_openshell_version`,
`min_openclaw_version`).

### 3. Plan

Determine what [OpenShell](../entities/openshell.md) resources need to be created
or updated: gateway, [sandbox](../entities/sandbox.md), inference routes,
[network policies](network-policy.md).

### 4. Apply

Execute the plan through the OpenShell CLI. Creates or updates all resources.

### 5. Status

Report the result — running sandbox, active inference provider, applied policies.

## Supply Chain Safety

- Blueprint artifacts are immutable and versioned
- Digests are SHA256, computed at release time
- Re-running setup recreates from the same blueprint/policy (reproducible)

## See Also

- [NemoClaw Blueprint](../entities/nemoclaw-blueprint.md) — The artifact itself
- [Two-Part Architecture](two-part-architecture.md) — Plugin + blueprint design
