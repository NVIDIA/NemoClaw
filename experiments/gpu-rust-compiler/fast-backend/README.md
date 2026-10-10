<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Captured Rust LLVM fast-backend experiment

This package compiles captured LLVM modules into object files through a pinned
TPDE adapter. It is a CPU fast-backend experiment, not GPU acceleration or a
drop-in complete Rust compiler. Its receipt says `gpu_accelerated: false` and
`scope: captured-llvm-module-to-object`.

The bridge parses and verifies LLVM text or bitcode, preserves the input target,
and emits Linux x86-64/AArch64 ELF. The Rust controller checks backend provenance,
records TPDE failures, and commits only a validated relocatable object. It never
replaces an existing output. Unsupported modules can use LLVM `llc` only
with `--allow-fallback`; the selected backend and reason remain visible.
Use `--backend llvm` for the direct LLVM baseline without attempting TPDE.
`--llvm-codegen-opt-level 0|1|2|3` controls LLVM target-machine code generation;
the standalone default remains 0. The controller passes that level as `-O=N`
without adding an IR optimization pipeline or changing TPDE's code generation.
For integrated builds, choose the level corresponding to the actual rustc
request; Rust's size levels `s` and `z` use target-machine level 2. Receipts
record `llvm_codegen_opt_level` and `llvm_codegen_opt_scope:
llvm-target-machine-codegen-only` when LLVM emits the object, and null for both
fields when TPDE succeeds. The level is not a TPDE quality setting.
The bridge also provides strict [GEM1 leaf export](GEM1.md) for the experimental
GPU native-code emitter. Unsupported whole modules keep the CPU backend route.

TPDE can mutate its in-memory module. LLVM fallback reparses the original file in
a separate process. Keep captured inputs immutable for the entire request.
Object validation checks format, architecture and structural bounds. It does not
prove machine-code semantics; link and execute differential workloads separately.

## Build

The bridge needs an existing LLVM **22.1.8** development installation, matching
Clang, CMake 3.25+, a GNU-compatible C++20 compiler, Python 3.10+ for upstream
encoder generation, and TPDE's fetched dependencies.
CMake fetches the pinned TPDE source. This package does not install system tools.

```sh
cargo +1.98.1 build --release --locked --offline \
  --manifest-path experiments/gpu-rust-compiler/fast-backend/Cargo.toml \
  --target-dir experiments/gpu-rust-compiler/fast-backend/.build/controller

cmake -S experiments/gpu-rust-compiler/fast-backend \
  -B experiments/gpu-rust-compiler/fast-backend/.build/native \
  -DCMAKE_BUILD_TYPE=Release -DLLVM_DIR=/path/to/llvm-22.1.8/lib/cmake/llvm \
  -DCMAKE_CXX_COMPILER=/path/to/clang++ -DCMAKE_C_COMPILER=/path/to/clang
cmake --build experiments/gpu-rust-compiler/fast-backend/.build/native \
  --target tpde-rust-bridge --parallel 4
```

Assertions are enabled in the upstream backend for correctness screening. Record
that setting in performance comparisons; changing it requires separate validation.
See [PROVENANCE.md](PROVENANCE.md) for versions and licensing.

## Compile a captured module

Capture real Rust IR with the pinned frontend's `--emit=llvm-ir` or
`--emit=llvm-bc`, preserving the source/lockfile/features/target configuration.
Do not time this capture as though it were an integrated fast compiler.

```sh
experiments/gpu-rust-compiler/fast-backend/.build/controller/release/nemoclaw-fast-backend \
  compile --input captured-rust.ll --output candidate.o \
  --bridge experiments/gpu-rust-compiler/fast-backend/.build/native/tpde-rust-bridge \
  --llc /path/to/llvm-22.1.8/bin/llc --allow-fallback --report receipt.json
```

Add `--llvm-codegen-opt-level 1` for an LLVM O1 code-generation comparison;
preserve the captured IR's original optimization settings in the measurement.

Omit `--allow-fallback` when qualifying TPDE coverage. No host target is inferred
or forced onto input modules. macOS targets route to the LLVM fallback because
current TPDE does not emit Mach-O. Other architectures/platforms are rejected by
the controller. Non-Rust LLVM fixtures are accepted with a null `rustc_ident`;
Rust-produced modules identifying a different compiler version are rejected.

Receipts include subprocess parsing/probing and object validation in elapsed
time. This screening design intentionally reparses IR and starts processes; it
cannot establish in-process backend latency or complete Cargo acceleration.
Linking, execution, executable size, compile-and-test time, and GPU scaling need
their own measurements. The object backend does not currently enable GPUs.

## Validate the controller

```sh
cargo +1.98.1 test --locked --offline \
  --manifest-path experiments/gpu-rust-compiler/fast-backend/Cargo.toml \
  --target-dir experiments/gpu-rust-compiler/fast-backend/.build/controller
```

Behavioral tests cover explicit fallback, required-backend failures, provenance,
wrong object architecture, invalid IR, existing-output preservation and literal
argument handling, including all four explicit LLVM code-generation levels for
direct and fallback routes. Native bridge compilation/execution requires LLVM 22.1.8;
controller tests alone do not qualify TPDE or generated Rust machine code.
The [native proof](NATIVE_PROOF.md) records separately observed bridge execution,
matching tool versions, native fallback semantics, and unqualified boundaries.

## Execute emitted Rust objects

On a Linux runner with the pinned frontend and bridge, capture the Rust fixture,
compile through TPDE with fallback disabled, and link it to the Rust driver:

```sh
rustc +1.98.1 --edition=2021 --crate-type=lib -Copt-level=0 \
  --emit=llvm-ir=scalar.ll,obj=reference.o \
  experiments/gpu-rust-compiler/fast-backend/fixtures/scalar.rs

experiments/gpu-rust-compiler/fast-backend/.build/controller/release/nemoclaw-fast-backend \
  compile --input scalar.ll --output tpde.o \
  --bridge experiments/gpu-rust-compiler/fast-backend/.build/native/tpde-rust-bridge \
  --llc /path/to/llvm-22.1.8/bin/llc --report scalar-tpde.json

rustc +1.98.1 --edition=2021 \
  experiments/gpu-rust-compiler/fast-backend/fixtures/driver.rs \
  -Clink-arg=tpde.o -o scalar-tpde
./scalar-tpde
```

Repeat the driver link with `reference.o` for the LLVM reference. The fixture
checks arithmetic, branches and normal-path Rust drops; it does not qualify
panicking drops, arbitrary intrinsics, async, generics or complete applications.
Capture a full crate's modules and run its appropriate executable workload next.
Keep these generated files in a private build directory, not the source root.

`fixtures/semantic.rs` and `fixtures/semantic-driver.rs` add standard-library
linkage, generic calls, sequentially consistent atomics, caught panics and drops
while unwinding. Capture and link them the same way with `-Cpanic=unwind`; retain
separate required-TPDE and fallback receipts. A fallback pass is not TPDE coverage.
