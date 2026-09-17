<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# PR Review Advisor

The PR Review Advisor is an SDK-powered, NemoClaw-specific pull request reviewer. It runs its
model-backed analysis in OpenShell sandboxes from trusted GitHub Actions jobs and inspects PRs as
read-only data. For automatic PR runs, it posts a sticky comment that links to the complete
specialist reviews in the workflow run. Manual dispatch does not post a PR comment.

After a required `CI / Pull Request` run whose name ends in `gate true` succeeds, it runs every specialist prompt in `tools/pr-review-advisor/specialists`. Other completed CI runs do not schedule the Advisor. Each prompt owns a distinct review concern and defines its purpose, investigation method, evidence expectations, and finding threshold.

Specialists inspect their assigned concern and recommend the smallest direct correction. They run independently and publish separate reports. The Advisor does not select or summarize their findings. A trusted aggregate gate reports only whether their blocker evidence is clear.

The first run on an unreviewed pull request is a complete assessment. After trusted human maintainers submit `CHANGES_REQUESTED` or `APPROVED` and the author pushes another commit, the next run becomes a bounded follow-up: it preserves unresolved change requests across successive reviews and reviewers as the frozen contract, reads the exact earliest-reviewed-commit-to-current-commit delta first, rechecks the contract, and inspects only affected seams. A later approval clears only that reviewer's earlier change requests; it does not discard another reviewer's unresolved blockers. A follow-up may add a blocker only when the new delta introduces it or newly available repository evidence proves a material failure that could not reasonably have been established in the frozen review. Resolved findings disappear; when the contract is resolved and no material delta regression exists, the aggregate gate becomes green so the separate maintainer workflow can perform its normal readiness check and approval.

This split is intentional. The Advisor supplies current-commit code evidence; it never approves or writes reviews. The maintainer review-request workflow owns FIFO scheduling, repository gates, idempotent GitHub writes, and the final approval.

It intentionally does not report GitHub mergeability, branch protection, CI status, reviewer state, CodeRabbit state, or E2E pass/fail status; those are handled elsewhere in the PR UI.

## Workflow

`.github/workflows/pr-review-advisor.yaml`:

1. Runs after `CI / Pull Request` completes, plus trusted manual dispatch.
2. Runs automatically only when the source workflow succeeds for a required PR revision.
3. Prepares the target PR as inert analysis data, including its unresolved trusted human review contract and an exact follow-up delta when applicable, and executes the trusted Advisor entrypoint from the workflow checkout.
4. Runs model analysis inside OpenShell. The sandbox receives neither a GitHub token nor the upstream model credential.
5. Runs one required Pi session for each valid Markdown prompt in `tools/pr-review-advisor/specialists`. Each specialist performs either the initial complete assessment or the bounded frozen-contract follow-up, reads repository evidence, and records a native session trace.
6. Each successfully completed specialist publishes its Markdown review as the job summary. Its artifact contains the Markdown, native session trace, E2E receipt, findings ledger, and shared review-queue context.
7. After every specialist completes successfully, a trusted aggregate job validates all exact-attempt finding ledgers and E2E receipts. It fails the workflow for any P0/P1 finding, unresolved E2E recommendation, or incomplete or malformed evidence.
8. For a PR-bound run, a read-only coordinator shadow consumes the same exact-head context and
   specialist evidence. It publishes only a job summary and decision artifact.
9. For automatic `workflow_run` PR runs, one publisher attempts to post a sticky comment that links to the workflow run, including after the aggregate job fails. A failed specialist suppresses publication. Manual dispatch does not run the publisher.

For a PR-bound run, `Require no Advisor blockers` is the review-request signal. Request human review only when that job is green for the latest PR commit. It is not merge authorization, and contributors must still inspect the specialist reports.

`investigate-turn.mts` owns the shared investigation turn and deterministic context contract. `specialist-tools.mts` owns specialist tool policy and implementations. `specialists.mts` applies each specialist prompt and tool policy. `trusted-guidance.mts` owns the system prompt and checked-in review guidance. `turn-context.mts` and the context modules build bounded deterministic evidence. `run-specialist.mts` composes these modules and writes each specialist's Markdown review and native session trace.

`tools/pr-review-advisor/specialist-lifecycle.mts` owns the advisor-specific prepare, configure,
complete, and cleanup sequence. `tools/pr-review-advisor/openshell.mts` exports its OpenShell
primitives and exposes only sandbox runtime initialization as a CLI command. Both use the shared
lifecycle and credential-boundary helpers in `tools/openshell-agent/runtime.mts`, which are also
used by the merge-conflict fixer.

