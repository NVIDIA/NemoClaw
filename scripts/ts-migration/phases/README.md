<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# JS to TS migration phase manifests

These manifests drive `scripts/migrate-js-to-ts.ts` so each stacked PR in the root CLI migration can be applied mechanically and re-run after rebases.

## Usage

```bash
npm run migrate:js-to-ts -- --manifest scripts/ts-migration/phases/<phase>.json --dry-run
npm run migrate:js-to-ts -- --manifest scripts/ts-migration/phases/<phase>.json --apply
```

See `example.json` for the manifest shape. It is a template, not a runnable phase.

## Supported operations

- `renameTests`: rename `test/**/*.js` files to `.ts`
- `moveRuntime`: move authored runtime JS into `src/**/*.ts`
- `rewriteSourcePaths`: rewrite source-inspection references in tests
- `shimStrategy`: wrapper strategy for moved runtime files

## Shim strategies

- `simple` — `module.exports = require("../../dist/lib/foo")`
- `cache-busting` — wrapper clears the dist module from `require.cache` before loading
- `cli-launcher` — shebang wrapper for `bin/nemoclaw.js`

## Notes

- Test renames and runtime moves prepend `// @ts-nocheck` and otherwise preserve file content as much as possible.
- The tool rewrites relative `require("../../dist/lib/*")` imports in moved runtime files so the new TS source points at `src/**/*` instead of `dist/**/*`.
- Keep each PR to one manifest / one phase.
