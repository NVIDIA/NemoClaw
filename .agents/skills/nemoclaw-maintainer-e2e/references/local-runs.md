<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Local E2E Runs

Run live E2E from the checkout whose source you want to test. Use the current
checkout for working-tree content. Use a detached worktree for a commit.

Local execution does not reproduce the complete GitHub E2E matrix. A local
aggregate run collects every `e2e-live` file, but host requirements, credentials,
target opt-ins, or unavailable services can cause individual tests to skip or fail.

## Review the Boundary

Read [Run Live E2E Locally](../../../../test/e2e/docs/README.md#run-live-e2e-locally)
before execution. Review the selected test's environment requirements and cleanup
contract. Live tests can install software and mutate Docker, OpenShell, sandbox,
and external-service state.

## Run Working-Tree Content

Run one test file:

```bash
npm run test:live-e2e -- \
  test/e2e/live/<name>.test.ts \
  -t '<test-name-regex>' \
  --silent=false --reporter=default
```

The command deletes and rebuilds `dist/` from tracked and untracked source inputs
in the current checkout. It deletes direct edits under generated `dist/` and
`nemoclaw/runner-dist/` paths. It then runs only the selected test file.

Omit the file argument to collect all locally eligible live test files:

```bash
npm run test:live-e2e -- --silent=false --reporter=default
```

This aggregate tests `HEAD` only when `git status --short` is empty. Otherwise,
it tests working-tree source.

## Run a Commit

Resolve the commit and create a detached worktree without changing the current
checkout:

```bash
SHA='<commit-sha>'
COMMIT="$(git rev-parse --verify "${SHA}^{commit}")"
WORKTREE="$(mktemp -d -t nemoclaw-e2e-XXXXXXXX)"
rmdir "$WORKTREE"
git worktree add --detach "$WORKTREE" "$COMMIT"
```

Prepare and run the detached checkout:

```bash
cd "$WORKTREE"
npm run dev:setup
NEMOCLAW_E2E_EXPECTED_SHA="$COMMIT" npm run test:live-e2e -- \
  test/e2e/live/<name>.test.ts \
  -t '<test-name-regex>' \
  --silent=false --reporter=default
```

Omit `-t` to run the complete file. Omit the file argument for the aggregate
local run. Record the resolved `COMMIT` in the result.
`NEMOCLAW_E2E_EXPECTED_SHA` checks identity; it does not select or clean a
checkout. Never set it in a dirty checkout to claim that only that commit ran.

After the run, remove external resources that cleanup left behind. Preserve any
needed artifacts. Then return to the primary checkout and remove the worktree:

```bash
cd -
git worktree remove "$WORKTREE"
```

## Report the Result

Return:

- whether the run used working-tree content or a commit;
- the test file, or state that the aggregate local command ran;
- the resolved commit when applicable;
- the command result; and
- any retained resources or required cleanup.

Do not describe a local aggregate run as GitHub full E2E or release qualification.