Provider failures, timeouts, missing specialist artifacts, blocker findings, unresolved E2E recommendations, and malformed evidence fail closed. GitHub context collection has one 120-second deadline across all required API reads. A timeout or partial result prevents context artifact publication. Workflow logs retain orchestration diagnostics. Hosted failed specialist execution attempts to recover artifacts before sandbox cleanup. When the model session returns an invalid result, its artifact retains `failure.json`, `failed-analysis.txt`, and the native session when available. These files are diagnostic evidence, not completed review receipts. Recovery failure does not suppress the original error or skip cleanup.

After the trusted Advisor checkout is available, hosted specialist failures also retain `job-failure.json` with each subsequent setup and analysis step outcome plus run identity. Earlier checkout failures have workflow logs only. A PR revision that changes before checkout is classified as `superseded`; the SHA check still rejects that revision. Setup failures may have only this host receipt. No automatic infrastructure retry is added.

Findings submission requires a recorded E2E recommendation result. The bounded terminal repair can record missing E2E recommendations before submitting findings. A repair that still omits required evidence fails closed.

The workflow is advisory and must not be configured as an E2E-required status check. Its comment
links to the specialist reviews and does not dispatch or report pass/fail for E2E jobs.
Model availability must not become the authority
for whether a pull request can merge.
When a maintainer requires live E2E for a pull request, they run it explicitly through the current
[E2E workflow](../../.github/workflows/e2e.yaml) and follow the
[maintainer E2E procedure](../../.agents/skills/nemoclaw-maintainer-day/MERGE-GATE.md). Former PR E2E
check contexts remain advisory and are ignored by the merge-readiness gate.

On automatic runs, the gate accepts a successful `CI / Pull Request` run whose name ends in
`gate true`. It uses the source repository, branch, and commit to resolve one open PR through the
GitHub API. Manual dispatch does not require CI-run evidence. A PR-targeted dispatch requires both
`target_repo` and a positive `target_pr`, resolves the open PR's head and base SHAs through the
GitHub API, and requires its base branch to match `target_base`. A ref-targeted dispatch resolves
`head_ref` and `base_ref` to full SHAs in `NVIDIA/NemoClaw`. In both cases, the analysis checkout
and sandbox inputs use those resolved SHAs, so later PR or ref movement cannot change the reviewed
revision. The blocker gate rejects missing or mismatched expected SHAs.

PR-targeted manual dispatch intentionally supports both same-repository and fork PRs. GitHub limits
manual workflow dispatch to repository writers, and the fork head is handled only as inert read-only
data bound to its base and full head SHAs. The specialist job has only artifact-read permission and
no repository write permission; the model sandbox receives neither a GitHub credential nor the real
provider credential. A same-repository restriction belongs on automation that changes a contributor
branch; here it would only remove static review coverage.

## Author and agent follow-up

Authors and coding agents should follow the shared [PR CI and Review Follow-Up](../../.agents/skills/_shared/pr-follow-up.md) workflow after opening a PR or pushing follow-up commits. If SSH, authentication, remote access, authorization, or permission problems prevent reading comments or pushing fixes, follow [Git and GitHub Access Hard Stop](../../.agents/skills/_shared/git-github-hard-stop.md).

## Safety model

