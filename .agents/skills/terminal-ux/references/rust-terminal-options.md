<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Rust terminal library options

Researched 2026-09-22 from primary documentation.
This is a capability comparison and recommendation, not an implementation or performance benchmark.
Recheck APIs, releases, compiler support, feature flags, and licenses before adding dependencies.

## Recommendation for NemoClaw

NemoClaw's selected direction is Ratatui with an inline viewport for layout flexibility, with plain text final summaries and a separate append-only CI renderer.
Keep it display-only initially; selection, expandable details, and keyboard navigation are separate product decisions.
Indicatif remains a suitable alternative for simpler progress-only interfaces.
Evaluate `miette` for configuration diagnostics if source spans can be supplied safely.
Ratatui also leaves room for selectable resources, scrolling detail, or an interactive status view if those become requirements.
These are fit judgments based on the proposed UX, not measured rankings.

| Option | Documented capability | Fit and cost to investigate |
|---|---|---|
| [indicatif](https://docs.rs/indicatif/latest/indicatif/) | Concurrent progress bars/spinners, templates, stderr drawing, byte/duration formatting. | Closest fit for a compact active-work block. It hides bars on non-terminals, so implement log heartbeats separately. |
| [console](https://docs.rs/console/latest/console/) | Terminal access, styling, ANSI-aware width and truncation helpers. | Useful alongside progress rendering; hand-building a concurrent renderer with it would add maintenance. |
| [Ratatui](https://docs.rs/ratatui/latest/ratatui/enum.Viewport.html) | Fullscreen, inline, and fixed viewports. Inline can coexist with normal terminal output. | Best candidate for richer interactive resource/detail views. Layout, UI state, and event coordination still need application code. |
| [Crossterm](https://docs.rs/crossterm/latest/crossterm/) | Terminal commands, cursor control, styling, and input events across platforms. | A backend/toolkit rather than a ready-made progress UX. Avoid recreating higher-level widgets without a demonstrated need. |
| [cliclack](https://docs.rs/cliclack/latest/src/cliclack/lib.rs.html) | Opinionated prompts, styled messages, spinners, and grouped progress. | Attractive for guided setup; less aligned with NemoClaw's explicit file-driven commands and removal of onboarding. |
| [Cursive](https://docs.rs/cursive/latest/cursive/) | View tree and callback-driven event loop for terminal applications. | Better suited to forms/dialogs; adopting that interaction model is unnecessary for the proposed command transcripts. |
| [miette](https://docs.rs/miette/latest/miette/) | Diagnostic codes, causes, source spans, help, graphical and narrated reports. | Error presentation rather than a TUI. Keep deployment outcomes/recovery in our typed contract; do not adopt its JSON format as our command-result schema. |

## Integration details that affect the choice

`indicatif::MultiProgress` coordinates concurrent draws and can suspend rendering around other output.
Its `println` does nothing when the draw target is hidden; it is not a CI logging fallback.
Route durable diagnostics through the selected renderer explicitly, and do not hold a suspended-rendering lock across long operations.
See [MultiProgress](https://docs.rs/indicatif/latest/indicatif/struct.MultiProgress.html).

Ratatui supports a [TestBackend](https://ratatui.rs/concepts/backends/).
For inline use, inspect terminal initialization rather than assuming the default [init helper](https://docs.rs/ratatui/latest/ratatui/fn.init.html) is appropriate; configure stream, viewport, terminal modes, and restoration deliberately.
Keep a plain renderer for CI and accessibility even if interactive rendering uses Ratatui.

Indicatif provides an optional [InMemoryTerm](https://docs.rs/indicatif/latest/indicatif/struct.InMemoryTerm.html) for terminal-oriented tests.
Use terminal tests to check resize, concurrent messages, completion, and interruption, alongside tests of plain output and JSON.

Miette's graphical features add dependencies; enable them only at the CLI boundary if selected.
Source snippets need sanitized input and valid spans, not just an error string.
Domain errors should remain usable without the presentation dependency.
See [miette application/library guidance](https://docs.rs/miette/latest/miette/).

## Evidence needed before adoption

Replay the same typed event fixtures through candidate renderers at narrow and normal widths.
Cover simultaneous downloads, a ten-minute readiness wait, a credential prompt, an error arriving during redraw, Ctrl-C, and stderr redirected while stdout remains a terminal.
Verify that machine output remains parseable and that warnings/errors survive progress cleanup.
Measure incremental dependencies, clean/incremental CLI build time, and release binary size with the actual feature sets.
No comparative build-time, memory, or binary-size measurements were made in this research.
