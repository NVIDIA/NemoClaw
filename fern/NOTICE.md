<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fern Integration Sources

The v1 integration adapts NVIDIA NemoClaw's Apache-2.0 documentation configuration and publishing workflows from [main revision f5c05a0e6a59bd5133c50e31becbff25af274c33](https://github.com/NVIDIA/NemoClaw/tree/f5c05a0e6a59bd5133c50e31becbff25af274c33).
Upstream NVIDIA copyright notices remain in adapted files.
`assets/NVIDIA_symbol.svg` is copied unchanged from that revision; it contains the NVIDIA brand mark.

Modifications on 2026-09-15:

- Extend `fern/docs.yml` with Latest (main) and v1 version entries, retaining main's routes, redirects, components, styling, and Fern CLI pin.
- Darken the light-mode accent to satisfy Fern's contrast check; retain NVIDIA green in dark mode.
- Adapt PR preview, staging, release publishing, and preview cleanup behavior into `.github/workflows/docs.yml` and `tools/docs/fern.py`.
- Generate v1 pages through Cargo and preserve main's generators in an isolated import pinned by `main-source.json`.
- Use a separate locked npm manifest containing only `yaml` for the imported generators, executed with Node's built-in TypeScript support.
- Rewrite imported absolute Markdown snippet paths from `/../docs/` to `/_main/docs/`; retain the original content and notices.
- Isolate previews with `nemoclaw-v1` IDs and gate shared-site release publication on explicit enablement after publisher coordination.
- Reuse the reviewed-npm setup action at immutable revision `98669f24d35f18e49b6b2769cd68709509ea24f2`; its upstream notice and audited npm identity remain in that action's repository checkout.

The generator and tests under `crates/nemoclaw-build` are original NemoClaw code.
