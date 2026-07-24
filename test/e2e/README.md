<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E CI

Direct E2E coverage runs through Vitest.

Interactive TUI targets require `expect`. The unified workflow installs it
before those targets run; local runners must provide it themselves.

- `.github/workflows/e2e.yaml` is the scheduled, manually dispatchable, and
  selectively dispatched live target workflow.
- `.github/workflows/pr-e2e-gate.yaml` runs as `E2E / PR Gate Controller` and
  publishes the trusted `E2E / PR Gate Coordination` check for the PR/base SHA pair and the
  native `E2E / PR Gate` job that mirrors coordination into the PR's required
  GitHub Actions check suite.
- `.github/workflows/e2e-branch-validation.yaml` provisions Brev instances and
  runs focused E2E targets from source on a clean machine.
- Platform workflows such as macOS, WSL, sandbox image, and regression E2E
  call their target E2E tests directly. The Ollama auth proxy target is
  selected through `.github/workflows/e2e.yaml`.

The former top-level `test/e2e/test-*.sh` suite has been removed. Keep real
shell, installer, process, Docker, OpenShell, `/proc`, and sandbox boundaries in
E2E tests when those boundaries are the behavior under test.

## Credential-free tests

Credential-free tests that can use the standard Ubuntu runner, CLI build, and
artifact policy opt into the shared E2E job with a tag beside the test:

```typescript
// @module-tag e2e/credential-free
```

Discovery reads tagged files from the `e2e-live` and `integration` Vitest
projects. It derives each test ID from the filename and supplies only the ID,
repository-relative file, and Vitest project to the test matrix. Keep the
filename stem unique and lowercase kebab-case. Do not add the test to a separate
catalog or manually maintained workflow matrix.

The E2E workflow owns the shared job's runner, timeout, setup, permissions,
secrets, and artifact handling. Keep a dedicated workflow job when a test needs
different capabilities, such as credentials, a custom runner, additional setup,
or a different timeout.

Both `jobs` and `targets` selectors continue to accept the test ID. Run the
discovery command locally to inspect the generated test matrix:

```bash
npx tsx tools/e2e/credential-free-tests.mts
```

## Larger-runner routing

The larger-runner experiment is inactive while the configuration variable
`E2E_LARGER_RUNNER_LABEL` is unset. In that state, every eligible lane continues
to use `ubuntu-latest`. The trusted `generate-matrix` job builds one runner map
before checking out test code, and it consumes the variable only when the
workflow repository is `NVIDIA/NemoClaw`, the ref is `refs/heads/main`, and
no alternate checkout SHA is requested. PR-gate dispatches therefore remain on
standard runners even though they use the trusted workflow definition from
`main`.

Exact-head PR-gate dispatches use a bounded swap fallback for the hosted
Hermes image-building lanes that remain on those standard runners. The trusted
workflow provisions the fallback as the first job step, before checking out or
executing the candidate revision. It requires a controller-supplied lowercase
40-hex checkout SHA, matching trusted workflow and dispatch revisions, and an
ephemeral GitHub-hosted Linux x64 runner. Candidate code cannot supply the
program or arguments passed to `sudo`.

The trusted step requires at least 32 GiB (34,359,738,368 bytes) of usable swap.
It reuses active swap that meets this requirement.
Otherwise, it preserves at least 16 GiB of available disk capacity under
`/mnt`, creates a root-owned mode-`0700` directory, and creates an exclusive
randomized mode-`0600` file.
The file allocation is 32 GiB plus 4,096 bytes (34,359,742,464 bytes).
The additional 4,096 bytes keep the usable swap capacity at or above 32 GiB
after formatting.
Setup failure stops before candidate checkout and removes partial state only
after proving the file inactive or successfully disabling it.
After `swapon` succeeds, the trusted step makes up to five activation
observations, one second apart.
If visibility remains stale, cleanup treats the file as active.
Cleanup removes it only after `swapoff` succeeds.
Successful state is discarded with the ephemeral runner.

The fallback covers agent-turn latency, Hermes inference switch and shields,
the Hermes Bedrock and stable MCP shards, and the `hermes-e2e`,
`hermes-dashboard`, and Hermes security-posture tests. Scheduled and ordinary
manual `main` runs, larger-runner executions, rebuild lanes with
workflow-managed swap, dedicated-runner lanes, `mcp-bridge-dev`, and non-Hermes
shards do not use it.

The fallback exists because the alternate-checkout trust boundary deliberately
keeps PR-authored code from selecting the administrator-managed larger-runner
label; changing the PR checkout cannot safely grant itself that capacity.
Remove the fallback only after the trusted controller routes exact-head PR
gates to an ephemeral GitHub-hosted runner with at least 32 GB RAM without
weakening the exact-SHA guard, and five consecutive runs of every protected
lane complete without runner loss while runner-pressure telemetry reports less
than 1 GiB of swap used.

The eligible set is limited to the measured or repeatedly interrupted heavy
lanes:

- `common-egress-agent`;
- `hermes-e2e`, `hermes-dashboard`, and `hermes-discord`;
- both `hermes-inference-switch` modes;
- `hermes-shields-config`;
- the Hermes shards of `security-posture` and `channels-stop-start`;
- `rebuild-hermes`;
- `rebuild-hermes-stale-base`;
- the `hermes` and `deepagents` shards of `mcp-bridge`.

