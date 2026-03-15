<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Overview

NemoClaw is the [OpenClaw](https://openclaw.ai) plugin for [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell).
It moves OpenClaw into a sandboxed environment where every network request, file access, and inference call is governed by declarative policy.

## What NemoClaw Does

- Sandboxes OpenClaw. Creates an OpenShell sandbox pre-configured for OpenClaw, with strict filesystem and network policies applied from the first boot.
- Routes inference through NVIDIA. Configures OpenShell inference routing so agent traffic flows through cloud-hosted Nemotron 3 Super 120B, a local NIM service, or vLLM, depending on the selected profile.
- Manages the lifecycle. Handles migration from a host-installed OpenClaw, snapshot-based rollback, blueprint versioning, and digest verification.

## How It Fits Together

NemoClaw is a thin TypeScript plugin that registers commands under the `openclaw nemoclaw` namespace.
It delegates heavy lifting to a versioned blueprint, a Python artifact that orchestrates sandbox creation, policy application, and inference provider setup through the OpenShell CLI.

```text
┌──────────────────────────────────────────────┐
│  Host                                        │
│                                              │
│  openclaw nemoclaw launch / migrate          │
│       │                                      │
│       ▼                                      │
│  nemoclaw plugin  ──▶  blueprint runner      │
│       │                    │                  │
│       │                    ▼                  │
│       │              openshell CLI            │
│       │              (sandbox, gateway,       │
│       │               inference, policy)      │
│       │                                      │
│  ─────┼──────────────────────────────────── ──│
│       │         OpenShell Sandbox             │
│       │                                      │
│       └──▶  OpenClaw agent                   │
│             ├── NVIDIA inference (routed)     │
│             ├── strict network policy         │
│             └── filesystem isolation          │
└──────────────────────────────────────────────┘
```

## Design Principles

Thin plugin, versioned blueprint
: The plugin stays small and stable. Orchestration logic lives in the blueprint and evolves on its own release cadence.

Respect CLI boundaries
: Plugin commands live under the `nemoclaw` namespace and never override built-in OpenClaw commands.

Supply chain safety
: Blueprint artifacts are immutable, versioned, and digest-verified before execution.

OpenShell-native for new installs
: For users without an existing OpenClaw installation, NemoClaw recommends `openshell sandbox create` directly
  rather than forcing a plugin-driven bootstrap.

Snapshot everything
: Every migration creates a restorable backup. Ejecting rolls back to the exact pre-migration state.
