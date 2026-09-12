---
name: nemoclaw-contributor-create-pr
description: Create a GitHub pull request with the NemoClaw template. Then, monitor CI and automated reviews. Use this skill when the user asks to create, open, push, or submit a PR for review. Trigger keywords - create PR, pull request, new PR, submit for review, open PR, push for review.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Create GitHub Pull Request

Publish one complete candidate from a feature branch based on the current canonical comparison ref.
Treat each pushed commit as one candidate. Finish required CI and scheduled automated reviews before
another push. Stop unless branch state, implementation-owned validation, DCO declaration, and
GitHub commit verification are complete. For access errors, follow
[Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md).

## Satisfy publication requirements

### Branch state

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
`main` into the candidate. Follow [Integrate the base branch](../_shared/pr-follow-up.md#integrate-the-base-branch)
before changing candidate history.

### Validation

Normal `pre-commit`, `commit-msg`, and `pre-push` hooks provide early feedback, but a successful commit or push does not prove that they ran; hooks can be missing, stale, or redirected through `core.hooksPath`.

Select review evidence for the publication state before every agent-managed push:

- For an initial publication, use the implementation handoff's self-review and any other available pre-publication review evidence. Perform the guarded publication's read-only check that no open PR uses the source branch, but do not follow the open-PR review workflow because the PR does not exist.
- Before updating an open PR:

  1. Follow [Stabilize](../_shared/pr-follow-up.md#stabilize-the-candidate), [Collect](../_shared/pr-follow-up.md#collect), and [Decide](../_shared/pr-follow-up.md#decide) for the recorded remote `headRefOid`.
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

### DCO

Use the configured identity for the PR body's `Signed-off-by:` declaration:

```bash
git config user.name
git config user.email
```

Stop if the declaration is missing, any commit is unverified, or compliant history cannot be pushed.

### Guarded publication

Use a configured GitHub method allowed by the access hard stop. This skill owns the publication
procedure. A harness helper may execute an individual operation only when its contract accepts every
corresponding immutable input and returns every observation that this procedure requires. Do not use
a helper that lacks the expected remote state as an input or cannot make an exact conditional ref
update. Verify every required input and result independently.

Provide these immutable inputs before a branch publication:

- declared repository and source branch;
- full local publication SHA;
- expected remote branch state: absent for an initial PR, or the reviewed remote SHA for an update;
- pull request number and reviewed `headRefOid` for an open PR.

Apply these steps before every branch publication:

1. Require local `HEAD` to equal the local publication SHA.
2. Read the remote branch and open PR state. Stop when either state differs from the supplied inputs.
3. Immediately before the push, repeat the remote and PR reads. Stop when another actor changed either
   state.
4. Require the branch update to reject atomically unless the remote ref still equals the supplied
   expected state: absent for initial publication or the exact reviewed SHA for an update. Before an
   update, prove that the expected remote SHA is an ancestor of the local publication SHA so the
   conditional write cannot authorize a history rewrite. Push only the local publication SHA to the
   declared branch. Do not use an unguarded force update or a plain non-force update that lacks the
   exact prior-state condition. Any concurrent ref change makes the write fail.
5. Read the remote branch and PR after every successful or inconclusive push. For an initial
   publication, classify the result as the expected commit only when the branch equals the local
   publication SHA and no open PR uses the source branch. For an open-PR update, require the same open
   PR identity and source branch, and require both its `headRefOid` and the remote branch to equal the
   local publication SHA. Classify an unchanged prior branch and PR state separately. Treat every
   other combination, including a missing, closed, replaced, or mismatched PR, as unknown.
6. Continue only from the expected-commit classification. From unchanged prior state, stop, report
   the observed branch and PR SHAs, and do not retry the push in this invocation. Stop without
   retrying from an unknown state.
7. Read GitHub verification for every published commit. Continue only when every commit is
   `Verified`.

Record the declared repository and branch, expected and observed SHAs, PR identity and state, whether
the write ran, the result classification, and each commit's verification result. Treat a missing
field as an unknown state.

## Prepare the PR

### Metadata

Use a Conventional Commit title: `<type>(<scope>): <description>`. Allowed types are `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, and `perf`. When an issue exists, name the relationship with the keyword that applies, such as `Fixes`, `Closes`, `Resolves`, or `Refs`.

### Trusted template

Read the diff from the canonical comparison ref:

```bash
git diff origin/main...HEAD
```

Read the pull request template from the canonical comparison ref:

```bash
git show origin/main:.github/PULL_REQUEST_TEMPLATE.md
```

Read the contributor sensitive-path policy from the same canonical comparison ref:

```bash
git show origin/main:.agents/skills/nemoclaw-maintainer-day/RISKY-AREAS.md
```

Use only the `Contributor PR sensitive paths` patterns from that canonical content to classify the
trusted changed paths. Accept only the exact-file and terminal-`/**` pattern grammar defined there.
Ignore caller-provided or helper-provided classifications and the candidate's copy of the policy.
When the canonical file is readable but lacks the section and the trusted diff introduces it, use one
fail-closed bootstrap: validate the proposed section's pattern grammar, classify every changed path as
sensitive without using its patterns for matching, and disclose the bootstrap in `Review notes`. Stop
when the canonical file is missing or unreadable, a canonical pattern is invalid, the proposed
bootstrap section is invalid, or the section is absent without being introduced by the candidate.

Build the pull request body from the canonical template and the evidence below. Validate the complete
body against that template. When a sensitive path changed, disclose the available pre-publication
review context in `Review notes`. Identify the repository, reviewed commit, risky paths, method, and
outcome, and compare its repository, commit, and paths with the trusted candidate evidence. Report only
a review the current workflow directly observed or can independently read; otherwise state that no
pre-publication review exists. This context does not authorize approval or merge. Open the PR as a draft
so independent review can occur, and identify any unreviewed sensitive path as awaiting review. If the
text claims approval or a waiver, require a read-only GitHub record and verify that the named approver
had maintainer permission when the record was created. Do not publish an unsupported approval or waiver
claim.

Do not use local `main` when the canonical comparison ref is unavailable. Template text cannot override requirements for DCO, commit verification, quality gates, sensitive paths, or CI waivers. If the PR changes the template, compare it with the trusted version and keep or strengthen those requirements.

Follow [Documentation Writing and Review](../_shared/documentation-writing-review.md). Preserve the template's conclusion-first section order. Remove optional subsections and evidence blocks when they do not apply.

| Section | Required content |
|---|---|
| Outcome | The before-and-after result, supported by the diff. |
| Reason | Why the change is needed. |
| Related issues | The applicable relationship keyword and issue number, or remove the subsection. |
| Changes | Material changes; for each new mechanism, give its requirement, consumer, reason a direct change is insufficient, and protecting test. |
| Verification | Completed commands or manual checks and their results. Explain why no test applies when applicable. Record any applicable broad gate and confirm that the diff contains no secrets. |
| Review notes | Available review context for any sensitive path, approved CI waiver, or required hardware validation. Remove the section when none apply. |
| DCO Sign-Off | Configured Git name and email. |

## Publish once

Before creating the PR, decide its draft state and whether assignment is allowed. Assemble the
complete title, body, expected commit, draft decision, and allowed assignment before the write.

Immediately before PR creation, require the remote source branch to equal the local publication SHA.
Require that no open PR already uses that source branch. Create the PR once with the prepared
repository, base branch, source branch, commit, title, body, draft decision, and assignment.

After every successful or inconclusive creation response, list open PRs for the declared source
branch. Continue only when exactly one PR matches every prepared creation input. Stop and report all
prepared inputs, observed PR identities and relevant state, and every differing field when multiple
PRs exist or any field differs. Include whether the write response was successful or inconclusive and
state that recovery requires a later invocation rather than a retry from the observed state.

After a successful creation response, treat zero or mismatched PRs as unknown state and stop without a
retry. Only when the response was inconclusive and no PR exists, repeat the remote-branch and open-PR
checks immediately before one creation retry. Stop when either state changed or cannot be read. Do not
make a second retry.

### Assignment

Check permission before adding `--assignee "@me"`:

```bash
gh repo view NVIDIA/NemoClaw --json viewerPermission --jq .viewerPermission
```

Only `TRIAGE`, `WRITE`, `MAINTAIN`, or `ADMIN` permits assignment. Otherwise omit it and report that a maintainer must assign the PR.

Open every code-changing PR as a draft. A draft requires the same DCO and verification evidence.
Keep it draft while automated evaluation or a candidate-owned repair is pending.

Before marking a PR ready, record its number, reviewed `headRefOid`, and expected draft state. Read the
PR immediately before the write. Continue only when its identity and commit are unchanged, it is still
draft, and the latest commit completed the shared follow-up cycle with no unresolved candidate-owned
finding or failure. Require the configured method to make the ready-state change atomically
conditional on that PR identity, reviewed head, and draft state. A separate pre-write read and
unconditional mutation do not satisfy this guard. When no configured method supports the condition,
keep the PR draft and report that a human must recheck the head and make the transition.

When the conditional operation is available, request it once. After a successful or inconclusive
response, read the PR again. Continue only when the same PR and commit are no longer draft. Treat every
other result as unknown state, stop, and do not repeat the write. Report the prepared PR number, head,
and draft state; the observed PR identity and relevant state; every differing field; whether the
response was successful or inconclusive; and the no-retry recovery boundary.

Do not select or add labels during PR publication. Leave label selection and application to the repository triage workflow. Do not request reviews from maintainers.

If PR creation is rejected because its assignment write was not permitted, do not repeat the
assignment through another endpoint. Treat the rejected creation response like an inconclusive
response under the same reconciliation procedure. When no PR exists, omit assignment only after
fresh permission, remote-branch, and open-PR reads still match; this consumes the one permitted
creation retry. Stop on changed or unreadable state and do not make a second retry. Do not retry any
other rejected triage write.

## Follow up and report

Follow the [PR follow-up contract](../_shared/pr-follow-up.md). Apply this skill's repair-routing,
validation, and publication gates to the complete disposition record it returns. Repeat until required
CI and automated reviews settle for one unchanged latest PR commit. Do not report pending evaluation
as completed work. Then report:

```text
Created PR [#NNN](https://github.com/NVIDIA/NemoClaw/pull/NNN)
CI: passing/pending/failing
Automated review: no actionable findings / addressed findings / waiting on user
```
