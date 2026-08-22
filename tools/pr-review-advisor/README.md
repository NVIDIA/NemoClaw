<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# PR Review Advisor

The PR Review Advisor is an SDK-powered, NemoClaw-specific pull request reviewer. It runs its
model-backed analysis in an OpenShell sandbox from a trusted GitHub Actions job, inspects PRs as
read-only data, and posts a sticky comment with blockers, warnings, and suggestions. Artifacts
retain acceptance coverage, security notes, and other review context.

It complements the existing PR surfaces by keeping a NemoClaw maintainer code-review lens focused on the patch itself and by including E2E coverage and target guidance in the same model session:

- sandbox and workflow security review;
- acceptance coverage for observable outcomes, current constraints and non-goals, supported
  contracts, and explicit maintainer decisions in linked issues. Proposed designs, implementation
  ideas, and ordinary discussion remain context; `Refs #...`, `References #...`, and
  `Follow-up to #...` relations do not make an entire issue binding;
- codebase drift and architecture review grounded in current behavior and contracts;
- source-of-truth review for fallback, recovery, tolerant parsing, monkeypatching, and other localized workaround behavior;
- static test-inventory context from changed test files and nearby test names;
- a complete simplicity sweep that considers the changed code and its surrounding area, including
  safe deletion, consolidation, existing or new patterns, and neutral or negative net-line outcomes.
  Present design defects can block when checked-in evidence shows duplicated ownership, unnecessary
  machinery, substantial repeated setup, widened dependencies, or unrelated churn and the review
  provides a concrete behavior-preserving reduction. The reduction case covers source and tests
  together, defaults to a negative total line outcome, and may be line-neutral only when it
  materially reduces owners, concepts, invalid combinations, or dependency width;
- semantic terminology review for terms that changed explanatory text introduces, expands, or
  redefines, with repository evidence for each model-selected candidate;
- E2E coverage, job, target, and fan-out selections normalized against the checked-in
  deterministic plan and supported inventory;
- correctness and test-quality checks that CI cannot prove.

It intentionally does not report GitHub mergeability, branch protection, CI status, reviewer state, CodeRabbit state, or E2E pass/fail status; those are handled elsewhere in the PR UI.

## Workflow

`.github/workflows/pr-review-advisor.yaml`:

1. Runs on `pull_request_target` for internal and fork PRs, plus trusted manual dispatch.
2. Prepares the target PR as inert analysis data and executes the trusted Advisor entrypoint from the workflow checkout.
3. Runs model analysis inside OpenShell. The sandbox receives neither a GitHub token nor the upstream model credential.
4. Opens one Pi session per model lane and performs exactly two normal turns.
5. The `investigate` turn has repo-confined `read`, `grep`, `find`, and `ls` tools, deterministic PR context tools, and trusted terminology tracing. It examines scope, architecture and simplicity, terminology, correctness, acceptance, source-of-truth behavior, all security categories, tests, CI and operations, E2E coverage, positives, and limitations in one coherent pass.
6. The `challenge-and-record` turn keeps repository reads and adds `record_findings`, `record_review_receipt`, `recommend_e2e`, and `submit_review`. The first three replace complete in-memory draft sections. They do not update canonical state.
7. `submit_review` validates the complete draft, deterministic E2E floors and allowlists, terminology trace bindings, finding references, and the public result schema. A successful call validates and assembles pending state, then ends the turn. The session runner atomically commits that state only after accepting the complete terminal flow. Failed validation does not mutate canonical state. The `challenge-and-record` turn permits one bounded repair: it accepts one failed call followed by one successful call in the same SDK response, or, if the failed call settles the response, one tool-only continuation. Omission, provider failure, unsettled calls, extra attempts, or activity after success fail closed and discard pending state.
8. Trusted code writes the session transcript, result, and summary artifacts. The trusted publisher posts only validated artifacts for the same pull request commit.
9. The primary GPT-5.6 Terra lane publishes the sticky comment. The Nemotron Ultra lane remains an artifact-only evaluation lane.
    The evaluation lane does not publish another review.

`investigate-turn.mts` and `challenge-and-record-turn.mts` own the two normal turn contracts, including their prompts and tool configuration. `trusted-guidance.mts` owns the system prompt and checked-in review guidance. `turn-context.mts` and the context modules build bounded deterministic evidence. `artifacts.mts` owns artifact paths, and `render-result.mts` owns human-readable result output. `analyze.mts` composes these modules and runs the session.

`tools/pr-review-advisor/openshell.mts` owns the advisor-specific prepare, create, run, download, and
cleanup sequence. It uses the shared lifecycle and credential-boundary helpers in
`tools/openshell-agent/runtime.mts`, which are also used by the merge-conflict fixer.

Provider failures, timeouts, and invalid or missing atomic submission fail closed and leave canonical state unchanged. Failure results retain the reason, and workflow logs retain orchestration diagnostics.

