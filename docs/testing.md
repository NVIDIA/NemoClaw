<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tests

The pinned Rust toolchain needs a C linker and `protoc` on PATH (or `PROTOC` pointing to it) to build the provider protocol.
Validation used protoc 36.1 on Linux ARM64.
No host package installation is part of the tests.

```sh
cargo test --workspace
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
```

## Test Runner Pilot

The Linux ARM64 native CI job uses cargo-nextest 0.9.144 for ordinary tests and the explicitly configured bundle fixtures.
Other platforms retain the Cargo test runner while the pilot is measured.
The pinned prebuilt runner is installed with checksum verification; installation cannot fall back to compiling it.

To run ordinary tests locally from the repository root, install the pinned runner once and use:

```sh
cargo install cargo-nextest --version 0.9.144 --locked
cargo nextest run --locked --workspace --profile ci
cargo test --locked --workspace --doc
```

The local install command compiles the tool; CI downloads its prebuilt executable.
The `ci` profile runs at most eight tests concurrently, reports slow tests every 30 seconds, terminates a test after five minutes, and does not retry failures.
The `lifecycle` profile limits the whole fixture run to two concurrent tests with the same timeout.
Both profiles finish the remaining tests after a failure.
Use the [fixture prerequisites](testing/fixtures.md#opentofu-and-bundle-lifecycle) before selecting ignored tests; the profiles do not configure a bundle or authorize live resources.
Nextest does not run doctests, so the separate Cargo command remains required.

## Dependency Policy

The [dependency workflow](../.github/workflows/dependencies.yml) checks changed Rust manifests, lockfiles, toolchain, and policy on pull requests and pushes to `v1`.
It runs once on Linux, outside the native build matrix, without compiling the workspace or caching build artifacts.
The [policy](../deny.toml) permits the current license inventory and the two existing Git sources; dependency revisions remain pinned in the manifests and lockfile.

Install cargo-deny 0.20.2 once, then run from the repository root:

```sh
cargo install cargo-deny --version 0.20.2 --locked
cargo deny --locked check licenses sources
cargo deny --locked check advisories
```

Advisories use the current advisory database and are a manual check, separate from dependency-change CI.
The workflow also defines a manual advisory step, but GitHub requires the workflow file on the repository's default branch before it accepts manual dispatch.
Until that requirement is met, run the advisory command locally on `v1`.
There is no scheduled advisory run on this branch.
A denied license or source requires reviewing the dependency and policy; do not add blanket exceptions to make the check pass.

## Image Source Checks

Use the [agent image build prerequisites](build.md#build-agent-images) and host Python 3.12 or newer for the target-selection test.
From the repository root:

```sh
python3 -B -m unittest discover -s image -p test_builds.py
docker buildx bake --check agents ollama-proxy
docker buildx bake check
```

The first command checks Bake's public target selection without a Docker daemon or prebuilt source tree.
Docker checks the selected build instructions; the `check` group runs Ruff lint/format checks, Oxlint, Oxfmt, strict TypeScript checks, Python behavior tests, and Pi's TypeScript compilation and native model tests.
Behavior tests run with networking disabled; downloading build dependencies still needs network access.
Checks produce build cache entries and no tagged runtime images.

For a faster source-only edit loop with host uv and Node.js 24.21.0 or newer:

```sh
uv tool run --from ruff==0.16.7 ruff check .
uv tool run --from ruff==0.16.7 ruff format --check .
npm --prefix image ci --ignore-scripts
npm --prefix image run lint
npm --prefix image run format:check
npm --prefix image run typecheck
```

Use `ruff format .` through the same pinned uv invocation and `npm --prefix image run format` to apply formatting.
The scope includes image Python/TypeScript, the native fixture code, and the Fabric adapter experiment runner.
Standalone TypeScript fixtures use `.mts` and Node's native type stripping; they need no transpiler or generated JavaScript files.
The host type check covers OpenClaw fixtures; the Pi build checks its model code and fixture against installed upstream declarations.
OpenClaw's private bundles ship no declarations, so [small fixture declarations](../test/openclaw.d.ts) describe the consumed API shapes and native tests verify those boundaries.
Upstream sources and model-specific recipe code retain their own conventions and checks.

The [image workflow](../.github/workflows/images.yml) runs for every pull request targeting `v1`, for pushes changing image inputs or tests, and on manual dispatch.
It builds all ten agent images plus the proxy and exercises native adapters against isolated local protocol fixtures.
Rust- or documentation-only pushes skip that image build; their schema and adapter-descriptor checks remain in the Rust suite.
It also runs OpenClaw tools, execution, search, and tracing checks.
Native messaging belongs to OpenClaw; NemoClaw tests that its adapter preserves unrelated native configuration and rejects drift in deployment-owned settings.
These fixtures use no live credentials, send no external messages, and do not qualify GPU inference or live OpenShell deployments.

## CLI Tests

Run `cargo test -p nemoclaw-cli` for argument, dispatch, I/O, and process tests.
The CLI's `args.rs` tests parse arguments and inspect help in-process.
Its `dispatch.rs` tests inject input while calling the SDK, and `io.rs` tests use readers, writers, and temporary files to cover bounded input, cancellation, and output failures.

Process tests cover exit codes, piping, secret-safe diagnostics, and preservation of an existing export file when observation fails.

## CI Caches

Native CI disables incremental compilation.
Development and test builds use `debug = 1`, retaining line-number backtraces without full local-variable debug data.
Changing this profile requires a one-time dependency rebuild before measuring warm-cache CI duration.
The dependency cache keeps third-party build artifacts for both debug and target-specific release profiles.
Workspace libraries, test executables, workspace binaries, and installed Cargo binaries are excluded.

Dependency caches are keyed by platform and the Rust toolchain, manifests, lockfile, and build environment, rather than each source commit.

The checksum-addressed OpenTofu archives in `.build/downloads` use a separate cache keyed by platform and `versions.json`.
Source-only changes reuse that archive cache without uploading it again.
Bundle assembly still verifies every archive checksum and builds a fresh bundle; `dist` is not cached.

Protobuf's compiler is still downloaded and checksum-verified during tool setup.

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

The same linker and `PROTOC` prerequisites apply as for ordinary tests.

To print a summary from the collected data without rerunning tests:

```sh
cargo llvm-cov report --ignore-filename-regex nemoclaw-e2e
```

There is no coverage threshold or CI coverage job.

## Integration and Live Qualification

Write integration tests as input, operation, and expected result.
For deployment tests, keep the YAML and expected plan/apply resource actions easy to find.
Use assertions and the test runner's output for failures; do not add evidence reports, host inventories, or qualification bookkeeping to tests.
Keep inference requests, fault injection, and recovery checks in explicitly named scenarios.

- [Run fixture qualification](testing/fixtures.md) with explicit OpenTofu and bundle paths.
- [Run live qualification](testing/live.md) only against explicitly owned resources.
- [Inspect retained evidence](validation/README.md) for tested configurations and remaining limits.

### SSH Engine Transport

Use [SSH service fixtures](testing/fixtures.md#ssh-service-fixtures) or [live SSH transport qualification](testing/live.md#ssh-engine-transport).