The OpenClaw shards of the matrix jobs, the `openclaw` MCP shard, and
`mcp-bridge-dev` remain on `ubuntu-latest`; unrelated jobs retain their
existing runner assignments. Before setting the variable, an organization
owner must:

1. Create a GitHub-hosted Ubuntu x64 larger runner with 8 vCPU, 32 GB RAM, and
   300 GB SSD in a dedicated runner group.
2. Set the group maximum concurrency to 4 and restrict repository access to
   `NVIDIA/NemoClaw` and workflow access to
   `NVIDIA/NemoClaw/.github/workflows/e2e.yaml@refs/heads/main`.
3. Record at least five standard-runner samples for each eligible lane,
   including queue time, execution time, peak CPU, memory and disk use,
   infrastructure failures, and estimated cost.
4. Copy the larger runner's workflow label into the repository variable, then
   repeat the same measurements for at least five representative executions
   per migrated lane.

Clearing `E2E_LARGER_RUNNER_LABEL` is the rollback. It sends the eligible lanes
back to `ubuntu-latest` without changing selectors, test setup, or test
semantics. Do not replace this experiment with a persistent self-hosted runner;
that requires a separate decision.

## Scheduled operations

The consolidated workflow keeps its operational reporting in the same job
graph as the live targets:

- GitHub Actions run history is the authoritative record for scheduled and
  manual E2E results.
- Automated issue routing and the workflow's `issues: write` capability are
  retired. Any future issue escalation should use a separately reviewed
  exceptional threshold, such as the same lane failing twice consecutively or
  remaining broken for 24 hours, rather than posting on every failed schedule.
- `scorecard` writes the scheduled/manual result summary, adds this run's
  semantic phase runtime table, compares the trusted cloud-onboard timing
  summary with the latest prior-release `e2e.yaml` run, and posts to the daily
  or full-run Slack route.
- Selective dispatches remain silent unless they run on `main` with
  `post_to_slack=true`, which uses the preview Slack route. Branch-dispatched
  runs never receive Slack webhook secrets.

### Runner comparison telemetry

Trusted `main` runs without an alternate checkout SHA record runner-comparison
telemetry for the #7145 contract: 12 routed workflow lane identities / 15
concrete job executions.

- `common-egress-agent` with the `openclaw-balanced-weather`,
  `openclaw-open-reference`, and `hermes-open-reference` shards
- `rebuild-hermes`
- `rebuild-hermes-stale-base`
- `mcp-bridge` with the `hermes` shard
- `mcp-bridge` with the `deepagents` shard
- `channels-stop-start` with the `hermes` shard
- `hermes-dashboard`
- `hermes-discord`
- `hermes-e2e`
- `hermes-inference-switch` with the `hosted` and `anthropic` modes
- `hermes-shields-config`
- `security-posture` with the `hermes` shard

The three extra executions come from `common-egress-agent`, which runs three
scenario shards, and `hermes-inference-switch`, which runs both listed modes.
The OpenClaw matrix entries for `mcp-bridge`,
`channels-stop-start`, and `security-posture` are not instrumented.

Each execution writes one bounded, ordered v2 time series to the canonical
`runner-comparison.jsonl` ledger. It contains:

- an `initialize` endpoint after workspace preparation;
- a distinct `scenario-start` for every test handled by the execution;
- a `periodic` sample on an approximately 60-second fixed cadence;
- a `phase` sample before each semantic phase transition and when the final
  phase stops; and
- a `finalize` endpoint from an `always()` step immediately before artifact
  checking and upload.

The progress pulse owns both stall reporting and periodic comparison sampling,
so it never creates a second timer. Phase samples that cross a periodic deadline
consume that slot, and delayed probes skip missed slots instead of producing a
catch-up burst. Each successful append also prints one bounded
`E2E_RUNNER_COMPARISON_SAMPLE` line in the job log.

The v2 ledger accepts at most 256 samples. Ordinary sampling stops once 255
records exist to reserve the last slot for `finalize`. A missing, historical-v1,
already-finalized, full, or invalid ledger permanently disables comparison
sampling for that test progress instance. In `rebuild-hermes` and
`rebuild-hermes-stale-base`, where legacy phase resource evidence is configured,
the existing five-minute full snapshot then becomes the best-effort fallback.
That full profile may run `ps`, `docker stats`, and `docker system df`
sequentially with a 15-second timeout each, or 45 seconds in the worst case;
canonical sampling suppresses this heavier collection while it remains active.
Other lanes stop canonical sampling without creating a second evidence stream.
Historical v1 ledgers and summaries remain readable, but a v1 ledger cannot be
extended or mixed with v2 samples.

Probe cost depends on the sample kind. `initialize` and `finalize` read only
kernel and filesystem sources and launch no child process. `periodic` adds one
one-second `ps` probe and does not call Docker. `scenario-start` and `phase`
samples add the same bounded process probe plus two-second `docker stats` and
`docker system df` probes. The emitted schema contains only numeric fields,
fixed process classes (`docker-buildkit`, `openshell`, or `other`), and fixed
sample metadata, including the explicit target and shard labels. It never
records process or container names, command lines, child output, or arbitrary
environment and secret values. Docker memory evidence is reduced to the largest
retained container value; maximum Docker CPU considers every row in the bounded
command output.

