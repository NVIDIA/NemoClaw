<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Catalog Skills Refresh

## Summary

- Regenerates `skills/` from `.agents/catalog-skills.yaml` and `.agents/skills/`.
- Keeps the NVIDIA Verified Skills catalog export deterministic and reviewable.

## Validation

- `python3 scripts/export-catalog-skills.py --check`

After maintainer review, request signing by commenting `/nvskills-ci` on this PR if the workflow did not do so automatically.
