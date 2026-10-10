<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Compatible compilation policies

`gpu-cargo` builds Cargo packages with pinned Rust 1.98.1. The default `native`
object backend uses stock CPU LLVM. Experimental `tpde`, `llvm-bitcode`, and
`gpu` adapters reuse Rust's frontend, crate metadata, packaging, and linker.
GPU object emission is restricted to qualified modules; other modules require
explicit, attributed CPU fallback. Physical execution does not establish a
compilation speedup.

| Quality | Root release-profile overrides |
| --- | --- |
| `fast` | O1, 16 codegen units, LTO off |
| `balanced` | O2, 16 codegen units, LTO off |
| `release` | Existing Cargo release configuration |

Every quality uses Cargo's release profile. The driver preserves the project's
panic, overflow, debug, target, feature, and inherited semantic settings. Existing
package-specific profile overrides and inherited compiler flags retain Cargo
precedence; the report identifies this scope. It pins Cargo's actual rustc path
and selects an explicit adapter wrapper, disabling project wrappers. It invokes programs as argument vectors and
retains the inherited environment and descriptors for Cargo's jobserver.

Run from the repository root:

```sh
cargo +1.98.1 build --locked \
  --manifest-path experiments/gpu-rust-compiler/compiler/Cargo.toml \
  --target-dir experiments/gpu-rust-compiler/.build/compiler \
  --bin gpu-cargo

experiments/gpu-rust-compiler/.build/compiler/debug/gpu-cargo plan \
  --manifest-path Cargo.toml --package nemoclaw-cli --bin nemoclaw \
  --quality fast --placement auto --offline \
  --target-root experiments/gpu-rust-compiler/.build/cargo-policies \
  --report experiments/gpu-rust-compiler/results/cargo-plan.json
```

Replace `plan` with `build` to compile. `--dry-run` also selects planning. Plans
inspect the toolchain and locked Cargo metadata but do not build or create target
directories. Required `metal` or `cuda` placement needs `--object-backend gpu`
and explicit GPU tools. The other object backends reject required GPU placement.

The selected target root contains separate `fast`, `balanced`, and `release`
directories, with a `native` child or a backend/tool-provenance child. The driver creates an ownership marker in each. It refuses to adopt
a nonempty directory without its marker or reuse a directory belonging to
another manifest or policy. Existing build targets remain separate.

## Experimental object adapters

Alternate object backends support `fast` and `balanced`. `release` retains the
native Cargo LTO contract. Supply all four paths: `--bitcode-wrapper`,
`--tpde-controller`, `--tpde-bridge`, and `--llvm-llc`. The controller uses the
pinned bridge to inspect IR even when LLVM emits the object. See
[backend setup](fast-backend/README.md).

`--object-backend llvm-bitcode` qualifies the bitcode/packaging seam using LLVM.
`--object-backend tpde` requests TPDE; `--allow-backend-fallback` permits recorded
LLVM fallback. TPDE cannot emit Darwin objects in the current adapter, so this
Mac needs that explicit fallback. Reports name the actual emitter rather than
labeling an LLVM result as TPDE.

`--object-backend gpu` also requires `--gpu-emitter` and `--gpu-library`. Select
`--gpu-backend metal|cuda`, optionally `--gpu-device INDEX`; Metal requires
`--gpu-shader`. A fresh GPU build must contain at least one physical GPU object
unit with recorded device identity, kernel dispatches, and used kernel output.
CPU fallback and module eligibility failures are reported separately. These
adapters do not establish arbitrary Rust-module GPU coverage or a performance
win.

Each Cargo invocation owns a new receipt directory. Reports aggregate current
object emitters, fallback reasons, and frontend/materialization/emission/link
stages. Stage sums can overlap across compiler processes; they are not
whole-build wall-time percentages. Tool-content hashes and fallback/device
choices isolate backend targets.

LLVM object emission follows each actual rustc invocation's code-generation
optimization setting, including package overrides and inherited flags. Size
levels use the pinned compiler's target-machine mapping and retain IR size
attributes. The standalone controller/helper keep O0 as their default baseline;
`--llvm-codegen-opt-level 0|1|2|3` selects only machine-code generation.

Alternate modes reject an inherited `RUST_LLVM_LIBRARY` override. They resolve
and hash the pinned sysroot library, explicitly select it only for child Cargo,
and verify the compact helper's loaded-library report. External `llc` remains
usable, but its additional dynamic dependencies are unqualified; it cannot
establish reusable GPU cache lineage.

A successful unchanged GPU build can reuse an owned, qualified artifact with
matching input/tool/artifact hashes and unchanged prior receipt hashes. It
reports `cache_only=true`, `gpu_executed=false`, and
`current_run_gpu_qualified=false`, retaining prior lineage separately. Cached
work cannot serve as evidence of a new GPU run. A fresh CPU-only fallback build
fails required-GPU qualification and invalidates previous GPU artifact lineage.

## Generated executable size

Declare a reference executable outside the selected quality's target directory:

```sh
experiments/gpu-rust-compiler/.build/compiler/debug/gpu-cargo build \
  --manifest-path Cargo.toml --package nemoclaw-cli --bin nemoclaw \
  --quality fast --offline \
  --target-root experiments/gpu-rust-compiler/.build/cargo-policies \
  --reference-artifact /absolute/path/to/reference-nemoclaw \
  --max-size-ratio 1.5 --size-basis strip-debug \
  --report experiments/gpu-rust-compiler/results/cargo-fast.json
```

`unmodified` measures each complete original file. `strip-debug` copies both
files and applies the same host strip command to each before measuring the
complete copies; the originals remain unchanged. On macOS it uses `strip -S -x`;
on Linux, `strip --strip-debug --discard-all`. This is complete-file accounting,
not machine-code-section accounting. The report retains raw sizes, measurement
method, hashes, and the observed ratio.

The size gate has no baseline until `--reference-artifact` is supplied. An
executable exceeding the declared ratio returns a failing exit status and a
`size-limit-exceeded` report. It does not silently rebuild or alter semantics to
fit the limit. Compiler footprint and its separate +50% allowance require
additional accounting; this generated-executable gate does not qualify them.

JSON reports include the exact command vector, pinned compiler path/version,
manifest and lock hashes, available Git revision/dirty state, actual backend,
actual Cargo executable path, compilation time, total driver time, artifact
size/hash, and optional size comparison. Compilation time includes Cargo's
selected dependency/build-script/link work, including cache hits. Source
provenance does not claim a content hash of every input. Report files replace
only earlier `gpu-cargo-report` version 1 files; unrelated existing files are
preserved.

Use identical explicit flags and cache states for repeated benchmarks. Switching
between implicit default codegen units and explicit `16` can change Cargo
fingerprints even when the effective codegen count matches.