The finalizer validates the complete ledger before writing
`runner-comparison-summary.json`. The v2 summary reports the sampled
post-prepare window; CPU average and busiest interval; one-minute load;
available, cached, reclaimable, swap, root-cgroup current/peak/limit, and
endpoint OOM-counter evidence; memory and I/O pressure; workspace bytes and
inodes; Docker image, container, and build-cache usage; largest container
memory and CPU; and the largest fixed process class by RSS. Extrema include the
semantic phase where they were observed when attribution is sound. CPU
intervals ending at a `scenario-start` remain unattributed because they can
span two tests, and extrema whose selected observation is `initialize` have a
`null` phase. OOM deltas are also `null` unless both endpoint counters are
available. Unsupported or unreadable measurements are `null`.

The root-cgroup peak is a lifetime counter that includes Docker siblings but
can also include host activity before the measured window. Compare it only
across runs with the same runner setup. Canonical v2 `memory.availableKb` comes
only from `/proc/meminfo` `MemAvailable` and is `null` when that field is
unavailable. Separately, the adjacent progress/stall resource line falls back
to the portable free-memory value and labels that value as `memory free`.

The comparison time series is diagnostic-only and is not an input to terminal
classification or retry policy. Low available or free memory never implies an
OOM. OOM classification or attribution still requires the existing positive
OOM evidence, and the single retry remains limited to positive runner-loss
evidence.

Treat a missing summary as unavailable evidence, not as low utilization. A
hard runner loss can prevent finalization or artifact upload. When you compare
standard and larger runners, use runs with the same commit SHA, workflow
inputs, target, and shard. Pair the artifact with the GitHub Actions runner
label, queue time, result, and usage or cost metadata. The ledger is a time
series for one execution only; this telemetry does not maintain cross-run
rolling history or write to the GitHub Actions step summary. Both output files
are private regular files on the runner (`0600`) with strict per-line and total
size limits.

Raw cloud-onboard traces stay under the runner temporary directory. Before
artifact upload, `scripts/e2e/sanitize-trace-timing.py` reduces them to the
allowlisted `cloud-onboard-trace-timing-summary.json` timing schema and deletes
the raw directory. Aggregation ratchets require `report-to-pr` and `scorecard`
to wait for the same execution-job set.

Registry-driven Vitest targets also enable onboard trace collection. Each live
matrix target writes raw traces under the runner temporary directory, sanitizes
them before upload, deletes the raw trace directory, and uploads only
`e2e-artifacts/live/<target>/cloud-onboard-trace-timing-summary.json` with the
target artifact. These per-target summaries are artifact evidence only; the
Slack/GitHub scorecard comparison remains tied to the dedicated `cloud-onboard`
artifact so baseline aggregation stays stable.
Older issue references to Vitest target artifacts under `e2e-artifacts/vitest/`
map to this consolidated `e2e-artifacts/live/` registry-target artifact layout.

Every `e2e-live` test and every credential-free integration test selected by
the shared E2E workflow planner declares an ordered semantic phase plan in
`meta.e2ePhases` and uses its automatic progress fixture. Normal E2E output
identifies the workflow target and test scenario, then shows immediate phase
start and completion lines with both phase and total elapsed time. A transition
looks like:

```text
[e2e target="cloud-onboard" scenario="onboards a hosted sandbox"] [phase 2/4] completed: onboard the sandbox — passed in 2m 14s (total 2m 21s)
[e2e target="cloud-onboard" scenario="onboards a hosted sandbox"] [phase 3/4] started: verify hosted inference (total 2m 21s; phase 0s)
```

For `e2e-live`, the stateful fixture appends `release registered E2E resources`
after the test-declared plan, so the displayed phase count includes that
terminal phase. Registered cleanup duration, failures, and stall diagnostics
are attributed there. Workflow-selected integration tests instead declare and
enter their own final release phase. Soft assertion failures remain attributed
to the semantic phase in which they occurred rather than being reassigned to
resource release.

If one phase remains active for five minutes, a content-free diagnostic adds
the target/scenario identity, total and phase duration, age of the last child
output, current redacted command or cleanup activity, and runner resources. It
repeats every ten minutes while that same phase remains active. Automatic child
output observation forwards only a timestamp and stream name, never contents.
Operations with bounded retries may emit immediate content-free
`progress.event(...)` lines for a timeout, cleanup, backoff, or retry; event
labels are explicitly logged and must never contain child output, request data,
credentials, or tokens.

During fixture teardown, the fixture writes `test-progress.json` into each
test's existing artifact directory for passing and failing tests. The summary
keeps the test identity and overall timestamps, plus each recorded phase's
timestamps, duration, outcome, child-output event count, and last-output timestamp.
It records the target from `E2E_TARGET_ID`, falling back to the Actions
`GITHUB_JOB` identity, and records `NEMOCLAW_E2E_SHARD` when set. Compare
extracted artifacts from multiple runs with:

```bash
npm run test:runtime-audit -- path/to/run-1 path/to/run-2
```

The audit groups each test by target and optional shard, ranks the groups by
p95 runtime, and reports variability plus the slowest observed phase's duration
and outcome. Scheduled and ordinary manual runs include the same table for that
run in the GitHub Actions scorecard summary. Keep phase
labels specific to test behavior, call `progress.phase("literal phase label")`
at the declared boundaries in order, and transition through the final
test-declared phase on every passing path. Both fixtures reject a passing test
that never reaches that phase; only the stateful live fixture enters its
resource-release phase automatically.
Validate phase coverage without executing test bodies with:

