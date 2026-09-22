<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Publish the Branch and PR

## Select the source repository

Choose the source repository before declaring the immutable publication inputs or writing a branch.
Do not default to a fork merely because it is the usual contributor location.

Read the canonical base copies of the pull-request workflows. Treat manual PR E2E applicability and
selector choice as immutable publication inputs owned by the explicit authorized task. Do not infer
that manual E2E is required from advisory recommendations, an implementation handoff, or the
publication skill itself. When the authorized task does not require manual PR E2E, it is not a
publication requirement. For required manual PR E2E, read its canonical contract. Use the trusted
diff, the task-owned applicability input, and those canonical rules to determine whether every
required CI and E2E path supports a fork head. In particular:

- a candidate whose required reviewed OpenShell SDK package job rejects a non-canonical head must use
  a branch in `NVIDIA/NemoClaw`;
- a PR that requires the manual PR E2E workflow must use a branch in `NVIDIA/NemoClaw` unless the
  canonical contract explicitly supports another source repository.

Treat this as a pre-publication hard stop. If any required path is same-repository-only:

1. Read `viewerPermission` for `NVIDIA/NemoClaw`. Use a same-repository source branch only when the
   authenticated actor has `WRITE`, `MAINTAIN`, or `ADMIN` and the requested task authorizes the
   repository branch write.
2. Otherwise stop before pushing or creating a PR. Name the exact required path and request adoption
   or publication by a maintainer with repository branch-write authority. Name an individual only when
   the task or checked-in repository evidence identifies that maintainer. Do not create a fork PR that
   cannot complete its required gates and do not describe its known failure as pending evidence.

When all required paths support fork heads, use the declared authorized fork. Record the selected
source repository, the canonical rule that permits it, and the permission observation with the other
publication inputs. Re-read the relevant source-repository identity immediately before the branch
write and PR creation.

An existing PR cannot change its head repository. If this gate discovers that an open fork PR must be
same-repository, do not rerun the impossible check or silently create a duplicate. Report the invalid
source choice and obtain explicit authorization before closing and replacing the PR.

## Guarded publication

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

Follow [Documentation Writing and Review](../../_shared/documentation-writing-review.md). Preserve the template's conclusion-first section order. Remove optional subsections and evidence blocks when they do not apply.

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
Use `prepare_pr_for_human_review` only after the latest PR commit completes the shared follow-up cycle
with no unresolved candidate-owned finding or failure.

Do not select or add labels during PR publication. Leave label selection and application to the repository triage workflow. Do not request reviews from maintainers.

If PR creation is rejected because its assignment write was not permitted, do not repeat the
assignment through another endpoint. Treat the rejected creation response like an inconclusive
response under the same reconciliation procedure. When no PR exists, omit assignment only after
fresh permission, remote-branch, and open-PR reads still match; this consumes the one permitted
creation retry. Stop on changed or unreadable state and do not make a second retry. Do not retry any
other rejected triage write.
