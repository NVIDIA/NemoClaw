---
name: nemoclaw-contributor-test-audit
description: "Audit NemoClaw tests for redundant or implementation-coupled coverage. Use when writing tests, reviewing test value, or reducing a test suite."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Audit Test Value

Keep tests that detect distinct regressions. Remove duplicated evidence and test support that no
retained test needs. A deletion count or unchanged coverage percentage does not establish success.

For ordinary test changes, apply the authoring questions below to the changed tests. A broader audit
requires a request for that scope. This skill does not authorize publication, live execution, or
changes to unrelated product behavior.

Read the applicable `AGENTS.md` files and [test contracts](../../../test/README.md).
Use [evidence selection](../../references/e2e-authoring.md) to choose the layer that owns each behavior.
Follow [writing and review guidance](../_shared/documentation-writing-review.md) for explanatory text.

## Author Tests

Before adding or extending a test, establish:

- The observable behavior or independent contract that it protects.
- A credible defect that would make its assertions fail.
- Why existing tests cannot detect that defect.
- Whether the test needs an export, flag, injection hook, or wrapper that production does not need.

Extend an existing case or fixture when it already owns the behavior. Add another layer only for a
distinct failure, such as package assembly or transport behavior that the first layer cannot exercise.
Exercise the production entry point before introducing a test-only interface.
Follow the regression-evidence requirements in `test/README.md` when fixing a defect.

## Discover Candidates

Start with read-only inspection of the requested area. Read each candidate test, its behavior owner,
callers, shared fixtures, overlapping tests, project routing, and relevant Git history.
Inspect dependency source or types when a claim depends on dependency behavior.
Search module basenames in tests that read files, as well as symbol imports. Paths may be assembled
from separate directory and filename strings.

For a whole-suite request, map each subsystem's production entrypoints and test layers before
calling the audit complete. Duplicate-body and assertion scans are discovery tools, not a semantic
audit. Review obsolete implementations, mocked wiring, repeated fixtures, and cross-layer ownership;
record both removal decisions and the reason superficially similar tests remain independent.
An unimported module may still be a packaged API, a manifest-loaded asset, a subprocess entrypoint,
or an intentionally dormant implementation. Check those consumers and the feature's history.

Include fixture libraries, live companions, shell/Python helpers, and tests of those helpers in the
inventory. Follow retired entrypoints through their remaining dependency chains. A unit or package
test does not itself establish a production consumer. Check compiled loaders, shell launchers,
configured setup hooks, and intentionally inactive qualification paths before removing a chain.
Trace existing remediation PRs so the audit does not duplicate another accepted change.

When only scenario data differs, consider a named table instead of retaining copied setup and
assertions. Preserve each input and expected result, and verify that test names remain useful.
Audit unconditional skips: repair useful checks with isolated, bounded fixtures; remove placeholders
whose subject or failure injection was retired.

Look for:

- Tests without assertions, self-comparisons, or expected results calculated by the subject under test.
- Mocks that implement the behavior the test claims to verify.
- Copies of source strings, export lists, manifests, or configuration inventories.
- Repeated scenarios that fail for the same reason at multiple layers.
- Private helper or call-shape assertions already covered through the owning consumer.
- Fixtures that supply the receipt, state transition, or callback order that production should produce.
- Negative cases that fail at an unrelated guard before reaching the claimed behavior.
- Exports, wrappers, globals, and dead paths kept alive only by redundant tests.

These patterns identify candidates, not automatic deletions. Keep independent API, security,
credential, policy, migration, lifecycle, platform, packaging, release, and compatibility contracts.
Check called helpers, subprocess failures, and intentional exceptions before classifying a test as assertion-free.
Repeated calls and round trips can protect independent determinism and serialization contracts.
Observable ordering and exact protocol bytes can be valid contracts.
Apply the reviewed source-shape exceptions in `test/README.md`; static inspection alone is not a
reason to delete a test. Treat a baseline failure as evidence to investigate, not permission to remove it.

## Establish Deletion Evidence

Before editing, record the candidate's path and test title, the failure it detects, and relevant history.
Name the remaining test that detects the same failure, or explain why the assertion protects no contract.
Identify production callers and any fixture or support deletion that the change permits.
State the risk and focused validation command. Keep a candidate when this evidence is incomplete.

Apply one coherent group of changes at a time. Preserve distinct positive, denial, recovery, and
cleanup behavior. Remove support code only after checking all its consumers.
Do not reduce coverage thresholds, expand exclusions, skip tests, or weaken assertions to meet a
deletion target. Do not move duplicated assertions into helpers or generated checks.
For live assertions, follow the disposition and budget rules in the owning E2E reference and test guide.

## Validate the Reduction

Run the affected tests before and after the edit with the same configuration and environment.
Do not edit their source or fixtures while the test runner is active.
Use the projects in `vitest.config.ts`; `npm run test:changed` does not cover every execution lane.

Examples, after repository setup:

```bash
npx vitest run --project cli src/lib/<area>/<owner>.test.ts
npx vitest run --project integration test/<area>/<owner>.test.ts
npx vitest run --project plugin nemoclaw/src/<area>/<owner>.test.ts
```

Include retained overlapping tests in the focused run. For a removed source assertion, execute the
owning validator or isolated behavior test when one exists.
Use a targeted mutation when overlap remains uncertain: introduce the named defect temporarily and
confirm the retained test rejects it for the intended reason. Restore the source before continuing.

For coverage comparisons, use identical production source, inclusion rules, and test selections before
and after deletion. Compare affected-file statements, branches, functions, and lines; inspect lost
coverage even when aggregate percentages remain stable. Use `npm run test:coverage:cli` or
`npm run test:coverage:plugin` when the audit needs full CLI or plugin coverage evidence.
Preserve `ci/coverage-threshold-*.json`. Report coverage as unmeasured when no comparison ran.

Run `npm run test:projects:check` after adding, moving, or deleting test files.
Run applicable formatting checks and `git diff --check`.
For live companions, run the mock/live parity checker against the complete proposed base/head diff.
Passing the checker's unit suite does not establish parity for that diff.
Use `CONTRIBUTING.md` for broader validation and committed PR requirements.
Only the requested live E2E workflow can establish live E2E results; local tests cannot substitute.

## Finish the Requested Work

Review the diff against the deletion evidence. Report removed categories, retained contracts, checks
actually run, coverage changes or measurement limits, and unresolved candidates.
Count production, tests, test support, and guidance changes separately with `git diff --numstat`.
For a broad audit, continue through the requested scope; identify any unaudited area explicitly.
Continue to `nemoclaw-contributor-create-pr` only when publication is part of the user's request.