```bash
npm run test:e2e-phases:check
```

The checker preserves coverage for every file under `test/e2e/live/` and adds
workflow-selected integration files from the authoritative shared-job planner.
Live modules import `fixtures/e2e-test.ts`; selected integration modules import
`fixtures/workflow-e2e-test.ts` and declare their final release phase explicitly.
It also follows shared E2E runtime helpers. Run child processes through
`ShellProbe` or an existing audited progress-aware boundary; new direct async
process boundaries fail the check. Synchronous calls require both a positive
timeout shorter than the first heartbeat and `killSignal: "SIGKILL"`. Keep child
contents in redacted artifacts and report only timestamp-based output activity
to the console. Pass the fixture-provided frozen, canonical `progress`
capability unchanged to an audited subprocess boundary; do not replace it with
a custom, copied, or no-op adapter.

## PR E2E gate

The controller, coordination check, and required job deliberately use
different names and report different parts of the lifecycle.
`E2E / PR Gate Controller` reports whether the trusted controller handled its
event. The controller publishes the internal custom check
`E2E / PR Gate Coordination` as its verdict for the PR/base SHA pair.
The default-branch `pull_request_target` path publishes the native GitHub
Actions job named `E2E / PR Gate`. It checks out the controller at
`github.workflow_sha`, validates that the PR still has the observed head and
base, waits for the matching trusted coordination identity, and exits with its
terminal verdict. It also writes that verdict and the trusted run link to the
job log and keeps the job summary free of network-derived content. During
rollout, the observer accepts the former custom-check name
`E2E / PR Gate` for the same PR/base SHA external identity so in-flight PRs do
not lose their gate.

A handled prerequisite-CI failure, selected E2E failure or timeout, stale
revision, or closed PR can leave the controller green while coordination is
failed or cancelled and the native job is non-passing. Only a successful native
`E2E / PR Gate` for the current head and base satisfies the required check. An
eligible prerequisite-CI failure records the versioned retry reason
`prerequisite-ci`. A selected child records `child-cancelled` only when the
controller authenticates either a trusted GitHub-hosted runner-loss annotation
or the exact terminal-shutdown fallback against the failed job and workflow
commit, and no other terminal classification was produced. Cancellation alone
is not retryable. Assertion failures and other selected-E2E outcomes do not
receive a retry reason. An unexpected controller error still fails the
controller workflow and fails coordination closed, which prevents the native
job from passing.

On open, synchronization, reopen, transition out of draft, or base retarget,
`.github/workflows/pr-e2e-gate.yaml` reserves `E2E / PR Gate Coordination` for
the PR SHA and base SHA, including fork SHAs. The read-only native
observer starts for every configured non-closed PR event; metadata-only edits
mirror the existing PR/base SHA coordination result instead of publishing a
skipped success. A base retarget reserves a distinct PR/base SHA identity.
Controllers never mutate coordination owned by another base because a newer
base can appear after an older controller's live validation. The exact-identity
observer ignores checks from other bases, and an older controller that resumes
fails its own coordination closed at final live validation. Completed results
remain audit history. The
`CI / Pull Request` run name binds its PR number, head SHA, base SHA, and gate
eligibility so the trusted controller can authenticate the completed run even
when a fork `workflow_run` payload omits pull-request metadata. The controller
also requires the completed run's workflow path to be
`.github/workflows/pr.yaml`. Metadata-only edits are marked ineligible and are
ignored by the controller and PR Review Advisor; base edits are eligible. PR CI
and advisor concurrency groups include that eligibility, so an ignored
metadata-edit run cannot cancel an eligible run for the same PR. The trusted
controller reads all changed files after eligible PR CI completes and builds
the deterministic risk plan.
Runtime families and changes to workflow-wired live tests select
canonical selectors from the trusted `e2e.yaml` inventory independently of
advisor output. Ordinary internal changes execute those focused selections.
Gate initialization, CI coordination, protected approval, and manual fork-skip
recording share one non-cancelling FIFO concurrency group for the exact
repository, PR number, PR SHA, and base SHA. `queue: max` keeps pending jobs for
that exact identity instead of replacing them, up to GitHub's 100-job bound.
Before the controller creates or updates coordination for the current revision,
it reads the live PR and requires the event's PR SHA and base SHA, including
when PR CI failed. The native observer performs the same live PR/base SHA check
before waiting and again before accepting a terminal verdict. This keeps a
stale seed, completed CI run, or observer from being applied to a newer PR/base
SHA pair. A completed CI event for an older revision is handled without
creating or updating the current revision's coordination check.
If the older revision still has an in-progress coordination check, the
controller completes it as cancelled with `Superseded by PR update` or
`PR closed — gate no longer applies` and identifies the obsolete head and base.
The closed-PR outcome also applies when a fork repository was deleted and
GitHub consequently returns no head-repository object.
Shared sandbox-boundary changes have a floor of `full-e2e`, `hermes-e2e`, and
`security-posture`. E2E control-plane changes select `cloud-onboard`,
`credential-sanitization`, and `security-posture`. The `e2e-control-plane`
family is a conservative path boundary that includes non-documentation files
under `tools/e2e/` and `test/e2e/`, plus the E2E and PR-CI workflows, risk
policy, dependency and test configuration, and preparation and upload actions.
The Deep Agents Code headless-inference check additionally selects the exact
`ubuntu-repo-cloud-langchain-deepagents-code` typed target. That target is
hashed into the risk plan beside the control-plane floor jobs, so the
controller dispatches both selector types in one correlated workflow run.
An internal revision whose matched control-plane files are drawn only from the
trusted controller and observer boundaries—`.github/workflows/pr-e2e-gate.yaml`,
`tools/e2e/pr-e2e-gate.mts`, and `tools/e2e/pr-e2e-required.mts`—automatically
dispatches those selected jobs.
Any other or mixed internal control-plane revision requires an authorized E2E
reviewer to approve the PR SHA before credentialed execution begins. If no job
or target is selected, coordination passes without an E2E run and the native
required job mirrors that success.

