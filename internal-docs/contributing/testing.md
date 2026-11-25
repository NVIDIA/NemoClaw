<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tests

## Choosing Local Validation

Before pushing, choose checks that cover the changed behavior and its affected callers.

| Change | Local validation |
|---|---|
| Prose or documentation | Review the changed text; run the [documentation check](documentation-build.md#validating-locally) for documentation changes. |
| Declarative configuration or workflow triggers | Run the applicable schema or lint checks; test affected execution paths when their behavior changes. |
| Isolated code change | Run focused behavioral tests and nearby regression checks, plus formatting and lint checks for the affected code. |
| Bundle construction, provider contracts, lifecycle behavior, or broad workspace dependencies | Run `cargo ci`; it [selects](#selecting-expensive-local-checks) the bundle, contract, and integration checks from the changed inputs. |
| Images or Kubernetes deployment | Also run `cargo ci live-docker` or `cargo ci live-kind`; see [live tests](live-tests.md). |
| Impact is unclear or narrower checks cannot establish confidence | Run `cargo ci`. |

For changes spanning categories, combine the applicable checks.
A YAML or configuration file can change runtime behavior; choose by impact rather than extension.
Report the commands and results to whoever asked for the change, and name checks deferred to CI with the reason; a PR description names only checks outside CI.
Repeat validation when relevant inputs change, a check fails, or an unresolved concern requires it; a push alone does not require another run.
Required PR checks still apply before merging.

## Running the Full Local Suite

Run this platform's complete `CI / Bundle` checks from the repository root:

```sh
cargo ci --full
```

The command needs the pinned Rust toolchain and a C linker.
It downloads Protocol Buffers compiler 36.2 and cargo-nextest 0.9.152 into the Git-ignored `.tools` directory, verifying each against its `versions.json` checksum; it installs no host packages.
It then runs formatting, Clippy, the unit tests and doctests, the schema check, a bundle build, and the contract and integration tests, stopping at the first failure.
To build the SDK outside `cargo ci`, set `PROTOC` to `.tools/protoc-36.2/bin/protoc` after `cargo ci tools`, or to another protoc 36.2.

## Selecting Expensive Local Checks

Plain `cargo ci` selects bundle, contract, and integration work from changed inputs:

```sh
cargo ci --dry-run
cargo ci
```

The base is selected in this order:

1. An explicit `--base REVISION`.
2. The open PR target reported by `gh pr view`, including a stacked PR's parent, when that exact commit is available locally.
3. `origin/v1`.

The runner prints the selected base and why it chose it.
PR discovery needs an attached branch, GitHub CLI, and GitHub access; a closed PR, failed lookup, or unavailable target commit falls back to `origin/v1`.
Fetch the parent branch if its commit is missing locally.
Before opening a stacked PR, use `--base origin/PARENT`; a tracking upstream does not reliably identify a stack's parent.
If the automatic base is unavailable, the runner stops and asks you to fetch it, pass `--base`, or use `--full`.
`--base` and `--full` bypass PR discovery.
The comparison includes committed, staged, unstaged, and untracked files; Git-ignored untracked files are excluded.
`--dry-run` prints JSON with the selected steps and the reasons for the expensive checks, without installing tools or running those steps.
The outer Cargo invocation still builds the CI runner when needed.
Formatting, Clippy, the workspace build, unit tests, doctests, and schema checks always run in `cargo ci`; only bundle construction and the contract and integration steps can skip.
Use `cargo ci --full` to run the complete local suite, or `cargo ci --full --dry-run` to preview it.
`--base` and `--full` are mutually exclusive and cannot be combined with a named step, a partition, an archive, live-image inputs, or `--hcl-cases`.

The bundle retains all crate sources, so a change outside the contract and integration dependency graph can rebuild the bundle while skipping those tests.
The planner accounts for the fixture provider launched by OpenTofu as well as Cargo dependencies.
Non-code inputs use the [bundle rules](../../.config/determinator-bundle.toml) and [lifecycle rules](../../.config/determinator-lifecycle.toml), which select the contract and integration steps together.
Unknown inputs select checks; an unavailable explicit base, invalid rules, or failed metadata analysis selects all expensive checks and reports why.
Keep these rules aligned with retained bundle sources, test fixtures, executable dependencies, and build/test configuration.

The same planner also reports image and live-suite decisions:

```sh
cargo run --locked -p nemoclaw-build --no-default-features -- changes plan --base origin/v1 --worktree
```

Its JSON contains `bundle`, `lifecycle` (the contract and integration steps), `images`, and `live`, each with `run` and `reason` fields.
Omit `--worktree` for a clean committed checkout, as CI does; a dirty checkout then selects all checks rather than ignoring local edits.
Image and live-suite decisions do not add those opt-in steps to `cargo ci`.
Rebuild the bundle before explicitly running contract, integration, or live tests after relevant inputs change.

## Test Layers

Put each test in the cheapest layer that can check its behavior, and assert only behavior that the test's crate owns.

| Layer | Checks | Test binaries | `cargo ci` step |
|---|---|---|---|
| Unit | One crate's rules, with in-process fakes | Each crate's library tests and `integration` binary, and every other test not marked `#[ignore]` | `test` |
| Contract | Each provider type through pinned OpenTofu | The ignored tests in `nemoclaw-provider::contract`, `openshell-provider::contract`, and `fabric-provider::contract` | `contract` |
| Integration | The SDK-compiled graph, and SDK and CLI orchestration over a bundle | The ignored tests in `nemoclaw-e2e::integration`, which the `integration` profile selects | `integration` |
| Live | Real Docker engines, kind clusters, and owned remote hosts | Ignored tests that the `live-docker` and `live-kind` profiles select, and the other opt-in tests in `nemoclaw-e2e::e2e` and [live tests](live-tests.md) | `live-docker`, `live-kind`, or none |

### Unit

Unit tests check one crate's rules: configuration parsing and validation, compilation, planning, provider backends, CLI argument and output handling, and the build tool.
On Unix, the build tool's image source-retention tests require Python 3.11 or newer on `PATH` for its standard-library TOML parser; CI installs Python 3.14.
They live in each crate's `src` modules and in its `integration` test binary, `tests/main.rs`; the providers' `schema` binaries also belong here.
In `nemoclaw-e2e` alone, the `integration` binary holds the integration layer instead; the tests it and the `e2e` binary don't ignore still run here.
They use in-process fakes and temporary files and need no bundle; `openshell-provider` and `fabric-provider`, for example, test their backends against the fake OpenShell gateway in `src/fake_gateway_tests.rs` without OpenTofu.
On Unix, the SDK's `integration` binary also runs `Deployment` over a [scripted OpenTofu](../../crates/nemoclaw-sdk/tests/support/scripted_tofu.rs): a shell script in a temporary directory with a bundle's layout and manifest, which logs its calls and replays canned plans and states.
The SDK alone decides the stage order and the unfinished-apply and unfinished-destroy state it saves when an operation stops, so those tests need neither OpenTofu nor `NEMOCLAW_TEST_BUNDLE`.
The shared fakes are:

- [`crates/test-support/http.rs`](../../crates/test-support/http.rs) serves HTTP and Docker-style engine APIs, and [`kube_api.rs`](../../crates/test-support/kube_api.rs) an in-memory Kubernetes API; crates include them as private modules.
- `nemoclaw-test-fixtures` provides a fake OpenShell gateway, the fake `ssh` relay, and an SSH simulator.

Each contract binary's coverage test, such as `every_type_has_a_contract_test`, is not ignored and runs with the unit tests.
A test that needs OpenTofu, a bundle, Docker, or a cluster must be marked `#[ignore]` with the reason, and selected by a nextest profile.

### Contract

A contract test applies one provider type through the OpenTofu that `NEMOCLAW_TEST_BUNDLE` supplies, against fake engines, gateways, model servers, or Kubernetes APIs, and checks what OpenTofu plans, applies, refreshes, and tears down, including after failures.
Each production provider has one `contract` binary under `tests/contract`.
It runs the provider Cargo built from the checkout, so it tests the change without a new bundle; OpenTofu and the other providers it needs come from the bundle.
Write a scenario that passes as a native `tofu test` file in `tests/contract/hcl/`; put a test of a command that must fail in `tests/contract/failures/`, and keep other Rust tests only for what `tofu test` cannot check, such as a saved plan or the state file.
A coverage test in each binary requires a contract test for every type the provider serves.
[Run integration tests](integration-tests.md#contract-tests) describes each binary.

### Integration

An integration test checks the SDK-compiled graph across providers, or runs the SDK or the bundled CLI through a whole lifecycle over a bundle: export, unchanged reapply, interrupted creation, failed readiness, and destroy with retained storage.
Integration tests live in `nemoclaw-e2e`'s `integration` binary, `crates/nemoclaw-e2e/tests/integration`, which holds only tests against local fixtures; the `integration` profile in [`.config/nextest.toml`](../../.config/nextest.toml) selects the whole binary.
Its `hcl/` directory holds the `tofu test` scenarios, which the `hcl_integration` module in `tofu_test/` runs: shared NemoClaw documents, unchanged examples, and authored HCL examples.
Its `rust/` directory holds the `container_service`, `deployment`, `export_observations`, `fabric_deployment`, `multi_agent`, `remote_service`, and `helm_recovery` modules, which keep the SDK and CLI behavior that `tofu test` cannot observe. [Run integration tests](integration-tests.md#integration-tests) says which a check belongs in.
On Unix, `helm_recovery` runs the bundle's OpenTofu and Helm provider against an in-memory Kubernetes API.
[Run integration tests](integration-tests.md#integration-tests) describes the scenarios.

### Live

Live tests use real Docker engines, kind clusters, images, or remote hosts, and touch only resources they own.
`nemoclaw-e2e`'s live tests live in its `e2e` binary, `crates/nemoclaw-e2e/tests/e2e`.
Its [HCL E2E scenarios](live-tests.md#hcl-e2e-scenarios) are in `tests/e2e/hcl`; `hcl_live.rs` runs them and holds their probes.
The `live-docker` profile selects the Docker tests in `nemoclaw-build`, that `e2e` binary, and `nemoclaw-provider`; the `live-kind` profile selects the `e2e` binary's kind HCL E2E scenarios.
Other ignored tests, such as the Brev and hosted-model tests, run only when selected by hand or by the Live / Brev workflow.
[Run live tests](live-tests.md) gives each test's prerequisites and the state it retains.

## Running Each Layer

Run every command from the repository root.
`cargo ci STEP` runs one step after checking the pinned tools.
The default steps are `tools`, `fmt`, `clippy`, `build`, `test`, `schema`, `bundle`, `contract`, and `integration`; `archive`, `live-images`, `live-docker`, and `live-kind` run only when named.

| Layer | All of it | One binary or test |
|---|---|---|
| Unit | `cargo ci test` | `cargo test -p CRATE` |
| Contract and integration | `cargo ci bundle`, then `cargo ci contract` and `cargo ci integration` | `NEMOCLAW_TEST_BUNDLE=$PWD/dist/PLATFORM cargo test -p CRATE --test BINARY FILTER -- --ignored` |
| Live | `cargo ci bundle`, then `cargo ci live-docker` or `cargo ci live-kind` | See [live tests](live-tests.md) |

`cargo ci test` runs the tests not marked `#[ignore]` with the `ci` nextest profile, then the doctests, which nextest does not run.
With `--partition`, such as `cargo ci test --partition slice:2/2`, it runs that nextest partition, and runs the doctests only in the first one; CI runs the unit tests in two partitions.
The `ci` profile runs at most eight tests concurrently, retries nothing, and finishes the remaining tests after a failure.

The contract, integration, and live tests read `NEMOCLAW_TEST_BUNDLE`, the absolute path of a bundle.
A test that starts a fixture executable from `nemoclaw-test-fixtures` or `nemoclaw-fixture-provider`, such as the fake `ssh` relay or the fixture provider, reads `NEMOCLAW_TEST_FIXTURES`, the absolute path of the directory that holds them.
Run from the checkout, `cargo ci test`, `contract`, and `integration` first build every workspace target and set `NEMOCLAW_TEST_FIXTURES` to `target/debug`, where Cargo puts a build's executables.
`cargo ci bundle` builds the host platform's bundle in `dist/PLATFORM`, such as `dist/linux_arm64`, and `cargo ci contract` and `cargo ci integration` pass that path to their profiles.
Local contract and integration runs use the available CPU count, with a minimum of four workers and a maximum of eight.
CI keeps the profile's four-worker setting; the runner treats `CI` or `GITHUB_ACTIONS` being set as CI.
An explicit `NEXTEST_TEST_THREADS` value takes precedence, for example `NEXTEST_TEST_THREADS=4 cargo ci integration`.
The same selection applies when contract and integration tests run through `cargo ci` or from an archive; other test layers retain their profile settings.
A contract test runs the provider built from the checkout, but an integration test runs the bundle's CLI and providers: rebuild the bundle after changing them.
[Run integration tests](integration-tests.md#opentofu-and-bundle-lifecycle) covers the fixture executables that a single `cargo test` needs.

`cargo ci live-docker` needs Linux with a local Docker engine that uses the [containerd image store](../../docs/build-deploy/build.md).
It pulls the pinned OpenShell and Ollama images; downloads the pinned OpenShell CLI by checksum into `.tools`; builds the OpenClaw and Hermes agent images, the reference dummy image, and an image derived from the dummy under a fresh `nc-live-` prefix; and writes gateway documents, and binds each selected Docker HCL E2E case, with fresh UUIDs, ports, and subnets in `172.30.200-254.0/24`.
It runs the `live-docker` profile in one nextest command for the tests that need no gateway document, one for each of the two gateway tests with its own document, then one for each selected HCL E2E case, `docker-dummy` and `docker-openclaw-hermes-interfaces`, with its bound document: five commands when both cases are selected.
`--hcl-cases` names the cases, as CI passes the plan's selection; without it, every case that the suite runs is selected.
Every test in the profile uses Docker, so all of them run one at a time, in its `docker-engine` test group.
Afterward it removes every container, volume, and network labelled with the documents' UUIDs, any sandbox objects in their gateways' OpenShell namespaces, and the images it built, whether or not the tests pass; pulled images remain.
When the tests pass, the step fails if OpenShell left a sandbox object or if it cannot list or remove an object labelled with one of those UUIDs.
It requests no inference from a model server and needs no GPU or credentials.

`cargo ci live-kind` needs native Linux with Docker Buildx and the [containerd image store](../../docs/build-deploy/build.md#building-agent-images).
It downloads the pinned kind executable by checksum into `.tools`, creates a cluster with a fresh `nc-live-` name, installs the pinned Agent Sandbox release, and loads an agent image built from this checkout by digest.
It starts a registry that requires a login on the kind network and pushes that image to it for the scenario.
It then runs the `kind-kubernetes-development` and `kind-kubernetes-oidc` HCL E2E scenarios, one after the other, which need no Helm CLI.
It deletes the cluster and its image tag whether or not the tests pass; set `NEMOCLAW_KEEP_KIND_CLUSTER` to any value to keep the cluster for inspection.
[Run live tests](live-tests.md#kubernetes-gateway-without-the-helm-cli) describes what each test checks.

To build the live images once for both suites, run `cargo ci live-images`.
It builds the OpenClaw and Hermes agent images and the reference dummy image under `nc-live-images`, saves them to `.build/ci/live-images.tar.zst` through the `zstd` command, and removes the local names.
It also saves the OpenClaw image alone to `.build/ci/live-images-openclaw.tar.zst`, which CI uploads for the GPU HCL cases that run only OpenClaw, since the GPU runner downloads artifacts slowly.
The command exports directly from Docker's local containerd store before compression.
This requires Docker to report its containerd address and namespace, `sudo -n ctr` access, and temporary disk space for the uncompressed archive.
The archive retains the image contents, names, digests, and attestations; the job logs archive size and export, compression, and cleanup timings.
On GitHub Actions, each image's build imports the layers, including builder stages, that an earlier run saved to the Actions cache under `live-images-IMAGE-ARCH`; see [CI caches](#ci-caches).
Then pass `--images .build/ci/live-images.tar.zst` to `cargo ci live-docker` or `cargo ci live-kind`: each loads the archive and names the images it needs under its own fresh prefix instead of building them, so its cleanup still removes only what it created.

Instead of either, `--images-commit COMMIT` pulls the OpenClaw, Hermes, and reference images that a `v1` commit pushed to `ghcr.io/nvidia/nemoclaw/v1-ci`, after `docker login ghcr.io`.
`cargo run -p nemoclaw-build -- changes live-images --base REV` names such a commit: the newest of the latest 30 on `REV`'s first-parent history that pushed all three images for both architectures, provided the image rules find no change between it and `HEAD`.

## CI Wall-Clock Time

The cost of CI is the time engineers wait for it.
An engineer waiting for checks costs about $200 to $300 an hour, while GitHub's standard hosted runners are free for this public repository.
Spend runner capacity to shorten the wait: more parallel jobs, more partitions, and more caching are worth it whenever they make results arrive sooner.
Never lengthen the critical path without measuring the change.

### Push-to-Green and the Critical Path

Measure push-to-green: the time from a push to every [required check](#how-ci-runs-the-tests) passing, across `CI / Bundle`, `CI / Images`, `CI / Dependencies`, and `CD / Documentation`.
Each `Test / PLATFORM` check waits for all four platforms, so every one of them reports after the slowest platform's last job.
The critical path is the chain of jobs, linked by their `needs`, that ends last.
Time spent off that path doesn't change push-to-green; time added on it does.

For example, over 22 pull request runs and 15 `v1` pushes in November 2026, a pull request took a median of about 15 minutes to turn green and about 41 at the 90th percentile; a `v1` push took about 27 and 53.
A pull request's critical path was split almost evenly among three branches of about 14 minutes each: Windows' bundle build and integration partitions; Linux's bundle, live images, and kind tests; and macOS's bundle and integration partitions with their runner queue.
Shortening one of these branches alone therefore barely moved push-to-green.
A `v1` push's critical path ran through Linux AMD64's GPU cases, which finished 8 to 12 minutes after every other job.

### Causes to Watch

The slowest of those runs lost their time outside any test step:

- Concurrency queuing on `v1` pushes: `CI / Bundle` doesn't cancel `v1` push runs, so a push's run waits for the previous push's run to finish, up to 39 minutes in those measurements; a newer push replaces a waiting run, and `CI / Bundle` never runs on that commit. `CI / Images` cancels superseded push runs, so an intermediate `v1` commit gets no `Build` result. Each GPU case also waits for the same case's job in any earlier run.
- Runner queues: a job starts only when a runner picks it up. The macOS runners queued for 5 to 7 minutes at the 90th percentile and up to about 15, and the self-hosted GPU runner up to about 13; hosted Ubuntu and Windows runners rarely queued.
- GPU runtime image builds: each GPU case builds its model runtime images on the GPU runner, in every run, which took about 4 minutes at the median.
- Cold caches: a new month, a toolchain change, or a profile change in `.cargo/config.toml` starts a fresh [dependency cache](#ci-caches), and pull requests restore only `v1`'s caches; the first runs after a change spent 20 to 30 minutes in a single build.
- Flaky reruns: a rerun repeats the failed job's wait and the time before it starts, and after its producers' artifacts expire, the [whole workflow's](#archives).
- Serial `needs` chains: a job waits for every job it needs, even when it uses none of their outputs. `E2E build images` downloads no artifacts but waits for `Build bundle`, because the E2E workflow that contains it needs the build and bundle jobs.

### Shortening It

- Partition and parallelize: split a long job or step across runners instead of adding to it, as Windows runs a third integration partition.
- Cache what a job would otherwise rebuild or download; see [CI caches](#ci-caches).
- Keep `needs` chains short: a job should need only the jobs whose outputs it uses, and independent work should start in parallel.
- Move a check to the cheapest [layer](#test-layers) that observes it, and keep live suites, whose Docker tests and kind scenarios run one at a time, to what needs a real engine or cluster.
- Fix a flaky test or job when you see it, or file a `v1` issue with the failing run; don't rerun until it passes.

### Measuring a Workflow Change

Compare several runs of the same kind before and after the change, since queues vary: pull requests or `v1` pushes, with the same selected checks and warm caches.
List a run's times and each job's with the GitHub API:

```sh
gh api repos/NVIDIA/NemoClaw/actions/runs/RUN_ID --jq '.created_at, .updated_at'
gh api "repos/NVIDIA/NemoClaw/actions/runs/RUN_ID/jobs?per_page=100" --paginate \
  --jq '.jobs[] | "\(.created_at) \(.started_at) \(.completed_at) \(.name)"'
```

- The run's `created_at` is when the push created it; the time until its first job's `created_at` is spent waiting in a concurrency group.
- A job's `created_at` to `started_at` is its runner queue, and `started_at` to `completed_at` its work; each job's `steps` carry `started_at` and `completed_at` too.
- The last required check's `completed_at` ends push-to-green; repeat for each workflow that reports a required check.

Follow the latest-finishing job back through its `needs` to find the critical path.
Within a `cargo ci` step, the [build and test timing reports](#timing-reports) show where its time goes.
Report the before-and-after push-to-green and critical-path times in the pull request.

[Test budgets](#budgets-and-per-test-limits) bound only the test steps, measured from their JUnit reports.
Compilation, image builds, cluster setup, artifact transfers, and runner and concurrency waits are in no budget, and no check fails when push-to-green grows: a change can pass every budget and still lengthen the wait.

### Local Waiting Time

Waiting for local checks costs the same as waiting for CI.
Run the narrowest checks that [local validation](#choosing-local-validation) allows.
Plain `cargo ci` skips the bundle, contract, and integration steps that its plan doesn't select, and `cargo ci --dry-run` shows the selection before you wait for it; it runs the selected steps one after another, while CI runs each platform's layers in parallel.

## Budgets and Per-Test Limits

[`.config/test-budgets.yaml`](../../.config/test-budgets.yaml) gives each test step a wall-clock budget and a limit for any one test, in seconds:

| Step | Budget bounds | Wall budget | Per-test limit | Nextest stops a test after |
|---|---|---|---|---|
| `test` | Each partition's `ci` nextest run, without the doctests | 30 s | 8 s | 24 s |
| `contract` | Each partition's nextest run | 300 s | 16 s | 32 s |
| `integration` | Each partition's nextest run | 300 s | 90 s | 180 s |
| `live-docker` | Its nextest commands together | 360 s | 180 s | 360 s |
| `live-kind` | Its nextest commands, one per HCL case, together | 300 s | 180 s | 360 s |

Its `binaries` section budgets each provider's contract binary by its nextest name: the binary's test times summed across a platform's contract partitions, and a limit for any one of its tests:

| Binary | Summed budget | Per-test limit | Nextest stops a test after |
|---|---|---|---|
| `fabric-provider::contract` | 32 s | 16 s | 32 s |
| `nemoclaw-provider::contract` | 82 s | 12 s | 24 s |
| `openshell-provider::contract` | 180 s | 12 s | 24 s |

Budgets are measured from each step's JUnit report, so compilation, image builds, and cluster setup do not count; see [CI wall-clock time](#ci-wall-clock-time) for the rest of the wait.

### Where Budgets Are Enforced

Budgets fail a run only on the Linux GitHub Actions runners, where `GITHUB_ACTIONS` is set; macOS, Windows, and local runs report them without failing.

- Each unit, contract, and integration partition and each live suite check their step budget when the step ends; a step over its wall budget, or with a test over its limit, fails and names each offender with its time and limit.
- Each platform's `Contract timing report` and `Integration timing report` jobs check the binary budgets, because a binary's tests run in several partitions.
  The macOS and Windows reports run on a Linux runner without `GITHUB_ACTIONS`, so they report the budgets without failing, and their `Test / PLATFORM` checks do not wait for them.
  `cargo ci --full`, `cargo ci contract`, and `cargo ci integration` run each whole suite in one step and report them there too.
- Nextest stops a test on every platform: each profile reports a test as slow at its per-test limit and stops it at a multiple of the limit, three times for the `test` step and twice for the others.
  An override in the binary's step profile does the same for each budgeted binary with that binary's limit.
  Nextest marks a stopped test `TIMEOUT` and fails the step.

The multiple leaves a margin for the platforms that only report budgets; the `test` step uses three because its slowest test takes nearly twice its limit on macOS.

### Changing a Budget

Lower a budget when a change makes its step faster; a pull request that raises one must give the reason.
When you change a per-test limit, change the matching `slow-timeout` period in [`.config/nextest.toml`](../../.config/nextest.toml) as well: the step's profile, or the binary's `binary_id` override in the `contract` profile.
To budget another test binary, add it under `binaries` and add an override with the filter `binary_id(=NAME)` to the `contract` profile; binary budgets apply only to the contract step.
Then run the tests that keep the two files in sync:

```sh
cargo test -p nemoclaw-build --test integration ci::
```

They fail when a step that writes a JUnit report has no budget, a provider's contract binary has no budget, a `slow-timeout` period differs from its limit, a profile or override stops a test later than three times its limit, or a budgeted binary and an override lack each other.

## Timing Reports

### Build Timings

`cargo ci build` enables Cargo's stable HTML timings with `cargo build --locked --workspace --all-targets --timings` (the default dev profile, including test executables).
The bundle's Rust compilation uses `cargo build --locked --release --target TARGET --timings` for the CLI and three providers.
Neither command changes the package graph or features for measurement.

In `CI / Bundle`, download `build-workspace-PLATFORM-ATTEMPT` or `build-bundle-PLATFORM-ATTEMPT` from the workflow run's artifacts and open `cargo-timing.html` in a browser; Windows uploads one `build-bundle-windows_amd64-PART-ATTEMPT` per bundle part instead.
CI retains these artifacts for 14 days, including any reports Cargo writes before a build fails.
Each job clears cached timing reports before building, so an early failure cannot upload an older build's report.
The jobs upload separately, before later commands can replace a report; timestamped HTML copies are retained too.
Locally, Cargo writes both reports under `target/cargo-timings`; `cargo-timing.html` names the latest invocation, and older timestamped reports remain.

The job summary also reports the existing `build` and `bundle` step wall durations and whether each passed or failed.
The build duration covers the workspace build; the bundle duration includes its build tool compilation, downloads, release compilation, assembly, and verification.
Both exclude the runner's initial tool installation and compilation of the CI runner itself.
These measurements are report-only and do not affect test budgets.

Use the HTML's compiler/build metadata, compilation units, dependency paths, build scripts, and concurrency graph to compare where compilation time goes.
Use the workflow commit, platform, job, and attempt to identify the run, and compare the same command/profile and cache conditions.
The workspace build follows Clippy, so it is not a cold build; a cache action hit does not prove Cargo reused every unit.
Cargo timings are not a standalone linker profiler and do not explain downloads, bundle assembly, or all causes of elapsed time.
See [Cargo's timing guide](https://doc.rust-lang.org/cargo/reference/timings.html) for graph interpretation.

### Test Timings

After each test step, `cargo ci` prints where the time went and, in GitHub Actions, adds it to the job summary:

- the step's test count, wall time, and summed test time;
- the 15 test modules with the most summed time, each with its binary, test count, and slowest test, and the 15 slowest tests;
- the step's budget, whether this run enforces it, and each total or test over it.

A unit, contract, or integration partition reports only its own tests.
Each platform's `Contract timing report` and `Integration timing report` jobs report the whole suite from the partitions' JUnit reports: each partition's latest attempt, naming any partition without a report, with the slowest partition's time as the suite's wall time.
It also shows each budgeted binary's test count, summed time, and slowest test against its budget, with its tests from every partition.
To produce the same report locally, download the `STEP-PLATFORM-SHARD-ATTEMPT` artifacts of the `contract` or `integration` step into subdirectories of one directory and run:

```sh
cargo run -q --locked -p nemoclaw-build --no-default-features -- suite-timing integration DIRECTORY --platform linux_amd64 --shards '[1, 2]'
```

CI keeps each step's JUnit report, with per-test durations, for 14 days in the `test-PLATFORM-SHARD-ATTEMPT`, `contract-PLATFORM-SHARD-ATTEMPT`, `integration-PLATFORM-SHARD-ATTEMPT`, `live-docker-PLATFORM-ATTEMPT`, and `live-kind-PLATFORM-ATTEMPT` artifacts; the `live-docker` report joins its nextest commands.
The live reports hold outcomes and times only, so they can be shared as a run's result; failing tests' output stays in the job log.
Each [HCL E2E scenario](live-tests.md#hcl-e2e-scenarios) also prints the time of each of its run blocks and, in GitHub Actions, adds them to the job summary.
The rest of what a live run used is on its GitHub run: the commit and runner, and the `bundle-PLATFORM-COMMIT-ATTEMPT` and `live-images-PLATFORM-COMMIT-ATTEMPT` artifacts it downloaded, each with its digest, or the `v1` commit whose images it pulled, which the plan's summary names.
Versions it pinned are in the repository at that commit, and known gaps are in [current limits](../../docs/resources/limits.md).

## How CI Runs the Tests

The automatic workflows accept pull requests to any base branch, including stacked `v1` PRs targeting another feature branch.
The PR must include these workflow changes; update existing stacks from `v1` to enable them.
Image and live-suite checks still use their change analysis to decide which steps to run.
Documentation previews publish only for PRs targeting `v1`.

| Workflow | Checks |
|---|---|
| CI / Bundle | `Test / linux_arm64`, `Test / linux_amd64`, `Test / darwin_arm64`, `Test / windows_amd64`; each platform's jobs start with their test layer, such as `linux_amd64 / Contract tests 1 of 1` or `linux_amd64 / E2E / E2E Docker tests` |
| CI / Images | `Build / linux_arm64`, `Build / linux_amd64`; beside them, `Build / llama.cpp runtime / linux_arm64` and `Build / llama.cpp runtime / linux_amd64` build the llama.cpp runtime image and run its server's and supervisor's version commands |
| CI / Dependencies | `Policy`, `Python scripts` |
| CD / Documentation | `Validate`, then PR preview, staging, or release publication |
| Live / Brev | In CI / Bundle's `brev` suite: image build and VM preparation alongside Linux AMD64's bundle build, then lifecycle qualification and verified VM deletion |
| E2E / Colossus runner connectivity | Manual, on `v1` only: runs `true` without credentials on `runner_label` (default `colossus-gb300`) |

The `v1` ruleset requires the four `Test /` checks, the two `Build /` checks, `Policy`, and `Validate`; `Python scripts` isn't required.
Keep the ruleset's check names aligned when renaming jobs; workflow display names do not identify required checks.
A `Test / PLATFORM` check succeeds only when every job of that platform that runs succeeds: its unit, contract, and integration tests, and, on Linux, its selected live suites. A job the plan doesn't select is skipped.

Each bundle or image workflow calls the [shared planner](../../.github/workflows/validation-plan.yml) once on Linux before its platform jobs.
It builds without the SDK, protoc, or nextest, reads old and new Cargo metadata once, and reports the decisions in the job summary.
Bundle push and manual runs select all checks; PRs use impact analysis.
Image pushes retain impact analysis, and manual image runs select all checks.
A failed analysis selects all expensive checks; a failed planning job prevents the required checks from passing.

### Workflow Rules

Two tests in `nemoclaw-build`'s `workflows` module check what a workflow run would only reveal when it is skipped or refused:

- A job that needs a job with an `if:` must check that job's `needs.JOB.result` or use a status function such as `!cancelled()` in its own `if:`. GitHub otherwise skips it whenever the needed job is skipped, and counts the skipped job as passing.
- Every action from outside GitHub and NVIDIA must come from a verified creator or be a commit listed in [`.github/allowed-actions.yml`](../../.github/allowed-actions.yml). The organization allows other actions only at the commits it lists, and a workflow that names any other action fails to start. List a commit only after an organization admin allows it.

### Jobs of One Platform

On Linux, `Unit build and test` and `Build bundle` run on Ubuntu 22.04, the oldest supported Linux, and `Build bundle` then runs `nemoclaw-build check-glibc --minimum 2.35`, which fails if any bundle executable needs a non-weak glibc symbol version newer than 2.35.
The other jobs run on Ubuntu 24.04: executables built against an older glibc run on newer ones, but not the other way around.

Each platform in [CI / Bundle](../../.github/workflows/rust.yml) runs [one workflow](../../.github/workflows/bundle-platform.yml) on its own runners, whose job names start with their test layer:

1. `Unit build and test` runs `cargo ci fmt`, `clippy`, `build`, `test --partition slice:1/2`, and `schema`; it runs `archive` only when contract, integration, or live jobs need the executables. On Linux, it runs `docker buildx version` before the tests, so the Bake tests' first Docker call doesn't spend their time limit reading the Docker CLI and Buildx from disk. At the same time, `Unit tests 2 of 2` builds the test executables on its own runner and runs `cargo ci test --partition slice:2/2`.
2. When the plan selects a bundle, `Build bundle` runs `cargo ci bundle` on a separate runner at the same time. On Windows, where one runner compiles the bundle slower than the unit job runs, three `Build bundle` jobs for the CLI, the NemoClaw providers, and the OpenShell and Fabric providers instead compile their release executables in parallel with `cargo ci bundle --executables`, and the CLI job also builds the build tool. `Build bundle` then assembles them with `nemoclaw-build bundle --prebuilt`, which compiles nothing.
3. When selected and the build and bundle jobs finish, `Contract tests N of M` and `Integration tests N of M` run their layers in partitions. On Linux, `Contract timing report` and `Integration timing report` then report each whole suite and check the binary budgets; `CI / Bundle` reports the macOS and Windows suites in `PLATFORM / Contract timing report` and `PLATFORM / Integration timing report`, on Ubuntu, after the platform's jobs finish.
4. On Linux, when the plan selects the live suites, `E2E build images` runs `cargo ci live-images` at the same time as the build and bundle jobs, because it reads neither job's artifacts. When all three finish, the [E2E platform workflow](../../.github/workflows/e2e-platform.yml) runs `E2E Docker tests` and `E2E Kubernetes (kind) tests` from the platform's archive, bundle, and live images. Linux AMD64 also runs `E2E HCL CASE` for the selected HCL cases that use NVIDIA hosted inference, and `E2E GPU` for those on the NVIDIA GPU runner, from the same artifacts; see [live suites](#live-suites).

When a pull request changes no image input since a `v1` commit that pushed the live images, the plan names that commit instead, and the live jobs pull its images; a fork's pull request, which cannot read the package, builds them.

Each platform starts its jobs after its own build; it does not wait for the other platforms.
Superseded pull request runs are cancelled, and their checks report as cancelled rather than failed.
In CI / Bundle and the image workflow, each `v1` push runs in its own concurrency group: it starts without waiting for an earlier push and is never cancelled, so every `v1` commit gets its checks and pushed images.
GPU case jobs from several pushes wait in the GPU runner queue; none cancels another.
Manual runs are not cancelled; documentation and dependency pushes finish.

### Partitions

Each platform runs the unit suite in two nextest slice partitions, the contract suite in one, and the integration suite in two, or three on Windows, each on its own runner with four test slots.
A slice partition deals the sorted test list round-robin, which spreads slow tests that sort next to each other across partitions.
Adding or removing a test moves later tests to other partitions.

### Archives

`cargo ci archive` writes the files that let other runners run the tests without compiling, one nextest archive per test layer so each job downloads only the tests it runs:

- `.build/ci/contract.tar.zst`, the test binaries that the `contract` profile selects;
- `.build/ci/integration.tar.zst`, the test binaries that the `integration` profile selects;
- `.build/ci/live.tar.zst`, on Linux only, the test binaries that the `live-docker` and `live-kind` profiles select;
- `.build/ci/e2e`, on Linux only, a copy of `nemoclaw-e2e`'s `e2e` test executable from that archive, at the path nextest lists for it, which the hosted and GPU HCL case jobs run alone;
- `.build/ci/lifecycle-inputs.tar`, which keeps the executable permissions of the pinned tools, the `nemoclaw-build` executable, and the fixture executables, which it unpacks into `target/debug`, where `NEMOCLAW_TEST_FIXTURES` points.

Each archive also holds the executables that its test binaries' packages build.
The build job uploads each file as its own artifact, and the bundle job uploads `dist/PLATFORM` separately.
Contract, integration, and live jobs download the inputs, their own layer's archive, and the bundle, the live jobs also the live images archive, and each then runs `.build/ci/nemoclaw-build ci STEP --archive-file .build/ci/LAYER.tar.zst`, which remaps the tests' working directories to the checkout and extracts the tests into `.build/ci/extracted`.
CI keeps these artifacts for one day; rerunning a failed job reuses its producers' artifacts, even from an earlier attempt, and after they expire the complete workflow must be rerun.

### Running a Contract or Integration Partition

`cargo ci --full` runs the complete contract and integration suites, each in one step.
After `cargo ci build` and `cargo ci bundle`, select one partition explicitly:

```sh
cargo ci integration --partition slice:1/2
```

To reproduce the archive handoff, run `cargo ci archive` after building.
Copy `.build/ci/lifecycle-inputs.tar` and `.build/ci/integration.tar.zst` into `.build/ci` and the bundle into `dist/PLATFORM` in a separate checkout of the same revision on the same operating system and architecture, then run:

```sh
tar -xf .build/ci/lifecycle-inputs.tar
.build/ci/nemoclaw-build ci integration --archive-file .build/ci/integration.tar.zst --partition slice:1/2
```

The checkout must be at the path where the tests were built: they read fixtures through paths that `env!("CARGO_MANIFEST_DIR")` fixed at compile time, which the remap does not change.

The worker compiles nothing and writes JUnit timings under `target/nextest/integration`; repeating the command overwrites the extracted files.
`--partition` requires the `test`, `contract`, or `integration` step, `--archive-file` requires `contract`, `integration`, `live-docker`, or `live-kind`, and `--images`, `--images-commit`, and `--hcl-cases` require `live-docker` or `live-kind`, so none of them narrows plain `cargo ci`.

### Windows

[`Fixture::engine`](../../crates/test-support/http.rs) serves a fake engine where the platform's local engines listen: a Unix socket, or on Windows a named pipe, `npipe:////./pipe/NAME`, which the providers and CLI that OpenTofu and the SDK start reach too.
Tests that need an SSH engine reach a fixture's loopback port through the fake relay `nemoclaw-fixture-ssh`, which forwards `ssh://127.0.0.1:PORT`; on Windows, the `contract` and `integration` steps put it first on `PATH` as `ssh`.
Use `Fixture::engine` for a fake engine so that the test runs on every platform; compile a test that needs a Unix-only fixture only on Unix with `#[cfg(unix)]`.

### Live Suites

`E2E Docker tests` and `E2E Kubernetes (kind) tests` run on the Linux platforms only, from that platform's archive, bundle, and live images, after enabling Docker's containerd image store on the runner.
They run whenever the shared validation plan selects them: on every `v1` push and manual run, and on a pull request whose changes reach the live build.
On a pull request, the plan compares the merge commit with its first parent, the PR base.
A file inside a crate counts when that crate is in the live build: the packages whose tests run live and the CLI and providers the bundle ships, with their dependencies.
[Path rules](../../.config/determinator-live.toml) classify other files; unclassified files, dependency or feature changes in the live build, and failed analyses run the suites.
After committing, run `cargo run -p nemoclaw-build --no-default-features -- changes live --base origin/v1` to see the decision.

When the plan selects the live suites, it also selects the [HCL E2E cases](live-tests.md#hcl-e2e-scenarios) to run: on a pull request, those its changes affect, as below; on `v1` pushes and manual runs, every case.
Each case runs where its document's needs are met, in this order:

| The case document | Runs in |
|---|---|
| Has a `kubernetes` gateway runtime | `E2E Kubernetes (kind) tests` |
| Has an `openshift` gateway runtime | No CI job; [by hand on OpenShift](live-tests.md#openshift-gateway) |
| Declares a `vllm` or `ollama` service | Live / HCL on the NVIDIA GPU runner |
| Reads `NVIDIA_INFERENCE_API_KEY` | `E2E HCL CASE`, on NVIDIA hosted inference |
| None of these | `E2E Docker tests` |

kind can't stand in for OpenShift: a managed `openshift` gateway gets its `fsGroup` only from OpenShift.
Only the hosted and GPU jobs receive the key, and a GPU case receives it only when it reads it.
`E2E Docker tests` binds each case to its run with code in `run_ci/live_docker.rs`, and refuses a case without it.
`E2E Kubernetes (kind) tests` runs only HCL cases, so it is skipped when none is selected; `cargo ci live-docker` and `live-kind` take the selection as `--hcl-cases`, and without it run every case placed on them.

Whenever the plan selects a hosted case, Linux AMD64 runs it as `linux_amd64 / E2E / E2E HCL CASE`, from the same test archive, bundle, and live images as the live suites, except on a fork's pull request, which cannot use the inference secret.
On `v1` pushes and manual runs, it also calls [Live / HCL](../../.github/workflows/hcl-e2e.yml) as `linux_amd64 / E2E / E2E GPU` for the GPU cases; NVIDIA's GPU runners refuse `pull_request` jobs. Separately, CI / Bundle's `hardware` suite runs on bot-admitted copied PR branches and runs the affected qualified hardware cases for open, non-draft v1 PRs. Those runs report no `Test /` checks and remain outside merge requirements; see [hardware dispatch](live-tests.md#dgx-station-and-spark-on-colossus).
Live / HCL's `Cases` job lists the cases and fetches the model runtime images' pinned sources, and each case's job runs the same test archive, bundle, and live images as the hosted cases, which the GPU runner can run because CI / Bundle builds them on Ubuntu 22.04. Each case's job builds the model runtime images that `cargo images runtimes` lists for it from the case's services.
Dispatch CI / Bundle with `suite=hcl` to run the hosted or GPU cases alone: it builds the target platform's bundle, test executable, and agent images on Ubuntu 22.04 from the dispatched branch, without that platform's other suites, and calls Live / HCL with them.
A Station or Spark case's job downloads them on its runner before it runs the case, since two machines share that runner's label; Actions artifacts move at 3-8 MB/s there.

To see which live HCL cases a pull request affects, such as before dispatching the GPU cases, which its CI does not run, run from a clean checkout of its commit:

```sh
cargo run --locked -p nemoclaw-build --no-default-features -- changes cases --base origin/v1
```

The JSON names the commit analyzed, the selected case IDs, each case's reason, the selected cases by where they run, and those that read the NVIDIA API key; `--all` selects every case without analysis.
A live case is a scenario in `crates/nemoclaw-e2e/tests/e2e/hcl/tests/` with a case document of the same name in `crates/nemoclaw-e2e/cases/`.
A row of [`examples/scenarios.md`](../../examples/scenarios.md) that is on and whose platform is `STATION` or `SPARK` is also a live case, named by its deployment ID in lowercase, such as `station-hermes`: it deploys the row's example through a shared scenario in `crates/nemoclaw-e2e/tests/e2e/hcl/scenarios/` on its platform's runner.
Its example selects only its case, and the page and the shared scenario select all of the page's cases.
The command compares the checkout's `HEAD` with its merge base with `--base`, so changes the base made since don't count.
A case's own document and scenario select only that case.
A model runtime image's directory, `image/vllm/` or `image/ollama/`, selects the cases whose documents declare a service of that `kind`, and `image/supervisor/` selects every case that runs either.
Any other change that selects the live suites selects every case, and a failed analysis selects every case.
Add `--add CASE` for each reviewed recommendation; it adds the case and removes none.

A selected live suite that fails fails its platform's `Test / PLATFORM` check.
The Brev workflow remains opt-in; see [live prerequisites and cleanup](live-tests.md#bare-brev).

## Dependency Policy

The [dependency workflow](../../.github/workflows/dependencies.yml) runs on every pull request, including stacked PRs, so its check is available even when no dependencies change.
Pushes to `v1` run it only when Rust manifests, lockfiles, the toolchain, the policy, the scripts in `tools/ci`, or the workflow change.
It runs once on Linux, outside the native build matrix, without compiling the workspace or caching build artifacts.
The [policy](../../deny.toml) permits the current license inventory and the explicitly listed Git sources; dependency revisions remain pinned in the manifests and lockfile.

Install cargo-deny 0.20.2 once, then run from the repository root:

```sh
cargo install cargo-deny --version 0.20.2 --locked
cargo deny --locked check licenses sources
cargo deny --locked check advisories
```

Advisories use the current advisory database and are a manual check, separate from the required license and source checks.
The workflow runs the advisory step only on a manual run, such as `gh workflow run dependencies.yml --ref v1`. GitHub's documentation requires a dispatched workflow on the default branch, but GitHub has accepted dispatches of this one from other branches.
There is no scheduled advisory run on this branch.
A denied license or source requires reviewing the dependency and policy; do not add blanket exceptions to make the check pass.

## Image Source Checks

Use the [agent image build prerequisites](../../docs/build-deploy/build.md#building-agent-images); the Bake tests need Docker Buildx but no host Python.
For the full Linux ARM64 checks, run from the repository root:

```sh
cargo test -p nemoclaw-build --test integration bake::
cargo images fetch
AGENT_PLATFORM=linux/arm64 docker buildx bake --check dummy agents ollama-proxy
AGENT_PLATFORM=linux/arm64 docker buildx bake check
```

The first command checks, without a Docker daemon or prebuilt source tree, that Bake defaults to the host platform and rejects others, and that Dockerfiles copy remote files only from pinned sources.
`cargo images fetch` places the remote files that `versions.json` pins under `imageSources` in `.build/image-sources`, where Bake reads them, even to check the Dockerfiles.
Docker checks the selected build instructions; the `check` group runs Ruff lint/format checks, reference-backend tests without Fabric, and generic runtime behavior tests against Fabric's installed fixture adapter.
Behavior tests run with networking disabled; downloading build dependencies still needs network access.
Checks produce build cache entries and no tagged runtime images.

For a faster Python source edit loop with host uv:

```sh
uv tool run --from ruff==0.17.5 ruff check .
uv tool run --from ruff==0.17.5 ruff format --check .
```

Use `ruff format .` through the same pinned uv invocation to apply formatting.
The scope includes image Python and retained integration fixtures.
Native adapter implementation and its behavioral tests live in Fabric and use Fabric's checks.

The [image workflow](../../.github/workflows/images.yml) builds the selected platform's agent images plus the proxy, verifies retained source hashes, and checks installed discovery metadata.
It first builds and qualifies the separate dummy image, whose qualification also starts, invokes, and stops one runtime with NemoClaw's test adapter through `fabric-agent-ctl`, in a network-isolated, read-only container.
It then qualifies every selected agent image with [`cargo images qualify`](../../crates/nemoclaw-build/src/images.rs).
In each image, offline and as the image's own user, it checks:

- the runtime command is `fabric-agent-ctl`, and it is executable;
- the retained sources match the image's provenance;
- the image runs as 10001:10001, and `/sandbox` and `TMPDIR` are laid out as OpenShell needs on Kubernetes and OpenShift;
- the image carries no package installer and no build toolchain;
- a Hermes image carries `aiohttp`, Hermes's built dashboard, and its built TUI bundle, which Hermes's API server, dashboard, and browser chat need.

The build itself refuses a catalog label that differs from what the image installs, and installs only what Fabric's lock pins.
NemoClaw doesn't run Fabric's native adapters; their behavior is Fabric's to test.
Use the [reference image procedure](agent-image-maintenance.md#qualifying-the-reference-contract-image) to run these locally.

The image workflow obtains its image decision from the shared validation plan and skips image steps when their inputs are unaffected; the `Build` checks still report.
On `v1` pushes that build images, it then pushes the checked agent and proxy images, and the reference image the live suites pull, by digest to `ghcr.io/nvidia/nemoclaw/v1-ci:<image>-<commit>-<arch>`, an internal package that releases promote from ([#13516](https://github.com/NVIDIA/NemoClaw/issues/13516)).
It pushes only to packages that already exist and aren't public, and otherwise skips with a warning; see [provisioning the packages](releases.md#provisioning-the-packages).
The job summary lists each digest and how long its push took.
A following job keeps the images of the latest ten commits and deletes older ones; releases keep their own copies of the images they promote.
A failed planning job fails those checks instead of skipping them.
A file inside a crate counts when that crate is part of the image build: `nemoclaw-build` without default features, or the Ollama proxy, with their dependencies.
[Path rules](../../.config/determinator-images.toml) classify other files by the `.dockerignore` build context.
Unclassified files, dependency or feature changes in the image build, manual runs, and failed analyses run every step.
Commit, then run `cargo run -p nemoclaw-build --no-default-features -- changes images --base origin/v1` to see the decision and its reason.
Rust- or documentation-only pushes skip that image build; their schema and descriptor consumption tests remain in the Rust suite.
These checks use no live credentials and do not establish GPU inference or live OpenShell deployment behavior.

## Provider Schema Snapshots

Each production provider's `tests/schema.txt` records its schema: the provider configuration and every resource and data source, with their attributes, types, constraints, and descriptions.
The provider's `schema_matches_the_checked_in_snapshot` test renders the compiled schema and fails with a unified diff when the two differ.
After an intended schema change, regenerate the snapshot and commit it with the change, so the review shows the schema diff:

```sh
NEMOCLAW_REGENERATE_FIXTURES=1 cargo test -p nemoclaw-provider --test integration schema::
NEMOCLAW_REGENERATE_FIXTURES=1 cargo test -p openshell-provider --test schema
NEMOCLAW_REGENERATE_FIXTURES=1 cargo test -p fabric-provider --test schema
```

The same `schema.rs` files check rules across types, such as every `nemoclaw` and `openshell` resource generating an omitted owner and generation; add a rule there rather than an assertion about one type's attributes.

## CLI Tests

Run `cargo test -p nemoclaw-cli` for argument, dispatch, I/O, and process tests.
The CLI's `args.rs` tests parse arguments and inspect help in-process.
Its `dispatch.rs` tests inject input while calling the SDK, and `io.rs` tests use readers, writers, and temporary files to cover bounded input, cancellation, and output failures.

Process tests cover text and JSON failures, independent stdout/stderr redirection, progress modes, secret-safe diagnostics, and preservation of an existing export file when observation fails.
The interruption test keeps credential input open to verify that Ctrl-C exits with 130 without waiting for another line.
Renderer tests use Ratatui's test backend to check concurrent resource identity, narrow layouts, overflow, measured downloads, and bounded redraws without hiding failure milestones.
These tests use fixtures and temporary files; they do not start deployment workloads or establish live inference.

## CI Caches

`CI / Bundle` disables incremental compilation.
Development and test builds use `debug = 1`, retaining line-number backtraces without full local-variable debug data.
On CI, `cargo ci` passes `CARGO_PROFILE_DEV_DEBUG=0` to the Cargo commands it runs, unless the caller sets that variable: nothing in CI reads debug data, and it is most of each test archive that test jobs download.
CI backtraces therefore name functions without line numbers; panic messages keep their file and line.
`cargo ci` sets the variable only for its own Cargo processes, so it is not part of the cache key, and third-party crates, which the profile already builds without debug data, keep their cached artifacts.
Profiles live in `.cargo/config.toml`, whose hash and the current month are part of the CI dependency cache prefix.
Changing a profile, or starting a new month, therefore starts a fresh cache with a one-time dependency rebuild.
Before saving, the cache action keeps target artifacts by crate name only, so a cache that extended an older one would keep every earlier version and profile of each crate.
Within a month, manifest and lockfile changes restore the platform's previous cache and rebuild only the changed dependencies.
The test job's cache keeps third-party debug build artifacts; the bundle job's `native-bundle-v4` cache keeps those of its debug build tool and the target-specific release profile. On Windows, every `Build bundle` part restores that cache and may save it; when a manifest change creates a new key, the first part to finish saves it, and the others rebuild the dependencies that only they changed until the next key.
On Linux, those jobs run on Ubuntu 22.04 and write the platform's caches, which the Ubuntu 24.04 `E2E build images` job restores.
A cache written on a newer Ubuntu would carry its glibc headers' requirements into the bundle, because Cargo does not rebuild C objects when the system headers change; `native-deps-v5` and `native-bundle-v4` started fresh for that reason.
Workspace libraries, test executables, workspace binaries, and installed Cargo binaries are excluded.
Only `v1` writes Rust dependency caches; PRs restore the base branch cache and skip uploads.
This avoids spending PR time saving caches scoped to individual pull requests.

Dependency caches are keyed by platform and the Rust toolchain, manifests, lockfile, and build environment, rather than each source commit.
The native build-and-test job and `E2E build images` share each platform's dependency cache instead of adding their job names to its key.
Only the native build-and-test job writes that shared cache; `E2E build images` restores it without uploading a duplicate copy, and the bundle job writes its own.
The live suites' Docker, Kind, and HCL jobs compile nothing, so they restore no Rust cache.
Documentation restores the bundle job's cache without saving one.
The shared key causes a one-time cold build when first enabled; old job-specific entries can expire normally.

`E2E build images` keeps BuildKit's layers for the live images in the same cache, through `cargo images build --gha-cache`: about 1.8 GB per Linux platform, mostly the OpenClaw application, the Rust toolchain, and the Fabric runtime's Rust build.
Only `v1` saves them, and pull requests into `v1` import them; a layer hits while its inputs, such as the pinned upstream images, the Fabric revision, or `image/fabric`, stay unchanged.
RUN cache mounts, such as the uv and Cargo download caches, are not saved, and a hit reuses the layer's packages, such as those `apt-get` installed, until its inputs change or the cache expires.

The checksum-addressed OpenTofu archives in `.build/downloads` use a separate cache keyed by platform and `versions.json`.
Source-only changes reuse that archive cache without uploading it again.
Bundle assembly still verifies every archive checksum and builds a fresh bundle; `dist` is not cached.

The [shared Rust setup](../../.github/actions/setup-rust/action.yml) runs `cargo ci tools` for native and documentation builds and for `E2E build images`, and exports the installed `PROTOC` to later steps.
On a runner without rustup, such as a leased Colossus machine, it first installs the `rustup-init` that `versions.json` pins, checked against its SHA-256, for the runner user without changing shell profiles, and then the toolchain that `rust-toolchain.toml` names.
That runner compiles without the SDK in `target/ci-runner`, so it can install the compiler before anything needs it.
GitHub restricts cache access by branch: temporary Brev branches may start cold because `v1` is not the default branch.
Parallel VM preparation reduces the build's contribution to elapsed time even on a cold run.

## Local Coverage

Install the pinned coverage tool and the LLVM tools for the repository's Rust version once:

```sh
cargo install cargo-llvm-cov --version 0.9.1 --locked
rustup component add llvm-tools-preview
```

Then run from the repository root:

```sh
cargo coverage
```

Open `target/llvm-cov/html/index.html` for the report.
This alias runs the normal workspace tests with coverage instrumentation and excludes the private `nemoclaw-e2e` fixture implementation from the report; its tests still run and contribute coverage to the other crates.
Ignored bundle and live tests remain opt-in.

Prebuilt runtime bundles are not instrumented by this command.

Coverage artifacts stay under the Git-ignored `target/` directory.
Coverage uses a separate build directory, so the first run recompiles dependencies.
On a memory-constrained host, use `CARGO_BUILD_JOBS=2 cargo coverage`.

The same linker and `PROTOC` prerequisites apply as for SDK builds outside `cargo ci`.

To print a summary from the collected data without rerunning tests:

```sh
cargo llvm-cov report --ignore-filename-regex nemoclaw-e2e
```

There is no coverage threshold or CI coverage job.

## Writing Tests

Put each test at the layer that owns its behavior, and don't repeat a check that a lower layer covers:

1. Unit: one crate's rule, with in-process fakes.
2. Contract: one provider type through OpenTofu, in its `tests/contract/hcl/` scenarios.
3. Integration: the compiled graph across providers in a `tests/integration/hcl/` scenario, or, in `tests/integration/rust/`, what `tofu test` cannot observe: the SDK and CLI, expected provider errors, saved plans, and interrupted or cancelled operations.
4. Live E2E: successful paths that need a real engine, cluster, image, model, or host.

At each layer, prefer a `tofu test` scenario to a Rust test. The [`write-tests` skill](../../.agents/skills/write-tests/SKILL.md) walks through the choice.

Write each test as input, operation, and expected result, and name the observable behavior and its conditions in its title.
Assert what the system does, not what its code, configuration, workflows, or documentation look like.
A test that restates a workflow's jobs, conditions, or inputs, a file's strings, help text, or a golden copy of current output breaks on harmless edits and passes on real bugs; run the workflow, or test the behavior at its owner's layer, instead.
Reading such files is acceptable only for a rule over every file of a kind, such as the [workflow rules](#workflow-rules), and for checking generated files against their generator.
For deployment tests, keep the YAML and expected plan and apply resource actions easy to find.
Use assertions and the test runner's output for failures; do not add separate reports, host inventories, or project-tracking metadata to tests.
Keep inference requests, fault injection, and recovery checks in explicitly named scenarios.

- [Run integration tests](integration-tests.md) for the contract and integration layers.
- [Run live tests](live-tests.md) only against explicitly owned resources.

### SSH Engine Transport

Use [SSH service fixtures](integration-tests.md#ssh-service-fixtures) or [live SSH transport tests](live-tests.md#ssh-engine-transport).
