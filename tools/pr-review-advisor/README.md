<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# PR Review Advisor

The PR Review Advisor is an SDK-powered, NemoClaw-specific pull request reviewer. It runs its
model-backed analysis in OpenShell sandboxes from trusted GitHub Actions jobs and inspects PRs as
read-only data. It posts a sticky comment that links to the complete specialist reviews in the
workflow run.

For each configured pull-request event, it runs every specialist prompt in `tools/pr-review-advisor/specialists`. Each prompt owns a distinct review concern and defines its purpose, investigation method, evidence expectations, and finding threshold.

Specialists inspect their assigned concern and recommend the smallest direct correction. They run independently and publish separate reports. The advisor does not select, aggregate, or summarize their findings.

It intentionally does not report GitHub mergeability, branch protection, CI status, reviewer state, CodeRabbit state, or E2E pass/fail status; those are handled elsewhere in the PR UI.

## Workflow

`.github/workflows/pr-review-advisor.yaml`:

1. Runs on `pull_request_target` for internal and fork PRs, plus trusted manual dispatch.
2. Prepares the target PR as inert analysis data and executes the trusted Advisor entrypoint from the workflow checkout.
3. Runs model analysis inside OpenShell. The sandbox receives neither a GitHub token nor the upstream model credential.
4. Runs one required Pi session for each valid Markdown prompt in `tools/pr-review-advisor/specialists`. Each specialist reads repository evidence and records a native session trace.
5. Each specialist publishes its complete Markdown review as the job summary and uploads the Markdown and native session trace as one artifact.
6. After every specialist completes successfully, one publisher attempts to post a sticky comment that links to the workflow run. A failed specialist keeps the workflow failed and suppresses publication.

`investigate-turn.mts` owns the shared investigation turn and deterministic context contract. `specialist-tools.mts` owns specialist tool policy and implementations. `specialists.mts` applies each specialist prompt and tool policy. `trusted-guidance.mts` owns the system prompt and checked-in review guidance. `turn-context.mts` and the context modules build bounded deterministic evidence. `run-specialist.mts` composes these modules and writes each specialist's Markdown review and native session trace.

`tools/pr-review-advisor/specialist-lifecycle.mts` owns the advisor-specific prepare, configure,
complete, and cleanup sequence. `tools/pr-review-advisor/openshell.mts` exports its OpenShell
primitives and exposes only sandbox runtime initialization as a CLI command. Both use the shared
lifecycle and credential-boundary helpers in `tools/openshell-agent/runtime.mts`, which are also
used by the merge-conflict fixer.

Provider failures, timeouts, and missing specialist artifacts fail closed. Workflow logs retain orchestration diagnostics.

The workflow is advisory and must not be configured as an E2E-required status check. Its comment
links to the specialist reviews and does not dispatch or report pass/fail for E2E jobs.
Model availability must not become the authority
for whether a pull request can merge.
For PRs from this repository, the PR E2E controller separately rebuilds the plan from GitHub's
changed-file list and dispatches every selected job after `CI / Pull Request` completes. `E2E / PR
Gate` does not consume advisor output.

Required-check status is point-in-time context, not a settled-CI gate. Earlier
`PR_REVIEW_ADVISOR_WAIT_*` workflow variables were inert and have been removed; any future waiting
behavior must be implemented and tested before the workflow claims to provide it.

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
- A separate trusted host step collects deterministic GitHub context with `github.token` and writes a bounded, identity-checked context file before model work. The sandbox receives that file, not the token.
- The OpenShell gateway binds only to loopback and holds the upstream provider credential. The sandbox uses `https://inference.local/v1` with an inert SDK key, and receives neither the provider credential nor a GitHub token.
- The separate publisher has pull-request write permission, but receives neither the model secret, specialist artifacts, nor the untrusted PR worktree. It rechecks the latest PR commit immediately before posting only the workflow-run link.
- Sticky publication updates only a marker-bearing comment owned by `github-actions[bot]`; a user-authored marker cannot claim the update target. Publication errors remain visible in the publisher logs.
- The workflow posts advisory comments only; it does not approve, request changes, merge, push, label, or dispatch E2E.
- The checked-in risk plan is deterministic and additive. PR Review Advisor reviews every listed invariant and required job for missing evidence. The PR E2E controller separately dispatches every listed job without consuming advisor output.

Risk plan version 20 selects the `gateway-topology` family for the production paths in the canonical `GATEWAY_TOPOLOGY_FILES` inventory in `tools/advisors/risk-plan.mts`.

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

Each specialist artifact contains a Markdown review and Pi's unchanged native JSONL session. The
workflow run also displays each Markdown review as a job summary. Replace `<interest>` with the
specialist interest and `<attempt>` with the workflow run attempt number, then download the artifact
with `gh run download <run-id> --name pr-review-specialist-<interest>-<attempt>`.

The publisher has the only pull-request write permission. It receives neither the model credential
nor the specialist artifacts. It posts only the workflow-run link.

## Local run

From a prepared contributor checkout, run:

```bash
npm run review:local
```

The command snapshots the committed branch delta from `origin/main`, staged and unstaged final
content, and nonignored untracked files. It runs every checked-in specialist separately through
OpenShell. It writes each specialist's Markdown review and native JSONL session under
`artifacts/pr-review-advisor-local/`. The command does not run tests, inspect CI state, use GitHub
context, or combine findings. Test recommendations are advisory targets verified against the
repository inventory, not executed test results.

Prerequisites:

- Node.js 22.19.0 or newer and npm registry access for the dependencies locked on `origin/main`;
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

## Output contract

Each specialist returns a Markdown review grounded in repository evidence and shared trusted
guidance. No component combines findings or makes merge decisions. Specialist reviews are advisory.
They do not replace required human review or change repository merge gates.
