<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Post-migration rescue tooling

These helpers exist for the period after the root CLI JS→TS migration lands on `main`. The CI guard also blocks edits that try to resurrect removed `bin/lib/*.js` compatibility shims; contributors should edit the canonical TS files instead.

## Files

- `move-map.json` — canonical old-path → new-path mapping
- `../ts-migration-assist.ts` — ports branch edits from migrated legacy paths onto the new canonical TS files
- `../ts-migration-bulk-fix-prs.ts` — maintainer helper for applying the assist script to open PR branches

## Typical contributor rescue flow

```bash
git fetch origin
git checkout <your-branch>
npm run ts-migration:assist -- --base origin/main --write
npm run build:cli
npm run typecheck:cli
npm run lint
npm test
```

## Typical maintainer rescue flow

```bash
git fetch origin
npm run ts-migration:bulk-fix-prs -- --all --base origin/main --update-branch
```

The bulk fixer only attempts PRs that:

- target `main`
- touch migrated legacy paths
- allow maintainer edits

When a branch cannot be fixed automatically, the tool leaves a summary so the remaining PRs can be handled manually.