Before dispatch, the controller verifies that the live PR still matches the CI
run's PR SHA and base SHA. It uses its own workflow commit when that commit is
still `main`. If `main` advanced, the controller accepts the current commit
only when GitHub reports it as a descendant whose merge base is the workflow
commit, the comparison contains fewer than 300 fully enumerated files, neither
side of a rename enters the `e2e-control-plane` risk family, and a second read
confirms that `main` did not move again. Any divergence, incomplete comparison,
control-plane change, or second advance fails closed. The accepted `main`
commit is recorded as the workflow SHA and passed as `workflow_sha`. Before
matrix or secret-bearing jobs can run, `e2e.yaml` requires
`github.workflow_sha` to match that accepted commit. Each selected job checks
out `checkout_sha`. The same validation verifies that the PR remains open,
belongs to `NVIDIA/NemoClaw`, and still has both the dispatched head and base
commits. The dispatch includes selected jobs, allowlisted typed targets, and
valid plan and correlation metadata. Controller-bound targets are restricted
to the trusted allowlist. Before checking out PR code, the trusted workflow
projects each controller-selected target into a fixed target ID and hosted
runner mapping. The generated live matrix must exactly match those trusted IDs
and runners, and only the trusted projection can configure credential-bearing
typed-target jobs. Ordinary branch dispatch is not an acceptable substitute.
The controller uses GitHub's returned run ID for
waiting, evidence download, and completion, then revalidates that the PR is
still open with the PR SHA, base SHA, and coordination identity before
recording a final result. The native observer revalidates the live revision
before mirroring that terminal result.

An internal revision whose control-plane matches include a file outside the
trusted controller and observer boundaries leaves coordination in progress
with `E2E reviewer authorization required to run E2E`. The native required job
keeps waiting for the authorization flow. No selected job or target runs and no
repository secret is exposed. The same controller run starts `Approve
credentialed E2E for internal PR`, which waits on the protected
`approve-credentialed-e2e-for-internal-pr` environment. With `deployment:
false`, the job does not create a deployment record. After reviewing the exact
head SHA, base SHA, and risk plan as described below, an environment reviewer
opens the linked run, chooses **Review deployments**, selects that environment,
and approves it. GitHub records the reviewer and optional comment. The
protected approval job uses the exact-revision FIFO concurrency group without
in-progress cancellation. A newer revision uses a distinct group and can
become available for review without waiting on the obsolete request. The
synchronization controller cancels active child runs and closes coordination
checks for the old revision. If an old approval job later starts, exact live
PR SHA and base SHA validation rejects it. The controller reads the approval
history and requires one approved review naming only the exact environment in
the first attempt of the trusted `workflow_run` controller. It then revalidates
the internal repository origin, open PR, PR SHA and base SHA, risk plan,
matching pending coordination state, compatible trusted controller commit, and
final live revision. It updates coordination to `Running <count> E2E check(s)`
and dispatches the selected jobs and targets in one workflow run.

The manual maintainer path remains available as a fallback. A repository
maintainer or administrator chooses **Run workflow** on `main`, selects
`run-control-plane`, and supplies the PR number, current 40-character head SHA
as `expected_head_sha`, current 40-character base SHA as `expected_base_sha`,
and a specific 10–500-character `review_reason`. This path additionally
revalidates the triggering actor's `maintain` or `admin` permission and uses the
same exact-revision and deterministic-plan checks. If authorization
fails before a child run is dispatched, the controller restores the
authorization title and leaves coordination in progress. A maintainer can then
launch a fresh first-attempt manual authorization. To use the protected path
again, correct its environment configuration, update the PR to create a new
head, and trigger fresh PR CI. After a child is dispatched, a startup failure
requests cancellation. Whether or not cancellation is confirmed, the
controller completes coordination as
`Authorized E2E run requires reconciliation`; that authorization for the PR/base SHA pair
cannot be retried because the child may still execute and a retry could start
duplicate credential-bearing work. Inspect the linked run, then update the PR
and run fresh CI before authorizing again.
The native required job treats authorization and running titles as intermediate
waiting states only while coordination remains in progress. It also keeps
polling when the current PR/base SHA coordination check is a completed failure
with a validated current-version retry marker, so it can follow a later
validated replacement for the same unchanged head and base. That completed
failure remains immutable and cannot be changed by manual authorization. A
later eligible `CI / Pull Request` run can create a fresh coordination check for
the same unchanged open head and base only when the newest failed coordination
check carries a current-version retry reason:
`prerequisite-ci` after the later CI run succeeds, `child-cancelled` after a
conclusively cancelled child, or `evidence-download` after a successful child
whose evidence download failed, was cancelled, or was skipped. The trusted
controller leaves the completed check as audit history, creates and validates a
new `in_progress` check with the same PR/base SHA external identity, and rebuilds
the deterministic plan before exposing a fresh authorization state. The
controller and native observer select the highest check-run ID only when every
older duplicate is a completed failure with a recognized versioned retry
marker. An unexpected app or mismatched mutation identity, duplicate ID, older
unmarked or otherwise non-retryable terminal state, or multiple active
candidates fails closed. Selected-job product or
assertion failures, evidence policy or integrity failures, schema or identity
mismatches, traversal or provenance failures, reconciliation, controller
errors, unknown states, and failures recorded before retry reasons existed
remain terminal for that PR/base SHA pair. Fork approval failures are not retried by
PR CI; follow the protected or manual skip path, or update the PR to create a
new head. Update the PR and run fresh CI for the other terminal outcomes. The
normal wait, evidence download, and finish path is the only path that can record
success; the authorization itself cannot make the gate green. A changed head or
base requires a new authorization.

