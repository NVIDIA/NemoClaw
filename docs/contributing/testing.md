<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tests

## Choose Local Validation

Before pushing, choose checks that cover the changed behavior and its affected callers.

| Change | Local validation |
|---|---|
| Prose or documentation | Review the changed text; run the [documentation check](documentation-build.md#validate-locally) for documentation changes. |
| Declarative configuration or workflow triggers | Run the applicable schema or lint checks; test affected execution paths when their behavior changes. |
| Isolated code change | Run focused behavioral tests and nearby regression checks, plus formatting and lint checks for the affected code. |
| Bundle construction, provider contracts, lifecycle behavior, or broad workspace dependencies | Run `cargo ci`; it [selects](#select-expensive-local-checks) bundle and lifecycle checks from the changed inputs. |
| Images or Kubernetes deployment | Also run `cargo ci live-docker` or `cargo ci live-kind`; see [live tests](live-tests.md). |
| Impact is unclear or narrower checks cannot establish confidence | Run `cargo ci`. |

For changes spanning categories, combine the applicable checks.
A YAML or configuration file can change runtime behavior; choose by impact rather than extension.
Report the commands and results in the PR, and name checks deferred to CI with the reason.
Repeat validation when relevant inputs change, a check fails, or an unresolved concern requires it; a push alone does not require another run.
Required PR checks still apply before merging.

## Run the Full Local Suite

Run this platform's complete `CI / Bundle` checks from the repository root:

```sh
cargo ci --full
```

The command needs the pinned Rust toolchain and a C linker.
It downloads Protocol Buffers compiler 36.1 and cargo-nextest 0.9.144 into the Git-ignored `.tools` directory, verifying each against its `versions.json` checksum; it installs no host packages.
It then runs formatting, Clippy, the unit tests and doctests, the schema check, a bundle build, and the contract and system tests, stopping at the first failure.
To build the SDK outside `cargo ci`, set `PROTOC` to `.tools/protoc-36.1/bin/protoc` after `cargo ci tools`, or to another protoc 36.1.

## Select Expensive Local Checks

Plain `cargo ci` selects bundle and lifecycle work from changed inputs:

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
Formatting, Clippy, the workspace build, unit tests, doctests, and schema checks always run in `cargo ci`; only bundle construction and lifecycle testing can skip.
Use `cargo ci --full` to run the complete local suite, or `cargo ci --full --dry-run` to preview it.
`--base` and `--full` are mutually exclusive and cannot be combined with a named step, a partition, an archive, or live-image inputs.

The bundle retains all crate sources, so a change outside the lifecycle dependency graph can rebuild the bundle while skipping lifecycle tests.
The planner accounts for the fixture provider launched by OpenTofu as well as Cargo dependencies.
Non-code inputs use the [bundle rules](../../.config/determinator-bundle.toml) and [lifecycle rules](../../.config/determinator-lifecycle.toml).
Unknown inputs select checks; an unavailable explicit base, invalid rules, or failed metadata analysis selects all expensive checks and reports why.
Keep these rules aligned with retained bundle sources, test fixtures, executable dependencies, and build/test configuration.

The same planner also reports image and live-suite decisions:

```sh
cargo run --locked -p nemoclaw-build --no-default-features -- changes plan --base origin/v1 --worktree
```

Its JSON contains `bundle`, `lifecycle`, `images`, and `live`, each with `run` and `reason` fields.
Omit `--worktree` for a clean committed checkout, as CI does; a dirty checkout then selects all checks rather than ignoring local edits.
Image and live-suite decisions do not add those opt-in steps to `cargo ci`.
Rebuild the bundle before explicitly running lifecycle or live tests after relevant inputs change.

## Test Layers

Put each test in the cheapest layer that can check its behavior, and assert only behavior that the test's crate owns.

| Layer | Checks | Test binaries | `cargo ci` step |
|---|---|---|---|
| Unit | One crate's rules, with in-process fakes | Each crate's library tests and `integration` binary, and every other test not marked `#[ignore]` | `test` |
| Contract | Each provider type through pinned OpenTofu | The ignored tests in `nemoclaw-provider::contract`, `openshell-provider::contract`, and `fabric-provider::contract` | `lifecycle` |
| System | SDK and CLI orchestration over a bundle | The ignored `nemoclaw-e2e::integration` modules that the `lifecycle` profile selects | `lifecycle` |
| Live | Real Docker engines, kind clusters, and owned remote hosts | Ignored tests that the `live-docker` and `live-kind` profiles select, and the opt-in tests in [live tests](live-tests.md) | `live-docker`, `live-kind`, or none |

### Unit

Unit tests check one crate's rules: configuration parsing and validation, compilation, planning, provider backends, CLI argument and output handling, and the build tool.
They live in each crate's `src` modules and in its `integration` test binary, `tests/main.rs`; the providers' `schema` binaries also belong here.
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
A coverage test in each binary requires a contract test for every type the provider serves.
[Run integration tests](integration-tests.md#contract-tests) describes each binary.

### System

A system test runs the SDK or the bundled CLI through a whole lifecycle over a bundle: export, unchanged reapply, interrupted creation, failed readiness, and destroy with retained storage.
System tests live in `nemoclaw-e2e`'s `integration` binary; the `lifecycle` profile in [`.config/nextest.toml`](../../.config/nextest.toml) selects its `deployment`, `export_observations`, `fabric_deployment`, `multiple_providers`, `remote_service`, `inference_discovery`, `sandbox_readiness`, and `helm_recovery` modules.
On Unix, `helm_recovery` runs the bundle's OpenTofu and Helm provider against an in-memory Kubernetes API.
The profile also selects one ignored test each in `nemoclaw-test-fixtures` and `nemoclaw-fixture-provider`, so that `cargo ci archive` packages their fixture executables with the tests.
[Run integration tests](integration-tests.md#system-tests) describes the scenarios.

### Live

Live tests use real Docker engines, kind clusters, images, or remote hosts, and touch only resources they own.
The `live-docker` profile selects the Docker tests in `nemoclaw-runtime`, `nemoclaw-build`, `nemoclaw-e2e`, `nemoclaw-sdk`, and `nemoclaw-provider`; the `live-kind` profile selects `nemoclaw-e2e`'s `kubernetes_live` and `kubernetes_chart` tests.
The `live-docker` profile's `managed_gateway` test in `nemoclaw-e2e` plans and applies only a managed gateway's runtime resources with real Docker; [Docker Gateway Recovery](live-tests.md#docker-gateway-recovery) gives its inputs.
Other ignored tests, such as the Brev, Spark, and hosted-model tests, run only when selected by hand or by the Live / Brev workflow.
[Run live tests](live-tests.md) gives each test's prerequisites and the state it retains.

## Run Each Layer

Run every command from the repository root.
`cargo ci STEP` runs one step after checking the pinned tools.
The default steps are `tools`, `fmt`, `clippy`, `build`, `test`, `schema`, `bundle`, and `lifecycle`; `archive`, `live-docker`, and `live-kind` run only when named.

| Layer | All of it | One binary or test |
|---|---|---|
| Unit | `cargo ci test` | `cargo test -p CRATE` |
| Contract and system | `cargo ci bundle`, then `cargo ci lifecycle` | `NEMOCLAW_TEST_BUNDLE=$PWD/dist/PLATFORM cargo test -p CRATE --test BINARY FILTER -- --ignored` |
| Live | `cargo ci bundle`, then `cargo ci live-docker` or `cargo ci live-kind` | See [live tests](live-tests.md) |

`cargo ci test` runs the tests not marked `#[ignore]` with the `ci` nextest profile, then the doctests, which nextest does not run.
The `ci` profile runs at most eight tests concurrently, retries nothing, and finishes the remaining tests after a failure.

The contract, system, and live tests take one input: `NEMOCLAW_TEST_BUNDLE`, the absolute path of a bundle.
`cargo ci bundle` builds the host platform's bundle in `dist/PLATFORM`, such as `dist/linux_arm64`, and `cargo ci lifecycle` passes that path to the `lifecycle` profile.
Local lifecycle runs use the available CPU count, with a minimum of four workers and a maximum of eight.
CI keeps the profile's four-worker setting; the runner treats `CI` or `GITHUB_ACTIONS` being set as CI.
An explicit `NEXTEST_TEST_THREADS` value takes precedence, for example `NEXTEST_TEST_THREADS=4 cargo ci lifecycle`.
The same selection applies when lifecycle tests run through `cargo ci` or from an archive; other test layers retain their profile settings.
A contract test runs the provider built from the checkout, but a system test runs the bundle's CLI and providers: rebuild the bundle after changing them.
[Run integration tests](integration-tests.md#opentofu-and-bundle-lifecycle) covers the fixture executables that a single `cargo test` needs.

`cargo ci live-docker` needs Linux with a local Docker engine that uses the [containerd image store](../build.md).
It pulls the pinned OpenShell and Ollama images, builds an agent image (Pi on ARM64, OpenClaw on AMD64) and two proxy images under a fresh `nc-live-` prefix, and writes gateway documents with fresh UUIDs, ports, and subnets in `172.30.200-254.0/24`.
It runs the `live-docker` profile in four nextest commands: one for the tests that need no gateway document, then one for each of the three gateway tests with its own document.
The tests that use Docker run one at a time, in the profile's `docker-engine` test group; the offline runtime rebuild uses no engine and compiles alongside them.
Afterward it removes every container, volume, and network labelled with the documents' UUIDs, any sandbox objects in their gateways' OpenShell namespaces, and the images it built, whether or not the tests pass; pulled images remain.
When the tests pass, the step fails if OpenShell left a sandbox object or if it cannot list or remove an object labelled with one of those UUIDs.
It requests no inference and needs no GPU or credentials.

`cargo ci live-kind` needs native Linux with Docker Buildx and the [containerd image store](../build.md#build-agent-images).
It downloads the pinned kind executable by checksum into `.tools`, creates a cluster with a fresh `nc-live-` name, installs the pinned Agent Sandbox release, and loads an agent image built from this checkout by digest.
It then runs the `live-kind` profile one test at a time: three live tests and two chart-render tests, which need no Helm CLI.
It deletes the cluster and its image tag whether or not the tests pass; set `NEMOCLAW_KEEP_KIND_CLUSTER=1` to keep the cluster for inspection.
[Run live tests](live-tests.md#kubernetes-gateway-without-the-helm-cli) describes what each test checks.

To build the live images once for both suites, run `cargo ci live-images`.
It builds the agent image, the reference dummy image, and both proxy images under `nc-live-images`, saves them to `.build/ci/live-images.tar.zst` through the `zstd` command, and removes the local names.
The command exports directly from Docker's local containerd store before compression.
This requires Docker to report its containerd address and namespace, `sudo -n ctr` access, and temporary disk space for the uncompressed archive.
The archive retains the image contents, names, digests, and attestations; the job logs archive size and export, compression, and cleanup timings.
Then pass `--images .build/ci/live-images.tar.zst` to `cargo ci live-docker` or `cargo ci live-kind`: each loads the archive and names the images it needs under its own fresh prefix instead of building them, so its cleanup still removes only what it created.

## Budgets and Per-Test Limits

[`.config/test-budgets.yaml`](../../.config/test-budgets.yaml) gives each test step a wall-clock budget and a limit for any one test, in seconds:

| Step | Budget bounds | Wall budget | Per-test limit | Nextest stops a test after |
|---|---|---|---|---|
| `test` | The `ci` nextest run, without the doctests | 45 s | 8 s | 24 s |
| `lifecycle` | Each partition's nextest run | 300 s | 90 s | 180 s |
| `live-docker` | Its four nextest commands together | 360 s | 180 s | 360 s |
| `live-kind` | The nextest run | 270 s | 120 s | 240 s |

Its `binaries` section budgets each provider's contract binary by its nextest name: the binary's test times summed across a platform's lifecycle partitions, and a limit for any one of its tests:

| Binary | Summed budget | Per-test limit | Nextest stops a test after |
|---|---|---|---|
| `fabric-provider::contract` | 40 s | 22 s | 44 s |
| `nemoclaw-provider::contract` | 110 s | 10 s | 20 s |
| `openshell-provider::contract` | 190 s | 12 s | 24 s |

Budgets are measured from each step's JUnit report, so compilation, image builds, and cluster setup do not count.

### Where Budgets Are Enforced

Budgets fail a run only on the Linux GitHub Actions runners, where `GITHUB_ACTIONS` is set; macOS, Windows, and local runs report them without failing.

- The `test` step, each lifecycle partition, and each live suite check their step budget when the step ends; a step over its wall budget, or with a test over its limit, fails and names each offender with its time and limit.
- Each platform's `Lifecycle timing` job checks the binary budgets, because a binary's tests run in several partitions.
  `cargo ci --full` and `cargo ci lifecycle` run the whole lifecycle suite in one step and report them there too.
- Nextest stops a test on every platform: each profile reports a test as slow at its per-test limit and stops it at a multiple of the limit, three times for the `test` step and twice for the others.
  An override in the `lifecycle` profile does the same for each budgeted binary with that binary's limit.
  Nextest marks a stopped test `TIMEOUT` and fails the step.

The multiple leaves a margin for the platforms that only report budgets; the `test` step uses three because its slowest test takes nearly twice its limit on macOS.

### Change a Budget

Lower a budget when a change makes its step faster; a pull request that raises one must give the reason.
When you change a per-test limit, change the matching `slow-timeout` period in [`.config/nextest.toml`](../../.config/nextest.toml) as well: the step's profile, or the binary's `binary_id` override in the `lifecycle` profile.
To budget another test binary, add it under `binaries` and add a `lifecycle` override with the filter `binary_id(=NAME)`.
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

In `CI / Bundle`, download `build-workspace-PLATFORM-ATTEMPT` or `build-bundle-PLATFORM-ATTEMPT` from the workflow run's artifacts and open `cargo-timing.html` in a browser.
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

A lifecycle partition reports only its own tests.
Each platform's `Lifecycle timing` job reports the whole lifecycle suite from the partitions' JUnit reports: each partition's latest attempt, naming any partition without a report, with the slowest partition's time as the suite's wall time.
It also shows each budgeted binary's test count, summed time, and slowest test against its budget, with its tests from every partition.
To produce the same report locally, download the `lifecycle-PLATFORM-SHARD-ATTEMPT` artifacts into subdirectories of one directory and run:

```sh
cargo run -q --locked -p nemoclaw-build --no-default-features -- lifecycle-timing DIRECTORY --platform linux_amd64 --shards '[1, 2]'
```

CI keeps each step's JUnit report, with per-test durations, for 14 days in the `test-PLATFORM-ATTEMPT`, `lifecycle-PLATFORM-SHARD-ATTEMPT`, `live-docker-PLATFORM-ATTEMPT`, and `live-kind-PLATFORM-ATTEMPT` artifacts; the `live-docker` report joins its four nextest commands.

## How CI Runs the Tests

The automatic workflows accept pull requests to any base branch, including stacked `v1` PRs targeting another feature branch.
The PR must include these workflow changes; update existing stacks from `v1` to enable them.
Image and live-suite checks still use their change analysis to decide which steps to run.
Documentation previews publish only for PRs targeting `v1`.

| Workflow | Checks |
|---|---|
| CI / Bundle | `Test / linux_arm64`, `Test / linux_amd64`, `Test / darwin_arm64`, `Test / windows_amd64` |
| CI / Images | `Build / linux_arm64`, `Build / linux_amd64` |
| CI / Dependencies | `Policy` |
| CD / Documentation | `Validate`, then PR preview, staging, or release publication |
| Live / Brev | Bundle build, image build, and VM preparation in parallel, then lifecycle qualification and verified VM deletion |

The `v1` ruleset requires the first eight checks.
Keep the ruleset's check names aligned when renaming jobs; workflow display names do not identify required checks.
A `Test / PLATFORM` check succeeds only when every selected job of that platform succeeds, including its live suites when they run.

Each bundle or image workflow calls the [shared planner](../../.github/workflows/validation-plan.yml) once on Linux before its platform jobs.
It builds without the SDK, protoc, or nextest, reads old and new Cargo metadata once, and reports the decisions in the job summary.
Bundle push and manual runs select all checks; PRs use impact analysis.
Image pushes retain impact analysis, and manual image runs select all checks.
A failed analysis selects all expensive checks; a failed planning job prevents the required checks from passing.

### Jobs of One Platform

Each platform in [CI / Bundle](../../.github/workflows/rust.yml) runs [one workflow](../../.github/workflows/bundle-platform.yml) on its own runners:

1. `Build and test` runs `cargo ci fmt`, `clippy`, `build`, `test`, and `schema`; it runs `archive` only when lifecycle or live jobs need the executables.
2. When the plan selects a bundle, `Build bundle` runs `cargo ci bundle` on a separate runner at the same time.
3. When the plan selects live checks, Linux runs `Build live images` with `cargo ci live-images`, alongside the first two jobs.
4. When selected and the build and bundle jobs finish, the `Lifecycle` jobs run the contract and system layers in partitions; on Linux, when the live images are also built, `Live / Docker` and `Live / Kind` start.
5. When the partitions finish, `Lifecycle timing` reports the whole lifecycle suite and checks the binary budgets.

Each platform starts its jobs after its own build; it does not wait for the other platforms.
Superseded pull request runs are cancelled, and their `Test / PLATFORM` checks report as cancelled rather than failed.
Push runs finish, because only `v1` pushes save the shared Rust caches; a newer push still replaces an older pending run.
The image workflow cancels superseded pull request runs and pushes, but not manual runs; documentation and dependency pushes finish.

### Partitions

Linux and macOS run the lifecycle suite in two nextest slice partitions and Windows in three, each on its own runner with four test slots.
A slice partition deals the sorted test list round-robin, which spreads the slow system scenarios, which sort next to each other, across partitions.
Adding or removing a test moves later tests to other partitions.

### Archives

`cargo ci archive` writes two files that let other runners run the tests without compiling:

- `.build/ci/lifecycle.tar.zst`, a nextest archive of the test binaries that the `lifecycle` profile selects, on Linux also those that the `live-docker` and `live-kind` profiles select, and the executables their packages build;
- `.build/ci/lifecycle-inputs.tar`, which keeps the executable permissions of the pinned tools, the `nemoclaw-build` executable, and the fake `ssh` relay.

The bundle job uploads `dist/PLATFORM` separately.
Lifecycle and live jobs extract both archives and the bundle, the live jobs also download the live images archive, and each then runs `.build/ci/nemoclaw-build ci STEP --archive-file .build/ci/lifecycle.tar.zst`, which remaps the tests' working directories to the checkout and extracts the tests into `.build/ci/extracted`.
CI keeps these artifacts for one day; rerunning a failed job reuses its producers' artifacts, even from an earlier attempt, and after they expire the complete workflow must be rerun.

### Run a Lifecycle Partition

`cargo ci --full` runs the complete lifecycle suite in one step.
After `cargo ci build` and `cargo ci bundle`, select one partition explicitly:

```sh
cargo ci lifecycle --partition slice:1/2
```

To reproduce the archive handoff, run `cargo ci archive` after building.
Copy both archives into `.build/ci` and the bundle into `dist/PLATFORM` in a separate checkout of the same revision on the same operating system and architecture, then run:

```sh
tar -xf .build/ci/lifecycle-inputs.tar
.build/ci/nemoclaw-build ci lifecycle --archive-file .build/ci/lifecycle.tar.zst --partition slice:1/2
```

The worker compiles nothing and writes JUnit timings under `target/nextest/lifecycle`; repeating the command overwrites the extracted files.
`--partition` requires the `lifecycle` step, `--archive-file` requires `lifecycle`, `live-docker`, or `live-kind`, and `--images` requires `live-docker` or `live-kind`, so none of them narrows plain `cargo ci`.

### Windows

Windows has no Unix sockets for fake container engines, so tests reach them over SSH through the fake relay `nemoclaw-fixture-ssh`, which forwards `ssh://127.0.0.1:PORT` to the fixture's loopback port.
[`Fixture::engine`](../../crates/test-support/http.rs) serves the engine on a Unix socket where one exists and otherwise installs the relay as `ssh` beside the test executable.
The `lifecycle` step also puts the relay first on `PATH` as `ssh`, so the providers and CLI that OpenTofu and the SDK start reach it too.
Use `Fixture::engine` for a fake engine so that the test runs on every platform; compile a test that needs a Unix-only fixture only on Unix with `#[cfg(unix)]`.

### Live Suites on Pull Requests

`Live / Docker` and `Live / Kind` run on the Linux platforms only, from that platform's archive, bundle, and live images, after enabling Docker's containerd image store on the runner.
They run on every `v1` push, `run-live/` branch push, and manual run.
On a pull request, the shared validation plan compares the merge commit with its first parent, the PR base.
When live inputs are unaffected, the live image and test jobs skip before installing tools or downloading test artifacts.
A file inside a crate counts when that crate is in the live build: the packages whose tests run live and the CLI and providers the bundle ships, with their dependencies.
[Path rules](../../.config/determinator-live.toml) classify other files; unclassified files, dependency or feature changes in the live build, and failed analyses run the suites.
After committing, run `cargo run -p nemoclaw-build --no-default-features -- changes live --base origin/v1` to see the decision.
A live failure fails that platform's `Test / PLATFORM` check.
The Brev workflow remains opt-in; see [live prerequisites and cleanup](live-tests.md#bare-brev).

## Dependency Policy

The [dependency workflow](../../.github/workflows/dependencies.yml) runs on every pull request, including stacked PRs, so its check is available even when no dependencies change.
Pushes to `v1` run it only when Rust manifests, lockfiles, the toolchain, the policy, or the workflow change.
It runs once on Linux, outside the native build matrix, without compiling the workspace or caching build artifacts.
The [policy](../../deny.toml) permits the current license inventory and the explicitly listed Git sources; dependency revisions remain pinned in the manifests and lockfile.

Install cargo-deny 0.20.2 once, then run from the repository root:

```sh
cargo install cargo-deny --version 0.20.2 --locked
cargo deny --locked check licenses sources
cargo deny --locked check advisories
```

Advisories use the current advisory database and are a manual check, separate from the required license and source checks.
The workflow also defines a manual advisory step, but GitHub requires the workflow file on the repository's default branch before it accepts manual dispatch.
Until that requirement is met, run the advisory command locally on `v1`.
There is no scheduled advisory run on this branch.
A denied license or source requires reviewing the dependency and policy; do not add blanket exceptions to make the check pass.

## Image Source Checks

Use the [agent image build prerequisites](../build.md#build-agent-images); the target-selection test needs Docker Buildx but no host Python.
For the full Linux ARM64 checks, run from the repository root:

```sh
cargo test -p nemoclaw-build --test integration bake::
AGENT_PLATFORM=linux/arm64 docker buildx bake --check dummy agents ollama-proxy
AGENT_PLATFORM=linux/arm64 docker buildx bake check
```

The first command checks Bake's public target selection without a Docker daemon or prebuilt source tree.
Docker checks the selected build instructions; the `check` group runs Ruff lint/format checks, reference-backend tests without Fabric, and generic runtime behavior tests against Fabric's installed fixture adapter.
Behavior tests run with networking disabled; downloading build dependencies still needs network access.
Checks produce build cache entries and no tagged runtime images.

For a faster Python source edit loop with host uv:

```sh
uv tool run --from ruff==0.16.7 ruff check .
uv tool run --from ruff==0.16.7 ruff format --check .
```

Use `ruff format .` through the same pinned uv invocation to apply formatting.
The scope includes image Python and retained integration fixtures.
Native adapter implementation and its behavioral tests live in Fabric and use Fabric's checks.

The [image workflow](../../.github/workflows/images.yml) builds the selected platform's agent images plus the proxy, verifies retained source hashes, and checks installed discovery metadata.
It first builds and qualifies the separate dummy image: the [reference runtime suite](../../image/test_agent_contract.py) starts, invokes, and stops one runtime with NemoClaw's test adapter through `fabric-agent-ctl`, in a network-isolated, read-only container.
It then runs the [image assembly checks](../../image/test_image.py) in every selected agent image: the runtime command, Python against each pinned adapter's declared range, the Fabric lock, Node.js only where a harness needs it, the catalog label, and retained sources without build toolchains.
NemoClaw doesn't run Fabric's native adapters; their behavior is Fabric's to test.
Use the [reference image procedure](../build.md#reference-contract-image) to run these locally.

The image workflow obtains its image decision from the shared validation plan and skips image steps when their inputs are unaffected; the `Build` checks still report.
On `v1` pushes that build images, it then pushes the checked agent and proxy images by digest to `ghcr.io/nvidia/nemoclaw/v1-ci:<image>-<commit>-<arch>`, an internal package that releases promote from ([#13516](https://github.com/NVIDIA/NemoClaw/issues/13516)).
It pushes only to packages that already exist and aren't public, and otherwise skips with a warning; see [provisioning the packages](releases.md#provision-the-packages).
The job summary lists each digest and how long its push took.
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
Profiles live in `.cargo/config.toml`, whose hash and the current month are part of the CI dependency cache prefix.
Changing a profile, or starting a new month, therefore starts a fresh cache with a one-time dependency rebuild.
Before saving, the cache action keeps target artifacts by crate name only, so a cache that extended an older one would keep every earlier version and profile of each crate.
Within a month, manifest and lockfile changes restore the platform's previous cache and rebuild only the changed dependencies.
The test job's cache keeps third-party debug build artifacts; the bundle job's `native-bundle-v3` cache keeps those of its debug build tool and the target-specific release profile.
Workspace libraries, test executables, workspace binaries, and installed Cargo binaries are excluded.
Only `v1` writes Rust dependency caches; PRs restore the base branch cache and skip uploads.
This avoids spending PR time saving caches scoped to individual pull requests.

Dependency caches are keyed by platform and the Rust toolchain, manifests, lockfile, and build environment, rather than each source commit.
Native, Docker, and Kind jobs share each platform's dependency cache instead of adding their job names to its key.
Only the native build-and-test job writes that shared cache; Docker and Kind jobs restore it without uploading duplicate copies, and the bundle job writes its own.
Documentation and Brev retain separate cache prefixes.
The shared key causes a one-time cold build when first enabled; old job-specific entries can expire normally.

The checksum-addressed OpenTofu archives in `.build/downloads` use a separate cache keyed by platform and `versions.json`.
Source-only changes reuse that archive cache without uploading it again.
Bundle assembly still verifies every archive checksum and builds a fresh bundle; `dist` is not cached.

The [shared Rust setup](../../.github/actions/setup-rust/action.yml) runs `cargo ci tools` for native, documentation, and Brev builds and exports the installed `PROTOC` to later steps.
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

## Write Tests

Write each test as input, operation, and expected result, and name the observable behavior and its conditions in its title.
For deployment tests, keep the YAML and expected plan and apply resource actions easy to find.
Use assertions and the test runner's output for failures; do not add separate reports, host inventories, or project-tracking metadata to tests.
Keep inference requests, fault injection, and recovery checks in explicitly named scenarios.

- [Run integration tests](integration-tests.md) for the contract and system layers.
- [Run live tests](live-tests.md) only against explicitly owned resources.

### SSH Engine Transport

Use [SSH service fixtures](integration-tests.md#ssh-service-fixtures) or [live SSH transport tests](live-tests.md#ssh-engine-transport).
