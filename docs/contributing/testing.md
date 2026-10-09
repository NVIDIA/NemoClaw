<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tests

Before pushing, run this platform's `CI / Native` checks from the repository root:

```sh
cargo ci
```

The command needs the pinned Rust toolchain and a C linker.
It downloads Protocol Buffers compiler 36.1 and cargo-nextest 0.9.144 into the Git-ignored `.tools` directory, verifying each against its `versions.json` checksum; it installs no host packages.
It then runs formatting, Clippy, the workspace tests and doctests, the schema check, a native bundle build, and the bundle lifecycle tests, stopping at the first failure.
A warm run on Linux ARM64 takes about ten minutes, mostly in the workspace and lifecycle tests.

Run one step with `cargo ci STEP`, for example `cargo ci lifecycle`.
The steps are `tools`, `fmt`, `clippy`, `build`, `test`, `schema`, `bundle`, and `lifecycle`; every step first checks the pinned tools.
Each workflow step calls the same command, so the local result matches the platform's CI job.
It does not run the image, documentation, or dependency workflows, or another platform's job.

On Linux with a local Docker engine that uses the [containerd image store](../build.md), `cargo ci live-docker` runs the Docker live tests; plain `cargo ci` never selects it.
Run `cargo ci build` and `cargo ci bundle` first.
The step pulls the pinned OpenShell and Ollama images, builds an agent image (Pi on ARM64, OpenClaw on AMD64) and two proxy images under a fresh `nc-live-` tag, and writes owned gateway documents with fresh UUIDs, ports, and `172.30.200-254.0/24` subnets.
It then runs the `live-docker` nextest profile: the Ollama cache, runtime archive, offline runtime rebuild, standalone cache, Docker proxy, gateway recovery, gateway isolation, and profile revision tests, one at a time.
Afterward it removes the images it built and every container, volume, and network labelled with its UUIDs, whether or not the tests pass; pulled images remain.
It requests no inference and needs no GPU or credentials.
A run on Linux ARM64 takes about five minutes after the build.

