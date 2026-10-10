<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native adapter verification

October 10, 2026. The TPDE bridge was built on this Apple ARM64 Mac with two C++
jobs, using the official LLVM 22.1.8 development archive in a private ignored
directory. No host package or rustup installation was changed.

The controller's ten behavioral tests and strict Clippy checks passed. New
controller behavior was tested failing before implementation. The native bridge
was separately built and exercised; controller mocks are not its native proof.

The later explicit LLVM code-generation level extension adds three behavioral
tests and a CLI parser test. Levels 0 through 3 reach direct and fallback LLVM
commands, invalid levels fail before a tool starts, and successful TPDE receipts
do not claim an LLVM quality level. These regressions were observed failing
before implementation. A real controller O1 run over the captured ARM64 semantic
module emitted an 11,552-byte object; the linked driver passed generics, atomics,
caught panics and unwind drops. The O1 receipt identifies target-machine code
generation only; no additional IR optimizer pipeline was introduced.

The later GEM1 extension exports genuine Rust 1.98.1 scalar leaf modules for
x86-64 Linux and ARM64 Darwin, producing 298-byte packets with original targets
and unwind requirements. Four explicit native contract tests pass: exact packet
bytes, constant-return signatures, ordinary Rust runtime binding flags, and
strict unsupported ABI/protection rejection. Export is CPU preparation for the
device emitter; these checks alone do not establish GPU execution.

## Observed results

- `fixtures/semantic.rs` was compiled by Rust 1.98.1 for **x86-64 Linux**, using a
  privately unpacked matching Linux standard library. No target triple was
  rewritten. The captured IR includes standard-library references, generic
  calls, sequentially consistent atomics, `catch_unwind`, and drops during
  unwinding. TPDE emitted a structurally validated **13,576-byte ELF object with
  fallback disabled**. Its native receipt reports `backend: tpde` and the
  observed Rust producer. Linux execution remains a CI qualification step.
- The same Rust source was captured for **Apple ARM64**. TPDE's unsupported
  platform selected the explicit LLVM fallback, which emitted a **12,528-byte
  Mach-O object**. Linking `fixtures/semantic-driver.rs` against that object and
  executing it locally passed generic calls, atomics, caught panics, and unwind
  drops. The separately generated Rust/LLVM reference object also passed.
- Real Rust `fixtures/unsupported-asm.rs` for x86-64 Linux was rejected in
  required-TPDE mode. No output object was committed. With `--allow-fallback`,
  LLVM emitted a validated **928-byte ELF** and the receipt retained the TPDE
  rejection. That is fallback coverage, not TPDE coverage.
- A genuine Rust `-Clinker-plugin-lto=yes -Clto=off` bitcode-wrapper `.o` from a
  cooperating compiler-seam probe was parsed by the bridge. The controller
  preserved its Darwin target and emitted a validated **744-byte Mach-O** through
  the documented LLVM fallback. Thus the serialized input seam is usable; this
  package alone is not a complete Cargo/rustc wrapper.

These runs establish adapter execution and the exercised native fallback
semantics. They do not establish full Rust compatibility, full NemoClaw/Omarchy
compilation, executable-size compliance, or GPU acceleration. Receipts identify
the scope as captured LLVM module to object and `gpu_accelerated: false`.

No performance speedup is claimed. The first LLVM version probe took about 1.6
seconds during first use of the private executable; subprocess startup,
verification, parsing, teardown, and object checks are included in receipts.
Use repeated, interleaved measurements and an in-process integration before
attributing whole-compiler latency gains.

## Mach-O fixed-frame unwind verification

The device emitter's fixed-frame code now retains precise asynchronous DWARF
rows in `__eh_frame`. Mach-O compact records use DWARF mode rather than assuming
the established frame throughout the prologue and epilogue. The records use
PC-relative 64-bit FDE locations with paired SUBTRACTOR/UNSIGNED relocations;
Apple's linker rejected an earlier absolute-pointer encoding. Two-function
objects also require `MH_SUBSECTIONS_VIA_SYMBOLS`: without it, actual native
unwinder lookup failed for the final x86 function because the linked compact
lookup range ended at its first instruction. The flag contract was tested
failing before the fix.