The workflow is advisory and must not be configured as an E2E-required status check. Its combined
comment lists trusted E2E recommendations, but does not dispatch or report pass/fail for E2E jobs.
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
- The advisor receives repo-confined read-only repository tools plus deterministic context tools. Repository paths must remain inside the checked-out analysis workspace after lexical and symlink resolution. The record tools replace transaction-local draft sections only; an accepted successful terminal submission atomically commits canonical finding and terminology snapshots; failed validation and rejected terminal flows do not mutate them. None of these tools can change repository or GitHub state.
- PR bodies, comments, titles, branch names, and diffs are treated as untrusted evidence, never as instructions.
- Manual target analysis validates the repository token, decimal PR number, and base-ref token before running any `git` command.
- Generated Pi configuration is written under the sandbox's runtime-only configuration directory, not uploaded artifacts.
- The review job is limited to `NVIDIA/NemoClaw` and has read-only GitHub permissions. Within it, only the trusted host provider-configuration step receives the upstream model secret.
- A separate trusted host step collects deterministic GitHub context with `github.token` and writes a bounded, identity-checked context file before model work. The sandbox receives that file, not the token.
- The OpenShell gateway binds only to loopback and holds the upstream provider credential. The sandbox uses `https://inference.local/v1` with an inert SDK key, and receives neither the provider credential nor a GitHub token.
- The separate publisher has pull-request write permission, but receives neither the model secret nor the untrusted PR worktree. It accepts only the bounded primary artifact from the same workflow run and rechecks the live PR head and base before commenting. Before rendering E2E guidance, it independently allowlists coverage IDs and selector tuples and ignores artifact-authored E2E prose. A newly added credential-free test can extend the job allowlist only through trusted-normalizer evidence bound to the same head SHA, changed-file path, and basename-derived selector ID.
- Sticky publication updates only a marker-bearing comment owned by `github-actions[bot]`; a user-authored marker cannot claim the update target.
  The rendered comment preserves its hidden identity metadata while enforcing a 60 KiB UTF-8 limit, and publication errors remain visible in the publisher logs.
- The workflow posts advisory comments only; it does not approve, request changes, merge, push, label, or dispatch E2E.
- During rollout, non-default advisor lanes may see an older trusted `main` checkout that has the workflow matrix but not the matching model support. The workflow treats that as trusted-main rollout skew and writes low-confidence skip artifacts in the lane-specific artifact directory. Do not run PR-controlled advisor code to bypass this gate; remove the gate only after the trusted `main` implementation always supports the parallel advisor lane.
- The checked-in risk plan is deterministic and additive. PR Review Advisor reviews every listed
  invariant and required job for missing evidence. The trusted E2E normalizer restores any listed
  job that the model omits or downgrades. The PR E2E controller separately dispatches every listed
  job without consuming the advisor's normalized result.

Risk plan version 13 maps runtime changes from these paths to the `focused-e2e` family:

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
`https://inference-api.nvidia.com/v1` service with OpenShell. The sandboxed analyzer reaches that
provider through `https://inference.local/v1` and does not receive the secret.
The primary lane uses `azure/openai/gpt-5.6-terra`; the parallel Nemotron lane sets
`PR_REVIEW_ADVISOR_MODEL=nvidia/nvidia/nemotron-3-ultra` and reuses the same analyzer,
prompts, schema, safety boundary, and credential secret.

If advisor credentials are unavailable, the advisor writes a low-confidence unavailable result
instead of failing closed without artifacts.

## Artifacts

- `pr-review-advisor-result.json` — validated advisor result, or execution metadata when analysis is unavailable.
- `pr-review-advisor-final-result.json` — canonical result used for comments.
- `pr-review-advisor-summary.md` — markdown summary used in the job summary.
- `pr-review-advisor-session.html` — complete two-turn session transcript for debugging, including embedded session JSON, prompts, context reads, draft tools, validation, and bounded repair when used.

The parallel Nemotron Ultra lane writes the same filenames under
`artifacts/pr-review-advisor-nemotron-ultra/` and uploads them as the
`pr-review-advisor-nemotron-ultra` artifact.

## Specialist synthesis shadow

The specialist shadow runs five focused, read-only Pi sessions for Behavior, Trust, Design /
Architecture, Operations, and Documentation. Each cell uses the primary model and uploads Pi's
unchanged native JSONL session. A specialist succeeds when its Pi turn completes and that native session
is uploaded; it does not produce or validate the broad advisor result schema. Specialists have ordinary
repository read tools and cannot record or submit the canonical review.

The shadow synthesis job places the available traces beside the read-only repository inside OpenShell.
It reads them with the ordinary Pi filesystem tools, treats their model-authored content as advisory and
untrusted, verifies retained concerns against repository evidence, and uses the existing atomic
submission tools to create a candidate result. It does not concatenate, resume, project, or translate
the specialist sessions. Behavior and Trust traces are required. If Design / Architecture, Operations,
or Documentation is missing, synthesis continues with the available traces and the trusted analyzer
adds each missing domain to the result's review-completeness limitations. Any present trace must remain
a valid, bounded native Pi JSONL session; an invalid present trace rejects synthesis.

