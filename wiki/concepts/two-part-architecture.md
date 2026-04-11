---
title: Two-Part Architecture
category: concept
created: 2026-04-11
updated: 2026-04-11
sources: [docs-about-how-it-works, docs-reference-architecture]
tags: [architecture, design, core]
---

# Two-Part Architecture

NemoClaw is built as two cooperating components with independent release cadences:

## 1. Plugin (TypeScript)

The [NemoClaw Plugin](../entities/nemoclaw-plugin.md) is a thin, stable CLI
package that registers with [OpenClaw](../entities/openclaw.md). It stays small
and changes infrequently.

**Responsibilities:**

- Registers with OpenClaw CLI as a plugin
- Provides `nemoclaw` host commands
- Resolves, verifies, and executes the blueprint as a subprocess
- Handles user interaction (wizard, CLI outputs)

## 2. Blueprint (Python)

The [NemoClaw Blueprint](../entities/nemoclaw-blueprint.md) is a versioned
Python artifact that handles all heavy lifting. It changes more frequently
and follows its own release cadence.

**Responsibilities:**

- Orchestrates all [OpenShell](../entities/openshell.md) resource creation/updates
- Manages sandbox creation, policy application, inference routing
- Follows the [blueprint lifecycle](blueprint-lifecycle.md): resolve → verify → plan → apply → status

## Design Principles

- **Thin plugin, versioned blueprint** — CLI stays small; heavy lifting in blueprint
- **Supply chain safety** — Blueprint artifacts are immutable, versioned, digest-verified
- **OpenShell-native** — Uses OpenShell directly when possible
- **Reproducible setup** — Re-running setup recreates from the same blueprint/policy

## See Also

- [Blueprint Lifecycle](blueprint-lifecycle.md) — The four-stage apply process
- [NemoClaw Plugin](../entities/nemoclaw-plugin.md) — TypeScript CLI
- [NemoClaw Blueprint](../entities/nemoclaw-blueprint.md) — Python orchestrator