- Static analysis only.
- PR-provided scripts, tests, package lifecycle hooks, and build tools are never executed.
- The model session runs in a digest-pinned OpenShell sandbox under a hard-required Landlock policy with no direct network policy and no ambient workdir. Four canonical host inputs are mounted read-only through the advisor's ephemeral Docker gateway outside `/sandbox`, so OpenShell v0.0.99 applies the final immutable boundary before the first process starts. Landlock independently grants those inputs read-only access. It grants application-data writes only to a bounded runtime tmpfs; required device access remains writable under `/dev`. The sandbox pins Git to `/pr-workdir/.git` and `/pr-workdir` instead of relying on cross-UID repository discovery. A startup proof must read every input canary, resolve the checkout and `HEAD`, fail chmod, overwrite, replacement, and creation in each input, and complete runtime writes. The model-facing Advisor tools remain repository-confined and read-only; generated configuration and artifacts use the dedicated runtime subtree.
- The advisor receives repo-confined read-only repository tools plus deterministic context tools. Repository paths must remain inside the checked-out analysis workspace after lexical and symlink resolution. None of these tools can change repository or GitHub state.
- PR bodies, comments, titles, branch names, and diffs are treated as untrusted evidence, never as instructions.
- Manual target analysis validates the repository token, decimal PR number, and base-ref token before running any `git` command.
- Generated Pi configuration is written under the sandbox's runtime-only configuration directory, not uploaded artifacts.
- The review job is limited to `NVIDIA/NemoClaw` and has read-only GitHub permissions. Within it, only the trusted host provider-configuration step receives the upstream model secret.
- The gate uses a job-scoped GitHub token to read open PR identity. It receives no model credential.
- A separate trusted host step collects deterministic GitHub context with `github.token` and writes a bounded, identity-checked context file before model work. The sandbox receives that file, not the token.
- The OpenShell gateway binds only to loopback and holds the upstream provider credential. The sandbox uses `https://inference.local/v1` with an inert SDK key, and receives neither the provider credential nor a GitHub token.
- The separate publisher has pull-request write permission, but receives neither the model secret, specialist artifacts, nor the untrusted PR worktree. It rechecks the latest PR commit immediately before posting only the workflow-run link.
- Sticky publication updates only a marker-bearing comment owned by `github-actions[bot]`; a user-authored marker cannot claim the update target. Publication errors remain visible in the publisher logs.
- The workflow posts advisory comments only; it does not approve, request changes, merge, push, label, or dispatch E2E.
- The checked-in risk plan is deterministic and additive. PR Review Advisor reviews every listed invariant and required job for missing evidence, but does not dispatch jobs. Maintainers decide whether to run its recommended E2E coverage through the [separate manual E2E procedure](../../.agents/skills/nemoclaw-maintainer-day/MERGE-GATE.md).

The checked-in risk plan selects the `gateway-topology` family for the production paths in the canonical `GATEWAY_TOPOLOGY_FILES` inventory in `tools/advisors/risk-plan.mts`.

The family requires PR Review Advisor to check this invariant against the diff, sibling consumers,
and checked-in evidence:

> An explicit sandbox-visible host address must be outside the sandbox network subnet, and every
> gateway-address projection must derive from the same authority.

The family does not add an E2E job. Existing topology tests and workflows remain the behavior
authority. Documentation-only and test-only changes do not select the family.

The same risk plan maps runtime changes from these paths to the `focused-e2e` family:

- `src/lib/onboard/managed-startup/**`.
- `src/lib/onboard/sandbox-create-launch.ts`.
- `scripts/lib/entrypoint-env-wrapper.sh`.

Each match selects these focused E2E jobs:

- `device-auth-health`.
- `issue-4462-scope-upgrade-approval`.
- `openclaw-inference-switch`.

The same risk plan maps these Hermes CLI adapter paths to `focused-e2e`:

- `agents/hermes/hermes-cli-adapter-v1.json`.
- `agents/hermes/hermes-wrapper.py`.
- `agents/hermes/validate-cli-adapter.py`.

Each Hermes CLI adapter match selects these focused E2E jobs:

- `channels-stop-start`.
- `mcp-bridge`.

The same risk plan maps these Hermes cron restore paths to `focused-e2e`:

- `agents/hermes/cron-restore-control.py`.
- `agents/hermes/patch-cron-restore-drain.py`.
- `src/lib/actions/sandbox/rebuild-hermes-post-restore.ts`.
- `src/lib/actions/sandbox/runtime/hermes-cron-restore-recovery.ts`.

Each Hermes cron restore match selects `rebuild-hermes`.
The generic `src/commands/sandbox/recover.ts` adapter remains agent-neutral and does not select that job.

## Required secret

Configure this repository secret for review analysis:

- `PR_REVIEW_ADVISOR_API_KEY`

The trusted host uses this secret only to register the OpenAI-compatible
`https://inference-api.nvidia.com/v1` service with OpenShell. The sandboxed specialists reach that
provider through `https://inference.local/v1` and do not receive the secret.
The discovered specialists use the workflow-configured model and share the same credential boundary.

## Artifacts

Each successfully completed specialist artifact contains a Markdown review, Pi's unchanged native JSONL session, E2E recommendations, a findings ledger, and shared review-queue context. Failed artifacts may contain only diagnostic failure evidence and cannot satisfy the review-queue contract. See [Review queue evidence](REVIEW-QUEUE.md) for the consumer contract. The
workflow run also displays each Markdown review as a job summary. Replace `<interest>` with the
specialist interest and `<attempt>` with the workflow run attempt number, then download the artifact
with `gh run download <run-id> --name pr-review-specialist-<interest>-<attempt>`.