The existing primary lane remains the published authority during shadow evaluation. The publisher
keeps sole pull-request write permission and receives neither the model credential nor specialist
traces. Promotion of specialist synthesis requires separate maintainer acceptance of exact-commit
quality, false-positive, latency, runner-use, and provider-cost evidence.

## Manual run

```bash
node --experimental-strip-types tools/pr-review-advisor/analyze.mts \
  --base origin/main \
  --head HEAD \
  --schema tools/pr-review-advisor/schema.json \
  --out-dir artifacts/pr-review-advisor
```

For this direct local invocation outside the workflow's OpenShell wrapper, set
`PR_REVIEW_ADVISOR_API_KEY` locally. Add
`PR_REVIEW_ADVISOR_MODEL=nvidia/nvidia/nemotron-3-ultra` to exercise the Nemotron Ultra lane
locally. Run `npm install` first so the Pi SDK dependency is available.

## Output contract

`tools/pr-review-advisor/schema.json` defines the normalized JSON result shape used for the PR
comment and future reporting work. Findings include probe-shaped fields for impact, verification
hints, and missing regression-test guidance so agents know what to check rather than treating findings
as generic commentary. The required `terminologyReview` field contains the canonical receipt with
each candidate's change type, disposition, meaning, contrast, established alternative, semantic
impact, recommendation, trace ID, and source bound to the head commit. The dispositions are `established`,
`justified`, `define`, `replace`, and `conflict`. The trusted terminology tools are
`pr_review_trace_term` during investigation and `record_review_receipt` during atomic submission.
Trusted tracing verifies repository evidence after the model selects a candidate; it does not scan
or classify changed text to select terms. Every source-of-truth review item includes a `findingId`: unresolved items
reference their covering open ledger finding, while satisfied and not-applicable items use `null`.
Every result also includes nested `e2e.coverage` and `e2e.targets` guidance. The fields stay
separate in JSON, but comments and summaries combine their IDs into one `Recommended E2E` list and
one optional list. Duplicate IDs appear once. If a list is longer than the display limit, the output
reports how many more IDs exist. The trusted normalizer
restores deterministic requirements before model selections, retains only allowlisted coverage IDs
and supported selector tuples, and replaces model-authored reasons with trusted
reasons. It discards free-form E2E domains, new-test recommendations, and no-selection explanations.
The publisher compares the completed lanes after this normalization. It lists trusted
second-opinion-only selectors with a publisher-authored coverage-gap reason as optional
disagreements without adding them to the primary lane's recommended E2E guidance. It also compares
normalized terminology receipts and can show second-opinion-only or conflicting dispositions when
both lanes completed with decisions for the same head commit. These differences remain advisory and do not
change the primary assessment, merge posture, or recommended E2E guidance.
For a changed credential-free test, the normalizer also records structured head evidence only
after the trusted module-tag parser accepts the source; model-provided evidence is overwritten. The
trusted publisher independently repeats the ID and tuple checks, verifies that evidence against the
result head and changed-file identity, and renders only trusted IDs.
The compatibility schema retains `requiredTests` and `targets.required`, but those names describe
the normalized advisory tier, not merge requirements. Rendered comments label them as recommended;
the independent PR E2E controller does not consume advisor output.
Findings can also include safe simplification metadata with delete, stdlib,
native, YAGNI, or shrink tags; those suggestions must keep validation, security, data-loss prevention,
and required tests intact. A blocker keeps its evidence and required outcome in the blocker card.
Its simplification metadata renders once in a brief `Recommended refactoring` section below the
blockers.
Trusted submission derives `merge_after_fixes` when findings remain and `info_only` for low-confidence
review evidence. A finding-free `superseded` request succeeds only when deterministic context identifies
an open PR that explicitly replaces the PR under review. Without that evidence, `submit_review` rejects
the request and discards pending state. A `superseded` request with findings becomes
`merge_after_fixes`. Other finding-free reviews become `merge_as_is`. Failure output can also use
`info_only`.
These recommendations describe advisor findings only.
They never approve a PR, replace required human review, or change the repository's merge gates.
Warnings identify concerns that maintainers can accept without author action. Suggestions identify
optional improvements. Required design work must be a blocker instead of a warning.
An unnecessary-complexity blocker must remove or consolidate current structure. A helper or
abstraction is eligible only when current consumers adopt it and the combined source-and-test
structure materially decreases. Other recommendations that increase net complexity or merely add a
registry, configuration surface, compatibility layer, fallback, migration path, test framework, or
fixture owner require an independent correctness, security, or accepted-scope defect; they are not
presented as simplification. This keeps architecture feedback strong while preventing review-driven
growth and serial refactoring layers.
Every result includes limitations and requires maintainer review.
