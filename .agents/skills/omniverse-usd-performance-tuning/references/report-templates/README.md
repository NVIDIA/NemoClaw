<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# USD Performance Tuning Report Templates

These templates are the design surface for `optimization-report`.

The HTML template is intentionally static and self-contained:

- No JavaScript.
- No charting libraries.
- No external assets.
- CSS-only score ring, bars, badges, and impact cards.

The syntax is a deliberately small Jinja-compatible subset (`{{ value }}`,
`{% for item in items %}`, `{% if value %}`, and simple equality checks). The
committed renderer supports that subset with Python's standard library, so
report generation does not require Jinja2.

Use `optimization-report.design-fixture.json` as a stable visual fixture when
iterating on layout, colors, and wording without rerunning a full optimization.
For local preview, run:

```bash
python3 references/report-templates/render_preview.py
```

The preview helper is Python stdlib-only and writes
`optimization-report.preview.html` next to the templates. Treat that output as a
generated visual aid, not as a source template.

Runtime metrics caveat: RAM, VRAM, FPS, frame time, shader cost, and renderer
activity belong in Omniperf or an equivalent runtime profiling dashboard. The
report templates focus the score on stage/composition optimization and provide
a separate runtime-profiling handoff section for external artifacts.
