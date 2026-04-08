# Test Gaps Workflow

Close the highest-value test gaps without turning the task into a rewrite.

For risky code areas, see [RISKY-AREAS.md](RISKY-AREAS.md).

## Step 1: Collect File Set

Sources: files changed in target PR, recent failing CI, `main` churn in hotspot area, hotspot list in state file. If unknown, derive from highest-ranked actionable PRs.

## Step 2: Map to Existing Tests

Repo conventions:

- Root integration tests (`test/`): ESM imports
- Plugin tests: co-located as `*.test.ts`
- Shell logic: may need extraction into testable helper first

For each risky file: is there a test covering the changed behavior? Is it too indirect or flaky? Can a small extraction improve testability?

## Step 3: Choose Highest-Value Tests

Prefer tests that catch regressions the maintainer loop actually sees:

- invalid/boundary env values, shell quoting, retry/timeout behavior
- missing/malformed config, denied network/policy paths
- duplicate workflow/hook behavior, version/tag/DCO edge cases
- unauthorized or unsafe inputs

Include at least one negative-path test for risky code.

## Step 4: Extract Narrow Seams If Needed

Smallest extraction that improves testability: move parsing into a pure helper, separate construction from execution, factor hook logic into a reusable function, replace bags of primitives with typed helpers.

Do not broad-refactor under the label of "adding tests."

## Step 5: Add Tests

- CLI tests → `test/`
- Plugin tests → `nemoclaw/src/`
- TypeScript helpers → TypeScript tests
- Mock external systems; no real API calls in unit tests
- Security paths: prove the unsafe action is denied, not just that happy path works

## Step 6: Validate

```bash
npm test                          # root tests
cd nemoclaw && npm test           # plugin tests
npm run typecheck:cli
make check
```

Narrowest command set that gives confidence.

## Step 7: Report Gaps Honestly

If untested risk remains, say so: no clean seam without larger refactor, too much hidden shell state, missing fixture strategy, flaky infra dependency.

## Notes

- Tests for risky code are merge readiness, not polish.
- One precise regression test beats many vague integration checks.
- If credible fix needs bigger redesign, follow [SEQUENCE-WORK.md](SEQUENCE-WORK.md).