On native Linux with Docker Buildx and the [containerd image store](../build.md#build-agent-images), `cargo ci live-kind` runs the Kubernetes live tests; plain `cargo ci` never selects it either.
Run `cargo ci build` and `cargo ci bundle` first.
The step downloads the pinned kind executable by checksum into `.tools`, creates a kind cluster with a fresh `nc-live-` name from the pinned node image, and installs the pinned Agent Sandbox release in it, as a platform would.
It builds an agent image from this checkout (Pi on ARM64, OpenClaw on AMD64), exports its metadata bundle, and loads the image into the cluster by digest.
It then runs three live tests and both chart-render tests in the `live-kind` nextest profile with the verified native bundle; no Helm CLI is required.
The render tests check that Kubernetes keeps the chart's gateway UID and OpenShift uses the observed namespace UID and group while retaining `runAsNonRoot`.
The gateway test runs OpenTofu and its Helm provider with an empty `PATH`, installs the managed gateway's storage, development issuer and Helm release, makes an authenticated OpenShell call through the in-process port forward, and checks that a token from another key is refused.
It removes the gateway, checks that storage remains, reinstalls it on the kept storage, and removes it again.
The agent test applies through the public SDK with a caller-relative kubeconfig, creates a sandbox, and requires apply to stop only at the agent health check, which the pinned Fabric reports as unsupported ([#12443](https://github.com/NVIDIA/NemoClaw/issues/12443)).
It exports the authored configuration without readiness checks, then destroys the deployment while retaining gateway storage.
The OpenShift-profile test writes namespace UID-range annotations on kind and checks the gateway and sandbox pod UIDs through the same SDK flow.
Kind does not enforce OpenShift security context constraints, so this does not qualify OpenShift admission or platform compatibility.
The step deletes the cluster and removes its built image tag whether or not the tests pass; pulled images and build caches remain.
Set `NEMOCLAW_KEEP_KIND_CLUSTER=1` before running to keep the cluster for inspection; remove it afterward with the printed kind command.
The tests request no inference and need no GPU or credentials.
Initial image builds need network access and can take longer than the tests.
See [live prerequisites and retained state](live-tests.md#kubernetes-gateway-without-the-helm-cli).

To build the SDK outside `cargo ci`, set `PROTOC` to `.tools/protoc-36.1/bin/protoc` after `cargo ci tools`, or to another protoc 36.1.

## CI Workflows

| Workflow | Checks |
|---|---|
| CI / Native | `Test / linux_arm64`, `Test / linux_amd64`, `Test / darwin_arm64`, `Test / windows_amd64` |
| CI / Images | `Build / linux_arm64`, `Build / linux_amd64` |
| CI / Dependencies | `Policy` |
| CD / Documentation | `Validate`, then PR preview, staging, or release publication |
| Live / Docker | `Live / Docker / linux_arm64`, `Live / Docker / linux_amd64` on `v1` pushes, `run-live-docker/` branch pushes, and manual runs, through `cargo ci live-docker` |
| Live / Kind | `Live / Kind / linux_arm64`, `Live / Kind / linux_amd64` on `v1` pushes, `run-live-kind/` branch pushes, and manual runs, through `cargo ci live-kind` |
| Live / Brev | Bundle build, image build, and VM preparation in parallel, then lifecycle qualification and verified VM deletion |

The first eight checks are required by the `v1` ruleset, including documentation validation.
Keep the ruleset's check names aligned when renaming jobs; workflow display names do not identify required checks.
Superseded PR runs are cancelled.
Running branch pushes finish; newer pushes replace older pending runs.
Live runs use separate concurrency groups.
The Brev workflow remains opt-in; see [live prerequisites and cleanup](live-tests.md#bare-brev).

## Test Runner

All native CI platforms use cargo-nextest 0.9.144 for ordinary tests and the explicitly configured bundle fixtures.
`cargo ci tools` installs its prebuilt executable after checksum verification; installation cannot fall back to compiling it.
`cargo ci test` runs the ordinary tests with the `ci` profile and then the doctests.
The `ci` profile runs at most eight tests concurrently, reports slow tests every 30 seconds, terminates a test after five minutes, and does not retry failures.
The `lifecycle` profile selects the isolated bundle fixtures and native-state test, with four concurrent tests and the same timeout.
CI retains the same workspace and target selection across both runs so Cargo can reuse the compiled tests.
After each test step, `cargo ci` prints where the time went: the step's test count, wall time, and summed test time, the time per test binary and module, and the 15 slowest tests.
In GitHub Actions, the report is added to the job summary, and the JUnit reports with per-test durations are uploaded as the `test-` and `lifecycle-` artifacts.
Both profiles finish the remaining tests after a failure.
Use the [fixture prerequisites](integration-tests.md#opentofu-and-bundle-lifecycle) before selecting ignored tests; the profiles do not configure a bundle or authorize live resources.
Nextest does not run doctests, so the separate Cargo command remains required.

## Dependency Policy

The [dependency workflow](../../.github/workflows/dependencies.yml) runs on every pull request targeting `v1`, so its required check is available even when no dependencies change.
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
It first builds and qualifies the separate dummy image, then runs the same [command contract suite](../../image/test_agent_contract.py) against every selected agent image.
Use the [reference image procedure](../build.md#reference-contract-image) to run that suite locally against explicit image references.
The suite tests real entrypoints, file and stdin inputs, exit codes, capability labels, standalone validation, host startup and shutdown, and retained files.
The dummy, OpenClaw, Hermes, and Pi also run shared configuration, generation, no-op, invocation, and preparation assertions, using the lifecycle profiles in the reference image procedure.
Native profiles use isolated local inference; images without a selected profile report lifecycle coverage as skipped.
Readiness qualification is separate and reports unsupported native health as skipped unless `--require-ready` requires it to pass.
The workflow requires dummy readiness and retains the dummy-specific readiness-failure test; it separately checks OpenClaw reconfiguration and Hermes security.
Rust- or documentation-only pushes skip that image build; their schema and descriptor consumption tests remain in the Rust suite.
These checks use no live credentials and do not establish GPU inference or live OpenShell deployment behavior.

## CLI Tests

Run `cargo test -p nemoclaw-cli` for argument, dispatch, I/O, and process tests.
The CLI's `args.rs` tests parse arguments and inspect help in-process.
Its `dispatch.rs` tests inject input while calling the SDK, and `io.rs` tests use readers, writers, and temporary files to cover bounded input, cancellation, and output failures.

Process tests cover text and JSON failures, independent stdout/stderr redirection, progress modes, secret-safe diagnostics, and preservation of an existing export file when observation fails.
The interruption test keeps credential input open to verify that Ctrl-C exits with 130 without waiting for another line.
Renderer tests use Ratatui's test backend to check concurrent resource identity, narrow layouts, overflow, measured downloads, and bounded redraws without hiding failure milestones.
These tests use fixtures and temporary files; they do not start deployment workloads or establish live inference.

## CI Caches

Native CI disables incremental compilation.
Development and test builds use `debug = 1`, retaining line-number backtraces without full local-variable debug data.
Profiles live in `.cargo/config.toml`, which the CI dependency cache hashes; changing one requires a one-time dependency rebuild.
Other manifest and lockfile changes restore the platform's previous cache and rebuild only the changed dependencies.
The dependency cache keeps third-party build artifacts for both debug and target-specific release profiles.
Workspace libraries, test executables, workspace binaries, and installed Cargo binaries are excluded.
Only `v1` writes Rust dependency caches; PRs restore the base branch cache and skip uploads.
This avoids spending PR time saving caches scoped to individual pull requests.

Dependency caches are keyed by platform and the Rust toolchain, manifests, lockfile, and build environment, rather than each source commit.

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

## Integration and Live Tests

Write integration tests as input, operation, and expected result.
For deployment tests, keep the YAML and expected plan/apply resource actions easy to find.
Use assertions and the test runner's output for failures; do not add separate reports, host inventories, or project-tracking metadata to tests.
Keep inference requests, fault injection, and recovery checks in explicitly named scenarios.

- [Run integration tests](integration-tests.md) with explicit OpenTofu and bundle paths.
- [Run live tests](live-tests.md) only against explicitly owned resources.

### SSH Engine Transport

Use [SSH service fixtures](integration-tests.md#ssh-service-fixtures) or [live SSH transport tests](live-tests.md#ssh-engine-transport).