A fork revision that selects jobs or typed targets completes coordination as
failed while the native required job waits for the skip-approval flow. The
controller does not dispatch the selected credential-bearing jobs or targets
or expose repository secrets.
Non-secret PR CI remains required. The failed coordination summary
embeds an explicit link to the same `E2E / PR Gate Controller` run; maintainers
follow that link rather than relying on the coordination check's **Details**
destination. The coordination check publishes only allowlisted skip-approval
metadata for its PR number, mode, head SHA, and base SHA. The native required
job recognizes the approval-required title as an intermediate waiting state.
That controller run starts
`Approve credentialed E2E skip for fork PR`, which waits on the protected
`approve-credentialed-e2e-skip-for-fork-pr` environment. With
`deployment: false`, the job does not create a deployment record. A maintainer
or delegated E2E reviewer reviews the exact head SHA, base SHA, and risk plan as
described below, opens the linked run, chooses **Review deployments**, selects
that environment, and approves it. The approval records that the selected
credential-bearing jobs and targets will not run; it does not authorize fork
code to run with repository secrets. The comment is optional, and the workflow
reads both the reviewer and comment from GitHub's run approval history rather
than accepting an actor supplied by the job.

Before rollout, create both `approve-credentialed-e2e-for-internal-pr` and
`approve-credentialed-e2e-skip-for-fork-pr` in the repository. Configure each
environment with one or more required reviewers. Protected-environment
reviewers are the authorization allowlist and may have repository read access
without merge rights. Do not add environment secrets, variables, or custom
protection apps. Enable **Prevent self-review** and prefer disabling
administrator bypass so every decision is independent and appears in the
approval history. Restrict deployment branches to protected `main`. Before
either decision, verify the exact head SHA, base SHA, and selected jobs and
targets in the coordination check summary and the
`pr-e2e-risk-plan-<head-sha>` artifact from the linked controller run. The
internal approval job receives only its job-scoped token after approval and
executes the trusted controller from `main`; the fork approval job records a
skip and runs no PR-controlled code. If **Review deployments** is absent, the
environment may be missing or unprotected, or the run may no longer be waiting.
Configure the environment, update the PR to create a new head, and trigger fresh
upstream PR CI to create a new gate run, or use the corresponding manual
maintainer fallback. GitHub approval
history is not bound to a run attempt, so the controller rejects reruns of an
approval run. Approval concurrency is bound to the exact PR SHA and base SHA.
A newer revision creates a separate approval request, while an obsolete request
cannot authorize it.

For the fork button path, the controller requires a first-attempt, in-progress run
of this exact workflow on `main`, at the trusted workflow SHA and with the
`workflow_run` event. It requires exactly one approved review that names only
the exact environment. The environment's required-reviewer configuration is
the authority for this protected path. The shared resolver revalidates
the open PR, repository origin, PR SHA and base SHA, deterministic plan,
matching failed coordination check, and that the controller commit is either
still `main` or
has only a compatible safe descendant as described above. Immediately before
recording success, it reads the live PR again and requires the same PR SHA and
base SHA. The result records the reviewer, bounded optional comment, validated
approval-run URL, plan hash, and jobs and targets that did not run. The
successful skip coordination check is titled
`Credentialed E2E skipped for fork PR — approved by @<reviewer>` and begins
with `Outcome: APPROVED SKIP — credentialed E2E did not run.` It never claims
that the selected checks passed. The native required job mirrors this
approved-skip success.

The manual fork skip approval on `main` remains available as a fallback. Choose
`approve-fork-e2e-skip` and provide the PR number, current `expected_head_sha`,
current `expected_base_sha`, a 10–500-character `review_reason`, and optionally
an Actions run URL in the exact form
`https://github.com/NVIDIA/NemoClaw/actions/runs/<run-id>`. Leave
`evidence_url` blank when no supporting run exists. PR, issue, comment, job, and
external URLs are rejected. The controller validates the optional URL's shape
but does not inspect that run's contents. It applies the same PR, role, plan,
failed-check, compatible-`main`, and final stale-revision checks. Any new commit
receives a different gate and requires a new decision; a base change also
invalidates the decision.

