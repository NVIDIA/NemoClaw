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

The native CPU, Metal, and CUDA paths retain their execution state across
`--serve` requests. CUDA loads a small C ABI library in the compiler process;
analysis uses the compiler's indexed arrays directly. Python remains an
independent oracle and benchmark controller inside the validation image. The
older Python/CUDA-process bridge remains a comparison baseline. An explicitly
requested CUDA pass fails when unavailable. Adaptive routing can select CPU
and reports that decision. A faster pass does not establish a faster NemoClaw build.

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
The hosted job also compiles standard-Rust reference programs; their sources,
executable outputs, compiler identity, and checksums travel with this exact-head
artifact. The GPU job builds the native CUDA library from the same revision.

GPU verification requires that workflow to succeed on this PR's exact
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

## Persistent native CUDA

`native/cuda_bridge.{h,cu}` exposes creation, submission, completion, device
capability queries, and destruction. A context owns a nonblocking stream,
events, reusable device allocations, and pinned staging buffers. Submission
captures an immutable snapshot before returning; the caller can then perform
independent CPU work. Completion waits for result downloads. Every request
reseeds its facts, including requests that remove previously live values.

The dense kernel remains a reference. The delta-frontier kernel propagates new
bits backward through predecessor kill masks, using atomic updates and uniform
round barriers. It scans a frontier bitmap but only visits edges of active
rows. Function-size buckets avoid charging small functions for the largest
function's shared-memory allocation. Both algorithms implement the same
finite least fixed point and phi predecessor semantics.

Inside the CUDA image, the native verifier builds the adapter and runs:

```sh
python3 scripts/verify_native_cuda.py \
  --compiler-binary .build/compiler/release/gpu-rust-compiler \
  --benchmark-binary .build/compiler/release/gpu-native-benchmark \
  --references .build/compiler/release/references \
  --report results/native-cuda-verification.json
.build/compiler/release/gpu-rust-compiler --serve --backend cuda \
  --cuda-algorithm sparse --cuda-library .build/cuda/libgpulab_cuda.so --verify
```

Native `cpu` execution has a reusable worker pool. Analysis calibration compares
serial, function, and word worklists over several active worker counts. CUDA
`cuda-hybrid` routing uses a saved profile bound to device, driver/runtime, CPU
capacity, source revision, objective, candidate shape, and parent workload.
Admission requires a clear timing advantage in separate training and held-out
samples, including packing, staging, transfers, CPU remainder, and assembly.
Missing, mismatched, or noisy evidence selects CPU. Long straight chains stay
on CPU. `--mode latency|throughput` selects separately qualified policies;
latency evidence cannot authorize throughput placement.

The verifier compares fresh and persistent processes, dense and sparse
algorithms, full supported-program compilation, and interleaved concurrent
compilation cohorts. Held-out facts rotate value identities on the same CFG;
they do not establish generalization to unseen graph geometry. Event polling
checks whether GPU work remains pending when independent CPU work starts;
it does not measure simultaneous kernel/CPU execution duration.

Placement is separate from algorithm selection. Pinned staging is implemented
on the PCIe runner. Runtime queries report memory capabilities, while
`CoherentUnverified` refuses execution. Vera/Rubin coherent placement and SCC
preprocessing remain unverified until hardware or measured benefits justify them.

## Same-runner CUDA benchmarks

The GPU job benchmarks the same generated analysis inputs with the native Rust
CPU worklist and CUDA. CPU results include serial, function-parallel, and
word-parallel solvers; the comparison uses the fastest CPU median. The Python
set oracle checks outputs outside the timed solve and is not the performance
baseline. Compact function batches test GPU throughput at several sizes;
long chains and mixed workloads test propagation and scheduling costs.

CUDA reports kernel events, resident-input warm passes, and warm passes that
upload all input arrays and download results. The last comparison includes
transfers and retains device allocations. Initialization and input preparation
are reported separately. These generated workloads are analysis measurements,
not NemoClaw or Omarchy build measurements.

The complete compiler benchmark interleaves repeated fresh-process compiles
of the supported demo through the native CPU compiler, Python CPU bridge, and
CUDA bridge. Each executable must print `1460`. Wall time includes process
startup and linking; stage timings retain their own boundaries. Native CPU
versus CUDA compares the current architectures, including the bridge and CPU
verification costs. Python CPU versus CUDA uses the same frontend and bridge.
File caches and the NVIDIA driver may remain warm between samples.

Within the validation image, after CUDA verification:

```sh
python3 scripts/benchmark_cuda.py --repeats 31 --compile-repeats 9 \
  --compiler-binary .build/compiler/release/gpu-rust-compiler \
  --cpu-binary .build/compiler/release/gpu-cpu-liveness \
  --cuda-binary .build/cuda/cuda-liveness --report results/cuda-benchmark.json
```

The workflow retains raw samples, workload hashes, executable outputs, hardware
identity, and source provenance. A result for one pass or this scalar demo does
not establish a faster complete Rust build.

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
