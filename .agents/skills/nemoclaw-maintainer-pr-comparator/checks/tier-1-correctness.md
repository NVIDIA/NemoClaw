# Tier 1 — Correctness Checks

Six 1%-clever LLM judgments. Each catches a failure mode CI cannot see. Score: pass = 1, yellow = 0.5, fail = 0; weight 2.0× per check. Every judgment must carry file:line evidence.

## Contents

- 1.1 Test exercises bug path
- 1.2 Comment-as-spec coverage
- 1.3 Negative test coverage
- 1.4 Coverage shape
- 1.5 Refactor-vs-behavior scan
- 1.6 Mocking purity

## 1.1 Test exercises bug path

The PR's new/modified test must, when run on the pre-fix code, fail. A test that passes both before and after the fix proves nothing.

**How to evaluate:** Read each new test in the diff. For each assertion, ask: "Would this assertion have held on the pre-fix code?" If yes, the test doesn't exercise the bug.

**Common false-positive patterns to flag as yellow:**

- Test calls the function but only asserts "no exception thrown"
- Test asserts on output that's unrelated to the bug
- Test mocks the very behavior the bug was in

**Evidence to record:** Diff line of the assertion + the bug's pre-fix behavior + reasoning that the assertion would have failed pre-fix.

## 1.2 Comment-as-spec coverage

Acceptance criteria come from the issue body **and every comment**. Commenters often add asks the body doesn't capture: "and don't break Y while you're at it." All asks must map to a fix or test in the diff.

**How to evaluate:** From the issue's parsed criteria checklist (Step 1 of the workflow), check each item against:

- Files changed in the diff
- New tests in the diff
- PR body's "Changes" section

**Yellow if:** Some criteria are addressed but one or two are missing without explanation.
**Fail if:** Half or more criteria are unaddressed.

## 1.3 Negative test coverage

The fix must have tests for invalid/edge inputs, not just the happy path that matches the reported bug.

**Look for assertions on:**

- Empty / null / undefined inputs
- Boundaries (0, max, min, off-by-one)
- Type confusion (string where number expected)
- Malformed input
- Whitespace-only / non-ASCII / unicode

**Adapt for the input domain:** A Dockerfile change needs different "negative cases" than an HTTP handler. For infrastructure changes, package-presence assertions and version-pin assertions count.

**Yellow if** only happy-path is tested. **Fail if** the bug class has obvious negative cases and none are covered.

## 1.4 Coverage shape

Every new code path in the diff has a test. Standard coverage % does not catch this — coverage can stay flat while new branches are untested if they're hit incidentally by unrelated tests.

**How to evaluate:** For each new branch (`if`, `else`, `try`/`catch`, `switch` arm) in the diff, find a test that exercises that branch specifically. A new `else` branch with no test is a yellow.

## 1.5 Refactor-vs-behavior scan

If the PR's title or description claims `refactor` / `rename` / `extract` / `move`, the diff must be net-zero in:

- Conditional adds (`if(`, `?`, `&&`, `||`)
- New `throw new Error(`
- Changed `process.exit(` codes
- Changed return values

**How to evaluate:** Run a count over the diff for these tokens. Net-zero is normal — code moves around. Net-positive in any of these = hidden behavior change inside what claims to be a refactor → yellow or fail depending on magnitude.

**Why this catches real bugs:** Authors sometimes "fix while refactoring" without flagging it. The fix may be correct, but landing it as a refactor bypasses the review attention a behavior change would get.

## 1.6 Mocking purity

Tests must isolate **external** dependencies (network, filesystem, time, randomness, third-party APIs), not replace the **unit under test**. If a test for `validateInput()` mocks `validateInput()` itself, the test proves nothing.

**How to evaluate:** Read each new test's mock setup. For each mock, ask: "Is this mock replacing an external dependency, or is it replacing the function this test is supposed to verify?" If the latter, fail.

**Common red flags:**

- Mocking the function whose name appears in the test description
- Mocking a function and asserting only that the mock was called (without verifying the calling code's logic)
- Mocking deep into the unit under test's call graph rather than at the external boundary
