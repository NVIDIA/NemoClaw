<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Generated NemoClaw Catalog Skills

This directory is generated from `.agents/catalog-skills.yaml` and `.agents/skills/`.
Do not edit files here directly. The exporter preserves NVSkills signing artifacts (`skill.oms.sig` and `skill-card.md`) when regenerating an already-signed export.

To update this export, edit the source skills or allowlist, then run:

```bash
python3 scripts/export-catalog-skills.py
```

CI verifies the directory with:

```bash
python3 scripts/export-catalog-skills.py --check
```
