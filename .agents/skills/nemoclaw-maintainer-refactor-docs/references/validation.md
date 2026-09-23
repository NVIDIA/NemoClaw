<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Step 7: Validate the Refactor

Run the existing deterministic checks rather than inventing another route model:

```bash
npm run docs:sync-agent-variants
npm run docs
npx vitest run test/generation/check-docs-published-routes.test.ts test/generation/check-docs-links.test.ts
git diff --check
```

Add or extend focused route tests when the refactored section is not covered by the current published-route checker.
Test observable published routes and redirects rather than source-file-relative assumptions.

Complete these audits after the build:

- Search for every deleted filename, old slug, old title, and old route.
- Search for every moved anchor and update references whose semantic destination changed.
- Search source comments, package-level `AGENTS.md` files, tests, and scripts for statements that name the former docs owner.
- Confirm no page links to a foldable section root.
- Confirm all redirects terminate at published pages for the applicable variants.
- Compare the old heading inventory with the new pages and account for every unique topic.
- Search canonical troubleshooting and reference destinations for duplicate headings or repeated remediation.
- Inspect generated OpenClaw, Hermes, and Deep Agents pages when variant blocks or shared lists changed.
- Check that simple lists have no blank lines between consecutive items.
- Visually inspect the Fern preview when navigation depth, titles, or conditional content changed.

Treat automated link feedback as a hypothesis.
Fern links resolve from published slug routes, so a valid link may not match a source-file-relative path.
Verify link comments against `docs/index.yml`, `fern/docs.yml`, generated variant mappings, and the deterministic route checks before editing.
Missing anchors can still be real even when the page route exists.

## Step 8: Run an Independent Docs Review

Run an independent documentation writer review of the completed documentation-only change. Give
the reviewer the old-to-new ownership map.
Ask it to check for content loss, duplicate ownership, variant drift, bad redirects, oversized
paragraph blocks, generated paragraph joins, and style regressions without telling it the expected
verdict.
Apply valid findings and rerun affected checks.
