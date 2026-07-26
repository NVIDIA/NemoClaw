<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Test Gaps Workflow

Add tests for the most important uncovered behavior. Do not rewrite the code.

For risky code areas, see [RISKY-AREAS.md](RISKY-AREAS.md).

## Step 1: Collect File Set

Use changed PR files, CI failures, recent `main` changes, and the state-file hotspot list.
If no file set is available, use the highest-ranked PR that can progress.

## Step 2: Map to Existing Tests

Repo conventions:

- Root integration tests (`test/`): ESM imports
- Plugin tests: co-located as `*.test.ts`
- Shell logic: may need extraction into testable helper first

For each risky file, find a test for the changed behavior.
Check whether the test is indirect or unstable. Identify a small extraction when it improves testing.

## Step 3: Select tests

Prioritize regressions found during maintenance:

- invalid/boundary env values, shell quoting, retry/timeout behavior
- missing/malformed config, denied network/policy paths
- duplicate workflow/hook behavior, version/tag/DCO edge cases
- unauthorized or unsafe inputs

For risky code, include a test that rejects invalid or unsafe input.

## Step 4: Extract code when needed

Make only the extraction needed for tests:

- Move parsing into a pure helper.
- Separate construction from execution.
- Move hook logic into a function.
- Replace related primitive values with a typed object.

Do not use a test change to add a refactor that is not required.

## Step 5: Add Tests

- Put CLI tests in `test/`.
- Put plugin tests in `nemoclaw/src/`.
- Use TypeScript tests for TypeScript helpers.
- Mock calls to external systems. Unit tests must not call external APIs.
- For security paths, prove that the code denies the unsafe action.

## Step 6: Validate

```bash
npm test                          # root tests
cd nemoclaw && npm test           # plugin tests
npm run typecheck:cli
npm run check
```

Run only the commands needed to validate the change.

## Step 7: Report remaining gaps

Report each remaining risk. Possible causes include:

- The code needs a larger refactor before it can be tested.
- Shell state prevents isolation.
- No fixture strategy exists.
- An infrastructure dependency is unstable.

## Notes

- Tests for risky code are required for merge.
- Prefer one regression test with a defined failure over many general integration tests.
- If a credible fix needs a redesign, follow [SEQUENCE-WORK.md](SEQUENCE-WORK.md).
