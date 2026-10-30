<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 Lauren Tan -->
<!-- SPDX-License-Identifier: Apache-2.0 AND MIT -->

# Adapted Skills

Five skills here adapt skills from pstack, and `statechart` runs pstack's statechart tool without copying it.

- Source: [pstack skills](https://github.com/cursor/plugins/tree/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills)
- Revision: `4dd1d05818d19792e7cd6e818f1667f95f7e1dbe`
- License: MIT, reproduced below

## Changes

2026-10-30: adapted for NemoClaw `v1`.

- All five skills point at NemoClaw's skill location, design scope, upstream boundaries, live-test ownership rules, and pull request skill in place of Cursor's rules, `Task` subagents, and model roster; they ask before pushing, commenting, or credentialed runs.
- `interrogate` inlines the parts of pstack's `arena` and `in-your-own-words` skills it used, treats an issue and its comments as a design, has adversaries probe the pinned upstream versions, and adds the restart, two-writer, and next-action probes from pstack's idempotence and shared-state principles.
- `create-formal-verification-skill` picks targets from NemoClaw's ownership and recovery invariants, maps questions to tools for Rust code, requires discussion before adding a verifier dependency, and keeps models beside the generated skill.
- `maintain-formal-verification-skill` looks for `verify-*` skills under `.agents/skills`.
- `create-verification-skill` builds on `nemoclaw-e2e` and the live tests, requires an owned deployment, cleans up with `nemoclaw destroy`, keeps credentials out of evidence, and states the feature map's shape in place of upstream's example files.
- `maintain-verification-skill` ships corrections through `nemoclaw-contributor-create-pr`.
- `statechart` fetches the pinned tool and a checksum-verified TLC jar into the user cache instead of vendoring the TypeScript.

## Upstream License

```text
MIT License

Copyright (c) 2026 Lauren Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
