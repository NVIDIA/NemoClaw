<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Windows bundle profile investigation

## Current codegen-unit comparison

The workflow now uses --codegen-units. It keeps optimization level 3 and the
selected linker unchanged. Baseline retains the pinned non-incremental rustc
default of 16 codegen units; candidate sets 64 for named workspace packages only.
Third-party settings stay unchanged, and no LINK=/TIME diagnostics are enabled.

Preview without cleaning or building bundles:

```sh
cargo run --locked --target-dir target/ci-runner -p nemoclaw-build --no-default-features \
  --example bundle_profile_experiment -- --plan-codegen-units
```

The driver warms both variants, then measures 16/64/64/16 with fresh release
workspace artifacts and warm dependencies. Compiler commands must attest level
3 for the SDK, CLI and provider libraries, no explicit CGU override for baseline,
and codegen-units=64 for candidate. The fixed CI environment disables incremental
compilation. Other source/cache/manifest checks remain in force.

After timing, cargo ci build prepares native validation executables once.
--restore 16 and --restore 64 select snapshots belonging to this experiment;
the workflow runs the native suite against each and retains separate XML.
The report records optimization level, codegen-unit setting, raw compiler logs
and executable sizes. More codegen units can hurt runtime optimization, so build
time alone cannot justify a production change.

[Compiler codegen-unit defaults](https://doc.rust-lang.org/rustc/codegen-options/index.html#codegen-units).

## Linker diagnostic mode

The earlier workflow used --link-times at unchanged release level 3. It first
compiles a small Rust probe with MSVC's LINK=/TIME and verifies that the pinned
rustc forwards the linker diagnostics. It then warms dependencies and records
one rebuilt-workspace bundle command with structured Cargo diagnostics.

Raw linker-pass messages retain their Cargo target identity. They are diagnostic
observations, not an optimization comparison; overlapping linker/unit intervals
must not be added. The linker, optimization settings, and codegen flags are not
replaced. Only the diagnostic /TIME option is appended to existing LINK options.

After timing, cargo ci build prepares all native validation executables,
including target/debug/nemoclaw-fixture-ssh.exe. Windows lifecycle setup needs
that fixture before invoking nextest. The job then validates the saved level-3
bundle. This prerequisite was missing from the earlier profile experiment.

References:
- [MSVC /TIME](https://learn.microsoft.com/en-us/cpp/build/reference/time-linker-time-information?view=msvc-170)
- [LINK environment options](https://learn.microsoft.com/en-us/cpp/build/reference/linking?view=msvc-170)
- [Pinned rustc linker-output handling](https://github.com/rust-lang/rust/blob/1.98.1/compiler/rustc_codegen_ssa/src/back/link.rs)

## Earlier optimization-level experiment

The --run mode retains the dependency-warmed ABBA protocol below. It found no
meaningful build-time gain for workspace optimization level 2, so the current
workflow does not repeat it.

This experiment does not change the repository's release profile or normal CI.
It compares the existing release configuration with optimization level 2 for
named repository-owned workspace packages. Third-party settings remain unchanged.
Generated overrides live under the ignored .build/windows-bundle-profile directory;
the dependency-cache key still uses the unchanged .cargo/config.toml.

Preview the plan without building bundles or cleaning artifacts:

```sh
cargo run --locked --target-dir target/ci-runner -p nemoclaw-build \
  --no-default-features --example bundle_profile_experiment -- --plan
```

The optional Windows workflow runs only for the perf/windows-bundle-profile PR.
It restores, but does not save, the native bundle dependency cache. The driver
rejects --run and --restore outside Windows GitHub Actions.

The earlier --run protocol:
1. Builds the SDK-enabled assembler once, outside sample timing.
2. Warms baseline and candidate, rebuilding release workspace artifacts each time.
3. Measures baseline/candidate/candidate/baseline, again rebuilding workspace
   artifacts before each sample while retaining dependencies.
4. Rejects measured samples that recompile third-party units or reuse the key
   workspace libraries. Verbose compiler logs attest the SDK optimization level.
5. Checks source identity, bundle inventory, and unchanged non-executable payloads.
6. Runs the complete native lifecycle suite against both saved bundles after
   measurement. Validation does not publish packages/images or use live clusters.

Samples time the complete bundle command: release compilation, schema/manifest
generation, and assembly. They exclude Cargo clean, dependency warmups, the
one-time dev assembler build, and snapshot copying. They are not whole-CI timings.

Artifacts contain raw logs, Cargo HTML reports, per-file byte sizes, generated
overrides, and native validation XML—not the large bundle snapshots. A failed
comparison remains a failed job; partial evidence is still uploaded.

Two samples per configuration provide directional evidence, not a stable
percentage estimate. Native tests establish functional behavior and end-to-end
test durations, not a CPU-throughput guarantee. Any production profile proposal
needs runtime/size assessment and the repository's normal bundle validation.

The investigation uses existing build collaborators; no production bundler,
cache policy, release profile, or ordinary CI checks are replaced.
