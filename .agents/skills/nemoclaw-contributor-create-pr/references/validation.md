<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validate a Publication

## Branch state

Read the canonical base SHA from GitHub. Fetch the canonical branch into the comparison ref. Confirm that both sources resolve to the same SHA. Then confirm a feature branch, commits to publish, and a clean tree:

```bash
nemoclaw_trusted_base_sha="$(gh api --method GET repos/NVIDIA/NemoClaw/git/ref/heads/main --jq '.object.sha')"
test -n "$nemoclaw_trusted_base_sha"
git fetch --no-tags https://github.com/NVIDIA/NemoClaw.git +refs/heads/main:refs/remotes/origin/main
nemoclaw_fetched_base_sha="$(git rev-parse --verify refs/remotes/origin/main)"
test "$nemoclaw_fetched_base_sha" = "$nemoclaw_trusted_base_sha"
git branch --show-current
git log origin/main..HEAD --oneline
git status --short
```

Every command must succeed. The `origin/main` name is a local comparison ref; it does not prove remote identity. Do not replace the canonical API endpoint or fetch URL with a checkout remote. Stop if the sources differ. Do not validate against a stale ref. Do not publish from `main` or with uncommitted changes.

This fetch refreshes read-only comparison evidence. It does not authorize merging or rebasing
`main` into the candidate. Follow [Integrate the base branch](../../_shared/pr-follow-up.md#integrate-the-base-branch)
before changing candidate history.

## Validation

Normal `pre-commit`, `commit-msg`, and `pre-push` hooks provide early feedback, but a successful commit or push does not prove that they ran; hooks can be missing, stale, or redirected through `core.hooksPath`.

Select review evidence for the publication state before every agent-managed push:

- For an initial publication, use the implementation handoff's self-review and any other available pre-publication review evidence. Perform the guarded publication's read-only check that no open PR uses the source branch, but do not follow the open-PR review workflow because the PR does not exist.
- Before updating an open PR:

  1. Follow [Stabilize](../../_shared/pr-follow-up.md#stabilize-the-candidate), [Collect](../../_shared/pr-follow-up.md#collect), and [Decide](../../_shared/pr-follow-up.md#decide) for the recorded remote `headRefOid`.
  2. Route only returned in-scope root-cause groups to `nemoclaw-contributor-implement-issue` with their returned scope records.
  3. Inspect the returned change and test evidence because the shared contract cannot repair, validate, commit, or push.
  4. Create one local repair commit and record it as the expected publication SHA.
  5. Mark each accepted repair group resolved by the inspected local repair, subject to trusted validation.
  6. Reread `headRefOid` before the canonical base fetch and restart collection only when it differs from the reviewed remote SHA.
  7. Do not push while the original collection is pending, a finding is unclassified, an accepted group lacks an inspected repair, or validation is unresolved.
  8. Immediately before publication, require the remote `headRefOid` to equal the reviewed remote SHA.
  9. Require the push tool's expected commit to equal the local publication SHA.

  Do not repeat collection or classification of the unchanged remote candidate after an inspected
  implementation repair. The reviewed remote SHA is now only the competing-update guard. A local
  repair commit does not violate that guard. An unrelated remote update does.

After the applicable review step, repeat every canonical base read, fetch, and comparison command in Branch state immediately before each validation attempt.

Confirm that the complete validation execution surface is byte-for-byte identical with the canonical comparison ref:

- validation command and hook configuration;
- package manifests, lockfiles, and package-manager configuration;
- transitively loaded repository-local helpers and configuration;
- resolved validator executables.

Do not infer executable identity from a package name or version. Do not use a branch-defined validator as independent evidence. If any surface differs, is unavailable, or cannot be traced, do not execute the candidate validator or publish. Report the path or executable and canonical base SHA.

Confirm that the installed pre-push hook is available. Then use a normal `git push`; do not use `--no-verify`. The hook prepares build artifacts and runs the publication checks once. Do not run a separate `npm run validate:pr` before the push. If the hook is missing or stale, stop and repair the contributor setup before publication.

Do not push when publication validation fails or is inconclusive. Complete formatting and generation before the final commit; publication validation checks tracked files without applying fixes. If validation reports a required change, repair it, commit it, inspect the new diff, refresh the trusted base, and push again. For an open PR, preserve the completed disposition record for the unchanged remote candidate and review the local repair without recollecting that remote candidate.

The shared compiler-check runner may reuse a successful local result only when the candidate and base commits, source bytes, installed dependency bytes, resolved executable, execution environment, and required generated outputs still match. Missing, unreadable, stale, or failed evidence must execute the check. A dirty worktree or external Node loader prevents reuse. This local optimization does not establish independent review, CI success, or publication authorization. Keep the trusted-validation comparison above.

Use `npm run check` for repository-wide validation changes, such as hooks, formatter configuration, generated-check scripts, or coverage baselines.

A maintainer may unblock unavailable trusted-base validation only with recorded evidence identifying the base and candidate SHAs, isolated environment, trusted validator entry point and resolved executables, exact command and result, and publication authorization. The environment must not give candidate code contributor-host credentials.

`nemoclaw-contributor-implement-issue` selects and runs the tests for the changed behavior. Record its command and result in the PR body. Do not select a test in this workflow or rerun a reported test because hooks passed. If this evidence is missing, route the change set back to that skill. Do not open the PR with an unselected tests line. For documentation-only changes, require `npm run docs` to pass before publication.

## DCO

Use the configured identity for the PR body's `Signed-off-by:` declaration:

```bash
git config user.name
git config user.email
```

Stop if the declaration is missing, any commit is unverified, or compliant history cannot be pushed.
