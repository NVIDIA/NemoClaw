<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# A new hybrid Rust compiler

The intended product is a Rust compiler whose CPU workers handle latency,
dependency ordering, and host effects, while GPU workers handle sufficiently
large batches of regular compiler work. CUDA is the primary NVIDIA backend.
Metal implements the same analysis contract for development on Apple Silicon macOS.
The hardware determines the available backend; the compiler's internal
representation and correctness rules should be shared.

The [compile-time-first backend design](COMPILE_FIRST.md) now supplies a second
path: stock Rust handles the complete language, while a pinned bitcode wrapper
selects CPU or GPU object emission. The scalar frontend described below remains
an independent analysis experiment. Its language restrictions do not apply to
the compatible Cargo path; strict GPU module eligibility still limits GPU
coverage. Multi-GPU scaling and whole-build GPU speedups remain unproved.

## The vertical slice that exists

The `compiler/` crate contains a new lexer, parser, scalar type validator, and
LLVM IR emitter. It does not invoke rustc to understand or compile its input.
Rust is used to build the compiler itself. Clang/LLVM generates CPU machine
code from the emitted IR, as an initial target backend.

The native path now records SSA value IDs, CFG edges, and phi predecessor uses
during emission. Rust packs that compiler-owned graph directly and prunes
instructions using the result. The Metal C ABI adapter caches its library,
pipeline, queue, and reusable shared buffers inside the compiler process.
`--serve` retains this state across requests and recovers from invalid input.
Clang remains an external code-generation/linking process.

CUDA now has an in-process C ABI adapter with retained streams, events, device
buffers, and pinned staging. Its dense and delta-frontier kernels consume the
same indexed snapshot. Submission captures input, enqueues transfers and work,
and returns before completion; CPU subsets can execute before the final wait.
Contexts and capacity are retained, while facts are cleared and reseeded for
every changed request. The placement policy exposes an explicit unverified
coherent option; capability queries cannot make that option verified.

The legacy portable `scripts/compile.py` bridge extracts that IR's SSA liveness problem
and selects the independent CPU oracle or the CUDA command-line backend. The selected result feeds a
bounded dead scalar instruction pruning pass, after which Clang links a native
executable. Native tests compare output with rustc compiling the same source
inside an equivalent entry harness.

Supported source features: `i64` and `bool`, functions and forward calls,
mutable locals, assignments, conditionals, loops, returns, integer operators,
and lazy `&&`/`||`. Source is treated as a module with a zero-argument scalar
`main` function; the generated executable prints that function's result.
This is an experimental entry convention, not complete Rust binary behavior.
Arithmetic uses wrapping add/subtract/multiply and masked shifts. Invalid
division/remainder traps; it does not reproduce Rust panic messages.

Ownership, references, traits, generic code, pattern matching, macros,
procedural macros, the standard library, dependency crates, Rust metadata, and
Cargo's rustc interface are outside the current subset. Unsupported syntax and
invalid types are rejected. This scalar frontend cannot build NemoClaw or the
full Omarchy Rust tools.

## Architectures to pursue

| Design | CPU role | GPU role | First experiment |
|---|---|---|---|
| Adaptive heterogeneous compiler | Parse, validate, schedule dependencies, and execute small or long-chain analyses | Process immutable batches of compact functions | Native CUDA routing requires measured total-cost wins; CPU and GPU state persist |
| Sparse graph engine | Order CPU worklists and create shape buckets | Propagate newly discovered dataflow bits through active frontiers | Delta frontier implemented; SCC preprocessing remains unmeasured |
| Flat task evaluator | Drive host effects, incremental caches, and uneven tasks | Execute balanced independent continuations on persistent workers | Encode one analysis in a Bend-style flat IR and compare against native kernels |
| Compatibility bridge | Use rustc's existing frontend for unsupported Rust while the new frontend grows | Run the same backend-neutral analyses inside a version-pinned backend | A custom `CodegenBackend` adapter with explicit compatibility modes |

