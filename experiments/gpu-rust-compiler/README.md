<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GPU-assisted Rust compiler experiment

This is a disposable pipeline experiment. It is excluded from NemoClaw's
production Cargo workspace and has `publish = false`. Do not merge or ship it.
[Import provenance](IMPORT.md) records the original prototype hashes.

The new frontend compiles a scalar Rust subset through SSA liveness analysis,
dead instruction pruning, and Clang/LLVM machine-code generation. Supported
source has `i64`/`bool`, functions, mutable locals, conditionals, loops, returns,
and scalar operators. The executable prints its zero-argument scalar `main`
result. It does not support ownership, traits, generics, macros, dependencies,
the standard library, or Cargo's compiler interface. It cannot build NemoClaw
or the complete Rust components used by Omarchy.

The native CPU/Metal/hybrid compiler retains its analysis pipeline across
`--serve` requests. CUDA currently runs through a Python bridge and a separate
CUDA analysis process. CUDA outputs must match an independent CPU set oracle
before they can affect the emitted executable. There is no CPU fallback for a
requested CUDA pass. A faster pass does not establish a faster NemoClaw build.

## Run the GPU experiment in GitHub Actions

Keep [PR #12951](https://github.com/NVIDIA/NemoClaw/pull/12951) open as a draft
from `experiment/gpu-rust-compiler` into `v1`, then push a signed commit to that
NVIDIA-owned branch. That starts `.github/workflows/gpu-compiler-experiment.yml`;
rerun its Actions run to repeat the current head. The hosted CPU job first
requires that the draft PR's repository, branches, and head SHA match this push.
NVIDIA's GPU runner rejects `pull_request` events, so this experiment uses the
trusted branch push route. Manual dispatch is unavailable until a workflow
exists on the default branch, and this experiment will not be merged.
The workflow builds the native frontend on a hosted Linux runner, then verifies
CUDA inside its validation image on the repository's GPU runner. It
retains device/toolchain identity, source and binary hashes, correctness
results, timings, and program output as artifacts.

GPU verification is pending until that workflow succeeds on this PR's exact
head. Exit code `3` from the verifier means CUDA is unavailable; it is not a
passing GPU result. The generated liveness cases are compiler analysis inputs,
not representative NemoClaw build measurements.

Within the validation image, from this directory:

```sh
python3 scripts/verify_cuda.py --report results/cuda-verification.json
python3 scripts/compile.py fixtures/compiler_demo.rs --backend cuda \
  --compiler-binary .build/compiler/release/gpu-rust-compiler \
  --cuda-binary .build/cuda/cuda-liveness \
  --output .build/compiler_demo_cuda --report results/cuda-demo.json
.build/compiler_demo_cuda
# 1460
```

`--compiler-binary` accepts a frontend artifact from the same source revision
without rebuilding it. Without that option, the bridge builds the frontend
when absent or older than its sources. A CUDA device, compatible driver/toolkit,
Python 3.9+, and a host C++ compiler are required. Clang must support the emitted
opaque-pointer LLVM IR.

## CPU and Metal development

```sh
sh scripts/build_native.sh
cargo test --locked --manifest-path compiler/Cargo.toml \
  --target-dir .build/compiler
python3 -m unittest discover -s tests
.build/compiler/release/gpu-rust-compiler fixtures/compiler_demo.rs \
  --backend cpu --verify --output .build/compiler_demo
.build/compiler_demo
python3 scripts/benchmark_native.py --backends cpu --repeats 5
```

CPU checks need Rust, Python, and Clang. The native tests compare emitted
program behavior against standard Rust compiling the same module with an
equivalent entry harness. Metal tests skip on Linux. On Apple Silicon macOS
with Xcode tools, use `--backend metal` or `--backend hybrid`; the default native
benchmark compares all three. Metal work executes on the Mac GPU, which cannot
verify CUDA hardware execution.

`--serve --backend metal --verify` keeps the Metal pipeline and buffers alive.
Each request is `compile`, source, output, and optional report, separated by
tabs. Each response is one JSON line. Paths cannot contain tabs or newlines.
Clang/linking remains a subprocess for every request.

Generated data and binaries live in `.build/`; reports live in `results/`.
Both are ignored. Timings separate warm kernel execution from startup,
transfers, verification, parsing, code generation, and linking. The native
benchmark measures complete supported-subset compilation, including linking,
with standard Rust as a behavioral baseline. This experiment has no shipped
performance claim. [Architecture and next milestones](ARCHITECTURE.md).