The Vitest reporter writes one `risk-signal.json` for each selected job shard
and typed target. Typed targets bind the signal identity to the exact matrix ID
and use the `default` evidence shard. The checked workflow boundary requires
every policy-selected execution path to expose its matching identity, attach
the reporter to every Vitest invocation, and always upload its evidence
artifact.
Each signal binds the observed checkout SHA, expected SHA, plan hash,
correlation ID, and pass, failure, skip, pending, and unhandled-error counts.
The controller retains `pr-e2e-risk-plan-<sha>` for 14 days, while each
signal travels in the selected job or target's existing E2E artifact.
Its private dispatch state is protected by a SHA-256 digest that is verified
before downloaded evidence is classified.

When the plan selects jobs or targets, coordination passes only when the E2E
run succeeds and every expected job shard and target uploads one complete
passing signal with no skips or pending tests. The native required job passes
only after observing that
trusted success. For the current PR/base SHA pair, every other dispatched outcome
fails. A failed coordination result links the selected E2E run and up to 10
non-passing jobs, including up to three failed step names per job. If GitHub
truncates the job listing or the controller cannot load it, the coordination
check directs the maintainer to the complete run.
The coordinator has a 330-minute job budget and gives each selected E2E run 140
minutes to finish. A first-attempt controller may dispatch one replacement run
when the first child fails because a standard GitHub-hosted `ubuntu-latest`
runner lost communication. The Jobs API response must identify the exact run,
attempt, workflow commit, job check, standard hosted runner group, and runner
name. The controller accepts one canonical runner-loss failure annotation bound
to `.github` at that workflow commit.

When GitHub emits a generic terminal result instead, the controller requires
exactly one failure annotation. Its message must be
`The operation was canceled.` for one completed `cancelled` workload step or
`Process completed with exit code 143.` for one completed `failure` workload
step. The annotation must use `.github`, equal start and end lines, null
columns, and empty title and detail fields. Every annotation must use a blob URL
bound to the same workflow commit. The controller accepts at most 20
annotations, bounds each text field, and limits the normalized annotation
evidence to 64 KiB. This permits trusted bounded non-failure notices beside the
sole failure annotation without allowing annotation output to exhaust the
coordinator.

GitHub Actions creates these `.github` failure annotations after the hosted
runner shuts down; NemoClaw workflow code cannot replace their generic messages
with the canonical lost-communication annotation. The classifier tests
`accepts the exact authenticated terminal shutdown block from run 29988226653`
and `accepts the exit-143 hosted shutdown from run 30026115852` preserve the
two observed fallback contracts. Remove a fallback and its test together only
after GitHub's documented Jobs or Checks API contract provides an authenticated
structured runner-loss reason for that shutdown path.

The terminal-shutdown fallback also authenticates the job log. The
controller requests the GitHub job-log endpoint and accepts only its signed
HTTPS redirect to GitHub Actions result storage. It does not forward the
repository token to that signed URL. A metadata request must return plain,
unencoded text with a strong bounded ETag and an exact content length. The
controller then reads at most the final 64 KiB with `If-Match` and requires an
exact partial-content range, length, and matching ETag.

The authenticated tail must end with exactly one line feed after the
timestamped shutdown error, matching operation-cancelled or exit-143 error, and
orphan-cleanup record, in that order. Up to 64 unique orphan-process termination
records may follow the cleanup record. Each record must contain a positive
process ID and a bounded process name. The record timestamps must not move
backward. The job must start no later than the interrupted step. The shutdown
must occur at or after that step starts, and the terminal-error second must
equal the step's completion time. Cleanup must not precede the terminal error.
Cleanup and orphan-process records must finish no later than the job completion
time.

A generic terminal result without this log contract, an ordinary exit 143
without the exact preceding shutdown block, timeout, unknown runner identity,
self-hosted or custom runner group, ordinary failed step, another non-passing
job, incomplete pagination, or mismatched annotation identity fails closed
without a retry.

Before the one-time retry dispatch, the controller revalidates the unchanged
internal PR head and base, original child, current coordination-check lineage,
trusted runner-loss evidence, and deterministic plan. It reads the complete
job, annotation, and optional log evidence twice. It confirms the unchanged
completed child after each read and requires identical evidence fingerprints,
including pagination state, log ETag, log length, and log-tail hash. After the
second classification, it validates the live PR head and base and the current
coordination-check lineage again.

The source coordination check binds that original child through the
controller-generated `Selected E2E run <run-id>` summary. The summary label,
linked run ID, repository, and exact Actions run URL must agree. GitHub may set
the check details URL to either that exact child run or the canonical
`/runs/<check-id>` URL for the source check. A malformed selected-run prefix or
any mismatch fails closed. Compatibility checks that predate the selected-run
summary remain eligible only when their details URL is the exact child Actions
run URL.

The controller reserves a distinct replacement coordination check before
dispatch so the native observer can follow the retry without mutating completed
attempt-one history. Attempt two uses separate private state and evidence paths.
Its result is terminal and cannot authorize another automatic retry. If the
retry setup fails, is cancelled, or is skipped before reservation, its
always-run cleanup removes the retry authorization from the source. If it stops
after reservation, cleanup closes the reserved replacement. This prevents a
retryable or active check from remaining.

