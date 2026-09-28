---
name: terminal-ux
description: Design or review CLI output, terminal progress, and error presentation across interactive terminals, CI logs, and JSON automation. Use when defining terminal UX or choosing rendering libraries.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Terminal UX

Design output around three questions: what will change, what is happening, and what state remains?
Treat presentation as a consumer of domain facts, never as a second orchestration engine.

## Establish the contract

Inspect current command help, output rendering, progress events, error types, and captured runs before proposing behavior.
Distinguish existing behavior, proposed behavior, and observations that the application cannot yet supply.
Preserve compatibility requirements and existing operation ownership.
A request for a design or library comparison does not authorize implementation or live operations.

For NemoClaw, start with the current [CLI contract](../../../docs/reference/cli.md) and [responsibility boundaries](../../../docs/design/scope.md).
Read [the original proposal](references/nemoclaw-proposal.md) for design rationale and illustrative transcripts; it is not the current command reference.
For Rust library selection, read [the research](references/rust-terminal-options.md) and recheck primary documentation before depending on current APIs.
Those references contain project choices and dated research, not universal requirements.

## Design and review

| Dimension | Decision rule |
|---|---|
| Information density | Put consequential changes and active work first; group supporting details without losing actions or mixing counting units. |
| Presentation | Preserve scrollback and copyable commands; use words independently of color; wrap safely on narrow terminals. |
| Correctness | Keep planned, observed, unknown, unsupported, failed, and completed states distinct. Never derive success from an empty change list alone. |
| Timeliness | Show start and stage changes promptly; separate elapsed-time heartbeats from new observations; use percentages only with measured totals. |
| Usefulness | Name user resources, relevant endpoints, retention, and supported next actions. Internal identifiers belong in diagnostic detail unless necessary to disambiguate. |
| Errors | Lead with failed operation/resource, actionable cause, known remaining state, and valid recovery. Expose useful underlying diagnostics without flooding the terminal. |

Represent concurrency honestly.
Show a dependency wait only if its reason is known.
Do not invent runtime stages, ETAs, health, rollback, or cleanup guarantees.
Qualify readiness separately from response tests and ongoing health.
Unsupported and stale observations must remain identifiable when they affect the result.

Specify interactive, redirected, and machine-readable behavior together.
Select animation using the stream being rendered; stdout and stderr may have different terminal capabilities.
Redirected output should preserve stage changes and bounded heartbeats without control sequences.
Keep final machine results separate from progress and document failures, interruptions, exit codes, and incomplete results.
Preserve the same domain facts across renderers.

Stop or suspend dynamic rendering before prompts, diagnostics, or final summaries.
Coordinate terminal writes and restore any changed terminal modes on recoverable exit paths.
Support plain output for accessibility and limited terminals; disabling color alone need not disable animation.
Treat resource labels and external diagnostics as untrusted terminal text: escape control sequences and redact secrets, including in snippets and files.

Use one error structure for human and machine output.
Show file/field and source location when available; do not fabricate spans or print credential-bearing source lines.
Distinguish confirmed resource state from planned actions after partial failure.
Only promise a diagnostic artifact when one was actually written.

## Choose implementation scope

Start with the smallest rendering capability that meets the interaction requirements.
Inline progress does not by itself justify raw mode, an alternate screen, keyboard navigation, or a new event framework.
Keep typed outcomes and progress independent of rendering libraries.
Use native orchestration/runtime observations rather than adding UI-owned probes or parsing prose logs.
Measure dependency, build-time, and binary-size costs before claiming that one option is lighter.

## Validate behavior

Exercise unchanged success, long waits/downloads, concurrent work, incomplete observation, partial failure, interruption, destructive retention, and repeated teardown where applicable.
Check TTY and redirected streams independently, narrow width, plain output, and machine-readable failures.
Assert meaningful invariants: no lost actions, no false success, no secret/control-sequence leakage, durable error visibility, and usable recovery.
Use representative transcripts and terminal tests rather than tests that merely duplicate formatting implementation.