Both ARM64 and x86-64 two-function objects were linked with the installed Apple
linker. ARM64 functions returned 42 locally; x86-64 functions returned 42 under
Rosetta. LLVM 22.1.8 decoded the linked FDE addresses against their actual symbol
addresses and showed the correct rows at entry, after each frame-establishing
instruction and after frame restoration. System libunwind found both functions
throughout the partial prologue, body and final return instruction, including
the last function in the text section. ARM64 entry lookup used entry+1 because
the local unwinder cursor treats an IP as a return address and searches IP-1.
The two-function unit test covers four relocation entries, their pair ordering,
the subsection flag, retained DWARF data and both compact DWARF encodings.

Private sources and executables are `unwind-object.rs`, `unwind-lookup.c`,
`unwind-arm-lookup`, and `unwind-x86-lookup` directly under `fast-backend/.build/`.
These checks qualify the fixed-frame metadata emitted for the restricted scalar
ABI. They do not prove arbitrary Rust exception handling or GPU throughput.

The CUDA emitter received a separate source review of its instruction sizes,
packet ABI, prefix-sum bounds, device ownership and completion fencing. No
evident CUDA compilation defect was found. This Mac has no nvcc or CUDA headers;
actual CUDA compilation and execution remain required runner checks.

## Pinned inputs and tools

| Item | Identity |
| --- | --- |
| Rust frontend | `1.98.1`, commit `48a229ceaefd4985c50990b14116b6d856af0985`, LLVM `22.1.8` |
| TPDE source | `9779acf4ada3736e779391da1e4b3369dba08024` |
| Official Clang | `22.1.8`, LLVM commit `ca7933e47d3a3451d81e72ac174dcb5aa28b59d1` |
| LLVM archive | `LLVM-22.1.8-macOS-ARM64.tar.xz`, SHA256 `f260f4f7c0d430828a81ae8a3826a1d63fc0963ec2459489308cc23b1f7eab4f` |
| Rust Linux std archive | `rust-std-1.98.1-x86_64-unknown-linux-gnu.tar.xz`, SHA256 `fa3ff450172a16c026944030230c5069947af93c728d9179971d44e5e0cfb561` |
| LLVM configuration header | SHA256 `d30ac6df01f61025a150cb60d30dd80f3929382d0c90579b75639e2201f5c4b6` |
| Initial TPDE bridge before GEM1 extension | SHA256 `45e2d5559af03266548075ab754278ff60bb685631985508126db4445b349b3a` |
| Bridge with GEM1 extension | SHA256 `425be10a5c7cfb87ab6af8a8c647dc5dd6a69d6808422789959ebd0d7b6bdcf0`, 8,086,784 bytes |
| Native `llvm-config` | SHA256 `f1697472090ec136a0b2755bdc5d571517a6f1e6bfd9b2b6f6afe7c66d68dc27` |
| Native `llc` | SHA256 `3d4ea1b357c68e34f70ed531ef8dfcbad7eb767a5cb7b5a486bc3e0d2626e404` |
| Linux `libstd` rlib | SHA256 `bf156342c5f849f27d8f53003131bc7c0e675143389d84dd549b2ebbaccfaa2f` |

Archive digests matched the publishers' HTTPS metadata. These are provenance
checks, not a claim of binary authentication. TPDE fetched submodules were args
`cc2368ca0d8a962862c96c00fe919e1480050f51`, disarm
`2d13d3f410a52daff1c5d8ef07d623332f372560`, fadec
`3994d89500985491b1a7ccc17827a22058b3de49`, and spdlog
`27cb4c76708608465c413f6d0e6b8d99a4d84302`.

The private source/build/results are under `fast-backend/.build/`. Native receipts
are `fixtures/semantic-linux-tpde.json`, `fixtures/semantic-linux-llvm.json`,
`fixtures/semantic-darwin-fallback.json`, `fixtures/unsupported-asm-fallback.json`,
and `fixtures/linker-plugin-probe.json`. Captured modules, headers, objects and
executables remain there for inspection. They are not committed binaries.

The initial raw standalone bridge was 8,065,872 bytes, controller 612,864 bytes, and the
official standalone LLVM fallback tool 126,780,656 bytes. Count required runtime
tools/libraries in any compiler-size comparison. The entire development archive
is build infrastructure, not an appropriate estimate of a final compiler
distribution. Later complete Mac runtime-file accounting uses the compact helper
and reuses Rust's shared LLVM. The compiler plus required adapters/kernels totals
235,124,841 bytes versus the 222,966,640-byte baseline (+5.453%), within the +50%
allowance. It includes the additional Metal libraries actually linked by the
runtime executables. This Mac measurement does not qualify Linux/CUDA asset size.