The Metal hybrid is a concrete instance of the first design. It dispatches
eligible functions of at most 64 blocks only when the batch contains at least
32 functions and either 50,000 packed cells or 1,024 word groups. Other functions
remain on CPU worklists. GPU submission precedes CPU work; there is one final
wait and then results are assembled. These provisional thresholds came from the original Metal prototype; the
CUDA routing instead uses calibrated shape buckets and saved CPU worker limits.
Profiles require separate training and held-out total-cost wins and are bound
to hardware, execution objective, and source revision. Unmatched inputs stay
on CPU; admitted GPU batches can run while CPU worklists solve other functions.

The GPU kernel's words are independent, so a threadgroup can converge without
global GPU synchronization. Long graphs are a poor fit for its dense Jacobi
sweeps: a chain can require roughly N sweeps over N blocks. A reverse-order CPU
worklist may solve that chain with roughly one pass. This algorithmic difference
explains why more GPU cores cannot fix the current stress-case loss.

For sparse liveness, initialize each block with local uses plus outgoing phi
uses not killed by local definitions. When a successor gains bits, propagate
only those bits not killed by the predecessor. Immutable GEN/KILL data gives a
monotone fixed point. Duplicate-safe atomic updates and correct termination
are required. Changed compiler input must invalidate prior results; deletion
cannot be handled by a monotone add-only update alone.

[Rust's MIR dataflow framework](https://rustc-dev-guide.rust-lang.org/mir/dataflow.html)
provides actual fixed-point analyses and edge effects to adapt.
[Gunrock](https://arxiv.org/abs/1701.01170) provides the active-frontier graph
architecture; its CUDA implementation is not a Metal implementation.
[Bend's flat evaluator](https://github.com/bendlang/bend/blob/main/guide/GUIDE.md#under-the-hood)
is an alternative execution model requiring substantial compiler data redesign.
[rustc's backend interface](https://github.com/rust-lang/rust/blob/main/compiler/rustc_codegen_ssa/src/traits/backend.rs)
provides a compatibility seam with compiler-version coupling.

## CUDA and Metal validation

Both GPU implementations consume the same bitsets and function-word groups,
and solve the same least fixed point. Native CUDA consumes compiler-owned
arrays directly. The legacy CUDA executable and native benchmark driver also
accept `GLC1` packs and emit `GLR1` results for independent verification. The
experimental workflow must establish CUDA compilation and NVIDIA GPU execution
on its exact candidate revision. Metal execution on a Mac cannot provide that evidence.

On a CUDA-capable build host:

```sh
python3 scripts/verify_cuda.py --report results/cuda-verification.json
python3 scripts/compile.py fixtures/compiler_demo.rs --backend cuda \
  --output .build/compiler_demo_cuda
```

The CUDA driver fails if no compatible device or runtime is available. There
is no silent CPU fallback. It verifies its result against the CPU oracle before
using it for pruning. Hardware results must identify the GPU, toolkit, driver,
source hashes, transfer/setup cost, and total compile time.

## Growing into a Rust compiler

1. Establish the scalar source-to-native slice and GPU analysis invariants.
   This is implemented; the native and independent oracle tests verify its scope.
2. The native compiler adapter and persistent GPU pipelines are implemented.
   Analysis no longer reparses LLVM text or crosses a JSON/subprocess boundary.
   Fresh processes and persistent workers are benchmarked against the same
   source and standard Rust with an equivalent entry harness. Native CPU analysis can use scoped workers;
   CPU execution now also retains a worker pool and calibrates mode and active
   worker count. Clang code
   generation and linking remain separate subprocess costs.
3. Profile actual NemoClaw and Omarchy-component Rust builds. Select an analysis
   with enough aggregate cost to justify GPU work; the current liveness pass
   is not evidence that it dominates those builds.
4. Expand source compatibility in deliberate stages: aggregates/control flow,
   ownership and borrow checking, generics/traits/coherence/const evaluation,
   macros and procedural macros, standard-library and dependency compilation,
   Cargo metadata and ABI compatibility.
5. Require differential diagnostics and program-behavior tests before widening
   accepted syntax. A compiler accepting more source while changing its meaning
   is a regression. Bind performance claims to exact sources and toolchains.

The immediate performance target is a lower complete compile time with the
same language features and output behavior. A fast isolated pass, simpler
language semantics, or omitting compiler work is insufficient evidence.
