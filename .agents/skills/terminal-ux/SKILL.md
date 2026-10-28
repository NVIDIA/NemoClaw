---
name: terminal-ux
description: Design or review NemoClaw CLI output, including progress, errors, and final results, across terminals, CI logs, and JSON.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Terminal UX

Output should answer three questions: what will change, what is happening, and what state remains?
Rendering consumes facts from the SDK; it doesn't orchestrate, probe, or parse logs.

Start from the [CLI contract](../../../docs/reference/cli.md), the [responsibility boundaries](../../../docs/design/scope.md), and the current renderer in `crates/nemoclaw-cli`.
Progress renders in a Ratatui inline viewport on terminals, as plain text when redirected, and as JSON for automation.

## Rules

- Keep planned, observed, unknown, unsupported, failed, and completed states distinct; never infer success from an empty change list.
- Don't invent stages, ETAs, health, or cleanup guarantees. Show percentages only with measured totals, and keep elapsed-time heartbeats separate from new observations.
- Give interactive, redirected, and JSON output the same facts. Choose animation per stream; redirected output gets stage changes and bounded heartbeats without control sequences, and JSON results stay separate from progress.
- Stop dynamic rendering before prompts, diagnostics, and final summaries, and restore terminal modes on every exit path.
- Escape control sequences and redact secrets in resource labels and external diagnostics.
- Don't rely on color alone.

## Failures

Lead with the operation and outcome, then the state directory, the cause, what remains, and the recovery:

```text
Apply failed · 3m 41s
State: /home/alex/.nemoclaw/demo

sandbox/coder: sandbox unavailable: SANDBOX_PHASE_ERROR, reason ControlSupervisorStartFailed, exit code unknown; control supervisor could not start; check the sandbox policy and attached providers; resources retained

Resources retained; sandbox startup failed.

Inspect the sandbox with OpenShell using this deployment's gateway and workspace; collect gateway and supervisor logs before cleanup.
```

Text and JSON share one error structure.
After a partial failure, separate confirmed state from planned actions.

## Validate

Cover long waits, concurrent work, partial failure, interruption, terminal and redirected streams, narrow widths, and JSON failures.
Assert invariants, such as no lost actions, no false success, and no leaked secrets or control sequences, instead of repeating format strings.
