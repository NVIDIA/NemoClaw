---
title: Wiki Index
category: index
created: 2026-04-11
updated: 2026-04-11
---

# Wiki Index

Content catalog for the NemoClaw knowledge base. Each entry links to a wiki
page with a one-line summary.

## Overview

- [overview.md](overview.md) — Living high-level synthesis of the NemoClaw project.

## Entities

- [openclaw](entities/openclaw.md) — Always-on agent framework that NemoClaw wraps.
- [openshell](entities/openshell.md) — NVIDIA container runtime providing sandbox isolation.
- [nvidia-nemotron](entities/nvidia-nemotron.md) — Default cloud inference model family.
- [nvidia-agent-toolkit](entities/nvidia-agent-toolkit.md) — Broader NVIDIA toolkit for agent development.
- [nemoclaw-plugin](entities/nemoclaw-plugin.md) — TypeScript CLI plugin extending OpenClaw.
- [nemoclaw-blueprint](entities/nemoclaw-blueprint.md) — Versioned Python artifact for sandbox orchestration.
- [sandbox](entities/sandbox.md) — Isolated OpenShell container running OpenClaw.
- [openshell-gateway](entities/openshell-gateway.md) — Credential-owning inference proxy.
- [discord-bridge](entities/discord-bridge.md) — Discord ↔ agent message forwarding service.
- [telegram-bridge](entities/telegram-bridge.md) — Telegram ↔ agent message forwarding service.
- [dgx-spark](entities/dgx-spark.md) — NVIDIA hardware platform with specific setup requirements.
- [ollama](entities/ollama.md) — Local inference runtime (experimental provider).
- [dashboard](entities/dashboard.md) — Web UI for agent interaction.

## Concepts

- [two-part-architecture](concepts/two-part-architecture.md) — Plugin + blueprint design with independent release cadences.
- [inference-routing](concepts/inference-routing.md) — Transparent provider routing through managed gateway endpoint.
- [network-policy](concepts/network-policy.md) — Deny-by-default egress control with operator approval.
- [sandbox-hardening](concepts/sandbox-hardening.md) — Four-layer security: network, filesystem, process, inference.
- [installation](concepts/installation.md) — Quick install, prerequisites, platform-specific notes.
- [workspace-files](concepts/workspace-files.md) — Agent personality, memory, and behavioural configuration.
- [backup-and-restore](concepts/backup-and-restore.md) — Built-in and manual backup/restore workflows.
- [sub-agents](concepts/sub-agents.md) — Multi-agent sandbox with per-agent workspaces and wikis.
- [brev-deployment](concepts/brev-deployment.md) — Remote GPU deployment via Brev provisioning.
- [policy-presets](concepts/policy-presets.md) — Pre-built network policy templates for common integrations.
- [blueprint-lifecycle](concepts/blueprint-lifecycle.md) — Resolve → verify → plan → apply → status.
- [turn-orchestration](concepts/turn-orchestration.md) — Serialized multi-model turn-taking on single GPU.
- [wiki-memory](concepts/wiki-memory.md) — Persistent compounding knowledge base pattern.
- [cli-commands](concepts/cli-commands.md) — Full command reference for nemoclaw, openshell, and openclaw.

## Sources

- [readme](sources/readme.md) — Repository README: pitch, quickstart, architecture, commands.
- [docs-about-overview](sources/docs-about-overview.md) — Official overview documentation.
- [docs-about-how-it-works](sources/docs-about-how-it-works.md) — Plugin/blueprint separation and lifecycle.
- [docs-reference-architecture](sources/docs-reference-architecture.md) — Detailed plugin structure, manifest, hardening.
- [docs-reference-commands](sources/docs-reference-commands.md) — Full CLI reference.
- [docs-inference](sources/docs-inference.md) — Inference configuration and Ollama verification.
- [docs-network-policy](sources/docs-network-policy.md) — Policy customization and presets.
- [docs-workspace](sources/docs-workspace.md) — Workspace files, backup, wiki memory, sub-agents.
- [docs-monitoring](sources/docs-monitoring.md) — Health checks, TUI, log streaming, reboot recovery.
- [docs-deployment](sources/docs-deployment.md) — Brev deploy, Discord bridge, Telegram bridge.
- [docs-contributing](sources/docs-contributing.md) — Developer guide: build, test, lint, commit conventions.
- [docs-security](sources/docs-security.md) — Security vulnerability reporting policy.
- [spark-install](sources/spark-install.md) — DGX Spark-specific installation guide.

## Analyses

<!-- No analyses filed yet. Substantive query results will be filed here. -->
