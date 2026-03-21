---
name: nemoclaw-overview
description: Explains NemoClaw plugin, blueprint, sandbox creation, and inference routing concepts. Also covers release notes and changelog. Use when asking what NemoClaw is, how it works, or checking release history.
---

# Nemoclaw Overview

Explains NemoClaw plugin, blueprint, sandbox creation, and inference routing concepts.

## Context

NemoClaw combines a lightweight CLI plugin with a versioned blueprint to move OpenClaw into a controlled sandbox.

The `nemoclaw` CLI is the primary entrypoint for setting up and managing sandboxed OpenClaw agents.
It delegates heavy lifting to a versioned blueprint, a Python artifact that orchestrates sandbox creation, policy application, and inference provider setup through the OpenShell CLI.

## Design Principles

Thin plugin, versioned blueprint
: The plugin stays small and stable. Orchestration logic lives in the blueprint and evolves on its own release cadence.

Respect CLI boundaries
: The `nemoclaw` CLI is the primary interface for sandbox management.

Supply chain safety
: Blueprint artifacts are immutable, versioned, and digest-verified before execution.

## Reference

- [How NemoClaw Works](references/how-it-works.md) — full architecture walkthrough
- [NemoClaw Overview](references/overview.md) — capabilities, benefits, and use cases
- [NemoClaw Release Notes](references/release-notes.md)

## Related Skills

- `nemoclaw-get-started` — Quickstart to install NemoClaw and run your first agent
- `nemoclaw-configure-inference` — Switch Inference Providers to configure the inference provider
- `nemoclaw-manage-policy` — Approve or Deny Network Requests to manage egress approvals
- `nemoclaw-deploy-remote` — Deploy to a Remote GPU Instance for persistent operation
- `nemoclaw-monitor-sandbox` — Monitor Sandbox Activity to observe agent behavior
