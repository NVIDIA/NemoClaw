---
title: NemoClaw Plugin
category: entity
created: 2026-04-11
updated: 2026-04-11
sources: [docs-reference-architecture]
tags: [plugin, typescript, cli, core]
---

# NemoClaw Plugin

The TypeScript CLI plugin that extends [OpenClaw](openclaw.md). It is the thin,
stable half of the [two-part architecture](../concepts/two-part-architecture.md).

## Location

`nemoclaw/src/` in the repository.

## Structure

```text
nemoclaw/src/
├── index.ts                 — Plugin entry point
├── cli.ts                   — Commander.js subcommand wiring
├── commands/
│   ├── launch.ts            — Fresh install into OpenShell
│   ├── connect.ts           — Interactive shell into sandbox
│   ├── status.ts            — Blueprint + sandbox health
│   ├── logs.ts              — Stream logs
│   └── slash.ts             — /nemoclaw chat command
└── blueprint/
    ├── resolve.ts           — Version resolution, cache management
    ├── fetch.ts             — Download from OCI registry
    ├── verify.ts            — Digest verification
    ├── exec.ts              — Subprocess execution
    └── state.ts             — Persistent state (run IDs)
```

## Manifest

Defined in `nemoclaw/openclaw.plugin.json`. Registers:

- Inference provider configuration
- `/nemoclaw` slash command
- Blueprint version pin and registry URL
- Sandbox name and provider type

## Responsibilities

- Registers with OpenClaw CLI as a plugin
- Provides `nemoclaw` host CLI commands
- Resolves, verifies, and executes the [blueprint](nemoclaw-blueprint.md)
- Handles user interaction (wizard, CLI output)

## See Also

- [NemoClaw Blueprint](nemoclaw-blueprint.md) — Versioned Python artifact
- [Two-Part Architecture](../concepts/two-part-architecture.md) — Plugin + blueprint design
- [CLI Commands](../concepts/cli-commands.md) — Full command reference