Each evidence download has its own 10-minute limit and 30-second process-kill
grace. Two 140-minute waits plus both download windows consume 301 minutes,
leaving 29 minutes of the coordinator budget for validation, dispatch, and
finalization. The native required observer waits up to 358 minutes inside a
360-minute job. That is 13 minutes longer than the 15-minute prerequisite-CI
budget plus the 330-minute controller budget, so it can observe the retry's
terminal result without racing the controller timeout. When a child wait
expires, finalization cancels that child and records the non-passing result in
the coordination check.

If the selected child succeeds but the `Download evidence` step fails, is
cancelled, or is skipped, the controller cannot authenticate the child's
artifacts. It fails coordination closed as
`Evidence could not be verified` and leaves `E2E / PR Gate Controller` red so
maintainers inspect that infrastructure failure. This download-only outcome
records `evidence-download`, so a later successful eligible PR CI run can create
a fresh coordination check for the same PR/base SHA pair. If the download step
succeeds but signals are missing, duplicated, skipped, pending, or report a test
failure, the controller has
completed its work: it publishes the handled red PR verdict and remains green
without a retry reason. Malformed or unsafe evidence, schema or exact-identity
mismatches, and traversal-limit violations remain terminal controller
verification errors, so coordination, the native required job, and the
controller fail closed.
These dispatches suppress PR comments and the scheduled or manual
scorecard, including scorecard Slack reporting.

Synchronizing, reopening, or closing an internal PR cancels its active E2E
runs. On synchronization, the trusted cancellation job receives the event's
current and previous head SHAs and first requires the live PR to match the
current internal revision. It completes each active GitHub Actions-owned
coordination check for the previous head as cancelled and rejects unexpected
GitHub App ownership. Completed checks remain immutable audit history. A new
dispatch also cancels the previous run. The previous controller then completes
the old PR/base SHA coordination check as cancelled when the PR revision moved
or closed, or as failed when the current revision's selected E2E did not pass.
Native observer concurrency cancels the old required-job run and starts a new
one when a configured non-closed PR event identifies the current revision.
Metadata-only edits restart the observer against the unchanged PR/base SHA
identity.
The controller does not read PR Review Advisor output, so model availability
and recommendations are not part of merge authority.

## Onboard performance budget

The scheduled/manual scorecard evaluates the trusted `cloud-onboard` timing
summary against `ci/onboard-performance-budget.json`. The budget covers the
warm-system path and is advisory: exceeding the total-duration cap or a
regression threshold emits a GitHub Actions warning and adds details to the run
summary, but does not fail the scorecard job.

The config separates the absolute total-duration budget from total and phase
regression thresholds. Phase regressions are diagnostic and are only compared
when the current run and prior-release baseline contain the same known onboard
phase names. Cold image pulls, first-time model downloads, provider outages,
and runner or network incidents can still affect the signal, so maintainers
should inspect the timing table before acting on a warning.

For PRs, the unified PR Review Advisor builds and renders guidance from the
deterministic risk plan for the PR SHA and changed-file set. It
recommends jobs for known regression families and includes `cloud-onboard` when
changes affect onboard behavior, trace timing, scorecard analysis, budget
configuration, or the unified E2E workflow. Compatibility schema fields may
classify that guidance as required, but rendered advisor guidance remains
non-authoritative. Model advice is additive and cannot downgrade the
deterministic floor. The independent PR E2E controller rebuilds the plan rather
than consuming those recommendations, and the scorecard remains the source of
truth for advisory warm-system trend evaluation.

The `full-e2e` target enforces a separate hard acceptance contract for the
first fresh onboarding path in that job. It measures from the onboard root span
(a conservative anchor before wizard step `[1/8]`) through the first non-empty
agent response, requires the local BuildKit prebuild for the NemoClaw-generated
context without a gateway-builder fallback, enforces the calibrated root and
phase limits in the budget file, and limits the longest onboard output gap to
60 seconds. A violation fails
`full-e2e`, and the target writes its evidence to `onboard-progress-budget.json`.

When changed base-image inputs require the authoritative local OpenClaw base
build, the target applies the separately calibrated 90-second allowance only to
the root-start and sandbox-phase limits. The installer must emit the exact local
base-build reason before the allowance applies. Published-image runs retain the
normal limits, and output silence, first-turn, and all other phase requirements
remain unchanged.

The two Hermes rebuild jobs and both reusable-workflow Hermes image exporters
add a bounded 32 GiB swap file on their ephemeral hosted runners before the
memory-heavy image build. The rebuild fixture verifies that floor and
provisions the same swap file on GitHub Actions when a trusted control-plane
run uses the workflow definition from `main`. Those paths build large Hermes
image layers and can otherwise exhaust the runner's default memory and swap
during Docker layer export. Other E2E jobs keep the standard runner memory
configuration except for the exact-head Hermes PR-gate fallback described in
[Larger-runner routing](#larger-runner-routing).

These assertions run inside the existing `full-e2e` lifecycle instead of a
second standalone onboarding run. This keeps the measurement on the job's first
sandbox build, avoids warming Docker layers before a duplicate performance
test, and makes `full-e2e` the source of truth for the hard cold-path contract.