For a complete PR-bound run, `pr-review-coordinator-shadow-<attempt>` contains the read-only
coordinator decision in `decision.json`. The coordinator job also writes that decision to its job
summary. The artifact does not authorize a review write or approval.

The publisher has the only pull-request write permission. It receives neither the model credential
nor the specialist artifacts. It posts only the workflow-run link.

## Local run

From a prepared contributor checkout, run:

```bash
npm run review:local
```

To run the same local specialists against a directly selected exact open, non-draft GitHub pull
request:

```bash
npm run review:local -- --pr 12345
```

The repository defaults to `NVIDIA/NemoClaw`. Use `--repo OWNER/REPO` after the PR number only
when reviewing another repository.

The PR form is read-only. It does not authenticate or admit a maintainer review-request queue. It
resolves and rechecks the selected PR's live head and base, checks out the exact head in a disposable
clone, collects bounded GitHub review context, and publishes specialist artifacts back to
`artifacts/pr-review-advisor-local/`. It does not combine findings, post a review, or approve the PR.
The repository workflow's coordinator shadow consumes the same exact-head evidence and reports a
read-only decision; a human maintainer still owns any consolidated review or approval. The
disposable clone and every published artifact retain the fetched PR's real full head SHA rather than
a locally synthesized commit identity. On a later commit, unresolved trusted human change requests
become the frozen contract and the specialists inspect their exact commit delta instead of starting
over.

Without `--pr`, the command snapshots the committed branch delta from `origin/main`, staged and
unstaged final content, and nonignored untracked files. It does not use GitHub context, so this
checkout form always uses the initial complete-assessment path. Both forms run every checked-in
specialist separately through OpenShell, write each specialist's Markdown review and native JSONL
session under `artifacts/pr-review-advisor-local/`, and do not run tests, inspect CI state, or combine
findings. Test recommendations are advisory targets verified against the repository inventory, not
executed test results.

Prerequisites:

- Node.js 22.19.0 or newer and npm registry access for the dependencies locked on `origin/main`;
- for `--pr`, an authenticated GitHub CLI (`gh`) identity with read access to the target repository;
- an `origin/main` remote-tracking commit that contains the trusted local review implementation;
- a running Docker-compatible container runtime. Run `npm run dev:doctor` to verify Docker availability and resources;
- `git`, `openshell`, `openshell-gateway`, `openshell-sandbox`, `rg`, and `fdfind` available on `PATH`;
- `PR_REVIEW_ADVISOR_API_KEY` exported in the host environment for the existing advisor provider.
  The local gateway receives this credential. The sandbox does not receive it. The variable remains
  in the caller environment until you clear it. The command attempts to remove the local gateway after
  the run. If cleanup fails, it reports the remaining resource; remove that resource before retrying.

`npm run dev:doctor` checks general contributor readiness. It does not check these local-review
executables, the advisor credential, or the `origin/main` ref.

Running the npm script trusts the contributor checkout's `package.json` entry and built-in-only bootstrap.
After that narrow entry boundary, the executable advisor checkout is detached at the resolved
`origin/main` commit. Other branch changes to tracked files, including advisor implementation,
policy, and specialist prompts, exist only in the read-only review snapshot. Ignored files, including
the contributor checkout's `node_modules`, are excluded. Before it reads the advisor credential or
starts the implementation, the built-in-only bootstrap runs `npm ci --ignore-scripts --no-audit
--no-fund` in the trusted checkout. Those separately installed dependencies are the only
`node_modules` used for execution. npm uses the committed `origin/main` lockfile, normal
cache behavior, and a credential-free environment with user and global npm configuration disabled.
Failure stops the run before the credential-bearing advisor lifecycle starts.

The command attempts to remove its temporary snapshot, trusted dependencies, gateway, and each
sandbox after success, failure, or a handled termination signal. It reports cleanup failures with the
remaining resource name or path. Remove that named resource before retrying.

Each locally owned gateway uses an in-memory database. Its provider records are discarded when the
gateway process stops. The local runner ignores inherited
database URLs for its gateway; it does not read or replace an existing gateway database.

## Output contract

Each successfully completed specialist returns a Markdown review grounded in repository evidence and shared trusted
guidance. No component combines findings or makes merge decisions. Specialist reviews are advisory.
They do not replace required human review or change repository merge gates.

Each specialist also records all additional E2E recommendations through a validated tool.
The receipt preserves the deterministic floor, optional coverage, explicit empty decisions, and unresolved coverage.
The [review queue contract](REVIEW-QUEUE.md) defines discovery, identity, dispatch, and result rules for read-only consumers.
